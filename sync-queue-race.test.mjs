import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {test} from "node:test";
const ts = createRequire(import.meta.url)("typescript");

function loadWorker(local, sync) {
  const compiled = ts.transpileModule(readFileSync(new URL("./reception-app/src/syncQueue.ts", import.meta.url), "utf8"), {
    compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022},
  }).outputText;
  const out = {};
  new Function("exports", "require", "navigator", "console", compiled)(out,
    name => name === "./localDb" ? local : {syncReceptionRecord: sync},
    {onLine: true}, {error: () => {}});
  return out;
}

test("a sync request joining between drain completion and finalizer is included in its returned promise", async () => {
  const uploaded = [], pending = [];
  let reads = 0, worker, joined;
  worker = loadWorker({
    getPendingSyncItems: async () => {
      if (++reads === 1) {
        // Resume the empty drain, then join before its promise finalizer runs.
        queueMicrotask(() => queueMicrotask(() => {
          pending.push({recordId: "new-record", retryCount: 0});
          joined = worker.syncPendingReceptionRecords();
        }));
        return [];
      }
      return [...pending];
    },
    getReceptionRecord: async () => ({recordId: "new-record", eventId: "event-one", ticketId: "ticket-one"}),
    markSyncStatus: async () => { pending.length = 0; },
  }, async record => { uploaded.push(record.recordId); });
  await worker.syncPendingReceptionRecords();
  await joined;
  assert.deepEqual(uploaded, ["new-record"]);
  assert.equal(pending.length, 0);
});
