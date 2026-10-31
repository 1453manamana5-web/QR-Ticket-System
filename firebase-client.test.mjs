import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadModule(file, dependencies, storage = { getItem: () => null, setItem: () => {} }, globals = {}) {
  const source = readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/import\.meta\.env\.[A-Z_]+/g, '"test-config"');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(compiled, { exports, ...globals, localStorage: storage, require: name => {
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
      "firebase/firestore": { initializeFirestore: () => ({}), persistentLocalCache: value => value, persistentMultipleTabManager: () => ({}) },
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
      getDoc: async () => ({ exists: () => false }),
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


for (const scenario of ["new", "pending", "manager", "handoff", "offline"]) {
  test("management terminal loading: " + scenario, async () => {
    let listedTerminals = false;
    const stored = new Map([["qr-ticket-terminal-id", "T-CHANGED-RECEPTION"]]);
    const terminalId = "T-TEST-MANAGEMENT";
    const snapshot = data => ({ exists: () => data !== null, data: () => data });
    const module = loadModule("./management-app/src/firebaseData.ts", {
      "./firebaseClient": {
        ensureFirebaseAuth: async () => {}, getFirebaseUid: async () => "current-uid", getFirebaseDb: () => ({}),
      },
      "firebase/firestore": {
        doc: (_db, ...parts) => parts.join("/"), collection: (_db, ...parts) => parts.join("/"),
        query: ref => ref, where: () => {}, limit: () => {},
        getDocFromServer: async ref => {
          if (scenario === "offline") throw Error("offline");
          if (ref.startsWith("terminalInstallations/")) return snapshot(
            scenario === "manager" || scenario === "handoff"
              ? { terminalId, authUid: "current-uid", approved: true } : null);
          if (ref.startsWith("terminalOwners/")) return snapshot({
            enabled: true, ownerUid: scenario === "handoff" ? "original-owner" : "current-uid",
          });
          return snapshot({ terminalId, approved: true, managementApproved: true, role: "both" });
        },
        getDocsFromServer: async ref => {
          if (ref === "terminals") {
            listedTerminals = true;
            return { docs: [{ id: terminalId, data: () => ({ approved: true, role: "management" }) }] };
          }
          return { docs: scenario === "pending" ? [{ data: () => ({
            terminalId, requestedRole: "management", status: "pending", name: "iPad",
          }) }] : [] };
        },
      },
    }, { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) });
    if (scenario === "offline") {
      await assert.rejects(module.loadTerminals(), /offline/);
    } else {
      const result = await module.loadTerminals();
      assert.equal(result.length, scenario === "new" || scenario === "handoff" ? 0 : 1);
      if (scenario === "pending") assert.equal(result[0].approved, false);
    }
    assert.equal(listedTerminals, scenario === "manager");
    assert.equal(stored.get("qr-ticket-terminal-id"), scenario === "manager" ? terminalId : "T-CHANGED-RECEPTION");
    if (scenario === "manager") assert.equal(stored.get("qr-ticket-device-id"), terminalId);
  });
}

test('reserve print activation is idempotent, preserves reception state, and leaves transfer inventory count unchanged',async()=>{
  const inventory=new Map([
    ['events/e',{ticketCount:700,inventoryRevision:1,dataVersion:1}],
    ['events/e/tickets/r',{basicInfo:{ticketNumber:501,reserve:true},currentStatus:'inside',valid:false}],
    ['events/e/tickets/n',{basicInfo:{ticketNumber:1},currentStatus:'unused',valid:true}],
  ]);
  const writes=[];
  const api=loadModule('./management-app/src/firebaseData.ts',{
    './firebaseClient':{getFirebaseDb:()=>({})},
    'firebase/firestore':{doc:(_db,...parts)=>parts.join('/'),runTransaction:async(_db,fn)=>fn({get:async ref=>({exists:()=>inventory.has(ref),data:()=>inventory.get(ref)}),update:(ref,patch)=>{writes.push({ref,patch});const value=inventory.get(ref);for(const [key,v] of Object.entries(patch)){if(key==='basicInfo.reservePrinted')value.basicInfo.reservePrinted=v;else value[key]=v;}},set:()=>assert.fail('no published bundle expected')})},
  });
  await api.markReserveTicketsPrinted('e',['r','r','n','missing']);
  assert.equal(inventory.get('events/e/tickets/r').basicInfo.reservePrinted,true);assert.equal(inventory.get('events/e/tickets/r').currentStatus,'inside');assert.equal(inventory.get('events/e/tickets/r').valid,false);
  assert.equal(inventory.get('events/e').ticketCount,700);assert.equal(inventory.get('events/e/tickets/n').basicInfo.reservePrinted,undefined);
  const count=writes.length;await api.markReserveTicketsPrinted('e',['r']);assert.equal(writes.length,count);
});

for(const ownerUid of ['current-uid','another-owner'])test('offline terminal cache verifies restored identity and owner: '+ownerUid,async()=>{
 const snap=value=>({exists:()=>true,data:()=>value});let servers=0;
 const client=loadModule('./management-app/src/firebaseData.ts',{
  './firebaseClient':{ensureFirebaseAuth:async()=>{},getFirebaseUid:async()=> 'current-uid',getFirebaseDb:()=>({})},
  'firebase/firestore':{
   doc:(_db,...p)=>p.join('/'),collection:(_db,...p)=>p.join('/'),
   getDocFromServer:async()=>{servers++;throw Error('network');},
   getDocsFromServer:async()=>{servers++;throw Error('network');},
   getDocFromCache:async ref=>snap(ref.startsWith('terminalInstallations/')?{authUid:'current-uid',terminalId:'T-CACHED',approved:true}:ref.startsWith('terminalOwners/')?{ownerUid,enabled:true}:{approved:true,managementApproved:true,role:'management'}),
   getDocsFromCache:async()=>({docs:[{id:'T-CACHED',data:()=>({approved:true,managementApproved:true,role:'management'})}]}),
  }
 },{getItem:()=>null,setItem(){}},{navigator:{onLine:false}});
 assert.equal((await client.loadTerminals()).length,ownerUid==='current-uid'?1:0);assert.equal(servers,0);
 await assert.rejects(client.saveEvent({eventId:'cached'}),/オンライン/);assert.equal(servers,0);
});
