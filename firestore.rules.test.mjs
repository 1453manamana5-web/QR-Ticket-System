import { after, before, test } from "node:test";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, setDoc, updateDoc, deleteDoc, getDoc } from "firebase/firestore";

const projectId = "qr-ticket-rules-test";
let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: (await import("node:fs/promises")).readFile(new URL("./firestore.rules", import.meta.url), "utf8").then(x => x) },
  });
});

after(async () => {
  await env.cleanup();
});

test("rejects access when unauthenticated", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "events", "event-1")));
  await assertFails(setDoc(doc(db, "events", "event-1"), { name: "test" }));
});

test("authenticated clients can access event and ticket data", async () => {
  const db = env.authenticatedContext("user-1").firestore();
  await assertSucceeds(setDoc(doc(db, "events", "event-1"), { name: "test" }));
  await assertSucceeds(setDoc(doc(db, "events", "event-1", "tickets", "ticket-1"), { used: false }));
});

test("clients cannot access trusted handoff collections", async () => {
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(setDoc(doc(db, "terminalOwners", "T-ABCDEFGH"), { ownerUid: "anonymous-user-1" }));
  await assertFails(setDoc(doc(db, "terminalInstallations", "anonymous-user-1"), { terminalId: "T-ABCDEFGH" }));
  await assertFails(setDoc(doc(db, "terminalHandoffRequests", "request-1"), { terminalId: "T-ABCDEFGH" }));
  await assertFails(setDoc(doc(db, "terminalHandoffRateLimits", "anonymous-user-1"), { count: 1 }));
});

test("clients cannot create approved or administrator terminals", async () => {
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(setDoc(doc(db, "terminals", "T-ABCDEFGH"), {
    terminalId: "T-ABCDEFGH", approved: true, managementApproved: false,
    receptionApproved: false, admin: false, subAdmin: false, role: "management",
  }));
  await assertFails(setDoc(doc(db, "terminals", "T-IJKLMNOP"), {
    terminalId: "T-IJKLMNOP", approved: false, managementApproved: false,
    receptionApproved: false, admin: false, subAdmin: true, role: "reception",
  }));
  await assertFails(setDoc(doc(db, "terminals", "T-QRSTUVWX"), {
    terminalId: "T-QRSTUVWX", approved: false, managementApproved: false,
    receptionApproved: false, admin: false, subAdmin: false, role: "unknown",
  }));
  await assertSucceeds(setDoc(doc(db, "terminals", "T-YZABCDEF"), {
    terminalId: "T-YZABCDEF", approved: false, managementApproved: false,
    receptionApproved: false, admin: false, subAdmin: false,
    role: "reception", name: "受付端末",
  }));
});

test("clients cannot modify approval flags on existing terminals", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "terminals", "T-ABCDEFGH"), {
      terminalId: "T-ABCDEFGH", approved: true, managementApproved: true,
      receptionApproved: false, admin: true, name: "管理端末",
    });
  });
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { managementApproved: false }));
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { admin: false }));
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { subAdmin: true }));
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { role: "both" }));
  await assertSucceeds(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { name: "名前変更" }));
});

test("clients cannot delete terminal documents directly", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "terminals", "T-ABCDEFGH"), {
      terminalId: "T-ABCDEFGH", approved: false, managementApproved: false,
      receptionApproved: false, admin: false,
    });
  });
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(deleteDoc(doc(db, "terminals", "T-ABCDEFGH")));
});
