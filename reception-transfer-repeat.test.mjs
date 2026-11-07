import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const event={eventId:'repeat-event',eventName:'Repeat',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'ready',dataVersion:1};
const payload={type:'qr-ticket-event-auth',eventId:event.eventId,eventName:event.eventName,dataVersion:1,authToken:'token'};
const canonical={...event,authToken:'token',receptionTarget:true,ticketCount:0};
const snapshot=value=>({exists:()=>value!==null,data:()=>value});
function harness({current=canonical,targets=[{id:event.eventId,value:canonical}],bundle={event,authToken:'token',ticketCount:0}}={}){
 const out={};const dependencies={'./firebaseClient':{getFirebaseDb:()=>({})},'firebase/firestore':{
  doc:(_db,...parts)=>parts.join('/'),collection:(_db,...parts)=>parts.join('/'),query:ref=>ref,where:()=>[],
  getDocFromServer:async ref=>snapshot(ref.startsWith('eventBundles/')?bundle:current),
  getDocsFromServer:async ref=>({docs:ref==='events'?targets.map(({id,value})=>({id,data:()=>value})):[]}),
 }};
 new Function('exports','require',ts.transpileModule(readFileSync('reception-app/src/eventDownloader.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,n=>dependencies[n]);return out;
}
test('a modern published bundle without reception policy cannot silently enable all gates',async()=>{
 await assert.rejects(harness().downloadEventData(payload,'T-REPEAT'),/EVENT_DATA_INVALID/);
});
test('legacy bundles without canonical events retain the documented default policy',async()=>{
 const result=await harness({current:null}).downloadEventData(payload,'T-REPEAT');
 assert.deepEqual(result.localEvent.settings,{entryEnabled:true,exitEnabled:true,reentryEnabled:true});
});
test('a malformed second active target cannot be hidden by choosing the valid event',async()=>{
 const targets=[{id:event.eventId,value:canonical},{id:'broken',value:{receptionTarget:true,eventStatus:'ready'}}];
 await assert.rejects(harness({targets}).getCurrentFirebaseEventAuthPayload(),/MULTIPLE_PUBLISHED_EVENTS/);
});
test('published metadata must belong to the document returned by the target query',async()=>{
 await assert.rejects(harness({targets:[{id:'different-event',value:canonical}]}).getCurrentFirebaseEventAuthPayload(),/INVALID_PUBLISHED_EVENT/);
});
test('malformed single active target is identified as invalid metadata',async()=>{
 await assert.rejects(harness({targets:[{id:event.eventId,value:{...canonical,eventName:''}}]}).getCurrentFirebaseEventAuthPayload(),/INVALID_PUBLISHED_EVENT/);
});
test('current publication tokens must be usable Firestore document IDs',async()=>{
 await assert.rejects(harness({targets:[{id:event.eventId,value:{...canonical,authToken:'bad/token'}}]}).getCurrentFirebaseEventAuthPayload(),/INVALID_PUBLISHED_EVENT/);
});
