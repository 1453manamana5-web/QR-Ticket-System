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
    projectId: "qr-ticket-flow-test",
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
async function createPublished(c, event = makeEvent(), tickets = [makeTicket(event.eventId)]) {
  const active = await getDocsFromServer(firestore.query(collection(c.managerDb,"events"),firestore.where("receptionTarget","==",true)));
  for (const target of active.docs) if (target.id !== event.eventId) await c.reception.saveTerminalHeartbeat("T-FLOW-RECEPTION","stopped",0,target.id);
  await c.management.saveEvent(event);
  await c.management.saveReceptionSettings(event.eventId, settings);
  await c.management.saveTickets(event.eventId, tickets);
  return c.publisher.publishEventBundle(event, settings, tickets);
}

test("real client flow: save, publish, download, offline entry/exit/reentry, retry, delete", async () => {
  const c = clients();
  const bundle = await createPublished(c);
  const downloaded = await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION");
  assert.equal(downloaded.tickets.length, 1);
  assert.equal(downloaded.authPayload.authToken, bundle.authToken);
  await c.local.prepareLocalEventData(downloaded.localEvent, downloaded.tickets);
  assert.equal((await c.local.loadLocalEvent()).dataReady, true);
  let ticket = await c.local.getTicket("ticket-1");
  // Intentionally reverse UUID order relative to capture time.
  const captures = [
    ["z-entry", "entry", "inside", "2026-10-25T01:00:00.000Z"],
    ["a-exit", "exit", "exited", "2026-10-25T01:01:00.000Z"],
    ["m-reentry", "reentry", "inside", "2026-10-25T01:02:00.000Z"],
  ];
  for (const [recordId, type, currentStatus, timestamp] of captures) {
    ticket = { ...ticket, currentStatus, updatedAt: timestamp };
    await c.local.saveReceptionTransaction(ticket, {
      recordId, type, timestamp, eventId: "flow-event", ticketId: "ticket-1", terminalId: "T-FLOW-RECEPTION",
    });
  }
  // All writes above are local only: the server must still be unused.
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event", "tickets", "ticket-1"))).data().currentStatus, "unused");
  const queue = await c.local.getPendingSyncItems();
  assert.deepEqual(Array.from(queue, item => item.recordId), ["z-entry", "a-exit", "m-reentry"]);
  for (const item of queue) {
    const record = await c.local.getReceptionRecord(item.recordId);
    await c.reception.syncReceptionRecord(record, await c.local.getTicket(record.ticketId));
    await c.local.markSyncStatus(item.recordId, "synced", item.retryCount);
    // A lost acknowledgement and retry must not write a second record.
    await c.reception.syncReceptionRecord(record, ticket);
  }
  assert.equal((await c.local.getPendingSyncItems()).length, 0);
  assert.equal((await getDocsFromServer(collection(c.managerDb, "events", "flow-event", "receptionRecords"))).size, 3);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event", "tickets", "ticket-1"))).data().currentStatus, "inside");
  await assert.rejects(c.reception.syncReceptionRecord({
    recordId: "duplicate-entry", type: "entry", timestamp: "2026-10-25T01:03:00.000Z",
    eventId: "flow-event", ticketId: "ticket-1", terminalId: "T-FLOW-RECEPTION",
  }, ticket), /permission/i);
  await c.management.deleteEvent("flow-event");
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event"))).exists(), false);
  for (const name of ["tickets", "receptionRecords", "settings"]) {
    assert.equal((await getDocsFromServer(collection(c.managerDb, "events", "flow-event", name))).size, 0);
  }
  assert.equal((await getDocFromServer(doc(c.managerDb, "eventBundles", bundle.authToken))).exists(), false);
});

test("ticket edits advance event and bundle together; zero tickets cannot resurrect a legacy embedded list", async () => {
  const c = clients();
  const bundle = await createPublished(c);
  const oldPayload = await c.downloader.getEventAuthPayloadByToken(bundle.authToken);
  const updated = { ...makeTicket("flow-event"), basicInfo: { number: "edited" } };
  await c.management.saveTicket("flow-event", updated);
  const event = (await getDocFromServer(doc(c.managerDb, "events", "flow-event"))).data();
  const published = (await getDocFromServer(doc(c.managerDb, "eventBundles", bundle.authToken))).data();
  assert.equal(event.dataVersion, 2);
  assert.equal(published.event.dataVersion, event.dataVersion);
  await assert.rejects(c.downloader.downloadEventData(oldPayload, "T-FLOW-RECEPTION"), /EVENT_DATA_INVALID/);
  assert.equal((await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION")).tickets[0].basicInfo.number, "edited");
  await setDoc(doc(c.managerDb, "eventBundles", bundle.authToken), { tickets: [updated] }, { merge: true });
  await c.management.deleteTicket("flow-event", "ticket-1");
  assert.equal((await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION")).tickets.length, 0);
  assert.equal((await c.publisher.loadPublishedEventBundle("flow-event")).tickets.length, 0);
});

test("switching publication selects one target and denies the old or finished event", async () => {
  const c = clients();
  const old = await createPublished(c);
  const next = makeEvent("flow-next");
  await createPublished(c, next);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event"))).data().receptionTarget, false);
  assert.equal((await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION")).localEvent.event.eventId, "flow-next");
  await assert.rejects(c.downloader.getEventAuthPayloadByToken(old.authToken), /permission/i);
  await c.management.saveEvent({ ...next, eventStatus: "finished" });
  await assert.rejects(c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION"), /NO_PUBLISHED_EVENT/);
});

test("451 tickets cross the write-batch boundary and download to IndexedDB without embedding the bundle", async () => {
  const c = clients();
  const event = makeEvent("large-flow");
  const tickets = Array.from({ length: 451 }, (_, i) => makeTicket(event.eventId, "ticket-" + i));
  const bundle = await createPublished(c, event, tickets);
  const stored = (await getDocFromServer(doc(c.managerDb, "eventBundles", bundle.authToken))).data();
  assert.equal("tickets" in stored, false);
  const downloaded = await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION");
  assert.equal(downloaded.tickets.length, 451);
  await c.local.prepareLocalEventData(downloaded.localEvent, downloaded.tickets);
  assert.equal(await c.local.countTickets(event.eventId), 451);
});

test("a failed publication batch leaves the previous published event available", async () => {
  const c = clients();
  await createPublished(c);
  await c.reception.saveTerminalHeartbeat("T-FLOW-RECEPTION","stopped",0,"flow-event");
  const next = makeEvent("failed-next");
  await c.management.saveEvent(next);
  await c.management.saveTickets(next.eventId, [makeTicket(next.eventId)]);
  const failing = loadClientModule("./management-app/src/eventPublisher.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER", {}, {
    runTransaction: async()=>{throw Error("simulated-publication-failure");},
  });
  await assert.rejects(failing.publishEventBundle(next, settings, []), /simulated-publication-failure/);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event"))).data().receptionTarget, true);
  assert.equal((await c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION")).localEvent.event.eventId, "flow-event");
});

test("aborted inventory metadata transaction cannot leave event and bundle on different versions", async () => {
  const c = clients();
  const bundle = await createPublished(c);
  const failing = loadClientModule("./management-app/src/firebaseData.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER", {}, {
    runTransaction: (db, operation) => firestore.runTransaction(db, async tx => {
      await operation(tx);
      throw Error("simulated-metadata-failure");
    }),
  });
  await assert.rejects(failing.saveTicket("flow-event", makeTicket("flow-event")), /simulated-metadata-failure/);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "flow-event"))).data().dataVersion, 1);
  assert.equal((await getDocFromServer(doc(c.managerDb, "eventBundles", bundle.authToken))).data().event.dataVersion, 1);
});

test("download rejects an incomplete ticket inventory instead of marking local data ready", async () => {
  const c = clients();
  const bundle = await createPublished(c);
  await updateDoc(doc(c.managerDb, "eventBundles", bundle.authToken), { ticketCount: 2 });
  await assert.rejects(c.downloader.downloadCurrentFirebaseEventData("T-FLOW-RECEPTION"), /EVENT_TICKET_COUNT_MISMATCH/);
});

test("stale publication cannot roll back a status changed by another manager", async () => {
  const c = clients();
  await createPublished(c);
  const stale = {...makeEvent(), eventStatus: "ready"};
  for (const status of ["active", "finalizing"]) {
    await updateDoc(doc(c.managerDb, "events", stale.eventId), {eventStatus: status});
    const published = await c.publisher.publishEventBundle(stale, settings, []);
    assert.equal(published.event.eventStatus, status);
    assert.equal((await getDocFromServer(doc(c.managerDb, "events", stale.eventId))).data().eventStatus, status);
  }
});

test("late publication and status writes cannot recreate or reopen a deleted or finished event", async () => {
  const c = clients();
  const stale = makeEvent();
  await createPublished(c, stale);
  await c.publisher.saveEventStatus(stale.eventId, "finished");
  await assert.rejects(c.publisher.saveEventStatus(stale.eventId, "active"), /EVENT_FINISHED/);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", stale.eventId))).data().eventStatus, "finished");
  await c.management.deleteEvent(stale.eventId);
  await assert.rejects(c.publisher.publishEventBundle(stale, settings, []), /EVENT_NOT_FOUND/);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", stale.eventId))).exists(), false);
});

test("deleting the last issued tickets does not block later issuance or reuse their numbers",async()=>{
  const c=clients(),event=makeEvent('issuance-floor');
  await c.management.saveEvent(event);
  const tickets=[1,2,3].map(number=>({...makeTicket(event.eventId,'TKT'+String(number).padStart(6,'0')),basicInfo:{ticketNumber:number}}));
  await c.management.appendTickets(event.eventId,tickets,true);
  await c.management.deleteTicket(event.eventId,tickets[2].ticketId);
  await c.management.deleteTicket(event.eventId,tickets[1].ticketId);
  const next=await c.management.loadNextTicketNumber(event.eventId,'TKT');
  assert.equal(next,4);
  await c.management.appendTickets(event.eventId,[{...makeTicket(event.eventId,'TKT000004'),basicInfo:{ticketNumber:next}}],true);
  assert.equal((await c.management.loadEventTickets(event.eventId)).length,2);
  await c.publisher.saveEventStatus(event.eventId,'finished');
  await assert.rejects(c.management.loadNextTicketNumber(event.eventId,'TKT'),/EVENT_FINISHED/);
  await assert.rejects(c.management.appendTickets(event.eventId,[{...makeTicket(event.eventId,'TKT000005'),basicInfo:{ticketNumber:5}}],true),/EVENT_FINISHED/);
});

test("reception reads another terminal's current entry state and keeps record identity after cache replacement", async () => {
  const c = clients();
  await createPublished(c);
  const entry = {recordId: "another-terminal-entry", eventId: "flow-event", ticketId: "ticket-1",
    terminalId: "T-FLOW-MANAGER", type: "entry", timestamp: "2026-10-27T01:00:00.000Z"};
  const managerReception = loadClientModule("./reception-app/src/receptionSync.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER");
  await managerReception.syncReceptionRecord(entry);
  const current = await c.reception.getLatestReceptionTicket("flow-event", "ticket-1");
  assert.equal(current.currentStatus, "inside");
  const exit = {...entry, recordId: "exit-after-entry", terminalId: "T-FLOW-RECEPTION", type: "exit", timestamp: "2026-10-27T01:01:00.000Z"};
  await c.reception.syncReceptionRecord(exit);
  assert.equal((await c.reception.getLatestReceptionTicket("flow-event", "ticket-1")).currentStatus, "exited");
  // Queue uploads no longer need the current event's local ticket inventory.
  await c.reception.syncReceptionRecord(exit);
  await assert.rejects(managerReception.syncReceptionRecord(exit), /RECEPTION_TERMINAL_CHANGED/);
  assert.equal((await getDocsFromServer(collection(c.managerDb, "events", "flow-event", "receptionRecords"))).size, 2);
});

test("deleting a republished event removes every old bundle without touching another event", async () => {
  const c = clients();
  const first = await createPublished(c);
  const second = await c.publisher.publishEventBundle(makeEvent(), settings, []);
  const other = await createPublished(c, makeEvent("keep-other"));
  await c.management.deleteEvent("flow-event");
  for (const token of [first.authToken, second.authToken]) {
    assert.equal((await getDocFromServer(doc(c.managerDb, "eventBundles", token))).exists(), false);
  }
  assert.equal((await getDocFromServer(doc(c.managerDb, "eventBundles", other.authToken))).exists(), true);
  assert.equal((await getDocFromServer(doc(c.managerDb, "events", "keep-other"))).exists(), true);
});

test("real reception registration can be approved by the manager and immediately used to download an event", async () => {
  const c = clients();
  await createPublished(c);
  const uid = "fresh-reception-user";
  const terminalId = "T-FRESH-RECEPTION";
  const db = env.authenticatedContext(uid).firestore();
  const local = loadClientModule("./reception-app/src/localDb.ts", db, uid, terminalId);
  const registration = loadClientModule("./reception-app/src/receptionSync.ts", db, uid, terminalId, local);
  await registration.registerReceptionTerminal("New reception");
  assert.equal((await registration.getTerminalRegistration()).approved, false);
  await c.management.approveTerminal(terminalId);
  const approved = await registration.getTerminalRegistration();
  assert.equal(approved.approved, true);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalOwners", terminalId))).data().ownerUid, uid);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalInstallations", uid))).data().approved, true);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalApplications", terminalId))).data().status, "approved");
  const downloader = loadClientModule("./reception-app/src/eventDownloader.ts", db, uid, terminalId);
  const event = await downloader.downloadCurrentFirebaseEventData(terminalId);
  assert.equal(event.tickets.length, 1);
});

async function registeredReception(c) {
  const uid = "reapply-reception-user", terminalId = "T-REAPPLY-RECEPTION";
  const db = env.authenticatedContext(uid).firestore();
  const registration = loadClientModule("./reception-app/src/receptionSync.ts", db, uid, terminalId);
  await registration.registerReceptionTerminal("Reapplication test");
  await c.management.approveTerminal(terminalId);
  return {uid, terminalId, db, registration};
}

test("event reapplication preserves terminal identity, requires approval again and works without a legacy version field", async () => {
  const c = clients();
  await createPublished(c);
  const r = await registeredReception(c);
  assert.equal(await r.registration.requestReceptionEventReapproval("Next event reception"), true);
  assert.equal((await r.registration.getTerminalRegistration()).approved, false);
  await assertFails(getDocsFromServer(collection(r.db, "events")));
  const pending = (await getDocFromServer(doc(c.managerDb, "terminals", r.terminalId))).data();
  assert.equal(pending.receptionApprovalVersion, 1);
  assert.equal(pending.role, "reception");
  assert.equal(pending.managementApproved, false);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalInstallations", r.uid))).data().terminalId, r.terminalId);
  await c.management.approveTerminal(r.terminalId);
  assert.equal((await r.registration.getTerminalRegistration()).approved, true);
  assert.equal((await r.registration.getLatestReceptionTicket("flow-event", "ticket-1")).currentStatus, "unused");
});

test("revoked reception can reapply, cancel and reapply again without deleting its owner mapping", async () => {
  const c = clients();
  const r = await registeredReception(c);
  await c.management.revokeManagedReception(r.terminalId);
  assert.equal(await r.registration.getTerminalRegistration(), null);
  await r.registration.registerReceptionTerminal("Reapply after event end");
  assert.equal((await r.registration.getTerminalRegistration()).approved, false);
  assert.equal(await r.registration.resetReceptionTerminalRegistration(), r.terminalId);
  assert.equal(await r.registration.getTerminalRegistration(), null);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminals", r.terminalId))).data().status, "offline");
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalOwners", r.terminalId))).data().enabled, true);
  await r.registration.registerReceptionTerminal("Reapply again");
  await c.management.approveTerminal(r.terminalId);
  assert.equal((await r.registration.getTerminalRegistration()).approved, true);
});

test("republishing settings advances the event and bundle version so reception refreshes them", async () => {
  const c = clients();
  const first = await createPublished(c);
  const second = await c.publisher.publishEventBundle(makeEvent(), {...settings, reentryEnabled: false}, []);
  assert.equal(second.event.dataVersion, first.event.dataVersion + 1);
  const payload = await c.downloader.getCurrentFirebaseEventAuthPayload();
  assert.equal(payload.dataVersion, second.event.dataVersion);
  const downloaded = await c.downloader.downloadEventData(payload, "T-FLOW-RECEPTION");
  assert.equal(downloaded.localEvent.settings.reentryEnabled, false);
});

test("reapplication rejects wrong owners, revoked grants, management roles, privilege changes and malformed schemas", async () => {
  const c = clients();
  const r = await registeredReception(c);
  await c.management.revokeManagedReception(r.terminalId);
  const applicationRef = doc(r.db, "terminalApplications", r.terminalId);
  const terminalRef = doc(r.db, "terminals", r.terminalId);
  const now = "2026-10-27T01:00:00.000Z";
  const application = {terminalId: r.terminalId, requestedByUid: r.uid, requestedRole: "reception",
    name: "Next event", type: "Web / iPad", status: "pending", requestedAt: now, updatedAt: now};
  const terminalUpdate = {name: application.name, type: application.type, status: "pending", requestedAt: now, updatedAt: now};
  for (const tamper of [
    {requestedRole: "management"}, {requestedByUid: "someone-else"}, {name: "x".repeat(81)},
    {name: 42}, {extra: true}, {status: "approved"}, {updatedAt: "x".repeat(41)},
  ]) {
    const batch = firestore.writeBatch(r.db);
    batch.set(applicationRef, {...application, ...tamper});
    batch.update(terminalRef, terminalUpdate);
    await assertFails(batch.commit());
  }
  for (const tamper of [{approved: true}, {managementApproved: true}, {admin: true}, {role: "both"}, {requestedByUid: "elsewhere"}]) {
    const batch = firestore.writeBatch(r.db);
    batch.set(applicationRef, application);
    batch.update(terminalRef, {...terminalUpdate, ...tamper});
    await assertFails(batch.commit());
  }
  await assertFails(setDoc(applicationRef, application)); // Missing paired terminal update.
  await assertFails(updateDoc(terminalRef, terminalUpdate)); // Missing paired application update.
  await assertFails(setDoc(doc(env.unauthenticatedContext().firestore(), "terminalApplications", r.terminalId), application));
  await assertFails(setDoc(doc(env.authenticatedContext("other-user").firestore(), "terminalApplications", r.terminalId), application));
  for (const [path, changes] of [
    [["terminalOwners", r.terminalId], {enabled: false}],
    [["terminalInstallations", r.uid], {approved: false}],
  ]) {
    await env.withSecurityRulesDisabled(async ctx => {await updateDoc(doc(ctx.firestore(), ...path), changes);});
    const batch = firestore.writeBatch(r.db);
    batch.set(applicationRef, application);batch.update(terminalRef, terminalUpdate);
    await assertFails(batch.commit());
    await env.withSecurityRulesDisabled(async ctx => {await updateDoc(doc(ctx.firestore(), ...path), Object.fromEntries(Object.keys(changes).map(key => [key, true])));});
  }
  // A manager's persistent installation must not be converted into a receptionist.
  const managerReception = loadClientModule("./reception-app/src/receptionSync.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER");
  assert.equal(await managerReception.requestReceptionEventReapproval("Manager reception"), false);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminals", "T-FLOW-MANAGER"))).data().managementApproved, true);
});


test("cancel a second pending reception request without releasing the existing manager installation", async () => {
  const c = clients();
  const reception = loadClientModule("./reception-app/src/receptionSync.ts", c.managerDb, "flow-manager", "T-EXTRA-RECEPTION");
  await reception.registerReceptionTerminal("Mistaken same-browser request");
  await assert.rejects(c.management.approveTerminal("T-EXTRA-RECEPTION"), /TERMINAL_INSTALLATION_CONFLICT/);
  assert.equal(await reception.resetReceptionTerminalRegistration(), "T-FLOW-MANAGER");
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalApplications", "T-EXTRA-RECEPTION"))).exists(), false);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminals", "T-EXTRA-RECEPTION"))).exists(), false);
  assert.equal((await getDocFromServer(doc(c.managerDb, "terminalInstallations", "flow-manager"))).data().terminalId, "T-FLOW-MANAGER");
  assert.equal((await c.management.loadTerminals()).find(t => t.terminalId === "T-FLOW-MANAGER").approved, true);
});


test("one verified manager installation can download and operate reception without another registration", async () => {
  const c = clients();
  await createPublished(c);
  const ids = new Map([["qr-ticket-terminal-id", "T-STALE-REQUEST"]]);
  const storage = { getItem: key => ids.get(key), setItem: (key, value) => ids.set(key, value) };
  const reception = loadClientModule("./reception-app/src/receptionSync.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER", {}, {}, storage);
  assert.equal((await reception.getTerminalRegistration()).approved, true);
  assert.equal(ids.get("qr-ticket-terminal-id"), "T-FLOW-MANAGER");
  assert.equal(ids.get("qr-ticket-device-id"), "T-FLOW-MANAGER");
  const downloader = loadClientModule("./reception-app/src/eventDownloader.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER");
  const downloaded = await downloader.downloadCurrentFirebaseEventData(ids.get("qr-ticket-terminal-id"));
  let ticket = downloaded.tickets[0];
  for (const [recordId, type, status, timestamp] of [
    ["same-entry", "entry", "inside", "2026-10-25T02:00:00.000Z"],
    ["same-exit", "exit", "exited", "2026-10-25T02:01:00.000Z"],
    ["same-reentry", "reentry", "inside", "2026-10-25T02:02:00.000Z"],
  ]) {
    ticket = { ...ticket, currentStatus: status, updatedAt: timestamp };
    const record = { recordId, type, timestamp, eventId: "flow-event", ticketId: "ticket-1", terminalId: "T-FLOW-MANAGER" };
    await reception.syncReceptionRecord(record, ticket);
    await reception.syncReceptionRecord(record, ticket);
  }
  await assert.rejects(reception.syncReceptionRecord({ recordId: "bad-entry", type: "entry", timestamp: "2026-10-25T02:03:00.000Z", eventId: "flow-event", ticketId: "ticket-1", terminalId: "T-FLOW-MANAGER" }, ticket), /permission/i);
  await reception.saveTerminalHeartbeat("T-FLOW-MANAGER", "entry", 0);
  assert.equal((await c.management.loadTerminals()).find(item => item.terminalId === "T-FLOW-MANAGER").admin, true);
  const terminal = (await getDocFromServer(doc(c.managerDb, "terminals", "T-FLOW-MANAGER"))).data();
  assert.equal(terminal.role, "management");
  assert.equal(terminal.managementApproved, true);
  assert.equal((await getDocsFromServer(collection(c.managerDb, "terminalApplications"))).size, 0);
  assert.equal((await getDocsFromServer(collection(c.managerDb, "events", "flow-event", "receptionRecords"))).size, 3);
});

for (const scenario of ["disabled-owner", "revoked-installation", "different-owner"]) {
  test("same-device reception rejects " + scenario, async () => {
    const c = clients();
    await createPublished(c);
    await env.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      if (scenario === "revoked-installation") await updateDoc(doc(db, "terminalInstallations", "flow-manager"), { approved: false });
      else await updateDoc(doc(db, "terminalOwners", "T-FLOW-MANAGER"), scenario === "disabled-owner" ? { enabled: false } : { ownerUid: "another-owner" });
    });
    const reception = loadClientModule("./reception-app/src/receptionSync.ts", c.managerDb, "flow-manager", "T-FLOW-MANAGER");
    try { assert.notEqual((await reception.getTerminalRegistration())?.approved, true); } catch (error) { assert.match(String(error), /permission/i); }
    await assert.rejects(reception.syncReceptionRecord({ recordId: "denied", type: "entry", timestamp: "2026-10-25T03:00:00.000Z", eventId: "flow-event", ticketId: "ticket-1", terminalId: "T-FLOW-MANAGER" }, makeTicket("flow-event")), /permission/i);
  });
}

test("manager field edits preserve a newer reception and cannot resurrect deleted tickets", async () => {
  const c = clients();
  await createPublished(c);
  const stale = makeTicket("flow-event");
  await c.reception.syncReceptionRecord({recordId:"concurrent-entry",eventId:"flow-event",ticketId:"ticket-1",terminalId:"T-FLOW-RECEPTION",type:"entry",timestamp:"2026-10-25T01:00:00.000Z"});
  await c.management.saveTicket("flow-event", {...stale,valid:false}, ["valid"]);
  let current=(await getDocFromServer(doc(c.managerDb,"events","flow-event","tickets","ticket-1"))).data();
  assert.equal(current.currentStatus,"inside");assert.equal(current.valid,false);
  await c.management.saveTicket("flow-event", {...stale,basicInfo:{ticketNumber:42}}, ["basicInfo"]);
  current=(await getDocFromServer(doc(c.managerDb,"events","flow-event","tickets","ticket-1"))).data();
  assert.equal(current.currentStatus,"inside");assert.equal(current.valid,false);assert.equal(current.basicInfo.ticketNumber,42);
  await c.management.deleteTicket("flow-event","ticket-1");
  await assert.rejects(c.management.saveTicket("flow-event",stale,["valid"]));
  assert.equal((await getDocFromServer(doc(c.managerDb,"events","flow-event","tickets","ticket-1"))).exists(),false);
});

test('append issuance never rolls back reception; simultaneous prefixes cannot issue the same numbers',async()=>{
  const c=clients();await createPublished(c);
  await c.reception.syncReceptionRecord({recordId:'live-entry',eventId:'flow-event',ticketId:'ticket-1',terminalId:'T-FLOW-RECEPTION',type:'entry',timestamp:'2026-10-25T01:00:00.000Z'});
  const first={...makeTicket('flow-event','A000002'),basicInfo:{ticketNumber:2}};
  const second={...makeTicket('flow-event','B000002'),basicInfo:{ticketNumber:2}};
  const results=await Promise.allSettled([c.management.appendTickets('flow-event',[first],true),c.management.appendTickets('flow-event',[second],true)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  const tickets=await c.management.loadEventTickets('flow-event');assert.equal(tickets.length,2);
  assert.equal(tickets.find(ticket=>ticket.ticketId==='ticket-1').currentStatus,'inside');
  const event=(await getDocFromServer(doc(c.managerDb,'events','flow-event'))).data();
  const bundle=(await getDocFromServer(doc(c.managerDb,'eventBundles',event.authToken))).data();
  assert.equal(event.ticketCount,2);assert.equal(bundle.ticketCount,2);assert.equal(bundle.event.dataVersion,event.dataVersion);
});

test('concurrent deletes and edits keep ticket counts and publication versions atomic',async()=>{
  const c=clients();await createPublished(c,makeEvent(),[makeTicket('flow-event','first'),makeTicket('flow-event','second')]);
  await Promise.all([c.management.deleteTicket('flow-event','first'),c.management.saveTicket('flow-event',{...makeTicket('flow-event','second'),valid:false},['valid'])]);
  const event=(await getDocFromServer(doc(c.managerDb,'events','flow-event'))).data();
  const bundle=(await getDocFromServer(doc(c.managerDb,'eventBundles',event.authToken))).data();
  assert.equal(event.ticketCount,1);assert.equal(bundle.ticketCount,1);assert.equal(bundle.event.dataVersion,event.dataVersion);
  assert.equal((await c.management.loadEventTickets('flow-event'))[0].valid,false);
});

test('publication cannot switch away while reception is active, offline or has unsent records',async()=>{
  const c=clients();await createPublished(c);
  const next=makeEvent('new-target');await c.management.saveEvent(next);
  for(const [mode,count] of [['entry',0],['stopped',1]]){
    await c.reception.saveTerminalHeartbeat('T-FLOW-RECEPTION',mode,count,'flow-event');
    await assert.rejects(c.publisher.publishEventBundle(next,settings,[]),/RECEPTION_DATA_NOT_COLLECTED/);
  }
  await c.reception.saveTerminalHeartbeat('T-FLOW-RECEPTION','stopped',0,'flow-event');
  await c.publisher.publishEventBundle(next,settings,[]);
  assert.equal((await c.downloader.getCurrentFirebaseEventAuthPayload()).eventId,'new-target');
});

test('republishing stale UI tickets after deletion cannot resurrect them or reset active event status',async()=>{
  const c=clients();await createPublished(c);const stale=makeTicket('flow-event');
  await c.publisher.saveEventStatus('flow-event','active');
  await c.management.deleteTicket('flow-event','ticket-1');
  const published=await c.publisher.publishEventBundle({...makeEvent(),eventStatus:'ready'},settings,[stale]);
  assert.equal(published.ticketCount,0);assert.equal(published.event.eventStatus,'active');
  assert.equal((await c.management.loadEventTickets('flow-event')).length,0);
});

test('management heartbeat and renaming cannot clear reception pending data or refresh its acknowledgement',async()=>{
  const c=clients();await createPublished(c);
  const reception=loadClientModule('./reception-app/src/receptionSync.ts',c.managerDb,'flow-manager','T-FLOW-MANAGER',c.local);
  await reception.saveTerminalHeartbeat('T-FLOW-MANAGER','entry',5,'flow-event');
  const before=(await getDocFromServer(doc(c.managerDb,'terminals','T-FLOW-MANAGER'))).data();
  await c.management.saveManagementTerminalHeartbeat('T-FLOW-MANAGER');
  await c.management.saveTerminal({terminalId:'T-FLOW-MANAGER',name:'Renamed',mode:'停止',syncPendingCount:0});
  const after=(await getDocFromServer(doc(c.managerDb,'terminals','T-FLOW-MANAGER'))).data();
  assert.equal(after.syncPendingCount,5);assert.equal(after.receptionMode,'entry');
  assert.equal(after.receptionReportedAt.toMillis(),before.receptionReportedAt.toMillis());
  assert.equal(after.name,'Renamed');
});

test('own heartbeat accepts only fresh validated reception metadata and cannot spoof another terminal',async()=>{
  const c=clients();await createPublished(c);
  await c.reception.saveTerminalHeartbeat('T-FLOW-RECEPTION','stopped',0,'flow-event');
  const ref=doc(c.receptionDb,'terminals','T-FLOW-RECEPTION');
  for(const change of [{receptionMode:'anything',receptionReportedAt:firestore.serverTimestamp()},{receptionEventId:42,receptionReportedAt:firestore.serverTimestamp()},{receptionReportedAt:'fake'},{receptionMode:'entry'}])await assertFails(updateDoc(ref,change));
  await assertFails(updateDoc(doc(c.receptionDb,'terminals','T-FLOW-MANAGER'),{receptionMode:'stopped',receptionEventId:'flow-event',receptionReportedAt:firestore.serverTimestamp()}));
});

test('republishing stale event metadata cannot rewind inventory revision or allocation sequence',async()=>{
  const c=clients();await createPublished(c);
  const ref=doc(c.managerDb,'events','flow-event');const stale=(await getDocFromServer(ref)).data();
  await c.management.appendTickets('flow-event',[{...makeTicket('flow-event','issued-2'),basicInfo:{ticketNumber:2}}],true);
  const before=(await getDocFromServer(ref)).data();
  await c.publisher.publishEventBundle(stale,settings,[]);
  const after=(await getDocFromServer(ref)).data();
  assert.equal(after.inventoryRevision,before.inventoryRevision);assert.equal(after.lastIssuedNumber,2);assert.equal(after.ticketCount,2);
});

test('an old receipt cannot authorize a ticket-only replay after a manager resets its state',async()=>{
  const c=clients();await createPublished(c);
  const entry={recordId:'first-entry',eventId:'flow-event',ticketId:'ticket-1',terminalId:'T-FLOW-RECEPTION',type:'entry',timestamp:'2026-10-25T01:00:00.000Z'};
  await c.reception.syncReceptionRecord(entry);
  await c.management.saveTicket('flow-event',{...makeTicket('flow-event'),currentStatus:'unused'},['currentStatus']);
  await assertFails(updateDoc(doc(c.receptionDb,'events','flow-event','tickets','ticket-1'),{currentStatus:'inside',updatedAt:entry.timestamp,lastReceptionRecordId:entry.recordId}));
  await c.reception.syncReceptionRecord({...entry,recordId:'new-entry',timestamp:'2026-10-25T02:00:00.000Z'});
});

test('5000-ticket issuance crosses every transaction boundary and remains downloadable offline',async()=>{
  const c=clients();await createPublished(c,makeEvent(),[]);
  const tickets=Array.from({length:5000},(_,i)=>({...makeTicket('flow-event','TKT'+String(i+1).padStart(6,'0')),basicInfo:{ticketNumber:i+1}}));
  await c.management.appendTickets('flow-event',tickets,true);
  const bundle=await c.downloader.downloadCurrentFirebaseEventData('T-FLOW-RECEPTION');
  assert.equal(bundle.tickets.length,5000);assert.equal(bundle.localEvent.ticketCount,5000);
  await c.local.prepareLocalEventData(bundle.localEvent,bundle.tickets);
  assert.equal(await c.local.countTickets('flow-event'),5000);
});

test('interrupted multi-chunk issuance preserves completed chunks with matching published counts',async()=>{
  const c=clients();await createPublished(c,makeEvent(),[]);let transactions=0;
  const failing=loadClientModule('./management-app/src/firebaseData.ts',c.managerDb,'flow-manager','T-FLOW-MANAGER',{}, {runTransaction:async(...args)=>{
    if(++transactions===2)throw Error('network lost after first chunk');
    return firestore.runTransaction(...args);
  }});
  const tickets=Array.from({length:451},(_,i)=>({...makeTicket('flow-event','new-'+i),basicInfo:{ticketNumber:i+1}}));
  await assert.rejects(failing.appendTickets('flow-event',tickets,true),/network lost/);
  assert.equal((await c.management.loadEventTickets('flow-event')).length,400);
  const current=(await getDocFromServer(doc(c.managerDb,'events','flow-event'))).data();
  assert.equal(current.ticketCount,400);assert.equal((await getDocFromServer(doc(c.managerDb,'eventBundles',current.authToken))).data().ticketCount,400);
  await c.management.appendTickets('flow-event',tickets.slice(400),true);
  assert.equal((await c.management.loadEventTickets('flow-event')).length,451);
});
