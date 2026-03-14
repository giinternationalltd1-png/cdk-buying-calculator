const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const BM_KEY = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';
const BM_HOST = 'www.backmarket.fr';

// Market code -> display name + currency
const MARKETS = {
  'fr-fr': { name: 'France', currency: 'EUR', flag: 'FR' },
  'de-de': { name: 'Germany', currency: 'EUR', flag: 'DE' },
  'it-it': { name: 'Italy', currency: 'EUR', flag: 'IT' },
  'es-es': { name: 'Spain', currency: 'EUR', flag: 'ES' },
  'de-at': { name: 'Austria', currency: 'EUR', flag: 'AT' },
  'fr-be': { name: 'Belgium', currency: 'EUR', flag: 'BE' },
  'nl-nl': { name: 'Netherlands', currency: 'EUR', flag: 'NL' },
  'pt-pt': { name: 'Portugal', currency: 'EUR', flag: 'PT' },
  'en-ie': { name: 'Ireland', currency: 'EUR', flag: 'IE' },
  'el-gr': { name: 'Greece', currency: 'EUR', flag: 'GR' },
  'sv-se': { name: 'Sweden', currency: 'SEK', flag: 'SE' },
  'en-gb': { name: 'United Kingdom', currency: 'GBP', flag: 'GB' },
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

// Step 1: Search BM catalogue for products matching query
// Uses /ws/listings endpoint but we search ALL listings, filter by title match,
// then use listing IDs to get BackBox competitor prices
async function searchProducts(query, simFilter) {
  // Fetch seller listings - use publication_state=2 (online) and get max results
  // We fetch multiple pages to get full catalogue
  let allListings = [];
  
  for (let page = 1; page <= 3; page++) {
    try {
      const r = await httpsGet(BM_HOST, '/ws/listings?page=' + page + '&page_size=50&publication_state=2', {
        'Authorization': 'Basic ' + BM_KEY,
        'Accept': 'application/json',
        'Accept-Language': 'en-gb'
      });
      if (r.status !== 200) break;
      const d = JSON.parse(r.body);
      const results = Array.isArray(d) ? d : (d.results || []);
      if (!results.length) break;
      allListings = allListings.concat(results);
      if (!d.next) break;
    } catch(e) { break; }
  }

  // Tokenise and score match
  const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g,' ').split(/\s+/).filter(t => t.length > 1);
  
  const matched = allListings
    .map(item => {
      const title = item.title || item.name || '';
      const tl = title.toLowerCase();
      let score = 0;
      for (const term of terms) { if (tl.includes(term)) score += term.length; }
      if (score < Math.ceil(terms.reduce((a,t)=>a+t.length,0) * 0.5)) return null;

      const simType = tl.includes('esim') || tl.includes('e-sim') ? 'esim'
        : tl.includes('physical') ? 'physical' : 'both';
      if (simFilter === 'esim' && !['esim','both'].includes(simType)) return null;
      if (simFilter === 'physical' && !['physical','both'].includes(simType)) return null;

      return {
        id: item.id,
        product_id: item.product_id,
        title,
        listedPrice: parseFloat(item.price) || 0,
        grade: item.grade || '',
        simType,
        currency: item.currency || 'EUR',
        score
      };
    })
    .filter(Boolean)
    .sort((a,b) => b.score - a.score)
    .slice(0, 8); // top 8 matches

  return matched;
}

// Step 2: For each listing, get BackBox competitor data across all markets
async function getBackboxData(listingId) {
  try {
    const r = await httpsGet(BM_HOST, '/ws/backbox/v1/competitors/' + listingId, {
      'Authorization': 'Basic ' + BM_KEY,
      'Accept': 'application/json',
      'Accept-Language': 'en-gb'
    });
    if (r.status !== 200) return [];
    const data = JSON.parse(r.body);
    if (!Array.isArray(data)) return [];
    
    // Group by market, extract winner_price (current BackBox price = what buyer pays)
    const byMarket = {};
    for (const c of data) {
      const mkt = c.market;
      if (!mkt) continue;
      if (!byMarket[mkt] || c.winner_price) {
        const winnerAmt = c.winner_price && c.winner_price.amount ? parseFloat(c.winner_price.amount) : null;
        const priceToWin = c.price_to_win && c.price_to_win.amount ? parseFloat(c.price_to_win.amount) : null;
        const currentPrice = c.price && c.price.amount ? parseFloat(c.price.amount) : null;
        if (!byMarket[mkt]) byMarket[mkt] = {};
        if (winnerAmt) byMarket[mkt].winnerPrice = winnerAmt;
        if (priceToWin) byMarket[mkt].priceToWin = priceToWin;
        if (currentPrice && !byMarket[mkt].currentPrice) byMarket[mkt].currentPrice = currentPrice;
        byMarket[mkt].currency = c.winner_price && c.winner_price.currency
          ? c.winner_price.currency
          : (c.price && c.price.currency ? c.price.currency : 'EUR');
      }
    }
    
    // Convert to array, map market codes to our MARKETS dict
    const marketKeys = { 'FR':'fr-fr','DE':'de-de','IT':'it-it','ES':'es-es','AT':'de-at',
      'BE':'fr-be','NL':'nl-nl','PT':'pt-pt','IE':'en-ie','GR':'el-gr','SE':'sv-se','GB':'en-gb','UK':'en-gb' };
    
    return Object.entries(byMarket)
      .map(([flag, data]) => {
        const locale = marketKeys[flag] || flag.toLowerCase();
        const info = MARKETS[locale] || { name: flag, currency: data.currency || 'EUR', flag };
        return {
          flag,
          locale,
          marketName: info.name,
          currency: data.currency || info.currency,
          winnerPrice: data.winnerPrice || null,
          priceToWin: data.priceToWin || null,
          currentPrice: data.currentPrice || null
        };
      })
      .filter(m => m.winnerPrice || m.currentPrice)
      .sort((a,b) => (a.marketName||'').localeCompare(b.marketName||''));
  } catch(e) {
    return [];
  }
}

async function handleSearch(query, simFilter, res) {
  try {
    const listings = await searchProducts(query, simFilter);
    
    if (!listings.length) {
      return jsend(res, 200, { count: 0, results: [] });
    }

    // Fetch BackBox data for all matches in parallel
    const enriched = await Promise.all(
      listings.map(async listing => {
        const markets = listing.id ? await getBackboxData(listing.id) : [];
        return { ...listing, markets };
      })
    );

    jsend(res, 200, { count: enriched.length, results: enriched });
  } catch(e) {
    jsend(res, 502, { error: 'Error: ' + e.message });
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

const MIME = { '.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.json':'application/json' };
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
}).listen(PORT, '0.0.0.0', () => console.log('CDK Calculator running on port ' + PORT));