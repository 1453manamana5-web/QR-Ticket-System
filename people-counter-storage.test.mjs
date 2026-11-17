import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { openRecordStore, totalOf, LEASE_MS } from './reception-app/public/people-counter/records.mjs';
import { CameraHealth, MAX_INFERENCE_MS, withDeadline } from './reception-app/public/people-counter/health.mjs';
let nextId = 0;
const uuid = () => 'audit-' + ++nextId;
const open = (factory = new IDBFactory(), extra = {}) => openRecordStore({ indexedDB: factory, uuid, ...extra });
const add = (store, delta = 1) => store.append({ delta, type: 'manual', expectedSession: store.initial.session });
async function legacyDatabase(factory, records) {
  const db = await new Promise((resolve, reject) => { const r = factory.open('koken-people-counter-prototype-v1', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('events', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
  await new Promise((resolve, reject) => { const t = db.transaction('events', 'readwrite');
    records.forEach(row => t.objectStore('events').put(row)); t.oncomplete = resolve; t.onabort = () => reject(t.error); });
  return db;
}
test('active session and records survive reload without localStorage', async () => {
  const factory = new IDBFactory(), a = await open(factory);
  await add(a); a.close();
  const b = await open(factory);
  assert.equal(b.initial.total, 1); assert.equal(b.initial.session, a.initial.session); b.close();
});
test('old records with a lost session hint are recovered without a schema upgrade', async () => {
  const factory = new IDBFactory(); const old = await legacyDatabase(factory, [
    { id: 'old1', session: 'old-session', delta: 1, type: 'auto', at: '2026-11-15T01:00:00Z' },
  ]);
  // Keep the old connection open: v5 must not hang waiting for an upgrade.
  const a = await open(factory); assert.equal(a.initial.total, 1); assert.equal(a.initial.session, 'old-session');
  a.close(); old.close();
});
test('a legacy empty session hint is preserved on first migration', async () => {
  const a = await open(new IDBFactory(), { legacySession: 'empty-trial' });
  assert.equal(a.initial.session, 'empty-trial'); a.close();
});
test('two tabs cannot subtract the same last visitor twice', async () => {
  const factory = new IDBFactory(), a = await open(factory); await add(a);
  const b = await open(factory);
  const results = await Promise.all([add(a, -1), add(b, -1)]);
  assert.deepEqual(results.map(r => r.status).sort(), ['saved', 'unchanged']);
  const result = await add(b, 1); assert.equal(result.snapshot.total, 1);
  assert.equal((await a.read()).events.reduce((s, e) => s + e.delta, 0), 1); a.close(); b.close();
});
test('concurrent increments from two tabs are both retained', async () => {
  const factory = new IDBFactory(), a = await open(factory), b = await open(factory);
  await Promise.all([add(a), add(b)]); assert.equal((await a.read()).total, 2); a.close(); b.close();
});
test('old negative records never create debt for a future visitor', async () => {
  const factory = new IDBFactory(); const old = await legacyDatabase(factory, [1, -1, -1].map((delta, i) => ({
    id: 'old-' + i, session: 'old', delta, at: '2026-11-15T00:00:0' + i + 'Z', type: 'manual' })));
  old.close(); const a = await open(factory);
  assert.equal(a.initial.total, 0); assert.equal((await add(a)).snapshot.total, 1); a.close();
});
test('new trial invalidates old queued records rather than moving them to the new trial', async () => {
  const factory = new IDBFactory(), a = await open(factory), b = await open(factory);
  const before = a.initial.session, fresh = await b.newSession();
  const r = await a.append({ delta: 1, type: 'manual', expectedSession: before });
  assert.equal(r.status, 'session-changed'); assert.equal(r.snapshot.session, fresh.session); assert.equal(r.snapshot.total, 0);
  a.close(); b.close();
});
test('camera lease permits only one tab and rejects an expired owner', async () => {
  const factory = new IDBFactory(), a = await open(factory), b = await open(factory); const session = a.initial.session;
  assert.equal(await a.acquireLease('tab-a', session, 1000), true);
  assert.equal(await b.acquireLease('tab-b', session, 1001), false);
  assert.equal((await b.append({ delta: 1, type: 'auto', owner: 'tab-b', expectedSession: session, now: 1002 })).status, 'lease-lost');
  assert.equal(await b.acquireLease('tab-b', session, 1000 + LEASE_MS + 1), true);
  assert.equal((await a.append({ delta: 1, type: 'auto', owner: 'tab-a', expectedSession: session, now: 1000 + LEASE_MS + 2 })).status, 'lease-lost');
  assert.equal((await b.append({ delta: 1, type: 'auto', owner: 'tab-b', expectedSession: session, now: 1000 + LEASE_MS + 3 })).snapshot.total, 1);
  await a.releaseLease('tab-a'); // Late cleanup must never release another tab's lease.
  assert.equal(await a.acquireLease('tab-a', session, 1000 + LEASE_MS + 4), false);
  a.close(); b.close();
});
test('sequence numbers retain order when the device clock goes backwards', async () => {
  const a = await open(); const session = a.initial.session;
  await a.append({ delta: 1, type: 'manual', expectedSession: session, now: 2000 });
  await a.append({ delta: -1, type: 'manual', expectedSession: session, now: 1000 });
  assert.deepEqual((await a.read()).events.map(e => e.delta), [1, -1]); assert.equal(totalOf((await a.read()).events), 0); a.close();
});
test('camera health detects ended and frozen video while accepting new frames', () => {
  const h = new CameraHealth(0, 1);
  assert.equal(h.check(1000, { videoTime: 2 }), null);
  assert.equal(h.check(3000, { videoTime: 2 }), null);
  assert.match(h.check(3500, { videoTime: 2 }), /更新/);
  assert.match(h.check(100, { videoTime: 2, ended: true }), /停止/);
});
test('slow or hung inference is reported instead of silently counting at an unsafe rate', async () => {
  const h = new CameraHealth(0, 1);
  assert.match(h.check(MAX_INFERENCE_MS + 1, { videoTime: 2, inferenceStarted: 0 }), /遅い/);
  await assert.rejects(withDeadline(new Promise(() => {}), 5, 'timeout'), /timeout/);
  assert.equal(await withDeadline(Promise.resolve(42), 50, 'timeout'), 42);
});
