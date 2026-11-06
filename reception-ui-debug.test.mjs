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
function load(path,dependencies={},globals={}){
  const output=ts.transpileModule(readFileSync(new URL(path,import.meta.url),'utf8'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const exports={};
  new Function('exports','require',...Object.keys(globals),output)(exports,name=>{
    if(name in dependencies)return dependencies[name];
    if(name==='react'||name==='react/jsx-runtime')return require(name);
    throw Error('Unexpected dependency: '+name);
  },...Object.values(globals));
  return exports;
}
async function readyReception(){
  const event={eventId:'event-debug',eventName:'UI regression',eventDate:'2026-11-06',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1};
  const localEvent={event,settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},terminalId:'T-UI-DEBUG',authenticatedAt:'2026-11-06T00:00:00.000Z',dataReady:true,ticketCount:1};
  const storage=new Map([['qr-ticket-terminal-id',localEvent.terminalId]]);
  let control;
  const dependencies={
    './receptionState':load('./reception-app/src/receptionState.ts'),
    './ReceptionGuide':{default:()=>null,receptionGuideTopics:[],useReceptionGuide:()=>({open:false})},
    './QrScanner':{default:()=>null},
    '../../shared/src/offlineTransfer':{OfflineEventCollector:class{}},
    './receptionAudio':{prepareReceptionAudio:()=>()=>{},playReceptionAudio:async()=> 'played',getReceptionAudioSettings:()=>({volume:1,voiceGuidance:true,successSound:true}),stopReceptionGuidance:()=>{}},
    './syncQueue':{syncPendingReceptionRecords:async()=>{}},
    './localDb':{loadLocalEvent:async()=>localEvent,getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>[]},
    './eventDownloader':{getCurrentFirebaseEventAuthPayload:async()=>({type:'qr-ticket-event-auth',...event,authToken:'debug-token'})},
    './receptionSync':{
      subscribeTerminalRegistration:callback=>{callback({approved:true,status:'online',name:'UI debug',eventId:event.eventId});return()=>{};},
      subscribeTerminalControl:(_terminal,callback)=>{control=callback;return()=>{};},
      saveTerminalHeartbeat:async()=>null,
    },
  };
  const App=load('./reception-app/src/App.tsx',dependencies,{
    navigator:{onLine:true},crypto:webcrypto,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    window:{addEventListener:()=>{},removeEventListener:()=>{},setInterval:()=>1,clearInterval:()=>{},setTimeout:()=>2,clearTimeout:()=>{}},
    console:{error:()=>{},warn:()=>{},info:()=>{}},
  }).default;
  let renderer;
  await act(async()=>{renderer=create(React.createElement(App));for(let i=0;i<10;i++)await nextTurn();});
  const button=label=>renderer.root.findAllByType('button').find(node=>node.children.join('')===label);
  return {renderer,button,control:async(mode,at)=>{await act(async()=>control(mode,at));},close:async()=>{await act(async()=>renderer.unmount());}};
}

test('remote stop before reception starts explains the block and re-enables start only after a resume command',async()=>{
  const h=await readyReception();
  try{
    assert.equal(h.button('受付を開始する').props.disabled,false);
    await h.control('停止','2026-11-06T00:01:00.000Z');
    assert.equal(h.button('受付を開始する').props.disabled,true);
    assert.match(JSON.stringify(h.renderer.toJSON()),/管理画面から受付停止の指示を受けています/);
    await h.control('出口受付','2026-11-06T00:02:00.000Z');
    assert.equal(h.button('受付を開始する').props.disabled,false);
    await act(async()=>h.button('受付を開始する').props.onClick());
    assert.ok(h.button('受付を停止'));
    assert.match(JSON.stringify(h.renderer.toJSON()),/reception-mode-exit/);
  }finally{await h.close();}
});
