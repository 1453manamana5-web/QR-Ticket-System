import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {test} from 'node:test';
import React from 'react';
import {act,create} from 'react-test-renderer';

const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function load(file,dependencies={},globals={}){
  const source=readFileSync(new URL(file,import.meta.url),'utf8').replaceAll('import.meta.env.BASE_URL','"/QR-Ticket-System/"');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const exports={};
  new Function('exports','require',...Object.keys(globals),compiled)(exports,name=>{
    if(name in dependencies)return dependencies[name];
    if(name==='./receptionState')return load('./reception-app/src/receptionState.ts');
    if(name==='../../shared/src/receptionTiming')return load('./shared/src/receptionTiming.ts');
    if(name==='../../shared/src/offlineTransfer')return load('./shared/src/offlineTransfer.ts',{}, {crypto:webcrypto});
    if(name==='react'||name==='react/jsx-runtime')return require(name);
    throw Error('Unexpected dependency: '+name);
  },...Object.values(globals));
  return exports;
}

test('an offline QR for a different approved event cannot overwrite an empty local inventory',async()=>{
  const other={event:{...makeEvent().event,eventId:'event-two'},settings:makeEvent().settings,tickets:[{...makeTicket(),eventId:'event-two'}]};
  const h=await harness({offlineAdd:async()=>other});
  try{
    await h.click('イベントQRを読み直す');h.clearStored();h.navigator.onLine=false;
    const scan=await h.beginScan(JSON.stringify({type:'qr-ticket-offline-v1'}));await act(async()=>scan.operation);await h.flush();
    await h.click('このイベントで認証');
    assert.equal(h.stored(),null,'event approval must be checked before durable installation');
    assert.match(h.text(),/受付承認|別イベント/);
  }finally{await h.close();}
});

test('a management stop is reapplied after revocation and reapproval of the same terminal',async()=>{
  const h=await harness();
  try{
    await h.control('停止');
    await h.registration(null);await h.registration(approved);
    await h.control('停止');
    await h.click('受付を開始する');
    assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);
  }finally{await h.close();}
});

test('permission denial during manual communication removes cached approval immediately',async()=>{
  const h=await harness({automaticDownload:async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'});}});
  try{
    await h.click('イベントQRを読み直す');await h.click('戻る');await h.click('通信でイベントデータを受信');
    assert.equal(h.storage.has('qr-ticket-reception-approved'),false);
    assert.match(h.text(),/受付端末を登録/);
  }finally{await h.close();}
});

const makeEvent=()=>({
  event:{eventId:'event-one',eventName:'Reception UI audit',eventDate:'2026-10-27',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1},
  settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
  terminalId:'T-UI-AUDIT',authenticatedAt:'2026-10-27T00:00:00.000Z',dataReady:true,ticketCount:1,
});
const makeTicket=()=>({ticketId:'ticket-one',eventId:'event-one',basicInfo:{},valid:true,currentStatus:'unused',updatedAt:'2026-10-27T00:00:00.000Z'});
const approved={approved:true,status:'online',name:'Audit terminal',eventId:'event-one'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

async function harness({localTicket=makeTicket(),latestTicket=async()=>makeTicket(),saveReception=async()=>'saved',initialRegistration=approved,initialFailure,cacheApproval=false,event=makeEvent(),offlineAdd,loadValidation,metadataRead,download,syncError,syncRecords,heartbeat,knownUid,cacheAuthUid,saved=true,automaticDownload,tokenRead}={}){
  let stored=saved?structuredClone(event):null,metadata=structuredClone(event.event),currentRegistration=initialRegistration,registrationCallback,registrationError,controlCallback,renderer;
  const audio=[],writes=[],errors=[],syncedErrors=new Set(),heartbeats=[],listeners=new Map(),intervals=new Map(),timeouts=new Map(),storage=new Map([['qr-ticket-terminal-id','T-UI-AUDIT']]);
  if(cacheApproval)storage.set('qr-ticket-reception-approved',JSON.stringify({...approved,terminalId:'T-UI-AUDIT',...(cacheAuthUid===undefined?{}:{authUid:cacheAuthUid})}));
  let id=0;
  const navigator={onLine:true};
  const window={
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    setInterval:(fn)=>{intervals.set(++id,fn);return id;},clearInterval:key=>intervals.delete(key),
    setTimeout:(fn)=>{timeouts.set(++id,fn);return id;},clearTimeout:key=>timeouts.delete(key),
  };
  const local={
    loadLocalEvent:async validate=>{if(validate&&loadValidation)await loadValidation();return structuredClone(stored);},
    saveLocalEvent:async data=>{stored=structuredClone(data);},
    prepareLocalEventData:async data=>{stored={...structuredClone(data),dataReady:true};},
    clearLocalEvent:async()=>{stored=null;},
    getTicket:async()=>localTicket,getReceptionRecord:async()=>null,getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>errors.filter(error=>!syncedErrors.has(error.errorId)),
    saveReceptionTransaction:async(...args)=>{writes.push(args);return saveReception(...args);},
    saveReceptionErrorLog:async error=>errors.push(error),markReceptionErrorLogSynced:async id=>syncedErrors.add(id),
  };
  function Scanner(){return null;}
  const auth=()=>({type:'qr-ticket-event-auth',eventId:metadata.eventId,eventName:metadata.eventName,dataVersion:metadata.dataVersion,authToken:'token',event:metadata});
  const App=load('./reception-app/src/App.tsx',{
    ...(offlineAdd?{'../../shared/src/offlineTransfer':{OfflineEventCollector:class{progress={received:0,total:0};add=offlineAdd;reset(){}}}}:{}),
    './QrScanner':{default:Scanner},
    './ReceptionGuide':{default:()=>null,receptionGuideTopics:[],useReceptionGuide:()=>({open:false,start(){}})},
    './receptionAudio':{prepareReceptionAudio:()=>()=>{},playReceptionAudio:async kind=>{audio.push(kind);return 'played';},stopReceptionGuidance(){},enableReceptionVoice:()=>true,getReceptionAudioSettings:()=>({volume:1,voiceGuidance:true,successSound:true})},
    './localDb':local,'./syncQueue':{syncPendingReceptionRecords:syncRecords??(async()=>{})},
    './eventDownloader':{getCurrentFirebaseEventAuthPayload:async()=>metadataRead?metadataRead(auth()):auth(),downloadCurrentFirebaseEventData:async()=>automaticDownload?automaticDownload():({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}],authPayload:auth()}),downloadEventData:async()=>download?download({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}]}):({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}]}),getEventAuthPayloadByToken:async()=>tokenRead?tokenRead():auth()},
    './receptionSync':{
      getTerminalRegistration:async()=>currentRegistration,getKnownFirebaseUid:()=>knownUid,
      subscribeTerminalRegistration:(change,error)=>{registrationCallback=change;registrationError=error;if(initialFailure)error({code:initialFailure});else change(initialRegistration);return()=>{};},
      subscribeTerminalControl:(_terminal,callback)=>{controlCallback=callback;return()=>{};},
      saveTerminalHeartbeat:async(...args)=>{heartbeats.push(args);return heartbeat?heartbeat(...args):null;},getLatestReceptionTicket:latestTicket,syncReceptionErrorLog:syncError??(async()=>{}),registerReceptionTerminal:async()=>{},resetReceptionTerminalRegistration:async()=>null,
    },
  },{navigator,window,crypto:webcrypto,localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},console:{error(){},warn(){},info(){}}}).default;
  await act(async()=>{renderer=create(React.createElement(App));});
  const flush=async()=>{await act(async()=>{for(let i=0;i<8;i++)await nextTurn();});};
  await flush();
  const label=node=>node.children.map(child=>typeof child==='string'?child:label(child)).join('');
  const click=async text=>{
    const button=renderer.root.findAllByType('button').find(node=>label(node)===text);
    assert.ok(button,'Missing button: '+text);
    await act(async()=>{button.props.onClick();});await flush();
  };
  return {renderer,Scanner,flush,click,audio,writes,errors,navigator,heartbeats,storage,
    text:()=>JSON.stringify(renderer.toJSON()),stored:()=>stored,
    clearStored:()=>{stored=null;},setMetadata:value=>{metadata=value;},setSettings:value=>{stored.settings=value;event.settings=value;},
    signal:async name=>{await act(async()=>{for(const fn of [...(listeners.get(name)??[])])fn();});await flush();},
    beginScan:async value=>{let operation;await act(async()=>{operation=renderer.root.findByType(Scanner).props.onResult(value);});await flush();return {operation};},
    registration:async value=>{currentRegistration=value;await act(async()=>registrationCallback(value));await flush();},
    registrationFailure:async code=>{await act(async()=>registrationError({code}));await flush();},
    control:async mode=>{await act(async()=>controlCallback(mode,'2099-01-01T00:00:00.000Z'));await flush();},
    poll:async()=>{await act(async()=>{for(const fn of [...intervals.values()])await fn();});await flush();},
    close:async()=>{await act(async()=>renderer.unmount());},
  };
}


test('a matching accepted local state cannot be reclassified as unused by a stale later timetable',async()=>{
 const used={...makeTicket(),currentStatus:'inside',updatedAt:'2026-10-27T00:30:00.000Z'};
 const event=makeEvent();event.event.startTime='10:00';
 const h=await harness({event,localTicket:used,latestTicket:async()=>used});
 try{await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();assert.equal(h.writes.length,0);assert.match(h.text(),/すでに入場/);}finally{await h.close();}
});

test('permission denial during code lookup revokes cached approval',async()=>{
 const h=await harness({tokenRead:async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'});}});
 try{await h.click('イベントQRを読み直す');await h.click('戻る');await h.click('コードで連携する');
 await act(async()=>h.renderer.root.findByProps({placeholder:'管理アプリに表示されたコード'}).props.onChange({target:{value:'token'}}));await h.click('コードで連携');
 assert.equal(h.storage.has('qr-ticket-reception-approved'),false);assert.match(h.text(),/受付端末を登録/);}finally{await h.close();}
});
test('permission denial during confirmation revokes cached approval',async()=>{
 const h=await harness({download:async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'});}});
 try{await h.click('イベントQRを読み直す');const scan=await h.beginScan(JSON.stringify({type:'qr-ticket-event-auth',eventId:'event-one',eventName:'Reception UI audit',dataVersion:1,authToken:'token'}));await act(async()=>scan.operation);await h.click('このイベントで認証');
 assert.equal(h.storage.has('qr-ticket-reception-approved'),false);assert.match(h.text(),/受付端末を登録/);}finally{await h.close();}
});

for(const qr of ['ticket-one/other/document','X'.repeat(161),JSON.stringify({type:'qr-ticket',ticketId:'ticket-one/other/document',eventId:'event-one'}),JSON.stringify({type:'qr-ticket',ticketId:'ticket-one',eventId:null})])test('malformed ticket QR is rejected without a server read or losing approval: '+qr.slice(0,65),async()=>{
 let reads=0;
 const h=await harness({latestTicket:async(_event,id)=>{reads++;if(id.includes('/'))throw Object.assign(Error('denied deep path'),{code:'permission-denied'});return makeTicket();}});
 try{
  await h.click('受付を開始する');const scan=await h.beginScan(qr);await act(async()=>scan.operation);await h.flush();
  assert.equal(reads,0);assert.equal(h.writes.length,0);assert.equal(h.storage.has('qr-ticket-reception-approved'),true);
  assert.doesNotMatch(h.text(),/受付端末を登録/);assert.match(h.text(),/QRコードを確認できません/);
  const valid=await h.beginScan('ticket-one');await act(async()=>valid.operation);await h.flush();
  assert.equal(h.writes.length,1,'the next valid legacy ticket remains usable');
 }finally{await h.close();}
});

test('an obsolete scan finalizer cannot unlock a newer event preparation',async()=>{
 const old=deferred(),download=deferred();
 const h=await harness({latestTicket:()=>old.promise,download:()=>download.promise});
 try{
  await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
  await h.registration(null);await h.registration(approved);
  await h.click('イベントQRを読み直す');const auth=await h.beginScan(JSON.stringify({type:'qr-ticket-event-auth',eventId:'event-one',eventName:'Reception UI audit',dataVersion:1,authToken:'token'}));await act(async()=>auth.operation);
  await h.click('このイベントで認証');
  assert.equal(h.renderer.root.findAllByType('button').find(n=>n.children.join('')==='イベントデータを準備中…').props.disabled,true);
  await act(async()=>{old.resolve(makeTicket());await scan.operation;});await h.flush();
  const pending=h.renderer.root.findAllByType('button').find(n=>n.children.join('')==='イベントデータを準備中…');
  assert.ok(pending,'new preparation must still be shown as busy');assert.equal(pending.props.disabled,true);
  await act(async()=>download.resolve({localEvent:makeEvent(),tickets:[makeTicket()]}));await h.flush();assert.match(h.text(),/受付準備完了/);
 }finally{old.resolve(makeTicket());download.resolve({localEvent:makeEvent(),tickets:[makeTicket()]});await h.flush();await h.close();}
});

test('a remote mode queued after reapproval survives completion of the obsolete scan',async()=>{
 const old=deferred();let reads=0;
 const h=await harness({latestTicket:()=>++reads===1?old.promise:Promise.resolve({...makeTicket(),currentStatus:'inside'})});
 try{
  await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
  await h.registration(null);await h.registration(approved);await h.control('出口受付');
  await act(async()=>{old.resolve(makeTicket());await scan.operation;});await h.flush();
  await h.click('受付を開始する');
  assert.ok(h.renderer.root.findByProps({'aria-label':'出口受付。左右にスワイプして入口受付へ切り替え'}));
  const next=await h.beginScan('ticket-one');await act(async()=>next.operation);await h.flush();
  assert.equal(h.writes.length,1);assert.equal(h.writes[0][1].type,'exit');
 }finally{old.resolve(makeTicket());await h.flush();await h.close();}
});

test('a management stop wins over a future manual clock and permits a later remote restart',async()=>{
 const h=await harness({latestTicket:async()=>({...makeTicket(),currentStatus:'inside'})});
 try{
  h.storage.set('qr-ticket-terminal-mode-changed:T-UI-AUDIT','2999-01-01T00:00:00.000Z');
  await h.click('受付を開始する');await h.control('停止');
  assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);assert.match(h.text(),/受付停止中/);
  await h.control('出口受付');assert.equal(h.renderer.root.findAllByType(h.Scanner).length,1);
  assert.ok(h.renderer.root.findByProps({'aria-label':'出口受付。左右にスワイプして入口受付へ切り替え'}));
  const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();
  assert.equal(h.writes[0][1].type,'exit');
 }finally{await h.close();}
});

test('rapid duplicate authentication clicks keep the owning preparation busy and perform one download',async()=>{
 const pending=deferred();let downloads=0;
 const h=await harness({download:()=>{downloads++;return pending.promise;}});
 try{
  await h.click('イベントQRを読み直す');const auth=await h.beginScan(JSON.stringify({type:'qr-ticket-event-auth',eventId:'event-one',eventName:'Reception UI audit',dataVersion:1,authToken:'token'}));await act(async()=>auth.operation);
  const start=h.renderer.root.findAllByType('button').find(n=>n.children.join('')==='このイベントで認証').props.onClick;
  await act(async()=>{start();start();});await h.flush();
  assert.equal(downloads,1);
  const busy=h.renderer.root.findAllByType('button').find(n=>n.children.join('')==='イベントデータを準備中…');
  assert.ok(busy);assert.equal(busy.props.disabled,true);
  await act(async()=>pending.resolve({localEvent:makeEvent(),tickets:[makeTicket()]}));await h.flush();assert.match(h.text(),/受付準備完了/);
 }finally{pending.resolve({localEvent:makeEvent(),tickets:[makeTicket()]});await h.flush();await h.close();}
});
