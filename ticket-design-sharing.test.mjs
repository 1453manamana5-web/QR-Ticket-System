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
  new Function('exports','require',...Object.keys(values),compile(source))(exports,name=>name==='react'?React:name==='react/jsx-runtime'?require(name):name==='./reservePrintStore'?store:name==='./reservePrintLedger'?{useReservePrintLedger:()=>({unsynced:0})}:{},...Object.values(values));
  return exports;
}

function designerModule(storage,{globals={},onReserve=()=>{}}={}){
  const exports={};
  const values={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},window:{confirm:()=>true},alert(){},...globals};
  new Function('exports','require',...Object.keys(values),compile(readFileSync('management-app/src/TicketDesigner.tsx','utf8')))(exports,name=>name==='react'?React:name==='react/jsx-runtime'||name==='qrcode.react'||name==='react-dom/server'?require(name):name==='./reservePrintStore'?{loadReservePackage:async()=>null}:name==='./ReservePrinting'?{ReserveConfiguration:props=>{onReserve(props);return null;}}:name==='./LazyQrCode'?{default:()=>React.createElement('span',{'data-lazy-qr':true})}:{},...Object.values(values));
  return exports;
}

test('shared save hydrates a fresh second device including number size and images',async()=>{
 const first=new Map([['qr-management-ticket-design-id-shared',JSON.stringify({title:'Shared',numberSize:48,textReferenceWidth:400,backgroundImage:'data:image/png;base64,AA=='})]]);let remote;
 let a,b;const mod=designerModule(first);await act(async()=>{a=create(React.createElement(mod.default,{eventId:'shared',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},saveSharedDesign:async value=>{remote=value;}}));});
 await act(async()=>button(a,'保存').props.onClick());await act(async()=>a.unmount());assert.equal(JSON.parse(remote).numberSize,48);
 const second=new Map(),mod2=designerModule(second);await act(async()=>{b=create(React.createElement(mod2.default,{eventId:'shared',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},loadSharedDesign:async()=>remote}));});
 assert.equal(JSON.parse(second.get('qr-management-ticket-design-id-shared')).backgroundImage,'data:image/png;base64,AA==');
 assert.ok(JSON.stringify(b.toJSON()).includes('Shared'));await act(async()=>b.unmount());
});
test('a late cloud load preserves a locally edited draft',async()=>{
 const storage=new Map([['qr-management-ticket-design-id-draft',JSON.stringify({title:'Local'})]]),wait=deferred(),mod=designerModule(storage);let r;
 await act(async()=>{r=create(React.createElement(mod.default,{eventId:'draft',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},loadSharedDesign:()=>wait.promise}));});
 assert.equal(button(r,'印刷').props.disabled,true,'do not print a stale local design while the shared design is loading');
 await act(async()=>button(r,'T文字').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'Draft'}}));
 await act(async()=>wait.resolve(JSON.stringify({title:'Old remote'})));assert.ok(JSON.stringify(r.toJSON()).includes('Draft'));assert.ok(!JSON.stringify(r.toJSON()).includes('Old remote'));assert.equal(button(r,'印刷').props.disabled,false);await act(async()=>r.unmount());
});
test('failed cloud save never claims the design is shared',async()=>{
 const mod=designerModule(new Map([['qr-management-ticket-design-id-fail',JSON.stringify({title:'E'})]]));let r;
 await act(async()=>{r=create(React.createElement(mod.default,{eventId:'fail',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},saveSharedDesign:async()=>{throw Error('offline');}}));});
 await act(async()=>button(r,'保存').props.onClick());assert.ok(JSON.stringify(r.toJSON()).includes('共有保存できませんでした'));assert.equal(r.root.findByProps({className:'studio-save-state'}).children.join(''),'編集中');await act(async()=>r.unmount());
});
test('printing selects the live editor sheet and carries the current number size to the popup',async()=>{
 const storage=new Map([['qr-management-ticket-design-id-print',JSON.stringify({title:'E',numberSize:20,textReferenceWidth:400,printWidthMm:100})]]);let r,printed;
 const sheet={cloneNode(){return {style:{},font:r.root.findAllByProps({className:'ticket-print-card'})[0].findByProps({className:'ticket-design-number'}).props.style.fontSize};}};
 const doc={open(){},write(){},close(){},readyState:'complete',body:{appendChild:node=>{printed=node;}}};
 const mod=designerModule(storage,{globals:{document:{querySelector:()=>{throw Error('wrong stale global sheet');}},window:{confirm:()=>true,open:()=>({document:doc,closed:false,focus(){},print(){},addEventListener(){}}),setTimeout:fn=>fn()}}});
 await act(async()=>{r=create(React.createElement(mod.default,{eventId:'print',eventName:'E',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){}}),{createNodeMock:n=>n.props.className==='ticket-print-sheet'?sheet:null});});
 await act(async()=>button(r,'＃番号').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'選択パーツのサイズ'}).props.onChange({target:{value:'48'}}));await act(async()=>button(r,'印刷').props.onClick());assert.equal(printed.font,'12mm');await act(async()=>r.unmount());
});

test('reserve printing refreshes its template from the current design and preserves a pending batch',async()=>{
 let current={...packet(),confirmed:['T501']},builds=0;
 const store={loadReservePackage:async()=>current,saveReservePackage:async value=>{current=value;return value;}};
 const mod=reserveModule({store});let r;
 await act(async()=>{r=create(React.createElement(mod.ReserveConfiguration,{eventId:'event-a',tickets:ticketList,build:async ids=>{builds++;assert.deepEqual(ids,['T502','T503']);return {...packet(),tickets:packet().tickets.filter(t=>ids.includes(t.id)),template:'font-size:12mm'};},onSaved(){},practice:true,store}));});
 const refresh=()=>r.root.findByType(mod.ReservePrintControls).props.beforePrint();
 await act(async()=>refresh());assert.equal(current.template,'font-size:12mm');assert.equal(builds,1);assert.deepEqual(current.tickets.map(t=>t.id),['T501','T502','T503'],'keep printed ticket records when refreshing only remaining tickets');
 current={...current,pending:{id:'already-printing',ids:['T501']}};
 await act(async()=>refresh());assert.equal(builds,1,'an already pending batch keeps its original print template');await act(async()=>r.unmount());
});


test('saving updates an already open second editor and QR preview without reopening',async()=>{
 let value=JSON.stringify({title:'Before',numberSize:20,textReferenceWidth:400});const listeners=new Set();
 const subscribe=(next)=>{listeners.add(next);next(value);return()=>listeners.delete(next);};
 const save=async next=>{value=next;for(const listener of listeners)listener(next);};
 const first=new Map(),second=new Map(),mod1=designerModule(first),mod2=designerModule(second);let a,b,qr;
 const props={eventId:'live',eventName:'E',tickets:ticketList.map(t=>({...t,reserve:false})),qrValue:t=>t.id,onClose(){},subscribeSharedDesign:subscribe,saveSharedDesign:save};
 await act(async()=>{a=create(React.createElement(mod1.default,props));b=create(React.createElement(mod2.default,props));qr=create(React.createElement(mod2.TicketQrPreview,{eventId:'live',eventName:'E',ticketNumber:'501',qrValue:'T501',subscribeSharedDesign:subscribe}));});
 await act(async()=>button(a,'T文字').props.onClick());await act(async()=>a.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'After save'}}));
 await act(async()=>button(a,'＃番号').props.onClick());await act(async()=>a.root.findByProps({'aria-label':'選択パーツのサイズ'}).props.onChange({target:{value:'48'}}));
 await act(async()=>button(a,'保存').props.onClick());
 assert.ok(JSON.stringify(b.toJSON()).includes('After save'));assert.ok(JSON.stringify(qr.toJSON()).includes('After save'));
 assert.equal(JSON.parse(second.get('qr-management-ticket-design-id-live')).numberSize,48);
 assert.equal(b.root.findAllByProps({className:'ticket-print-card'})[0].findByProps({className:'ticket-design-number'}).props.style.fontSize,'10.8mm');
 await act(async()=>{a.unmount();b.unmount();qr.unmount();});assert.equal(listeners.size,0);
});
test('a subscribed remote save preserves an unsaved draft and offers the shared revision',async()=>{
 let notify;const mod=designerModule(new Map());let r;
 await act(async()=>{r=create(React.createElement(mod.default,{eventId:'conflict',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},subscribeSharedDesign:next=>{notify=next;next(JSON.stringify({title:'Before'}));return()=>{};}}));});
 await act(async()=>button(r,'T文字').props.onClick());await act(async()=>r.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'Unsaved draft'}}));
 await act(async()=>notify(JSON.stringify({title:'Remote revision',numberSize:48,textReferenceWidth:400})));
 assert.ok(JSON.stringify(r.toJSON()).includes('Unsaved draft'));await act(async()=>button(r,'他端末の保存内容を読み込む').props.onClick());
 assert.ok(JSON.stringify(r.toJSON()).includes('Remote revision'));assert.ok(!JSON.stringify(r.toJSON()).includes('Unsaved draft'));
 await act(async()=>r.unmount());
});

test('a delayed echo of this device own save does not flag its next draft as a remote conflict',async()=>{
 let notify,saved;const mod=designerModule(new Map());let r;
 await act(async()=>{r=create(React.createElement(mod.default,{eventId:'echo',eventName:'E',tickets:ticketList,qrValue:t=>t.id,onClose(){},subscribeSharedDesign:next=>{notify=next;next(JSON.stringify({title:'Before'}));return()=>{};},saveSharedDesign:async value=>{saved=value;}}));});
 await act(async()=>button(r,'T文字').props.onClick());await act(async()=>r.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'Saved title'}}));await act(async()=>button(r,'保存').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'イベント名の文字'}).props.onChange({target:{value:'Next draft'}}));await act(async()=>notify(saved));
 assert.ok(JSON.stringify(r.toJSON()).includes('Next draft'));assert.equal(r.root.findAllByType('button').filter(node=>label(node)==='他端末の保存内容を読み込む').length,0);await act(async()=>r.unmount());
});
