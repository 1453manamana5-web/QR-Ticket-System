import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadAuthClient(app, auth, signIn) {
  const source = readFileSync(new URL(`./${app}/src/firebaseClient.ts`, import.meta.url), "utf8")
    .replace(/import\.meta\.env\.[A-Z_]+/g, '"test-config"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const firebaseApp = {};
  const dependencies = {
    "firebase/app": { getApps: () => [firebaseApp], getApp: () => firebaseApp },
    "firebase/auth": { getAuth: () => auth, signInAnonymously: signIn },
    "firebase/firestore": {},
  };
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => dependencies[name] });
  return exports;
}

for (const app of ["management-app", "reception-app"]) {
  test(`${app}: authentication recovers when a restored user disappears after initialization`, async () => {
    let signIns = 0;
    const auth = { currentUser: { uid: "original-user" }, authStateReady: async () => {} };
    const client = loadAuthClient(app, auth, async () => {
      signIns++;
      auth.currentUser = { uid: "replacement-user" };
    });
    assert.equal(await client.getFirebaseUid(), "original-user");
    auth.currentUser = null;
    const first = client.ensureFirebaseAuth();
    const concurrent = client.ensureFirebaseAuth();
    assert.equal(first, concurrent);
    await Promise.all([first, concurrent]);
    assert.equal(await client.getFirebaseUid(), "replacement-user");
    assert.equal(signIns, 1);
  });

  test(`${app}: failed reauthentication retries without discarding the restored identity`, async () => {
    let attempts = 0;
    const auth = { currentUser: { uid: "original-user" }, authStateReady: async () => {} };
    const client = loadAuthClient(app, auth, async () => {
      attempts++;
      if (attempts === 1) throw Error("network unavailable");
      auth.currentUser = { uid: "replacement-user" };
    });
    await client.ensureFirebaseAuth();
    auth.currentUser = null;
    await assert.rejects(client.ensureFirebaseAuth(), /network unavailable/);
    assert.equal(await client.getFirebaseUid(), "replacement-user");
    assert.equal(attempts, 2);
    await client.ensureFirebaseAuth();
    assert.equal(attempts, 2);
  });
}

function loadManagerWithInventory(inventory) {
  const compiled = ts.transpileModule(readFileSync(new URL("./management-app/src/firebaseData.ts", import.meta.url), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const snapshot = ref => ({ exists: () => inventory.has(ref), data: () => inventory.get(ref) });
  const api = {};
  const transaction = {
    get: async ref => snapshot(ref),
    update: (ref, changes) => {
      const target = inventory.get(ref);
      for (const [key, value] of Object.entries(changes)) {
        if (key === "basicInfo.reservePrinted") target.basicInfo.reservePrinted = value;
        else target[key] = value;
      }
    },
  };
  const dependencies = {
    "./firebaseClient": { getFirebaseDb: () => ({}) },
    "firebase/firestore": {
      doc: (_db, ...parts) => parts.join("/"),
      runTransaction: async (_db, execute) => execute(transaction),
    },
  };
  new Function("exports", "require", compiled)(api, name => dependencies[name]);
  return api;
}

test("ticket metadata edits and reserve print confirmation preserve the actual reception time", async () => {
  const enteredAt = "2026-10-24T23:59:00.000Z";
  const inventory = new Map([
    ["events/e", { eventId: "e", ticketCount: 1, inventoryRevision: 1, dataVersion: 1 }],
    ["events/e/tickets/t", {
      eventId: "e", ticketId: "t", currentStatus: "inside", valid: true,
      updatedAt: enteredAt, lastReceptionRecordId: "legacy-trial", basicInfo: { reserve: true, name: "Before" },
    }],
  ]);
  const client = loadManagerWithInventory(inventory);
  await client.saveTicket("e", {
    ...inventory.get("events/e/tickets/t"), updatedAt: "2026-11-06T00:00:00.000Z",
    valid: false, basicInfo: { reserve: true, name: "After" },
  }, ["basicInfo", "valid"]);
  await client.markReserveTicketsPrinted("e", ["t"]);
  const ticket = inventory.get("events/e/tickets/t");
  assert.equal(ticket.updatedAt, enteredAt);
  assert.equal(ticket.currentStatus, "inside");
  assert.equal(ticket.lastReceptionRecordId, "legacy-trial");
  assert.equal(ticket.valid, false);
  assert.equal(ticket.basicInfo.name, "After");
  assert.equal(ticket.basicInfo.reservePrinted, true);
  assert.equal(inventory.get("events/e").inventoryRevision, 3);
  const changedAt = "2026-11-06T01:00:00.000Z";
  await client.saveTicket("e", { ...ticket, currentStatus: "unused", updatedAt: changedAt }, ["currentStatus"]);
  assert.equal(ticket.updatedAt, changedAt);
  assert.equal(ticket.currentStatus, "unused");
});

function managerApplicationHarness(online = true) {
  const uid = "manager-history-user", applications = [], writes = [];
  for (let n = 0; n < 5; n++) applications.push({id: "T-0000000" + n, requestedByUid: uid, status: "approved", name: "Historical"});
  applications.push({id: "T-ZZZZZZZZ", terminalId: "T-ZZZZZZZZ", requestedByUid: uid, status: "pending", name: "Current application", requestedRole: "both"});
  const list = async ({constraints}) => {
    let rows = applications;
    for (const item of constraints.filter(item => item.type === "where")) rows = rows.filter(row => row[item.field] === item.value);
    for (const item of constraints.filter(item => item.type === "limit")) rows = rows.slice(0, item.value);
    return {docs: rows.map(row => ({id: row.id, data: () => row}))};
  };
  const firestore = {
    doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"),
    where: (field, operator, value) => ({type: "where", field, operator, value}), limit: value => ({type: "limit", value}),
    query: (path, ...constraints) => ({path, constraints}),
    getDocFromServer: async () => ({exists: () => false}), getDocFromCache: async () => ({exists: () => false}),
    getDocs: list, getDocsFromServer: list, getDocsFromCache: list,
    writeBatch: () => ({set: (ref, data) => writes.push({ref, data}), commit: async () => {}}),
  };
  const dependencies = {"firebase/firestore": firestore, "./firebaseClient": {ensureFirebaseAuth: async () => {}, getFirebaseUid: async () => uid, getFirebaseDb: () => ({})}};
  const compiled = ts.transpileModule(readFileSync(new URL("./management-app/src/firebaseData.ts", import.meta.url), "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const api = {};
  new Function("exports", "require", "navigator", compiled)(api, name => dependencies[name], {onLine: online});
  return {api, writes};
}

test("management pending registration remains visible after five historical applications, online and cached", async () => {
  for (const online of [true, false]) {
    const h = managerApplicationHarness(online), status = await h.api.getOwnTerminalStatus();
    assert.equal(status.approved, false);
    assert.equal(status.status, "pending");
    assert.equal(status.name, "Current application");
    assert.equal(status.role, "both");
    assert.equal(status.managementApproved, false);
    assert.equal(status.receptionApproved, false);
    assert.equal(h.writes.length, 0);
  }
});

test("management cannot submit a duplicate request hidden behind five historical applications", async () => {
  const h = managerApplicationHarness();
  await assert.rejects(h.api.requestTerminalRegistration({terminalId: "T-MANAGERNEW", name: "Duplicate", type: "Web / iPad", role: "both"}), /TERMINAL_APPLICATION_ALREADY_PENDING/);
  assert.equal(h.writes.length, 0);
});

function ticketInventoryHarness({lastIssuedNumber = 1, rejectCommit = false, beforeTransaction} = {}) {
  const inventory = new Map([
    ['events/e', {eventId: 'e', dataVersion: 1, inventoryRevision: 0, ticketCount: 1, lastIssuedNumber}],
    ['events/e/tickets/TKT000001', {ticketId: 'TKT000001', eventId: 'e', basicInfo: {ticketNumber: 1, reserve: true, reservePrinted: true}, currentStatus: 'inside', valid: true, updatedAt: '2026-11-08T01:00:00.000Z'}],
  ]);
  const ref = (...parts) => ({path: parts.join('/'), id: parts.at(-1)});
  const snapshot = (target, values = inventory) => ({id: target.id, ref: target, exists: () => values.has(target.path), data: () => structuredClone(values.get(target.path))});
  const list = async target => ({docs: [...inventory.keys()].filter(path => path.startsWith(target.path + '/') && path.split('/').length === target.path.split('/').length + 1).map(path => snapshot(ref(...path.split('/'))))});
  let transactions = 0;
  const firestore = {
    doc: (_db, ...parts) => ref(...parts), collection: (_db, ...parts) => ref(...parts),
    getDocFromServer: async target => snapshot(target), getDocsFromServer: list,
    runTransaction: async (_db, operation) => {
      transactions++;
      beforeTransaction?.(inventory, transactions);
      const staged = structuredClone(inventory);
      const result = await operation({
        get: async target => snapshot(target, staged),
        update: (target, patch) => {const value = staged.get(target.path);assert.ok(value);Object.assign(value, structuredClone(patch));},
        set: (target, value) => staged.set(target.path, structuredClone(value)),
        delete: target => staged.delete(target.path),
      });
      if (rejectCommit) throw Error('simulated-commit-failure');
      inventory.clear();for (const [key, value] of staged) inventory.set(key, value);
      return result;
    },
  };
  const api = {}, compiled = ts.transpileModule(readFileSync(new URL('./management-app/src/firebaseData.ts', import.meta.url), 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
  new Function('exports', 'require', 'navigator', compiled)(api, name => name === 'firebase/firestore' ? firestore : {getFirebaseDb: () => ({})}, {onLine: true});
  return {api, inventory, get transactions() {return transactions;}, ticket: () => structuredClone(inventory.get('events/e/tickets/TKT000001'))};
}

test('a stale number edit retains reserve print confirmation received after its UI snapshot', async () => {
  const h = ticketInventoryHarness(), stale = h.ticket();
  stale.basicInfo = {ticketNumber: 2, reserve: true};
  stale.currentStatus = 'unused';
  await h.api.saveTicket('e', stale, ['basicInfo']);
  assert.equal(h.ticket().basicInfo.ticketNumber, 2);
  assert.equal(h.ticket().basicInfo.reservePrinted, true);
  assert.equal(h.ticket().currentStatus, 'inside');
});

test('deleting a renumbered ticket cannot reuse the edited number', async () => {
  const h = ticketInventoryHarness(), edited = h.ticket();edited.basicInfo.ticketNumber = 100;
  await h.api.saveTicket('e', edited, ['basicInfo']);
  await h.api.deleteTicket('e', edited.ticketId);
  assert.equal(await h.api.loadNextTicketNumber('e', 'TKT'), 101);
  assert.equal(h.inventory.get('events/e').lastIssuedNumber, 100);
});

test('deleting restored tickets cannot reuse their previously issued numbers', async () => {
  const h = ticketInventoryHarness(), restored = {...h.ticket(), ticketId: 'restored', basicInfo: {ticketNumber: 200}};
  await h.api.appendTickets('e', [restored]);await h.api.deleteTicket('e', restored.ticketId);
  assert.equal(await h.api.loadNextTicketNumber('e', 'TKT'), 201);
  assert.equal(h.inventory.get('events/e').lastIssuedNumber, 200);
});

test('a ticket edit cannot lower the issued-number watermark', async () => {
  const h = ticketInventoryHarness({lastIssuedNumber: 300}), edited = h.ticket();edited.basicInfo.ticketNumber = 20;
  await h.api.saveTicket('e', edited, ['basicInfo']);
  assert.equal(h.inventory.get('events/e').lastIssuedNumber, 300);
  assert.equal(await h.api.loadNextTicketNumber('e', 'TKT'), 301);
});

test('a failed ticket edit commits neither its new number nor its issuance watermark', async () => {
  const h = ticketInventoryHarness({rejectCommit: true}), edited = h.ticket();edited.basicInfo.ticketNumber = 100;
  await assert.rejects(h.api.saveTicket('e', edited, ['basicInfo']), /simulated-commit-failure/);
  assert.equal(h.ticket().basicInfo.ticketNumber, 1);
  assert.equal(h.inventory.get('events/e').lastIssuedNumber, 1);
});

for (const count of [2, 401]) test('duplicate numbers in a ' + count + '-ticket issuance request fail before the first chunk is written', async () => {
  const h = ticketInventoryHarness(), tickets = Array.from({length: count}, (_, n) => ({...h.ticket(), ticketId: 'new-' + n, basicInfo: {ticketNumber: n === count - 1 ? 2 : n + 2}}));
  await assert.rejects(h.api.appendTickets('e', tickets, true));
  assert.equal(h.transactions, 0);
  assert.equal(h.inventory.size, 2);
});

test('a restored ticket cannot duplicate a live ticket number under another ID', async () => {
  const h = ticketInventoryHarness(), restored = {...h.ticket(), ticketId: 'different-backup-id'};
  await assert.rejects(h.api.appendTickets('e', [restored]), /DUPLICATE_TICKET_NUMBER/);
  assert.equal(h.transactions, 0);
  assert.equal(h.inventory.size, 2);
});

test('restore inventory preflight is invalidated by a concurrent ticket edit', async () => {
  const h = ticketInventoryHarness({beforeTransaction: inventory => {inventory.get('events/e').inventoryRevision++;}});
  const restored = {...h.ticket(), ticketId: 'new-backup-id', basicInfo: {ticketNumber: 50}};
  await assert.rejects(h.api.appendTickets('e', [restored]), /TICKET_CHANGED_RETRY/);
  assert.equal(h.inventory.has('events/e/tickets/new-backup-id'), false);
  assert.equal(h.inventory.get('events/e').ticketCount, 1);
});
