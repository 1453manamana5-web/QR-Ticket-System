// Same database/version as the prototype: old events stay intact. Metadata uses
// reserved IDs in the existing store, so an old open tab cannot block an upgrade.
const DB_NAME = 'koken-people-counter-prototype-v1';
const STATE = 'meta:people-counter-state';
const LEASE = 'meta:people-counter-camera';
export const LEASE_MS = 15000;
const validEvent = row => typeof row.session === 'string' && (row.delta === 1 || row.delta === -1);
export function orderedEvents(rows, session) {
  return rows.filter(row => validEvent(row) && row.session === session).sort((a, b) => {
    const sa = Number.isFinite(a.seq), sb = Number.isFinite(b.seq);
    if (sa && sb) return a.seq - b.seq;
    if (sa !== sb) return sa ? 1 : -1;
    return String(a.at).localeCompare(String(b.at)) || String(a.id).localeCompare(String(b.id));
  });
}
export function totalOf(events) {
  // Old versions could store an excessive -1 from two tabs. Keep the original
  // evidence, but never let it create a hidden debt against future visitors.
  return events.reduce((sum, event) => Math.max(0, sum + event.delta), 0);
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined)
    .map(key => [key, canonical(value[key])]));
}
function ledgerContent({synced, ...row}) {
  if (row.kind !== 'revision') return JSON.stringify(canonical(row));
  const {at,source,direction,person,invalid,clockWarning,clockUncertainty,configVersion,...revision} = row;
  const snapshot = fields => fields && {...fields,clockWarning:fields.clockWarning ?? '',clockUncertainty:fields.clockUncertainty ?? null};
  return JSON.stringify(canonical({...revision,before:snapshot(revision.before),after:snapshot(revision.after),resolves:revision.resolves ?? []}));
}
export async function openRecordStore({ indexedDB = globalThis.indexedDB,
  uuid = () => globalThis.crypto.randomUUID(), legacySession = null, onClose = () => {} } = {}) {
  if (!indexedDB) throw new Error('このブラウザは端末内保存に対応していません。');
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('events')) request.result.createObjectStore('events', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('以前の画面を閉じて再試行してください。'));
  });
  db.onversionchange = () => { db.close(); onClose(); };
  const transact = (mode, operation) => new Promise((resolve, reject) => {
    const tx = db.transaction('events', mode), store = tx.objectStore('events');
    let result, failure;
    const request = store.getAll();
    request.onsuccess = () => {
      try { result = operation(request.result, store); }
      catch (error) { failure = error; tx.abort(); }
    };
    tx.oncomplete = () => resolve(result);
    tx.onabort = tx.onerror = () => reject(failure || tx.error || new Error('記録を保存できませんでした。'));
  });
  const stateFrom = rows => {
    const state = rows.find(row => row.id === STATE);
    if (!state?.activeSession) throw new Error('試験情報を読み込めませんでした。画面を再読み込みしてください。');
    return state;
  };
  const snapshot = (rows, state = stateFrom(rows)) => {
    const events = orderedEvents(rows, state.activeSession);
    return { session: state.activeSession, revision: state.revision, events, total: totalOf(events) };
  };
  let initial;
  try {
    initial = await transact('readwrite', (rows, store) => {
      let state = rows.find(row => row.id === STATE);
      if (!state?.activeSession) {
        const latest = rows.filter(validEvent).sort((a, b) => String(a.at).localeCompare(String(b.at))).at(-1);
        state = { id: STATE, activeSession: legacySession || latest?.session || uuid(), revision: 1 };
        store.put(state);
      }
      return snapshot(rows, state);
    });
  } catch (error) { db.close(); throw error; }
  return {
    initial,
    read: () => transact('readonly', rows => snapshot(rows)),
    append: ({ delta, type, expectedSession, owner, now = Date.now(), passage }) => transact('readwrite', (rows, store) => {
      if (![1, -1].includes(delta) || !['auto', 'manual'].includes(type)) throw new Error('記録の内容が不正です。');
      const state = stateFrom(rows), current = snapshot(rows, state);
      if (expectedSession !== state.activeSession) return { status: 'session-changed', snapshot: current };
      if (type === 'auto') {
        const lease = rows.find(row => row.id === LEASE);
        if (!lease || lease.owner !== owner || lease.sessionId !== expectedSession || lease.expiresAt <= now) {
          return { status: 'lease-lost', snapshot: current };
        }
      }
      if (delta < 0 && current.total === 0) return { status: 'unchanged', snapshot: current };
      const record = { id: uuid(), session: expectedSession, delta, type, at: new Date(now).toISOString(), seq: state.revision + 1 };
      const next = { ...state, revision: state.revision + 1 };
      store.add(record); store.put(next);
      if (passage) {
        const sequenceId = "meta:counter-sequence:" + JSON.stringify([passage.eventId, passage.mode, passage.device]);
        const number = (rows.find(row => row.id === sequenceId)?.number ?? 0) + 1;
        store.put({ id: sequenceId, number });
        store.add({ ...passage, id: "ledger:" + record.id, passageId: record.id, sequence: number, kind: 'passage', synced: false });
      }
      return { status: 'saved', snapshot: snapshot([...rows, record], next) };
    }),
    ledger: () => transact('readonly', rows => rows.filter(row => row.kind === 'passage' || row.kind === 'revision')),
    addLedger: row => transact('readwrite', (_, store) => store.add(row)),
    mergeLedger: incoming => transact('readwrite', (rows, store) => {
      const existing = new Map(rows.filter(r => r.kind === 'passage' || r.kind === 'revision').map(row => [row.id, row]));
      for (const row of incoming) {
        const old = existing.get(row.id);
        if (old) {
          if (ledgerContent(old) !== ledgerContent(row)) throw new Error('同一IDの記録内容が一致しません: ' + row.id);
          store.put({...old, synced: true});
        } else store.add({...row, synced: true});
      }
    }),
    newSession: () => transact('readwrite', (rows, store) => {
      const previous = stateFrom(rows), state = { id: STATE, activeSession: uuid(), revision: previous.revision + 1 };
      store.put(state); store.delete(LEASE);
      return snapshot(rows, state);
    }),
    acquireLease: (owner, sessionId, now = Date.now()) => transact('readwrite', (rows, store) => {
      if (stateFrom(rows).activeSession !== sessionId) return false;
      const lease = rows.find(row => row.id === LEASE);
      const active = lease && lease.expiresAt > now && lease.expiresAt - now <= LEASE_MS * 2;
      if (active && lease.owner !== owner) return false;
      store.put({ id: LEASE, owner, sessionId, expiresAt: now + LEASE_MS }); return true;
    }),
    renewLease: (owner, sessionId, now = Date.now()) => transact('readwrite', (rows, store) => {
      const lease = rows.find(row => row.id === LEASE);
      if (stateFrom(rows).activeSession !== sessionId || !lease || lease.owner !== owner || lease.expiresAt <= now) return false;
      store.put({ ...lease, expiresAt: now + LEASE_MS }); return true;
    }),
    releaseLease: owner => transact('readwrite', (rows, store) => {
      if (rows.find(row => row.id === LEASE)?.owner === owner) store.delete(LEASE);
    }),
    close() { db.close(); },
  };
}
