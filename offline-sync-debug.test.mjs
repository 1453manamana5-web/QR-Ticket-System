import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { IDBFactory } from "fake-indexeddb";

const ts = createRequire(import.meta.url)("typescript");
function load(file, dependencies = {}, factory = new IDBFactory()) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  new Function("exports", "require", "indexedDB", compiled)(exports, name => {
    if (!(name in dependencies)) throw new Error("Unexpected module " + name);
    return dependencies[name];
  }, factory);
  return exports;
}
const event = (eventId = "event-one", version = 1) => ({
  event: { eventId, eventName: "Offline race", dataVersion: version },
  settings: { entryEnabled: true, exitEnabled: true, reentryEnabled: true },
  terminalId: "T-DEBUG-0001", authenticatedAt: "2026-11-06T00:00:00.000Z", dataReady: false, ticketCount: 1,
});
const ticket = (eventId = "event-one", status = "unused") => ({
  eventId, ticketId: "ticket-one", currentStatus: status, valid: true, basicInfo: {}, updatedAt: "2026-11-06T00:00:00.000Z",
});
const record = (recordId, eventId = "event-one") => ({
  recordId, eventId, ticketId: "ticket-one", terminalId: "T-DEBUG-0001", type: "entry", timestamp: "2026-11-06T00:01:00.000Z",
});

test("a download that races an upload cannot rewind a locally accepted entry; the next read succeeds", async () => {
  const local = load("./reception-app/src/localDb.ts");
  await local.prepareLocalEventData(event(), [ticket()]);
  await local.saveReceptionTransaction(ticket("event-one", "inside"), record("entry-before-read"));
  const receptionSnapshot = await local.captureLocalReceptionSnapshot("event-one");
  // The downloaded inventory was read before this upload reached the server.
  await local.markSyncStatus("entry-before-read", "synced", 0);
  await assert.rejects(local.prepareLocalEventData({ ...event("event-one", 2), receptionSnapshot }, [ticket()]), /LOCAL_RECEPTION_SYNC_CHANGED/);
  assert.equal((await local.getTicket("ticket-one")).currentStatus, "inside");
  assert.equal((await local.loadLocalEvent()).event.dataVersion, 1);
  assert.deepEqual(await local.getPendingSyncItems(), []);
  // A new server read can include a newer exit on the other iPad.
  const retry = await local.captureLocalReceptionSnapshot("event-one");
  await local.prepareLocalEventData({ ...event("event-one", 2), receptionSnapshot: retry }, [ticket("event-one", "exited")]);
  const saved = await local.loadLocalEvent();
  assert.equal((await local.getTicket("ticket-one")).currentStatus, "exited");
  assert.equal(saved.event.dataVersion, 2);
  assert.equal("receptionSnapshot" in saved, false);
});

test("scans accepted and uploaded during a download also invalidate that download", async () => {
  const local = load("./reception-app/src/localDb.ts");
  await local.prepareLocalEventData(event(), [ticket()]);
  const receptionSnapshot = await local.captureLocalReceptionSnapshot("event-one");
  await local.saveReceptionTransaction(ticket("event-one", "inside"), record("entry-during-read"));
  await local.markSyncStatus("entry-during-read", "synced", 0);
  await assert.rejects(local.prepareLocalEventData({ ...event("event-one", 2), receptionSnapshot }, [ticket()]), /LOCAL_RECEPTION_SYNC_CHANGED/);
  assert.equal((await local.getTicket("ticket-one")).currentStatus, "inside");
});

test("pending scans retain their state, while another event's uploads cannot block a refresh", async () => {
  const local = load("./reception-app/src/localDb.ts");
  await local.prepareLocalEventData(event(), [ticket()]);
  await local.saveReceptionTransaction(ticket("event-one", "inside"), record("entry-pending"));
  const receptionSnapshot = await local.captureLocalReceptionSnapshot("event-one");
  await local.saveReceptionTransaction(ticket("event-two", "inside"), record("other-entry", "event-two"));
  await local.markSyncStatus("other-entry", "synced", 0);
  await local.prepareLocalEventData({ ...event("event-one", 2), receptionSnapshot }, [ticket()]);
  assert.equal((await local.getTicket("ticket-one")).currentStatus, "inside");
  assert.deepEqual((await local.getPendingSyncItems()).map(item => item.recordId), ["entry-pending"]);
});

test("the real downloader captures its local snapshot before starting remote inventory reads", async () => {
  const local = load("./reception-app/src/localDb.ts");
  await local.prepareLocalEventData(event(), [ticket()]);
  await local.saveReceptionTransaction(ticket("event-one", "inside"), record("entry"));
  const payload = { type: "qr-ticket-event-auth", eventId: "event-one", eventName: "Offline race", dataVersion: 2, authToken: "debug-token" };
  const downloader = load("./reception-app/src/eventDownloader.ts", {
    "./localDb": local,
    "./firebaseClient": { getFirebaseDb: () => ({}) },
    "firebase/firestore": {
      doc: () => ({}), collection: () => ({}),
      getDocFromServer: async () => {
        await local.markSyncStatus("entry", "synced", 0);
        return { exists: () => true, data: () => ({ event: event("event-one", 2).event, settings: event().settings, authToken: "debug-token", ticketCount: 1 }) };
      },
      getDocsFromServer: async () => ({ docs: [{ data: () => ticket() }] }),
    },
  });
  const downloaded = await downloader.downloadEventData(payload, "T-DEBUG-0001");
  await assert.rejects(local.prepareLocalEventData({ ...downloaded.localEvent }, downloaded.tickets), /LOCAL_RECEPTION_SYNC_CHANGED/);
  assert.equal((await local.getTicket("ticket-one")).currentStatus, "inside");
});

for (const synced of [false, true]) {
  test(`old offline QR cannot replace accepted ${synced ? "synced" : "pending"} reception history`, async () => {
    const local = load("./reception-app/src/localDb.ts");
    await local.prepareLocalEventData(event(), [ticket()]);
    await local.saveReceptionTransaction(ticket("event-one", "inside"), record("accepted-entry"));
    if (synced) await local.markSyncStatus("accepted-entry", "synced", 0);
    await assert.rejects(local.prepareLocalEventData(event(), [ticket()], {offlineTransfer: true}), /オフラインQRでは再読み込みできません/);
    assert.equal((await local.getTicket("ticket-one")).currentStatus, "inside");
    assert.equal((await local.getReceptionRecord("accepted-entry")).type, "entry");
    assert.equal((await local.getPendingSyncItems()).length, synced ? 0 : 1);
    // Clearing event metadata must not make durable history unsafe to restore.
    await local.clearLocalEvent();
    await assert.rejects(local.prepareLocalEventData(event(), [ticket()], {offlineTransfer: true}), /通信で最新データ/);
    assert.equal(await local.loadLocalEvent(), null);
  });
}

test("offline QR supports initial setup and refresh before reception, without blocking other events' history", async () => {
  const local = load("./reception-app/src/localDb.ts");
  await local.prepareLocalEventData(event(), [ticket()], {offlineTransfer: true});
  await local.prepareLocalEventData(event("event-one", 2), [{...ticket(), valid: false}], {offlineTransfer: true});
  assert.equal((await local.getTicket("ticket-one")).valid, false);
  await local.saveReceptionTransaction(ticket("event-one", "inside"), record("old-event-entry"));
  await local.markSyncStatus("old-event-entry", "synced", 0);
  await local.prepareLocalEventData(event("event-two"), [ticket("event-two")], {offlineTransfer: true});
  assert.equal((await local.loadLocalEvent()).event.eventId, "event-two");
  assert.ok(await local.getReceptionRecord("old-event-entry"));
});
