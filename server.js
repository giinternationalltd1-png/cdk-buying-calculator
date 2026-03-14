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
  'SK':{ name:'Slovakia', currency:'EUR' },
  'FI':{ name:'Finland', currency:'EUR' },
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

// Extract storage size from a string e.g. "128gb" -> "128", "256 gb" -> "256"
function extractStorage(s) {
  const m = s.toLowerCase().match(/(\d+)\s*gb/);
  return m ? m[1] : null;
}

// Extract model number from title/query for strict matching
// e.g. "iPhone 16" vs "iPhone 16 Pro" vs "iPhone 16 Pro Max"
function extractModelTokens(s) {
  const t = s.toLowerCase()
    .replace(/iphone/g, 'iphone')
    .replace(/galaxy/g, 'galaxy')
    .replace(/samsung/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bgo\b/g, 'gb')      // French "Go" = GB
    .replace(/\s+/g, ' ')
    .trim();
  return t.split(' ').filter(x => x.length > 0);
}

// Strict scoring: storage GB must match exactly, model must match exactly
// "iphone 16 128gb" should NOT match "iphone 16 pro max 256gb"
function strictScore(queryTokens, titleTokens, queryStorage, titleStorage) {
  // If query has a storage size, title MUST match it exactly
  if (queryStorage && titleStorage && queryStorage !== titleStorage) return 0;
  if (queryStorage && !titleStorage) return 0; // query specifies storage, title has none

  // Check each query token exists in the title
  let matched = 0;
  for (const qt of queryTokens) {
    if (qt === queryStorage + 'gb') continue; // already handled storage
    if (titleTokens.includes(qt)) matched++;
  }

  const nonStorageQueryTokens = queryTokens.filter(t => t !== queryStorage + 'gb' && t !== queryStorage);
  if (nonStorageQueryTokens.length === 0) return 0;

  const ratio = matched / nonStorageQueryTokens.length;

  // Need 100% of meaningful query tokens to match for strict search
  // e.g. "iphone 16 128gb" must match ALL of: iphone, 16, 128gb
  if (ratio < 1.0) return 0;

  // Penalise if title has extra model qualifiers not in query
  // e.g. query="iphone 16" but title has "pro" or "max" or "plus" -> lower score
  const extras = ['pro', 'max', 'plus', 'ultra', 'mini', 'fe', 'lite', 'edge'];
  const queryHasExtras = extras.filter(e => queryTokens.includes(e));
  const titleHasExtras = extras.filter(e => titleTokens.includes(e));
  
  // Title has model qualifiers that aren't in the query = wrong model
  const unexpectedExtras = titleHasExtras.filter(e => !queryHasExtras.includes(e));
  if (unexpectedExtras.length > 0) return 0;

  return matched + (queryStorage ? 10 : 0); // storage match bonus
}

async function searchListings(query, simFilter) {
  // Normalise query
  const normQuery = query.toLowerCase()
    .replace(/\bsamsung\b/g, '')
    .replace(/\bgo\b/g, 'gb')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const queryTokens = extractModelTokens(normQuery);
  const queryStorage = extractStorage(normQuery);

  let allListings = [];
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
    const rawTitle = item.title || item.name || '';
    // Normalise title same way as query
    const normTitle = rawTitle.toLowerCase()
      .replace(/\bgo\b/g, 'gb')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const titleTokens = extractModelTokens(normTitle);
    const titleStorage = extractStorage(normTitle);

    const score = strictScore(queryTokens, titleTokens, queryStorage, titleStorage);
    if (score === 0) return null;

    const tl = rawTitle.toLowerCase();
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
      title: rawTitle,
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

  const byMarket = {};
  for (const c of allCompetitors) {
    const flag = (c.market || '').toUpperCase().replace('UK', 'GB');
    if (!flag) continue;
    if (!byMarket[flag]) byMarket[flag] = {};
    if (c.winner_price && c.winner_price.amount != null) {
      const wp = parseFloat(c.winner_price.amount);
      if (!isNaN(wp) && wp > 0) {
        byMarket[flag].winnerPrice = wp;
        byMarket[flag].currency = c.winner_price.currency || byMarket[flag].currency || 'EUR';
      }
    }
    if (c.price_to_win && c.price_to_win.amount != null) {
      const ptw = parseFloat(c.price_to_win.amount);
      if (!isNaN(ptw) && ptw > 0) byMarket[flag].priceToWin = ptw;
    }
    if (!byMarket[flag].currency && c.price && c.price.currency) {
      byMarket[flag].currency = c.price.currency;
    }
  }

  return Object.entries(byMarket)
    .map(([flag, data]) => {
      const mkt = MARKETS[flag] || { name: flag, currency: 'EUR' };
      return {
        flag,
        marketName: mkt.name,
        currency: data.currency || mkt.currency,
        winnerPrice: data.winnerPrice || null,
        priceToWin: data.priceToWin || null,
      };
    })
    .filter(m => m.winnerPrice || m.priceToWin)
    .sort((a, b) => a.marketName.localeCompare(b.marketName));
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