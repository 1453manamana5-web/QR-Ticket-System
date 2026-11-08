import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {setImmediate as tick} from 'node:timers/promises';
const ts=createRequire(import.meta.url)('typescript');
const id='T-REPEAT-01',uid='repeat-user';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const snap=value=>({exists:()=>value!==undefined,data:()=>value});
async function until(check){for(let n=0;n<50&&!check();n++)await tick();assert.ok(check());}
function clock(){let next=0;const timers=new Map();return {setTimeout:fn=>{timers.set(++next,fn);return next;},clearTimeout:id=>timers.delete(id),fire(){const [id,fn]=timers.entries().next().value;timers.delete(id);fn();}};}
function harness({read,ensure,getUid,globals={}}={}){
 const auth={currentUser:{uid}},storage=new Map([['qr-ticket-terminal-id',id]]),writes=[],reads=[];
 const get=async ref=>{reads.push(ref);return read?read(ref):snap(undefined);};
 const api={};
 const dependencies={'./firebaseClient':{ensureFirebaseAuth:()=>ensure?ensure(auth):Promise.resolve(auth),getFirebaseUid:async()=>getUid?getUid(auth):auth.currentUser?.uid,getKnownFirebaseUid:()=>auth.currentUser?.uid??null,getFirebaseDb:()=>({})},'./localDb':{},'firebase/firestore':{doc:(_db,...parts)=>parts.join('/'),getDoc:get,getDocFromServer:get,serverTimestamp:()=>({time:true}),runTransaction:async(_db,op)=>op({get,set:(ref,data)=>writes.push({ref,data})})}};
 const vars={localStorage:{getItem:key=>storage.get(key)??null},...globals};
 new Function('exports','require',...Object.keys(vars),ts.transpileModule(readFileSync('reception-app/src/receptionSync.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api,n=>dependencies[n],...Object.values(vars));
 return {api,auth,storage,writes,reads};
}
for(const method of ['registerReceptionTerminal','resetReceptionTerminalRegistration','requestReceptionEventReapproval'])test(method+' stops follow-up work after its auth deadline',async()=>{
 const wait=deferred(),time=clock(),h=harness({ensure:()=>wait.promise,globals:time});
 const operation=h.api[method]('Name');time.fire();await assert.rejects(operation,e=>e.code==='deadline-exceeded');
 wait.resolve(h.auth);for(let i=0;i<5;i++)await tick();assert.equal(h.reads.length,0);assert.equal(h.writes.length,0);
});

const validTicket=()=>({ticketId:'ticket',eventId:'repeat-event',basicInfo:{},currentStatus:'unused',valid:true,updatedAt:'2026-11-07T00:00:00.000Z'});
for(const ids of [['event/path/child','ticket'],['repeat-event','ticket/path/child'],['X'.repeat(161),'ticket'],['repeat-event','X'.repeat(161)],[null,'ticket'],['repeat-event',null],['   ','ticket'],['repeat-event','   ']])test('latest-ticket lookup rejects malformed IDs before auth or reads: '+JSON.stringify(ids).slice(0,75),async()=>{
 let auth=0;const h=harness({ensure:a=>{auth++;return Promise.resolve(a);}});
 await assert.rejects(h.api.getLatestReceptionTicket(...ids),/INVALID_RECEPTION_TICKET_ID/);
 assert.equal(auth,0);assert.equal(h.reads.length,0);assert.equal(h.storage.get('qr-ticket-terminal-id'),id);
});
for(const changes of [{ticketId:'different'},{eventId:'different'},{valid:'true'},{currentStatus:'broken'},{basicInfo:null},{updatedAt:'invalid'}])test('latest-ticket lookup rejects malformed server data: '+JSON.stringify(changes),async()=>{
 const h=harness({read:async()=>snap({...validTicket(),...changes})});
 await assert.rejects(h.api.getLatestReceptionTicket('repeat-event','ticket'),/INVALID_RECEPTION_TICKET_DATA/);
 assert.equal(h.storage.get('qr-ticket-terminal-id'),id);
});
test('latest-ticket lookup keeps a validated canonical ticket usable',async()=>{
 const h=harness({read:async()=>snap(validTicket())});
 assert.deepEqual(await h.api.getLatestReceptionTicket('repeat-event','ticket'),validTicket());
});
test('latest-ticket lookup returns null for a genuinely absent ticket',async()=>{
 const h=harness();assert.equal(await h.api.getLatestReceptionTicket('repeat-event','missing'),null);
});

function applicationHarness({owned=false}={}){
 const pendingId='T-ZZZZZZZZ',documents=new Map(),writes=[];
 for(let i=0;i<5;i++)documents.set('terminalApplications/T-0000000'+i,{terminalId:'T-0000000'+i,requestedByUid:uid,status:'approved',name:'Historical'});
 documents.set('terminalApplications/'+pendingId,{terminalId:pendingId,requestedByUid:uid,status:'pending',name:'Current application'});
 documents.set('terminals/'+pendingId,{terminalId:pendingId,requestedByUid:uid,approved:false,receptionApproved:false,managementApproved:false,role:'reception',status:'pending',name:'Current application'});
 if(owned)documents.set('terminalInstallations/'+uid,{authUid:uid,approved:true,terminalId:pendingId});
 const auth={currentUser:{uid}},storage=new Map([['qr-ticket-terminal-id',owned?pendingId:id]]);
 const snapshot=(ref,value)=>({id:ref.split('/').at(-1),exists:()=>value!==undefined,data:()=>value});
 const get=async ref=>snapshot(ref,documents.get(ref));
 const list=async ({path,constraints})=>{
  let rows=[...documents].filter(([ref])=>ref.startsWith(path+'/')&&!ref.slice(path.length+1).includes('/')).sort(([a],[b])=>a.localeCompare(b));
  for(const constraint of constraints.filter(item=>item.type==='where'))rows=rows.filter(([,data])=>data[constraint.field]===constraint.value);
  for(const constraint of constraints.filter(item=>item.type==='limit'))rows=rows.slice(0,constraint.value);
  return {docs:rows.map(([ref,value])=>snapshot(ref,value))};
 };
 const firestore={doc:(_db,...parts)=>parts.join('/'),collection:(_db,...parts)=>parts.join('/'),where:(field,operator,value)=>({type:'where',field,operator,value}),limit:value=>({type:'limit',value}),query:(path,...constraints)=>({path,constraints}),getDoc:get,getDocFromServer:get,getDocs:list,getDocsFromServer:list,
  runTransaction:async(_db,op)=>op({get,delete:ref=>{writes.push({ref,deleted:true});documents.delete(ref);},update:(ref,data)=>{writes.push({ref,data});Object.assign(documents.get(ref),data);}}),
  writeBatch:()=>({set:(ref,data)=>writes.push({ref,data}),commit:async()=>{}}),
 };
 const api={},dependencies={'firebase/firestore':firestore,'./localDb':{},'./firebaseClient':{ensureFirebaseAuth:async()=>auth,getFirebaseUid:async()=>uid,getKnownFirebaseUid:()=>uid,getFirebaseDb:()=>({})}};
 new Function('exports','require','localStorage',ts.transpileModule(readFileSync('reception-app/src/receptionSync.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api,n=>dependencies[n],{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)});
 return {api,documents,writes,pendingId};
}

for(const owned of [false,true])test('five completed applications cannot hide the current '+(owned?'owned reapplication':'pending registration'),async()=>{
 const h=applicationHarness({owned});
 assert.deepEqual(await h.api.getTerminalRegistration(),{approved:false,status:'pending',name:'Current application',...(owned?{eventId:undefined}:{})});
});

test('pending application reset still finds the active request after five completed applications',async()=>{
 const h=applicationHarness();await h.api.resetReceptionTerminalRegistration();
 assert.equal(h.documents.has('terminalApplications/'+h.pendingId),false);
 assert.equal(h.documents.has('terminals/'+h.pendingId),false);
 assert.equal(h.documents.size,5,'completed applications remain intact');
});

test('a hidden pending request still prevents duplicate terminal registration',async()=>{
 const h=applicationHarness();
 await assert.rejects(h.api.registerReceptionTerminal('Duplicate'),/TERMINAL_APPLICATION_ALREADY_PENDING/);
 assert.equal(h.writes.length,0);
});
