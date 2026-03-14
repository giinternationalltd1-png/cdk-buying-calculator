const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const PORT = process.env.PORT || 3000;
const BM_KEY = 'MzkyZTM0ZjZlYjUxNmMyOTI3NjMwMjpCTVQtYTY4NjIyM2FiOTU4MjViMDhlZGZlODY1ODg0ZjIwZGMxNzU4Y2QzZg==';

function httpsGet(hostname,p,headers){return new Promise((resolve,reject)=>{const req=https.request({hostname,path:p,method:'GET',headers:{'User-Agent':'CDK/1.0',...headers}},r=>{let b='';r.on('data',c=>b+=c);r.on('end',()=>resolve({status:r.statusCode,body:b}));});req.on('error',reject);req.setTimeout(15000,()=>{req.destroy();reject(new Error('Timeout'));});req.end();});}

function jsend(res,status,obj){res.writeHead(status,{'Content-Type':'application/json','Access-Control-Allow-Origin':'*'});res.end(JSON.stringify(obj));}

function extractPrice(item){
  if(!item)return null;
  if(item.price!==undefined&&typeof item.price!=='object')return parseFloat(item.price);
  if(item.price&&item.price.amount!==undefined)return parseFloat(item.price.amount);
  if(item.listing&&item.listing.price&&item.listing.price.amount!==undefined)return parseFloat(item.listing.price.amount);
  if(item.unit_price!==undefined)return parseFloat(item.unit_price);
  if(item.listing_price!==undefined)return parseFloat(item.listing_price);
  return null;
}

function extractGrade(item){
  if(!item)return '';
  if(item.grade&&item.grade.name)return item.grade.name;
  if(item.listing&&item.listing.grade&&item.listing.grade.name)return item.listing.grade.name;
  if(item.condition)return item.condition;
  if(item.quality)return item.quality;
  return '';
}

// Detect SIM type from title
function extractSim(title){
  const t=(title||'').toLowerCase();
  if(t.includes('esim')||t.includes('e-sim'))return 'esim';
  if(t.includes('physical sim')||t.includes('physical'))return 'physical';
  return 'unknown';
}

function gradeOrder(g){
  const n=(g||'').toLowerCase();
  if(n.includes('parfait')||n.includes('excellent')||n.includes('like new')||n.includes('neuf'))return 1;
  if(n.includes('tres bon')||n.includes('very good')||n.includes('good')||n.includes('bon'))return 2;
  if(n.includes('correct')||n.includes('fair')||n.includes('satisf'))return 3;
  return 4;
}

// Score how well a title matches the search query (higher = better match)
function matchScore(title, queryTerms){
  const t = title.toLowerCase();
  let score = 0;
  let matched = 0;
  for(const term of queryTerms){
    if(t.includes(term)){
      score += term.length; // longer term matches worth more
      matched++;
    }
  }
  // Require at least 60% of terms to match
  if(matched < Math.ceil(queryTerms.length * 0.6)) return 0;
  return score;
}

async function searchListings(query, simFilter, res){
  // Fetch all listings (no query filter - API ignores it for seller listings)
  // Use page_size=100 to get as many as possible
  const bmPath='/ws/listings?page_size=100';
  try{
    const r=await httpsGet('www.backmarket.fr',bmPath,{
      'Authorization':'Basic '+BM_KEY,
      'Accept':'application/json',
      'Accept-Language':'en-gb'
    });
    let parsed;
    try{parsed=JSON.parse(r.body);}catch(e){return jsend(res,502,{error:'Invalid JSON from BackMarket. Status:'+r.status});}
    if(r.status!==200){
      const msg=(parsed.error&&(parsed.error.message||parsed.error.code))||('Status '+r.status);
      return jsend(res,r.status,{error:msg});
    }
    let raw=[];
    if(Array.isArray(parsed))raw=parsed;
    else if(Array.isArray(parsed.results))raw=parsed.results;
    else if(Array.isArray(parsed.listings))raw=parsed.listings;

    // Tokenise the query for matching
    const queryTerms = query.toLowerCase()
      .replace(/[^a-z0-9\s]/g,' ')
      .split(/\s+/)
      .filter(t=>t.length>1);

    const items = raw
      .map(item=>{
        const price=extractPrice(item);
        const grade=extractGrade(item);
        const title=item.title||item.name||item.product_title||item.displayTitle||item.label||'Listing';
        const simType=extractSim(title);
        const currency=(item.price&&item.price.currency)||(item.listing&&item.listing.price&&item.listing.price.currency)||'EUR';
        const score=matchScore(title, queryTerms);
        return{title,price,grade,currency,simType,score};
      })
      .filter(i=>{
        if(i.price===null||isNaN(i.price)||i.price<=0)return false;
        if(i.score===0)return false; // doesn't match query
        if(simFilter&&simFilter!=='all'){
          if(simFilter==='esim'&&i.simType!=='esim')return false;
          if(simFilter==='physical'&&i.simType!=='physical')return false;
        }
        return true;
      })
      .sort((a,b)=>b.score-a.score||gradeOrder(a.grade)-gradeOrder(b.grade)||a.price-b.price);

    jsend(res,200,{count:items.length,results:items,query,simFilter});
  }catch(e){
    jsend(res,502,{error:'Cannot reach BackMarket: '+e.message});
  }
}

async function exchangeRate(res){
  try{
    const r=await httpsGet('api.exchangerate-api.com','/v4/latest/USD',{Accept:'application/json'});
    const d=JSON.parse(r.body);
    jsend(res,200,{rate:d.rates.EUR,base:'USD',target:'EUR'});
  }catch(e){jsend(res,502,{error:'Exchange rate unavailable'});}
}

const MIME={'.html':'text/html; charset=utf-8','.css':'text/css','.js':'application/javascript','.json':'application/json'};
function serveFile(reqPath,res){
  const fp=path.join(__dirname,'public',reqPath==='/'?'index.html':reqPath);
  fs.readFile(fp,(err,content)=>{
    if(err){res.writeHead(404);return res.end('Not found');}
    res.writeHead(200,{'Content-Type':MIME[path.extname(fp)]||'text/plain'});
    res.end(content);
  });
}

http.createServer((req,res)=>{
  const parsed=url.parse(req.url,true);
  const p=parsed.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*'});return res.end();}
  if(p==='/api/search'){
    const q=(parsed.query.q||'').trim();
    const sim=(parsed.query.sim||'all').trim();
    return q?searchListings(q,sim,res):jsend(res,400,{error:'Missing ?q='});
  }
  if(p==='/api/rate')return exchangeRate(res);
  serveFile(p,res);
}).listen(PORT,'0.0.0.0',()=>console.log('CDK Calculator on port '+PORT));