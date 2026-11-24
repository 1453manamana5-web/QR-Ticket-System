import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import { assertFails, assertSucceeds, initializeTestEnvironment } from "@firebase/rules-unit-testing";
import { collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, writeBatch, query, where } from "firebase/firestore";

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

for (const [authority, targetRole, allowed] of [
  ["ordinary", "reception", false], ["ordinary", "management", false],
  ["subAdmin", "reception", true], ["subAdmin", "management", false],
  ["admin", "reception", true], ["admin", "management", true],
]) {
  test(`terminal deletion requires administrator authority: ${authority} deleting ${targetRole}`, async () => {
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await setDoc(doc(db, "terminals", "T-DELETE-MANAGER"), {
        terminalId: "T-DELETE-MANAGER", requestedByUid: "delete-manager", approved: true,
        role: "management", managementApproved: true, receptionApproved: false,
        admin: authority === "admin", subAdmin: authority === "subAdmin",
      });
      await setDoc(doc(db, "terminalOwners", "T-DELETE-MANAGER"), {
        terminalId: "T-DELETE-MANAGER", ownerUid: "delete-manager", enabled: true,
      });
      await setDoc(doc(db, "terminalInstallations", "delete-manager"), {
        terminalId: "T-DELETE-MANAGER", authUid: "delete-manager", approved: true,
      });
      await setDoc(doc(db, "terminals", "T-DELETE-TARGET"), {
        terminalId: "T-DELETE-TARGET", requestedByUid: "delete-target", approved: true,
        role: targetRole, managementApproved: targetRole === "management",
        receptionApproved: targetRole === "reception", admin: false, subAdmin: false,
      });
      await setDoc(doc(db, "terminalOwners", "T-DELETE-TARGET"), {
        terminalId: "T-DELETE-TARGET", ownerUid: "delete-target", enabled: true,
      });
    });
    const db = env.authenticatedContext("delete-manager").firestore();
    const batch = writeBatch(db);
    batch.delete(doc(db, "terminals", "T-DELETE-TARGET"));
    batch.set(doc(db, "terminalOwners", "T-DELETE-TARGET"), {
      terminalId: "T-DELETE-TARGET", ownerUid: "delete-target", enabled: false,
      deletedByUid: "delete-manager", updatedAt: new Date().toISOString(),
    }, { merge: true });
    await (allowed ? assertSucceeds(batch.commit()) : assertFails(batch.commit()));
  });
}

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

test("approved reception installations cannot read event or ticket documents but can inspect their own terminal", async () => {
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
  await assertFails(getDoc(doc(db, "events", "event-1")));
  await assertFails(getDocs(collection(db, "events")));
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
  await assertFails(setDoc(doc(db, "receptionErrors", "forged-error"), { errorId: "forged-error" }));
});

test("legacy reception terminals can fetch the published event and bundle", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "legacy-reception"), {
      terminalId: "T-LEGACY-RECEPTION", authUid: "legacy-reception", approved: true,
    });
    await setDoc(doc(db, "terminalOwners", "T-LEGACY-RECEPTION"), {
      terminalId: "T-LEGACY-RECEPTION", ownerUid: "legacy-reception", enabled: true,
    });
    // Older approved terminals may predate the explicit receptionApproved flag.
    await setDoc(doc(db, "terminals", "T-LEGACY-RECEPTION"), {
      terminalId: "T-LEGACY-RECEPTION", approved: true, role: "reception",
    });
    await setDoc(doc(db, "events", "event-legacy"), {
      eventId: "event-legacy",
      eventName: "旧形式の受付端末向け公開イベント",
      eventStatus: "ready",
      dataVersion: 1,
      authToken: "legacy-token",
      receptionTarget: true,
    });
    await setDoc(doc(db, "eventBundles", "legacy-token"), {
      authToken: "legacy-token",
      event: { eventId: "event-legacy" },
      tickets: [],
    });
  });
  const db = env.authenticatedContext("legacy-reception").firestore();
  await assertSucceeds(getDoc(doc(db, "events", "event-legacy")));
  await assertFails(getDocs(collection(db, "events")));
  await assertSucceeds(getDoc(doc(db, "eventBundles", "legacy-token")));
});

test("handed-off reception installations cannot inherit management access or read event documents directly", async () => {
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
  await assertFails(getDoc(doc(db, "events", "event-shared")));
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

test("disabled owner tombstones and released installations revoke access immediately", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "revoked-management"), {
      terminalId: "T-REVOKED-MANAGEMENT", authUid: "revoked-management", approved: true,
    });
    await setDoc(doc(db, "terminals", "T-REVOKED-MANAGEMENT"), {
      terminalId: "T-REVOKED-MANAGEMENT", approved: true,
      managementApproved: true, role: "management",
    });
    await setDoc(doc(db, "terminalOwners", "T-REVOKED-MANAGEMENT"), {
      terminalId: "T-REVOKED-MANAGEMENT", ownerUid: "revoked-management",
      enabled: false, deletedAt: new Date().toISOString(),
    });

    await setDoc(doc(db, "terminalInstallations", "released-reception"), {
      terminalId: "T-RELEASED-RECEPTION", authUid: "released-reception",
      approved: false, releasedAt: new Date().toISOString(),
    });
    await setDoc(doc(db, "terminals", "T-RELEASED-RECEPTION"), {
      terminalId: "T-RELEASED-RECEPTION", approved: true,
      receptionApproved: true, role: "reception",
    });
    await setDoc(doc(db, "terminalOwners", "T-RELEASED-RECEPTION"), {
      terminalId: "T-RELEASED-RECEPTION", ownerUid: "original-owner", enabled: true,
    });
    await setDoc(doc(db, "events", "event-revocation"), {
      eventId: "event-revocation", eventStatus: "ready",
      authToken: "revocation-token", receptionTarget: true,
    });
    await setDoc(doc(db, "eventBundles", "revocation-token"), {
      authToken: "revocation-token", event: { eventId: "event-revocation" }, tickets: [],
    });
  });

  const revokedManagementDb = env.authenticatedContext("revoked-management").firestore();
  await assertFails(setDoc(doc(revokedManagementDb, "events", "forbidden-after-delete"), {
    eventId: "forbidden-after-delete",
  }));

  const releasedReceptionDb = env.authenticatedContext("released-reception").firestore();
  await assertFails(getDoc(doc(releasedReceptionDb, "eventBundles", "revocation-token")));
});

test("only approved terminals can fetch event bundles and management terminals can publish", async () => {
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "events", "event-1"), {
      eventId: "event-1", eventName: "公開中イベント", eventStatus: "ready",
      dataVersion: 1, authToken: "opaque-token-1", receptionTarget: true,
    });
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
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "events", "event-1"), {
      eventId: "event-1", eventName: "終了イベント", eventStatus: "finished",
      dataVersion: 1, authToken: "opaque-token-1", receptionTarget: false,
    });
  });
  await assertFails(getDoc(doc(receptionDb, "eventBundles", "opaque-token-1")));
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
  await assertFails(getDoc(doc(db, "terminalApplications", "T-ABCDEFGH")));
  await assertFails(setDoc(doc(db, "terminalApplications", "T-ABCDEFGH"), {
    terminalId: "T-ABCDEFGH", requestedByUid: "anonymous-user-1", requestedRole: "management", status: "approved",
  }));
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


async function seedApprovedReception() {
  await env.withSecurityRulesDisabled(async context => {
    const trusted = context.firestore();
    await setDoc(doc(trusted, "terminalInstallations", "reception-writer"), {
      terminalId: "T-RECEPTION-WRITE", authUid: "reception-writer", approved: true,
    });
    await setDoc(doc(trusted, "terminalOwners", "T-RECEPTION-WRITE"), {
      terminalId: "T-RECEPTION-WRITE", ownerUid: "terminal-owner", enabled: true,
    });
    await setDoc(doc(trusted, "terminals", "T-RECEPTION-WRITE"), {
      terminalId: "T-RECEPTION-WRITE", approved: true, receptionApproved: true,
      managementApproved: false, role: "reception",
    });
    await setDoc(doc(trusted, "events", "event-live"), {
      eventId: "event-live", eventName: "公開中", eventStatus: "ready",
      dataVersion: 1, authToken: "event-live-token", receptionTarget: true,
    });
    await setDoc(doc(trusted, "events", "event-live", "receptionApprovals", "T-RECEPTION-WRITE"), {
      eventId:"event-live", terminalId:"T-RECEPTION-WRITE", requestedByUid:"reception-writer",name:"Reception",status:"approved",requestedAt:"2026-11-01T00:00:00.000Z",
    });
    await setDoc(doc(trusted, "events", "event-live", "tickets", "ticket-0001"), {
      ticketId: "ticket-0001", eventId: "event-live", valid: true, currentStatus: "unused",
    });
  });
}

test("approved reception client can atomically transition one ticket and append its record", async () => {
  await seedApprovedReception();
  const db = env.authenticatedContext("reception-writer").firestore();
  const eventRef = doc(db, "events", "event-live");
  const ticketRef = doc(db, "events", "event-live", "tickets", "ticket-0001");
  const recordRef = doc(db, "events", "event-live", "receptionRecords", "record-12345678");
  const timestamp = "2026-10-23T14:00:00.000Z";

  const batch = writeBatch(db);
  batch.update(ticketRef, {
    currentStatus: "inside", updatedAt: timestamp, lastReceptionRecordId: "record-12345678",
  });
  batch.set(recordRef, {
    recordId: "record-12345678", eventId: "event-live", ticketId: "ticket-0001",
    terminalId: "T-RECEPTION-WRITE", type: "entry", timestamp,
  });
  await assertSucceeds(batch.commit());
});

test("approved reception client cannot change a ticket status without a matching record", async () => {
  await seedApprovedReception();
  const db = env.authenticatedContext("reception-writer").firestore();
  await assertFails(updateDoc(doc(db, "events", "event-live", "tickets", "ticket-0001"), {
    currentStatus: "inside",
    updatedAt: "2026-10-23T14:00:00.000Z",
    lastReceptionRecordId: "record-12345678",
  }));
});

test("reception clients cannot write a record for an unpublished event or another terminal", async () => {
  await seedApprovedReception();
  const db = env.authenticatedContext("reception-writer").firestore();
  await env.withSecurityRulesDisabled(async context => {
    await setDoc(doc(context.firestore(), "events", "event-old"), {
      eventId: "event-old", eventStatus: "finished", receptionTarget: false,
    });
    await setDoc(doc(context.firestore(), "events", "event-old", "tickets", "ticket-old"), {
      ticketId: "ticket-old", eventId: "event-old", valid: true, currentStatus: "unused",
    });
  });
  await assertFails(setDoc(doc(db, "events", "event-old", "receptionRecords", "record-87654321"), {
    recordId: "record-87654321", eventId: "event-old", ticketId: "ticket-old",
    terminalId: "T-RECEPTION-WRITE", type: "entry", timestamp: "2026-10-23T14:00:00.000Z",
  }));
  await assertFails(setDoc(doc(db, "receptionErrors", "error-12345678"), {
    errorId: "error-12345678", eventId: "event-live", terminalId: "T-OTHER-TERMINAL",
    category: "camera_failed", mode: "entry", timestamp: "2026-10-23T14:00:00.000Z",
    receivedAt: serverTimestamp(),
  }));
});


test("a device can submit a pending terminal application but cannot self-approve it", async () => {
  const uid = "new-terminal-owner";
  const terminalId = "T-NEW-DEVICE-01";
  const db = env.authenticatedContext(uid).firestore();
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.set(doc(db, "terminalApplications", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: "reception",
    name: "新規受付端末", type: "Web / iPad",
    status: "pending", requestedAt: now, updatedAt: now,
  });
  batch.set(doc(db, "terminals", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: "reception",
    name: "新規受付端末", type: "Web / iPad", role: "reception",
    approved: false, managementApproved: false, receptionApproved: false,
    admin: false, subAdmin: false, status: "pending", mode: "停止",
    desiredMode: "停止", requestedAt: now, updatedAt: now, syncPendingCount: 0,
  });
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(db, "terminals", terminalId), {
    approved: true, managementApproved: true, receptionApproved: true,
  }));
});

test("a primary admin can approve a pending terminal only as an atomic trusted grant", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const now = new Date().toISOString();
    await setDoc(doc(db, "terminalInstallations", "primary-admin-user"), {
      terminalId: "T-PRIMARY-ADMIN", authUid: "primary-admin-user", approved: true,
    });
    await setDoc(doc(db, "terminalOwners", "T-PRIMARY-ADMIN"), {
      terminalId: "T-PRIMARY-ADMIN", ownerUid: "primary-admin-user", enabled: true,
    });
    await setDoc(doc(db, "terminals", "T-PRIMARY-ADMIN"), {
      terminalId: "T-PRIMARY-ADMIN", requestedByUid: "primary-admin-user",
      approved: true, managementApproved: true, receptionApproved: false,
      role: "management", admin: true, subAdmin: false,
    });
    await setDoc(doc(db, "terminals", "T-APPROVAL-TARGET"), {
      terminalId: "T-APPROVAL-TARGET", requestedByUid: "pending-reception-user",
      requestedRole: "reception", role: "reception", name: "受付端末",
      type: "Web / iPad", approved: false, managementApproved: false,
      receptionApproved: false, admin: false, subAdmin: false, status: "pending",
      mode: "停止", desiredMode: "停止", requestedAt: now, updatedAt: now, syncPendingCount: 0,
    });
    await setDoc(doc(db, "terminalApplications", "T-APPROVAL-TARGET"), {
      terminalId: "T-APPROVAL-TARGET", requestedByUid: "pending-reception-user",
      requestedRole: "reception", name: "受付端末", type: "Web / iPad",
      status: "pending", requestedAt: now, updatedAt: now,
    });
  });

  const db = env.authenticatedContext("primary-admin-user").firestore();
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.update(doc(db, "terminals", "T-APPROVAL-TARGET"), {
    approved: true, status: "offline", managementApproved: false, receptionApproved: true,
    approvalUpdatedAt: now, approvalUpdatedByUid: "primary-admin-user", updatedAt: now,
  });
  batch.set(doc(db, "terminalOwners", "T-APPROVAL-TARGET"), {
    terminalId: "T-APPROVAL-TARGET", ownerUid: "pending-reception-user", enabled: true, updatedAt: now,
  });
  batch.set(doc(db, "terminalInstallations", "pending-reception-user"), {
    terminalId: "T-APPROVAL-TARGET", authUid: "pending-reception-user",
    approved: true, registrationApprovedAt: now,
  });
  batch.update(doc(db, "terminalApplications", "T-APPROVAL-TARGET"), {
    status: "approved", decidedAt: now, decidedByUid: "primary-admin-user", updatedAt: now,
  });
  await assertSucceeds(batch.commit());
});

test("management can revoke reception, change sub-admin status, and delete only an unprotected terminal", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    const now = new Date().toISOString();
    await setDoc(doc(db, "terminalInstallations", "primary-admin-user"), {
      terminalId: "T-PRIMARY-ADMIN", authUid: "primary-admin-user", approved: true,
    });
    await setDoc(doc(db, "terminalOwners", "T-PRIMARY-ADMIN"), {
      terminalId: "T-PRIMARY-ADMIN", ownerUid: "primary-admin-user", enabled: true,
    });
    await setDoc(doc(db, "terminals", "T-PRIMARY-ADMIN"), {
      terminalId: "T-PRIMARY-ADMIN", approved: true, managementApproved: true,
      receptionApproved: false, role: "management", admin: true, subAdmin: false,
    });
    await setDoc(doc(db, "terminals", "T-LIFECYCLE-TARGET"), {
      terminalId: "T-LIFECYCLE-TARGET", requestedByUid: "lifecycle-target-user",
      requestedRole: "both", role: "both", name: "兼用端末", type: "Web / iPad",
      approved: true, managementApproved: true, receptionApproved: true,
      admin: false, subAdmin: false, status: "offline", mode: "入口受付",
      desiredMode: "入口受付", receptionApprovalVersion: 0,
    });
    await setDoc(doc(db, "terminalOwners", "T-LIFECYCLE-TARGET"), {
      terminalId: "T-LIFECYCLE-TARGET", ownerUid: "lifecycle-target-user", enabled: true,
    });
    await setDoc(doc(db, "terminalInstallations", "lifecycle-target-user"), {
      terminalId: "T-LIFECYCLE-TARGET", authUid: "lifecycle-target-user", approved: true,
    });
    await setDoc(doc(db, "terminalApplications", "T-LIFECYCLE-TARGET"), {
      terminalId: "T-LIFECYCLE-TARGET", requestedByUid: "lifecycle-target-user",
      requestedRole: "both", name: "兼用端末", type: "Web / iPad",
      status: "approved", requestedAt: now, updatedAt: now,
    });
  });

  const db = env.authenticatedContext("primary-admin-user").firestore();
  const now = new Date().toISOString();
  await assertSucceeds(updateDoc(doc(db, "terminals", "T-LIFECYCLE-TARGET"), {
    receptionApproved: false, receptionApprovalVersion: 1, approved: true,
    mode: "停止", desiredMode: "停止", desiredModeUpdatedAt: now, updatedAt: now,
    approvalUpdatedAt: now, approvalUpdatedByUid: "primary-admin-user", role: "management",
  }));
  await assertSucceeds(updateDoc(doc(db, "terminals", "T-LIFECYCLE-TARGET"), {
    subAdmin: true, subAdminUpdatedAt: now, subAdminUpdatedByUid: "primary-admin-user",
  }));
  await assertFails(deleteDoc(doc(db, "terminals", "T-LIFECYCLE-TARGET")));
  await assertSucceeds(updateDoc(doc(db, "terminals", "T-LIFECYCLE-TARGET"), {
    subAdmin: false, subAdminUpdatedAt: now, subAdminUpdatedByUid: "primary-admin-user",
  }));
  const batch = writeBatch(db);
  batch.delete(doc(db, "terminals", "T-LIFECYCLE-TARGET"));
  batch.set(doc(db, "terminalOwners", "T-LIFECYCLE-TARGET"), {
    terminalId: "T-LIFECYCLE-TARGET", ownerUid: "lifecycle-target-user",
    enabled: false, deletedAt: now, deletedByUid: "primary-admin-user", updatedAt: now,
  });
  batch.delete(doc(db, "terminalApplications", "T-LIFECYCLE-TARGET"));
  await assertSucceeds(batch.commit());
});


test("reception can discover only published events and download only active tickets", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await setDoc(doc(db, "terminalInstallations", "active-reader"), {
      terminalId: "T-ACTIVE-READER", authUid: "active-reader", approved: true,
    });
    await setDoc(doc(db, "terminalOwners", "T-ACTIVE-READER"), {
      terminalId: "T-ACTIVE-READER", ownerUid: "owner", enabled: true,
    });
    await setDoc(doc(db, "terminals", "T-ACTIVE-READER"), {
      approved: true, role: "reception", receptionApproved: true,
    });
    await setDoc(doc(db,"events","active","receptionApprovals","T-ACTIVE-READER"), {eventId:"active",terminalId:"T-ACTIVE-READER",requestedByUid:"active-reader",name:"Reader",status:"approved",requestedAt:"2026-11-01T00:00:00.000Z"});
    for (const [id, target, status] of [
      ["active", true, "ready"], ["private", false, "preparing"], ["finished", true, "finished"],
    ]) {
      await setDoc(doc(db, "events", id), { eventId: id, receptionTarget: target, eventStatus: status });
      await setDoc(doc(db, "events", id, "tickets", "ticket-1"), {
        eventId: id, ticketId: "ticket-1", valid: true, currentStatus: "unused",
      });
    }
  });
  const db = env.authenticatedContext("active-reader").firestore();
  await assertSucceeds(getDocs(query(collection(db, "events"), where("receptionTarget", "==", true))));
  await assertFails(getDocs(collection(db, "events")));
  await assertFails(getDoc(doc(db, "events", "private")));
  await assertSucceeds(getDocs(collection(db, "events", "active", "tickets")));
  await assertSucceeds(getDoc(doc(db, "events", "active", "tickets", "ticket-1")));
  for (const id of ["private", "finished", "missing"]) {
    await assertFails(getDocs(collection(db, "events", id, "tickets")));
  }
  await assertFails(updateDoc(doc(db, "events", "active"), { receptionTarget: false }));
  await assertFails(updateDoc(doc(db, "events", "active", "tickets", "ticket-1"), { valid: false }));
  for (const uid of [null, "unapproved"]) {
    const denied = uid ? env.authenticatedContext(uid).firestore() : env.unauthenticatedContext().firestore();
    await assertFails(getDocs(query(collection(denied, "events"), where("receptionTarget", "==", true))));
    await assertFails(getDocs(collection(denied, "events", "active", "tickets")));
  }
  await env.withSecurityRulesDisabled(context =>
    updateDoc(doc(context.firestore(), "terminalOwners", "T-ACTIVE-READER"), { enabled: false }));
  await assertFails(getDocs(collection(db, "events", "active", "tickets")));
});

test("management can remove reception history during event deletion; reception cannot", async () => {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    for (const [uid, role] of [["delete-manager", "management"], ["delete-reception", "reception"]]) {
      await setDoc(doc(db, "terminalInstallations", uid), { terminalId: uid, authUid: uid, approved: true });
      await setDoc(doc(db, "terminalOwners", uid), { terminalId: uid, ownerUid: uid, enabled: true });
      await setDoc(doc(db, "terminals", uid), {
        approved: true, role, managementApproved: role === "management", receptionApproved: role === "reception",
      });
    }
    await setDoc(doc(db, "events", "delete-event"), { receptionTarget: true });
    await setDoc(doc(db, "events", "delete-event", "receptionRecords", "r1"), {
      terminalId: "delete-reception",
    });
  });
  const ref = uid => doc(env.authenticatedContext(uid).firestore(), "events", "delete-event", "receptionRecords", "r1");
  await assertFails(deleteDoc(ref("delete-reception")));
  await assertFails(deleteDoc(ref("unapproved")));
  await assertSucceeds(deleteDoc(ref("delete-manager")));
});


test("pending owner can cancel atomically and reapply, without deleting another or approved terminal", async () => {
  const uid = "cancel-owner";
  const terminalId = "T-CANCEL-RECEPTION";
  const db = env.authenticatedContext(uid).firestore();
  const now = new Date().toISOString();
  const create = () => {
    const batch = writeBatch(db);
    batch.set(doc(db, "terminalApplications", terminalId), {
      terminalId, requestedByUid: uid, requestedRole: "reception", name: "受付", type: "Web / iPad",
      status: "pending", requestedAt: now, updatedAt: now,
    });
    batch.set(doc(db, "terminals", terminalId), {
      terminalId, requestedByUid: uid, requestedRole: "reception", name: "受付", type: "Web / iPad",
      role: "reception", approved: false, managementApproved: false, receptionApproved: false,
      admin: false, subAdmin: false, status: "pending", mode: "停止", desiredMode: "停止",
      requestedAt: now, updatedAt: now, syncPendingCount: 0,
    });
    return batch.commit();
  };
  await assertSucceeds(create());
  await assertFails(deleteDoc(doc(db, "terminals", terminalId)));
  const foreignDb = env.authenticatedContext("other-owner").firestore();
  const foreignBatch = writeBatch(foreignDb);
  foreignBatch.delete(doc(foreignDb, "terminals", terminalId));
  foreignBatch.delete(doc(foreignDb, "terminalApplications", terminalId));
  await assertFails(foreignBatch.commit());
  const cancel = writeBatch(db);
  cancel.delete(doc(db, "terminals", terminalId));
  cancel.delete(doc(db, "terminalApplications", terminalId));
  await assertSucceeds(cancel.commit());
  await assertSucceeds(create());
  await env.withSecurityRulesDisabled(context =>
    updateDoc(doc(context.firestore(), "terminals", terminalId), { approved: true }));
  const approvedCancel = writeBatch(db);
  approvedCancel.delete(doc(db, "terminals", terminalId));
  approvedCancel.delete(doc(db, "terminalApplications", terminalId));
  await assertFails(approvedCancel.commit());
});

const counterIdentity = "5b1c80c3-9924-4ed9-a1f2-71c39e9fd93d";
const counterPassageId = "ledger:97da10aa-c291-4e38-94fe-55d87a336b11";
const legacyCounterId = "ledger:877f6381-c291-42c1-91f7-658380631d10";
const counterRevisionId = "edit:d2139319-0b7b-4aa4-8ad9-d23e4460b8f1";
const counterDevice = (db, uid, event = "festival") => doc(db,"events",event,"counterDevices",uid);
const counterDevices = db => collection(db,"events","festival","counterDevices");
const counterConfig = (db, mode = "live") => doc(db,"events","festival","counterConfig",mode);
const counterOperations = (db, mode = "live", event = "festival") => collection(db,"events",event,"counterRuns",mode,"operations");
const counterOperation = (db, id = counterPassageId, mode = "live", event = "festival") => doc(counterOperations(db,mode,event),id);
const counterDb = uid => env.authenticatedContext(uid).firestore();
const pendingCounterDevice = {name: "入口端末", device:counterIdentity, role:"in", status:"pending"};
const wallTime = 1750000000000;
const counterPayload = {id:counterPassageId, kind:"passage", eventId:"festival", mode:"live", device:counterIdentity,
  rawAt:wallTime, at:wallTime, station:"in", direction:"in", person:"visitor", source:"auto", invalid:false};
const counterData = payload => ({payload, receivedAt:serverTimestamp()});

async function seedCounterRoles() {
  await env.withSecurityRulesDisabled(async context => {
    const db = context.firestore();
    await Promise.all([setDoc(doc(db,"events","festival"),{receptionTarget:true}), setDoc(doc(db,"events","other"),{})]);
    for (const [uid,role] of [["counter-admin","management"],["counter-sub","management"],
      ["counter-observer","management"],["qr-only","reception"]]) {
      const terminalId = `terminal-${uid}`;
      await Promise.all([
        setDoc(doc(db,"terminalInstallations",uid),{authUid:uid,terminalId,approved:true}),
        setDoc(doc(db,"terminalOwners",terminalId),{ownerUid:uid,enabled:true}),
        setDoc(doc(db,"terminals",terminalId),{approved:true,role,managementApproved:role === "management",
          admin:uid === "counter-admin",subAdmin:uid === "counter-sub"}),
      ]);
    }
    await setDoc(doc(db,"events","festival","receptionApprovals","terminal-qr-only"),{status:"approved",requestedByUid:"qr-only"});
  });
}

async function enrollCounterStation(station, admin) {
  await assertSucceeds(setDoc(counterDevice(station,"counter-station"),{...pendingCounterDevice,requestedAt:serverTimestamp()}));
  await assertSucceeds(updateDoc(counterDevice(admin,"counter-station"),
    {status:"approved",updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
}

test("counter devices self-enroll only as pending; operators can inspect and only the admin can approve", async () => {
  await seedCounterRoles();
  const station = counterDb("counter-station"), stranger = counterDb("stranger"), admin = counterDb("counter-admin"), sub = counterDb("counter-sub");
  const request = {...pendingCounterDevice,requestedAt:serverTimestamp()};
  await assertSucceeds(getDoc(counterDevice(station,"counter-station")));
  await assertFails(setDoc(counterDevice(station,"someone-else"),request));
  await assertFails(setDoc(counterDevice(station,"counter-station","missing"),request));
  await assertFails(setDoc(counterDevice(station,"counter-station"),{...request,status:"approved"}));
  await assertSucceeds(setDoc(counterDevice(station,"counter-station"),request));
  await assertSucceeds(getDoc(counterDevice(station,"counter-station")));
  await assertFails(getDoc(counterDevice(stranger,"counter-station")));
  await assertFails(getDocs(counterDevices(station)));
  await assertSucceeds(getDocs(counterDevices(admin)));
  await assertSucceeds(getDocs(counterDevices(sub)));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),{status:"approved"}));
  await assertFails(updateDoc(counterDevice(sub,"counter-station"),{status:"approved",updatedAt:serverTimestamp(),updatedByUid:"counter-sub"}));
  await assertFails(updateDoc(counterDevice(admin,"counter-station"),{device:"80913781-fc6d-4af0-8b9f-9b808d4e1259",status:"approved",updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
  await assertSucceeds(updateDoc(counterDevice(admin,"counter-station"),{status:"approved",updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
  const heartbeat = {lastSeen:serverTimestamp(),version:"13",camera:true,ai:true,profile:"detail",pending:2,alert:"none",mode:"live"};
  await assertSucceeds(updateDoc(counterDevice(station,"counter-station"),heartbeat));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),{...heartbeat,rawTrackCount:2}));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),{...heartbeat,alert:"自由入力"}));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),{...heartbeat,status:"revoked"}));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),{...heartbeat,role:"out"}));
  await assertSucceeds(updateDoc(counterDevice(admin,"counter-station"),{status:"revoked",updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
  await assertFails(updateDoc(counterDevice(station,"counter-station"),heartbeat));
  await assertFails(deleteDoc(counterDevice(admin,"counter-station")));
});

test("counter config is event and mode scoped; only admin sets hours and subadmin can pause", async () => {
  await seedCounterRoles();
  const admin = counterDb("counter-admin"), sub = counterDb("counter-sub"), station = counterDb("counter-station");
  const qr = counterDb("qr-only"), observer = counterDb("counter-observer");
  const config = {opened:wallTime,closed:null,paused:false,verified:false,updatedAt:serverTimestamp(),updatedByUid:"counter-admin"};
  await enrollCounterStation(station,admin);
  await assertFails(setDoc(counterConfig(admin,"unknown"),config));
  await assertFails(setDoc(counterConfig(admin),{...config,verified:true}));
  await assertFails(setDoc(counterConfig(admin),{...config,opened:wallTime + .5}));
  await assertFails(setDoc(counterConfig(sub),{...config,updatedByUid:"counter-sub"}));
  await assertSucceeds(setDoc(counterConfig(admin),config));
  await assertSucceeds(setDoc(counterConfig(admin,"test"),{...config,opened:null}));
  await assertSucceeds(getDoc(counterConfig(station)));
  await assertSucceeds(getDoc(counterConfig(sub)));
  await assertFails(getDoc(counterConfig(qr)));
  await assertFails(getDoc(counterConfig(observer)));
  const pause = {paused:true,updatedAt:serverTimestamp(),updatedByUid:"counter-sub"};
  await assertSucceeds(updateDoc(counterConfig(sub),pause));
  await assertFails(updateDoc(counterConfig(sub),{...pause,opened:wallTime+1}));
  await assertFails(updateDoc(counterConfig(station),{...pause,updatedByUid:"counter-station"}));
  await assertFails(updateDoc(counterConfig(admin),{closed:wallTime-1,updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
  await assertSucceeds(updateDoc(counterConfig(admin),{closed:wallTime+1,verified:true,updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
});

test("counter ledger grants reads only to enrolled stations and operators; operation admission is event, mode, device, and role bound", async () => {
  await seedCounterRoles();
  await env.withSecurityRulesDisabled(context => setDoc(counterOperation(context.firestore(),legacyCounterId),counterData("{}")));
  const admin = counterDb("counter-admin"), station = counterDb("counter-station"), qr = counterDb("qr-only");
  const stranger = counterDb("stranger"), observer = counterDb("counter-observer");
  const request = {...pendingCounterDevice,requestedAt:serverTimestamp()};
  await assertSucceeds(setDoc(counterDevice(station,"counter-station"),request));
  await assertFails(getDocs(counterOperations(station)));
  await assertFails(setDoc(counterOperation(station),counterData(counterPayload)));
  await assertFails(setDoc(counterOperation(qr),counterData(counterPayload)));
  await assertSucceeds(updateDoc(counterDevice(admin,"counter-station"),{status:"approved",updatedAt:serverTimestamp(),updatedByUid:"counter-admin"}));
  await assertSucceeds(getDoc(counterOperation(station,legacyCounterId)));
  await assertSucceeds(getDoc(counterOperation(admin,legacyCounterId)));
  await assertFails(getDoc(counterOperation(qr,legacyCounterId)));
  await assertFails(getDocs(counterOperations(stranger)));
  await assertFails(getDocs(counterOperations(observer)));
  await assertFails(getDocs(counterOperations(station,"live","other")));
  await assertFails(setDoc(counterOperation(station,counterPassageId,"live","other"),counterData({...counterPayload,eventId:"other"})));
  await assertFails(setDoc(counterOperation(station,counterPassageId,"test"),counterData(counterPayload)));
  await assertFails(setDoc(counterOperation(station,counterPassageId,"unknown"),counterData({...counterPayload,mode:"unknown"})));
  await assertFails(setDoc(counterOperation(station),counterData(JSON.stringify(counterPayload))));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,device:"other"})));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,station:"out",direction:"out"})));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,direction:"out"})));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,person:"staff"})));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,actorUid:"stranger"})));
  await assertFails(setDoc(counterOperation(station),counterData({...counterPayload,cameraFrames:[]})));
  await assertSucceeds(setDoc(counterOperation(station),counterData(counterPayload)));
  await assertSucceeds(setDoc(counterOperation(station,counterPassageId,"test"),counterData({...counterPayload,mode:"test"})));
  await assertSucceeds(getDocs(counterOperations(station)));
  await assertFails(updateDoc(counterOperation(admin), {payload:"overwritten"}));
  await assertFails(deleteDoc(counterOperation(admin)));
  await assertSucceeds(setDoc(doc(station,"counterClocks","counter-station"),{at:serverTimestamp(),eventId:"festival"}));
  await assertFails(setDoc(doc(station,"counterClocks","stranger"),{at:serverTimestamp(),eventId:"festival"}));
});

test("counter managers can append manual entries and revisions without forging identities or overwriting records", async () => {
  await seedCounterRoles();
  const sub = counterDb("counter-sub"), station = counterDb("counter-station"), admin = counterDb("counter-admin");
  await enrollCounterStation(station,admin);
  const manual = {...counterPayload,actorUid:"counter-sub",device:"terminal-counter-sub",source:"manual"};
  await assertFails(setDoc(counterOperation(station),counterData({...manual,actorUid:"counter-station",device:counterIdentity})));
  await assertFails(setDoc(counterOperation(sub),counterData({...manual,device:counterIdentity})));
  await assertFails(setDoc(counterOperation(sub),counterData({...manual,actorUid:"counter-admin"})));
  await assertSucceeds(setDoc(counterOperation(sub),counterData(manual)));
  const before = {at:wallTime,direction:"in",person:"visitor",invalid:false,clockWarning:"",clockUncertainty:null};
  const revision = {id:counterRevisionId,target:counterPassageId,parent:counterPassageId,eventId:"festival",mode:"live",
    kind:"revision",rawAt:wallTime,station:"in",actorUid:"counter-sub",device:"terminal-counter-sub",reason:"訂正",resolves:[],before,after:{...before,invalid:true}};
  await assertFails(setDoc(counterOperation(station,counterRevisionId),counterData({...revision,actorUid:"counter-station",device:counterIdentity})));
  await assertFails(setDoc(counterOperation(sub,counterRevisionId),counterData({...revision,after:{...before,pose:[]}})));
  await assertSucceeds(setDoc(counterOperation(sub,counterRevisionId),counterData(revision)));
});
