// Storage layer. One interface, two backends:
//   - SQLite (default, zero setup)      - MongoDB (when MONGODB_URI is set)
const path = require('path');
const fs = require('fs');

module.exports = async function initDb() {
  if (process.env.MONGODB_URI) return mongoBackend();
  return sqliteBackend();
};

function sqliteBackend() {
  const Database = require('better-sqlite3');
  const dir = process.env.DATA_DIR || path.join(__dirname, 'data');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'snip.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS links (
      code TEXT PRIMARY KEY, url TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, ts INTEGER NOT NULL,
      device TEXT, browser TEXT, os TEXT, referrer TEXT);
    CREATE INDEX IF NOT EXISTS idx_clicks_code ON clicks(code, ts);
  `);
  const q = {
    insLink: db.prepare('INSERT INTO links(code,url,created) VALUES(?,?,?)'),
    getLink: db.prepare('SELECT code,url,created FROM links WHERE code=?'),
    insClick: db.prepare('INSERT INTO clicks(code,ts,device,browser,os,referrer) VALUES(?,?,?,?,?,?)'),
    links: db.prepare('SELECT code,url,created FROM links ORDER BY created DESC LIMIT 500'),
    clicksAll: db.prepare('SELECT code,ts,device,browser,os,referrer FROM clicks ORDER BY ts DESC LIMIT 20000'),
    clicksOne: db.prepare('SELECT code,ts,device,browser,os,referrer FROM clicks WHERE code=? ORDER BY ts DESC LIMIT 20000'),
    counts: db.prepare('SELECT code, COUNT(*) AS n FROM clicks GROUP BY code'),
  };
  return {
    name: 'SQLite',
    async createLink(code, url) {
      try { q.insLink.run(code, url, Date.now()); return true; }
      catch (e) { if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return false; throw e; }
    },
    async getLink(code) { return q.getLink.get(code) || null; },
    async addClick(c) { q.insClick.run(c.code, c.ts, c.device, c.browser, c.os, c.referrer); },
    async listLinks() { return q.links.all(); },
    async clicks(code) { return code ? q.clicksOne.all(code) : q.clicksAll.all(); },
    async counts() { return Object.fromEntries(q.counts.all().map(r => [r.code, r.n])); },
  };
}

async function mongoBackend() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db(process.env.MONGODB_DB || 'snip');
  const links = db.collection('links'), clicks = db.collection('clicks');
  await links.createIndex({ code: 1 }, { unique: true });
  await clicks.createIndex({ code: 1, ts: -1 });
  const noId = { projection: { _id: 0 } };
  return {
    name: 'MongoDB',
    async createLink(code, url) {
      try { await links.insertOne({ code, url, created: Date.now() }); return true; }
      catch (e) { if (e.code === 11000) return false; throw e; }
    },
    async getLink(code) { return links.findOne({ code }, noId); },
    async addClick(c) { await clicks.insertOne({ ...c }); },
    async listLinks() { return links.find({}, noId).sort({ created: -1 }).limit(500).toArray(); },
    async clicks(code) {
      return clicks.find(code ? { code } : {}, noId).sort({ ts: -1 }).limit(20000).toArray();
    },
    async counts() {
      const r = await clicks.aggregate([{ $group: { _id: '$code', n: { $sum: 1 } } }]).toArray();
      return Object.fromEntries(r.map(x => [x._id, x.n]));
    },
  };
}
