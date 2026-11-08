import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {setImmediate as nextTurn} from "node:timers/promises";
import {test} from "node:test";
import {IDBFactory} from "fake-indexeddb";

const require = createRequire(import.meta.url);
const ts = require("typescript");
function load(file, dependencies = {}, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(new URL(file, import.meta.url), "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const exports = {};
  new Function("exports", "require", ...Object.keys(globals), compiled)(exports, name => {
    if (name in dependencies) return dependencies[name];
    if (name === "../../shared/src/receptionTiming") return load("./shared/src/receptionTiming.ts");
    throw Error("Unexpected dependency: " + name);
  }, ...Object.values(globals));
  return exports;
}

const settings = {entryEnabled: true, exitEnabled: true, reentryEnabled: false};
const event = (id = "audit-event", version = 1) => ({
  eventId: id, eventName: "Audit event", eventDate: "2026-11-06", startTime: "09:00", endTime: "17:00",
  eventStatus: "ready", dataVersion: version,
});
const localEvent = (id = "audit-event", version = 1) => ({
  event: event(id, version), settings, terminalId: "T-AUDIT-TERMINAL", authenticatedAt: "2026-11-05T00:00:00.000Z",
  dataReady: false, ticketCount: 1,
});
const ticket = (id = "audit-ticket", eventId = "audit-event") => ({
  ticketId: id, eventId, basicInfo: {}, currentStatus: "unused", valid: true, updatedAt: "2026-11-05T00:00:00.000Z",
});
const record = (id, type = "entry", timestamp = "2026-11-06T01:00:00.000Z", ticketId = "audit-ticket", eventId = "audit-event") => ({
  recordId: id, type, timestamp, ticketId, eventId, terminalId: "T-AUDIT-TERMINAL",
});
const snapshot = value => ({exists: () => value !== undefined && value !== null, data: () => value});
const localDb = (indexedDB = new IDBFactory()) => load("./reception-app/src/localDb.ts", {}, {indexedDB});

const ticketBackup = () => ({version:1,eventId:"audit-event",eventHistory:[event()],tickets:[ticket()],members:[]});
for(const status of ["unused","inside","exited"])test("backup rejects a ticket status disguised as an array: "+status,()=>{
  const value=ticketBackup();value.tickets[0].currentStatus=[status];
  assert.throws(()=>load("./management-app/src/backup.ts").parseManagementBackup(value),/チケット情報/);
});
for(const status of ["ready","active"])test("backup rejects an event status disguised as an array: "+status,()=>{
  const value=ticketBackup();value.eventHistory[0].eventStatus=[status];
  assert.throws(()=>load("./management-app/src/backup.ts").parseManagementBackup(value),/イベント情報/);
});
test("backup refuses blank ticket IDs which reception cannot query",()=>{
  const value=ticketBackup();value.tickets[0].ticketId="   ";
  assert.throws(()=>load("./management-app/src/backup.ts").parseManagementBackup(value),/チケット情報/);
});
test("backup refuses an event name too long for reception download",()=>{
  const value=ticketBackup();value.eventHistory[0].eventName="X".repeat(301);
  assert.throws(()=>load("./management-app/src/backup.ts").parseManagementBackup(value),/イベント情報/);
});
test("backup preserves supported legacy tickets without display numbers and literal status strings",()=>{
  const value=ticketBackup(),parsed=load("./management-app/src/backup.ts").parseManagementBackup(value);
  assert.deepEqual(parsed.tickets,value.tickets);assert.deepEqual(parsed.eventHistory,value.eventHistory);
});

function downloaderHarness({canonical = {...event(), authToken: "token", receptionTarget: true, ticketCount: 1}, bundle = {}, tickets = [ticket()]} = {}) {
  const data = {event: event(), settings, ticketCount: 1, authToken: "token", ...bundle};
  const api = load("./reception-app/src/eventDownloader.ts", {
    "./firebaseClient": {getFirebaseDb: () => ({})},
    "firebase/firestore": {
      doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"),
      query: ref => ref, where: (...parts) => parts,
      getDocFromServer: async ref => snapshot(ref.startsWith("eventBundles/") ? data : canonical),
      getDocsFromServer: async ref => ({docs: (ref === "events" ? canonical ? [canonical] : [] : tickets).map(value => ({data: () => value}))}),
    },
  });
  const payload = {type: "qr-ticket-event-auth", eventId: "audit-event", eventName: "Audit event", dataVersion: 1, authToken: "token"};
  return {api, payload, data};
}

function timers() {
  const pending = new Map();
  let id = 0;
  return {
    globals: {setTimeout: (fn, milliseconds) => {pending.set(++id, {fn, milliseconds}); return id;}, clearTimeout: key => pending.delete(key)},
    fire() {const [key, value] = pending.entries().next().value ?? []; assert.ok(value, "a deadline is scheduled"); pending.delete(key); value.fn();},
    get size() {return pending.size;},
  };
}

async function seed(indexedDB, values) {
  await new Promise((resolve, reject) => {
    const request = indexedDB.open("qr-ticket-reception");
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction([...new Set(values.map(([store]) => store))], "readwrite");
      for (const [store, value] of values) tx.objectStore(store).put(value);
      tx.oncomplete = () => {db.close(); resolve();};
      tx.onabort = tx.onerror = () => {db.close(); reject(tx.error);};
    };
    request.onerror = () => reject(request.error);
  });
}

test("published metadata includes canonical schedule without leaking approval metadata", async () => {
  const canonical = {...event(), startTime: "10:30", eventStatus: "active", authToken: "token", receptionTarget: true, ticketCount: 1};
  const {api} = downloaderHarness({canonical});
  const payload = await api.getCurrentFirebaseEventAuthPayload();
  assert.deepEqual(payload.event, {...event(), startTime: "10:30", eventStatus: "active"});
  assert.equal(payload.event.authToken, undefined);
});

test("download uses edited canonical schedule and name with the current count and published settings", async () => {
  const canonical = {...event(), eventName: "Renamed event", startTime: "10:30", eventStatus: "active", authToken: "token", receptionTarget: true, ticketCount: 2};
  const {api, payload} = downloaderHarness({canonical, tickets: [ticket(), ticket("new-ticket")]});
  const downloaded = await api.downloadEventData(payload, "T-AUDIT-TERMINAL");
  assert.equal(downloaded.localEvent.event.startTime, "10:30");
  assert.equal(downloaded.localEvent.event.eventName, "Renamed event");
  assert.equal(downloaded.localEvent.event.eventStatus, "active");
  assert.equal(downloaded.localEvent.ticketCount, 2);
  assert.deepEqual(downloaded.localEvent.settings, settings);
  const current = await api.getCurrentFirebaseEventAuthPayload();
  assert.equal((await api.downloadEventData(current, "T-AUDIT-TERMINAL")).tickets.length, 2);
});

test("legacy embedded bundles remain usable when no canonical event exists", async () => {
  const legacy = downloaderHarness({canonical: null, bundle: {tickets: [ticket()]}, tickets: []});
  const result = await legacy.api.downloadEventData(legacy.payload, "T-AUDIT-TERMINAL");
  assert.equal(result.tickets.length, 1);
  assert.deepEqual(result.localEvent.event, event());
});

test("canonical empty inventory does not resurrect stale embedded bundle tickets", async () => {
  const {api, payload} = downloaderHarness({canonical: {...event(), authToken: "token", receptionTarget: true, ticketCount: 0}, bundle: {tickets: [ticket()]}, tickets: []});
  const result = await api.downloadEventData(payload, "T-AUDIT-TERMINAL");
  assert.equal(result.tickets.length, 0);
  assert.equal(result.localEvent.ticketCount, 0);
});

test("canonical token/version/publication changes and bundle identity mismatches fail closed", async () => {
  const changes = [
    {canonical: {...event(), authToken: "rotated", receptionTarget: true}},
    {canonical: {...event("audit-event", 2), authToken: "token", receptionTarget: true}},
    {canonical: {...event(), authToken: "token", receptionTarget: false}},
    {canonical: {...event(), authToken: "token", receptionTarget: true, eventStatus: "finished"}},
    {bundle: {event: event("wrong-event")}},
    {bundle: {authToken: "wrong-token"}},
    {bundle: {event: event("audit-event", 2)}},
  ];
  for (const change of changes) {
    const {api, payload} = downloaderHarness(change);
    await assert.rejects(api.downloadEventData(payload, "T-AUDIT-TERMINAL"), /EVENT_DATA_INVALID/);
  }
});

test("incomplete inventory fails without quietly accepting fewer tickets", async () => {
  const {api, payload} = downloaderHarness({canonical: {...event(), authToken: "token", ticketCount: 2}});
  await assert.rejects(api.downloadEventData(payload, "T-AUDIT-TERMINAL"), /EVENT_TICKET_COUNT_MISMATCH/);
});

test("invalid schedules and malformed canonical counts cannot silently enable production reception", async () => {
  for (const change of [
    {eventDate: "2026-02-29"}, {eventDate: "2026-11-31"}, {eventDate: "2026-1-6"},
    {startTime: "24:00"}, {startTime: "9:00"}, {endTime: "17:60"}, {dataVersion: NaN},
  ]) {
    const {api, payload} = downloaderHarness({canonical: {...event(), authToken: "token", receptionTarget: true, ...change}});
    await assert.rejects(api.downloadEventData(payload, "T-AUDIT-TERMINAL"), /EVENT_DATA_INVALID/);
    await assert.rejects(api.getCurrentFirebaseEventAuthPayload(), /INVALID_PUBLISHED_EVENT/);
  }
  for (const ticketCount of ["0", -1, 1.5]) {
    const {api, payload} = downloaderHarness({canonical: {...event(), authToken: "token", ticketCount}});
    await assert.rejects(api.downloadEventData(payload, "T-AUDIT-TERMINAL"), /EVENT_DATA_INVALID/);
  }
});

test("pending legacy state is retained until canonical trial classification", async () => {
  const factory = new IDBFactory(), local = localDb(factory);
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const trial = record("legacy-trial", "entry", "2026-11-05T23:59:59.999Z");
  await seed(factory, [
    ["receptionRecords", trial], ["syncQueue", {recordId: trial.recordId, status: "pending", retryCount: 0, sequence: 1}],
  ]);
  await local.prepareLocalEventData(localEvent("audit-event", 2), [{...ticket(), currentStatus: "inside", updatedAt: trial.timestamp}]);
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  await local.markSyncStatus(trial.recordId,"synced",0,"trial");
  assert.equal((await local.getTicket("audit-ticket")).currentStatus,"unused");
  assert.deepEqual(await local.getReceptionRecord(trial.recordId), trial);
  assert.equal((await local.getPendingSyncItems()).length, 0);
});

test("offline startup normalizes old trial state atomically and permits the first official entry", async () => {
  const factory = new IDBFactory(), local = localDb(factory);
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  await seed(factory, [["tickets", {...ticket(), currentStatus: "exited", updatedAt: "2026-11-05T23:59:59.999Z"}]]);
  const current = await local.getTicket("audit-ticket");
  assert.equal(current.currentStatus, "unused");
  const official = record("official-entry", "entry", "2026-11-06T00:00:00.000Z");
  assert.equal(await local.saveReceptionTransaction({...current, currentStatus: "inside", updatedAt: official.timestamp}, official, current), "saved");
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  assert.equal((await local.getPendingSyncItems()).length, 1);
});

test("metadata refresh cannot undo a scan's inventory count or roll back a newer version", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const stale = await local.loadLocalEvent();
  const discovered = ticket("discovered");
  await local.saveReceptionTransaction({...discovered, currentStatus: "inside"}, record("discovered-entry", "entry", undefined, "discovered"), null);
  await local.saveLocalEvent({...stale, event: {...stale.event, startTime: "08:30"}});
  assert.equal((await local.loadLocalEvent(true)).ticketCount, 2);
  await local.prepareLocalEventData({...localEvent("audit-event", 2), ticketCount: 2}, [ticket(), discovered]);
  await assert.rejects(local.saveLocalEvent(stale), /LOCAL_EVENT_VERSION_CHANGED/);
  assert.equal((await local.loadLocalEvent(true)).event.dataVersion, 2);
});

test("switching events with unsent history fails atomically and preserves the previous inventory", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  await local.saveReceptionTransaction({...ticket(), currentStatus: "inside"}, record("pending-entry"));
  await assert.rejects(local.prepareLocalEventData(localEvent("another-event"), [ticket("another-ticket", "another-event")]), /LOCAL_EVENT_PENDING_SYNC/);
  assert.equal((await local.loadLocalEvent(true)).event.eventId, "audit-event");
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  assert.equal((await local.getPendingSyncItems()).length, 1);
});

test("late metadata cannot resurrect a replaced or cleared event", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const stale = await local.loadLocalEvent();
  await local.prepareLocalEventData(localEvent("another-event"), [ticket("another-ticket", "another-event")]);
  await assert.rejects(local.saveLocalEvent(stale), /LOCAL_EVENT_CHANGED/);
  assert.equal((await local.loadLocalEvent(true)).event.eventId, "another-event");
  assert.equal(await local.getTicket("audit-ticket"), null);
  await local.clearLocalEvent();
  await assert.rejects(local.saveLocalEvent(stale), /LOCAL_EVENT_CHANGED/);
  assert.equal(await local.loadLocalEvent(true), null);
});

test("late metadata cannot overwrite a renewed registration for the same event", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const stale = await local.loadLocalEvent();
  await local.prepareLocalEventData({...localEvent(), authenticatedAt: "2026-11-06T00:30:00.000Z"}, [ticket()]);
  await assert.rejects(local.saveLocalEvent(stale), /LOCAL_EVENT_CHANGED/);
  assert.equal((await local.loadLocalEvent(true)).authenticatedAt, "2026-11-06T00:30:00.000Z");
});

test("reused record IDs cannot replace reception history or reorder its queue", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const first = record("same-id");
  await local.saveReceptionTransaction({...ticket(), currentStatus: "inside"}, first);
  await assert.rejects(local.saveReceptionTransaction({...ticket(), currentStatus: "exited"}, record("same-id", "exit")));
  assert.deepEqual(await local.getReceptionRecord("same-id"), first);
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  assert.equal((await local.getPendingSyncItems())[0].sequence, 1);
});

test("local ticket state and timestamp are derived from the accepted record and invalid records do not write", async () => {
  const local = localDb();
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  const item = record("accepted");
  await local.saveReceptionTransaction(ticket(), item);
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  assert.equal((await local.getTicket("audit-ticket")).updatedAt, item.timestamp);
  await assert.rejects(local.saveReceptionTransaction(ticket(), {...record("wrong-ticket"), ticketId: "other"}), /INVALID_RECEPTION_RECORD/);
  await assert.rejects(local.saveReceptionTransaction(ticket(), record("wrong-time", "entry", "not-a-date")), /INVALID_RECEPTION_RECORD/);
  assert.equal((await local.getPendingSyncItems()).length, 1);
});

test("approval reads and latest-ticket identity restoration have bounded deadlines on blocked Wi-Fi", async () => {
  for (const method of ["getTerminalRegistration", "getLatestReceptionTicket"]) {
    const clock = timers();
    const sync = load("./reception-app/src/receptionSync.ts", {
      "./localDb": {}, "./firebaseClient": {ensureFirebaseAuth: () => new Promise(() => {})}, "firebase/firestore": {},
    }, clock.globals);
    const result = sync[method]("audit-event", "audit-ticket");
    clock.fire();
    await assert.rejects(result, error => error.code === "deadline-exceeded");
    assert.equal(clock.size, 0);
  }
});

test("approval permission errors are retained for callers to revoke cached access", async () => {
  const denied = Object.assign(new Error("denied"), {code: "permission-denied"});
  const sync = load("./reception-app/src/receptionSync.ts", {
    "./localDb": {}, "./firebaseClient": {ensureFirebaseAuth: async () => {throw denied;}}, "firebase/firestore": {},
  });
  await assert.rejects(sync.getTerminalRegistration(), error => error === denied);
});

test("timed-out approval reads cannot change the cached terminal identity or create a late approval", async () => {
  for (const stage of ["installation", "events", "approval"]) {
    const clock = timers(), storage = new Map([["qr-ticket-terminal-id", "T-OLD"], ["qr-ticket-device-id", "T-OLD"]]);
    let release, reached = false, requested = 0;
    const blocked = new Promise(resolve => {release = resolve;});
    const wait = value => {reached = true; return blocked.then(() => value);};
    const installation = {authUid: "auth-user", terminalId: "T-NEW", approved: true};
    const terminal = {approved: true, receptionApproved: true, role: "reception", name: "New terminal", status: "online"};
    const events = {docs: [{id: "audit-event", data: () => event()}]};
    const sync = load("./reception-app/src/receptionSync.ts", {
      "./localDb": {}, "./firebaseClient": {ensureFirebaseAuth: async () => {}, getFirebaseUid: async () => "auth-user", getFirebaseDb: () => ({})},
      "firebase/firestore": {
        doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"), query: ref => ref, where: () => [],
        getDoc: async ref => ref.startsWith("terminalInstallations/")
          ? stage === "installation" ? wait(snapshot(installation)) : snapshot(installation) : snapshot(terminal),
        getDocsFromServer: async () => stage === "events" ? wait(events) : events,
        runTransaction: async (_db, callback) => callback({get: async () => stage === "approval" ? wait(snapshot(null)) : snapshot(null), set: () => {requested++;}}),
      },
    }, {...clock.globals, localStorage: {getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value)}});
    const result = sync.getTerminalRegistration();
    for (let i = 0; i < 30 && !reached; i++) await nextTurn();
    assert.equal(reached, true, stage);
    clock.fire();
    await assert.rejects(result, error => error.code === "deadline-exceeded");
    release();
    for (let i = 0; i < 4; i++) await nextTurn();
    assert.equal(storage.get("qr-ticket-terminal-id"), "T-OLD", stage);
    assert.equal(storage.get("qr-ticket-device-id"), "T-OLD", stage);
    assert.equal(requested, 0, stage);
    assert.equal(clock.size, 0, stage);
  }
});

test("a timed-out committed upload keeps history pending and retries without writing the ticket again", async () => {
  const clock = timers(), saved = new Map();
  const local = localDb();
  let commits = 0;
  const item = record("lost-ack");
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  await local.saveReceptionTransaction(ticket(), item);
  const sync = load("./reception-app/src/receptionSync.ts", {
    "./localDb": {}, "./firebaseClient": {ensureFirebaseAuth: async () => {}, getFirebaseDb: () => ({})},
    "firebase/firestore": {
      doc: (_db, ...parts) => parts.join("/"),
      runTransaction: async (_db, operation) => {
        const writes = [];
        const result = await operation({
          get: async ref => snapshot(ref === "events/audit-event" ? event() : saved.get(ref)),
          update: () => {}, set: (ref, data) => writes.push([ref, data]),
        });
        if (writes.length) {
          commits++;
          for (const [ref, data] of writes) saved.set(ref, data);
          return new Promise(() => {});
        }
        return result;
      },
    },
  }, {...clock.globals, localStorage: {getItem: () => "T-AUDIT-TERMINAL"}});
  const errors = [];
  const worker = load("./reception-app/src/syncQueue.ts", {
    "./localDb": local, "./receptionSync": sync,
  }, {navigator: {onLine: true}, console: {error: (...args) => errors.push(args)}});
  const first = worker.syncPendingReceptionRecords();
  for (let i = 0; i < 100 && commits === 0; i++) await nextTurn();
  assert.equal(commits, 1);
  clock.fire();
  await first;
  assert.equal(errors[0][1].code, "deadline-exceeded");
  const pending = await local.getPendingSyncItems();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "failed");
  assert.equal(pending[0].retryCount, 1);
  assert.deepEqual(await local.getReceptionRecord(item.recordId), item);
  await worker.syncPendingReceptionRecords();
  assert.equal(commits, 1);
  assert.equal((await local.getPendingSyncItems()).length, 0);
  assert.equal((await local.getTicket("audit-ticket")).currentStatus, "inside");
  assert.equal(clock.size, 0);
});

test("queue pauses at loss of connectivity and retries the remaining ticket after reconnect", async () => {
  const local = localDb(), navigator = {onLine: true};
  await local.prepareLocalEventData({...localEvent(), ticketCount: 2}, [ticket(), ticket("second")]);
  for (const [id, ticketId] of [["first-entry", "audit-ticket"], ["second-entry", "second"]]) {
    await local.saveReceptionTransaction({...ticket(ticketId), currentStatus: "inside"}, record(id, "entry", undefined, ticketId));
  }
  const uploaded = [];
  const worker = load("./reception-app/src/syncQueue.ts", {
    "./localDb": local, "./receptionSync": {syncReceptionRecord: async item => {uploaded.push(item.recordId); navigator.onLine = false;}},
  }, {navigator});
  await worker.syncPendingReceptionRecords();
  assert.deepEqual(uploaded, ["first-entry"]);
  assert.equal((await local.getPendingSyncItems()).length, 1);
  navigator.onLine = true;
  await worker.syncPendingReceptionRecords();
  assert.deepEqual(uploaded, ["first-entry", "second-entry"]);
  assert.equal((await local.getPendingSyncItems()).length, 0);
});

test("missing local records remain recoverable and are reported as failed queue entries", async () => {
  const factory = new IDBFactory(), local = localDb(factory);
  await local.prepareLocalEventData(localEvent(), [ticket()]);
  await seed(factory, [["syncQueue", {recordId: "missing", status: "pending", retryCount: 0, sequence: 1}]]);
  const errors = [];
  const worker = load("./reception-app/src/syncQueue.ts", {
    "./localDb": local, "./receptionSync": {syncReceptionRecord: async () => assert.fail("no record to upload")},
  }, {navigator: {onLine: true}, console: {error: (...args) => errors.push(args)}});
  await worker.syncPendingReceptionRecords();
  const remaining = await local.getPendingSyncItems();
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].status, "failed");
  assert.equal(remaining[0].retryCount, 1);
  assert.equal(errors.length, 1);
});

test("an upload requested at worker completion is drained before callers finish", async () => {
  let reads = 0, uploaded = 0, synced = false;
  let worker;
  worker = load("./reception-app/src/syncQueue.ts", {
    "./localDb": {
      getPendingSyncItems: async () => {
        if (++reads === 1) {
          queueMicrotask(() => queueMicrotask(() => {void worker.syncPendingReceptionRecords();}));
          return [];
        }
        return synced ? [] : [{recordId: "late-entry", status: "pending", retryCount: 0}];
      },
      getReceptionRecord: async () => record("late-entry"), loadLocalEvent: async () => localEvent(),
      markSyncStatus: async () => {synced = true;},
    },
    "./receptionSync": {syncReceptionRecord: async () => {uploaded++;}},
  }, {navigator: {onLine: true}});
  await worker.syncPendingReceptionRecords();
  assert.equal(uploaded, 1);
  assert.equal(synced, true);
});
