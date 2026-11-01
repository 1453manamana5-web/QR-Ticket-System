import assert from "node:assert/strict";
import {test} from "node:test";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {webcrypto} from "node:crypto";
const ts=createRequire(import.meta.url)("typescript");
function protocol(crypto=webcrypto){
  const out={};
  new Function("exports","crypto",ts.transpileModule(readFileSync(new URL("./shared/src/offlineTransfer.ts",import.meta.url),"utf8"),{
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
  }).outputText)(out,crypto);
  return out;
}
const data=()=>({event:{eventId:"offline-event",eventName:"Offline race",eventDate:"2026-11-01",startTime:"09:00",endTime:"17:00",eventStatus:"ready",dataVersion:1},
 settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},tickets:[]});
test("resetting while the previous QR digest is pending must preserve the next transfer",async()=>{
  const frames=await protocol().encodeOfflineEvent(data());
  let finish;
  const delayed={subtle:{digest:(...args)=>new Promise(resolve=>{finish=async()=>resolve(await webcrypto.subtle.digest(...args));})}};
  const collector=new (protocol(delayed).OfflineEventCollector)();
  for(const frame of frames.slice(0,-1))assert.equal(await collector.add(frame),null);
  const old=collector.add(frames.at(-1));
  assert.ok(finish);
  collector.reset();
  await collector.add(JSON.stringify({type:"qr-ticket-offline-v1",id:"a".repeat(64),index:0,total:2,data:"QQ=="}));
  await finish();
  assert.equal(await old,null);
  assert.deepEqual(collector.progress,{received:1,total:2});
});
test("offline events reject impossible calendar dates instead of accepting Date.parse rollover",()=>{
  const p=protocol();
  for(const eventDate of ["2026-02-29","2026-02-31","2026-04-31"]){
    assert.throws(()=>p.validateOfflineEvent({...data(),event:{...data().event,eventDate}}),/形式/);
  }
  assert.equal(p.validateOfflineEvent({...data(),event:{...data().event,eventDate:"2028-02-29"}}).event.eventDate,"2028-02-29");
});
