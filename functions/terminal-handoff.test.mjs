import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "./lib/index.js";

const db = getFirestore();
const collections = ["terminals", "terminalOwners", "terminalInstallations", "terminalHandoffRequests", "terminalHandoffRateLimits", "events", "eventBundles"];
async function clearCollections() {
  for (const name of collections) {
    const snapshot = await db.collection(name).get();
    for (let i = 0; i < snapshot.docs.length; i += 400) {
      const batch = db.batch();
      snapshot.docs.slice(i, i + 400).forEach((item) => batch.delete(item.ref));
      await batch.commit();
    }
  }
}
async function seedManager() {
  await db.doc("terminals/T-MANAGEMENT-0001").set({ terminalId: "T-MANAGEMENT-0001", approved: true, managementApproved: true, receptionApproved: false, role: "management", admin: true });
  await db.doc("terminalOwners/T-MANAGEMENT-0001").set({ terminalId: "T-MANAGEMENT-0001", ownerUid: "manager-owner-uid", enabled: true });
  await db.doc("terminalInstallations/manager-owner-uid").set({ terminalId: "T-MANAGEMENT-0001", authUid: "manager-owner-uid", approved: true });
}
async function seedReceptionTerminal() {
  await db.doc("terminals/T-RECEPTION-0001").set({ terminalId: "T-RECEPTION-0001", approved: true, receptionApproved: true, managementApproved: false, role: "reception", receptionApprovalVersion: 0 });
  await db.doc("terminalOwners/T-RECEPTION-0001").set({ terminalId: "T-RECEPTION-0001", ownerUid: "trusted-owner-uid", enabled: true });
  await db.doc("terminalInstallations/trusted-owner-uid").set({ terminalId: "T-RECEPTION-0001", authUid: "trusted-owner-uid", approved: true });
}
async function call(name, uid, data) {
  const callable = functions[name];
  assert.ok(callable && typeof callable.run === "function", name + " must expose callable run()");
  return callable.run({ auth: uid ? { uid, token: { firebase: { sign_in_provider: "anonymous" } } } : null, data });
}
before(async () => { assert.ok(process.env.FIRESTORE_EMULATOR_HOST, "This suite must run against the Firestore emulator."); await clearCollections(); });
beforeEach(clearCollections);
after(clearCollections);
test("handoff requires authentication and an eligible registered reception terminal", async () => {
  await seedReceptionTerminal();
  await assert.rejects(call("requestTerminalHandoff", null, { terminalId: "T-RECEPTION-0001" }));
  await assert.rejects(call("requestTerminalHandoff", "untrusted-requester", { terminalId: "T-UNKNOWN-0001" }));
  const result = await call("requestTerminalHandoff", "new-installation-uid", { terminalId: "T-RECEPTION-0001" });
  assert.equal(result.expiresInSeconds, 300); assert.ok(result.requestId);
});
test("only the trusted owner can decide; approval can be consumed once", async () => {
  await seedReceptionTerminal();
  const request = await call("requestTerminalHandoff", "new-installation-uid", { terminalId: "T-RECEPTION-0001" });
  await assert.rejects(call("decideTerminalHandoff", "impostor-owner", { requestId: request.requestId, decision: "approve" }));
  assert.deepEqual(await call("decideTerminalHandoff", "trusted-owner-uid", { requestId: request.requestId, decision: "approve" }), { status: "approved" });
  assert.deepEqual(await call("completeTerminalHandoff", "new-installation-uid", { requestId: request.requestId }), { terminalId: "T-RECEPTION-0001", approved: true });
  await assert.rejects(call("completeTerminalHandoff", "new-installation-uid", { requestId: request.requestId }));
  assert.equal((await db.doc("terminalInstallations/new-installation-uid").get()).get("approved"), true);
  assert.equal((await db.doc("terminalHandoffRequests/" + request.requestId).get()).get("status"), "consumed");
});
test("concurrent approval decisions cannot both win", async () => {
  await seedReceptionTerminal();
  const request = await call("requestTerminalHandoff", "new-installation-uid", { terminalId: "T-RECEPTION-0001" });
  const results = await Promise.allSettled([call("decideTerminalHandoff", "trusted-owner-uid", { requestId: request.requestId, decision: "approve" }), call("decideTerminalHandoff", "trusted-owner-uid", { requestId: request.requestId, decision: "reject" })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.ok(["approved", "rejected"].includes((await db.doc("terminalHandoffRequests/" + request.requestId).get()).get("status")));
});
test("concurrent completion attempts produce one installation grant", async () => {
  await seedReceptionTerminal();
  const request = await call("requestTerminalHandoff", "new-installation-uid", { terminalId: "T-RECEPTION-0001" });
  await call("decideTerminalHandoff", "trusted-owner-uid", { requestId: request.requestId, decision: "approve" });
  const results = await Promise.allSettled([call("completeTerminalHandoff", "new-installation-uid", { requestId: request.requestId }), call("completeTerminalHandoff", "new-installation-uid", { requestId: request.requestId })]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await db.doc("terminalInstallations/new-installation-uid").get()).get("approved"), true);
  assert.equal((await db.doc("terminalHandoffRequests/" + request.requestId).get()).get("status"), "consumed");
});
test("expired approvals cannot create installation grants", async () => {
  await seedReceptionTerminal();
  const old = Timestamp.fromMillis(Date.now() - 60000);
  await db.doc("terminalHandoffRequests/manual-expired-request").set({ terminalId: "T-RECEPTION-0001", requesterUid: "new-installation-uid", status: "approved", receptionApprovalVersion: 0, createdAt: old, expiresAt: old, decidedByUid: "trusted-owner-uid" });
  await assert.rejects(call("completeTerminalHandoff", "new-installation-uid", { requestId: "manual-expired-request" }));
  assert.equal((await db.doc("terminalInstallations/new-installation-uid").get()).exists, false);
});

test("reception revocation invalidates an already approved handoff", async () => {
  await seedManager();
  await seedReceptionTerminal();
  const request = await call("requestTerminalHandoff", "new-installation-uid", {
    terminalId: "T-RECEPTION-0001",
  });
  await call("decideTerminalHandoff", "trusted-owner-uid", {
    requestId: request.requestId, decision: "approve",
  });
  await call("revokeTerminalReception", "manager-owner-uid", {
    managerTerminalId: "T-MANAGEMENT-0001", targetTerminalId: "T-RECEPTION-0001",
  });
  await assert.rejects(call("completeTerminalHandoff", "new-installation-uid", {
    requestId: request.requestId,
  }));
  assert.equal((await db.doc("terminalInstallations/new-installation-uid").get()).exists, false);
  assert.equal((await db.doc("terminals/T-RECEPTION-0001").get()).get("receptionApproved"), false);
  assert.equal((await db.doc("terminalHandoffRequests/" + request.requestId).get()).get("status"), "cancelled");
});

test("event deletion also removes the separately stored published bundle", async () => {
  await seedManager();
  await db.doc("events/event-to-delete").set({
    eventId: "event-to-delete",
    authToken: "published-bundle-token",
    eventStatus: "ready",
  });
  await db.doc("events/event-to-delete/tickets/ticket-private").set({
    ticketId: "ticket-private", currentStatus: "unused",
  });
  await db.doc("events/event-to-delete/receptionRecords/record-private").set({
    recordId: "record-private", ticketId: "ticket-private",
  });
  await db.doc("events/event-to-delete/analysis/analysis-private").set({
    eventId: "event-to-delete", total: 1,
  });
  await db.doc("eventBundles/published-bundle-token").set({
    authToken: "published-bundle-token",
    event: { eventId: "event-to-delete" },
    tickets: [{ ticketId: "ticket-private" }],
  });

  assert.deepEqual(await call("deleteManagedEvent", "manager-owner-uid", {
    eventId: "event-to-delete",
  }), { eventId: "event-to-delete", deleted: true });
  assert.equal((await db.doc("events/event-to-delete").get()).exists, false);
  assert.equal((await db.doc("events/event-to-delete/tickets/ticket-private").get()).exists, false);
  assert.equal((await db.doc("events/event-to-delete/receptionRecords/record-private").get()).exists, false);
  assert.equal((await db.doc("events/event-to-delete/analysis/analysis-private").get()).exists, false);
  assert.equal((await db.doc("eventBundles/published-bundle-token").get()).exists, false);
});

test('every exported callable rejects an unauthenticated request before making changes',async()=>{
  const names=Object.keys(functions).filter(name=>typeof functions[name]?.run==='function');
  assert.ok(names.length>=20);
  for(const name of names)await assert.rejects(call(name,null,{confirm:'RESET_ALL_PRODUCTION_DATA'}),error=>error.code==='unauthenticated',name);
});

test('an ordinary reception installation cannot reset production or delete events through callables',async()=>{
  await seedManager();await seedReceptionTerminal();
  await db.doc('events/protected-event').set({eventId:'protected-event'});
  await assert.rejects(call('resetAllProductionData','trusted-owner-uid',{confirm:'RESET_ALL_PRODUCTION_DATA'}));
  await assert.rejects(call('deleteManagedEvent','trusted-owner-uid',{eventId:'protected-event'}));
  assert.equal((await db.doc('events/protected-event').get()).exists,true);
  assert.equal((await db.doc('terminals/T-MANAGEMENT-0001').get()).exists,true);
});

test('event deletion removes historical bundle tokens and preserves other events',async()=>{
  await seedManager();
  await db.doc('events/republished-event').set({eventId:'republished-event',authToken:'latest-token'});
  for(const token of ['old-token','latest-token'])await db.doc('eventBundles/'+token).set({authToken:token,event:{eventId:'republished-event'}});
  await db.doc('eventBundles/other-token').set({event:{eventId:'other-event'}});
  await call('deleteManagedEvent','manager-owner-uid',{eventId:'republished-event'});
  assert.equal((await db.doc('eventBundles/old-token').get()).exists,false);
  assert.equal((await db.doc('eventBundles/latest-token').get()).exists,false);
  assert.equal((await db.doc('eventBundles/other-token').get()).exists,true);
});

test('confirmed administrator reset removes all app collections including orphaned nested data',async()=>{
  await seedManager();
  await db.doc('events/orphan/tickets/orphan-ticket').set({ticketId:'orphan-ticket'});
  await db.doc('devices/T-OLD-DEVICE').set({volume:50});
  await db.doc('receptionErrors/test-error').set({errorId:'test-error'});
  await assert.rejects(call('resetAllProductionData','manager-owner-uid',{confirm:'WRONG'}));
  assert.equal((await db.doc('terminals/T-MANAGEMENT-0001').get()).exists,true);
  const result=await call('resetAllProductionData','manager-owner-uid',{confirm:'RESET_ALL_PRODUCTION_DATA'});
  assert.equal(result.success,true);assert.equal(result.authAccountsPreserved,true);
  assert.equal((await db.doc('events/orphan/tickets/orphan-ticket').get()).exists,false);
  assert.equal((await db.doc('terminals/T-MANAGEMENT-0001').get()).exists,false);
  assert.equal((await db.doc('devices/T-OLD-DEVICE').get()).exists,false);
});

const managerId = "T-MANAGEMENT-0001";
const receptionId = "T-RECEPTION-0001";
const managerUid = "manager-owner-uid";
const ownerUid = "trusted-owner-uid";
async function seedManagementTarget() {
  const terminalId = "T-MANAGEMENT-0002";
  await db.doc("terminals/" + terminalId).set({ terminalId, approved: true,
    managementApproved: true, receptionApproved: false, role: "management", admin: false, subAdmin: false });
  await db.doc("terminalOwners/" + terminalId).set({ terminalId, ownerUid: "target-manager-uid", enabled: true });
  await db.doc("terminalInstallations/target-manager-uid").set({ terminalId, authUid: "target-manager-uid", approved: true });
  return terminalId;
}

for (const operation of ["revokeTerminalReception", "deleteManagedTerminal", "setTerminalSubAdmin", "setManagedTerminalMode"]) {
  test(operation + " checks the acting installation and accepts a valid registered manager", async () => {
    await seedManager(); await seedReceptionTerminal();
    const targetTerminalId = operation === "setTerminalSubAdmin" ? await seedManagementTarget() : receptionId;
    const data = { managerTerminalId: managerId, targetTerminalId, enabled: true, mode: "入口受付" };
    for (const invalid of [
      { approved: false },
      { authUid: "another-uid" },
      { terminalId: "T-ANOTHER-MANAGER" },
    ]) {
      await db.doc("terminalInstallations/" + managerUid).set({ terminalId: managerId, authUid: managerUid, approved: true, ...invalid });
      await assert.rejects(call(operation, managerUid, data), error => error.code === "permission-denied");
      assert.equal((await db.doc("terminals/" + targetTerminalId).get()).exists, true);
    }
    await db.doc("terminalInstallations/" + managerUid).delete();
    await assert.rejects(call(operation, managerUid, data), error => error.code === "permission-denied");
    await db.doc("terminalInstallations/" + managerUid).set({ terminalId: managerId, authUid: managerUid, approved: true });
    const result = await call(operation, managerUid, data);
    assert.equal(result.terminalId, targetTerminalId);
  });
}

test("recordReception requires approval of this installation for this event", async () => {
  await seedReceptionTerminal();
  const eventId = "event-approval-required";
  const ticketId = "ticket-approval-required";
  await db.doc("events/" + eventId).set({ eventId, eventName: "Approval test", dataVersion: 1,
    authToken: "approval-test-token", receptionTarget: true, eventStatus: "active" });
  const ticketRef = db.doc("events/" + eventId + "/tickets/" + ticketId);
  await ticketRef.set({ eventId, ticketId, currentStatus: "unused", valid: true });
  const record = { recordId: "record-approval-required", eventId, ticketId, terminalId: receptionId,
    type: "entry", timestamp: new Date().toISOString() };
  const approvalRef = db.doc("events/" + eventId + "/receptionApprovals/" + receptionId);
  for (const approval of [null, { status: "pending", requestedByUid: ownerUid },
    { status: "approved", requestedByUid: "another-installation" }]) {
    if (approval) await approvalRef.set(approval); else await approvalRef.delete();
    await assert.rejects(call("recordReception", ownerUid, { record }), error => error.code === "permission-denied");
    assert.equal((await ticketRef.get()).get("currentStatus"), "unused");
    assert.equal((await db.doc("events/" + eventId + "/receptionRecords/" + record.recordId).get()).exists, false);
  }
  await approvalRef.set({ status: "approved", requestedByUid: ownerUid });
  assert.equal((await call("recordReception", ownerUid, { record })).saved, true);
  assert.equal((await call("recordReception", ownerUid, { record })).saved, true);
  assert.equal((await ticketRef.get()).get("currentStatus"), "inside");
});

for (const [label, releaseValue, shouldAccept] of [
  ["ISO release newer than request", now => new Date(now - 1000).toISOString(), false],
  ["timestamp release newer than request", now => Timestamp.fromMillis(now - 1000), false],
  ["invalid release time", () => "invalid", false],
  ["missing release time", () => undefined, false],
  ["ISO release older than request", now => new Date(now - 3000).toISOString(), true],
]) {
  test("handoff re-registration handles " + label, async () => {
    await seedReceptionTerminal();
    const now = Date.now();
    const requesterUid = "released-recipient-uid";
    const releasedAt = releaseValue(now);
    await db.doc("terminalInstallations/" + requesterUid).set({ terminalId: receptionId, authUid: requesterUid,
      approved: false, ...(releasedAt === undefined ? {} : { releasedAt }) });
    const requestId = "request-before-client-release";
    await db.doc("terminalHandoffRequests/" + requestId).set({ terminalId: receptionId, requesterUid,
      status: "approved", receptionApprovalVersion: 0, decidedByUid: ownerUid,
      createdAt: Timestamp.fromMillis(now - 2000), expiresAt: Timestamp.fromMillis(now + 60000) });
    if (shouldAccept) {
      assert.equal((await call("completeTerminalHandoff", requesterUid, { requestId })).approved, true);
    } else {
      await assert.rejects(call("completeTerminalHandoff", requesterUid, { requestId }), error => error.code === "failed-precondition");
      assert.equal((await db.doc("terminalInstallations/" + requesterUid).get()).get("approved"), false);
      assert.equal((await db.doc("terminalHandoffRequests/" + requestId).get()).get("status"), "approved");
    }
  });
}
