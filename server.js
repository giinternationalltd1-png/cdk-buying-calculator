const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PORT = process.env.PORT || 3000;
const BM_KEY = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';
const BM_HOST = 'www.backmarket.fr';

function httpsGet(hostname, p, hdrs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET',
      headers: { 'User-Agent': 'BM-GandI-Calculator;tech@gi-international.com', ...hdrs }
    }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function extractPrice(item) {
  if (!item) return null;
  if (item.price !== undefined && typeof item.price !== 'object') return parseFloat(item.price);
  if (item.price && item.price.amount !== undefined) return parseFloat(item.price.amount);
  if (item.unit_price !== undefined) return parseFloat(item.unit_price);
  return null;
}

function extractSimType(title) {
  const t = (title || '').toLowerCase();
  if (t.includes('esim') || t.includes('e-sim')) return 'esim';
  if (t.includes('physical sim') || t.includes('physical')) return 'physical';
  return 'unknown';
}

function gradeOrder(g) {
  const n = (g || '').toLowerCase();
  if (n === 'premium') return 0;
  if (n === 'excellent') return 1;
  if (n === 'very_good' || n.includes('very good')) return 2;
  if (n === 'good') return 3;
  if (n === 'fair') return 4;
  return 5;
}

function matchScore(title, terms) {
  const t = title.toLowerCase();
  let matched = 0;
  for (const term of terms) { if (t.includes(term)) matched++; }
  if (matched < Math.ceil(terms.length * 0.6)) return 0;
  return matched;
}

// Fetch BackBox competitor data for a listing to get winner_price
async function getBackboxPrice(listingId, market) {
  try {
    const r = await httpsGet(BM_HOST, '/ws/backbox/v1/competitors/' + listingId, {
      'Authorization': 'Basic ' + BM_KEY,
      'Accept': 'application/json',
      'Accept-Language': market || 'en-gb'
    });
    if (r.status !== 200) return null;
    const competitors = JSON.parse(r.body);
    if (!Array.isArray(competitors) || competitors.length === 0) return null;

    // Find the winner_price — this is the actual market selling price (BackBox winner)
    // winner_price is what the current BackBox winner is selling for
    const withWinner = competitors.find(c => c.winner_price && c.winner_price.amount);
    if (withWinner) return parseFloat(withWinner.winner_price.amount);

    // Fallback: lowest competitor price
    const prices = competitors
      .filter(c => c.price && c.price.amount)
      .map(c => parseFloat(c.price.amount))
      .filter(p => !isNaN(p) && p > 0);
    if (prices.length > 0) return Math.min(...prices);

    return null;
  } catch(e) {
    return null;
  }
}

async function searchListings(query, simFilter, market, res) {
  const bmPath = '/ws/listings?page_size=100&publication_state=2';
  try {
    const r = await httpsGet(BM_HOST, bmPath, {
      'Authorization': 'Basic ' + BM_KEY,
      'Accept': 'application/json',
      'Accept-Language': market || 'en-gb'
    });

    let parsed;
    try { parsed = JSON.parse(r.body); } catch(e) {
      return jsend(res, 502, { error: 'Invalid JSON from BackMarket. Status: ' + r.status });
    }
    if (r.status !== 200) {
      const msg = (parsed.error && (parsed.error.message || parsed.error.code)) || ('Status ' + r.status);
      return jsend(res, r.status, { error: msg });
    }

    let raw = [];
    if (Array.isArray(parsed)) raw = parsed;
    else if (Array.isArray(parsed.results)) raw = parsed.results;
    else if (Array.isArray(parsed.listings)) raw = parsed.listings;

    const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

    // Filter and score matches
    const matched = raw
      .map(item => {
        const title = item.title || item.name || 'Listing';
        const score = matchScore(title, terms);
        if (score === 0) return null;
        const listedPrice = parseFloat(item.price) || 0;
        const grade = item.grade || '';
        const simType = extractSimType(title);
        if (simFilter && simFilter !== 'all') {
          if (simFilter === 'esim' && simType !== 'esim') return null;
          if (simFilter === 'physical' && simType !== 'physical') return null;
        }
        return {
          id: item.id,           // UUID — needed for BackBox API
          listing_id: item.listing_id,
          title,
          listedPrice,
          grade,
          simType,
          score,
          currency: item.currency || 'EUR',
          sku: item.sku || ''
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.score - a.score || gradeOrder(a.grade) - gradeOrder(b.grade) || a.listedPrice - b.listedPrice)
      .slice(0, 15);

    if (matched.length === 0) {
      return jsend(res, 200, { count: 0, results: [] });
    }

    // For each matched listing, fetch the BackBox winner_price (real market price)
    const enriched = await Promise.all(
      matched.map(async item => {
        const winnerPrice = await getBackboxPrice(item.id, market || 'en-gb');
        return {
          id: item.id,
          title: item.title,
          listedPrice: item.listedPrice,
          marketPrice: winnerPrice,           // BackBox winner price — real selling price
          price: winnerPrice || item.listedPrice, // Use market price if available, else listed
          priceSource: winnerPrice ? 'backbox_winner' : 'listed_price',
          grade: item.grade,
          simType: item.simType,
          currency: item.currency,
          sku: item.sku
        };
      })
    );

    jsend(res, 200, { count: enriched.length, results: enriched });

  } catch(e) {
    jsend(res, 502, { error: 'Cannot reach BackMarket: ' + e.message });
  }
}

async function exchangeRate(res) {
  try {
    const r = await httpsGet('api.exchangerate-api.com', '/v4/latest/USD', { Accept: 'application/json' });
    const d = JSON.parse(r.body);
    jsend(res, 200, { rate: d.rates.EUR });
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
    const mkt = (parsed.query.market || 'en-gb').trim();
    return q ? searchListings(q, sim, mkt, res) : jsend(res, 400, { error: 'Missing ?q=' });
  }
  if (p === '/api/rate') return exchangeRate(res);
  serveFile(p, res);
}).listen(PORT, '0.0.0.0', () => console.log('CDK Calculator on port ' + PORT));