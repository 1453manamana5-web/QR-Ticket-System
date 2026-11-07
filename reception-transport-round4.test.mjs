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
