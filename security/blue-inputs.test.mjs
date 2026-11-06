import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {test} from 'node:test';
import React from 'react';
import {act,create} from 'react-test-renderer';

const ts=createRequire(import.meta.url)('typescript');
const root=new URL('../',import.meta.url);
const path='reception-app/src/receptionState.ts';
const source=process.env.QR_SECURITY_BASELINE==='1'
  ?execFileSync('git',['show','c88322dbe12670fbd55b26f160786ec973582296:'+path],{cwd:root,encoding:'utf8'})
  :readFileSync(new URL(path,root),'utf8');
const state={};
new Function('exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(state);
const {initialReceptionState,receptionReducer,receptionPhase,canReceive}=state;
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const localEvent={event:{eventId:'approved-event',eventName:'Approved event',eventDate:'2026-11-06',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1},settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},terminalId:'T-BLUE-INPUTS',authenticatedAt:'2026-11-06T00:00:00.000Z',dataReady:true,ticketCount:1};

function tryReception(registration){
  let value=receptionReducer(initialReceptionState,{type:'registration',value:registration});
  value=receptionReducer(value,{type:'event',value:localEvent});
  value=receptionReducer(value,{type:'screen',value:'ready'});
  return receptionReducer(value,{type:'screen',value:'reception'});
}

test('blue: a legacy approval without an event binding cannot unlock reception',()=>{
  const current=tryReception({approved:true,status:'offline',name:'Legacy approval'});
  assert.equal(canReceive(current),false);
  assert.equal(current.localEvent,null);
  assert.notEqual(receptionPhase(current),'receiving');
});

test('blue: another event or a pending approval cannot unlock the saved inventory',()=>{
  for(const registration of [
    {approved:true,status:'offline',name:'Other event',eventId:'other-event'},
    {approved:false,status:'pending',name:'Pending',eventId:'approved-event'},
  ]){
    const current=tryReception(registration);
    assert.equal(canReceive(current),false);
    assert.equal(current.localEvent,null);
  }
});

test('blue: an event-bound approval continues receiving offline and stops on revocation',()=>{
  let current=tryReception({approved:true,status:'offline',name:'Approved terminal',eventId:'approved-event'});
  assert.equal(canReceive(current),true);
  assert.equal(receptionPhase(current),'receiving');
  current=receptionReducer(current,{type:'registration',value:null});
  assert.equal(canReceive(current),false);
  assert.equal(current.localEvent,null);
});

async function cachedApprovalScreen(eventId){
  const storage=new Map([
    ['qr-ticket-terminal-id',localEvent.terminalId],
    ['qr-ticket-reception-approved',JSON.stringify({terminalId:localEvent.terminalId,approved:true,name:'Cached terminal',...(eventId?{eventId}:{})})],
  ]);
  const appPath='reception-app/src/App.tsx';
  const appSource=process.env.QR_SECURITY_BASELINE==='1'
    ?execFileSync('git',['show','c88322dbe12670fbd55b26f160786ec973582296:'+appPath],{cwd:root,encoding:'utf8'})
    :readFileSync(new URL(appPath,root),'utf8');
  const out={};
  const deps={
    './receptionState':state,
    './QrScanner':{default:()=>null},
    './ReceptionGuide':{default:()=>null,receptionGuideTopics:[],useReceptionGuide:()=>({open:false})},
    '../../shared/src/offlineTransfer':{OfflineEventCollector:class{}},
    './receptionAudio':{prepareReceptionAudio:()=>()=>{},playReceptionAudio:async()=> 'played',getReceptionAudioSettings:()=>({volume:1,voiceGuidance:true,successSound:true}),stopReceptionGuidance(){}},
    './syncQueue':{syncPendingReceptionRecords:async()=>{}},
    './localDb':{loadLocalEvent:async()=>localEvent,getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>[]},
    './eventDownloader':{},
    './receptionSync':{subscribeTerminalRegistration:cb=>{cb(null);return()=>{};},subscribeTerminalControl:()=>()=>{},saveTerminalHeartbeat:async()=>null},
  };
  const compile=ts.transpileModule(appSource,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;
  const require=createRequire(import.meta.url);
  new Function('exports','require','navigator','localStorage','window','console',compile)(out,name=>{
    if(name in deps)return deps[name];
    if(name==='react'||name==='react/jsx-runtime')return require(name);
    throw Error('Unexpected dependency: '+name);
  },{onLine:false},{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  {addEventListener(){},removeEventListener(){},setInterval:()=>1,clearInterval(){},setTimeout:()=>2,clearTimeout(){}},
  {error(){},warn(){},info(){}});
  let renderer;
  await act(async()=>{renderer=create(React.createElement(out.default));for(let i=0;i<20;i++)await nextTurn();});
  return {text:()=>JSON.stringify(renderer.toJSON()),close:()=>act(async()=>renderer.unmount())};
}

test('blue: a legacy cached approval cannot restore a ready offline event',async()=>{
  const h=await cachedApprovalScreen();
  try{
    assert.doesNotMatch(h.text(),/受付準備完了/);
    assert.match(h.text(),/受付端末を登録/);
  }finally{await h.close();}
});

test('blue: cached approval bound to the same event still restores offline reception',async()=>{
  const h=await cachedApprovalScreen('approved-event');
  try{assert.match(h.text(),/受付準備完了/);}finally{await h.close();}
});
