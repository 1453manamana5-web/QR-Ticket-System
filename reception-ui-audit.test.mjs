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
const makeEvent=()=>({
  event:{eventId:'event-one',eventName:'Reception UI audit',eventDate:'2026-10-27',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1},
  settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
  terminalId:'T-UI-AUDIT',authenticatedAt:'2026-10-27T00:00:00.000Z',dataReady:true,ticketCount:1,
});
const makeTicket=()=>({ticketId:'ticket-one',eventId:'event-one',basicInfo:{},valid:true,currentStatus:'unused',updatedAt:'2026-10-27T00:00:00.000Z'});
const approved={approved:true,status:'online',name:'Audit terminal',eventId:'event-one'};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

async function harness({latestTicket=async()=>makeTicket(),saveReception=async()=>'saved',initialRegistration=approved,initialFailure,cacheApproval=false,event=makeEvent(),offlineAdd}={}){
  let stored=structuredClone(event),metadata=structuredClone(event.event),currentRegistration=initialRegistration,registrationCallback,registrationError,controlCallback,renderer;
  const audio=[],writes=[],errors=[],intervals=new Map(),timeouts=new Map(),storage=new Map([['qr-ticket-terminal-id','T-UI-AUDIT']]);
  if(cacheApproval)storage.set('qr-ticket-reception-approved',JSON.stringify({...approved,terminalId:'T-UI-AUDIT'}));
  let id=0;
  const navigator={onLine:true};
  const window={
    addEventListener(){},removeEventListener(){},
    setInterval:(fn)=>{intervals.set(++id,fn);return id;},clearInterval:key=>intervals.delete(key),
    setTimeout:(fn)=>{timeouts.set(++id,fn);return id;},clearTimeout:key=>timeouts.delete(key),
  };
  const local={
    getLocalPreparationToken:async()=>"test-preparation",
    loadLocalEvent:async()=>structuredClone(stored),
    saveLocalEvent:async data=>{stored=structuredClone(data);},
    prepareLocalEventData:async data=>{stored={...structuredClone(data),dataReady:true};},
    clearLocalEvent:async()=>{stored=null;},
    getTicket:async()=>makeTicket(),getReceptionRecord:async()=>null,getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>[],
    saveReceptionTransaction:async(...args)=>{writes.push(args);return saveReception(...args);},
    saveReceptionErrorLog:async error=>errors.push(error),markReceptionErrorLogSynced:async()=>{},
  };
  function Scanner(){return null;}
  const auth=()=>({type:'qr-ticket-event-auth',eventId:metadata.eventId,eventName:metadata.eventName,dataVersion:metadata.dataVersion,authToken:'token',event:metadata});
  const App=load('./reception-app/src/App.tsx',{
    ...(offlineAdd?{'../../shared/src/offlineTransfer':{OfflineEventCollector:class{progress={received:0,total:0};add=offlineAdd;reset(){}}}}:{}),
    './QrScanner':{default:Scanner},
    './ReceptionGuide':{default:()=>null,receptionGuideTopics:[],useReceptionGuide:()=>({open:false,start(){}})},
    './receptionAudio':{prepareReceptionAudio:()=>()=>{},playReceptionAudio:async kind=>{audio.push(kind);return 'played';},stopReceptionGuidance(){},enableReceptionVoice:()=>true,getReceptionAudioSettings:()=>({volume:1,voiceGuidance:true,successSound:true})},
    './localDb':local,'./syncQueue':{syncPendingReceptionRecords:async()=>{}},
    './eventDownloader':{getCurrentFirebaseEventAuthPayload:async()=>auth(),downloadCurrentFirebaseEventData:async()=>({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}],authPayload:auth()}),downloadEventData:async()=>({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}]}),getEventAuthPayloadByToken:async()=>auth()},
    './receptionSync':{
      getTerminalRegistration:async()=>currentRegistration,
      subscribeTerminalRegistration:(change,error)=>{registrationCallback=change;registrationError=error;if(initialFailure)error({code:initialFailure});else change(initialRegistration);return()=>{};},
      subscribeTerminalControl:(_terminal,callback)=>{controlCallback=callback;return()=>{};},
      saveTerminalHeartbeat:async()=>null,getLatestReceptionTicket:latestTicket,syncReceptionErrorLog:async()=>{},registerReceptionTerminal:async()=>{},resetReceptionTerminalRegistration:async()=>null,
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
  return {renderer,Scanner,flush,click,audio,writes,errors,navigator,
    text:()=>JSON.stringify(renderer.toJSON()),stored:()=>stored,
    setMetadata:value=>{metadata=value;},
    beginScan:async value=>{let operation;await act(async()=>{operation=renderer.root.findByType(Scanner).props.onResult(value);});await flush();return {operation};},
    registration:async value=>{currentRegistration=value;await act(async()=>registrationCallback(value));await flush();},
    registrationFailure:async code=>{await act(async()=>registrationError({code}));await flush();},
    control:async mode=>{await act(async()=>controlCallback(mode,'2099-01-01T00:00:00.000Z'));await flush();},
    poll:async()=>{await act(async()=>{for(const fn of [...intervals.values()])await fn();});await flush();},
    close:async()=>{await act(async()=>renderer.unmount());},
  };
}

test('a scan begun before revocation cannot commit after the same terminal is reapproved',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    await h.registrationFailure('permission-denied');await h.registration(approved);await h.click('受付を開始する');
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);assert.equal(h.audio.includes('entrySuccess'),false);
  }finally{await h.close();}
});

for(const succeeds of [true,false])test(`remote stop keeps control of the screen when a pending local save ${succeeds?'succeeds':'fails'}`,async()=>{
  const saved=deferred(),h=await harness({saveReception:()=>saved.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');assert.equal(h.writes.length,1);
    await h.control('停止');
    await act(async()=>{if(succeeds)saved.resolve('saved');else saved.reject(Error('storage failure'));await scan.operation;});await h.flush();
    assert.match(h.text(),/受付が停止されています/);assert.equal(h.audio.includes('entrySuccess'),false);assert.equal(h.errors.length,0);
  }finally{await h.close();}
});

test('same-version polling refreshes the event schedule while reception stays open',async()=>{
  const h=await harness();
  try{
    await h.click('受付を開始する');h.setMetadata({...makeEvent().event,eventDate:'2099-10-27',startTime:'10:30'});await h.poll();
    assert.equal(h.stored().event.eventDate,'2099-10-27');assert.equal(h.renderer.root.findAllByType(h.Scanner).length,1);
    const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();
    assert.equal(h.writes.length,0);assert.match(h.text(),/試験チケット/);assert.doesNotMatch(h.text(),/入場OK/);
  }finally{await h.close();}
});

test('a changed approval event starts a fresh polling lifecycle even when approval remains true',async()=>{
  const h=await harness();
  try{
    h.setMetadata({...makeEvent().event,eventId:'event-two',eventName:'Next event'});
    await h.registration({...approved,eventId:'event-two'});await h.poll();
    assert.match(h.text(),/イベントが切り替わりました/);
    await h.click('通信でイベントデータを受信');
    assert.match(h.text(),/受付準備完了/);assert.equal(h.stored().event.eventId,'event-two');
  }finally{await h.close();}
});

test('a stop followed by resume cancels the old pending ticket read',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    await h.control('停止');await h.control('入口受付');
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);assert.equal(h.audio.includes('entrySuccess'),false);
  }finally{await h.close();}
});

test('leaving reception to open the guide cancels the pending read even when reception is restarted',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    await h.click('設定');await h.click('使い方ガイドを始める');await h.click('受付を開始する');
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);
  }finally{await h.close();}
});

test('a server ticket consumed by an old pre-opening test is accepted as a fresh production entry',async()=>{
  const h=await harness({latestTicket:async()=>({...makeTicket(),currentStatus:'inside',updatedAt:'2026-10-26T23:59:59.000Z'})});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();
    assert.equal(h.writes.length,1);assert.equal(h.writes[0][1].type,'entry');assert.match(h.text(),/入場を確認しました/);
  }finally{await h.close();}
});

for(const code of ['unavailable','deadline-exceeded','auth/network-request-failed'])test(`cached approval restores the saved event when Wi-Fi is online but ${code}; permission errors revoke it`,async()=>{
  const h=await harness({initialFailure:code,cacheApproval:true});
  try{
    assert.match(h.text(),/受付準備完了/);assert.match(h.text(),/オフライン/);
    await h.registrationFailure('permission-denied');assert.match(h.text(),/受付端末を登録/);assert.doesNotMatch(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test('network errors do not approve an uncached terminal',async()=>{
  const h=await harness({initialFailure:'unavailable'});
  try{assert.match(h.text(),/受付端末を登録/);assert.doesNotMatch(h.text(),/受付準備完了/);}
  finally{await h.close();}
});

test('a schedule change during the server ticket read changes the pending scan into a test ticket',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    h.setMetadata({...makeEvent().event,eventDate:'2099-10-27'});await h.poll();
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);assert.match(h.text(),/試験チケット/);
  }finally{await h.close();}
});

test('an old offline QR verification error cannot overwrite the screen after Back',async()=>{
  const decoded=deferred(),h=await harness({offlineAdd:()=>decoded.promise});
  try{
    await h.click('イベントQRを読み直す');const scan=await h.beginScan(JSON.stringify({type:'qr-ticket-offline-v1'}));
    await h.click('戻る');
    await act(async()=>{decoded.reject(Error('古いオフラインQRのエラー'));await scan.operation;});await h.flush();
    assert.doesNotMatch(h.text(),/古いオフラインQRのエラー/);
  }finally{await h.close();}
});

test('a queued camera decode never invokes its callback after the scanner unmounts',async()=>{
  let decode;const accepted=[];
  class Camera{
    static async getCameras(){return [{id:'front',label:'Front camera'}];}
    async start(_camera,_options,callback){decode=callback;this.isScanning=true;}
    async stop(){this.isScanning=false;}
    clear(){}
    async applyVideoConstraints(){}
  }
  const Scanner=load('./reception-app/src/QrScanner.tsx',{'html5-qrcode':{Html5Qrcode:Camera,Html5QrcodeSupportedFormats:{QR_CODE:0}}},{document:{getElementById:()=>({innerHTML:'',querySelectorAll:()=>[]})},window:{setTimeout(){}},console:{error(){},info(){},warn(){}}}).default;
  let renderer;
  await act(async()=>{renderer=create(React.createElement(Scanner,{readerId:'reader',onResult:value=>accepted.push(value)}));await nextTurn();});
  act(()=>{decode('ticket-one');renderer.unmount();});
  await nextTurn();assert.deepEqual(accepted,[]);
});
