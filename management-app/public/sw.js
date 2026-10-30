const CACHE='qr-ticket-management-shell-v1';
const BASE=new URL('./',self.location.href).pathname;
const INDEX=new URL('index.html',self.location.href).href;
async function saveShell(cache,response){
  if(!response.ok)throw Error('管理画面を取得できませんでした');
  const html=await response.clone().text();
  await Promise.all([...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(async match=>{
    const url=new URL(match[1],INDEX);if(url.origin!==self.location.origin||!url.pathname.startsWith(BASE))return;
    const asset=await fetch(url.href,{cache:'reload'});if(!asset.ok)throw Error('印刷画面のファイルを取得できませんでした');await cache.put(url.href,asset);
  }));
  await cache.put(INDEX,response.clone());
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(CACHE);await saveShell(cache,await fetch(INDEX,{cache:'reload'}));await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith('qr-ticket-management-shell-')&&name!==CACHE)await caches.delete(name);await self.clients.claim();})()));
self.addEventListener('fetch',event=>{
  const req=event.request,url=new URL(req.url);
  if(req.method!=='GET'||url.origin!==self.location.origin||!url.pathname.startsWith(BASE))return;
  if(req.mode==='navigate'){
    if(url.pathname!==BASE&&url.pathname!==BASE+'index.html')return;
    event.respondWith((async()=>{const cache=await caches.open(CACHE);try{const response=await fetch(req);await saveShell(cache,response);return response;}catch{return await cache.match(INDEX)||new Response('オンラインで一度、予備印刷画面を開いて準備してください。',{status:503,headers:{'Content-Type':'text/plain;charset=utf-8'}});}})());return;
  }
  event.respondWith((async()=>{const cache=await caches.open(CACHE),saved=await cache.match(req);if(saved)return saved;try{const response=await fetch(req);if(response.ok)await cache.put(req,response.clone());return response;}catch{return new Response('',{status:503});}})());
});
