import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import * as functions from "./lib/index.js";

const db = getFirestore();
const collections = ["terminals", "terminalOwners", "terminalInstallations", "terminalHandoffRequests", "terminalHandoffRateLimits", "events", "eventBundles"];
async function clearCollections() {
  for (const name of collections) {
    if (name === "events") {
      await db.recursiveDelete(db.collection(name));
      continue;
    }
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

async function seedCallableReception() {
  await seedReceptionTerminal();
  await db.doc("events/callable-event").set({
    eventId: "callable-event", eventName: "Callable event", eventDate: "2026-10-25",
    startTime: "09:00", receptionTarget: true, eventStatus: "ready", dataVersion: 1, authToken: "callable-token",
  });
  await db.doc("events/callable-event/tickets/callable-ticket").set({
    eventId: "callable-event", ticketId: "callable-ticket", valid: true, currentStatus: "unused",
  });
  return {
    recordId: "callable-record", eventId: "callable-event", ticketId: "callable-ticket",
    terminalId: "T-RECEPTION-0001", type: "entry", timestamp: "2026-10-25T00:00:00.000Z",
  };
}

test("callable reception cannot bypass event approval or its approving identity", async () => {
  const record = await seedCallableReception();
  const approval = db.doc("events/callable-event/receptionApprovals/T-RECEPTION-0001");
  for (const data of [null, { status: "pending", requestedByUid: "trusted-owner-uid" },
    { status: "approved", requestedByUid: "another-installation" }]) {
    if (data) await approval.set(data);
    await assert.rejects(call("recordReception", "trusted-owner-uid", { record }),
      error => error.code === "permission-denied");
  }
  assert.equal((await db.doc("events/callable-event/tickets/callable-ticket").get()).get("currentStatus"), "unused");
  assert.equal((await db.doc("events/callable-event/receptionRecords/callable-record").get()).exists, false);
});

test("callable reception rejects preopening trials and records an idempotent real entry at opening", async () => {
  const record = await seedCallableReception();
  await db.doc("events/callable-event/receptionApprovals/T-RECEPTION-0001").set({
    status: "approved", requestedByUid: "trusted-owner-uid",
  });
  await assert.rejects(call("recordReception", "trusted-owner-uid", {
    record: { ...record, timestamp: "2026-10-24T23:59:59.999Z" },
  }), error => error.code === "failed-precondition");
  assert.equal((await db.doc("events/callable-event/tickets/callable-ticket").get()).get("currentStatus"), "unused");
  assert.equal((await db.doc("events/callable-event/receptionRecords/callable-record").get()).exists, false);
  await call("recordReception", "trusted-owner-uid", { record });
  await call("recordReception", "trusted-owner-uid", { record });
  const ticket = await db.doc("events/callable-event/tickets/callable-ticket").get();
  assert.equal(ticket.get("currentStatus"), "inside");
  assert.equal(ticket.get("lastReceptionRecordId"), "callable-record");
  assert.equal((await db.collection("events/callable-event/receptionRecords").get()).size, 1);
});

const managementCalls = {
  revokeTerminalReception: { targetTerminalId: "T-RECEPTION-0001" },
  deleteManagedTerminal: { targetTerminalId: "T-RECEPTION-0001" },
  setTerminalSubAdmin: { targetTerminalId: "T-TARGET-MANAGER", enabled: true },
  updateManagedTerminalName: { terminalId: "T-MANAGEMENT-0001", name: "Updated manager" },
  setManagedTerminalMode: { targetTerminalId: "T-RECEPTION-0001", mode: "入口受付" },
};
for (const [name, input] of Object.entries(managementCalls)) {
  test(`${name} requires the caller's current installation grant`, async () => {
    const installation = db.doc("terminalInstallations/manager-owner-uid");
    for (const grant of [null,
      { authUid: "manager-owner-uid", terminalId: "T-MANAGEMENT-0001", approved: false },
      { authUid: "manager-owner-uid", terminalId: "T-OTHER-MANAGER", approved: true },
      { authUid: "another-uid", terminalId: "T-MANAGEMENT-0001", approved: true }]) {
      await seedManager();
      await seedReceptionTerminal();
      await db.doc("terminals/T-TARGET-MANAGER").set({
        terminalId: "T-TARGET-MANAGER", approved: true, managementApproved: true,
        role: "management", admin: false, subAdmin: false,
      });
      await db.doc("terminalOwners/T-TARGET-MANAGER").set({ ownerUid: "target-owner", enabled: true });
      await db.doc("terminalInstallations/target-owner").set({
        terminalId: "T-TARGET-MANAGER", authUid: "target-owner", approved: true,
      });
      if (grant) await installation.set(grant); else await installation.delete();
      await assert.rejects(call(name, "manager-owner-uid", { managerTerminalId: "T-MANAGEMENT-0001", ...input }),
        error => error.code === "permission-denied");
    }
    await seedManager();
    await call(name, "manager-owner-uid", { managerTerminalId: "T-MANAGEMENT-0001", ...input });
  });
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

for (const format of ["ISO", "Timestamp", "invalid", "missing"]) {
  test(`a ${format} release marker prevents replaying an older handoff approval`, async () => {
    await seedReceptionTerminal();
    const requestId = "pre-release-approved-request";
    const now = Date.now();
    await db.doc("terminalHandoffRequests/" + requestId).set({
      terminalId: "T-RECEPTION-0001", requesterUid: "released-installation", status: "approved",
      receptionApprovalVersion: 0, createdAt: Timestamp.fromMillis(now - 2000),
      expiresAt: Timestamp.fromMillis(now + 60000), decidedByUid: "trusted-owner-uid",
    });
    const installation = {
      terminalId: "T-RECEPTION-0001", authUid: "released-installation", approved: false,
    };
    if (format !== "missing") installation.releasedAt = format === "Timestamp"
      ? Timestamp.fromMillis(now - 1000) : format === "ISO" ? new Date(now - 1000).toISOString() : "invalid";
    await db.doc("terminalInstallations/released-installation").set(installation);
    await assert.rejects(call("completeTerminalHandoff", "released-installation", { requestId }),
      error => error.code === "failed-precondition");
    assert.equal((await db.doc("terminalInstallations/released-installation").get()).get("approved"), false);
    assert.equal((await db.doc("terminalHandoffRequests/" + requestId).get()).get("status"), "approved");
  });
}

for (const format of ["ISO", "Timestamp"]) {
  test(`a new handoff approved after a ${format} release remains usable`, async () => {
    await seedReceptionTerminal();
    const requestId = "post-release-approved-request";
    const now = Date.now();
    await db.doc("terminalHandoffRequests/" + requestId).set({
      terminalId: "T-RECEPTION-0001", requesterUid: "released-installation", status: "approved",
      receptionApprovalVersion: 0, createdAt: Timestamp.fromMillis(now - 1000),
      expiresAt: Timestamp.fromMillis(now + 60000), decidedByUid: "trusted-owner-uid",
    });
    await db.doc("terminalInstallations/released-installation").set({
      terminalId: "T-RECEPTION-0001", authUid: "released-installation", approved: false,
      releasedAt: format === "Timestamp" ? Timestamp.fromMillis(now - 2000) : new Date(now - 2000).toISOString(),
    });
    await call("completeTerminalHandoff", "released-installation", { requestId });
    assert.equal((await db.doc("terminalInstallations/released-installation").get()).get("approved"), true);
  });
}

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
