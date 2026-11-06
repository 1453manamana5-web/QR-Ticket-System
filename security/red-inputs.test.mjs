import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {webcrypto,createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {IDBFactory} from 'fake-indexeddb';
import React from 'react';
import {act,create} from 'react-test-renderer';

const root=new URL('../',import.meta.url);
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
// Optional local-only reproduction of the vulnerable App. Normal CI tests the
// current source. No network request, browser account or Firebase config is used.
const baseline=process.env.QR_SECURITY_BASELINE==='1';
function load(file,dependencies={},globals={}){
  const source=baseline&&['./reception-app/src/App.tsx','./reception-app/src/receptionState.ts'].includes(file)
    ?execFileSync('git',['show','c88322d:'+file.slice(2)],{cwd:root,encoding:'utf8'})
    :readFileSync(new URL(file,root),'utf8');
  const compiled=ts.transpileModule(source.replaceAll('import.meta.env.BASE_URL','"/QR-Ticket-System/"'),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const exports={};
  new Function('exports','require',...Object.keys(globals),compiled)(exports,name=>{
    if(name in dependencies)return dependencies[name];
    if(name==='./receptionState')return load('./reception-app/src/receptionState.ts');
    if(name==='../../shared/src/offlineTransfer')return load('./shared/src/offlineTransfer.ts',{}, {crypto:webcrypto});
    if(name==='react'||name==='react/jsx-runtime')return require(name);
    throw Error('Unexpected dependency: '+name);
  },...Object.values(globals));
  return exports;
}
const makeEvent=(eventId='event-one',dataVersion=1)=>({
  event:{eventId,eventName:'Security fixture',eventDate:'2026-11-06',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion},
  settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
  terminalId:'T-REGRESSION-01',authenticatedAt:'2026-11-06T00:00:00.000Z',dataReady:false,ticketCount:1,
});
const makeTicket=(eventId='event-one')=>({ticketId:'ticket-one',eventId,basicInfo:{},valid:true,currentStatus:'unused',updatedAt:'2026-11-06T00:00:00.000Z'});
const localDb=()=>load('./reception-app/src/localDb.ts',{},{indexedDB:new IDBFactory()});
const offlineProtocol=()=>load('./shared/src/offlineTransfer.ts',{}, {crypto:webcrypto});
// Reuse the existing full App harness without running the other test suite.
const regression=readFileSync(new URL('../reception-regression.test.mjs',import.meta.url),'utf8');
const start=regression.indexOf('async function harness(');
const end=regression.indexOf('\ntest(',start);
assert.ok(start>=0&&end>start,'The established App test harness must exist');
const harness=new Function('load','localDb','makeEvent','makeTicket','React','act','create','nextTurn','webcrypto','assert',
  regression.slice(start,end)+';return harness;')(load,localDb,makeEvent,makeTicket,React,act,create,nextTurn,webcrypto,assert);
const validData=(eventId='event-one')=>({event:makeEvent(eventId).event,settings:makeEvent().settings,tickets:[makeTicket(eventId)]});

async function importOffline(registration,eventId){
  const h=await harness({saved:false,initialRegistration:registration,readRegistration:async()=>registration,
    automatic:async()=>{throw Error('NO_PUBLISHED_EVENT');},download:async()=>{throw Error('NETWORK_MUST_NOT_BE_USED');}});
  h.navigator.onLine=false;
  await h.click('イベントデータQRを読み取る');
  for(const frame of await offlineProtocol().encodeOfflineEvent(validData(eventId)))await h.scan(frame);
  await h.click('このイベントで認証');
  return h;
}

test('red input: a self-hashed offline QR cannot select an event not approved for this terminal',async()=>{
  const h=await importOffline({approved:true,status:'online',name:'Entrance',eventId:'event-one'},'attacker-event');
  try{
    assert.equal(await h.local.loadLocalEvent(),null,'forged event must not become local inventory');
    assert.equal(await h.local.getTicket('ticket-one'),null);
    assert.doesNotMatch(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test('red input: a legacy registration without an approved event cannot bootstrap arbitrary offline inventory',async()=>{
  const h=await importOffline({approved:true,status:'online',name:'Legacy entrance'},'attacker-event');
  try{
    assert.equal(await h.local.loadLocalEvent(),null);
    assert.doesNotMatch(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test('red input normal control: explicitly approved event still transfers and captures offline',async()=>{
  const h=await importOffline({approved:true,status:'online',name:'Entrance',eventId:'event-one'},'event-one');
  try{
    assert.equal((await h.local.loadLocalEvent()).event.eventId,'event-one');
    assert.match(h.text(),/受付準備完了/);
    await h.click('受付を開始する');await h.scan('ticket-one');
    assert.equal((await h.local.getTicket('ticket-one')).currentStatus,'inside');
    assert.equal((await h.local.getPendingSyncItems()).length,1);
  }finally{await h.close();}
});

test('red input: malformed, oversized and out-of-range offline frames are rejected before use',async()=>{
  const {OfflineEventCollector}=offlineProtocol();
  const frame=JSON.parse((await offlineProtocol().encodeOfflineEvent(validData()))[0]);
  const values=['{',null,{...frame,index:-1},{...frame,total:201},{...frame,total:'1'},{...frame,data:'$not-base64'},'x'.repeat(200_000)];
  for(const value of values){
    const text=typeof value==='string'?value:JSON.stringify(value);
    await assert.rejects(new OfflineEventCollector().add(text));
  }
});

test('red input: a small validly hashed gzip cannot expand beyond the 2MB receiving limit',async()=>{
  // One bounded decompression test; the compressed input is only a few KB.
  const compressed=gzipSync(Buffer.alloc(2_000_001,32));
  assert.ok(compressed.length<200_000);
  const encoded=compressed.toString('base64'),total=Math.ceil(encoded.length/1000);
  const id=createHash('sha256').update(compressed).digest('hex');
  const collector=new (offlineProtocol().OfflineEventCollector)();
  await assert.rejects(async()=>{
    for(let index=0;index<total;index++)await collector.add(JSON.stringify({type:'qr-ticket-offline-v1',id,index,total,data:encoded.slice(index*1000,(index+1)*1000)}));
  },/大きすぎます/);
});

test('red input: offline schema validation rejects forged paths, duplicate IDs and type confusion',()=>{
  const {validateOfflineEvent}=offlineProtocol(),data=validData();
  for(const value of [
    {...data,event:{...data.event,eventId:'events/other'}},
    {...data,event:{...data.event,eventStatus:'finished'}},
    {...data,tickets:[data.tickets[0],data.tickets[0]]},
    {...data,tickets:[{...data.tickets[0],eventId:'another'}]},
    {...data,tickets:[{...data.tickets[0],valid:'true'}]},
    {...data,settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:'true'}},
  ])assert.throws(()=>validateOfflineEvent(value));
});

test('red input: backup imports discard authority fields rather than trusting roles or prototype keys',()=>{
  const {parseManagementBackup}=load('./management-app/src/backup.ts');
  const data=validData();
  const imported=parseManagementBackup(JSON.parse(JSON.stringify({
    version:1,eventId:'event-one',eventHistory:[{...data.event,authToken:'attacker-token',receptionTarget:true}],
    tickets:data.tickets,members:[],terminalInstallations:{attacker:{approved:true}},
    appSettings:JSON.parse('{"admin":true,"subAdmin":true,"__proto__":{"polluted":true},"voiceGuidance":true}'),
  })));
  assert.equal(imported.eventHistory[0].authToken,undefined);
  assert.equal(imported.eventHistory[0].receptionTarget,undefined);
  assert.equal(imported.terminalInstallations,undefined);
  assert.deepEqual(imported.appSettings,{voiceGuidance:true});
  assert.equal({}.polluted,undefined);
});
