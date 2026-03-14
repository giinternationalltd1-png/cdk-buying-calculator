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

// Markets for BackBox data
const MARKETS = {
  'FR':{ name:'France', currency:'EUR' }, 'DE':{ name:'Germany', currency:'EUR' },
  'IT':{ name:'Italy', currency:'EUR' }, 'ES':{ name:'Spain', currency:'EUR' },
  'AT':{ name:'Austria', currency:'EUR' }, 'BE':{ name:'Belgium', currency:'EUR' },
  'NL':{ name:'Netherlands', currency:'EUR' }, 'PT':{ name:'Portugal', currency:'EUR' },
  'IE':{ name:'Ireland', currency:'EUR' }, 'GR':{ name:'Greece', currency:'EUR' },
  'SE':{ name:'Sweden', currency:'SEK' }, 'GB':{ name:'United Kingdom', currency:'GBP' },
  'UK':{ name:'United Kingdom', currency:'GBP' }, 'SK':{ name:'Slovakia', currency:'EUR' },
  'FI':{ name:'Finland', currency:'EUR' },
};

// Grade mapping: BM front-end grade names to our standard labels
const GRADE_MAP = {
  'Ausgezeichnet':'Excellent','Sehr gut':'Very Good','Gut':'Good','Akzeptabel':'Fair',
  'Excellent':'Excellent','Very good':'Very Good','Good':'Good','Fair':'Fair',
  'Parfait':'Excellent','Très bon':'Very Good','Bon':'Good','Correct':'Fair',
};

function httpsGet(hostname, p, hdrs, followRedirects) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36', ...hdrs }
    }, r => {
      // Handle redirects
      if (followRedirects && (r.statusCode === 301 || r.statusCode === 302) && r.headers.location) {
        const loc = r.headers.location;
        const parsed = new URL(loc, 'https://' + hostname);
        return httpsGet(parsed.hostname, parsed.pathname + parsed.search, hdrs, false)
          .then(resolve).catch(reject);
      }
      let b = ''; r.on('data', c => b += c);
      r.on('end', () => resolve({ status: r.statusCode, body: b, headers: r.headers }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(obj));
}

// Scrape BackMarket.de search results — uses keyword-optimised public search
// Returns product cards with title, price (lowest), product URL
async function scrapeSearch(query, simFilter) {
  const encodedQ = encodeURIComponent(query);
  const searchUrl = '/de-de/search?q=' + encodedQ;
  
  const r = await httpsGet('www.backmarket.de', searchUrl, {
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  }, true);

  if (r.status !== 200) throw new Error('BM search returned ' + r.status);
  
  const html = r.body;
  
  // Extract product links from HTML — BM uses /de-de/p/ pattern
  const productLinks = [];
  const linkRegex = /href="(/de-de/p/[^"#?]+(?:?[^"]*)?)"[^>]*>/g;
  let m;
  const seen = new Set();
  while ((m = linkRegex.exec(html)) !== null) {
    const href = m[1].split('?')[0]; // strip query params
    if (!seen.has(href) && href.match(//de-de/p/[^/]+/[a-f0-9-]{36}/)) {
      seen.add(href);
      productLinks.push('https://www.backmarket.de' + href);
    }
  }

  // Also get product names from the page to filter by query
  const titleRegex = /data-qa="product-card-title"[^>]*>([^<]+)</g;
  const titles = [];
  while ((m = titleRegex.exec(html)) !== null) titles.push(m[1].trim());

  return { productLinks: productLinks.slice(0, 8), titles, html: html.slice(0, 500) };
}

// Scrape a product page — get price by grade and SIM type from schema.org + page data
async function scrapeProductPage(productUrl) {
  const parsed = new URL(productUrl);
  const r = await httpsGet(parsed.hostname, parsed.pathname + parsed.search, {
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'de-DE,de;q=0.9',
  }, true);

  if (r.status !== 200) return null;
  const html = r.body;

  // Extract title
  const titleMatch = html.match(/<h1[^>]*>([^<]+)</h1>/);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Extract price from schema.org (most reliable)
  const schemaMatch = html.match(/<script[^>]+type="application/ld+json"[^>]*>([sS]*?)</script>/g);
  let schemaPrice = null;
  let currency = 'EUR';
  if (schemaMatch) {
    for (const s of schemaMatch) {
      try {
        const inner = s.replace(/<script[^>]*>/, '').replace(/</script>/, '');
        const data = JSON.parse(inner);
        if (data.offers && data.offers.price) {
          schemaPrice = parseFloat(data.offers.price);
          currency = data.offers.priceCurrency || 'EUR';
          break;
        }
      } catch(e) {}
    }
  }

  // Try to extract grade options and their prices from the page
  // BM embeds grades as data attributes or in JSON blobs
  const gradeData = [];
  
  // Look for the listing data JSON blob BM uses
  const listingDataMatch = html.match(/"listing":s*({[^}]+})/);
  
  // Extract SIM info from title
  const tl = title.toLowerCase();
  const simType = (tl.includes('esim') || tl.includes('e-sim')) ? 'esim'
    : tl.includes('physical') ? 'physical' : 'both';

  // Get the UUID from URL for BackBox lookup
  const uuidMatch = productUrl.match(//([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
  const productUuid = uuidMatch ? uuidMatch[1] : null;

  return {
    title: title || productUrl,
    schemaPrice,
    currency,
    simType,
    productUuid,
    url: productUrl
  };
}

// Find G&I's listing ID that matches a product UUID (for BackBox data)
async function findListingForProduct(productUuid) {
  // Search our own listings for one matching this product_id
  try {
    for (let page = 1; page <= 3; page++) {
      const r = await httpsGet(BM_HOST_EU,
        '/ws/listings?page=' + page + '&page_size=50',
        { 'Authorization': 'Basic ' + BM_KEY_EU, 'Accept': 'application/json', 'Accept-Language': 'fr-fr' }
      );
      if (r.status !== 200) break;
      const d = JSON.parse(r.body);
      const results = Array.isArray(d) ? d : (d.results || []);
      if (!results.length) break;
      
      // Find listing where product_id matches or title is similar
      for (const listing of results) {
        if (listing.product_id === productUuid) return listing.id;
      }
      if (!d.next) break;
    }
  } catch(e) {}
  return null;
}

// Get BackBox competitor data
async function getBackboxData(listingId) {
  if (!listingId) return [];
  const attempts = [
    { host:BM_HOST_EU, key:BM_KEY_EU, locale:'fr-fr' },
    { host:BM_HOST_UK, key:BM_KEY_UK, locale:'en-gb' },
  ];
  let all = [];
  for (const a of attempts) {
    try {
      const r = await httpsGet(a.host, '/ws/backbox/v1/competitors/'+listingId, {
        'Authorization':'Basic '+a.key, 'Accept':'application/json', 'Accept-Language':a.locale
      });
      if (r.status === 200) {
        const d = JSON.parse(r.body);
        if (Array.isArray(d)) all = all.concat(d);
      }
    } catch(e) {}
  }
  if (!all.length) return [];
  const byMarket = {};
  for (const c of all) {
    const flag = (c.market||'').toUpperCase().replace('UK','GB');
    if (!flag) continue;
    if (!byMarket[flag]) byMarket[flag] = {};
    if (c.winner_price?.amount != null) {
      const wp = parseFloat(c.winner_price.amount);
      if (!isNaN(wp) && wp > 0) { byMarket[flag].winnerPrice = wp; byMarket[flag].currency = c.winner_price.currency||'EUR'; }
    }
    if (c.price_to_win?.amount != null) {
      const ptw = parseFloat(c.price_to_win.amount);
      if (!isNaN(ptw) && ptw > 0) byMarket[flag].priceToWin = ptw;
    }
    if (!byMarket[flag].currency && c.price?.currency) byMarket[flag].currency = c.price.currency;
  }
  return Object.entries(byMarket).map(([flag,data]) => {
    const mkt = MARKETS[flag] || { name:flag, currency:'EUR' };
    return { flag, marketName:mkt.name, currency:data.currency||mkt.currency, winnerPrice:data.winnerPrice||null, priceToWin:data.priceToWin||null };
  }).filter(m => m.winnerPrice || m.priceToWin).sort((a,b)=>a.marketName.localeCompare(b.marketName));
}

async function handleSearch(query, simFilter, res) {
  try {
    // Step 1: Search BackMarket.de (keyword-optimised, returns exact models)
    const searchResults = await scrapeSearch(query, simFilter);
    
    if (!searchResults.productLinks.length) {
      return jsend(res, 200, { count:0, results:[], searchUrl: 'https://www.backmarket.de/de-de/search?q=' + encodeURIComponent(query) });
    }

    // Step 2: Scrape each product page for price + details (parallel, limit to 6)
    const pages = await Promise.all(
      searchResults.productLinks.slice(0, 6).map(link => scrapeProductPage(link).catch(() => null))
    );
    const validPages = pages.filter(Boolean);

    // Step 3: For each, try to find our listing ID and get BackBox data
    const enriched = await Promise.all(
      validPages.map(async prod => {
        // Use the DE price as the market selling price
        // The schemaPrice is what buyers on backmarket.de pay right now
        // Reduce by 5% to account for pricing headroom as requested
        const dePrice = prod.schemaPrice;
        const adjustedPrice = dePrice ? Math.round(dePrice * 0.95 * 100) / 100 : null;

        // Try to get BackBox data from our own API using product UUID
        const listingId = prod.productUuid ? await findListingForProduct(prod.productUuid) : null;
        const markets = listingId ? await getBackboxData(listingId) : [];

        // Filter by SIM type
        if (simFilter !== 'all') {
          const simType = prod.simType;
          if (simFilter === 'esim' && simType === 'physical') return null;
          if (simFilter === 'physical' && simType === 'esim') return null;
        }

        return {
          title: prod.title,
          simType: prod.simType,
          currency: prod.currency || 'EUR',
          // BM.de live price (what buyers currently pay)
          livePrice: dePrice,
          // Adjusted price (5% below BM.de = realistic selling price after competition)
          adjustedPrice,
          grade: 'EXCELLENT', // BM.de shows the best available grade by default
          stockLabel: 'in_stock', // if it's on BM.de public site, it's available
          quantity: null,
          markets,
          productUrl: prod.url,
          priceSource: 'backmarket_de_live'
        };
      })
    );

    const results = enriched.filter(Boolean);
    jsend(res, 200, { count: results.length, results, query });

  } catch(e) {
    jsend(res, 502, { error: e.message });
  }
}

async function exchangeRate(res) {
  try {
    const r = await httpsGet('api.exchangerate-api.com', '/v4/latest/USD', { Accept:'application/json' });
    const d = JSON.parse(r.body);
    jsend(res, 200, { rate:d.rates.EUR, rates:d.rates });
  } catch(e) { jsend(res, 502, { error:'Exchange rate unavailable' }); }
}

const MIME = { '.html':'text/html; charset=utf-8','.js':'application/javascript','.json':'application/json' };
function serveFile(reqPath, res) {
  const fp = path.join(__dirname, 'public', reqPath==='/' ? 'index.html' : reqPath);
  fs.readFile(fp, (err,content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)]||'text/plain' });
    res.end(content);
  });
}

http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const p = parsed.pathname;
  if (req.method==='OPTIONS') { res.writeHead(204,{'Access-Control-Allow-Origin':'*'}); return res.end(); }
  if (p==='/api/search') {
    const q=(parsed.query.q||'').trim(), sim=(parsed.query.sim||'all').trim();
    return q ? handleSearch(q,sim,res) : jsend(res,400,{error:'Missing ?q='});
  }
  if (p==='/api/rate') return exchangeRate(res);
  serveFile(p, res);
}).listen(PORT,'0.0.0.0',()=>console.log('CDK Calculator on port '+PORT));