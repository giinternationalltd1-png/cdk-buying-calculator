const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PORT = process.env.PORT || 3000;
const BM_KEY = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';

function httpsGet(hostname, p, hdrs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname, path: p, method: 'GET', headers: { 'User-Agent': 'BM-GIInternational-CDKCalc;tech@giinternational.co.uk', ...hdrs } },
      res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); }
    );
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function bmHeaders() {
  return { 'Authorization': 'Basic ' + BM_KEY, 'Accept': 'application/json', 'Accept-Language': 'en-gb' };
}

// Extract price from a listing object (handles flat string, nested {amount}, or listing.price.amount)
function extractPrice(item) {
  if (!item) return null;
  if (item.price !== undefined && typeof item.price !== 'object') return parseFloat(item.price);
  if (item.price && item.price.amount !== undefined) return parseFloat(item.price.amount);
  if (item.listing && item.listing.price && item.listing.price.amount !== undefined) return parseFloat(item.listing.price.amount);
  return null;
}

function gradeLabel(g) {
  if (!g) return '';
  const n = (typeof g === 'string') ? g : '';
  const map = { PREMIUM: 'Premium', EXCELLENT: 'Excellent', VERY_GOOD: 'Very Good', GOOD: 'Good', FAIR: 'Fair', STALLONE: 'Fair' };
  return map[n] || n;
}

function extractSim(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('esim') || t.includes('e-sim')) return 'esim';
  if (t.includes('physical sim') || t.includes('physical')) return 'physical';
  return 'unknown';
}

function matchScore(title, terms) {
  const t = title.toLowerCase();
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    if (t.includes(term)) { matched++; score += term.length; }
  }
  return matched >= Math.ceil(terms.length * 0.55) ? score : 0;
}

// STEP 1: Get all G&I listings, filter by search query + SIM type, return with UUIDs
async function searchListings(query, simFilter, res) {
  try {
    // Fetch up to 50 listings per page, get pages 1 & 2 (max 100 total)
    const pages = await Promise.all([
      httpsGet('www.backmarket.fr', '/ws/listings?page_size=50&page=1', bmHeaders()),
      httpsGet('www.backmarket.fr', '/ws/listings?page_size=50&page=2', bmHeaders()),
    ]);

    let raw = [];
    for (const r of pages) {
      if (r.status === 200) {
        try {
          const d = JSON.parse(r.body);
          const items = Array.isArray(d) ? d : (Array.isArray(d.results) ? d.results : []);
          raw = raw.concat(items);
        } catch(e) {}
      }
    }

    if (!raw.length) {
      const first = JSON.parse(pages[0].body);
      const msg = (first.error && (first.error.message || first.error.code)) || ('Status ' + pages[0].status);
      return jsend(res, pages[0].status, { error: msg });
    }

    const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

    const items = raw
      .map(item => ({
        id: item.id || item.listing_id || '',          // UUID for BackBox API
        listing_id: item.listing_id || '',
        title: item.title || item.name || 'Listing',
        myPrice: extractPrice(item),
        grade: gradeLabel(item.grade || ''),
        currency: item.currency || 'EUR',
        simType: extractSim(item.title || ''),
        quantity: item.quantity || 0,
        score: matchScore(item.title || '', terms)
      }))
      .filter(i => {
        if (i.score === 0) return false;
        if (i.myPrice === null || isNaN(i.myPrice) || i.myPrice <= 0) return false;
        if (simFilter && simFilter !== 'all') {
          if (simFilter === 'esim' && i.simType !== 'esim') return false;
          if (simFilter === 'physical' && i.simType !== 'physical') return false;
        }
        return true;
      })
      .sort((a, b) => b.score - a.score || a.myPrice - b.myPrice)
      .slice(0, 15);

    jsend(res, 200, { count: items.length, results: items });
  } catch(e) {
    jsend(res, 502, { error: 'Cannot reach BackMarket: ' + e.message });
  }
}

// STEP 2: Get the real BackBox winner price for a specific listing UUID
// Returns winner_price (what the market is actually selling at) and whether G&I holds the BackBox
async function getBackboxPrice(listingId, res) {
  if (!listingId || listingId === 'undefined') {
    return jsend(res, 400, { error: 'Missing listing ID' });
  }
  try {
    const r = await httpsGet('www.backmarket.fr', '/ws/backbox/v1/competitors/' + listingId, bmHeaders());

    if (r.status === 404) {
      // No BackBox data - listing has no competitors, our price IS the market price
      return jsend(res, 200, { noCompetitors: true, message: 'No competitors found for this listing. Your listing may be the only one or not yet in a BackBox.' });
    }

    if (r.status !== 200) {
      let errMsg = 'BackBox API error ' + r.status;
      try { const e = JSON.parse(r.body); errMsg = (e.detail || e.message || errMsg); } catch(e2) {}
      return jsend(res, r.status, { error: errMsg });
    }

    const competitors = JSON.parse(r.body); // array of Competitor objects

    if (!Array.isArray(competitors) || !competitors.length) {
      return jsend(res, 200, { noCompetitors: true, message: 'No competitors found for this listing.' });
    }

    // Find the current BackBox winner (is_winning: true) or lowest price
    const winner = competitors.find(c => c.is_winning) || null;
    const giIsWinning = winner ? winner.is_winning : false;

    // winner_price = the price the BackBox is selling at right now
    const winnerPrice = winner && winner.winner_price ? parseFloat(winner.winner_price.amount || winner.winner_price) : null;
    const priceToWin = winner && winner.price_to_win ? parseFloat(winner.price_to_win.amount || winner.price_to_win) : null;
    const currency = (winner && winner.winner_price && winner.winner_price.currency) || 'EUR';

    // All competitor prices for context
    const allPrices = competitors.map(c => ({
      price: parseFloat((c.price && c.price.amount) || c.price || 0),
      isWinning: c.is_winning,
      market: c.market
    }));

    jsend(res, 200, {
      winnerPrice,
      priceToWin,
      currency,
      giIsWinning,
      competitorCount: competitors.length,
      allPrices,
      noCompetitors: false
    });
  } catch(e) {
    jsend(res, 502, { error: 'BackBox API error: ' + e.message });
  }
}

// Exchange rate
async function exchangeRate(res) {
  try {
    const r = await httpsGet('api.exchangerate-api.com', '/v4/latest/USD', { Accept: 'application/json' });
    const d = JSON.parse(r.body);
    jsend(res, 200, { rate: d.rates.EUR, base: 'USD', target: 'EUR' });
  } catch(e) {
    jsend(res, 502, { error: 'Exchange rate unavailable' });
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json' };
function serveFile(reqPath, res) {
  const fp = path.join(__dirname, 'public', reqPath === '/' ? 'index.html' : reqPath);
  fs.readFile(fp, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
    res.end(content);
  });
}

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  if (p === '/api/search') {
    const q = (parsed.query.q || '').trim();
    const sim = (parsed.query.sim || 'all').trim();
    return q ? searchListings(q, sim, res) : jsend(res, 400, { error: 'Missing ?q=' });
  }
  if (p === '/api/backbox') {
    const id = (parsed.query.id || '').trim();
    return getBackboxPrice(id, res);
  }
  if (p === '/api/rate') return exchangeRate(res);
  serveFile(p, res);
}).listen(PORT, '0.0.0.0', () => console.log('CDK Calculator running on port ' + PORT));