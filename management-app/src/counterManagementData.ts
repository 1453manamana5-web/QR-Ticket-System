import {
  collection, doc, getDocFromServer, onSnapshot, runTransaction, serverTimestamp, setDoc, Timestamp,
  type DocumentData, type QueryDocumentSnapshot, type SnapshotMetadata,
} from "firebase/firestore";
import { ensureFirebaseAuth, getFirebaseDb, getFirebaseUid } from "../../reception-app/src/firebaseClient";
import type {
  CounterDirection, CounterMode, CounterOperation, CounterPassageFields, EffectiveCounterPassage,
} from "../../reception-app/public/people-counter/ledger.mjs";

export { analyze, csv } from "../../reception-app/public/people-counter/ledger.mjs";
export type {
  CounterDirection, CounterMode, CounterOperation, CounterPassage, CounterPassageFields, CounterRevision,
  EffectiveCounterPassage,
} from "../../reception-app/public/people-counter/ledger.mjs";

export type CounterConfig = {opened: number | null; closed: number | null; paused: boolean; verified: boolean};
export type CounterStationStatus = "pending" | "approved" | "rejected" | "revoked";
export type CounterStation = {
  uid: string;
  name: string;
  device: string;
  role: CounterDirection;
  status: CounterStationStatus;
  requestedAt: number;
  lastSeen?: number;
  version?: string;
  camera?: boolean;
  ai?: boolean;
  profile?: string;
  pending?: number;
  configVersion?: number;
  alert?: string;
  mode?: CounterMode;
  updatedAt?: number;
  updatedByUid?: string;
};
export type CounterSnapshot<T> = {
  data: T;
  source: "pending" | "cache" | "server" | "error";
  serverAt?: number;
  lastChangeAt?: number;
  error?: string;
  errorCode?: string;
  invalid?: number;
};
export type CounterCallbacks = {
  config(snapshot: CounterSnapshot<CounterConfig | null>): void;
  stations?(snapshot: CounterSnapshot<CounterStation[]>): void;
  operations(snapshot: CounterSnapshot<CounterOperation[]>): void;
};

const isDirection = (value: unknown): value is CounterDirection => value === "in" || value === "out";
const isMode = (value: unknown): value is CounterMode => value === "live" || value === "test";
const isStatus = (value: unknown): value is CounterStationStatus =>
  value === "pending" || value === "approved" || value === "rejected" || value === "revoked";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isMillis = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8.64e15;
const isPathPart = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 160 && !value.includes("/") && value !== "." && value !== "..";
const isOperationId = (value: unknown): value is string => typeof value === "string" &&
  /^(ledger|edit):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const isReason = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 180;
const optionalMillis = (value: unknown): number | undefined => {
  const milliseconds = value instanceof Timestamp ? value.toMillis() : value;
  return isMillis(milliseconds) ? milliseconds : undefined;
};
const checkedScope = (eventId: string, mode: CounterMode) => {
  if (!isPathPart(eventId) || !isMode(mode)) throw new Error("人数計測のイベントまたは運用区分が不正です。");
};

export function decodeConfig(data: unknown): CounterConfig | null {
  if (!isRecord(data)) return null;
  const {opened, closed, paused, verified} = data;
  if (!(opened === null || isMillis(opened)) || !(closed === null || isMillis(closed)) ||
      typeof paused !== "boolean" || typeof verified !== "boolean" ||
      (closed !== null && (opened === null || closed < opened)) ||
      (verified && closed === null)) return null;
  return {opened, closed, paused, verified};
}

function decodeStation(uid: string, data: DocumentData): CounterStation | null {
  const {name, device, role, status, version, camera, ai, profile, pending, alert, mode, updatedByUid} = data;
  const requestedAt = optionalMillis(data.requestedAt);
  if (typeof name !== "string" || !isPathPart(device) || !isDirection(role) || !isStatus(status) || requestedAt === undefined) return null;
  return {
    uid, name, device, role, status, requestedAt, lastSeen: optionalMillis(data.lastSeen),
    updatedAt: optionalMillis(data.updatedAt),
    configVersion: Number.isSafeInteger(data.configVersion) ? data.configVersion : undefined,
    version: typeof version === "string" ? version : undefined,
    camera: typeof camera === "boolean" ? camera : undefined,
    ai: typeof ai === "boolean" ? ai : undefined,
    profile: typeof profile === "string" ? profile : undefined,
    pending: Number.isSafeInteger(pending) && pending >= 0 ? pending : undefined,
    alert: typeof alert === "string" ? alert : undefined,
    mode: isMode(mode) ? mode : undefined,
    updatedByUid: typeof updatedByUid === "string" ? updatedByUid : undefined,
  };
}

function passageFields(value: unknown): CounterPassageFields | null {
  if (!isRecord(value)) return null;
  const {at, direction, person, invalid, clockWarning, clockUncertainty} = value;
  if (!isMillis(at) || !isDirection(direction) || (person !== "visitor" && person !== "staff") ||
      typeof invalid !== "boolean") return null;
  return {at,direction,person,invalid,
    clockWarning: typeof clockWarning === "string" ? clockWarning.slice(0, 80) : "",
    clockUncertainty: isMillis(clockUncertainty) ? clockUncertainty : null,
  };
}

export function decodeOperation(id: string, eventId: string, mode: CounterMode, payload: unknown): CounterOperation | null {
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch { return null; }
  }
  if (!isOperationId(id) || !isRecord(payload) || payload.id !== id || payload.eventId !== eventId || payload.mode !== mode ||
      !isPathPart(payload.device) || !isMillis(payload.rawAt)) return null;
  const base = {id,eventId,mode,device:payload.device,rawAt:payload.rawAt,synced:true,
    createdAt:isMillis(payload.createdAt) ? payload.createdAt : undefined,
    station:isDirection(payload.station) ? payload.station : undefined,
    actorUid:isPathPart(payload.actorUid) ? payload.actorUid : undefined};
  if (payload.kind === "passage" && id.startsWith("ledger:") &&
      (payload.source === "manual" || payload.source === "auto")) {
    const fields = passageFields(payload);
    if (!fields) return null;
    return {...base,...fields,kind:"passage",source:payload.source,
      configVersion:Number.isSafeInteger(payload.configVersion) ? Number(payload.configVersion) : undefined,
      sequence:Number.isSafeInteger(payload.sequence) ? Number(payload.sequence) : undefined,
      passageId:typeof payload.passageId === "string" ? payload.passageId : undefined,
      reason:typeof payload.reason === "string" ? payload.reason : undefined};
  }
  if (payload.kind === "revision" && id.startsWith("edit:") && isOperationId(payload.target) && isOperationId(payload.parent) &&
      typeof payload.reason === "string") {
    const before = passageFields(payload.before), after = passageFields(payload.after);
    if (!before || !after) return null;
    return {...base,kind:"revision",target:payload.target,parent:payload.parent,reason:payload.reason,before,after,
      resolves:Array.isArray(payload.resolves) ? payload.resolves.filter(isOperationId) : undefined};
  }
  return null;
}

function observed<T>(initial: T, callback: (snapshot: CounterSnapshot<T>) => void) {
  let current: CounterSnapshot<T> = {data:initial,source:"pending"};
  callback(current);
  return {
    next(data: T, metadata: SnapshotMetadata, invalid = 0, lastChangeAt?: number) {
      const cached = metadata.fromCache || metadata.hasPendingWrites;
      current = cached
        ? {...current,source:"cache",error:undefined,errorCode:undefined}
        : {data,source:"server",serverAt:Date.now(),lastChangeAt,invalid};
      callback(current);
    },
    fail(error: unknown) {
      const errorCode = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
      if (errorCode === "permission-denied" || errorCode === "unauthenticated") current = {data:initial,source:"error"};
      current = {...current,source:"error",errorCode,
        error:error instanceof Error ? error.message : "人数計測データの接続を確認してください。"};
      callback(current);
    },
  };
}

export function subscribeCounterEvent(eventId: string, mode: CounterMode, callbacks: CounterCallbacks): () => void {
  let active = true;
  const cleanup: Array<() => void> = [];
  const config = observed<CounterConfig | null>(null, callbacks.config);
  const stations = callbacks.stations && observed<CounterStation[]>([], callbacks.stations);
  const operations = observed<CounterOperation[]>([], callbacks.operations);
  const failAll = (error: unknown) => {
    if (!active) return;
    config.fail(error);
    stations?.fail(error);
    operations.fail(error);
  };

  void (async () => {
    checkedScope(eventId,mode);
    await ensureFirebaseAuth();
    if (!active) return;
    const db = getFirebaseDb();
    const watch = {includeMetadataChanges:true};
    cleanup.push(onSnapshot(doc(db,"events",eventId,"counterConfig",mode), watch, snapshot => {
      if (!active) return;
      const data = decodeConfig(snapshot.data());
      config.next(data,snapshot.metadata,snapshot.exists() && data === null ? 1 : 0);
    }, error => { if (active) config.fail(error); }));
    if (stations) cleanup.push(onSnapshot(collection(db,"events",eventId,"counterDevices"), watch, snapshot => {
      if (!active) return;
      const data = snapshot.docs.filter(row => !row.metadata.hasPendingWrites)
        .map(row => decodeStation(row.id,row.data())).filter((row): row is CounterStation => row !== null)
        .sort((a,b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name,"ja"));
      stations.next(data,snapshot.metadata,snapshot.size - data.length);
    }, error => { if (active) stations.fail(error); }));
    const rows = new Map<string,CounterOperation>();
    const invalid = new Set<string>();
    const changeTimes = new Map<string,number>();
    const update = (row: QueryDocumentSnapshot) => {
      if (row.metadata.hasPendingWrites) return;
      const received = row.get("receivedAt");
      if (received instanceof Timestamp) changeTimes.set(row.id,received.toMillis());
      const operation = decodeOperation(row.id,eventId,mode,row.get("payload"));
      if (operation) {rows.set(row.id,operation);invalid.delete(row.id);}
      else {rows.delete(row.id);invalid.add(row.id);}
    };
    cleanup.push(onSnapshot(collection(db,"events",eventId,"counterRuns",mode,"operations"), watch, snapshot => {
      if (!active) return;
      for (const change of snapshot.docChanges(watch)) {
        if (change.type === "removed") {
          rows.delete(change.doc.id);
          invalid.delete(change.doc.id);
          changeTimes.delete(change.doc.id);
        } else update(change.doc);
      }
      let lastChangeAt: number | undefined;
      for (const stamp of changeTimes.values()) if (lastChangeAt === undefined || stamp > lastChangeAt) lastChangeAt = stamp;
      operations.next([...rows.values()],snapshot.metadata,invalid.size,lastChangeAt);
    }, error => { if (active) operations.fail(error); }));
  })().catch(error => {
    for (const release of cleanup.splice(0)) release();
    failAll(error);
  });

  return () => {
    active = false;
    for (const release of cleanup.splice(0)) release();
  };
}

export async function saveCounterConfig(eventId: string, mode: CounterMode, config: CounterConfig,
  expected?: CounterConfig | null): Promise<void> {
  checkedScope(eventId, mode);
  const value = decodeConfig(config);
  if (!value) throw new Error("人数計測の運用設定が不正です。");
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const reference = doc(db,"events",eventId,"counterConfig",mode);
  await runTransaction(db, async transaction => {
    const snapshot = await transaction.get(reference);
    const current = decodeConfig(snapshot.data());
    if (snapshot.exists() && !current) throw new Error("サーバーの運用設定を読み直してください。");
    if (expected !== undefined && (expected?.opened !== current?.opened || expected?.closed !== current?.closed ||
      expected?.verified !== current?.verified)) throw new Error("別の管理端末で運用設定が変更されました。読み直してから保存してください。");
    transaction.set(reference,{...value,paused:current?.paused ?? value.paused,
      updatedAt:serverTimestamp(),updatedByUid:uid});
  });
}

export async function pauseCounterEvent(eventId: string, mode: CounterMode, paused: boolean): Promise<void> {
  checkedScope(eventId,mode);
  if (typeof paused !== "boolean") throw new Error("計測の停止状態が不正です。");
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const reference = doc(db,"events",eventId,"counterConfig",mode);
  await runTransaction(db, async transaction => {
    const current = await transaction.get(reference);
    if (!current.exists()) throw new Error("運用設定を先に保存してください。");
    transaction.update(reference,{paused,updatedAt:serverTimestamp(),updatedByUid:uid});
  });
}

export async function findCounterPair(eventId: string, code: string) {
  if (!isPathPart(eventId) || !/^[0-9]{6}$/.test(code)) throw new Error("6桁の接続コードを入力してください。");
  const uid=await getFirebaseUid(),db=getFirebaseDb();
  await setDoc(doc(db,"events",eventId,"counterPairAttempts",uid),{code,at:serverTimestamp()});
  let invitation;
  try {invitation=(await getDocFromServer(doc(db,"events",eventId,"counterPairCodes",code))).data();}
  catch (error) {
    if (!isRecord(error)||error.code!=="permission-denied") throw error;
    throw new Error("コードの期限が切れたか、すでに使用されています。端末で新しいコードを表示してください。");
  }
  if (!invitation || invitation.usedAt!=null || !isPathPart(invitation.uid)) throw new Error("有効な接続コードが見つかりません。端末の表示を確認してください。");
  const snapshot=await getDocFromServer(doc(db,"events",eventId,"counterDevices",invitation.uid));
  const station=snapshot.exists()?decodeStation(snapshot.id,snapshot.data()):null;
  if (!station || station.status!=="pending" || station.device!==invitation.device ||
    snapshot.get("pairingIssuedAt")?.isEqual(invitation.issuedAt)!==true)
    throw new Error("コードの期限が切れたか、すでに使用されています。端末でコードを確認してください。");
  return station;
}

type StationPatch = {status?: Exclude<CounterStationStatus,"pending">; name?: string; role?: CounterDirection};
export async function saveCounterStation(eventId: string, stationUid: string, patch: StationPatch, code?: string): Promise<void> {
  if (!isPathPart(eventId) || !isPathPart(stationUid)) throw new Error("対象端末を確認してください。");
  const update: StationPatch = {};
  if (patch.status !== undefined) {
    if (!isStatus(patch.status) || !["approved","rejected","revoked"].includes(patch.status)) throw new Error("端末の承認状態が不正です。");
    update.status = patch.status;
  }
  if (patch.role !== undefined) {
    if (!isDirection(patch.role)) throw new Error("端末の入口・出口区分が不正です。");
    update.role = patch.role;
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 80) throw new Error("端末名を80文字以内で入力してください。");
    update.name = name;
  }
  if (!Object.keys(update).length) return;
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const reference = doc(db,"events",eventId,"counterDevices",stationUid);
  await runTransaction(db, async transaction => {
    const station=(await transaction.get(reference)).data();
    const dedicated=(await transaction.get(doc(db,"counterDays",eventId))).exists();
    if (!station) throw new Error("端末の登録情報が見つかりません。");
    const pairing=code && /^[0-9]{6}$/.test(code) ? doc(db,"events",eventId,"counterPairCodes",code) : null;
    if (dedicated && station.status==="pending" && update.status==="approved" && !pairing)
      throw new Error("計測端末に表示された接続コードを確認してください。");
    const audit={updatedAt:serverTimestamp(),updatedByUid:uid};
    if (dedicated) {
      const role=update.role ?? station.role, status=update.status ?? station.status;
      const previous=station.status==="approved" ? station.role : null;
      const next=status==="approved" ? role : null;
      if (next) {
        const assignment=doc(db,"events",eventId,"counterAssignments",next);
        const occupant=(await transaction.get(assignment)).data()?.uid;
        if (occupant && occupant!==stationUid) throw new Error("この役割は別の端末が使用中です。現地で停止してから、管理者が割り当てを解除してください。");
        transaction.set(assignment,{uid:stationUid,...audit});
      }
      if (previous && previous!==next) transaction.set(doc(db,"events",eventId,"counterAssignments",previous),{uid:null,...audit});
    }
    if (pairing) transaction.update(pairing,{usedAt:serverTimestamp()});
    transaction.update(reference,{...update,...audit,...(pairing?{pairingConfirmed:code}:{})});
  });
}

function defined<T extends object>(payload: T): T {
  return Object.fromEntries(Object.entries(payload).filter(([,value]) => value !== undefined)) as T;
}

export async function appendCounterOperation(operation: CounterOperation): Promise<void> {
  const {id,eventId,mode} = operation;
  checkedScope(eventId,mode);
  const uid = await getFirebaseUid();
  const {synced: _synced,...data} = operation;
  const payload = defined({...data,actorUid:uid});
  if (!decodeOperation(id,eventId,mode,payload)) throw new Error("人数計測の通過記録が不正です。");
  const db = getFirebaseDb();
  const reference = doc(db,"events",eventId,"counterRuns",mode,"operations",id);
  await runTransaction(db, async transaction => {
    const current = await transaction.get(reference);
    if (current.exists()) throw new Error("同じIDの通過記録がすでに存在します。");
    if (operation.kind === "revision") {
      const path = (rowId: string) => doc(db,"events",eventId,"counterRuns",mode,"operations",rowId);
      const root = await transaction.get(path(operation.target));
      const recording = decodeOperation(root.id,eventId,mode,root.get("payload"));
      const parent = operation.parent === operation.target ? recording :
        decodeOperation(operation.parent,eventId,mode,(await transaction.get(path(operation.parent))).get("payload"));
      if (recording?.kind !== "passage" || !parent || (parent.kind === "revision" && parent.target !== operation.target)) {
        throw new Error("修正元の通過記録を読み直してください。");
      }
    }
    transaction.set(reference,{payload,receivedAt:serverTimestamp()});
  });
}

export async function addCounterPassage(eventId:string,mode:CounterMode,fields:CounterPassageFields,reason:string,device?:string): Promise<void> {
  const form = passageFields(fields);
  if (!form || form.invalid || !isReason(reason)) throw new Error("通過時刻と修正理由を確認してください。");
  await appendCounterOperation({...form,id:"ledger:" + crypto.randomUUID(),kind:"passage",eventId,mode,
    device:device || await getFirebaseUid(),rawAt:form.at,createdAt:Date.now(),station:form.direction,source:"manual",reason:reason.trim()});
}

export async function reviseCounterPassage(eventId:string,mode:CounterMode,record:EffectiveCounterPassage,
  fields:CounterPassageFields,reason:string,resolves:string[] = [],device?:string): Promise<void> {
  const before = passageFields(record), after = passageFields(fields);
  if (!before || !after || !isReason(reason) || resolves.length > 100 || !resolves.every(isOperationId) ||
      record.eventId !== eventId || record.mode !== mode) throw new Error("通過記録と修正理由を確認してください。");
  const now = Date.now();
  await appendCounterOperation({id:"edit:" + crypto.randomUUID(),kind:"revision",eventId,mode,
    device:device || await getFirebaseUid(),rawAt:now,createdAt:now,station:record.station ?? record.direction,
    target:record.originalId,parent:record.id,before,after,resolves:[...new Set(resolves)],reason:reason.trim()});
}
