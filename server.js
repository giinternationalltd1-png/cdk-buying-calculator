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
// Anthropic API for AI matching
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

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

function httpsGet(hostname, p, hdrs) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path: p, method: 'GET',
      headers: { 'User-Agent': 'BM-GandI-CDKCalculator;tech@gi-international.com', ...hdrs }
    }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>resolve({status:r.statusCode,body:b})); });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function httpsPost(hostname, p, hdrs, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname, path: p, method: 'POST',
      headers: { 'Content-Type':'application/json', 'Content-Length': Buffer.byteLength(data), ...hdrs }
    }, r => { let b=''; r.on('data',c=>b+=c); r.on('end',()=>resolve({status:r.statusCode,body:b})); });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(data);
    req.end();
  });
}

function jsend(res, status, obj) {
  res.writeHead(status, { 'Content-Type':'application/json','Access-Control-Allow-Origin':'*' });
  res.end(JSON.stringify(obj));
}

// Fetch ALL listings from BM — paginate through everything
async function fetchAllListings() {
  let all = [];
  for (let page = 1; page <= 60; page++) {
    try {
      const r = await httpsGet(BM_HOST_EU,
        '/ws/listings?page=' + page + '&page_size=50',
        { 'Authorization':'Basic '+BM_KEY_EU, 'Accept':'application/json', 'Accept-Language':'fr-fr' }
      );
      if (r.status !== 200) break;
      const d = JSON.parse(r.body);
      const results = Array.isArray(d) ? d : (d.results || []);
      if (!results.length) break;
      all = all.concat(results);
      if (!d.next) break;
    } catch(e) { break; }
  }
  return all;
}

// Use Claude AI to find the best matching listings for a query
async function aiMatch(query, listings) {
  if (!ANTHROPIC_KEY) return fallbackMatch(query, listings);

  // Build a compact list for Claude to reason over
  const listForClaude = listings.map((l, i) => ({
    idx: i,
    title: l.title,
    grade: l.grade,
    qty: l.quantity,
    pub: l.publication_state
  }));

  const prompt = `You are helping match a search query to the correct product listings.

Query: "${query}"

Here are the available listings (JSON array):
${JSON.stringify(listForClaude, null, 1)}

Return ONLY a JSON array of the indices (idx values) of listings that EXACTLY match the query.
Rules:
- Model must match exactly (iPhone 16 ≠ iPhone 16 Pro, iPhone 16 Pro ≠ iPhone 16 Pro Max)
- Storage must match exactly (128GB ≠ 256GB)
- If query has no storage, return all storage variants of that model
- Return max 10 best matches
- Return ONLY the JSON array of integers, nothing else. Example: [0,3,7]`;

  try {
    const r = await httpsPost('api.anthropic.com', '/v1/messages', {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'Accept': 'application/json'
    }, {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role:'user', content: prompt }]
    });

    const resp = JSON.parse(r.body);
    const text = resp.content?.[0]?.text || '[]';
    const indices = JSON.parse(text.match(/\[.*\]/s)?.[0] || '[]');
    return indices.map(i => listings[i]).filter(Boolean);
  } catch(e) {
    return fallbackMatch(query, listings);
  }
}

// Fallback: strict rule-based matching (used if no Anthropic key)
function fallbackMatch(query, listings) {
  const q = query.toLowerCase()
    .replace(/\bgo\b/g,'gb').replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ').trim();
  const qTerms = q.split(' ').filter(t => t.length > 0);
  const storage = (q.match(/(\d+)gb/) || [])[1];
  const extras = ['pro','max','plus','ultra','mini','fe','lite'];
  const qExtras = extras.filter(e => qTerms.includes(e));

  return listings.filter(item => {
    const t = (item.title||'').toLowerCase().replace(/\bgo\b/g,'gb')
      .replace(/[^a-z0-9\s]/g,' ').replace(/\s+/g,' ');
    const tTerms = t.split(' ').filter(x => x.length > 0);
    const tStorage = (t.match(/(\d+)gb/) || [])[1];
    if (storage && tStorage !== storage) return false;
    const tExtras = extras.filter(e => tTerms.includes(e));
    const unexpectedExtras = tExtras.filter(e => !qExtras.includes(e));
    if (unexpectedExtras.length > 0) return false;
    const nonStorageTerms = qTerms.filter(t => t !== storage && t !== storage+'gb');
    return nonStorageTerms.every(term => t.includes(term));
  }).slice(0, 10);
}

async function getBackboxData(listingId) {
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
    const allListings = await fetchAllListings();
    
    // SIM filter first
    const simFiltered = allListings.filter(item => {
      if (simFilter === 'all') return true;
      const tl = (item.title||'').toLowerCase();
      const isEsim = tl.includes('esim') || tl.includes('e-sim');
      const isPhysical = tl.includes('physical');
      if (simFilter === 'esim') return isEsim;
      if (simFilter === 'physical') return isPhysical || (!isEsim);
      return true;
    });

    // AI match
    const matched = await aiMatch(query, simFiltered);

    if (!matched.length) return jsend(res, 200, { count:0, results:[], total: allListings.length });

    // Enrich with BackBox data
    const enriched = await Promise.all(matched.map(async item => {
      const tl = (item.title||'').toLowerCase();
      const simType = (tl.includes('esim')||tl.includes('e-sim')) ? 'esim'
        : tl.includes('physical') ? 'physical' : 'both';
      const qty = typeof item.quantity === 'number' ? item.quantity : null;
      const stockLabel = qty === 0 ? 'out_of_stock' : item.publication_state !== 2 ? 'offline' : 'in_stock';
      const markets = item.id ? await getBackboxData(item.id) : [];
      return {
        id: item.id, title: item.title||'', grade: item.grade||'',
        simType, currency: item.currency||'EUR',
        listedPrice: parseFloat(item.price)||0,
        quantity: qty, stockLabel, markets
      };
    }));

    jsend(res, 200, { count:enriched.length, results:enriched, total:allListings.length, aiUsed: !!ANTHROPIC_KEY });
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