const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const BM_KEY_EU = 'N2EzMDZkNzY2MWRkNjgzZWU2MDIxZjpCTVQtMDY1MTAwN2VlZjIxZWQzOGFkZDEwODhlNjE4Y2QxNTI3Yjg4ZmY1Mw==';
const BM_KEY_UK = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';
const BM_HOST_EU = 'www.backmarket.fr';
const BM_HOST_UK = 'www.backmarket.co.uk';

const MARKETS = {
  'FR':{ name:'France', currency:'EUR' },
  'DE':{ name:'Germany', currency:'EUR' },
  'IT':{ name:'Italy', currency:'EUR' },
  'ES':{ name:'Spain', currency:'EUR' },
  'AT':{ name:'Austria', currency:'EUR' },
  'BE':{ name:'Belgium', currency:'EUR' },
  'NL':{ name:'Netherlands', currency:'EUR' },
  'PT':{ name:'Portugal', currency:'EUR' },
  'IE':{ name:'Ireland', currency:'EUR' },
  'GR':{ name:'Greece', currency:'EUR' },
  'SE':{ name:'Sweden', currency:'SEK' },
  'GB':{ name:'United Kingdom', currency:'GBP' },
  'UK':{ name:'United Kingdom', currency:'GBP' },
};

function httpsGet(hostname, p, hdrs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET',
      headers: { 'User-Agent': 'BM-GandI-CDKCalculator;tech@gi-international.com', ...hdrs }
    }, r => {
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// ─── Keyword aliases so short/informal searches still match ──────────────────
const ALIASES = {
  's22': 'galaxy s22', 's21': 'galaxy s21', 's23': 'galaxy s23', 's24': 'galaxy s24',
  's20': 'galaxy s20', 'note20': 'galaxy note 20', 'note10': 'galaxy note 10',
  'iphone14': 'iphone 14', 'iphone13': 'iphone 13', 'iphone12': 'iphone 12',
  'iphone15': 'iphone 15', 'iphone16': 'iphone 16', 'iphone11': 'iphone 11',
  'pro max': 'pro max', 'plus': 'plus', 'ultra': 'ultra',
  'pixel7': 'pixel 7', 'pixel8': 'pixel 8', 'pixel6': 'pixel 6',
};

function expandQuery(q) {
  let expanded = q.toLowerCase().trim();
  // Apply aliases
  for (const [short, full] of Object.entries(ALIASES)) {
    expanded = expanded.replace(new RegExp('\\b' + short + '\\b', 'g'), full);
  }
  return expanded;
}

// Score how well a listing title matches the query
// Flexible: partial word matches, handles "iphone 14" matching "iPhone 14 128GB - Midnight - Unlocked"
function scoreMatch(title, queryTerms) {
  const t = title.toLowerCase();
  let matched = 0;
  let totalScore = 0;
  for (const term of queryTerms) {
    if (t.includes(term)) {
      matched++;
      totalScore += term.length; // longer matches worth more
    }
  }
  // Need at least 60% of terms to match
  if (matched < Math.ceil(queryTerms.length * 0.6)) return 0;
  return totalScore;
}

async function searchListings(query, simFilter) {
  const expanded = expandQuery(query);
  const terms = expanded.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 0);

  let allListings = [];
  // Fetch all pages — no publication_state filter so we get all regardless of stock
  for (let page = 1; page <= 5; page++) {
    try {
      const r = await httpsGet(BM_HOST_EU,
        '/ws/listings?page=' + page + '&page_size=50',
        { 'Authorization': 'Basic ' + BM_KEY_EU, 'Accept': 'application/json', 'Accept-Language': 'fr-fr' }
      );
      if (r.status !== 200) break;
      const d = JSON.parse(r.body);
      const results = Array.isArray(d) ? d : (d.results || []);
      if (!results.length) break;
      allListings = allListings.concat(results);
      if (!d.next) break;
    } catch(e) { break; }
  }

  const matched = allListings.map(item => {
    const title = item.title || item.name || '';
    const score = scoreMatch(title, terms);
    if (score === 0) return null;

    const tl = title.toLowerCase();
    const simType = (tl.includes('esim') || tl.includes('e-sim')) ? 'esim'
      : tl.includes('physical') ? 'physical' : 'both';
    if (simFilter === 'esim' && simType === 'physical') return null;
    if (simFilter === 'physical' && simType === 'esim') return null;

    const qty = typeof item.quantity === 'number' ? item.quantity : null;
    const pubState = item.publication_state;
    const stockLabel = qty === 0 ? 'out_of_stock'
      : pubState !== 2 ? 'offline'
      : 'in_stock';

    return {
      id: item.id,
      title,
      listedPrice: parseFloat(item.price) || 0,
      grade: item.grade || '',
      simType,
      currency: item.currency || 'EUR',
      score,
      quantity: qty,
      stockLabel,
    };
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 10);

  return matched;
}

// ─── BackBox data ─────────────────────────────────────────────────────────────
// From the API spec and back office screenshots:
//   winner_price  = CURRENT BackBox price (what the winner is selling for right now)
//   price_to_win  = price YOU need to set to WIN the BackBox (lower than winner_price)
// These map exactly to the back office columns:
//   "Current BackBox price" = winner_price
//   "Price to win BackBox"  = price_to_win
async function getBackboxData(listingId) {
  const attempts = [
    { host: BM_HOST_EU, key: BM_KEY_EU, locale: 'fr-fr' },
    { host: BM_HOST_UK, key: BM_KEY_UK, locale: 'en-gb' },
  ];

  let allCompetitors = [];
  for (const a of attempts) {
    try {
      const r = await httpsGet(a.host, '/ws/backbox/v1/competitors/' + listingId, {
        'Authorization': 'Basic ' + a.key,
        'Accept': 'application/json',
        'Accept-Language': a.locale
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        if (Array.isArray(data) && data.length) allCompetitors = allCompetitors.concat(data);
      }
    } catch(e) {}
  }

  if (!allCompetitors.length) return [];

  // Group by market flag, pick best data per market
  const byMarket = {};
  for (const c of allCompetitors) {
    const flag = (c.market || '').toUpperCase();
    if (!flag) continue;
    if (!byMarket[flag]) byMarket[flag] = {};

    // winner_price = current BackBox price (the price the current winner charges)
    if (c.winner_price && c.winner_price.amount != null) {
      const wp = parseFloat(c.winner_price.amount);
      if (!isNaN(wp) && wp > 0) {
        byMarket[flag].winnerPrice = wp;
        byMarket[flag].currency = c.winner_price.currency || byMarket[flag].currency || 'EUR';
      }
    }

    // price_to_win = what price you need to set to win the BackBox
    if (c.price_to_win && c.price_to_win.amount != null) {
      const ptw = parseFloat(c.price_to_win.amount);
      if (!isNaN(ptw) && ptw > 0) byMarket[flag].priceToWin = ptw;
    }

    // fallback currency from price field
    if (!byMarket[flag].currency && c.price && c.price.currency) {
      byMarket[flag].currency = c.price.currency;
    }
  }

  const info = Object.entries(byMarket)
    .map(([flag, data]) => {
      const mkt = MARKETS[flag] || MARKETS[flag === 'UK' ? 'GB' : flag] || { name: flag, currency: 'EUR' };
      return {
        flag: flag === 'UK' ? 'GB' : flag,
        marketName: mkt.name,
        currency: data.currency || mkt.currency,
        winnerPrice: data.winnerPrice || null,   // "Current BackBox price"
        priceToWin: data.priceToWin || null,     // "Price to win BackBox"
      };
    })
    .filter(m => m.winnerPrice || m.priceToWin)
    .sort((a, b) => a.marketName.localeCompare(b.marketName));

  return info;
}

async function handleSearch(query, simFilter, res) {
  try {
    const listings = await searchListings(query, simFilter);
    if (!listings.length) return jsend(res, 200, { count: 0, results: [] });

    const enriched = await Promise.all(
      listings.map(async listing => ({
        ...listing,
        markets: listing.id ? await getBackboxData(listing.id) : []
      }))
    );

    jsend(res, 200, { count: enriched.length, results: enriched });
  } catch(e) {
    jsend(res, 502, { error: e.message });
  }
}

async function exchangeRate(res) {
  try {
    const r = await httpsGet('api.exchangerate-api.com', '/v4/latest/USD', { Accept: 'application/json' });
    const d = JSON.parse(r.body);
    jsend(res, 200, { rate: d.rates.EUR, rates: d.rates });
  } catch(e) {
    jsend(res, 502, { error: 'Exchange rate unavailable' });
  }
}

const MIME = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.json':'application/json' };
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
    return q ? handleSearch(q, sim, res) : jsend(res, 400, { error: 'Missing ?q=' });
  }
  if (p === '/api/rate') return exchangeRate(res);
  serveFile(p, res);
}).listen(PORT, '0.0.0.0', () => console.log('CDK Calculator on port ' + PORT));