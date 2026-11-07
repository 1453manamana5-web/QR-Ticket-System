import assert from 'node:assert/strict';
import {before, after, test} from 'node:test';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve, extname, sep} from 'node:path';
import {build} from 'esbuild';
import {chromium} from 'playwright';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {QRCodeSVG} from 'qrcode.react';

// All attack targets are loopback files or intercepted .invalid probe URLs.
// No Firebase configuration, credential, production page or real record is used.
let browser, origin, attackerOrigin, servers=[];
const scripts={};
const apps={management:'/QR-Ticket-System/management-app/',reception:'/QR-Ticket-System/'};
const roots={management:resolve('management-app/dist'),reception:resolve('reception-app/dist')};
const expectedQr='isolated-security-qr';
const qr=renderToStaticMarkup(React.createElement(QRCodeSVG,{xmlns:'http://www.w3.org/2000/svg',value:expectedQr,size:400,marginSize:4}));
let meta='';
async function serve(){
  const server=createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,'http://127.0.0.1');
      if(url.pathname==='/frame'){
        const target=new URL(apps[url.searchParams.get('app')]??apps.management,origin);
        if(url.searchParams.get('reserve')==='1')target.search='?reserve-print=isolated-event';
        res.setHeader('Content-Type','text/html');res.end(`<iframe title="target" src="${target.href}" ${url.searchParams.get('sandbox')==='1'?'sandbox="allow-scripts allow-same-origin"':''}></iframe>`);return;
      }
      if(url.pathname==='/fixture'){
        res.setHeader('Content-Type','text/html');res.end(`<!doctype html><html><head><meta charset="utf-8">${meta}</head><body><div id="reader" style="width:400px"></div><script type="module" src="/security-fixture.js"></script></body></html>`);return;
      }
      if(url.pathname==='/self-probe.js'){
        res.setHeader('Content-Type','text/javascript');res.end("window.selfProbe=true;try{(0,eval)('window.evalProbe=true')}catch{window.evalBlocked=true}");return;
      }
      if(url.pathname in scripts){res.setHeader('Content-Type','text/javascript');res.end(scripts[url.pathname]);return;}
      const app=url.pathname.startsWith(apps.management)?'management':'reception';
      const root=roots[app],suffix=decodeURIComponent(url.pathname.slice(apps[app].length))||'index.html';
      const path=resolve(root,suffix);
      if(!path.startsWith(root+sep)){res.writeHead(404).end();return;}
      const body=await readFile(path);
      res.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.json':'application/json','.png':'image/png','.svg':'image/svg+xml'})[extname(path)]??'application/octet-stream');
      res.end(body);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);return 'http://127.0.0.1:'+server.address().port;
}
before(async()=>{
  const html=await readFile(resolve(roots.management,'index.html'),'utf8');
  meta=html.match(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i)?.[0]??'';
  const fixture=await build({stdin:{contents:`import {openReservePrint} from './management-app/src/ReservePrinting.tsx';import {Html5Qrcode,Html5QrcodeSupportedFormats} from 'html5-qrcode';import {ensureFirebaseAuth} from './management-app/src/firebaseClient.ts';
    window.authProbe=async()=>{const auth=await ensureFirebaseAuth();return auth.currentUser.uid;};
    window.printProbe=packet=>{const popup=window.open('','_blank');const target=new Proxy(popup,{get:(win,key)=>key==='print'?()=>{win.printCalls=(win.printCalls||0)+1;}:key==='focus'?()=>{}:typeof win[key]==='function'?win[key].bind(win):win[key],set:(win,key,value)=>{win[key]=value;return true;}});openReservePrint(packet,target);};
    window.scanProbe=async(svg)=>{const img=new Image();img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);await img.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=400;canvas.getContext('2d').drawImage(img,0,0);const blob=await new Promise(resolve=>canvas.toBlob(resolve));const scanner=new Html5Qrcode('reader',{formatsToSupport:[Html5QrcodeSupportedFormats.QR_CODE],useBarCodeDetectorIfSupported:false});try{return await scanner.scanFile(new File([blob],'probe.png',{type:'image/png'}),false);}finally{scanner.clear();}};`,resolveDir:process.cwd(),loader:'js'},bundle:true,write:false,format:'esm',platform:'browser',define:{'import.meta.env':JSON.stringify({BASE_URL:apps.management,VITE_FIREBASE_API_KEY:'isolated-test-key',VITE_FIREBASE_AUTH_DOMAIN:'isolated-security-test.firebaseapp.com',VITE_FIREBASE_PROJECT_ID:'isolated-security-test',VITE_FIREBASE_STORAGE_BUCKET:'isolated-security-test.appspot.com',VITE_FIREBASE_MESSAGING_SENDER_ID:'123',VITE_FIREBASE_APP_ID:'1:123:web:isolated'})},logLevel:'silent'});
  scripts['/security-fixture.js']=fixture.outputFiles[0].text;
  origin=await serve();attackerOrigin=await serve();
  browser=await chromium.launch({headless:true,...(process.platform==='win32'?{channel:'msedge'}:{})});
});
after(async()=>{await browser?.close();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));});

async function isolatedPage({mockFirebase=false}={}){
  const context=await browser.newContext({serviceWorkers:'block'});context.setDefaultTimeout(5000);const remote=[];
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(url.hostname==='127.0.0.1')return route.continue();
    remote.push(url.href);
    if(mockFirebase && ['identitytoolkit.googleapis.com','firestore.googleapis.com'].includes(url.hostname)){
      const headers={'access-control-allow-origin':'*','access-control-allow-headers':'*','access-control-allow-methods':'GET,POST,OPTIONS'};
      if(route.request().method()==='OPTIONS')return route.fulfill({status:204,headers,body:''});
      const now=Math.floor(Date.now()/1000),uid='isolated-user';
      const token=[{alg:'none',typ:'JWT'},{iss:'https://securetoken.google.com/isolated-security-test',aud:'isolated-security-test',sub:uid,user_id:uid,iat:now,auth_time:now,exp:now+3600,firebase:{identities:{},sign_in_provider:'anonymous'}}].map(value=>Buffer.from(JSON.stringify(value)).toString('base64url')).join('.')+'.isolated';
      const body=url.hostname==='firestore.googleapis.com'?{isolated:true}:url.pathname.endsWith('/accounts:lookup')?{users:[{localId:uid,createdAt:String(Date.now()),lastLoginAt:String(Date.now()),providerUserInfo:[]}]}:{localId:uid,idToken:token,refreshToken:'isolated-refresh',expiresIn:'3600'};
      return route.fulfill({headers,contentType:'application/json',body:JSON.stringify(body)});
    }
    if(url.hostname==='script-probe.invalid')return route.fulfill({contentType:'text/javascript',body:'window.externalProbe=true'});
    return route.abort();
  });
  const page=await context.newPage();
  page.on('pageerror',error=>console.error('Browser module error:',error.message));
  return {context,page,remote};
}
for(const [name,path] of Object.entries(apps)){
  test(name+': production policy blocks injected inline/remote scripts and eval while loading its own module',async()=>{
    const {context,page,remote}=await isolatedPage();
    try{
      await page.goto(origin+path);
      await page.waitForFunction(()=>document.querySelector('#root')?.textContent?.includes('Firebase接続エラー'));
      const result=await page.evaluate(async()=>{
        window.inlineProbe=false;window.externalProbe=false;
        const inline=document.createElement('script');inline.textContent='window.inlineProbe=true';document.body.appendChild(inline);
        await Promise.all(['/self-probe.js','https://script-probe.invalid/probe.js'].map(src=>new Promise(resolve=>{const s=document.createElement('script');s.src=src;s.onload=s.onerror=resolve;document.body.appendChild(s);}))); 
        return {inline:window.inlineProbe,external:window.externalProbe,self:window.selfProbe,eval:window.evalProbe,blocked:window.evalBlocked};
      });
      assert.equal(result.self,true,'same-origin module and script loading works');
      assert.equal(result.inline,false);assert.equal(result.external,false);assert.equal(result.eval,undefined);assert.equal(result.blocked,true);
      assert.equal(remote.length,0,'blocked scripts never make an outbound request');
    }finally{await context.close();}
  });
  for(const attacker of ['same-origin','cross-origin','sandboxed'])test(name+': refuses '+attacker+' iframe startup before authentication',async()=>{
    const {context,page,remote}=await isolatedPage();
    try{
      await page.goto((attacker==='cross-origin'?attackerOrigin:origin)+'/frame?app='+name+(attacker==='sandboxed'?'&sandbox=1':''));
      const frame=page.frameLocator('iframe');
      await frame.locator('[data-security-blocked="embedded"]').waitFor({timeout:2500});
      assert.match(await frame.locator('#root').innerText(),/埋め込み画面では操作できません/);
      assert.equal(await frame.getByRole('link',{name:'アプリを開く'}).getAttribute('rel'),'noopener noreferrer');
      assert.equal(remote.length,0);
    }finally{await context.close();}
  });
}
test('offline reserve entry point also refuses framing',async()=>{
  const {context,page}=await isolatedPage();try{
    await page.goto(attackerOrigin+'/frame?app=management&reserve=1');
    await page.frameLocator('iframe').locator('[data-security-blocked="embedded"]').waitFor({timeout:2500});
  }finally{await context.close();}
});

test('tampered stored print markup cannot execute scripts or reach the opener, while printing still works',async()=>{
  const {context,page}=await isolatedPage();
  try{
    await page.goto(origin+'/fixture');await page.waitForFunction(()=>typeof window.printProbe==='function');
    const next=context.waitForEvent('page');
    await page.evaluate(()=>window.printProbe({eventId:'isolated',eventName:'<img onerror="window.printInjected=true">',preparedAt:'2026-11-07',css:'</style><script>window.printInjected=true</script><style>',sheetStyle:'--ticket-print-width:90mm',columns:1,confirmed:[],pending:{id:'batch',ids:['t']},tickets:[{id:'t',number:'123',svg:'<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>'}],template:'<div class="ticket-print-card"><img src="/missing-security-test.png" onerror="window.printInjected=true"><div class="ticket-design-qr"></div><div class="ticket-design-number"></div></div>'}));
    const popup=await next;
    await popup.locator('.ticket-print-card').waitFor();
    // Exercise the inserted inline handler directly; do not depend on a failed
    // relative image request in a detached about:blank print document.
    await popup.locator('.ticket-print-card img').dispatchEvent('error');
    assert.equal(await popup.evaluate(()=>window.printInjected),undefined);
    assert.equal(await popup.evaluate(()=>window.opener===null),true);
    assert.equal(await popup.locator('.ticket-design-number').innerText(),'123');
    assert.equal(await popup.locator('.ticket-design-qr svg').count(),1);
    const prints=await popup.evaluate(()=>window.printCalls??0);await popup.getByRole('button',{name:'印刷する',exact:true}).click();
    assert.ok((await popup.evaluate(()=>window.printCalls))>prints,'programmatic print handler remains functional');
  }finally{await context.close();}
});
test('QR image decoding still works with scripts/eval locked down',async()=>{
  const {context,page,remote}=await isolatedPage();try{
    await page.goto(origin+'/fixture');await page.waitForFunction(()=>typeof window.scanProbe==='function');
    assert.equal(await page.evaluate(svg=>window.scanProbe(svg),qr),expectedQr);
    assert.equal(remote.length,0);
  }finally{await context.close();}
});

test('the real anonymous-auth client and allowed Firestore transport work through intercepted dummy responses',async()=>{
  const {context,page,remote}=await isolatedPage({mockFirebase:true});try{
    await page.goto(origin+'/fixture');await page.waitForFunction(()=>typeof window.authProbe==='function');
    assert.equal(await page.evaluate(()=>window.authProbe()),'isolated-user');
    assert.deepEqual(await page.evaluate(async()=>{const response=await fetch('https://firestore.googleapis.com/isolated-security-probe');return response.json();}),{isolated:true});
    assert.ok(remote.some(url=>url.includes('accounts:signUp')));
    assert.ok(remote.some(url=>url.includes('firestore.googleapis.com/isolated-security-probe')));
  }finally{await context.close();}
});
