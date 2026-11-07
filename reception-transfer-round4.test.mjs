import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),ts=require('typescript');
const event={eventId:'repeat-event',eventName:'Repeat',eventDate:'2026-11-07',startTime:'09:00',endTime:'17:00',eventStatus:'ready',dataVersion:1};
const payload={type:'qr-ticket-event-auth',eventId:event.eventId,eventName:event.eventName,dataVersion:1,authToken:'token'};
const canonical={...event,authToken:'token',receptionTarget:true,ticketCount:0};
const snapshot=value=>({exists:()=>value!==null,data:()=>value});
for(const changed of ['other-user',null])test('download refuses identity change to '+changed,async()=>{
 let identity='original',release,begin,reads=0;const started=new Promise(r=>{begin=r;}),blocked=new Promise(r=>{release=r;});
 const deps={'./firebaseClient':{getFirebaseDb:()=>({}),getKnownFirebaseUid:()=>identity},'firebase/firestore':{doc:(_db,...p)=>p.join('/'),getDocFromServer:async()=>{reads++;begin();return blocked;}}},out={};
 new Function('exports','require',ts.transpileModule(readFileSync('reception-app/src/eventDownloader.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(out,n=>deps[n]);
 const operation=out.downloadEventData(payload,'T-REPEAT');await started;identity=changed;release(snapshot({event,authToken:'token',settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},ticketCount:0}));
 await assert.rejects(operation,e=>e.code==='cancelled');assert.equal(reads,1);
});
