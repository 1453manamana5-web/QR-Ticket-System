import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import React from 'react';
import {act,create} from 'react-test-renderer';
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function loader(globals={},overrides={}){
 const cache=new Map();
 return function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file);const out={};
 const source=readFileSync(file,'utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/QR-Ticket-System/management-app/'));
 cache.set(file,out);
 const deps=name=>{
   if(name in overrides)return overrides[name];
   if(name.endsWith('.css'))return {};
   if(name.startsWith('.')){let target=path.resolve(path.dirname(file),name);if(!path.extname(target)){try{return load(target+'.tsx');}catch(e){if(e.code!=='ENOENT')throw e;return load(target+'.ts');}}return load(target);}
   return require(name);
 };
 new Function('exports','require',...Object.keys(globals),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,deps,...Object.values(globals));return out;
 };
}
const label=n=>n.children.map(c=>typeof c==='string'?c:label(c)).join('');
const flush=async()=>{await act(async()=>{for(let i=0;i<14;i++)await new Promise(resolve=>setImmediate(resolve));});};
function virtualRoot(renderer){
 const hosts=()=>renderer.root.findAll(n=>typeof n.type==='string');
 const matches=(n,part)=>{
   const attrs=[...part.matchAll(/\[([^=\]]+)(?:="([^"]*)")?\]/g)];
   for(const [,name,value] of attrs){if(!(name in n.props)||(value!==undefined&&String(n.props[name])!==value))return false;}
   const classes=[...part.matchAll(/\.([\w-]+)/g)].map(x=>x[1]);if(classes.some(c=>!String(n.props.className??'').split(' ').includes(c)))return false;
   const tag=part.match(/^[a-z]+/i)?.[0];if(tag&&n.type!==tag)return false;
   const nth=part.match(/:nth-of-type\((\d+)\)/);if(nth){const siblings=n.parent?.children.filter(c=>typeof c!=='string'&&c.type===n.type)??[];if(siblings.indexOf(n)+1!==Number(nth[1]))return false;}
   return true;
 };
 const selectorMatches=(n,selector)=>{
   const parts=selector.trim().split(/\s+(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/);let current=n;if(!matches(current,parts.pop()))return false;
   while(parts.length){const part=parts.pop();current=current.parent;while(current&&!matches(current,part))current=current.parent;if(!current)return false;}return true;
 };
 const wrap=n=>({node:n,get textContent(){return label(n);},getClientRects:()=>[{}],getAttribute:key=>n.props[key]??null,querySelector:s=>query(n,s)[0]??null,querySelectorAll:s=>query(n,s),closest:s=>{let p=n.parent;while(p){if(selectorMatches(p,s))return wrap(p);p=p.parent;}return null;}});
 const query=(scope,selector)=>hosts().filter(n=>(!scope||(()=>{let p=n.parent;while(p){if(p===scope)return true;p=p.parent;}return false;})())&&selector.split(',').some(s=>selectorMatches(n,s))).map(wrap);
 return {querySelector:s=>query(null,s)[0]??null,querySelectorAll:s=>query(null,s)};
}

test('management guide starts after approval, resumes its chapter, pauses, completes and can be restarted',async()=>{
 const store=new Map(),storage={getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)};let enabled=false,view;
 const load=loader({}, {'react':React,'react/jsx-runtime':require('react/jsx-runtime')});const mod=load('management-app/src/ManagementGuide.tsx'),steps=load('management-app/src/guideSteps.ts').managementGuideSteps;
 function Harness(){view=mod.useManagementGuide('terminal',enabled,storage);return null;}
 let renderer;await act(async()=>{renderer=create(React.createElement(Harness));});assert.equal(view.open,false);assert.equal(store.size,0);
 enabled=true;await act(async()=>renderer.update(React.createElement(Harness)));assert.equal(view.open,true);
 await act(async()=>view.next());await act(async()=>view.next());await act(async()=>view.pause());assert.equal(view.open,false);
 await act(async()=>renderer.unmount());await act(async()=>{renderer=create(React.createElement(Harness));});assert.equal(view.open,false);
 await act(async()=>view.start(false));assert.equal(view.step,1);assert.equal(view.open,true);
 for(let i=1;i<steps.length;i++)await act(async()=>view.next());assert.equal(view.open,false);
 await act(async()=>renderer.unmount());await act(async()=>{renderer=create(React.createElement(Harness));});assert.equal(view.open,false);
 await act(async()=>view.start(true));assert.equal(view.step,0);assert.equal(view.open,true);await act(async()=>renderer.unmount());
});

test('practice backend changes only its own inventory, settings and terminal records',async()=>{
 const mod=loader()('management-app/src/guidePractice.ts'),a=mod.createGuidePractice(),b=mod.createGuidePractice();
 const e=(await a.api.loadEventTickets('GUIDE-EVENT'))[0];await a.api.saveTicket('GUIDE-EVENT',{...e,valid:false});assert.equal((await b.api.loadEventTickets('GUIDE-EVENT'))[0].valid,true);
 await a.api.approveTerminal('T-GUIDE-RECEPTION');assert.equal((await b.api.loadTerminals())[1].approved,false);
 await a.api.saveAppSettings(a.terminalId,{volume:0});assert.equal((await b.api.loadAppSettings(b.terminalId)).volume,70);
 const reserve=a.api;assert.ok(reserve);const printed=mod.createGuideReserveStore();const packet={eventId:'GUIDE',eventName:'Guide',preparedAt:'now',template:'',css:'',sheetStyle:'',columns:1,tickets:[{id:'r',number:'1',svg:''}],confirmed:[],pending:null};
 await printed.saveReservePackage(packet);let state=await printed.claimReserveBatch('GUIDE',1);await printed.finishReserveBatch('GUIDE',state.pending.id,false);state=await printed.claimReserveBatch('GUIDE',1);assert.deepEqual(state.pending.ids,['r']);await printed.finishReserveBatch('GUIDE',state.pending.id,true);assert.deepEqual((await printed.loadReservePackage('GUIDE')).confirmed,['r']);
});

test('every management guide action can be performed on the real practice screens without live services or persistent storage',async()=>{
 const storage={getItem:()=>assert.fail('practice must not read live storage'),setItem:()=>assert.fail('practice must not write live storage'),removeItem:()=>assert.fail('practice must not remove live storage')};
 const timers=new Map();let seq=0;
 const window={setInterval:fn=>{timers.set(++seq,fn);return seq;},clearInterval:id=>timers.delete(id),setTimeout:()=>++seq,clearTimeout(){},matchMedia:()=>({matches:false}),confirm:()=>true,prompt:()=> '42',print:()=>assert.fail('practice must not print'),open:()=>assert.fail('practice must not open windows')};
 const document={querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>{
   let html='';const qr={set innerHTML(v){}},number={set textContent(v){}};
   const card={querySelector:s=>s==='.ticket-design-qr'?qr:number,get outerHTML(){return html;}};
   return {set innerHTML(v){html=v;},querySelector:()=>card};
 }};
 const live=new Proxy({}, {get:(_target,name)=>()=>assert.fail('live service '+String(name)+' called in practice')});
 const load=loader({window,document,localStorage:storage,navigator:{},crypto:webcrypto,alert(){},FileReader:class{readAsDataURL(){this.result='data:image/png;base64,AA==';this.onload();}}},{'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'./firebaseData':live,'./eventPublisher':live,'./reservePrintLedger':{useReservePrintLedger:(_event,enabled)=>{assert.equal(enabled,false);return {confirmed:[],reserved:[],unsynced:0};}},'./LazyQrCode':{default:()=>React.createElement('svg')}});
 const App=load('management-app/src/App.tsx').default,guide=load('management-app/src/ManagementGuide.tsx'),steps=load('management-app/src/guideSteps.ts').managementGuideSteps;
 let renderer,chapter='';
 try{
  for(const step of steps){
   if(step.chapter==='受付の練習'||step.chapter==='完了')continue;
   if(chapter!==step.chapter){if(renderer)await act(async()=>renderer.unmount());await act(async()=>{renderer=create(React.createElement(App,{practice:true}));});await flush();chapter=step.chapter;}
   if(step.note)continue;
   let target=guide.findGuideTarget(virtualRoot(renderer),step.target);assert.ok(target,step.chapter+': '+step.title+' target not found');const n=target.node;
   if(step.event==='input'){
    let value=n.props.type==='checkbox'?!n.props.checked:n.props.type==='number'?'25':n.props.type==='date'?'2099-11-02':n.type==='select'?'exited':'練習';
    if(step.target.label==='通常分の枚数')value='3';if(step.target.label==='予備分の枚数')value='2';if(step.target.label==='予備の印刷枚数')value='1';if(step.target.selector==='.ticket-search-box input')value='1';
    await act(async()=>n.props.onChange({target:{value,checked:value,files:[{name:'練習.png',type:'image/png',size:30}]}}));
   }else if(n.props.onClick){await act(async()=>{await n.props.onClick({currentTarget:null});});}
   else if(n.props.onPointerDown){await act(async()=>n.props.onPointerDown({clientX:10,currentTarget:{getBoundingClientRect:()=>({left:0,width:600})}}));}
   else assert.fail(step.title+' has no handler');
   await flush();
   if(step.after)assert.ok(virtualRoot(renderer).querySelector(step.after),step.title+' did not produce '+step.after);
  }
 }finally{if(renderer)await act(async()=>renderer.unmount());}
});

test('reception practice covers duplicate entry, exit and reentry without increasing first visitors twice',async()=>{
 const Practice=loader({}, {'react':React,'react/jsx-runtime':require('react/jsx-runtime')})('management-app/src/GuideReceptionPractice.tsx').default;
 let renderer;await act(async()=>{renderer=create(React.createElement(Practice));});
 const click=async text=>{const n=renderer.root.findAllByType('button').find(n=>label(n)===text);assert.ok(n,text);await act(async()=>n.props.onClick());};
 try{
  await click('受付を開始する');await click('練習QRを読み取る');assert.match(JSON.stringify(renderer.toJSON()),/入場を受け付け/);
  await click('練習QRを読み取る');assert.match(JSON.stringify(renderer.toJSON()),/入場済み/);
  await click('出口受付へ切り替え');await click('練習QRを読み取る');assert.match(JSON.stringify(renderer.toJSON()),/退場を受け付け/);
  await click('入口受付へ切り替え');await click('練習QRを読み取る');assert.match(JSON.stringify(renderer.toJSON()),/再入場/);
  const text=label(renderer.root);assert.match(text,/初回来場者 1人/);await click('受付を停止する');assert.match(label(renderer.root),/受付を停止しました/);
 }finally{await act(async()=>renderer.unmount());}
});

test('reception guide waits for registration approval and can be reopened after completion',async()=>{
 const values=new Map();const storage={getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};
 const mod=loader({localStorage:storage},{'react':React,'react/jsx-runtime':require('react/jsx-runtime')})('reception-app/src/ReceptionGuide.tsx');
 let approved=false,view,renderer;function Harness(){view=mod.useReceptionGuide('receipt',approved);return null;}
 await act(async()=>{renderer=create(React.createElement(Harness));});assert.equal(view.open,false);assert.equal(values.size,0);
 approved=true;await act(async()=>renderer.update(React.createElement(Harness)));assert.equal(view.open,true);
 for(let i=0;i<mod.receptionGuideSteps.length;i++)await act(async()=>view.next());assert.equal(view.open,false);
 await act(async()=>renderer.unmount());await act(async()=>{renderer=create(React.createElement(Harness));});assert.equal(view.open,false);
 await act(async()=>view.start());assert.equal(view.open,true);assert.equal(view.step,0);await act(async()=>view.pause());assert.equal(view.open,false);await act(async()=>renderer.unmount());
});

test('the bundled practice image has valid PNG chunks and can be decoded',async()=>{
 const {inflateSync}=await import('node:zlib');
 const encoded=readFileSync('management-app/src/ManagementGuide.tsx','utf8').match(/atob\('([^']+)'\)/)[1],bytes=Buffer.from(encoded,'base64');
 const crc=data=>{let n=0xffffffff;for(const b of data){n^=b;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
 assert.equal(bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');let offset=8,data=[];
 while(offset<bytes.length){const length=bytes.readUInt32BE(offset),type=bytes.subarray(offset+4,offset+8).toString();assert.equal(crc(bytes.subarray(offset+4,offset+8+length)),bytes.readUInt32BE(offset+8+length),type);if(type==='IDAT')data.push(bytes.subarray(offset+8,offset+8+length));offset+=length+12;}
 assert.equal(inflateSync(Buffer.concat(data)).length,32*(1+32*4));
});
