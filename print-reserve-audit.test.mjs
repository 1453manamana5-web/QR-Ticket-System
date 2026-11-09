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
const printArtworkModule={};new Function('exports',ts.transpileModule(readFileSync('management-app/src/printArtwork.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(printArtworkModule);
const compile=source=>ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const label=node=>node.children.map(child=>typeof child==='string'?child:label(child)).join('');
const button=(renderer,text)=>{const result=renderer.root.findAllByType('button').find(node=>label(node)===text);assert.ok(result,text);return result;};
const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-9,`${actual} != ${expected}`);
const ticketList=[501,502,503].map(n=>({id:`T${n}`,qrNumber:String(n),valid:true,status:'unused',reserve:true}));
const packet=(eventId='event-a')=>({eventId,eventName:`Event ${eventId}`,preparedAt:'2026-11-06T00:00:00.000Z',template:'<div class="ticket-print-card"><div class="ticket-design-qr"></div><div class="ticket-design-number"></div></div>',css:'',sheetStyle:'--ticket-print-width:90mm',columns:2,tickets:ticketList.map(t=>({id:t.id,number:t.qrNumber,svg:'<svg></svg>'})),confirmed:[],pending:null});

function reserveModule({store={},globals={}}={}){
  const exports={},source=readFileSync('management-app/src/ReservePrinting.tsx','utf8').replaceAll('import.meta.env.BASE_URL','"/qr-system/control/"');
  const values={navigator:{},window:{},setInterval:()=>0,clearInterval(){},...globals};
  new Function('exports','require',...Object.keys(values),compile(source))(exports,name=>name==='./printArtwork'?printArtworkModule:name==='react'?React:name==='react/jsx-runtime'?require(name):name==='./reservePrintStore'?store:name==='./reservePrintLedger'?{useReservePrintLedger:()=>({unsynced:0})}:{},...Object.values(values));
  return exports;
}

function designerModule(storage,{globals={},onReserve=()=>{}}={}){
  const exports={};
  const values={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},window:{confirm:()=>true},alert(){},...globals};
  new Function('exports','require',...Object.keys(values),compile(readFileSync('management-app/src/TicketDesigner.tsx','utf8')))(exports,name=>name==='./printArtwork'?printArtworkModule:name==='react'?React:name==='react/jsx-runtime'||name==='qrcode.react'||name==='react-dom/server'?require(name):name==='./reservePrintStore'?{loadReservePackage:async()=>null}:name==='./ReservePrinting'?{ReserveConfiguration:props=>{onReserve(props);return null;}}:name==='./LazyQrCode'?{default:()=>React.createElement('span',{'data-lazy-qr':true})}:{},...Object.values(values));
  return exports;
}

test('saved font proportions survive a narrow editor, resize, zoom and reopening on a wider screen',async()=>{
  const key='qr-management-ticket-design-id-font',storage=new Map([[key,JSON.stringify({title:'文化祭',titleSize:24,numberSize:36,printWidthMm:90,qrSize:27,qrX:71})]]);
  const card={clientWidth:320,getBoundingClientRect:()=>({width:card.clientWidth*2,height:300,left:0,top:0})};let resize;
  const mod=designerModule(storage,{globals:{ResizeObserver:class{constructor(callback){resize=callback;}observe(){}disconnect(){}}}});
  let renderer;
  const mount=async()=>act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'font',eventName:'Event',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){}}),{createNodeMock:node=>node.props.className==='ticket-design-card'?card:null});});
  const printed=()=>renderer.root.findAll(node=>node.props.className==='ticket-print-card')[0];
  const number=()=>printed().findByProps({className:'ticket-design-number'});
  const editorNumber=()=>renderer.root.findAll(node=>String(node.props.className).startsWith('ticket-design-number ticket-draggable-part'))[0];
  await mount();
  try{
    close(parseFloat(editorNumber().props.style.fontSize),36,'legacy migration must not visibly resize text');
    const physical=number().props.style.fontSize;close(parseFloat(physical),36/320*90);
    assert.equal(JSON.parse(storage.get(key)).textReferenceWidth,320,'existing saved designs migrate without requiring another Save');
    assert.ok(printed().findAllByType('svg').length,'actual print tickets must already contain SVG before the lazy preview loads');
    assert.equal(printed().findAllByProps({'data-lazy-qr':true}).length,0);
    await act(async()=>button(renderer,'保存').props.onClick());
    assert.equal(JSON.parse(storage.get(key)).textReferenceWidth,320);
    await act(async()=>renderer.root.findByProps({'aria-label':'拡大'}).props.onClick());
    assert.equal(number().props.style.fontSize,physical);
    card.clientWidth=640;await act(async()=>resize());
    close(parseFloat(editorNumber().props.style.fontSize),72);
    assert.equal(number().props.style.fontSize,physical,'orientation changes must not alter printed text');
    await act(async()=>button(renderer,'実寸確認').props.onClick());
    close(parseFloat(renderer.root.findByProps({className:'ticket-actual-size-preview'}).findByProps({className:'ticket-design-number'}).props.style.fontSize),parseFloat(physical)*96/25.4);
    card.clientWidth=0;await act(async()=>resize());assert.equal(number().props.style.fontSize,physical);
    await act(async()=>renderer.unmount());
    card.clientWidth=760;await mount();
    assert.equal(number().props.style.fontSize,physical);
    close(parseFloat(editorNumber().props.style.fontSize),36*760/320);
    const qr=printed().findByProps({className:'ticket-design-qr'});assert.equal(qr.props.style.width,'27%');assert.equal(qr.props.style.left,'71%');
  }finally{await act(async()=>renderer.unmount());}
});

test('automatic font migration changes only metadata in the latest saved design and leaves unsaved edits in memory',async()=>{
  const key='qr-management-ticket-design-id-metadata',storage=new Map([[key,JSON.stringify({title:'Saved title',numberSize:20})]]);
  const card={clientWidth:0};let resize;
  const mod=designerModule(storage,{globals:{ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){}}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'metadata',eventName:'Event',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){}}),{createNodeMock:node=>node.props.className==='ticket-design-card'?card:null});});
  try{
    await act(async()=>button(renderer,'T文字').props.onClick());
    await act(async()=>renderer.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'Unsaved title'}}));
    storage.set(key,JSON.stringify({title:'Saved in another window',numberSize:20,otherSetting:'keep'}));
    card.clientWidth=400;await act(async()=>resize());
    assert.deepEqual(JSON.parse(storage.get(key)),{title:'Saved in another window',numberSize:20,otherSetting:'keep',textReferenceWidth:400});
    const editor=renderer.root.findAll(node=>String(node.props.className).startsWith('ticket-design-title ticket-draggable-part'))[0];assert.match(label(editor),/Unsaved title/);
  }finally{await act(async()=>renderer.unmount());}
});

test('a failed migration write keeps printing at the measured size',async()=>{
  const saved=JSON.stringify({title:'Existing',numberSize:20}),storage=new Map();let writes=0;
  const mod=designerModule(storage,{globals:{localStorage:{getItem:key=>key.endsWith('id-storage-failure')?saved:null,setItem(){writes++;throw Error('Quota exceeded');}}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'storage-failure',eventName:'Event',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){}}),{createNodeMock:node=>node.props.className==='ticket-design-card'?{clientWidth:400}:null});});
  try{assert.ok(writes>0);close(parseFloat(renderer.root.findAll(node=>node.props.className==='ticket-print-card')[0].findByProps({className:'ticket-design-number'}).props.style.fontSize),4.5);}finally{await act(async()=>renderer.unmount());}
});

test('saved designs use the same relative text sizes in the ticket QR preview',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-preview',JSON.stringify({title:'Test',titleSize:24,numberSize:36,textReferenceWidth:320})]]),card={clientWidth:280};let resize;
  const mod=designerModule(storage,{globals:{ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){}}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(mod.TicketQrPreview,{eventId:'preview',eventName:'Event',ticketNumber:'501',qrValue:'T501'}),{createNodeMock:node=>node.props.className==='ticket-qr-design-preview'?card:null});});
  try{
    close(parseFloat(renderer.root.findByProps({className:'ticket-design-number'}).props.style.fontSize),36*280/320);
    close(parseFloat(renderer.root.findByProps({className:'ticket-design-title'}).props.style.fontSize),24*280/320);
    card.clientWidth=560;await act(async()=>resize());
    close(parseFloat(renderer.root.findByProps({className:'ticket-design-number'}).props.style.fontSize),63);
  }finally{await act(async()=>renderer.unmount());}
});

test('reserve templates freeze the same physical font size as ordinary printing after an editor resize',async()=>{
  const storage=new Map([['qr-management-ticket-design-id-reserve',JSON.stringify({title:'Test',numberSize:30,textReferenceWidth:500,printWidthMm:100})]]);
  let reserveProps,markup='',resize;const card={clientWidth:350};
  const document={createElement(){return {set innerHTML(value){markup=value;},querySelector(){return {outerHTML:markup,querySelector:()=>({innerHTML:'',textContent:''})};}};}};
  const mod=designerModule(storage,{onReserve:props=>{reserveProps=props;},globals:{document,ResizeObserver:class{constructor(fn){resize=fn;}observe(){}disconnect(){}}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'reserve',eventName:'Reserve',initialReserveOpen:true,tickets:ticketList,qrValue:t=>t.id,onClose(){}}),{createNodeMock:node=>node.props.className==='ticket-design-card'?card:null});});
  try{
    let saved=await reserveProps.build(['T501','T502']);assert.match(saved.template,/font-size:6mm/);assert.ok(saved.tickets.every(t=>t.svg.startsWith('<svg')&&t.svg.includes('<path')));
    card.clientWidth=700;await act(async()=>resize());
    saved=await reserveProps.build(['T501','T502']);assert.match(saved.template,/font-size:6mm/);
  }finally{await act(async()=>renderer.unmount());}
});

for(const invalid of [0,-1,'bad',null])test(`invalid saved font reference ${JSON.stringify(invalid)} migrates from the visible editor`,async()=>{
  const storage=new Map([['qr-management-ticket-design-id-invalid',JSON.stringify({title:'Test',numberSize:20,textReferenceWidth:invalid})]]);
  const mod=designerModule(storage);let renderer;await act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'invalid',eventName:'Event',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){}}),{createNodeMock:node=>node.props.className==='ticket-design-card'?{clientWidth:400}:null});});
  try{await act(async()=>button(renderer,'保存').props.onClick());assert.equal(JSON.parse(storage.get('qr-management-ticket-design-id-invalid')).textReferenceWidth,400);close(parseFloat(renderer.root.findAll(node=>node.props.className==='ticket-print-card')[0].findByProps({className:'ticket-design-number'}).props.style.fontSize),4.5);}finally{await act(async()=>renderer.unmount());}
});

test('offline readiness asks the current scoped worker and respects an incomplete shell',async()=>{
  let answer={app:'management',ready:true},requests=0,closed=0;
  class Channel{constructor(){this.port1={onmessage:null,close(){closed++;}};this.port2={target:this.port1,close(){closed++;}};}}
  const mod=reserveModule({globals:{MessageChannel:Channel,caches:{open:()=>assert.fail('worker result must be authoritative')}}});
  const reg={scope:'https://example.test/qr-system/control/',active:{postMessage(message,ports){requests++;assert.deepEqual(message,{type:'OFFLINE_STATUS'});queueMicrotask(()=>ports[0].target.onmessage({data:answer}));}}};
  assert.equal(await mod.isReserveOfflineReady(reg,'/qr-system/control/'),true);
  answer={app:'management',ready:false};assert.equal(await mod.isReserveOfflineReady(reg,'/qr-system/control/'),false);
  answer={app:'reception',ready:true};assert.equal(await mod.isReserveOfflineReady(reg,'/qr-system/control/'),false);
  assert.equal(await mod.isReserveOfflineReady({...reg,scope:'https://example.test/'},'/qr-system/control/'),false);
  assert.equal(requests,3);assert.equal(closed,6);
});

test('legacy offline readiness finds a hashed existing cache without creating the obsolete v1 cache',async()=>{
  const opened=[],index='https://example.test/qr-system/control/index.html';
  const mod=reserveModule({globals:{MessageChannel:undefined,caches:{keys:async()=>['qr-ticket-reception-shell-abc','qr-ticket-management-shell-release456'],open:async name=>{opened.push(name);return {match:async url=>url===index?new Response('app'):undefined};}}}});
  assert.equal(await mod.isReserveOfflineReady({scope:'https://example.test/qr-system/control/',active:{}},'/qr-system/control/'),true);
  assert.deepEqual(opened,['qr-ticket-management-shell-release456']);
});

test('reserve event switching clears an old packet and ignores old load failures',async()=>{
  const b=deferred(),c=deferred();
  const store={loadReservePackage:id=>id==='event-a'?Promise.resolve(packet()):id==='event-b'?b.promise:c.promise};
  const mod=reserveModule({store});let renderer;
  const props=id=>({eventId:id,tickets:ticketList,build:async()=>packet(id),onSaved(){},practice:true,store});
  await act(async()=>{renderer=create(React.createElement(mod.ReserveConfiguration,props('event-a')));});
  try{
    assert.equal(renderer.root.findAllByType(mod.ReservePrintControls).length,1);
    await act(async()=>renderer.update(React.createElement(mod.ReserveConfiguration,props('event-b'))));
    assert.equal(renderer.root.findAllByType(mod.ReservePrintControls).length,0);
    await act(async()=>renderer.update(React.createElement(mod.ReserveConfiguration,props('event-c'))));
    await act(async()=>{b.reject(Error('old failure'));c.resolve(null);});
    assert.equal(renderer.root.findAllByProps({role:'alert'}).length,0);
  }finally{await act(async()=>renderer.unmount());}
});

test('an unfinished reserve build cannot save tickets or call onSaved after switching events',async()=>{
  const built=deferred();let builds=0,saves=0,callbacks=0;
  const store={loadReservePackage:async()=>null,saveReservePackage:async p=>{saves++;return p;}};
  const mod=reserveModule({store});let renderer;
  const props=id=>({eventId:id,tickets:ticketList,build:()=>{builds++;return built.promise;},onSaved(){callbacks++;},practice:true,store});
  await act(async()=>{renderer=create(React.createElement(mod.ReserveConfiguration,props('event-a')));});
  try{
    const save=button(renderer,'予備のデザインとQRを端末に保存');
    await act(async()=>{save.props.onClick();save.props.onClick();});assert.equal(builds,1,'same-frame double taps must not build twice');
    await act(async()=>renderer.update(React.createElement(mod.ReserveConfiguration,props('event-b'))));
    await act(async()=>built.resolve(packet()));assert.equal(saves,0);assert.equal(callbacks,0);
    assert.equal(renderer.root.findAllByType(mod.ReservePrintControls).length,0);
  }finally{await act(async()=>renderer.unmount());}
});

test('a slow initial reserve load cannot replace newly saved preparation',async()=>{
  const old=deferred();const newer={...packet(),preparedAt:'2026-11-06T09:00:00.000Z'};
  const store={loadReservePackage:()=>old.promise,saveReservePackage:async p=>p};
  const mod=reserveModule({store});let renderer;await act(async()=>{renderer=create(React.createElement(mod.ReserveConfiguration,{eventId:'event-a',tickets:ticketList,build:async()=>newer,onSaved(){},practice:true,store}));});
  try{
    await act(async()=>button(renderer,'予備のデザインとQRを端末に保存').props.onClick());
    await act(async()=>old.resolve(packet()));
    assert.equal(renderer.root.findByType(mod.ReservePrintControls).props.packet.preparedAt,newer.preparedAt);
  }finally{await act(async()=>renderer.unmount());}
});

test('offline reserve switching never leaves the previous event printable',async()=>{
  const old=deferred(),store={loadReservePackage:id=>id==='event-a'?Promise.resolve(packet()):old.promise};
  const mod=reserveModule({store});let renderer;await act(async()=>{renderer=create(React.createElement(mod.default,{eventId:'event-a'}));});
  try{
    assert.equal(renderer.root.findAllByType(mod.ReservePrintControls).length,1);
    await act(async()=>renderer.update(React.createElement(mod.default,{eventId:'event-b'})));
    assert.equal(renderer.root.findAllByType(mod.ReservePrintControls).length,0);
    await act(async()=>old.resolve(null));assert.match(label(renderer.root),/この端末に予備印刷が保存されていません/);
  }finally{await act(async()=>renderer.unmount());}
});

test('same-frame print taps claim one batch and an unmounted print view cannot publish stale state',async()=>{
  const claimed=deferred();let claims=0,changes=0;
  const store={claimReserveBatch(){claims++;return claimed.promise;},loadReservePackage:async()=>packet()};
  const mod=reserveModule({store});let renderer;await act(async()=>{renderer=create(React.createElement(mod.ReservePrintControls,{packet:packet(),practice:true,store,onChange(){changes++;}}));});
  const print=button(renderer,'予備チケットを印刷');await act(async()=>{print.props.onClick();print.props.onClick();});assert.equal(claims,1);
  await act(async()=>renderer.unmount());await act(async()=>claimed.resolve({...packet(),pending:{id:'one',ids:['T501']}}));assert.equal(changes,0);
});

test('redesigning reserves keeps confirmed and synced IDs even if they temporarily leave the selected range',async()=>{
  const store={};new Function('exports','indexedDB','crypto',compile(readFileSync('management-app/src/reservePrintStore.ts','utf8')))(store,new IDBFactory(),webcrypto);
  await store.saveReservePackage(packet());let saved=await store.claimReserveBatch('event-a',1);
  await store.finishReserveBatch('event-a',saved.pending.id,true);await store.markReservePrintsSynced('event-a',['T501']);
  await store.saveReservePackage({...packet(),template:'new physical font template',tickets:packet().tickets.slice(1)});
  saved=await store.saveReservePackage(packet());assert.deepEqual(saved.confirmed,['T501']);assert.deepEqual(saved.synced,['T501']);
  saved=await store.claimReserveBatch('event-a',1);assert.deepEqual(saved.pending.ids,['T502']);
  await assert.rejects(store.saveReservePackage(packet()),/確認待ち/);
});

for(const fail of [false,true])test('a delayed print-state refresh cannot replace a newly claimed batch'+(fail?' with a stale failure':''),async()=>{
  const old=deferred(),claimed={...packet(),pending:{id:'current-batch',ids:['T501']}};
  const store={loadReservePackage:()=>old.promise,claimReserveBatch:async()=>claimed};
  const mod=reserveModule({store});let renderer;
  function Harness(){const [value,setValue]=React.useState(packet());return React.createElement(mod.ReservePrintControls,{packet:value,onChange:setValue,practice:true,store});}
  await act(async()=>{renderer=create(React.createElement(Harness));});
  try{
    await act(async()=>button(renderer,'印刷状態を更新').props.onClick());
    await act(async()=>button(renderer,'予備チケットを印刷').props.onClick());
    assert.ok(button(renderer,'印刷完了して次へ'));
    await act(async()=>fail?old.reject(Error('old read failed')):old.resolve(packet()));
    assert.ok(button(renderer,'印刷完了して次へ'),'the current pending batch must stay confirmable');
    assert.equal(renderer.root.findAllByProps({role:'alert'}).length,0,'an obsolete refresh must not show an unrelated error');
  }finally{await act(async()=>renderer.unmount());}
});

for(const fail of [false,true])test('a current print-state refresh still '+(fail?'reports its read failure':'shows another tab pending batch'),async()=>{
  const fresh={...packet(),pending:{id:'another-tab',ids:['T502']}};
  const store={loadReservePackage:async()=>{if(fail)throw Error('current failure');return fresh;}};
  const mod=reserveModule({store});let renderer;
  function Harness(){const [value,setValue]=React.useState(packet());return React.createElement(mod.ReservePrintControls,{packet:value,onChange:setValue,practice:true,store});}
  await act(async()=>{renderer=create(React.createElement(Harness));});
  try{
    await act(async()=>button(renderer,'印刷状態を更新').props.onClick());
    if(fail)assert.match(label(renderer.root),/状態を取得できませんでした/);
    else assert.ok(button(renderer,'印刷完了して次へ'));
  }finally{await act(async()=>renderer.unmount());}
});
