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

async function harness({latestTicket=async()=>makeTicket(),saveReception=async()=>'saved',initialRegistration=approved,initialFailure,cacheApproval=false,event=makeEvent(),offlineAdd,loadValidation,metadataRead,download,syncError,syncRecords,heartbeat}={}){
  let stored=structuredClone(event),metadata=structuredClone(event.event),currentRegistration=initialRegistration,registrationCallback,registrationError,controlCallback,renderer;
  const audio=[],writes=[],errors=[],syncedErrors=new Set(),heartbeats=[],listeners=new Map(),intervals=new Map(),timeouts=new Map(),storage=new Map([['qr-ticket-terminal-id','T-UI-AUDIT']]);
  if(cacheApproval)storage.set('qr-ticket-reception-approved',JSON.stringify({...approved,terminalId:'T-UI-AUDIT'}));
  let id=0;
  const navigator={onLine:true};
  const window={
    addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},
    setInterval:(fn)=>{intervals.set(++id,fn);return id;},clearInterval:key=>intervals.delete(key),
    setTimeout:(fn)=>{timeouts.set(++id,fn);return id;},clearTimeout:key=>timeouts.delete(key),
  };
  const local={
    getLocalPreparationToken:async()=>"test-preparation",
    loadLocalEvent:async validate=>{if(validate&&loadValidation)await loadValidation();return structuredClone(stored);},
    saveLocalEvent:async data=>{stored=structuredClone(data);},
    prepareLocalEventData:async data=>{stored={...structuredClone(data),dataReady:true};},
    clearLocalEvent:async()=>{stored=null;},
    getTicket:async()=>makeTicket(),getReceptionRecord:async()=>null,getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>errors.filter(error=>!syncedErrors.has(error.errorId)),
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
    './eventDownloader':{getCurrentFirebaseEventAuthPayload:async()=>metadataRead?metadataRead(auth()):auth(),downloadCurrentFirebaseEventData:async()=>({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}],authPayload:auth()}),downloadEventData:async()=>download?download({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}]}):({localEvent:{...event,event:metadata},tickets:[{...makeTicket(),eventId:metadata.eventId}]}),getEventAuthPayloadByToken:async()=>auth()},
    './receptionSync':{
      getTerminalRegistration:async()=>currentRegistration,
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
    setMetadata:value=>{metadata=value;},setSettings:value=>{stored.settings=value;event.settings=value;},
    signal:async name=>{await act(async()=>{for(const fn of [...(listeners.get(name)??[])])fn();});await flush();},
    beginScan:async value=>{let operation;await act(async()=>{operation=renderer.root.findByType(Scanner).props.onResult(value);});await flush();return {operation};},
    registration:async value=>{currentRegistration=value;await act(async()=>registrationCallback(value));await flush();},
    registrationFailure:async code=>{await act(async()=>registrationError({code}));await flush();},
    control:async mode=>{await act(async()=>controlCallback(mode,'2099-01-01T00:00:00.000Z'));await flush();},
    poll:async()=>{await act(async()=>{for(const fn of [...intervals.values()])await fn();});await flush();},
    close:async()=>{await act(async()=>renderer.unmount());},
  };
}

test('incomplete saved inventory is repaired before same-version metadata can mark reception ready',async()=>{
  const download=deferred();let downloads=0;
  const h=await harness({loadValidation:async()=>{throw Error('LOCAL_EVENT_INCOMPLETE');},download:()=>{downloads++;return download.promise;}});
  try{
    assert.doesNotMatch(h.text(),/受付準備完了/);
    assert.equal(downloads,1);
    await act(async()=>download.resolve({localEvent:makeEvent(),tickets:[makeTicket()]}));await h.flush();
    assert.match(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test('permission-denied during an active ticket lookup stops scanning and removes cached approval',async()=>{
  const h=await harness({cacheApproval:true,latestTicket:async()=>{throw Object.assign(Error('denied'),{code:'permission-denied'});}});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();
    assert.equal(h.writes.length,0);assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);
    assert.equal(h.storage.has('qr-ticket-reception-approved'),false);
    assert.match(h.text(),/受付.*承認|受付端末を登録/);
  }finally{await h.close();}
});

test('permission-denied from the current publication poll also stops cached reception',async()=>{
  let denied=false;
  const h=await harness({cacheApproval:true,metadataRead:async payload=>{if(denied)throw Object.assign(Error('denied'),{code:'permission-denied'});return payload;}});
  try{
    await h.click('受付を開始する');denied=true;await h.poll();
    assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);
    assert.equal(h.storage.has('qr-ticket-reception-approved'),false);
  }finally{await h.close();}
});

test('reconnect and periodic retries share one in-flight reception error upload',async()=>{
  const upload=deferred();let uploads=0;
  const h=await harness({syncError:()=>{uploads++;return upload.promise;}});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan(JSON.stringify({type:'qr-ticket',ticketId:''}));await act(async()=>scan.operation);await h.flush();
    await h.signal('online');await h.poll();await h.signal('online');
    assert.equal(uploads,1);
    await act(async()=>upload.resolve());await h.flush();
    assert.equal(uploads,1);
  }finally{upload.resolve();await h.close();}
});

test('offline error logging immediately updates the saved pending count without an upload',async()=>{
  let uploads=0;const h=await harness({syncError:async()=>{uploads++;}});
  try{
    await h.click('受付を開始する');h.navigator.onLine=false;
    const scan=await h.beginScan(JSON.stringify({type:'qr-ticket',ticketId:''}));await act(async()=>scan.operation);await h.flush();
    assert.equal(uploads,0);assert.ok(h.renderer.root.findAllByProps({role:'status'}).some(node=>node.children.join('')==='未同期 1件（端末内保存済み）'));
    await h.click('受付を停止');
    assert.ok(h.renderer.root.findAllByProps({role:'status'}).some(node=>node.children.join('')==='未同期 1件（端末内保存済み）'),'stopped reception must keep unsent history visible');
  }finally{await h.close();}
});

test('a temporarily unreachable server does not wait on every saved error log in one retry',async()=>{
  let uploads=0;const h=await harness({syncError:async()=>{uploads++;throw Object.assign(Error('timeout'),{code:'deadline-exceeded'});}});
  try{
    for(let index=0;index<4;index++)h.errors.push({errorId:'old-'+index,eventId:'event-one',terminalId:'T-UI-AUDIT',category:'unknown_ticket',mode:'entry',timestamp:'2026-10-27T01:00:00.000Z'});
    await h.signal('online');
    assert.equal(uploads,1);
  }finally{await h.close();}
});

test('a transient ticket read failure displays offline reception while preserving the downloaded ticket',async()=>{
  const h=await harness({latestTicket:async()=>{throw Object.assign(Error('network'),{code:'unavailable'});}});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');await act(async()=>scan.operation);await h.flush();
    assert.equal(h.writes.length,1);assert.match(h.text(),/オフライン/);assert.match(h.text(),/入場を確認しました/);
  }finally{await h.close();}
});

test('approval does not send an unscoped startup heartbeat that can trail event mode reports',async()=>{
  const h=await harness();
  try{
    assert.ok(h.heartbeats.length>0);assert.ok(h.heartbeats.every(args=>args[3]==='event-one'));
    await h.click('受付を開始する');assert.equal(h.heartbeats.at(-1)[1],'entry');
  }finally{await h.close();}
});

test('a late heartbeat from an old screen cannot overwrite the current connection measurement',async()=>{
  const first=deferred();let reports=0;
  const h=await harness({heartbeat:()=>++reports===1?first.promise:42});
  try{
    await h.click('受付を開始する');await h.click('受付を停止');
    assert.match(h.text(),/42.0 Mbps/);
    await act(async()=>first.resolve(.2));await h.flush();
    assert.match(h.text(),/42.0 Mbps/);assert.doesNotMatch(h.text(),/0.2 Mbps/);
  }finally{first.resolve(null);await h.close();}
});

test('a new approval lifecycle can poll while its obsolete publication read is outstanding',async()=>{
  const first=deferred();let reads=0;
  const h=await harness({metadataRead:async payload=>++reads===1?first.promise:payload});
  try{
    assert.equal(reads,1);await h.registration(null);await h.registration(approved);
    assert.ok(reads>=2,'the cancelled lifecycle must release its loading ownership');
    first.resolve({type:'qr-ticket-event-auth',eventId:'old-event',eventName:'Old',dataVersion:1,authToken:'old'});await h.flush();
    assert.match(h.text(),/受付準備完了/);assert.equal(h.stored().event.eventId,'event-one');
  }finally{first.resolve(null);await h.close();}
});

test('opening and closing settings cancels an already pending ticket scan',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    await h.click('設定');await h.click('閉じる');
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);assert.equal(h.audio.includes('entrySuccess'),false);
  }finally{await h.close();}
});

test('a disabled entry policy received while ticket lookup is pending prevents acceptance',async()=>{
  const latest=deferred(),h=await harness({latestTicket:()=>latest.promise});
  try{
    await h.click('受付を開始する');const scan=await h.beginScan('ticket-one');
    h.setSettings({entryEnabled:false,exitEnabled:true,reentryEnabled:true});await h.poll();
    await act(async()=>{latest.resolve(makeTicket());await scan.operation;});await h.flush();
    assert.equal(h.writes.length,0);assert.match(h.text(),/受付できません/);
  }finally{await h.close();}
});
