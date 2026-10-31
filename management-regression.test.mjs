import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import React from 'react';
import {act,create} from 'react-test-renderer';
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function reserveStore(){const out={};new Function('exports','indexedDB','crypto',ts.transpileModule(readFileSync('management-app/src/reservePrintStore.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,new IDBFactory(),webcrypto);return out;}
const reservePacket=(numbers=[501,502,503])=>({eventId:'reserve-event',eventName:'Reserve event',preparedAt:new Date().toISOString(),template:'<div class="ticket-print-card"><div class="ticket-design-qr"></div><div class="ticket-design-number"></div></div>',css:'.ticket-print-card{}',sheetStyle:'--ticket-print-width:90mm',columns:2,tickets:numbers.map(n=>({id:'TKT'+n,number:String(n),svg:'<svg></svg>'})),confirmed:[],pending:null});

test('reserve printing retains pending batches after reopening, cancellation reuses numbers and confirmation advances',async()=>{
  const store=reserveStore();await store.saveReservePackage(reservePacket());
  let state=await store.claimReserveBatch('reserve-event',2);
  assert.deepEqual(state.pending.ids,['TKT501','TKT502']);assert.equal(state.confirmed.length,0);
  assert.deepEqual((await store.loadReservePackage('reserve-event')).pending,state.pending);
  await assert.rejects(store.claimReserveBatch('reserve-event',1),/確認待ち/);
  await store.finishReserveBatch('reserve-event',state.pending.id,false);
  state=await store.claimReserveBatch('reserve-event',2);assert.deepEqual(state.pending.ids,['TKT501','TKT502']);
  const id=state.pending.id;await store.finishReserveBatch('reserve-event',id,true);
  await assert.rejects(store.finishReserveBatch('reserve-event',id,true),/変更/);
  state=await store.claimReserveBatch('reserve-event',1);assert.deepEqual(state.pending.ids,['TKT503']);
  await store.finishReserveBatch('reserve-event',state.pending.id,true);
  await assert.rejects(store.claimReserveBatch('reserve-event',1),/残数/);
});

test('simultaneous reserve print windows can claim only one batch and preparing a new design preserves the print ledger',async()=>{
  const store=reserveStore();await store.saveReservePackage(reservePacket());
  const results=await Promise.allSettled([store.claimReserveBatch('reserve-event',2),store.claimReserveBatch('reserve-event',2)]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  const state=await store.loadReservePackage('reserve-event');
  await assert.rejects(store.saveReservePackage(reservePacket([503,504,505])),/確認待ち/);
  assert.deepEqual((await store.loadReservePackage('reserve-event')).tickets.map(t=>t.id),['TKT501','TKT502','TKT503']);
  await store.finishReserveBatch('reserve-event',state.pending.id,true);
  await store.saveReservePackage(reservePacket([503,504,505]));
  await store.saveReservePackage(reservePacket());
  assert.deepEqual((await store.claimReserveBatch('reserve-event',1)).pending.ids,['TKT503']);
  assert.throws(()=>store.claimReserveBatch('reserve-event',0),/整数/);
});

test('reserves require an existing unique range of valid unused tickets',()=>{
  const store=reserveStore();const tickets=[503,501,502].map(n=>({id:'TKT'+n,qrNumber:String(n).padStart(6,'0'),valid:true,status:'unused'}));
  assert.deepEqual(store.selectReserveTickets(tickets,501,503).map(t=>t.id),['TKT501','TKT502','TKT503']);
  for(const [start,end] of [[0,2],[503,501],[501.5,503],[501,504],[1,5001]])assert.throws(()=>store.selectReserveTickets(tickets,start,end));
  for(const change of [{valid:false},{status:'inside'},{qrNumber:'501'}])assert.throws(()=>store.selectReserveTickets([{...tickets[0],...change},...tickets.slice(1)],501,503));
});

test('the offline reserve entry opens before Firebase authentication',async()=>{
  let authentication=0,rendered;
  function Offline(){}function App(){}
  const deps={'react-dom/client':{default:{createRoot:()=>({render:element=>{rendered=element;}})}},'react/jsx-runtime':require('react/jsx-runtime'),'./App':{default:App},'./styles.css':{},'./legacy-ticket-design-overrides.css':{},'./motion.css':{},'./ReservePrinting':{default:Offline},'./firebaseClient':{ensureFirebaseAuth:()=>{authentication++;throw Error('No network');}}};
  const source=readFileSync('management-app/src/main.tsx','utf8').replaceAll('import.meta.env.BASE_URL','"/QR-Ticket-System/management-app/"');
  new Function('exports','require','document','navigator','window',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:false}}).outputText)({},n=>deps[n],{getElementById:()=>({})},{},{location:{search:'?reserve-print=reserve-event'}});
  assert.equal(authentication,0);assert.equal(rendered.type,Offline);assert.equal(rendered.props.eventId,'reserve-event');
});

test('management offline shell preserves its last complete shell and serves the reserve query without the network',async()=>{
  const listeners=new Map(),entries=new Map();let fail=false,offline=false;
  const base='https://test.example/QR-Ticket-System/management-app/';
  const cache={put:async(k,v)=>entries.set(k,v.clone()),match:async k=>entries.get(typeof k==='string'?k:k.url)?.clone()};
  const caches={open:async()=>cache,keys:async()=>[],delete:async()=>true};
  const fetch=async url=>{if(offline)throw Error('offline');if(String(url).endsWith('offline-assets.json'))return Response.json(['assets/app.js','assets/lazy.js']);return new Response(String(url).endsWith('index.html')?'<script src="./assets/app.js"></script>':fail?'failed':'app',{status:fail&&!String(url).endsWith('index.html')?503:200});};
  const self={location:{href:base+'sw.js',origin:'https://test.example'},addEventListener:(name,fn)=>listeners.set(name,fn),skipWaiting:async()=>{},clients:{claim:async()=>{}}};
  new Function('self','caches','fetch','Response','URL',readFileSync('management-app/public/sw.js','utf8'))(self,caches,fetch,Response,URL);
  let install;listeners.get('install')({waitUntil:p=>{install=p;}});await install;
  assert.ok(entries.has(base+'assets/app.js'));assert.ok(entries.has(base+'assets/lazy.js'));const saved=await entries.get(base+'index.html').clone().text();
  fail=true;listeners.get('install')({waitUntil:p=>{install=p;}});await assert.rejects(install);assert.equal(await entries.get(base+'index.html').clone().text(),saved);
  offline=true;let response;
  listeners.get('fetch')({request:{url:base+'?reserve-print=reserve-event',method:'GET',mode:'navigate'},respondWith:p=>{response=p;}});
  assert.equal(await (await response).text(),saved);
  let intercepted=false;listeners.get('fetch')({request:{url:'https://test.example/QR-Ticket-System/',method:'GET',mode:'navigate'},respondWith:()=>{intercepted=true;}});assert.equal(intercepted,false);
});
test('offline manager export creates self contained QR pages and escapes the event name',async()=>{
  const compile=file=>ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const protocol={};new Function('exports','crypto',compile('shared/src/offlineTransfer.ts'))(protocol,webcrypto);
  let saved;const module={};
  new Function('exports','require','document','URL','setTimeout',compile('management-app/src/OfflineEventTransfer.tsx'))(module,n=>n==='../../shared/src/offlineTransfer'?protocol:require(n),{createElement:()=>({click(){}})},{createObjectURL:blob=>{saved=blob;return 'blob:test';}},()=>0);
  const event={eventId:'export-test',eventName:'<img src=x onerror=alert(1)>',eventDate:'2026-10-30',startTime:'09:00',endTime:'17:00',eventStatus:'ready',dataVersion:1};
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{data:{event,settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},tickets:[]}}));});
  try{
    const label=node=>node.children.map(c=>typeof c==='string'?c:label(c)).join('');
    const click=async text=>{const button=renderer.root.findAllByType('button').find(n=>label(n)===text);assert.ok(button,text);await act(async()=>button.props.onClick());};
    await click('オフラインQRを作成・更新');await click('QRをファイルに保存');
    const html=await saved.text();
    assert.match(html,/<svg/);assert.match(html,/&lt;img/);assert.doesNotMatch(html,/<img src=x/);
    assert.doesNotMatch(html,/<script[^>]+src=|<link[^>]+href=/);
    assert.equal((html.match(/<script>/g)??[]).length,0);
  }finally{await act(async()=>renderer.unmount());}
});
test('print title treats event names as text and prints only once',async()=>{
  const name='文化祭</title><script>alert(1)</script>&体験';
  let html='',prints=0,load;
  const printDocument={open(){},write(value){html=value;},close(){},body:{appendChild(){}},readyState:'complete'};
  const popup={document:printDocument,closed:false,focus(){},print(){prints++;},addEventListener(_event,fn){load=fn;}};
  const window={open:()=>popup,setTimeout:fn=>fn()};
  const document={querySelector:()=>({cloneNode:()=>({style:{}})})};
  const exports={};
  new Function('exports','require','localStorage','window','document','alert',ts.transpileModule(readFileSync('management-app/src/TicketDesigner.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(exports,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):n==='./reservePrintStore'?{loadReservePackage:async()=>null}:n==='./LazyQrCode'?{default:()=>null}:{},{getItem:()=>null},window,document,()=>assert.fail('printing failed'));
  let renderer;await act(async()=>{renderer=create(React.createElement(exports.default,{eventName:name,tickets:[{id:'1',qrNumber:'1',valid:true,status:'unused'}],qrValue:()=>'',onClose(){}}));});
  const click=async text=>{const button=renderer.root.findAllByType('button').find(n=>n.children.join('')===text);assert.ok(button,text);await act(async()=>button.props.onClick());};
  try{
    await click('画像を使わず新規作成');await click('印刷');
    assert.equal(printDocument.title,name+' - 印刷');assert.equal(html.includes('<script>'),false);assert.equal(html.includes(name),false);
    load();assert.equal(prints,1);
  }finally{await act(async()=>renderer.unmount());}
});

function designerModule(storage,{globals={},detection={},reserve=null}={}){
  const out={};
  new Function('exports','require','localStorage','window','alert',...Object.keys(globals),ts.transpileModule(readFileSync('management-app/src/TicketDesigner.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):n==='./reservePrintStore'?{loadReservePackage:async()=>reserve}:n==='./LazyQrCode'?{default:()=>null}:n==='./pinkQrMarkerDetection'?detection:{},{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},{confirm:()=>true},()=>{},...Object.values(globals));
  return out;
}
const designTickets=Array.from({length:6},(_,i)=>({id:String(i),qrNumber:String(i+1),valid:true,status:'unused'}));
const designLabel=node=>node.children.map(child=>typeof child==='string'?child:designLabel(child)).join('');

test('designs are isolated by event ID, survive renaming, and migrate named designs without changing another event',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-event-a',JSON.stringify({title:'Design A'})]]),module=designerModule(storage);
  let renderer;
  const mount=async(eventId,eventName)=>{await act(async()=>{renderer=create(React.createElement(module.default,{eventId,eventName,tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});};
  await mount('event-a','Same name');
  assert.ok(renderer.root.findAll(node=>node.props.className==='ticket-design-title ticket-draggable-part ').length>0);
  assert.ok(JSON.stringify(renderer.toJSON()).includes('Design A'));
  await act(async()=>renderer.unmount());
  await mount('event-b','Same name');
  assert.equal(JSON.stringify(renderer.toJSON()).includes('Design A'),false);
  await act(async()=>renderer.unmount());
  await mount('event-a','Renamed event');assert.ok(JSON.stringify(renderer.toJSON()).includes('Design A'));
  await act(async()=>renderer.unmount());
  storage.set('qr-management-ticket-design-'+encodeURIComponent('Legacy name'),JSON.stringify({title:'Legacy design'}));
  await mount('event-c','Legacy name');
  await act(async()=>renderer.root.findAllByType('button').find(node=>designLabel(node)==='保存').props.onClick());
  assert.ok(storage.get('qr-management-ticket-design-id-event-c').includes('Legacy design'));
  await act(async()=>renderer.unmount());
});

test('malformed saved image lists and column counts cannot crash print layout',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-damaged',JSON.stringify({title:'Recovered',images:{broken:true},cardsPerRow:0,printWidthMm:null,qrX:'bad'})]]),module=designerModule(storage);
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'damaged',eventName:'Damaged',tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});
  try{assert.equal(renderer.root.findAll(node=>node.props.className==='ticket-print-card').length,6);}finally{await act(async()=>renderer.unmount());}
});

test('pink marker detection and containment mapping preserve the intended QR position',()=>{
  const out={};new Function('exports',ts.transpileModule(readFileSync('management-app/src/pinkQrMarkerDetection.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out);
  const pixels=new Uint8ClampedArray(100*60*4);
  for(let y=20;y<40;y++)for(let x=65;x<85;x++)pixels.set([255,0,170,255],(y*100+x)*4);
  const marker=out.detectPinkQrMarker(pixels,100,60);assert.equal(marker.centerXPercent,75);assert.equal(marker.centerYPercent,50);assert.equal(marker.sizePercent,20);
  assert.equal(out.findClosestTicketRatio(1600,900).cardRatio,'16:9');
  const mapped=out.mapMarkerToTicketRatio(marker,100,60,{width:16,height:9});assert.equal(mapped.centerXPercent,73.4375);
  assert.equal(out.detectPinkQrMarker(new Uint8ClampedArray(4),100,60),null);
});

test('undoing a background while analysis is pending cannot revive the undone background',async()=>{
  let finish;const storage=new Map();
  const module=designerModule(storage,{globals:{FileReader:class{readAsDataURL(){this.result='data:image/png;base64,new';this.onload();}}},detection:{analyzeTicketBackgroundFromDataUrl:()=>new Promise(resolve=>{finish=resolve;})}});
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'undo-background',eventName:'Test',tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});
  const click=async name=>{const node=renderer.root.findAllByType('button').find(node=>designLabel(node)===name||node.props['aria-label']===name);assert.ok(node,name);await act(async()=>node.props.onClick());};
  try{
    const upload=renderer.root.findAllByType('input').find(node=>node.props.type==='file');
    await act(async()=>upload.props.onChange({target:{files:[{name:'background.png',type:'image/png'}],value:''}}));
    await click('元に戻す');
    await act(async()=>finish({marker:null,ratio:{cardRatio:'4:3'}}));
    await click('保存');
    const saved=JSON.parse(storage.get('qr-management-ticket-design-id-undo-background'));
    assert.equal(saved.backgroundImage,'');assert.equal(saved.cardRatio,'16:9');
  }finally{await act(async()=>renderer.unmount());}
});

test('late background detection preserves a manual QR adjustment and locked QR placement',async()=>{
  for(const locked of [false,true]){
    let finish;const storage=new Map([['qr-management-ticket-design-id-position',JSON.stringify({title:'Existing',locked:{qr:locked}})]]);
    const module=designerModule(storage,{globals:{FileReader:class{readAsDataURL(){this.result='data:image/png;base64,new';this.onload();}}},detection:{analyzeTicketBackgroundFromDataUrl:()=>new Promise(resolve=>{finish=resolve;})}});
    let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'position',eventName:'Test',tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});
    const click=async name=>{const node=renderer.root.findAllByType('button').find(node=>designLabel(node)===name);assert.ok(node,name);await act(async()=>node.props.onClick());};
    try{
      const upload=renderer.root.findAllByType('input').find(node=>node.props.accept==='image/*');
      await act(async()=>upload.props.onChange({target:{files:[{name:'background.png',type:'image/png'}],value:''}}));
      if(!locked){
        await click('▦QR');await click('パーツ設定を開く');
        await act(async()=>renderer.root.findByProps({'aria-label':'QRコードの横位置'}).props.onChange({target:{value:'25'}}));
      }
      await act(async()=>finish({marker:{centerXPercent:80,centerYPercent:55,sizePercent:20},ratio:{cardRatio:'4:3'}}));
      await click('保存');
      const saved=JSON.parse(storage.get('qr-management-ticket-design-id-position'));
      assert.equal(saved.qrX,locked?76:25);
    }finally{await act(async()=>renderer.unmount());}
  }
});


test('prepared reserve IDs are excluded from normal printing after reopening the designer',async()=>{
  const module=designerModule(new Map([['qr-management-ticket-design-id-reserved',JSON.stringify({title:'Test'})]]),{reserve:{tickets:[{id:'4'},{id:'5'}]}});
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'reserved',eventName:'Test',tickets:designTickets,qrValue:t=>t.id,onClose(){}}));});
  try{
    const cards=renderer.root.findAll(node=>node.props.className==='ticket-print-card');
    assert.equal(cards.length,4);
    assert.ok(JSON.stringify(renderer.toJSON()).includes('通常印刷から予備 '));
  }finally{await act(async()=>renderer.unmount());}
});

test('reserve print popup uses only pending tickets and preserves layout without confirming the ledger',()=>{
  class Element{
    children=[];attrs={};append(...nodes){this.children.push(...nodes);}appendChild(node){this.children.push(node);return node;}
    setAttribute(key,value){this.attrs[key]=value;}get lastElementChild(){return this.children.at(-1);}
    set innerHTML(value){this.html=value;if(value.includes('ticket-print-card')){this.card=new Element();this.card.qr=new Element();this.card.number=new Element();}}
    querySelector(selector){return selector==='.ticket-print-card'?this.card:selector==='.ticket-design-qr'?this.qr:this.number;}
  }
  let html='',prints=0,onLoad;const doc={body:new Element(),open(){},write(value){html=value;},close(){},createElement(){return new Element();},readyState:'loading'};
  const popup={document:doc,closed:false,focus(){},print(){prints++;},addEventListener(_event,fn){onLoad=fn;}};
  const out={};const source=readFileSync('management-app/src/ReservePrinting.tsx','utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/management-app/'));
  new Function('exports','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):{});
  const packet=reservePacket([501,502,503,504]);packet.eventName='Test</title><script>bad()</script>';packet.pending={id:'batch',ids:['TKT501','TKT502','TKT503']};
  out.openReservePrint(packet,popup);
  const sheet=doc.body.children[1];assert.equal(sheet.attrs.style,packet.sheetStyle);assert.equal(sheet.children.length,2);
  assert.deepEqual(sheet.children.flatMap(row=>row.children.map(card=>card.number.textContent)),['501','502','503']);
  assert.equal(sheet.children[0].children[0].qr.html,'<svg></svg>');assert.equal(doc.title,packet.eventName+' - 予備チケット');assert.equal(html.includes('<script>'),false);
  onLoad();onLoad();assert.equal(prints,1);assert.deepEqual(packet.confirmed,[]);assert.ok(packet.pending);
});

test('reserves marked at issuance are excluded before preparing local offline print data',async()=>{
  const module=designerModule(new Map([['qr-management-ticket-design-id-issued',JSON.stringify({title:'Test'})]]));
  const tickets=designTickets.map((t,i)=>({...t,reserve:i>=4}));
  let renderer;await act(async()=>{renderer=create(React.createElement(module.default,{eventId:'issued',eventName:'Test',tickets,qrValue:t=>t.id,onClose(){}}));});
  try{assert.equal(renderer.root.findAll(n=>n.props.className==='ticket-print-card').length,4);}finally{await act(async()=>renderer.unmount());}
});

test('reserve preparation selects issuance flags across nonconsecutive batches without requiring manual ranges',async()=>{
  let built,saved;const store={loadReservePackage:async()=>null,saveReservePackage:async p=>{saved=p;return p;}};
  const module={};const source=readFileSync('management-app/src/ReservePrinting.tsx','utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/management-app/'));
  new Function('exports','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(module,n=>n==='react'?React:n==='react/jsx-runtime'?require(n):store);
  const tickets=[{id:'a',qrNumber:'501',valid:true,status:'unused',reserve:true},{id:'b',qrNumber:'502',valid:true,status:'unused'},{id:'c',qrNumber:'701',valid:true,status:'unused',reserve:true}];
  let renderer;await act(async()=>{renderer=create(React.createElement(module.ReserveConfiguration,{eventId:'test',tickets,build:async ids=>{built=ids;return reservePacket();},onSaved(){}}));});
  try{
    assert.equal(renderer.root.findAllByProps({'aria-label':'予備の開始番号'}).length,0);
    await act(async()=>renderer.root.findAllByType('button').find(n=>designLabel(n)==='予備のデザインとQRを端末に保存').props.onClick());
    assert.deepEqual(built,['a','c']);assert.ok(saved);
  }finally{await act(async()=>renderer.unmount());}
});

test('print ledger persists unacknowledged confirmations, retries after reconnect and never acknowledges failed writes',async()=>{
  const store=reserveStore();await store.saveReservePackage(reservePacket());
  let packet=await store.claimReserveBatch('reserve-event',1);await store.finishReserveBatch('reserve-event',packet.pending.id,true);
  let timer,online,view,writes=0,fail=true;const navigator={onLine:false};
  const out={};
  new Function('exports','require','window','navigator',ts.transpileModule(readFileSync('management-app/src/reservePrintLedger.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,n=>n==='react'?React:n==='./reservePrintStore'?store:n==='./firebaseClient'?{getFirebaseUid:async()=> 'manager'}:{markReserveTicketsPrinted:async(_event,ids)=>{writes++;assert.deepEqual(ids,['TKT501']);if(fail)throw Error('offline');}},{setInterval:fn=>{timer=fn;return 1;},clearInterval(){},addEventListener:(_name,fn)=>{online=fn;},removeEventListener(){}},navigator);
  function Harness(){view=out.useReservePrintLedger('reserve-event',true);return null;}
  let renderer;const flush=async()=>{await act(async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));});};
  await act(async()=>{renderer=create(React.createElement(Harness));});await flush();
  try{
    assert.deepEqual(view.confirmed,['TKT501']);assert.equal(view.unsynced,1);assert.equal(writes,0);
    navigator.onLine=true;await act(async()=>online());await flush();assert.equal(writes,1);assert.equal(view.unsynced,1);assert.deepEqual((await store.loadReservePackage('reserve-event')).synced,[]);
    fail=false;await act(async()=>timer());await flush();assert.equal(writes,2);assert.equal(view.unsynced,0);assert.deepEqual((await store.loadReservePackage('reserve-event')).synced,['TKT501']);
    await act(async()=>timer());await flush();assert.equal(writes,2);
  }finally{await act(async()=>renderer.unmount());}
});

test('a stalled network request cannot block later local print confirmations',async()=>{
  const store=reserveStore();await store.saveReservePackage(reservePacket());
  let packet=await store.claimReserveBatch('reserve-event',1);await store.finishReserveBatch('reserve-event',packet.pending.id,true);
  let timer,view,release;const auth=new Promise(resolve=>{release=resolve;});
  const out={};new Function('exports','require','window','navigator',ts.transpileModule(readFileSync('management-app/src/reservePrintLedger.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,n=>n==='react'?React:n==='./reservePrintStore'?store:n==='./firebaseClient'?{getFirebaseUid:()=>auth}:{markReserveTicketsPrinted:async()=>{}},{setInterval:fn=>{timer=fn;return 1;},clearInterval(){}},{onLine:true});
  function Harness(){view=out.useReservePrintLedger('reserve-event',true);return null;}
  const flush=async()=>{await act(async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));});};
  let renderer;await act(async()=>{renderer=create(React.createElement(Harness));});await flush();
  try{
    packet=await store.claimReserveBatch('reserve-event',1);await store.finishReserveBatch('reserve-event',packet.pending.id,true);
    await act(async()=>timer());await flush();assert.deepEqual(view.confirmed,['TKT501','TKT502']);assert.equal(view.unsynced,2);
    await act(async()=>release('manager'));await flush();await act(async()=>timer());await flush();assert.equal(view.unsynced,0);
  }finally{await act(async()=>renderer.unmount());}
});
