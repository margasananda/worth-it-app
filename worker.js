/**
 * Worth It? V2 API — Cloudflare Worker.
 * Set the SERPAPI_KEY secret in Cloudflare dashboard, NEVER in GitHub.
 * Endpoint: GET /search?q=...&budget=...
 * All third-party data is unverified search-index material, not original reviews.
 */
const ORIGIN = 'https://margasananda.github.io';
const ALLOWED_PATH = '/search';
const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status, headers: {'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin': ORIGIN,
    'Vary':'Origin','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...extra}
});
function safeLink(value) {
  try { const u = new URL(value); return ['https:','http:'].includes(u.protocol) ? u.href : null; } catch {return null;}
}
function priceNum(p) {
  if (Number.isFinite(p)) return Number(p);
  if (typeof p !== 'string') return null;
  const s=p.replace(/,/g,''); const m=s.match(/(?:NT\$|TWD|\$)\s*(\d+(?:\.\d+)?)/i) || s.match(/(\d+(?:\.\d+)?)/);
  return m? Number(m[1]):null;
}
function positiveNumber(n, min, max) {const x=Number(n);return Number.isFinite(x)&&x>=min&&x<=max?x:null;}
async function serp(params, key) {
  const u=new URL('https://serpapi.com/search.json');
  for (const [k,v] of Object.entries(params))u.searchParams.set(k,String(v));
  u.searchParams.set('api_key',key);
  const response=await fetch(u,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(14000)});
  if(!response.ok)throw new Error('搜尋供應商暫時無法使用（'+response.status+'）');
  const data=await response.json();
  if(data.error)throw new Error('搜尋供應商回報：'+String(data.error).slice(0,160));
  return data;
}
export default {
  async fetch(request,env,ctx) {
    const origin=request.headers.get('Origin');
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:{'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'GET, OPTIONS','Access-Control-Allow-Headers':'Content-Type','Access-Control-Max-Age':'86400','Vary':'Origin'}});
    const u=new URL(request.url);
    if(u.pathname==='/health')return json({ok:true,configured:Boolean(env.SERPAPI_KEY)});
    if(request.method!=='GET'||u.pathname!==ALLOWED_PATH)return json({error:'找不到此功能'},404);
    if(origin&&origin!==ORIGIN)return json({error:'不允許的網站來源'},403);
    if(!env.SERPAPI_KEY)return json({error:'尚未設定 SERPAPI_KEY，請先在 Cloudflare Workers 設定 Secret。'},503);
    const q=(u.searchParams.get('q')||'').trim();
    const budget=positiveNumber(u.searchParams.get('budget'),1,10000000);
    if(q.length<2||q.length>70||budget===null)return json({error:'商品名稱需 2–70 字，預算需為正數。'},400);
    // Cache normalized searches for one hour to control provider usage.
    const cache= caches.default;
    const cacheRequest=new Request('https://cache.worthit.invalid/search?q='+encodeURIComponent(q.toLowerCase())+'&budget='+budget);
    const cached=await cache.match(cacheRequest);
    if(cached)return new Response(cached.body,{status:cached.status,headers:{...Object.fromEntries(cached.headers), 'X-WorthIt-Cache':'HIT'}});
    try {
      // One shopping query + one organic query per uncached search (2 SerpApi credits usually).
      const [shopping,organic]=await Promise.all([
        serp({engine:'google_shopping',q:q+' 台灣',gl:'tw',hl:'zh-tw'},env.SERPAPI_KEY),
        serp({engine:'google',q:q+' 開箱 心得 缺點 評價 PTT Mobile01',gl:'tw',hl:'zh-tw',num:8},env.SERPAPI_KEY)
      ]);
      // Keep separate shopping offers, group only when Google supplies the same product_id.
      // Without a stable product identifier, group only identical normalized titles.
      const groups=new Map();
      for (const p of (shopping.shopping_results||[]).slice(0,100)) {
        const title=String(p.title||'').trim().slice(0,150);
        const price=priceNum(p.extracted_price??p.price);
        const link=safeLink(p.product_link||p.link||'');
        const currencyText=String(p.price||'');
        if(!title || !link || price===null || price<=0 || price>budget || /(US\$|USD|HK\$|HKD|CNY|RMB|JPY|¥|€|EUR)/i.test(currencyText))continue;
        const rating=positiveNumber(p.rating,0,5);
        const reviewCount=positiveNumber(p.reviews,0,100000000);
        const merchant=String(p.source||'未標示商家').slice(0,90);
        // The provider often omits sales-volume. Do not substitute reviewCount for sales.
        const volume = [ ...(Array.isArray(p.extensions)?p.extensions:[]), String(p.sales_volume||'')]
          .map(x=>String(x)).find(x=>/\b(?:bought|sold)\b|已售|銷量|售出/i.test(x))||null;
        const productId=String(p.product_id||'').trim();
        const normalized=title.toLowerCase().replace(/[\s\p{P}]+/gu,' ').trim();
        const key=productId?'id:'+productId:'title:'+normalized;
        const entry=groups.get(key)||{title,offers:[],rating:null,reviewCount:null,salesEvidence:[],productId:productId||null};
        const originalPrice=priceNum(p.extracted_old_price??p.old_price??p.original_price??null);
        const discountLabel=[...(Array.isArray(p.extensions)?p.extensions:[]),p.discount||p.discount_percentage||'']
          .map(x=>String(x).trim()).find(x=>/(?:\d+\s*%\s*off|折|特價|限時優惠|優惠價|省\s*(?:NT\$|\$)?\s*\d+)/i.test(x))||null;
        const isPromotion=(originalPrice!==null&&originalPrice>price) || Boolean(discountLabel);
        entry.offers.push({price,merchant,link,promotion:isPromotion?{price,originalPrice:originalPrice>price?originalPrice:null,label:discountLabel,link,merchant}:null});
        if (rating!==null && reviewCount!==null && (entry.reviewCount===null || reviewCount>entry.reviewCount)) {
          entry.rating=rating; entry.reviewCount=reviewCount;
        }
        if(volume&&!entry.salesEvidence.includes(volume))entry.salesEvidence.push(volume.slice(0,100));
        groups.set(key,entry);
      }
      const products=[...groups.values()].map(p=>{
        p.offers.sort((a,b)=>a.price-b.price);
        p.price=p.offers[0].price;
        p.merchant=p.offers[0].merchant;
        p.link=p.offers[0].link;
        p.offerCount=p.offers.length;
        // Promo offers are independent of cheapest ordinary offer; never claim they are the all-in lowest deal.
        const promotional=p.offers.filter(o=>o.promotion).sort((a,b)=>a.price-b.price);
        p.promotion=promotional.length?promotional[0].promotion:null;
        p.salesVolume=p.salesEvidence.length?p.salesEvidence.join('； '):null;
        // Public aggregated stars are an imperfect proxy for consumer feedback.
        // Bayesian shrinkage reduces 5-star, one-review listings winning.
        const n=p.reviewCount??0;
        p.feedbackScore=p.rating!==null&&n>=5?Math.round(100*((p.rating*n+3.8*20)/(n+20))/5):null;
        p.evidence=n>=50?'中：平台彙總評價':n>=5?'低：評論量較少':'不足：未達 5 則評論';
        return p;
      }).sort((a,b)=>(b.feedbackScore??-1)-(a.feedbackScore??-1)||b.reviewCount-a.reviewCount||a.price-b.price).slice(0,6);
      // Rankings may include products with insufficient feedback only as visibly unranked candidates.
      const reviews=(organic.organic_results||[]).map(p=>({title:String(p.title||'').slice(0,160),url:safeLink(p.link),snippet:String(p.snippet||'').slice(0,350),source:String(p.source||p.displayed_link||'').slice(0,90),date:p.date||null})).filter(p=>p.title&&p.url).slice(0,8);
      const result={query:q,budget,checkedAt:new Date().toISOString(),products,reviewSources:reviews,
        limitations:['第 1–6 名依可取得的彙總星等和評論數量排序；尚未驗證每一則評論的真實性。','最低價僅指此次 Google Shopping 搜尋結果中，同一產品 ID 或完全相同標題的可比商品報價，未涵蓋全網、運費或優惠券。','沒有公開銷量時顯示「未公開」；若有銷量文字，屬賣場或搜尋來源宣稱，未經獨立查核。','同型號但標題不同可能被視為不同商品；購買前須核對規格及庫存。','如不足六個符合預算商品或評論資料不足，只顯示可查到的項目，不補造排名。','促銷資訊僅依搜尋提供的原價與折扣標示，可能過期或不含券、運費及會員門檻，請以商家結帳價為準。']};
      const response=json(result,200,{'Cache-Control':'public, max-age=60'});
      ctx.waitUntil(cache.put(cacheRequest,new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':ORIGIN,'Cache-Control':'public, max-age=3600','Vary':'Origin'}})));
      return response;
    }catch(e){return json({error:'搜尋失敗：'+String(e.message||e).slice(0,240)},502);}
  }
};
