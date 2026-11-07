import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(path,deps={},globals={}){
 const out={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,n=>{if(n in deps)return deps[n];throw Error('Unexpected dependency '+n);},...Object.values(globals));return out;
}
const event={eventId:'transfer-event',eventName:'Transfer event',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'ready',dataVersion:1};
const settings={entryEnabled:true,exitEnabled:true,reentryEnabled:true};
const ticket={ticketId:'TKT000001',eventId:event.eventId,basicInfo:{ticketNumber:1},currentStatus:'unused',valid:true,updatedAt:'2026-11-07T00:00:00.000Z'};
const payload={type:'qr-ticket-event-auth',eventId:event.eventId,eventName:event.eventName,dataVersion:1,authToken:'token'};
const data={event,settings,tickets:[ticket]};
const snapshot=value=>({exists:()=>value!==null,data:()=>value});
function downloader({change=()=>{},tickets=[ticket],canonical={...event,authToken:'token',receptionTarget:true,ticketCount:1,inventoryRevision:1},bundle={event,settings,ticketCount:1,authToken:'token',publishedAt:'2026-11-07T00:00:00.000Z'},globals={},reads}={}){
 const documents={canonical:structuredClone(canonical),bundle:structuredClone(bundle)};
 const api=load('reception-app/src/eventDownloader.ts',{'./firebaseClient':{getFirebaseDb:()=>({})},'firebase/firestore':{
  doc:(_db,...p)=>p.join('/'),collection:(_db,...p)=>p.join('/'),query:q=>q,where:()=>[],
  getDocFromServer:async ref=>{reads?.push(ref);return snapshot(structuredClone(ref.startsWith('eventBundles/')?documents.bundle:documents.canonical));},
  getDocsFromServer:async ref=>{reads?.push(ref);const result={docs:tickets.map(t=>({id:t.ticketId,data:()=>structuredClone(t)}))};change(documents);return result;},
 }},globals);
 return {api,documents};
}
for(const [name,change] of [
 ['unpublication',d=>{d.canonical.receptionTarget=false;}],['deletion',d=>{d.canonical=null;}],
 ['version',d=>{d.canonical.dataVersion=2;d.bundle.event.dataVersion=2;}],['token',d=>{d.canonical.authToken='new-token';}],
 ['schedule',d=>{d.canonical.startTime='10:00';}],['inventory revision',d=>{d.canonical.inventoryRevision=2;}],
 ['bundle settings',d=>{d.bundle.settings.reentryEnabled=false;}],['bundle deletion',d=>{d.bundle=null;}],
])test('a '+name+' change while ticket inventory is downloading cannot return stale ready data',async()=>{
 const {api}=downloader({change});await assert.rejects(api.downloadEventData(payload,'T-TRANSFER'),/EVENT_DATA_INVALID|EVENT_DATA_NOT_FOUND/);
});
test('an existing canonical inventory never falls back to stale embedded tickets',async()=>{
 const {api}=downloader({tickets:[],bundle:{event,settings,authToken:'token',ticketCount:1,tickets:[ticket]}});
 await assert.rejects(api.downloadEventData(payload,'T-TRANSFER'),/EVENT_TICKET_COUNT_MISMATCH/);
});
for(const invalid of [{...ticket,updatedAt:'bad'},{...ticket,ticketId:'a/b'},{...ticket,basicInfo:[]},{...ticket,eventId:'other'}])test('malformed downloaded ticket '+JSON.stringify(invalid)+' is rejected before local preparation',async()=>{
 const {api}=downloader({tickets:[invalid]});await assert.rejects(api.downloadEventData(payload,'T-TRANSFER'),/EVENT_DATA_INVALID/);
});
test('published settings cannot silently interpret string false as an enabled gate',async()=>{
 const {api}=downloader({bundle:{event,settings:{...settings,entryEnabled:'false'},authToken:'token',ticketCount:1}});
 await assert.rejects(api.downloadEventData(payload,'T-TRANSFER'),/EVENT_DATA_INVALID/);
});
test('a full download has one bounded budget and does not continue reads after timing out',async()=>{
 const pending=new Map();let id=0,finish;const reads=[];
 const api=load('reception-app/src/eventDownloader.ts',{'./firebaseClient':{getFirebaseDb:()=>({})},'firebase/firestore':{
  doc:(_db,...p)=>p.join('/'),getDocFromServer:ref=>{reads.push(ref);return new Promise(resolve=>{finish=resolve;});},
 }},{setTimeout:fn=>{pending.set(++id,fn);return id;},clearTimeout:key=>pending.delete(key)});
 const result=api.downloadEventData(payload,'T-TRANSFER');
 const timers=[...pending.values()];timers[0]();await assert.rejects(result,e=>e.code==='deadline-exceeded');
 finish(snapshot({event,settings,ticketCount:1,authToken:'token'}));await tick();await tick();
 assert.deepEqual(reads,['eventBundles/token']);assert.equal(pending.size,0);
});
function protocol(globals={}){return load('shared/src/offlineTransfer.ts',{}, {crypto:webcrypto,...globals});}
test('resetting during digest verification cannot clear the next transfer',async()=>{
 const frames=await protocol().encodeOfflineEvent(data),next=await protocol().encodeOfflineEvent({...data,event:{...event,eventName:'Next'},tickets:Array.from({length:120},(_,i)=>({...ticket,ticketId:'NEXT'+i,basicInfo:{tag:webcrypto.randomUUID()}}))});
 assert.ok(next.length>1);
 let finish;const crypto={subtle:{digest:()=>new Promise(resolve=>{finish=resolve;})}};
 const {OfflineEventCollector}=protocol({crypto});const collector=new OfflineEventCollector();
 let result;for(const frame of frames)result=collector.add(frame);
 await tick();assert.ok(finish);collector.reset();
 assert.equal(await collector.add(next[0]),null);const progress=collector.progress;
 const bytes=Uint8Array.from(atob(frames.map(s=>JSON.parse(s).data).join('')),c=>c.charCodeAt(0));
 finish(await webcrypto.subtle.digest('SHA-256',bytes));
 assert.equal(await result,null);assert.deepEqual(collector.progress,progress);
});
test('a fully received invalid compressed payload resets and permits a fresh transfer',async()=>{
 const bytes=new TextEncoder().encode('not gzip'),hash=[...new Uint8Array(await webcrypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 const broken=JSON.stringify({type:'qr-ticket-offline-v1',id:hash,index:0,total:1,data:btoa(String.fromCharCode(...bytes))});
 const {OfflineEventCollector,encodeOfflineEvent}=protocol();const collector=new OfflineEventCollector();
 await assert.rejects(collector.add(broken));assert.deepEqual(collector.progress,{received:0,total:0});
 let result;for(const frame of await encodeOfflineEvent(data))result=await collector.add(frame);assert.deepEqual(result,data);
});

test('resetting during decompression ignores obsolete data without clearing the next transfer',{timeout:10000},async()=>{
 const real=protocol(),frames=await real.encodeOfflineEvent(data);
 const next=await real.encodeOfflineEvent({...data,tickets:Array.from({length:120},(_,i)=>({...ticket,ticketId:'NEXT'+i,basicInfo:{tag:webcrypto.randomUUID()}}))});
 assert.ok(next.length>1);
 let resume,signalStarted;const blocked=new Promise(resolve=>{resume=resolve;});
 const started=new Promise(resolve=>{signalStarted=resolve;});
 const DecompressionStream=class{constructor(){return new TransformStream({async transform(_chunk,controller){signalStarted();await blocked;controller.enqueue(new TextEncoder().encode(JSON.stringify(data)));}});}};
 const {OfflineEventCollector}=protocol({DecompressionStream}),collector=new OfflineEventCollector();
 let pending;for(const frame of frames)pending=collector.add(frame);
 await started;
 collector.reset();assert.equal(await collector.add(next[0]),null);const progress=collector.progress;
 resume();assert.equal(await pending,null);assert.deepEqual(collector.progress,progress);
});

test('repeated final frames share one verification and decompression',async()=>{
 const frames=await protocol().encodeOfflineEvent(data);let digests=0;
 const crypto={subtle:{digest:(...args)=>{digests++;return webcrypto.subtle.digest(...args);}}};
 const {OfflineEventCollector}=protocol({crypto}),collector=new OfflineEventCollector();
 let first;for(const frame of frames)first=collector.add(frame);
 const second=collector.add(frames.at(-1));
 assert.deepEqual(await first,data);assert.deepEqual(await second,data);assert.equal(digests,1);
});
