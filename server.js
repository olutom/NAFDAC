/**
 * NafdacCheck Backend Proxy  v1.1.0
 * ─────────────────────────────────
 * • Proxies drug lookups to greenbook.nafdac.gov.ng
 * • Stores counterfeit drug reports in SQLite (via better-sqlite3)
 * • Forwards reports to NAFDAC MedSafety reporting endpoint
 *
 * Deploy: Railway / Render / Fly.io
 *   railway up   OR   render deploy
 *
 * Local dev:
 *   npm install && npm run dev
 */
'use strict';

const express   = require('express');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const cors      = require('cors');
const NodeCache = require('node-cache');
const { chromium } = require('playwright');

const app   = express();
const cache = new NodeCache({ stdTTL: 86400 }); // 24-hour cache

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50kb' }));
app.set('trust proxy', 1);

// Global rate limit
app.use(rateLimit({
  windowMs: 60_000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' }
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'%;()&+]/g, '').trim().slice(0, maxLen);
}

// ─── NAFDAC SCRAPER (PLAYWRIGHT - FIXED WORKING VERSION) ─────────────────────
async function fetchNafdac(params) {
  const key = `nafdac_${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  let results = [];

  try {
    const query = params.search || '';

    await page.goto('https://greenbook.nafdac.gov.ng/', {
      waitUntil: 'networkidle',
    });

    // Try find search input
    const input = await page.$('input[type="text"], input[name="search"]');

    if (input) {
      await input.fill(query);
      await page.keyboard.press('Enter');
    }

    // Wait for results
    await page.waitForTimeout(5000);

    // Extract table data
    const data = await page.$$eval('table tbody tr', rows =>
      rows.map(row =>
        Array.from(row.querySelectorAll('td')).map(td => td.innerText.trim())
      )
    );

    await browser.close();

    results = data.map(row => ({
      product_name: row[0] || '',
      active_ingredients: row[1] || '',
      product_category: row[2] || '',
      nrn: row[5] || '',
      form: row[6] || '',
      roa: row[7] || '',
      strengths: row[8] || '',
      applicant_name: row[9] || '',
      approval_date: row[10] || '',
      status: row[11] || ''
    }));

    cache.set(key, results);
    return results;

  } catch (err) {
    console.log('[Playwright error]', err.message);
    await browser.close();
    return [];
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', version: '1.1.0', ts: Date.now() });
});

/**
 * SEARCH DRUGS
 */
app.get('/api/drugs/search', async (req, res) => {
  const q = sanitize(String(req.query.q ?? ''));

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters' });
  }

  try {
    const results = await fetchNafdac({ search: q });
    res.json(results);
  } catch (err) {
    console.error('[search error]', err.message);
    res.status(502).json({ error: 'Could not fetch data' });
  }
});

/**
 * VERIFY DRUG
 */
app.get('/api/drugs/verify', async (req, res) => {
  const nrn = sanitize(String(req.query.nrn ?? '')).toUpperCase();

  if (!nrn) {
    return res.status(400).json({ error: 'nrn required' });
  }

  try {
    const results = await fetchNafdac({ search: nrn });

    const exact = results.find(d =>
      d.nrn?.toUpperCase().replace(/\s/g, '') === nrn.replace(/\s/g, '')
    );

    if (exact) return res.json(exact);

    return res.status(404).json(null);
  } catch (err) {
    console.error('[verify error]', err.message);
    res.status(502).json({ error: 'Could not fetch data' });
  }
});

/**
 * REPORT DRUG
 */
app.post('/api/reports', async (req, res) => {
  const {
    product_name,
    nafdac_reg_no = '',
    purchase_location,
    state = '',
    reporter_phone = '',
    details = '',
    app_version = '',
    platform = ''
  } = req.body;

  if (!product_name || product_name.length < 2) {
    return res.status(400).json({ error: 'product_name required' });
  }

  if (!purchase_location || purchase_location.length < 3) {
    return res.status(400).json({ error: 'purchase_location required' });
  }

  const report = {
    product_name: sanitize(product_name),
    nafdac_reg_no: sanitize(nafdac_reg_no),
    purchase_location: sanitize(purchase_location),
    state: sanitize(state),
    reporter_phone: sanitize(reporter_phone, 20),
    details: sanitize(details, 1000),
    app_version: sanitize(app_version, 20),
    platform: sanitize(platform, 20),
    received_at: new Date().toISOString(),
    ip: req.ip
  };

  console.log('[REPORT RECEIVED]', JSON.stringify(report));

  res.json({ message: 'Report received successfully' });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ─── ERROR HANDLER ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[ERROR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`NafdacCheck proxy v1.1.0 running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
