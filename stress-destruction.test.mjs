import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { webcrypto } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import * as firestore from "firebase/firestore";
import { IDBFactory } from "fake-indexeddb";
const ts = createRequire(import.meta.url)("typescript");
const { collection, doc, getDocFromServer, getDocsFromServer, setDoc, updateDoc } = firestore;
let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qr-ticket-stress-test",
    firestore: { rules: readFileSync(new URL("./firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1", port: 8080 },
  });
});
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [uid, terminalId, role] of [
      ["flow-manager", "T-FLOW-MANAGER", "management"], ["flow-reception", "T-FLOW-RECEPTION", "reception"],
    ]) {
      await setDoc(doc(db, "terminals", terminalId), {
        terminalId, requestedByUid: uid, role, approved: true,
        managementApproved: role === "management", receptionApproved: role === "reception",
        admin: role === "management", subAdmin: false,
      });
      await setDoc(doc(db, "terminalOwners", terminalId), { terminalId, ownerUid: uid, enabled: true });
      await setDoc(doc(db, "terminalInstallations", uid), { terminalId, authUid: uid, approved: true });
    }
  });
});
after(async () => env.cleanup());

function loadClientModule(file, db, uid, terminalId, local = {}, overrides = {}, storage = { getItem: () => terminalId, setItem: () => {} }) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const dependencies = {
    "firebase/firestore": { ...firestore, ...overrides },
    "./firebaseClient": { getFirebaseDb: () => db, ensureFirebaseAuth: async () => {}, getFirebaseUid: async () => uid },
    "./localDb": local,
    "./operationSafety": file.endsWith("operationSafety.ts") ? {} : loadClientModule("./management-app/src/operationSafety.ts", db, uid, terminalId),
  };
  // Run trusted application source in the SDK's realm: Firestore intentionally
  // rejects plain objects created with another vm context's Object prototype.
  new Function("exports", "require", "indexedDB", "crypto", "localStorage", "navigator", compiled)(
    exports, name => {
      if (name === "../../shared/src/receptionTiming") return loadClientModule("./shared/src/receptionTiming.ts", db, uid, terminalId);
      if (!(name in dependencies)) throw Error("Unexpected module " + name);
      return dependencies[name];
    },
    new IDBFactory(), webcrypto,
    storage,
    { userAgent: "flow test" },
  );
  return exports;
}
function clients() {
  const managerDb = env.authenticatedContext("flow-manager").firestore();
  const receptionDb = env.authenticatedContext("flow-reception").firestore();
  const local = loadClientModule("./reception-app/src/localDb.ts", receptionDb, "flow-reception", "T-FLOW-RECEPTION");
  return {
    managerDb, receptionDb, local,
    management: loadClientModule("./management-app/src/firebaseData.ts", managerDb, "flow-manager", "T-FLOW-MANAGER"),
    publisher: loadClientModule("./management-app/src/eventPublisher.ts", managerDb, "flow-manager", "T-FLOW-MANAGER"),
    downloader: loadClientModule("./reception-app/src/eventDownloader.ts", receptionDb, "flow-reception", "T-FLOW-RECEPTION"),
    reception: loadClientModule("./reception-app/src/receptionSync.ts", receptionDb, "flow-reception", "T-FLOW-RECEPTION", local),
  };
}
const settings = { entryEnabled: true, exitEnabled: true, reentryEnabled: true };
const makeEvent = (id = "flow-event") => ({
  eventId: id, eventName: "Integration test", eventDate: "2026-10-25",
  startTime: "09:00", endTime: "17:00", eventStatus: "preparing", dataVersion: 1,
});
const makeTicket = (eventId, ticketId = "ticket-1") => ({
  eventId, ticketId, basicInfo: { number: ticketId }, currentStatus: "unused",
  valid: true, updatedAt: "2026-10-25T00:00:00.000Z",
});
async function createPublished(c, event = makeEvent(), tickets = [makeTicket(event.eventId)], approveForFixture = true) {
  const active = await getDocsFromServer(firestore.query(collection(c.managerDb,"events"),firestore.where("receptionTarget","==",true)));
  for (const target of active.docs) if (target.id !== event.eventId) await c.reception.saveTerminalHeartbeat("T-FLOW-RECEPTION","stopped",0,target.id);
  await c.management.saveEvent(event);
  await c.management.saveReceptionSettings(event.eventId, settings);
  await c.management.saveTickets(event.eventId, tickets);
  const bundle = await c.publisher.publishEventBundle(event, settings, tickets);
  if (approveForFixture) await env.withSecurityRulesDisabled(async context => {
    for (const [uid, id] of [["flow-manager","T-FLOW-MANAGER"],["flow-reception","T-FLOW-RECEPTION"]]) {
      await setDoc(doc(context.firestore(),"events",event.eventId,"receptionApprovals",id), {eventId:event.eventId,terminalId:id,requestedByUid:uid,name:id,status:"approved",requestedAt:new Date().toISOString()});
    }
  });
  return bundle;
}


async function pooled(items, count, operation) {
  let next=0;
  await Promise.all(Array.from({length:count},async()=>{for(;;){const index=next++;if(index>=items.length)return;await operation(items[index],index);}}));
}
const receipt=(id,ticketId="ticket-1")=>({recordId:id,eventId:"flow-event",ticketId,terminalId:"T-FLOW-RECEPTION",type:"entry",timestamp:"2026-11-01T01:00:00.000Z"});

test("load: 300 independent entries at concurrency 16 preserve every ticket and receipt", {timeout:180000}, async()=>{
  const c=clients(),tickets=Array.from({length:300},(_,i)=>makeTicket("flow-event","load-"+i));
  await createPublished(c,makeEvent(),tickets);
  const latencies=[],start=performance.now();
  await pooled(tickets,16,async ticket=>{const at=performance.now();await c.reception.syncReceptionRecord(receipt("entry-"+ticket.ticketId,ticket.ticketId));latencies.push(performance.now()-at);});
  const elapsed=performance.now()-start;latencies.sort((a,b)=>a-b);
  const records=await getDocsFromServer(collection(c.managerDb,"events","flow-event","receptionRecords"));
  const saved=await c.management.loadEventTickets("flow-event");
  assert.equal(records.size,300);assert.equal(saved.filter(t=>t.currentStatus==="inside").length,300);
  console.log("STRESS_METRIC "+JSON.stringify({scenario:"300 entries/concurrency16",elapsedMs:Math.round(elapsed),requestsPerSecond:Math.round(300000/elapsed),p50Ms:Math.round(latencies[149]),p95Ms:Math.round(latencies[284]),receipts:records.size}));
});

test("destructive: 20 conflicting entries for one ticket accept exactly one",async()=>{
  const c=clients();await createPublished(c);
  const results=await Promise.allSettled(Array.from({length:20},(_,i)=>c.reception.syncReceptionRecord(receipt("contender-"+i))));
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal((await getDocsFromServer(collection(c.managerDb,"events","flow-event","receptionRecords"))).size,1);
  assert.equal((await getDocFromServer(doc(c.managerDb,"events","flow-event","tickets","ticket-1"))).data().currentStatus,"inside");
});

test("destructive: 20 duplicate deliveries converge to one receipt after retry",async()=>{
  const c=clients();await createPublished(c);
  const record=receipt("same-delivery");
  const first=await Promise.allSettled(Array.from({length:20},()=>c.reception.syncReceptionRecord(record)));
  assert.ok(first.some(r=>r.status==="fulfilled"));
  await Promise.all(Array.from({length:20},()=>c.reception.syncReceptionRecord(record)));
  assert.equal((await getDocsFromServer(collection(c.managerDb,"events","flow-event","receptionRecords"))).size,1);
});

test("fault: lost acknowledgement after server commit does not duplicate reception on retry",async()=>{
  const c=clients();await createPublished(c);let lost=false;
  const failing=loadClientModule("./reception-app/src/receptionSync.ts",c.receptionDb,"flow-reception","T-FLOW-RECEPTION",{},{
    runTransaction:async(db,operation)=>{const result=await firestore.runTransaction(db,operation);if(!lost){lost=true;throw Error("simulated lost acknowledgement");}return result;}
  });
  await assert.rejects(failing.syncReceptionRecord(receipt("lost-ack")),/lost acknowledgement/);
  await c.reception.syncReceptionRecord(receipt("lost-ack"));
  assert.equal((await getDocsFromServer(collection(c.managerDb,"events","flow-event","receptionRecords"))).size,1);
});

test("fault: interrupted deletion remains unpublished and retry removes all children",async()=>{
  const c=clients();await createPublished(c,makeEvent(),Array.from({length:600},(_,i)=>makeTicket("flow-event","delete-"+i)));let commits=0;
  const failing=loadClientModule("./management-app/src/firebaseData.ts",c.managerDb,"flow-manager","T-FLOW-MANAGER",{},{
    writeBatch:db=>{const batch=firestore.writeBatch(db);return {delete:(...args)=>batch.delete(...args),commit:async()=>{if(++commits===2)throw Error("simulated deletion disconnect");await batch.commit();}};}
  });
  await assert.rejects(failing.deleteEvent("flow-event"),/deletion disconnect/);
  assert.equal((await getDocFromServer(doc(c.managerDb,"events","flow-event"))).data().receptionTarget,false);
  await assert.rejects(c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION"),/NO_PUBLISHED_EVENT/);
  await c.management.deleteEvent("flow-event");
  assert.equal((await getDocFromServer(doc(c.managerDb,"events","flow-event"))).exists(),false);
  for(const child of ["tickets","receptionRecords","receptionApprovals","settings"])assert.equal((await getDocsFromServer(collection(c.managerDb,"events","flow-event",child))).size,0);
});

test("destructive: forged terminal, extra fields and oversized IDs cannot alter a ticket",async()=>{
  const c=clients();await createPublished(c);
  for(const bad of [{terminalId:"T-FORGED"},{extra:"injected"},{ticketId:"x".repeat(2000)}]){
    const batch=firestore.writeBatch(c.receptionDb);
    batch.update(doc(c.receptionDb,"events","flow-event","tickets","ticket-1"),{currentStatus:"inside",updatedAt:"2026-11-01T01:00:00.000Z",lastReceptionRecordId:"bad-record"});
    batch.set(doc(c.receptionDb,"events","flow-event","receptionRecords","bad-record"),{...receipt("bad-record"),...bad});
    await assertFails(batch.commit());
    assert.equal((await getDocFromServer(doc(c.managerDb,"events","flow-event","tickets","ticket-1"))).data().currentStatus,"unused");
  }
});

test("load: 1000 offline records survive event clearing without queue loss", {timeout:120000},async()=>{
  const c=clients(),start=performance.now();
  await c.local.prepareLocalEventData({event:makeEvent(),settings,terminalId:"T-FLOW-RECEPTION",authenticatedAt:new Date().toISOString(),dataReady:true,ticketCount:1},[makeTicket("flow-event")]);
  for(let i=0;i<1000;i++)await c.local.saveReceptionTransaction({...makeTicket("flow-event"),currentStatus:"inside"},receipt("offline-"+String(i).padStart(4,"0")));
  assert.equal((await c.local.getPendingSyncItems()).length,1000);
  await c.local.clearLocalEvent();
  const pending=await c.local.getPendingSyncItems();
  assert.equal(pending.length,1000);
  assert.equal((await c.local.getReceptionRecord(pending[999].recordId)).eventId,"flow-event");
  console.log("STRESS_METRIC "+JSON.stringify({scenario:"1000 offline captures/clear",elapsedMs:Math.round(performance.now()-start),pending:pending.length}));
});
