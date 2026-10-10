import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from "firebase/firestore";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qr-ticket-rules-test",
    firestore: {
      rules: await readFile(new URL("./firestore.rules", import.meta.url), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});
beforeEach(async () => env.clearFirestore());
after(async () => env.cleanup());

test("rejects access when unauthenticated", async () => {
  const db = env.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(db, "events", "event-1")));
  await assertFails(setDoc(doc(db, "events", "event-1"), { eventId: "event-1" }));
});

test("authenticated clients can read event and ticket data but cannot write without management approval", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "events", "event-1"), { eventId: "event-1" });
    await setDoc(doc(context.firestore(), "events", "event-1", "tickets", "ticket-1"), {
      ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
    });
  });
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertSucceeds(getDoc(doc(db, "events", "event-1")));
  await assertSucceeds(getDoc(doc(db, "events", "event-1", "tickets", "ticket-1")));
  await assertFails(setDoc(doc(db, "events", "event-2"), { eventId: "event-2" }));
  await assertFails(setDoc(doc(db, "events", "event-1", "tickets", "ticket-2"), {
    ticketId: "ticket-2", eventId: "event-1", currentStatus: "unused",
  }));
});

test("approved management installations can write event and ticket data", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "management-user"), {
      terminalId: "T-MANAGEMENT-01", authUid: "management-user", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-MANAGEMENT-01"), {
      terminalId: "T-MANAGEMENT-01", approved: true, managementApproved: true,
      receptionApproved: false, role: "management",
    });
  });
  const db = env.authenticatedContext("management-user").firestore();
  await assertSucceeds(setDoc(doc(db, "events", "event-1"), { eventId: "event-1" }));
  await assertSucceeds(setDoc(doc(db, "events", "event-1", "tickets", "ticket-1"), {
    ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
  }));
});

test("reception-only installations cannot write management data", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "reception-user"), {
      terminalId: "T-RECEPTION-01", authUid: "reception-user", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-RECEPTION-01"), {
      terminalId: "T-RECEPTION-01", approved: true, managementApproved: false,
      receptionApproved: true, role: "reception",
    });
  });
  const db = env.authenticatedContext("reception-user").firestore();
  await assertFails(setDoc(doc(db, "events", "event-1"), { eventId: "event-1" }));
  await assertFails(setDoc(doc(db, "events", "event-1", "tickets", "ticket-1"), {
    ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
  }));
});

test("clients cannot write reception records directly", async () => {
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(setDoc(doc(db, "events", "event-1", "receptionRecords", "record-12345678"), {
    recordId: "record-12345678", eventId: "event-1", ticketId: "ticket-1",
    terminalId: "T-ABCDEFGH", type: "entry", timestamp: new Date().toISOString(),
  }));
});

test("clients cannot access trusted handoff collections", async () => {
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(getDoc(doc(db, "terminalOwners", "T-ABCDEFGH")));
  await assertFails(setDoc(doc(db, "terminalOwners", "T-ABCDEFGH"), { ownerUid: "anonymous-user-1", enabled: true }));
  await assertFails(setDoc(doc(db, "terminalInstallations", "anonymous-user-1"), { terminalId: "T-ABCDEFGH" }));
  await assertFails(setDoc(doc(db, "terminalHandoffRequests", "request-12345678"), { status: "approved" }));
  await assertFails(setDoc(doc(db, "terminalHandoffRateLimits", "anonymous-user-1"), { count: 1 }));
});

test("clients cannot create, update, or delete terminal documents directly", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "terminals", "T-ABCDEFGH"), {
      terminalId: "T-ABCDEFGH", approved: true, managementApproved: true,
      receptionApproved: true, admin: true, name: "管理端末",
    });
  });

  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(setDoc(doc(db, "terminals", "T-IJKLMNOP"), {
    terminalId: "T-IJKLMNOP", approved: false, managementApproved: false,
    receptionApproved: false, admin: false, subAdmin: false,
    role: "reception", name: "受付端末",
  }));
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { name: "改ざんした名前" }));
  await assertFails(updateDoc(doc(db, "terminals", "T-ABCDEFGH"), { managementApproved: false }));
  await assertFails(deleteDoc(doc(db, "terminals", "T-ABCDEFGH")));

  // Reading terminal status remains necessary for the management/reception UI.
  await assertSucceeds(getDoc(doc(db, "terminals", "T-ABCDEFGH")));
});
