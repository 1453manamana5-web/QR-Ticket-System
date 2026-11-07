import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {IDBFactory} from 'fake-indexeddb';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(path,deps={},globals={}){
 const out={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,name=>{
  if(name in deps)return deps[name];
  if(name==='../../shared/src/receptionTiming')return load('shared/src/receptionTiming.ts');
  throw Error('Unexpected dependency '+name);
 },...Object.values(globals));return out;
}
const event={eventId:'repeat-event',eventName:'Repeat',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1};
const ticket={eventId:event.eventId,ticketId:'one',basicInfo:{},currentStatus:'unused',valid:true,updatedAt:'2026-11-06T00:00:00.000Z'};
const record={recordId:'accepted-entry',eventId:event.eventId,ticketId:'one',terminalId:'T-REPEAT-DEVICE',type:'entry',timestamp:'2026-11-07T00:30:00.000Z'};
async function pendingWithLaterLocalOpening(){
 const local=load('reception-app/src/localDb.ts',{}, {indexedDB:new IDBFactory()});
 await local.prepareLocalEventData({event,settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},terminalId:record.terminalId,authenticatedAt:'2026-11-07T00:00:00.000Z',dataReady:false,ticketCount:1},[ticket]);
 await local.saveReceptionTransaction({...ticket,currentStatus:'inside',updatedAt:record.timestamp},record,ticket);
 const cached=await local.loadLocalEvent();
 await local.saveLocalEvent({...cached,event:{...cached.event,startTime:'10:00'}});
 return local;
}
function worker(local,sync){return load('reception-app/src/syncQueue.ts',{'./localDb':local,'./receptionSync':{syncReceptionRecord:sync}},{navigator:{onLine:true},console:{error(){}}});}

test('a later cached opening cannot silently discard a canonically valid unsent visit',async()=>{
 const local=await pendingWithLaterLocalOpening();let canonicalChecks=0,serverWrites=0;
 const queue=worker(local,async receipt=>{
  canonicalChecks++;
  if(Date.parse(receipt.timestamp)>=Date.parse(event.eventDate+'T'+event.startTime+':00+09:00'))serverWrites++;
 });
 await queue.syncPendingReceptionRecords();
 assert.equal(canonicalChecks,1);assert.equal(serverWrites,1);
 assert.equal((await local.getPendingSyncItems()).length,0);
 assert.deepEqual(await local.getReceptionRecord(record.recordId),record);
});

test('a cached trial classification cannot acknowledge a receipt when canonical verification is unavailable',async()=>{
 const local=await pendingWithLaterLocalOpening();let attempts=0;
 await worker(local,async()=>{attempts++;throw Object.assign(Error('offline'),{code:'unavailable'});}).syncPendingReceptionRecords();
 assert.equal(attempts,1);
 const pending=await local.getPendingSyncItems();assert.equal(pending.length,1);assert.equal(pending[0].status,'failed');
 assert.deepEqual(await local.getReceptionRecord(record.recordId),record);
});

test('recoverable receipt uploads do not depend on loading the active inventory metadata',async()=>{
 const local=await pendingWithLaterLocalOpening();let uploads=0;
 const damagedMetadata={...local,loadLocalEvent:async()=>{throw Error('LOCAL_EVENT_INCOMPLETE');}};
 await worker(damagedMetadata,async()=>{uploads++;}).syncPendingReceptionRecords();
 assert.equal(uploads,1);assert.equal((await local.getPendingSyncItems()).length,0);
});
