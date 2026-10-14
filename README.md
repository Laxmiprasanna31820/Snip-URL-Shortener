# Snip: Cloud-Based URL Shortener with Analytics

Node.js + Express backend, SQLite (local) or MongoDB Atlas (cloud), and a dashboard.

## Features
- Shorten any URL, with optional custom alias
- Real HTTP 302 redirects; every click is logged (time, device, browser, OS, referrer)
- Analytics dashboard: totals, clicks today, 14-day chart, device/browser/OS/referrer breakdowns, per-link filter
- Validation, duplicate-alias check, rate limiting (30 creations/min/IP)

## 1. Run on your computer (no accounts needed)
1. Install Node.js 18+ from https://nodejs.org
2. Open a terminal in this folder and run:
   ```
   npm install
   npm start
   ```
3. Open http://localhost:3000

Data is stored in `data/snip.db` (created automatically).

## 2. Deploy to the cloud (Render + MongoDB Atlas, both have free tiers)
Render's free servers lose local files, so use MongoDB Atlas for storage online.

**A. Database**
1. Create a free cluster at https://www.mongodb.com/atlas
2. Database Access: create a user and password.
3. Network Access: allow `0.0.0.0/0`.
4. Connect > Drivers: copy the connection string and put your password in it.

**B. Code on GitHub**
```
git init
git add .
git commit -m "Snip URL shortener"
```
Create an empty repo on GitHub, then push (`git remote add origin <url>`, `git push -u origin main`).

**C. Render**
1. https://render.com > New > Web Service > connect your GitHub repo.
2. Build command: `npm install`   Start command: `npm start`
3. Environment variables:
   - `MONGODB_URI` = your Atlas connection string
   - `BASE_URL` = your Render URL (e.g. https://snip.onrender.com), optional
4. Deploy. Your app is live at the Render URL.

Note: free-tier servers can sleep when idle, so the first request after a break may be slow. Check each provider's current limits.

## API
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/shorten` | body `{url, alias?}` creates a link |
| GET | `/api/links` | list links with click counts |
| GET | `/api/stats?code=abc` | analytics (all links, or one) |
| GET | `/:code` | 302 redirect + click logged |
| GET | `/health` | health check |

## Project structure
```
server.js        Express app: API, redirect, analytics
db.js            Storage layer (SQLite or MongoDB, same interface)
public/          Dashboard (index.html) and 404 page
.env.example     Optional settings
```

## How it works
1. POST /api/shorten validates the URL, generates a 6-character code (random, collision-checked) and saves `code -> url`.
2. GET /:code looks up the code, logs a click in the background, then sends a 302 redirect.
3. /api/stats aggregates click events into totals, daily counts and breakdowns.

302 (not 301) is used so browsers never cache the redirect and every click is counted.

## Ideas to extend
User login, link expiry, delete/edit links, QR codes, geo-location by IP, Redis cache.
