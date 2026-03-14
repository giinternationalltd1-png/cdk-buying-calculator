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

function httpsGet(hostname, p, hdrs, redir) {
  redir = redir || 0;
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', 'Accept-Language': 'de-DE,de;q=0.9', ...hdrs }
    }, r => {
      if (redir < 4 && (r.statusCode === 301 || r.statusCode === 302) && r.headers.location) {
        const loc = r.headers.location;
        try {
          const u = loc.startsWith('http') ? new URL(loc) : new URL(loc, 'https://' + hostname);
          return httpsGet(u.hostname, u.pathname + u.search, hdrs, redir + 1).then(resolve).catch(reject);
        } catch(e) { return reject(e); }
      }
      let b = ''; r.on('data', c => b += c); r.on('end', () => resolve({ status: r.statusCode, body: b }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

// Search BackMarket.de — uses their keyword-optimised public search
async function scrapeSearch(query) {
  const r = await httpsGet('www.backmarket.de', '/de-de/search?q=' + encodeURIComponent(query), {
    'Accept': 'text/html,application/xhtml+xml'
  });
  if (r.status !== 200) throw new Error('BM.de search ' + r.status);
  const html = r.body;

  // Extract product links using string indexOf (no regex flags needed)
  const seen = new Set();
  const links = [];
  let pos = 0;
  const PREFIX = '/de-de/p/';
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  while (pos < html.length && links.length < 8) {
    const hi = html.indexOf('href="' + PREFIX, pos);
    if (hi === -1) break;
    const end = html.indexOf('"', hi + 6);
    if (end === -1) break;
    const href = html.slice(hi + 6, end).split('?')[0].split('#')[0];
    pos = end + 1;
    const parts = href.split('/');
    const last = parts[parts.length - 1];
    if (!seen.has(href) && UUID_RE.test(last)) {
      seen.add(href);
      links.push('https://www.backmarket.de' + href);
    }
  }
  return links;
}

// Scrape product page — extract price from schema.org JSON embedded in page
async function scrapeProduct(productUrl) {
  try {
    const u = new URL(productUrl);
    const r = await httpsGet(u.hostname, u.pathname, { 'Accept': 'text/html,application/xhtml+xml' });
    if (r.status !== 200) return null;
    const html = r.body;

    // Title from <h1>
    let title = '';
    const h1s = html.indexOf('<h1');
    if (h1s !== -1) {
      const h1c = html.indexOf('>', h1s);
      const h1e = html.indexOf('</h1>', h1c);
      if (h1e !== -1) title = html.slice(h1c + 1, h1e).trim().replace(/\s+/g, ' ');
    }

    // Price from schema.org ld+json
    let price = null, currency = 'EUR';
    let sp = 0;
    while (sp < html.length) {
      const si = html.indexOf('application/ld+json', sp);
      if (si === -1) break;
      const ji = html.indexOf('{', si);
      const je = html.indexOf('</script>', si);
      if (ji === -1 || je === -1 || ji > je) { sp = je + 1; continue; }
      try {
        const schema = JSON.parse(html.slice(ji, je));
        if (schema && schema.offers && schema.offers.price) {
          price = parseFloat(schema.offers.price);
          currency = schema.offers.priceCurrency || 'EUR';
          break;
        }
      } catch(e) {}
      sp = je + 1;
    }
    if (!price) return null;

    const tl = title.toLowerCase();
    const simType = (tl.includes('esim') || tl.includes('e-sim')) ? 'esim'
      : tl.includes('physical') ? 'physical' : 'both';

    const um = productUrl.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    return { title, price, currency, simType, uuid: um ? um[1] : null, url: productUrl };
  } catch(e) { return null; }
}

async function handleSearch(query, simFilter, res) {
  try {
    const links = await scrapeSearch(query);
    if (!links.length) return jsend(res, 200, { count: 0, results: [] });

    const pages = await Promise.all(links.map(l => scrapeProduct(l)));
    const valid = pages.filter(p => p && p.price);

    const results = valid
      .filter(p => {
        if (simFilter === 'all') return true;
        if (simFilter === 'esim') return p.simType === 'esim' || p.simType === 'both';
        if (simFilter === 'physical') return p.simType === 'physical' || p.simType === 'both';
        return true;
      })
      .map(p => ({
        title: p.title,
        simType: p.simType,
        currency: p.currency,
        livePrice: p.price,
        adjustedPrice: Math.round(p.price * 0.95 * 100) / 100,
        stockLabel: 'in_stock',
        quantity: null,
        markets: [],
        productUrl: p.url,
        priceSource: 'backmarket_de_live'
      }));

    jsend(res, 200, { count: results.length, results, query });
  } catch(e) {
    jsend(res, 502, { error: e.message });
  }
}

async function exchangeRate(res) {
  try {
    const r = await httpsGet('api.exchangerate-api.com', '/v4/latest/USD', { Accept: 'application/json' });
    const d = JSON.parse(r.body);
    jsend(res, 200, { rate: d.rates.EUR, rates: d.rates });
  } catch(e) { jsend(res, 502, { error: 'Exchange rate unavailable' }); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json' };
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
    const q = (parsed.query.q || '').trim(), sim = (parsed.query.sim || 'all').trim();
    return q ? handleSearch(q, sim, res) : jsend(res, 400, { error: 'Missing ?q=' });
  }
  if (p === '/api/rate') return exchangeRate(res);
  serveFile(p, res);
}).listen(PORT, '0.0.0.0', () => console.log('CDK Calculator on port ' + PORT));