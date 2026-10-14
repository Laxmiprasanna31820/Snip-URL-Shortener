require('dotenv').config();
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const initDb = require('./db');

const PORT = process.env.PORT || 3000;
const RESERVED = new Set(['api', 'health', 'favicon.ico', 'index.html']);
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
const DAY = 86400000;

const app = express();
app.set('trust proxy', 1); // correct protocol/host behind Render's proxy
app.use(express.json({ limit: '10kb' }));

// ---------- helpers ----------
const genCode = (n = 6) => Array.from(crypto.randomBytes(n), b => ALPHA[b % 36]).join('');

function validUrl(u) {
  try {
    const p = new URL(u);
    return /^https?:$/.test(p.protocol) && p.hostname.includes('.');
  } catch { return false; }
}

function parseUA(ua = '') {
  const device = /iPad|Tablet/i.test(ua) ? 'Tablet'
    : /Mobi|Android|iPhone/i.test(ua) ? 'Mobile'
    : /bot|crawl|spider|curl|wget/i.test(ua) ? 'Bot' : 'Desktop';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari' : 'Other';
  const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
    : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
    : /Linux/.test(ua) ? 'Linux' : 'Other';
  return { device, browser, os };
}

function refHost(r) {
  if (!r) return 'direct';
  try { return new URL(r).hostname.replace(/^www\./, ''); } catch { return 'direct'; }
}

const baseUrl = req => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

// tiny in-memory rate limiter for link creation (30 / minute / IP)
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now(), k = req.ip;
  const h = hits.get(k);
  if (!h || now > h.reset) { hits.set(k, { n: 1, reset: now + 60000 }); return next(); }
  if (++h.n > 30) return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
  next();
}

function tally(clicks, key) {
  const m = {};
  for (const c of clicks) { const v = c[key] || 'Unknown'; m[v] = (m[v] || 0) + 1; }
  return Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
}

function summarize(clicks) {
  const today = Math.floor(Date.now() / DAY) * DAY;
  const byDay = Array.from({ length: 14 }, (_, i) => ({
    date: new Date(today - (13 - i) * DAY).toISOString().slice(0, 10), count: 0,
  }));
  for (const c of clicks) {
    const i = 13 - Math.floor((today + DAY - 1 - c.ts) / DAY);
    if (i >= 0 && i < 14) byDay[i].count++;
  }
  return {
    total: clicks.length,
    today: clicks.filter(c => c.ts >= today).length,
    byDay,
    devices: tally(clicks, 'device'),
    browsers: tally(clicks, 'browser'),
    os: tally(clicks, 'os'),
    referrers: tally(clicks, 'referrer'),
  };
}

// ---------- start ----------
(async () => {
  const db = await initDb();

  app.get('/health', (_req, res) => res.json({ ok: true, db: db.name }));

  // Create a short link
  app.post('/api/shorten', rateLimit, async (req, res) => {
    try {
      let { url, alias } = req.body || {};
      url = String(url || '').trim();
      if (!url) return res.status(400).json({ error: 'URL is required.' });
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      if (url.length > 2048 || !validUrl(url)) return res.status(400).json({ error: 'Please enter a valid http(s) URL.' });
      if (new URL(url).host === req.get('host')) return res.status(400).json({ error: 'Cannot shorten a link to this service.' });

      alias = String(alias || '').trim().toLowerCase();
      if (alias) {
        if (!/^[a-z0-9-]{3,30}$/.test(alias)) return res.status(400).json({ error: 'Alias: 3-30 characters, letters, numbers, hyphens.' });
        if (RESERVED.has(alias)) return res.status(400).json({ error: 'That alias is reserved.' });
        if (!(await db.createLink(alias, url))) return res.status(409).json({ error: 'Alias already taken.' });
        return res.status(201).json({ code: alias, url, shortUrl: `${baseUrl(req)}/${alias}` });
      }
      for (let i = 0; i < 5; i++) {
        const code = genCode();
        if (await db.createLink(code, url)) {
          return res.status(201).json({ code, url, shortUrl: `${baseUrl(req)}/${code}` });
        }
      }
      res.status(500).json({ error: 'Could not generate a unique code. Try again.' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
  });

  // List links with click counts
  app.get('/api/links', async (req, res) => {
    try {
      const [links, counts] = await Promise.all([db.listLinks(), db.counts()]);
      const base = baseUrl(req);
      res.json(links.map(l => ({ ...l, clicks: counts[l.code] || 0, shortUrl: `${base}/${l.code}` })));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
  });

  // Analytics (all links, or one with ?code=abc)
  app.get('/api/stats', async (req, res) => {
    try {
      const code = req.query.code ? String(req.query.code).toLowerCase() : null;
      res.json(summarize(await db.clicks(code)));
    } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); }
  });

  // Dashboard
  app.use(express.static(path.join(__dirname, 'public')));

  // Redirect (must be last). 302 so every click reaches the server.
  app.get('/:code', async (req, res) => {
    try {
      const code = req.params.code.toLowerCase();
      const link = RESERVED.has(code) ? null : await db.getLink(code);
      if (!link) return res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
      const ua = parseUA(req.get('user-agent') || '');
      // log in the background so the redirect is never slowed down
      db.addClick({ code, ts: Date.now(), ...ua, referrer: refHost(req.get('referer')) })
        .catch(e => console.error('click log failed', e.message));
      res.set('Cache-Control', 'no-store');
      res.redirect(302, link.url);
    } catch (e) { console.error(e); res.status(500).send('Server error'); }
  });

  app.listen(PORT, () => console.log(`Snip running on http://localhost:${PORT}  (database: ${db.name})`));
})().catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
