import { collection, deleteField, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy,
  query, runTransaction, serverTimestamp, startAfter, Timestamp, type QueryConstraint } from "firebase/firestore";
import { pairingCode } from "../public/people-counter/station-command.mjs";
import { ensureFirebaseAuth, getFirebaseDb, getFirebaseUid } from "./firebaseClient";

type Mode = "live" | "test";
type Role = "in" | "out";
type StationStatus = "pending" | "approved" | "rejected" | "revoked";
type Operation = {id: string; eventId: string; mode: string; synced?: boolean};
type Station = {name: string; device: string; role: Role; status: StationStatus; updatedAt?: Timestamp; pairingIssuedAt?: Timestamp};
type EventConfig = {opened: number | null; closed: number | null; paused: boolean; verified: boolean; version: number | null};
type Heartbeat = {version: "14" | "15"; camera: boolean; ai: boolean; profile: "baseline" | "detail" | "lighting" | "unknown";
  pending: number; alert: "none" | "paused" | "setup" | "recalibrate" | "camera" | "storage" | "network"; mode: Mode};
type Cursor = {seconds: number; nanoseconds: number; id: string};

function decodeOperation(payload: unknown) {
  return typeof payload === "string" ? JSON.parse(payload) : payload;
}

function sortedPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedPayload);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, item]) => [key, sortedPayload(item)]));
}

export async function readCounterStation(eventId: string) {
  const uid = await getFirebaseUid();
  const ref = doc(getFirebaseDb(), "events", eventId, "counterDevices", uid);
  const snapshot = await getDocFromServer(ref);
  return snapshot.exists() ? snapshot.data() as Station : null;
}

export async function enrollCounterStation(eventId: string, station: Pick<Station, "name" | "device" | "role">, pairing = false) {
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const ref = doc(db, "events", eventId, "counterDevices", uid);
  const code = pairing ? pairingCode() : null;
  await runTransaction(db, async tx => {
    const current = await tx.get(ref);
    if (current.exists() && current.get("device") !== station.device) throw new Error("このSafariには別の端末登録が紐づいています");
    if (current.exists() && (!code || current.get("status") === "approved")) return;
    const pairingFields = code ? {pairingIssuedAt:serverTimestamp()} : {};
    if (current.exists()) tx.update(ref,{...pairingFields,status:"pending",pairingConfirmed:deleteField()});
    else tx.set(ref,{...station,status:"pending",requestedAt:serverTimestamp(),...pairingFields});
    if (code) tx.set(doc(db,"events",eventId,"counterPairCodes",code),{uid,device:station.device,issuedAt:serverTimestamp(),usedAt:null});
  }, {maxAttempts: 1});
  return code;
}

export async function readStationCommand(eventId: string) {
  const uid = await getFirebaseUid();
  const ref = doc(getFirebaseDb(),"events",eventId,"counterCommands",uid);
  return (await getDocFromServer(ref)).data() ?? null;
}

export async function updateStationCommand(eventId: string, identifier: string, result?: string, downtimeMs?: number) {
  const uid = await getFirebaseUid(), db = getFirebaseDb();
  const ref = doc(db,"events",eventId,"counterCommands",uid);
  return runTransaction(db, async tx => {
    const snap = await tx.get(ref);
    if (snap.get("id") !== identifier) return false;
    if (result === undefined && snap.get("state") === "issued") {
      tx.update(ref,{state:"running",startedAt:serverTimestamp()});
      return true;
    }
    if (result !== undefined && snap.get("state") === "running") {
      tx.update(ref,{state:"finished",result,finishedAt:serverTimestamp(),...(downtimeMs===undefined?{}:{downtimeMs})});
      return true;
    }
    return false;
  },{maxAttempts:1});
}

export async function readCounterConfig(eventId: string, mode: Mode) {
  await ensureFirebaseAuth();
  const snapshot = await getDocFromServer(doc(getFirebaseDb(), "events", eventId, "counterConfig", mode));
  if (!snapshot.exists()) return null;
  const {opened, closed, paused, verified, version} = snapshot.data();
  if (![opened, closed].every(value => value === null || Number.isSafeInteger(value)) ||
      typeof paused !== "boolean" || typeof verified !== "boolean") throw new Error("管理側の設定を読み込めません");
  return {opened, closed, paused, verified, version: Number.isSafeInteger(version) ? version : null} as EventConfig;
}

export async function heartbeatCounterStation(eventId: string, health: Heartbeat & {configVersion?:number|null}) {
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const ref = doc(db, "events", eventId, "counterDevices", uid);
  await runTransaction(db, async tx => {
    const current = await tx.get(ref);
    if (current.get("status") !== "approved") return;
    tx.update(ref, {...health, lastSeen: serverTimestamp()});
  }, {maxAttempts: 1});
}

export async function serverClock(eventId: string) {
  const auth = await ensureFirebaseAuth();
  const db = getFirebaseDb();
  const ref = doc(db, "counterClocks", auth.currentUser!.uid);
  await runTransaction(db, async tx => {
    await tx.get(ref);
    tx.set(ref, {at: serverTimestamp(), eventId});
  }, {maxAttempts: 1});
  const at = (await getDocFromServer(ref)).get("at");
  if (!(at instanceof Timestamp)) throw new Error("サーバー時刻が取得できません");
  return at.toMillis();
}

export async function pushOperations(eventId: string, mode: string, rows: Operation[]) {
  await ensureFirebaseAuth();
  const db = getFirebaseDb();
  const refs = rows.map(row => doc(db, "events", eventId, "counterRuns", mode, "operations", row.id));
  await runTransaction(db, async tx => {
    const existing = await Promise.all(refs.map(ref => tx.get(ref)));
    for (const [index, {synced: _synced, ...row}] of rows.entries()) {
      const payload = sortedPayload(row);
      if (existing[index].exists()) {
        if (JSON.stringify(sortedPayload(decodeOperation(existing[index].get("payload")))) !== JSON.stringify(payload)) {
          throw new Error("同じIDに異なる記録があります");
        }
      } else tx.set(refs[index], {payload, receivedAt: serverTimestamp()});
    }
  });
}

export async function pullOperations(eventId: string, mode: string, cursor?: Cursor) {
  await ensureFirebaseAuth();
  const source = collection(getFirebaseDb(), "events", eventId, "counterRuns", mode, "operations");
  const constraints: QueryConstraint[] = [orderBy("receivedAt"), orderBy(documentId()), limit(200)];
  if (cursor) constraints.push(startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id));
  const page = await getDocsFromServer(query(source, ...constraints));
  const rows = page.docs.map(snapshot => {
    const row = decodeOperation(snapshot.get("payload"));
    if (!row || row.id !== snapshot.id || row.eventId !== eventId || row.mode !== mode) throw new Error("同期データのイベントまたはIDが不正です");
    return row;
  });
  const last = page.docs.at(-1);
  const at = last?.get("receivedAt") as Timestamp | undefined;
  return {rows, cursor: last && at ? {seconds: at.seconds, nanoseconds: at.nanoseconds, id: last.id} : cursor};
}
