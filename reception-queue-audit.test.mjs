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

test('a late failed tab cannot reopen an already synchronized receipt or rewind its attempt history',async()=>{
  const factory=new IDBFactory(),first=localDb(factory),second=localDb(factory);
  await first.prepareLocalEventData(localEvent(),[ticket()]);
  await first.saveReceptionTransaction(ticket(),record('shared-entry'));
  await first.markSyncStatus('shared-entry','synced',3);
  await second.markSyncStatus('shared-entry','failed',1);
  assert.equal((await first.getPendingSyncItems()).length,0);
  const row=await queueRow(factory,'shared-entry');
  assert.equal(row.status,'synced');assert.equal(row.retryCount,3);
});

test('late successful acknowledgement preserves the greatest retry count from another tab',async()=>{
  const factory=new IDBFactory(),local=localDb(factory);
  await local.prepareLocalEventData(localEvent(),[ticket()]);
  await local.saveReceptionTransaction(ticket(),record('retry-entry'));
  await local.markSyncStatus('retry-entry','failed',5);
  await local.markSyncStatus('retry-entry','synced',1);
  assert.equal((await queueRow(factory,'retry-entry')).retryCount,5);
  assert.equal((await local.getPendingSyncItems()).length,0);
});

test('an old terminal cannot commit a pending scan into the same event after its registration was replaced',async()=>{
  const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
  const expected=await local.getTicket('one');
  await local.prepareLocalEventData(localEvent({terminalId:'T-QUEUE-REPLACEMENT',authenticatedAt:'2026-11-07T00:30:00.000Z'}),[ticket()]);
  await assert.rejects(local.saveReceptionTransaction({...expected,currentStatus:'inside'},record('obsolete-terminal'),expected),/LOCAL_EVENT_CHANGED/);
  assert.equal((await local.getTicket('one')).currentStatus,'unused');
  assert.equal((await local.getPendingSyncItems()).length,0);
  assert.equal(await local.getReceptionRecord('obsolete-terminal'),null);
});

test('refresh cannot discard a newly discovered ticket while its accepted receipt is still pending',async()=>{
  const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
  const added=ticket('newly-issued');
  await local.saveReceptionTransaction({...added,currentStatus:'inside'},record('discovered-entry','newly-issued'),null);
  await assert.rejects(local.prepareLocalEventData(localEvent(),[ticket()]),/LOCAL_EVENT_PENDING_SYNC/);
  assert.equal((await local.loadLocalEvent(true)).ticketCount,2);
  assert.equal((await local.getTicket('newly-issued')).currentStatus,'inside');
  assert.equal((await local.getPendingSyncItems()).length,1);
  assert.ok(await local.getReceptionRecord('discovered-entry'));
});

for(const [type,status,setting] of [['entry','unused','entryEnabled'],['exit','inside','exitEnabled'],['reentry','exited','reentryEnabled']]){
  test(`a pending ${type} scan cannot commit after its policy was disabled in the same local event`,async()=>{
    const local=localDb(),original={...ticket(),currentStatus:status,updatedAt:'2026-11-07T00:30:00.000Z'};
    await local.prepareLocalEventData(localEvent(),[original]);
    const current=await local.loadLocalEvent();
    await local.saveLocalEvent({...current,settings:{...current.settings,[setting]:false}});
    await assert.rejects(local.saveReceptionTransaction({...original,currentStatus:type==='exit'?'exited':'inside'},record('disabled-policy','one',type),original),/LOCAL_RECEPTION_SETTINGS_CHANGED/);
    assert.equal((await local.getTicket('one')).currentStatus,status);
    assert.equal((await local.getPendingSyncItems()).length,0);
    assert.equal(await local.getReceptionRecord('disabled-policy'),null);
  });
}

for(const code of ['unavailable','deadline-exceeded','auth/network-request-failed']){
  test(`a ${code} connection failure pauses the drain before unrelated queued tickets time out`,async()=>{
    const local=localDb(),tickets=[ticket('one'),ticket('two'),ticket('three')];
    await local.prepareLocalEventData(localEvent({ticketCount:3}),tickets);
    for(const saved of tickets)await local.saveReceptionTransaction(saved,record('receipt-'+saved.ticketId,saved.ticketId));
    let failed=true;const uploads=[];
    const upload=worker(local,async item=>{uploads.push(item.recordId);if(failed)throw Object.assign(Error('blocked Wi-Fi'),{code});});
    await upload.syncPendingReceptionRecords();
    assert.deepEqual(uploads,['receipt-one']);
    assert.deepEqual((await local.getPendingSyncItems()).map(item=>[item.status,item.retryCount]),[['failed',1],['pending',0],['pending',0]]);
    failed=false;await upload.syncPendingReceptionRecords();
    assert.deepEqual(uploads,['receipt-one','receipt-one','receipt-two','receipt-three']);
    assert.equal((await local.getPendingSyncItems()).length,0);
  });
}

test('a request arriving during a failed connection does not recursively retry until a later trigger',async()=>{
  const local=localDb();await local.prepareLocalEventData(localEvent(),[ticket()]);
  await local.saveReceptionTransaction(ticket(),record('pending-entry'));
  let failed=true,joined,attempts=0;
  const upload=worker(local,async()=>{
    attempts++;
    if(failed){joined=upload.syncPendingReceptionRecords();throw Object.assign(Error('blocked Wi-Fi'),{code:'deadline-exceeded'});}
  });
  await upload.syncPendingReceptionRecords();await joined;
  assert.equal(attempts,1);
  assert.equal((await local.getPendingSyncItems()).length,1);
  failed=false;await upload.syncPendingReceptionRecords();
  assert.equal(attempts,2);assert.equal((await local.getPendingSyncItems()).length,0);
});

test('per-ticket conflicts preserve their ordering but do not starve another ticket',async()=>{
  const local=localDb();await local.prepareLocalEventData(localEvent({ticketCount:2}),[ticket('one'),ticket('two')]);
  await local.saveReceptionTransaction(ticket('one'),record('entry-one'));
  await local.saveReceptionTransaction(ticket('one'),record('exit-one','one','exit'));
  await local.saveReceptionTransaction(ticket('two'),record('entry-two','two'));
  const uploads=[];const upload=worker(local,async item=>{uploads.push(item.recordId);if(item.recordId==='entry-one')throw Object.assign(Error('ticket conflict'),{code:'failed-precondition'});});
  await upload.syncPendingReceptionRecords();
  assert.deepEqual(uploads,['entry-one','entry-two']);
  assert.deepEqual((await local.getPendingSyncItems()).map(item=>item.recordId),['entry-one','exit-one']);
});
