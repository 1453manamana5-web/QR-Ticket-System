import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {IDBFactory} from 'fake-indexeddb';
const require=createRequire(import.meta.url),ts=require('typescript');
function load(file,deps={},globals={}){
  const out={};
  new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,name=>{
    if(name in deps)return deps[name];
    if(name==='../../shared/src/receptionTiming')return load('shared/src/receptionTiming.ts');
    throw Error('Unexpected import '+name);
  },...Object.values(globals));
  return out;
}
const localEvent=(extra={})=>({event:{eventId:'queue-event',eventName:'Queue event',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'active',dataVersion:1},settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},terminalId:'T-QUEUE-ORIGINAL',authenticatedAt:'2026-11-07T00:00:00.000Z',dataReady:false,ticketCount:1,...extra});
const ticket=(id='one')=>({ticketId:id,eventId:'queue-event',basicInfo:{},currentStatus:'unused',valid:true,updatedAt:'2026-11-06T00:00:00.000Z'});
const record=(id,ticketId='one',type='entry')=>({recordId:id,eventId:'queue-event',ticketId,terminalId:'T-QUEUE-ORIGINAL',type,timestamp:'2026-11-07T01:00:00.000Z'});
const localDb=(indexedDB=new IDBFactory())=>load('reception-app/src/localDb.ts',{}, {indexedDB});
const worker=(local,syncReceptionRecord,navigator={onLine:true})=>load('reception-app/src/syncQueue.ts',{'./localDb':local,'./receptionSync':{syncReceptionRecord}},{navigator,console:{error(){}}});
async function queueRow(factory,id){
  return new Promise((resolve,reject)=>{
    const request=factory.open('qr-ticket-reception');
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction('syncQueue','readonly'),row=tx.objectStore('syncQueue').get(id);
      tx.oncomplete=()=>{resolve(row.result);db.close();};tx.onerror=tx.onabort=()=>{reject(tx.error);db.close();};
    };
  });
}

test('pending and acknowledged production state survives a later cached opening',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const rec=record('accepted');await local.saveReceptionTransaction(ticket(),rec);
 const saved=await local.loadLocalEvent();await local.saveLocalEvent({...saved,event:{...saved.event,startTime:'12:00'}});
 assert.equal((await local.getTicket('one')).currentStatus,'inside');
 await local.markSyncStatus(rec.recordId,'synced',0,'saved');
 assert.equal((await local.getTicket('one')).currentStatus,'inside');
});
test('canonical trial acknowledgement resets only its exact local transition and retains history',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const rec=record('trial');await local.saveReceptionTransaction(ticket(),rec);
 await local.markSyncStatus(rec.recordId,'synced',0,'trial');
 assert.equal((await local.getTicket('one')).currentStatus,'unused');
 assert.equal((await local.getReceptionRecord(rec.recordId)).recordId,rec.recordId);
});
test('a late canonical trial acknowledgement cannot reset a newer accepted exit',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const rec=record('trial');await local.saveReceptionTransaction(ticket(),rec);
 const next={...record('later','one','exit'),timestamp:'2026-11-07T01:01:00.000Z'};
 await local.saveReceptionTransaction(ticket(),next);
 await local.markSyncStatus(rec.recordId,'synced',0,'trial');
 assert.equal((await local.getTicket('one')).currentStatus,'exited');
});

test('a downloaded inventory cannot roll back an entry acknowledged while its snapshot was in flight',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const token=await local.getLocalPreparationToken();
 const accepted=record('acknowledged-during-download');
 await local.saveReceptionTransaction(ticket(),accepted,await local.getTicket('one'));
 await local.markSyncStatus(accepted.recordId,'synced',0,'saved');
 await assert.rejects(local.prepareLocalEventData(localEvent(),[ticket()],token),/LOCAL_EVENT_CHANGED/);
 assert.equal((await local.getTicket('one')).currentStatus,'inside');
 assert.equal((await local.getPendingSyncItems()).length,0);
 assert.deepEqual(await local.getReceptionRecord(accepted.recordId),accepted);
});

test('a stale inventory cannot remove a newly discovered ticket after its receipt has already synced',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const token=await local.getLocalPreparationToken(),added=ticket('newly-issued'),accepted=record('new-ticket-ack','newly-issued');
 await local.saveReceptionTransaction(added,accepted,null);
 await local.markSyncStatus(accepted.recordId,'synced',0,'saved');
 await assert.rejects(local.prepareLocalEventData(localEvent(),[ticket()],token),/LOCAL_EVENT_CHANGED/);
 assert.equal((await local.loadLocalEvent(true)).ticketCount,2);
 assert.equal((await local.getTicket('newly-issued')).currentStatus,'inside');
 assert.deepEqual(await local.getReceptionRecord(accepted.recordId),accepted);
});

test('an unchanged preparation token permits newer canonical state without replaying acknowledged local history',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const accepted=record('old-local-entry');await local.saveReceptionTransaction(ticket(),accepted);
 await local.markSyncStatus(accepted.recordId,'synced',0,'saved');
 const token=await local.getLocalPreparationToken();
 // The later server transition may have an earlier device timestamp.
 const canonical={...ticket(),currentStatus:'exited',updatedAt:'2026-11-07T00:30:00.000Z'};
 await local.prepareLocalEventData(localEvent(),[canonical],token);
 assert.equal((await local.getTicket('one')).currentStatus,'exited');
 assert.deepEqual(await local.getReceptionRecord(accepted.recordId),accepted);
});

test('background retry bookkeeping cannot invalidate an otherwise unchanged preparation token',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const accepted=record('failed-upload');await local.saveReceptionTransaction(ticket(),accepted);
 const token=await local.getLocalPreparationToken();
 await local.markSyncStatus(accepted.recordId,'failed',3);
 assert.equal(await local.getLocalPreparationToken(),token);
 await local.prepareLocalEventData(localEvent(),[{...ticket(),valid:false}],token);
 assert.equal((await local.getTicket('one')).valid,false);
 assert.equal((await local.getTicket('one')).currentStatus,'inside');
 assert.equal((await local.getPendingSyncItems())[0].retryCount,3);
});

test('a canonical trial acknowledgement during download cannot be undone by that downloaded inventory',async()=>{
 const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
 const accepted=record('canonical-trial');await local.saveReceptionTransaction(ticket(),accepted);
 const token=await local.getLocalPreparationToken();
 await local.markSyncStatus(accepted.recordId,'synced',0,'trial');
 const stale={...ticket(),currentStatus:'inside',updatedAt:accepted.timestamp};
 await assert.rejects(local.prepareLocalEventData(localEvent(),[stale],token),/LOCAL_EVENT_CHANGED/);
 assert.equal((await local.getTicket('one')).currentStatus,'unused');
 assert.equal((await local.getPendingSyncItems()).length,0);
});

test('a preparation token cannot replace an event installed by another tab during download',async()=>{
 const factory=new IDBFactory(),first=localDb(factory),other=localDb(factory);
 await first.prepareLocalEventData(localEvent(),[ticket()]);
 const token=await first.getLocalPreparationToken();
 const next=localEvent({event:{...localEvent().event,eventId:'another-event'}});
 await other.prepareLocalEventData(next,[{...ticket(),eventId:'another-event'}]);
 await assert.rejects(first.prepareLocalEventData(localEvent(),[ticket()],token),/LOCAL_EVENT_CHANGED/);
 assert.equal((await first.loadLocalEvent(true)).event.eventId,'another-event');
});
