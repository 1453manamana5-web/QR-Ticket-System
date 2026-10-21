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
  await db.doc("eventBundles/published-bundle-token").set({
    authToken: "published-bundle-token",
    event: { eventId: "event-to-delete" },
    tickets: [{ ticketId: "ticket-private" }],
  });

  assert.deepEqual(await call("deleteManagedEvent", "manager-owner-uid", {
    eventId: "event-to-delete",
  }), { eventId: "event-to-delete", deleted: true });
  assert.equal((await db.doc("events/event-to-delete").get()).exists, false);
  assert.equal((await db.doc("eventBundles/published-bundle-token").get()).exists, false);
});
