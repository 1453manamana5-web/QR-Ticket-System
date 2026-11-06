import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import React from 'react';
import {act,create} from 'react-test-renderer';

const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function load(path,deps={},globals={}) {
  const source=readFileSync(path,'utf8').replaceAll('import.meta.env.BASE_URL',JSON.stringify('/QR-Ticket-System/management-app/'));
  const out={};
  new Function('exports','require',...Object.keys(globals),ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n in deps?deps[n]:require(n),...Object.values(globals));
  return out;
}
const flush=()=>act(async()=>{for(let i=0;i<8;i++)await tick();});
const manager={terminalId:'T-TEST-MANAGER',name:'Manager',type:'Web / iPad',role:'management',approved:true,managementApproved:true,receptionApproved:false,status:'online',lastSeen:null,networkMbps:null,battery:null,admin:true};

async function managementHarness(){
  let finishInitial,rejectInitial,publishTerminals;
  const initial=new Promise((resolve,reject)=>{finishInitial=resolve;rejectInitial=reject;});
  const api={
    loadTerminals:()=>initial,subscribeTerminals:callback=>{publishTerminals=callback;callback([]);return()=>{};},
    subscribeEvents:callback=>{callback([]);return()=>{};},subscribeTickets:()=>()=>{},subscribeReceptionRecords:()=>()=>{},
    loadAppSettings:async()=>({}),saveAppSettings:async()=>{},saveManagementTerminalHeartbeat:async()=>{},
    loadReceptionSettings:async()=>null,loadMembers:async()=>[],loadAnalysis:async()=>[],loadReceptionErrors:async()=>[],loadPendingReceptionEventApprovals:async()=>[],
  };
  const storage=new Map([['qr-ticket-terminal-id',manager.terminalId],['qr-ticket-device-id',manager.terminalId]]);
  const window={addEventListener(){},removeEventListener(){},setInterval(){return 1;},clearInterval(){},setTimeout(){return 1;},clearTimeout(){}};
  const app=load('management-app/src/App.tsx',{
    './firebaseData':api,'./eventPublisher':{loadPublishedEventBundle:async()=>null},
    './SurfaceMotion':{SurfacePresence:({children})=>children,TicketZoomSurface:({children})=>children},
    './VenueOccupancyChart':{default:()=>null},'./OfflineEventTransfer':{default:()=>null},'qrcode.react':{QRCodeSVG:()=>null},
    './guidePractice':load('management-app/src/guidePractice.ts'),
    './ManagementGuide':{default:()=>null,managementGuideTopics:[],useManagementGuide:()=>({open:false})},
    './eventUtils':load('management-app/src/eventUtils.ts',{}, {crypto:webcrypto}),
    './backup':load('management-app/src/backup.ts'),'./operationSafety':load('management-app/src/operationSafety.ts'),
    './reservePrintLedger':{useReservePrintLedger:()=>({confirmed:[],reserved:[],unsynced:0})},
    './TicketDesigner':{default:()=>null,TicketQrPreview:()=>null},
  },{localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},window,navigator:{},document:{querySelectorAll:()=>[]},crypto:webcrypto,console:{error(){},warn(){}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(app.default));});await flush();
  return {renderer,finishInitial,rejectInitial,publish:async values=>{await act(async()=>publishTerminals(values));await flush();},text:()=>JSON.stringify(renderer.toJSON()),close:()=>act(async()=>renderer.unmount())};
}

test('late initial terminal reads cannot erase a newer approval or restore a revoked manager',async()=>{
  for(const initiallyApproved of [false,true]){
    const h=await managementHarness();
    try{
      await h.publish(initiallyApproved?[]:[manager]);
      const before=h.text();
      if(initiallyApproved)assert.match(before,/端末登録申請/);else assert.match(before,/ホーム/);
      await act(async()=>h.finishInitial(initiallyApproved?[manager]:[]));await flush();
      assert.equal(h.text(),before,'the live terminal subscription is newer than the initial read');
      if(initiallyApproved)assert.match(h.text(),/端末登録申請/);else assert.match(h.text(),/ホーム/);
    }finally{await h.close();}
  }
});

test('failure of a superseded initial terminal read preserves a working live session',async()=>{
  const h=await managementHarness();
  try{
    await h.publish([manager]);
    const before=h.text();await act(async()=>h.rejectInitial(Error('slow initial read failed')));await flush();
    assert.equal(h.text(),before);
  }finally{await h.close();}
});

test('offline reserve readiness recognizes the shell written by the current service worker',async()=>{
  const sw=readFileSync('management-app/public/sw.js','utf8');
  const currentCache=sw.match(/const CACHE='([^']+)'/)[1];
  const scope='https://test.example/QR-Ticket-System/management-app/';
  const cached=[];
  const caches={keys:async()=>[currentCache],open:async name=>({match:async url=>{cached.push({name,url});return name===currentCache?new Response('saved shell'):undefined;}})};
  const reserve=load('management-app/src/ReservePrinting.tsx',{
    './reservePrintLedger':{useReservePrintLedger:()=>({unsynced:0})},
    './reservePrintStore':{loadReservePackage:async()=>({eventId:'event',eventName:'Festival',preparedAt:new Date().toISOString(),tickets:[{id:'1',number:'1',svg:'<svg/>'}],confirmed:[],pending:null})},
  },{navigator:{serviceWorker:{getRegistration:async()=>({active:{},scope})}},window:{caches},caches,setInterval:()=>1,clearInterval(){}});
  let renderer;await act(async()=>{renderer=create(React.createElement(reserve.default,{eventId:'event'}));});await flush();
  try{
    assert.match(JSON.stringify(renderer.toJSON()),/オフライン起動の準備完了/);
    assert.ok(cached.some(item=>item.name===currentCache&&item.url===scope+'index.html'));
  }finally{await act(async()=>renderer.unmount());}
});
