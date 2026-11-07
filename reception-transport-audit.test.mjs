import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {setImmediate as tick} from 'node:timers/promises';

const ts=createRequire(import.meta.url)('typescript');
const terminalId='T-TRANSPORT-01',eventId='transport-event',uid='transport-user';
const event={eventId,eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'active',receptionTarget:true};
const receipt=(changes={})=>({recordId:'transport-entry',eventId,ticketId:'ticket-one',terminalId,type:'entry',timestamp:'2026-11-07T00:00:00.000Z',...changes});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const snapshot=(ref,data)=>({id:ref.split('/').at(-1),exists:()=>data!==undefined,data:()=>data});
async function until(check){for(let i=0;i<100&&!check();i++)await tick();assert.equal(Boolean(check()),true,'expected async operation to reach its checkpoint');}
function clock(){let id=0;const pending=new Map();return {
  setTimeout:(fn,ms)=>{pending.set(++id,{fn,ms});return id;},clearTimeout:id=>pending.delete(id),
  fire:()=>{const [id,{fn}]=pending.entries().next().value??[];assert.ok(fn,'deadline is scheduled');pending.delete(id);fn();},
};}
function harness(options={}){
  const documents=new Map([
    ['terminalInstallations/'+uid,{authUid:uid,approved:true,terminalId}],
    ['terminals/'+terminalId,{terminalId,approved:true,receptionApproved:true,role:'reception',status:'online',name:'Entrance'}],
    ['events/'+eventId,{...event}],
    [`events/${eventId}/receptionApprovals/${terminalId}`,{eventId,terminalId,requestedByUid:uid,status:'approved'}],
    [`events/${eventId}/tickets/ticket-one`,{eventId,ticketId:'ticket-one',valid:true,currentStatus:'unused'}],
  ]);
  const storage=new Map([['qr-ticket-terminal-id',terminalId],['qr-ticket-device-id',terminalId]]);
  const auth={currentUser:{uid}},reads=[],writes=[];
  let attempts=0,commits=0;
  const get=async ref=>{reads.push(ref);return options.read?options.read(ref,documents):snapshot(ref,structuredClone(documents.get(ref)));};
  const list=ref=>({docs:[...documents].filter(([key])=>key.startsWith(ref+'/')&&!key.slice(ref.length+1).includes('/')).map(([key,data])=>snapshot(key,structuredClone(data)))});
  const firestore={
    doc:(_db,...path)=>path.join('/'),collection:(_db,...path)=>path.join('/'),query:ref=>ref,where:()=>[],limit:()=>[],
    getDoc:get,getDocFromServer:get,getDocs:async()=>({docs:[]}),
    getDocsFromServer:async ref=>options.list?options.list(ref,documents):list(ref),
    serverTimestamp:()=>({serverTimestamp:true}),
    updateDoc:async(ref,data)=>{writes.push({ref,data});Object.assign(documents.get(ref),data);if(options.update)await options.update(ref,data,writes.length);},
    runTransaction:async(_db,callback)=>{
      for(let retry=0;retry<5;retry++){
        attempts++;
        const readVersions=new Map(),pending=[];
        const result=await callback({
          get:async ref=>{const value=await get(ref);readVersions.set(ref,JSON.stringify(value.data()));return value;},
          update:(ref,data)=>pending.push({ref,data,update:true}),set:(ref,data)=>pending.push({ref,data}),
        });
        await options.beforeCommit?.({documents,attempts,pending});
        if([...readVersions].some(([ref,version])=>JSON.stringify(documents.get(ref))!==version))continue;
        for(const write of pending){writes.push(write);if(write.update)Object.assign(documents.get(write.ref),write.data);else documents.set(write.ref,{...write.data});}
        if(pending.length)commits++;
        await options.afterCommit?.({commits,pending});
        return result;
      }
      throw Error('transaction retry budget exhausted');
    },
  };
  const dependencies={'firebase/firestore':firestore,'./firebaseClient':{getFirebaseDb:()=>({}),ensureFirebaseAuth:async()=>auth,getFirebaseUid:async()=>auth.currentUser?.uid},'./localDb':{getPendingSyncItems:async()=>[],getPendingReceptionErrorLogs:async()=>[],...options.local}};
  const api={},globals={localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)},navigator:{connection:{downlink:20}},...options.globals};
  new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync('reception-app/src/receptionSync.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api,name=>dependencies[name],...Object.values(globals));
  return {api,documents,storage,auth,reads,writes,attempts:()=>attempts,commits:()=>commits};
}

test('canonical opening excludes retained trial records without local event data and accepts the exact opening',async()=>{
  const h=harness();
  await h.api.syncReceptionRecord(receipt({timestamp:'2026-11-06T23:59:59.999Z'}));
  assert.equal(h.writes.length,0);
  assert.equal(h.documents.get(`events/${eventId}/tickets/ticket-one`).currentStatus,'unused');
  await h.api.syncReceptionRecord(receipt());
  assert.equal(h.commits(),1);
  assert.equal(h.documents.get(`events/${eventId}/tickets/ticket-one`).currentStatus,'inside');
});

test('missing, malformed and unreadable canonical schedules never acknowledge an unsent receipt',async()=>{
  for(const change of [null,{eventDate:'2026-11-31'},{eventDate:'2026-02-29'},{startTime:'24:00'},{eventId:'another-event'}]){
    const h=harness();
    if(change===null)h.documents.delete('events/'+eventId);else Object.assign(h.documents.get('events/'+eventId),change);
    await assert.rejects(h.api.syncReceptionRecord(receipt()),/RECEPTION_EVENT_NOT_FOUND|INVALID_RECEPTION_EVENT/);
    assert.equal(h.writes.length,0);
  }
  const denied=Object.assign(Error('no access'),{code:'permission-denied'});
  const h=harness({read:async(ref,documents)=>{if(ref==='events/'+eventId)throw denied;return snapshot(ref,documents.get(ref));}});
  await assert.rejects(h.api.syncReceptionRecord(receipt()),error=>error===denied);
  assert.equal(h.writes.length,0);
});

test('a timetable edit between transaction read and commit rechecks the trial boundary',async()=>{
  const h=harness({beforeCommit:({documents,attempts})=>{if(attempts===1)documents.set('events/'+eventId,{...event,startTime:'10:00'});}});
  await h.api.syncReceptionRecord(receipt({timestamp:'2026-11-07T00:30:00.000Z'}));
  assert.equal(h.attempts(),2);
  assert.equal(h.writes.length,0);
  assert.equal(h.documents.has(`events/${eventId}/receptionRecords/transport-entry`),false);
});

test('concurrent deliveries of one receipt converge directly to one ticket transition',async()=>{
  const h=harness();
  await Promise.all(Array.from({length:12},()=>h.api.syncReceptionRecord(receipt())));
  assert.equal(h.commits(),1);
  assert.equal(h.writes.filter(write=>write.update).length,1);
  assert.equal([...h.documents.keys()].filter(ref=>ref.includes('/receptionRecords/')).length,1);
});

test('an exact saved receipt acknowledges a lost reply without touching the ticket or requiring the old event',async()=>{
  const h=harness();
  h.documents.set(`events/${eventId}/receptionRecords/transport-entry`,receipt());
  h.documents.delete('events/'+eventId);
  await h.api.syncReceptionRecord(receipt());
  assert.equal(h.writes.length,0);
  h.documents.get(`events/${eventId}/receptionRecords/transport-entry`).recordId='wrong-identity';
  await assert.rejects(h.api.syncReceptionRecord(receipt()),/RECEPTION_RECORD_ID_COLLISION/);
});

test('a timed-out committed transaction retries by receipt ID without a second status update',async()=>{
  const time=clock();
  const h=harness({globals:time,afterCommit:({commits,pending})=>commits===1&&pending.length?new Promise(()=>{}):undefined});
  const first=h.api.syncReceptionRecord(receipt());
  await until(()=>h.commits()===1);time.fire();
  await assert.rejects(first,error=>error.code==='deadline-exceeded');
  await h.api.syncReceptionRecord(receipt());
  assert.equal(h.commits(),1);
  assert.equal(h.writes.filter(write=>write.update).length,1);
});

test('a transaction retry after its deadline cannot start another late write attempt',async()=>{
  const time=clock(),wait=deferred();let paused=false;
  const h=harness({globals:time,beforeCommit:async({documents,attempts})=>{if(attempts===1){paused=true;await wait.promise;documents.set('events/'+eventId,{...event,startTime:'08:00'});}}});
  const first=h.api.syncReceptionRecord(receipt());
  await until(()=>paused);time.fire();
  await assert.rejects(first,error=>error.code==='deadline-exceeded');
  wait.resolve();for(let i=0;i<5;i++)await tick();
  assert.equal(h.writes.length,0);
});

for(const change of ['terminal','auth']){
  test(`receipt reads cannot commit after the ${change} identity changes`,async()=>{
    const wait=deferred();let reading=false;
    const h=harness({read:async(ref,documents)=>{if(ref.includes('/receptionRecords/')){reading=true;await wait.promise;}return snapshot(ref,documents.get(ref));}});
    const result=h.api.syncReceptionRecord(receipt());
    await until(()=>reading);
    if(change==='terminal')h.storage.set('qr-ticket-terminal-id','T-ANOTHER-01');else h.auth.currentUser={uid:'another-user'};
    wait.resolve();
    await assert.rejects(result,/RECEPTION_TERMINAL_CHANGED|RECEPTION_AUTH_CHANGED/);
    assert.equal(h.writes.length,0);
  });
}

test('unsubscribing a registration read prevents late identity and approval writes',async()=>{
  const wait=deferred();let listing=false,callbacks=0;
  const h=harness({list:async ref=>{listing=true;return wait.promise;}});
  h.storage.set('qr-ticket-terminal-id','T-CACHED-01');h.storage.set('qr-ticket-device-id','T-CACHED-01');
  h.documents.delete(`events/${eventId}/receptionApprovals/${terminalId}`);
  const unsubscribe=h.api.subscribeTerminalRegistration(()=>{callbacks++;},()=>{callbacks++;});
  await until(()=>listing);unsubscribe();
  wait.resolve({docs:[snapshot('events/'+eventId,event)]});
  for(let i=0;i<8;i++)await tick();
  assert.equal(callbacks,0);
  assert.equal(h.storage.get('qr-ticket-terminal-id'),'T-CACHED-01');
  assert.equal(h.writes.length,0);
});

for(const change of ['terminal','auth']){
  test(`a late approval lookup cannot overwrite a renewed ${change} identity`,async()=>{
    const wait=deferred();let listing=false;
    const h=harness({list:async()=>{listing=true;return wait.promise;}});
    const result=h.api.getTerminalRegistration();
    await until(()=>listing);
    if(change==='terminal'){
      h.storage.set('qr-ticket-terminal-id','T-ANOTHER-01');h.storage.set('qr-ticket-device-id','T-ANOTHER-01');
    }else h.auth.currentUser={uid:'another-user'};
    wait.resolve({docs:[snapshot('events/'+eventId,event)]});
    await assert.rejects(result,error=>error.code==='cancelled');
    assert.equal(h.storage.get('qr-ticket-terminal-id'),change==='terminal'?'T-ANOTHER-01':terminalId);
  });
}

test('a slow stopped heartbeat cannot overwrite a newer active report and pending count',async()=>{
  const wait=deferred();let reading=false;
  const h=harness({local:{getPendingReceptionErrorLogs:async()=>{reading=true;return wait.promise;}}});
  const old=h.api.saveTerminalHeartbeat(terminalId,'stopped',undefined,eventId);
  await until(()=>reading);
  await h.api.saveTerminalHeartbeat(terminalId,'entry',5,eventId);
  wait.resolve([]);
  await assert.rejects(old,error=>error.code==='cancelled');
  const saved=h.documents.get('terminals/'+terminalId);
  assert.equal(saved.receptionMode,'entry');assert.equal(saved.syncPendingCount,5);
  assert.equal(h.writes.some(write=>write.data.receptionMode==='stopped'),false);
});

test('an older acknowledged heartbeat cannot issue its mode update after a newer report',async()=>{
  const wait=deferred();let first=false;
  const h=harness({update:async(_ref,data,index)=>{if(index===1){first=true;await wait.promise;}}});
  const old=h.api.saveTerminalHeartbeat(terminalId,'stopped',0,eventId);
  await until(()=>first);
  await h.api.saveTerminalHeartbeat(terminalId,'exit',2,eventId);
  wait.resolve();await assert.rejects(old,error=>error.code==='cancelled');
  assert.deepEqual(h.writes.filter(write=>'mode' in write.data).map(write=>write.data.mode),['出口受付']);
  assert.equal(h.documents.get('terminals/'+terminalId).syncPendingCount,2);
});
