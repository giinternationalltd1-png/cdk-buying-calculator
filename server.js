const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;

// EU API key - covers all EU markets
const BM_KEY_EU = 'N2EzMDZkNzY2MWRkNjgzZWU2MDIxZjpCTVQtMDY1MTAwN2VlZjIxZWQzOGFkZDEwODhlNjE4Y2QxNTI3Yjg4ZmY1Mw==';
// UK API key
const BM_KEY_UK = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';

const BM_HOST_EU = 'www.backmarket.fr';
const BM_HOST_UK = 'www.backmarket.co.uk';

const MARKETS = {
  'fr-fr': { name: 'France', currency: 'EUR', flag: 'FR', key: BM_KEY_EU, host: BM_HOST_EU },
  'de-de': { name: 'Germany', currency: 'EUR', flag: 'DE', key: BM_KEY_EU, host: BM_HOST_EU },
  'it-it': { name: 'Italy', currency: 'EUR', flag: 'IT', key: BM_KEY_EU, host: BM_HOST_EU },
  'es-es': { name: 'Spain', currency: 'EUR', flag: 'ES', key: BM_KEY_EU, host: BM_HOST_EU },
  'de-at': { name: 'Austria', currency: 'EUR', flag: 'AT', key: BM_KEY_EU, host: BM_HOST_EU },
  'fr-be': { name: 'Belgium', currency: 'EUR', flag: 'BE', key: BM_KEY_EU, host: BM_HOST_EU },
  'nl-nl': { name: 'Netherlands', currency: 'EUR', flag: 'NL', key: BM_KEY_EU, host: BM_HOST_EU },
  'pt-pt': { name: 'Portugal', currency: 'EUR', flag: 'PT', key: BM_KEY_EU, host: BM_HOST_EU },
  'en-ie': { name: 'Ireland', currency: 'EUR', flag: 'IE', key: BM_KEY_EU, host: BM_HOST_EU },
  'el-gr': { name: 'Greece', currency: 'EUR', flag: 'GR', key: BM_KEY_EU, host: BM_HOST_EU },
  'sv-se': { name: 'Sweden', currency: 'SEK', flag: 'SE', key: BM_KEY_EU, host: BM_HOST_EU },
  'en-gb': { name: 'United Kingdom', currency: 'GBP', flag: 'GB', key: BM_KEY_UK, host: BM_HOST_UK },
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

// Search ALL listings (all publication states — in stock and out of stock)
async function searchListings(query, simFilter) {
  let allListings = [];
  // No publication_state filter = returns all listings regardless of stock
  for (let page = 1; page <= 4; page++) {
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

  const terms = query.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 1);

  const matched = allListings.map(item => {
    const title = item.title || item.name || '';
    const tl = title.toLowerCase();
    let score = 0;
    for (const t of terms) { if (tl.includes(t)) score += t.length; }
    if (score < Math.ceil(terms.reduce((a,t)=>a+t.length,0) * 0.5)) return null;

    const simType = (tl.includes('esim') || tl.includes('e-sim')) ? 'esim'
      : tl.includes('physical') ? 'physical' : 'both';
    if (simFilter === 'esim' && !['esim','both'].includes(simType)) return null;
    if (simFilter === 'physical' && !['physical','both'].includes(simType)) return null;

    // Stock status
    const qty = typeof item.quantity === 'number' ? item.quantity : null;
    const pubState = item.publication_state;
    // publication_state 2 = online/active, others = offline
    const inStock = pubState === 2 && qty > 0;
    const stockLabel = qty === null ? 'unknown'
      : qty === 0 ? 'out_of_stock'
      : pubState !== 2 ? 'offline'
      : 'in_stock';

    return {
      id: item.id,
      product_id: item.product_id,
      title,
      listedPrice: parseFloat(item.price) || 0,
      grade: item.grade || '',
      simType,
      currency: item.currency || 'EUR',
      score,
      quantity: qty,
      inStock,
      stockLabel,
      publicationState: pubState
    };
  }).filter(Boolean).sort((a,b) => b.score - a.score).slice(0, 8);

  return matched;
}

// Get BackBox data for a listing — uses EU key for EU, UK key for UK
async function getBackboxData(listingId) {
  // Try EU first (primary), then UK
  const attempts = [
    { host: BM_HOST_EU, key: BM_KEY_EU, locale: 'fr-fr' },
    { host: BM_HOST_UK, key: BM_KEY_UK, locale: 'en-gb' }
  ];

  let allCompetitors = [];
  for (const a of attempts) {
    try {
      const r = await httpsGet(a.host, '/ws/backbox/v1/competitors/' + listingId, {
        'Authorization': 'Basic ' + a.key, 'Accept': 'application/json', 'Accept-Language': a.locale
      });
      if (r.status === 200) {
        const data = JSON.parse(r.body);
        if (Array.isArray(data) && data.length) {
          allCompetitors = allCompetitors.concat(data);
        }
      }
    } catch(e) {}
  }

  if (!allCompetitors.length) return [];

  const marketKeys = {
    'FR':'fr-fr','DE':'de-de','IT':'it-it','ES':'es-es','AT':'de-at',
    'BE':'fr-be','NL':'nl-nl','PT':'pt-pt','IE':'en-ie','GR':'el-gr',
    'SE':'sv-se','GB':'en-gb','UK':'en-gb'
  };

  const byMarket = {};
  for (const c of allCompetitors) {
    const flag = c.market;
    if (!flag) continue;
    if (!byMarket[flag]) byMarket[flag] = {};
    if (c.winner_price && c.winner_price.amount) {
      byMarket[flag].winnerPrice = parseFloat(c.winner_price.amount);
      byMarket[flag].currency = c.winner_price.currency || 'EUR';
    }
    if (c.price_to_win && c.price_to_win.amount) {
      byMarket[flag].priceToWin = parseFloat(c.price_to_win.amount);
    }
    if (!byMarket[flag].currency && c.price && c.price.currency) {
      byMarket[flag].currency = c.price.currency;
    }
  }

  return Object.entries(byMarket)
    .map(([flag, data]) => {
      const locale = marketKeys[flag] || flag.toLowerCase();
      const info = MARKETS[locale] || { name: flag, currency: data.currency||'EUR', flag };
      return {
        flag, locale,
        marketName: info.name,
        currency: data.currency || info.currency,
        winnerPrice: data.winnerPrice || null,
        priceToWin: data.priceToWin || null
      };
    })
    .filter(m => m.winnerPrice || m.priceToWin)
    .sort((a,b) => a.marketName.localeCompare(b.marketName));
}

async function handleSearch(query, simFilter, res) {
  try {
    const listings = await searchListings(query, simFilter);
    if (!listings.length) return jsend(res, 200, { count: 0, results: [] });

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