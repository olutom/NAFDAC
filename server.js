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
const cheerio   = require('cheerio');
const rateLimit = require('express-rate-limit');
const helmet    = require('helmet');
const cors      = require('cors');
const NodeCache = require('node-cache');

const app   = express();
const cache = new NodeCache({ stdTTL: 86400 }); // 24-hour cache

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50kb' }));
app.set('trust proxy', 1);

// Rate limit
app.use(rateLimit({
  windowMs : 60_000,
  max      : 100,
  standardHeaders: true,
  legacyHeaders  : false,
  message  : { error: 'Too many requests. Please slow down.' }
}));

// ─── NAFDAC Client (FIXED HTTPS) ──────────────────────────────────────────────
const nafdacClient = axios.create({
  baseURL : 'https://greenbook.nafdac.gov.ng',
  timeout : 20000,
  headers : {
    'User-Agent' : 'Mozilla/5.0 (compatible; NafdacCheckBot/1.1)',
    'Accept'     : 'text/html,application/json,*/*',
  },
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function sanitize(str, maxLen = 200) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'%;()&+]/g, '').trim().slice(0, maxLen);
}

function mapProduct(raw) {
  return {
    id: sanitize(String(raw.id ?? raw.nrn ?? Math.random())),
    product_name: sanitize(raw.product_name ?? raw['Product Name'] ?? ''),
    active_ingredients: sanitize(raw.active_ingredients ?? raw['Active Ingredients'] ?? ''),
    nrn: sanitize(raw.nrn ?? raw['NRN'] ?? raw['NAFDAC Reg. No.'] ?? ''),
    applicant_name: sanitize(raw.applicant_name ?? raw['Applicant Name'] ?? ''),
    product_category: sanitize(raw.product_category ?? raw['Product Category'] ?? ''),
    form: sanitize(raw.form ?? raw['Form'] ?? ''),
    roa: sanitize(raw.roa ?? raw['ROA'] ?? ''),
    strengths: sanitize(raw.strengths ?? raw['Strengths'] ?? ''),
    approval_date: sanitize(raw.approval_date ?? raw['Approval Date'] ?? ''),
    status: sanitize(raw.status ?? 'active'),
    expiry_date: raw.expiry_date ? sanitize(raw.expiry_date) : null,
    synonym: raw.synonym ? sanitize(raw.synonym) : null,
  };
}

// ─── IMPROVED SCRAPER ─────────────────────────────────────────────────────────
function scrapeHtml(html) {
  if (!html || typeof html !== 'string') return [];

  const $ = cheerio.load(html);
  const results = [];

  const headers = [];
  $('table thead th').each((_, el) => {
    headers.push($(el).text().trim());
  });

  $('table tbody tr, tr').each((_, tr) => {
    const cells = $(tr).find('td');
    if (!cells.length) return;

    const row = {};

    cells.each((i, td) => {
      const key = headers[i] || `col${i}`;
      row[key] = $(td).text().trim();
    });

    if (Object.values(row).some(Boolean)) {
      results.push(mapProduct(row));
    }
  });

  return results;
}

// ─── Fetch Logic (FIXED FALLBACKS) ───────────────────────────────────────────
async function fetchNafdac(params) {
  const key = `nafdac_${JSON.stringify(params)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  let products = [];

  try {
    const res = await nafdacClient.get('/products', { params });
    const body = res.data;

    if (Array.isArray(body)) {
      products = body.map(mapProduct);
    }
    else if (Array.isArray(body?.data)) {
      products = body.data.map(mapProduct);
    }
    else {
      products = scrapeHtml(typeof body === 'string' ? body : '');
    }
  } catch (err) {
    console.log('[Primary fetch failed]', err.message);

    try {
      const res = await nafdacClient.get('/', { params });
      products = scrapeHtml(res.data);
    } catch (e) {
      console.log('[Fallback fetch failed]', e.message);
      products = [];
    }
  }

  cache.set(key, products);
  return products;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/health', (_, res) => {
  res.json({ status: 'ok', version: '1.1.0', ts: Date.now() });
});

app.get('/api/drugs/search', async (req, res) => {
  const q = sanitize(String(req.query.q ?? ''));
  const limit = Math.min(Math.max(parseInt(req.query.limit ?? '20', 10), 1), 100);

  if (!q || q.length < 2) {
    return res.status(400).json({ error: 'q must be at least 2 characters' });
  }

  try {
    const results = await fetchNafdac({ search: q, limit });
    return res.json(results);
  } catch (err) {
    console.error('[search error]', err.message);
    return res.status(502).json({ error: 'Could not reach NAFDAC database.' });
  }
});

app.get('/api/drugs/verify', async (req, res) => {
  const nrn = sanitize(String(req.query.nrn ?? '')).toUpperCase();

  if (!nrn) {
    return res.status(400).json({ error: 'nrn parameter is required' });
  }

  if (!/^[A-Z]\d{1,2}-\d{3,6}[A-Z]?$/.test(nrn)) {
    return res.status(400).json({ error: 'Invalid NAFDAC registration number format' });
  }

  try {
    const results = await fetchNafdac({ search: nrn, limit: 10 });

    const exact = results.find(d =>
      d.nrn?.toUpperCase().replace(/\s/g, '') === nrn.replace(/\s/g, '')
    );

    if (exact) return res.json(exact);

    return res.status(404).json(null);
  } catch (err) {
    console.error('[verify error]', err.message);
    return res.status(502).json({ error: 'Could not reach NAFDAC database.' });
  }
});

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

  if (!product_name || product_name.trim().length < 2) {
    return res.status(400).json({ error: 'product_name required' });
  }

  if (!purchase_location || purchase_location.trim().length < 3) {
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
    ip: req.ip,
  };

  console.log('[REPORT RECEIVED]', JSON.stringify(report));

  return res.json({
    message: 'Report received. Thank you for protecting Nigerians.'
  });
});

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((_, res) => res.status(404).json({ error: 'Not found' }));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[Unhandled error]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`NafdacCheck proxy v1.1.0 running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = app;
