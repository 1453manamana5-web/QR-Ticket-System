import assert from "node:assert/strict";
import {beforeEach, after, test} from "node:test";
import {createRequire} from "node:module";
import {assertIsolatedEnvironment} from "./isolation.mjs";

// Check the destination before importing any Admin SDK or application code.
assertIsolatedEnvironment();
const projectId = "demo-qr-blue-functions";
process.env.GCLOUD_PROJECT = projectId;
process.env.GOOGLE_CLOUD_PROJECT = projectId;
process.env.FIREBASE_CONFIG = JSON.stringify({projectId});
const require = createRequire(new URL("../functions/package.json", import.meta.url));
const functions = require(process.env.QR_SECURITY_FUNCTIONS_MODULE || "../functions/lib/index.js");
const {getFirestore} = require("firebase-admin/firestore");
const db = getFirestore();
const uid = "blue-owner-uid";
const terminalId = "T-BLUE-TERMINAL-01";
const eventId = "blue-event-0001";
const ticketId = "blue-ticket-0001";
const time = "2026-11-06T00:00:00.000Z";

async function clear() {
  const response = await fetch(`http://127.0.0.1:8080/emulator/v1/projects/${projectId}/databases/(default)/documents`, {method:"DELETE"});
  assert.equal(response.ok, true);
}
beforeEach(clear);
after(async () => { await clear(); await db.terminate(); });
async function call(name, data, caller = uid) {
  return functions[name].run({auth: {uid:caller, token:{firebase:{sign_in_provider:"anonymous"}}}, data});
}
async function seed(role = "reception", approved = true) {
  await db.doc(`terminals/${terminalId}`).set({terminalId, requestedByUid:uid,
    role, approved:true, managementApproved:role === "management", receptionApproved:role === "reception",
    status:"online", mode:"停止", lastSeen:time, updatedAt:time, syncPendingCount:0});
  await db.doc(`terminalOwners/${terminalId}`).set({terminalId, ownerUid:uid, enabled:true});
  await db.doc(`terminalInstallations/${uid}`).set({terminalId, authUid:uid, approved});
}
async function seedEvent() {
  await db.doc(`events/${eventId}`).set({eventId,eventName:"Isolated test",eventStatus:"active",receptionTarget:true,dataVersion:1,authToken:"blue-token-0001"});
  await db.doc(`events/${eventId}/receptionApprovals/${terminalId}`).set({status:"approved",requestedByUid:uid});
  await db.doc(`events/${eventId}/tickets/${ticketId}`).set({ticketId,eventId,valid:true,currentStatus:"unused",updatedAt:time});
}

for (const role of ["management", "reception"]) {
  test(`released ${role} installation cannot publish heartbeat through its old owner UID`, async () => {
    await seed(role, false);
    await assert.rejects(call("updateTerminalHeartbeat", {terminalId,mode:"停止",syncPendingCount:0}), error=>error.code === "permission-denied");
    await db.doc(`terminalInstallations/${uid}`).update({approved:true});
    await call("updateTerminalHeartbeat", {terminalId,mode:"停止",syncPendingCount:0});
    assert.equal((await db.doc(`terminals/${terminalId}`).get()).get("status"), "online");
  });
}

test("released manager installation cannot rename its terminal until reapproved", async () => {
  await seed("management", false);
  await assert.rejects(call("updateManagedTerminalName", {terminalId,name:"Changed"}), error=>error.code === "permission-denied");
  await db.doc(`terminalInstallations/${uid}`).update({approved:true});
  await call("updateManagedTerminalName", {terminalId,name:"Changed"});
  assert.equal((await db.doc(`terminals/${terminalId}`).get()).get("name"), "Changed");
});

for (const ownerState of ["disabled", "missing"]) {
  test(`a reception installation cannot heartbeat with a ${ownerState} ownership grant`, async () => {
    await seed();
    if (ownerState === "missing") await db.doc(`terminalOwners/${terminalId}`).delete();
    else await db.doc(`terminalOwners/${terminalId}`).update({enabled:false});
    await assert.rejects(call("updateTerminalHeartbeat", {terminalId,mode:"停止",syncPendingCount:0}), error=>error.code === "permission-denied");
  });
}

test("receipt timestamps cannot carry a 200KB parseable payload", async () => {
  await seed();await seedEvent();
  const record = {recordId:"blue-record-0001",eventId,ticketId,terminalId,type:"entry",timestamp:"2026-11-06"+" ".repeat(199990)};
  assert.equal(Number.isFinite(Date.parse(record.timestamp)), true);
  await assert.rejects(call("recordReception", {record}), error=>error.code === "invalid-argument");
  assert.equal((await db.doc(`events/${eventId}/tickets/${ticketId}`).get()).get("currentStatus"), "unused");
  await call("recordReception", {record:{...record,timestamp:time}});
  assert.equal((await db.doc(`events/${eventId}/tickets/${ticketId}`).get()).get("currentStatus"), "inside");
});

test("error timestamps reject oversized parseable payloads and retain valid offline times", async () => {
  await seed();
  const log = {errorId:"blue-error-0001",eventId,terminalId,category:"invalid_ticket",mode:"entry",timestamp:"2026-11-06"+" ".repeat(199990)};
  await assert.rejects(call("recordReceptionError", {log}), error=>error.code === "invalid-argument");
  assert.equal((await db.doc(`receptionErrors/${log.errorId}`).get()).exists, false);
  await call("recordReceptionError", {log:{...log,timestamp:time}});
  assert.equal((await db.doc(`receptionErrors/${log.errorId}`).get()).get("timestamp"), time);
});
