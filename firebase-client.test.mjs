import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadModule(file, dependencies) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/import\.meta\.env\.[A-Z_]+/g, '"test-config"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, require: name => {
    if (!(name in dependencies)) throw Error("Unexpected dependency: " + name);
    return dependencies[name];
  } });
  return exports;
}

for (const app of ["management-app", "reception-app"]) {
  function loadAuth(auth, signIn) {
    const firebaseApp = {};
    return loadModule("./" + app + "/src/firebaseClient.ts", {
      "firebase/app": { getApps: () => [firebaseApp], getApp: () => firebaseApp },
      "firebase/auth": { getAuth: () => auth, signInAnonymously: signIn },
      "firebase/firestore": { getFirestore: () => ({}) },
    });
  }

  test(app + ": waits for persisted identity and shares concurrent initialization", async () => {
    let restore;
    let signIns = 0;
    const auth = { currentUser: null, authStateReady: () => new Promise(resolve => { restore = resolve; }) };
    const client = loadAuth(auth, async () => { signIns++; });
    const first = client.ensureFirebaseAuth();
    const second = client.ensureFirebaseAuth();
    assert.equal(first, second);
    assert.equal(signIns, 0);
    auth.currentUser = { uid: "approved-existing-uid" };
    restore();
    assert.equal(await client.getFirebaseUid(), "approved-existing-uid");
    await Promise.all([first, second]);
    assert.equal(signIns, 0);
  });

  test(app + ": fresh login retries after failure", async () => {
    let attempts = 0;
    const auth = { currentUser: null, authStateReady: async () => {} };
    const client = loadAuth(auth, async () => {
      attempts++;
      if (attempts === 1) throw Error("network unavailable");
      auth.currentUser = { uid: "new-uid" };
    });
    await assert.rejects(client.ensureFirebaseAuth(), /network unavailable/);
    assert.equal(await client.getFirebaseUid(), "new-uid");
    assert.equal(attempts, 2);
  });

  test(app + ": callable waits for authentication and uses the same Firebase app", async () => {
    let resolveAuth;
    const ready = new Promise(resolve => { resolveAuth = resolve; });
    const firebaseApp = {};
    const calls = [];
    const backend = loadModule("./" + app + "/src/firebaseFunctions.ts", {
      "./firebaseClient": { ensureFirebaseAuth: () => ready, getFirebaseApp: () => firebaseApp },
      "firebase/functions": {
        getFunctions: app => { assert.equal(app, firebaseApp); return "functions"; },
        httpsCallable: (instance, name) => async input => {
          calls.push({ instance, name, input });
          return { data: "ok" };
        },
      },
    });
    const result = backend.callBackend("operation", { value: 1 });
    assert.equal(calls.length, 0);
    resolveAuth();
    assert.equal(await result, "ok");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "operation");
  });
}

test("reception registration atomically creates the application and pending terminal", async () => {
  const writes = [];
  let commits = 0;
  const db = {};
  const source = readFileSync(new URL("./reception-app/src/receptionSync.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  const dependencies = {
    "./firebaseClient": { ensureFirebaseAuth: async () => {}, getFirebaseUid: async () => "new-user", getFirebaseDb: () => db },
    "./localDb": { getPendingSyncItems: async () => [] },
    "firebase/firestore": {
      collection: (...args) => args.slice(1).join("/"), doc: (...args) => args.slice(1).join("/"),
      query: (...args) => args, where: (...args) => args, limit: n => n,
      getDocs: async () => ({ docs: [] }),
      writeBatch: () => ({ set: (ref, data) => writes.push({ ref, data }), commit: async () => { commits++; } }),
    },
  };
  vm.runInNewContext(compiled, {
    exports, require: name => dependencies[name],
    localStorage: { getItem: () => "T-TEST-RECEPTION-01" },
    navigator: { userAgent: "iPad" },
  });
  await exports.registerReceptionTerminal("  Entrance  ");
  assert.equal(commits, 1);
  assert.equal(writes.length, 2);
  const app = writes.find(w => w.ref.startsWith("terminalApplications/")).data;
  const terminal = writes.find(w => w.ref.startsWith("terminals/")).data;
  assert.equal(app.terminalId, terminal.terminalId);
  assert.equal(app.requestedByUid, "new-user");
  assert.equal(terminal.requestedByUid, app.requestedByUid);
  assert.equal(terminal.name, "Entrance");
  for (const field of ["approved", "managementApproved", "receptionApproved", "admin", "subAdmin"]) {
    assert.equal(terminal[field], false);
  }
});
