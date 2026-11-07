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
function harness({read,ensure,globals={}}={}){
 const auth={currentUser:{uid}},storage=new Map([['qr-ticket-terminal-id',id]]),writes=[],reads=[];
 const get=async ref=>{reads.push(ref);return read?read(ref):snap(undefined);};
 const api={};
 const dependencies={'./firebaseClient':{ensureFirebaseAuth:()=>ensure?ensure(auth):Promise.resolve(auth),getFirebaseUid:async()=>auth.currentUser?.uid,getFirebaseDb:()=>({})},'./localDb':{},'firebase/firestore':{doc:(_db,...parts)=>parts.join('/'),getDoc:get,getDocFromServer:get,serverTimestamp:()=>({time:true}),runTransaction:async(_db,op)=>op({get,set:(ref,data)=>writes.push({ref,data})})}};
 const vars={localStorage:{getItem:key=>storage.get(key)??null},...globals};
 new Function('exports','require',...Object.keys(vars),ts.transpileModule(readFileSync('reception-app/src/receptionSync.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(api,n=>dependencies[n],...Object.values(vars));
 return {api,auth,storage,writes,reads};
}
const errorLog={errorId:'repeat-error',eventId:'repeat-event',terminalId:id,category:'save_failed',mode:'entry',timestamp:'2026-11-07T01:00:00.000Z'};
for(const change of ['terminal','auth','deadline'])test(`pending error upload stops after ${change} changes`,async()=>{
 const wait=deferred(),time=clock();let reading=false;
 const h=harness({globals:time,read:async()=>{reading=true;return wait.promise;}});
 const result=h.api.syncReceptionErrorLog(errorLog);await until(()=>reading);
 if(change==='terminal')h.storage.set('qr-ticket-terminal-id','T-OTHER-01');
 else if(change==='auth')h.auth.currentUser={uid:'new-user'};
 else {time.fire();await assert.rejects(result,e=>e.code==='deadline-exceeded');}
 wait.resolve(snap(undefined));
 if(change!=='deadline')await assert.rejects(result,/RECEPTION_TERMINAL_CHANGED|RECEPTION_AUTH_CHANGED/);
 for(let i=0;i<4;i++)await tick();
 assert.equal(h.writes.length,0);
});
test('a mismatched saved error identity is not acknowledged as the requested upload',async()=>{
 const h=harness({read:async()=>snap({...errorLog,errorId:'wrong-id'})});
 await assert.rejects(h.api.syncReceptionErrorLog(errorLog),/RECEPTION_ERROR_ID_COLLISION/);
});
for(const change of ['terminal','auth'])test(`latest ticket cannot return from an obsolete ${change} identity`,async()=>{
 const wait=deferred();let reading=false;
 const h=harness({read:async()=>{reading=true;return wait.promise;}});
 const result=h.api.getLatestReceptionTicket('repeat-event','ticket');await until(()=>reading);
 if(change==='terminal')h.storage.set('qr-ticket-terminal-id','T-OTHER-01');else h.auth.currentUser={uid:'new-user'};
 wait.resolve(snap({ticketId:'ticket',eventId:'repeat-event'}));
 await assert.rejects(result,/RECEPTION_TERMINAL_CHANGED|RECEPTION_AUTH_CHANGED/);
});
test('expired latest-ticket auth restoration cannot start a new server read',async()=>{
 const wait=deferred(),time=clock(),h=harness({ensure:()=>wait.promise,globals:time});
 const result=h.api.getLatestReceptionTicket('repeat-event','ticket');time.fire();
 await assert.rejects(result,e=>e.code==='deadline-exceeded');
 wait.resolve(h.auth);for(let i=0;i<4;i++)await tick();assert.equal(h.reads.length,0);
});
test('control subscription rejects a reply captured under an older auth identity',async()=>{
 const wait=deferred();let terminalRead=false,modeCalls=0,error;
 const h=harness({read:async ref=>{
  if(ref.startsWith('terminalInstallations/'))return snap({authUid:uid,terminalId:id,approved:true});
  terminalRead=true;return wait.promise;
 }});
 const close=h.api.subscribeTerminalControl(id,()=>modeCalls++,e=>error=e);
 await until(()=>terminalRead);h.auth.currentUser={uid:'new-user'};
 wait.resolve(snap({approved:true,desiredMode:'入口受付',desiredModeUpdatedAt:'now'}));
 for(let i=0;i<6;i++)await tick();close();
 assert.equal(modeCalls,0);assert.equal(error?.code,'cancelled');
});

test('known auth identity lookup stays synchronous and does not initialize or sign in',async()=>{
 const wait=deferred(),auth={currentUser:null,authStateReady:()=>wait.promise};let starts=0,signIns=0;
 const source=readFileSync('reception-app/src/firebaseClient.ts','utf8').replace(/import\.meta\.env\.[A-Z_]+/g,'"test-config"');
 const client={},deps={'firebase/app':{getApps:()=>[{}],getApp:()=>({})},'firebase/auth':{getAuth:()=>{starts++;return auth;},signInAnonymously:async()=>{signIns++;}},'firebase/firestore':{}};
 new Function('exports','require',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(client,n=>deps[n]);
 assert.equal(client.getKnownFirebaseUid(),undefined);assert.equal(starts,0);
 const ready=client.ensureFirebaseAuth();assert.equal(client.getKnownFirebaseUid(),undefined);
 auth.currentUser={uid};wait.resolve();await ready;
 assert.equal(client.getKnownFirebaseUid(),uid);
 auth.currentUser={uid:'new-user'};assert.equal(client.getKnownFirebaseUid(),'new-user');
 auth.currentUser=null;assert.equal(client.getKnownFirebaseUid(),null);
 assert.equal(starts,1);assert.equal(signIns,0);
});
