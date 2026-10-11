import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc } from "firebase/firestore";

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

test("unapproved authenticated clients cannot enumerate event or ticket data", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "events", "event-1"), { eventId: "event-1" });
    await setDoc(doc(context.firestore(), "events", "event-1", "tickets", "ticket-1"), {
      ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
    });
  });
  const db = env.authenticatedContext("anonymous-user-1").firestore();
  await assertFails(getDoc(doc(db, "events", "event-1")));
  await assertFails(getDoc(doc(db, "events", "event-1", "tickets", "ticket-1")));
  await assertFails(setDoc(doc(db, "events", "event-2"), { eventId: "event-2" }));
  await assertFails(setDoc(doc(db, "events", "event-1", "tickets", "ticket-2"), {
    ticketId: "ticket-2", eventId: "event-1", currentStatus: "unused",
  }));
});

test("approved reception installations can read event metadata but not ticket documents directly", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "reception-reader"), {
      terminalId: "T-RECEPTION-READ", authUid: "reception-reader", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-RECEPTION-READ"), {
      terminalId: "T-RECEPTION-READ", approved: true, managementApproved: false,
      receptionApproved: true, role: "reception", requestedByUid: "reception-reader",
    });
    await setDoc(doc(db, "terminalOwners", "T-RECEPTION-READ"), {
      terminalId: "T-RECEPTION-READ", ownerUid: "reception-reader", enabled: true,
    });
    await setDoc(doc(db, "events", "event-1"), { eventId: "event-1" });
    await setDoc(doc(db, "events", "event-1", "tickets", "ticket-1"), {
      ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
    });
  });
  const db = env.authenticatedContext("reception-reader").firestore();
  await assertSucceeds(getDoc(doc(db, "events", "event-1")));
  await assertFails(getDoc(doc(db, "events", "event-1", "tickets", "ticket-1")));
  await assertSucceeds(getDoc(doc(db, "terminals", "T-RECEPTION-READ")));
  await assertFails(getDoc(doc(db, "terminals", "T-OTHER")));
  await env.withSecurityRulesDisabled(async context => {
    const trustedDb = context.firestore();
    await setDoc(doc(trustedDb, "events", "event-1", "receptionRecords", "record-1"), { recordId: "record-1" });
    await setDoc(doc(trustedDb, "events", "event-1", "analysis", "analysis-1"), { eventId: "event-1" });
    await setDoc(doc(trustedDb, "events", "event-1", "members", "member-1"), { memberId: "member-1" });
    await setDoc(doc(trustedDb, "events", "event-1", "settings", "reception"), { entryEnabled: true });
    await setDoc(doc(trustedDb, "devices", "device-1"), { secretSetting: true });
    await setDoc(doc(trustedDb, "terminals", "T-OTHER"), { terminalId: "T-OTHER", name: "別の端末" });
  });
  await assertFails(getDocs(collection(db, "events", "event-1", "receptionRecords")));
  await assertFails(getDocs(collection(db, "events", "event-1", "analysis")));
  await assertFails(getDocs(collection(db, "events", "event-1", "members")));
  await assertFails(getDocs(collection(db, "events", "event-1", "settings")));
  await assertFails(getDoc(doc(db, "devices", "device-1")));
  await assertFails(getDocs(collection(db, "terminals")));
});

test("handed-off reception installations cannot inherit management access", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "handoff-reception"), {
      terminalId: "T-SHARED-BOTH", authUid: "handoff-reception", approved: true,
    });
    await setDoc(doc(db, "terminalOwners", "T-SHARED-BOTH"), {
      terminalId: "T-SHARED-BOTH", ownerUid: "original-owner", enabled: true,
    });
    await setDoc(doc(db, "terminals", "T-SHARED-BOTH"), {
      terminalId: "T-SHARED-BOTH", approved: true, managementApproved: true,
      receptionApproved: true, role: "both",
    });
    await setDoc(doc(db, "events", "event-shared"), { eventId: "event-shared" });
    await setDoc(doc(db, "events", "event-shared", "tickets", "ticket-shared"), {
      ticketId: "ticket-shared", eventId: "event-shared", currentStatus: "unused",
    });
    await setDoc(doc(db, "events", "event-shared", "analysis", "private-analysis"), {
      eventId: "event-shared", summary: "private",
    });
  });

  const db = env.authenticatedContext("handoff-reception").firestore();
  await assertSucceeds(getDoc(doc(db, "events", "event-shared")));
  await assertFails(getDoc(doc(db, "events", "event-shared", "tickets", "ticket-shared")));
  await assertFails(getDoc(doc(db, "events", "event-shared", "analysis", "private-analysis")));
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
    await setDoc(doc(db, "terminalOwners", "T-MANAGEMENT-01"), {
      terminalId: "T-MANAGEMENT-01", ownerUid: "management-user", enabled: true,
    });
  });
  const db = env.authenticatedContext("management-user").firestore();
  await assertSucceeds(setDoc(doc(db, "events", "event-1"), { eventId: "event-1" }));
  await assertSucceeds(setDoc(doc(db, "events", "event-1", "tickets", "ticket-1"), {
    ticketId: "ticket-1", eventId: "event-1", currentStatus: "unused",
  }));
  await assertSucceeds(getDocs(collection(db, "terminals")));
});

test("only approved terminals can fetch event bundles and management terminals can publish", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "eventBundles", "opaque-token-1"), {
      authToken: "opaque-token-1",
      event: { eventId: "event-1" },
      tickets: [],
    });
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "reception-user"), {
      terminalId: "T-BUNDLE-RECEPTION", authUid: "reception-user", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-BUNDLE-RECEPTION"), {
      terminalId: "T-BUNDLE-RECEPTION", approved: true, managementApproved: false,
      receptionApproved: true, role: "reception",
    });
    await setDoc(doc(db, "terminalOwners", "T-BUNDLE-RECEPTION"), {
      terminalId: "T-BUNDLE-RECEPTION", ownerUid: "reception-user", enabled: true,
    });
    await setDoc(doc(db, "terminalInstallations", "bundle-manager"), {
      terminalId: "T-BUNDLE-MANAGER", authUid: "bundle-manager", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-BUNDLE-MANAGER"), {
      terminalId: "T-BUNDLE-MANAGER", approved: true, managementApproved: true,
      role: "management",
    });
    await setDoc(doc(db, "terminalOwners", "T-BUNDLE-MANAGER"), {
      terminalId: "T-BUNDLE-MANAGER", ownerUid: "bundle-manager", enabled: true,
    });
  });

  const unauthorisedDb = env.authenticatedContext("random-user").firestore();
  await assertFails(getDoc(doc(unauthorisedDb, "eventBundles", "opaque-token-1")));

  const receptionDb = env.authenticatedContext("reception-user").firestore();
  await assertSucceeds(getDoc(doc(receptionDb, "eventBundles", "opaque-token-1")));
  await assertFails(setDoc(doc(receptionDb, "eventBundles", "opaque-token-2"), {
    authToken: "opaque-token-2", event: { eventId: "event-2" }, tickets: [],
  }));

  const managementDb = env.authenticatedContext("bundle-manager").firestore();
  await assertSucceeds(setDoc(doc(managementDb, "eventBundles", "opaque-token-2"), {
    authToken: "opaque-token-2", event: { eventId: "event-2" }, tickets: [],
  }));
});

test("management writes require the installation UID and exact approved management role", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "uid-mismatch-user"), {
      terminalId: "T-MISMATCH-01", authUid: "some-other-user", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-MISMATCH-01"), {
      terminalId: "T-MISMATCH-01", approved: true, managementApproved: true, role: "management",
    });
    await setDoc(doc(db, "terminalInstallations", "missing-management-flag-user"), {
      terminalId: "T-MISSING-FLAG-01", authUid: "missing-management-flag-user", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-MISSING-FLAG-01"), {
      terminalId: "T-MISSING-FLAG-01", approved: true, role: "management",
    });
  });

  const mismatchedDb = env.authenticatedContext("uid-mismatch-user").firestore();
  await assertFails(setDoc(doc(mismatchedDb, "events", "event-mismatch"), { eventId: "event-mismatch" }));

  const missingFlagDb = env.authenticatedContext("missing-management-flag-user").firestore();
  await assertFails(setDoc(doc(missingFlagDb, "events", "event-missing-flag"), { eventId: "event-missing-flag" }));
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

  // Unrelated clients must not read another terminal's status.
  await assertFails(getDoc(doc(db, "terminals", "T-ABCDEFGH")));
});
