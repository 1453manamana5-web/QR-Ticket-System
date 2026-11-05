import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
function worker(app,mode){
 const base='https://koken-web.github.io/qr-system/'+(app==='management-app'?'control/':'');
 const listeners={},timers=new Map(),background=[];let seq=0,response;
 const cache={match:async()=>new Response('cached '+app),put:async()=>{}};
 const fetch=async(url,options)=>{
  if((typeof url==='string'?url:url.url??String(url))===base){
   if(mode==='stall')return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(Error('timeout'))));
   if(mode==='error')return new Response('unavailable',{status:503});
   return new Response('<html>current</html>');
  }
  return new Promise(()=>{}); // A slow asset must not hold up a successful navigation.
 };
 new Function('self','URL','caches','fetch','Response','AbortController','setTimeout','clearTimeout',readFileSync(app+'/public/sw.js','utf8'))({location:{href:base+'sw.js',origin:new URL(base).origin},addEventListener:(n,fn)=>listeners[n]=fn},URL,{open:async()=>cache},fetch,Response,AbortController,fn=>{timers.set(++seq,fn);return seq;},id=>timers.delete(id));
 listeners.fetch({request:{url:base,method:'GET',mode:'navigate'},respondWith:p=>response=p,waitUntil:p=>background.push(p)});
 return {timers,background,response};
}
for(const app of ['reception-app','management-app']){
 test(app+' at legacy URL falls back on a stalled or failed network',async()=>{
  for(const mode of ['stall','error']){
   const w=worker(app,mode);
   if(mode==='stall'){await Promise.resolve();await Promise.resolve();assert.equal(w.timers.size,1);for(const fn of w.timers.values())fn();}
   assert.equal(await (await w.response).text(),'cached '+app);assert.equal(w.timers.size,0);
  }
 });
 test(app+' serves successful navigation before slow asset caching completes',async()=>{
  const w=worker(app,'success');
  const response=await Promise.race([w.response,new Promise((_resolve,reject)=>setTimeout(()=>reject(Error('navigation waited for assets')),300))]);
  assert.equal(await response.text(),'<html>current</html>');assert.equal(w.background.length,1);assert.equal(w.timers.size,0);
 });
}
