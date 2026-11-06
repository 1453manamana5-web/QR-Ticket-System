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
