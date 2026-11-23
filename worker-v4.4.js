
/** Worth It? V4.4 — search relevance and source-aware ranking.
 * Secret: SERPAPI_KEY (Cloudflare only). GET /search?q=...&budget=...
 * Shopping ratings/prices are search-index reports, not independently verified.
 */
const ORIGIN = 'https://margasananda.github.io';
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: {'Content-Type':'application/json; charset=utf-8',
    'Access-Control-Allow-Origin':ORIGIN,'Vary':'Origin',
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}
});
const safeLink = value => {
  try {const u = new URL(value); return ['http:','https:'].includes(u.protocol) ? u.href : null;}
  catch {return null;}
};
const positiveNumber = (value,min,max) => {
  if(value===null || value===undefined || value==='') return null;
  const n=Number(String(value).replace(/,/g,''));
  return Number.isFinite(n)&&n>=min&&n<=max?n:null;
};
const priceNum = value => {
  if(typeof value==='number') return positiveNumber(value,0,100000000);
  if(typeof value!=='string') return null;
  const m=value.replace(/,/g,'').match(/(?:NT\$|TWD|\$)\s*(\d+(?:\.\d+)?)/i)
    || value.replace(/,/g,'').match(/^\s*(\d+(?:\.\d+)?)(?:\s*元)?\s*$/);
  return m?positiveNumber(m[1],0,100000000):null;
};
function cleanTitle(value) {
  return String(value||'')
    .replace(/^(?:\s*[【\[]?\s*(?:\d{1,2}[\/.-]\d{1,2}\s*前)?(?:最高送\s*\d+|限時優惠|現折\s*\d+|特價|免運|官方旗艦店|蝦皮購物|熱銷)[^】\]]*[】\]]?\s*)+/iu,'')
    .replace(/^(?:\s*[【\[][^】\]]*(?:優惠|現折|贈|折價|免運|旗艦店)[^】\]]*[】\]]\s*)+/iu,'')
    .replace(/\s+/g,' ').trim().slice(0,130);
}
function tokens(s) {
  const t=String(s||'').toLowerCase().replace(/台灣|推薦|好評|排行|前\s*6\s*名/g,' ').trim();
  return [...new Set((t.match(/[a-z0-9]+|[\p{Script=Han}]{2,}/gu)||[]).flatMap(x=>{
    if(/^[\p{Script=Han}]+$/u.test(x)&&x.length>2)
      return [x,...Array.from({length:x.length-1},(_,i)=>x.slice(i,i+2))];
    return [x];
  }).filter(x=>x.length>=2))];
}
function relevance(query,title) {
  const q=String(query).toLowerCase().trim();
  const t=String(title).toLowerCase();
  if(!q||!t) return 0;
  let score=t.includes(q)?100:0;
  const words=tokens(query);
  if(!words.length) return score;
  const matched=words.filter(w=>t.includes(w)).length;
  score+=55*matched/words.length;
  if(/腳底按摩|足底按摩|足部按摩|按摩腳|腳底按摩器/.test(q)) {
    if(/腳底|足底|足部|腳底按摩|足按摩|足療|腳部按摩|按摩機|按摩器|滾輪|指壓/.test(t)) score+=35;
    if(/氣壓|腿部|小腿/.test(t)&&!/腳底|足底|腳掌|足部/.test(t)) score-=35;
    if(/按摩椅|按摩槍|按摩枕|按摩油|按摩襪|替換|配件|保護套|維修/.test(t)) score-=100;
  }
  if(/iphone|手機|智慧型手機/.test(q)) {
    if(/手機殼|保護殼|保護貼|鏡頭貼|充電線|手機支架|二手零件|維修/.test(t)) score-=110;
  }
  return score;
}
async function serp(params,key) {
  const u=new URL('https://serpapi.com/search.json');
  Object.entries(params).forEach(([k,v])=>u.searchParams.set(k,String(v)));
  u.searchParams.set('api_key',key);
  const r=await fetch(u,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(14000)});
  if(!r.ok)throw new Error('搜尋服務暫時無法使用（'+r.status+'）');
  const data=await r.json();
  if(data.error)throw new Error(String(data.error).slice(0,160));
  return data;
}
export default {
  async fetch(request,env,ctx) {
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{
      'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET, OPTIONS',
      'Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin'}});
    const u=new URL(request.url);
    if(u.pathname==='/health')return json({ok:true,configured:Boolean(env.SERPAPI_KEY)});
    if(request.method!=='GET'||u.pathname!=='/search')return json({error:'找不到此功能'},404);
    const origin=request.headers.get('Origin');
    if(origin&&origin!==ORIGIN)return json({error:'不允許的網站來源'},403);
    if(!env.SERPAPI_KEY)return json({error:'Cloudflare 尚未設定 SERPAPI_KEY'},503);
    const q=(u.searchParams.get('q')||'').trim();
    const budget=positiveNumber(u.searchParams.get('budget'),1,10000000);
    if(q.length<2||q.length>70||budget===null)return json({error:'商品名稱需 2–70 字，預算需為正數。'},400);
    const cache=caches.default;
    const key=new Request('https://cache.worthit.invalid/v44?q='+encodeURIComponent(q.toLowerCase())+'&budget='+budget);
    const cached=await cache.match(key);
    if(cached)return new Response(cached.body,{status:200,headers:{...Object.fromEntries(cached.headers),'X-WorthIt-Cache':'HIT'}});
    try {
      const [shopping,organic]=await Promise.all([
        serp({engine:'google_shopping',q:q+' 台灣',gl:'tw',hl:'zh-tw'},env.SERPAPI_KEY),
        serp({engine:'google',q:q+' 開箱 心得 缺點 評價 PTT Mobile01',gl:'tw',hl:'zh-tw',num:8},env.SERPAPI_KEY)
      ]);
      const groups=new Map();
      for(const p of (shopping.shopping_results||[]).slice(0,100)) {
        const raw=String(p.title||'');
        const title=cleanTitle(raw);
        const rel=relevance(q,title);
        const price=priceNum(p.extracted_price??p.price);
        const link=safeLink(p.product_link||p.link||'');
        const currency=String(p.price||'');
        if(!title||!link||price===null||price<=0||price>budget||rel<25||/(US\$|USD|HK\$|HKD|CNY|RMB|JPY|¥|€|EUR)/i.test(currency))continue;
        const id=String(p.product_id||'').trim();
        const normalized=title.toLowerCase().replace(/[\s\p{P}]+/gu,' ').trim();
        const groupKey=id?'id:'+id:'title:'+normalized;
        const entry=groups.get(groupKey)||{title,offers:[],rating:null,reviewCount:null,productId:id||null,relevanceScore:rel};
        entry.relevanceScore=Math.max(entry.relevanceScore,rel);
        const rating=positiveNumber(p.rating,0,5);
        const count=positiveNumber(p.reviews,0,100000000);
        const merchant=String(p.source||'未標示商家').slice(0,90);
        const oldPrice=priceNum(p.extracted_old_price??p.old_price??p.original_price);
        const extension=(Array.isArray(p.extensions)?p.extensions:[]).map(String);
        const promoLabel=[...extension,String(p.discount||p.discount_percentage||'')].find(s=>/(\d+\s*%\s*off|折|特價|限時優惠|優惠價)/i.test(s))||null;
        entry.offers.push({price,merchant,link,promotion:(oldPrice>price||promoLabel)?{
          price,originalPrice:oldPrice>price?oldPrice:null,label:promoLabel,link,merchant}:null});
        if(rating!==null&&count!==null&&(entry.reviewCount===null||count>entry.reviewCount)) {
          entry.rating=rating;entry.reviewCount=count;
        }
        groups.set(groupKey,entry);
      }
      const products=[...groups.values()].map(p=>{
        p.offers.sort((a,b)=>a.price-b.price);
        p.price=p.offers[0].price;
        p.merchant=p.offers[0].merchant;
        p.link=p.offers[0].link;
        p.offerCount=p.offers.length;
        const promos=p.offers.filter(o=>o.promotion);
        p.promotion=promos.length?promos[0].promotion:null;
        const n=p.reviewCount??0;
        p.feedbackScore=p.rating!==null&&n>=5?Math.round(100*((p.rating*n+3.8*20)/(n+20))/5):null;
        p.evidence=n>=50?'中：平台彙總評價（未獨立驗證）':n>=5?'低：評論量較少（未獨立驗證）':'不足：缺乏可用評論數';
        return p;
      }).sort((a,b)=>b.relevanceScore-a.relevanceScore||(b.feedbackScore??-1)-(a.feedbackScore??-1)||(b.reviewCount??0)-(a.reviewCount??0)||a.price-b.price).slice(0,6);
      const reviews=(organic.organic_results||[]).map(p=>({
        title:String(p.title||'').slice(0,160),url:safeLink(p.link),
        snippet:String(p.snippet||'').slice(0,350),
        source:String(p.source||p.displayed_link||'').slice(0,90),date:p.date||null
      })).filter(p=>p.title&&p.url).slice(0,8);
      const result={query:q,budget,checkedAt:new Date().toISOString(),products,reviewSources:reviews,
        limitations:['評分與評論數取自搜尋索引，並非 Worth It? 獨立查驗；不同商家可能統計口徑不同。',
        '價格僅為此次搜尋取得的參考報價，可能不含運費、優惠券與結帳折扣。',
        '排名優先考慮商品名稱相關性，再參考平台星等與評論量；這不是品質保證。',
        '同型號但標題不同可能被當成不同商品；請核對型號、規格與賣場。',
        '找不到足夠相關商品時少於六項，不會補造結果；不提供銷量數字。']};
      ctx.waitUntil(cache.put(key,new Response(JSON.stringify(result),{headers:{
        'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':ORIGIN,
        'Cache-Control':'public, max-age=3600','Vary':'Origin'}})));
      return json(result,200,{'Cache-Control':'public, max-age=60'});
    } catch(e) {return json({error:'搜尋失敗：'+String(e.message||e).slice(0,240)},502);}
  }
};
