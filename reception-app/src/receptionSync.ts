import { doc, getDoc, getDocFromServer, onSnapshot, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getPendingSyncItems } from "./localDb";
import { getFirebaseDb } from "./firebaseClient";
import { getTerminalInstallationStatus, releaseOwnReceptionRegistration } from "./terminalHandoff";


export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const terminalId = getTerminalIdForRegistration();
  // A browser that completed handoff must re-validate its server-issued installation
  // record on every registration check, including after reload or app relaunch.
  if (localStorage.getItem("qr-ticket-terminal-handoff-verified") === "true") {
    const serverStatus = await getTerminalInstallationStatus();
    if (!serverStatus.approved || serverStatus.terminalId !== terminalId) return null;
  }
  const db = getFirebaseDb();
  const snapshot = await getDoc(doc(db, "terminals", terminalId));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  if (data.role !== "reception" && data.role !== "both") return null;
  return {
    approved: data.receptionApproved ?? data.approved === true,
    status: data.status === "online" || data.status === "offline" ? data.status : "pending",
    name: typeof data.name === "string" ? data.name : "受付端末",
  };
}

export async function resetReceptionTerminalRegistration(): Promise<void> {
  await releaseOwnReceptionRegistration(getTerminalIdForRegistration());
  localStorage.removeItem("qr-ticket-terminal-handoff-verified");
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const db = getFirebaseDb();
  const terminalId = getTerminalIdForRegistration();
  const reference = doc(db, "terminals", terminalId);
  const existing = await getDoc(reference);
  const data = existing.exists() ? existing.data() : {};
  const existingRole = data.role === "management" || data.role === "reception" || data.role === "both"
    ? data.role
    : "reception";
  const role = existingRole === "management" || existingRole === "both" ? "both" : "reception";
  // 受付を使うたびに、現在の端末状態に関係なく新しい承認申請として扱う。
  // 同じ端末・同じFirebaseアカウントでも、受付権限を自動で引き継がない。
  const receptionApproved = false;
  // 受付の承認待ち状態は管理端末側の承認状態と分離する。
  // 同じ端末が「管理＋受付」の両方を持つ場合、受付申請だけで管理画面を承認待ちにしない。
  const status = data.managementApproved === true
    ? (data.status === "online" || data.status === "offline" ? data.status : "offline")
    : ("pending" as const);

  await setDoc(reference, {
    terminalId,
    name: name.trim() || (typeof data.name === "string" ? data.name : "受付端末"),
    type: data.type === "Web / PC" ? "Web / PC" : "Web / iPad",
    role,
    mode: "停止" as const,
    status,
    approved: data.managementApproved === true,
    managementApproved: data.managementApproved === true,
    receptionApproved,
    lastSeen: new Date().toISOString(),
    networkMbps: typeof data.networkMbps === "number" ? data.networkMbps : null,
    battery: typeof data.battery === "number" ? data.battery : null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

export function subscribeTerminalRegistration(onChange: (value: {approved:boolean;status:"online"|"offline"|"pending";name:string}|null) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  let revision = 0;
  return onSnapshot(doc(db, "terminals", getTerminalIdForRegistration()), snapshot => {
    const currentRevision = ++revision;
    void (async () => {
      // Keep the live subscription consistent with the initial registration check.
      // This client-side marker is only a UX guard; Firestore Rules must enforce access.
      if (localStorage.getItem("qr-ticket-terminal-handoff-verified") === "true") {
        const serverStatus = await getTerminalInstallationStatus();
        if (currentRevision !== revision) return;
        if (!serverStatus.approved || serverStatus.terminalId !== getTerminalIdForRegistration()) {
          onChange(null);
          return;
        }
      }
      if (currentRevision !== revision) return;
      if (!snapshot.exists() || (snapshot.data()?.role !== "reception" && snapshot.data()?.role !== "both")) { onChange(null); return; }
      const data = snapshot.data();
      onChange({
        approved: data.receptionApproved ?? data.approved === true,
        status: data.status === "online" || data.status === "offline" ? data.status : "pending",
        name: typeof data.name === "string" ? data.name : "受付端末",
      });
    })().catch(onError);
  }, onError);
}

function getTerminalIdForRegistration(): string {
  const key = "qr-ticket-terminal-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = "T-" + crypto.randomUUID().slice(0,8).toUpperCase();
  localStorage.setItem(key,id);
  return id;
}

export async function syncReceptionRecord(record: ReceptionRecord, ticket: Ticket): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", record.eventId, "tickets", ticket.ticketId), ticket, { merge: true });
  await setDoc(doc(db, "events", record.eventId, "receptionRecords", record.recordId), record, { merge: true });
}

let networkSpeedCache: number | null = null;
let networkSpeedMeasuredAt = 0;
const NETWORK_SPEED_MEASURE_INTERVAL_MS = 30000;
const NETWORK_PROBE_SIZE_BYTES = 32768;

function getBrowserDownlink(): number | null {
  if (typeof navigator === "undefined") return null;

  const connection = (navigator as Navigator & {
    connection?: { downlink?: number };
    mozConnection?: { downlink?: number };
    webkitConnection?: { downlink?: number };
  }).connection
    ?? (navigator as Navigator & { mozConnection?: { downlink?: number } }).mozConnection
    ?? (navigator as Navigator & { webkitConnection?: { downlink?: number } }).webkitConnection;

  const downlink = connection?.downlink;
  return typeof downlink === "number" && Number.isFinite(downlink) && downlink > 0 ? downlink : null;
}

function createNetworkProbe(): string {
  return "0123456789abcdef".repeat(NETWORK_PROBE_SIZE_BYTES / 16);
}

async function measureNetworkSpeed(
  db: ReturnType<typeof getFirebaseDb>,
  reference: ReturnType<typeof doc>,
): Promise<number | null> {
  const now = Date.now();
  if (now - networkSpeedMeasuredAt < NETWORK_SPEED_MEASURE_INTERVAL_MS) {
    return networkSpeedCache;
  }

  const browserDownlink = getBrowserDownlink();
  if (browserDownlink !== null) {
    networkSpeedCache = browserDownlink;
    networkSpeedMeasuredAt = now;
    return browserDownlink;
  }

  try {
    const probe = createNetworkProbe();
    const startedAt = performance.now();
    await setDoc(reference, {
      networkProbe: probe,
      networkProbeAt: new Date().toISOString(),
    }, { merge: true });
    await getDocFromServer(reference);

    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const roundTripBytes = probe.length * 2;
    const measuredMbps = (roundTripBytes * 8) / (elapsedMs * 1000);
    const normalized = Math.max(0.1, Math.min(10000, measuredMbps));

    networkSpeedCache = normalized;
    networkSpeedMeasuredAt = Date.now();
    return normalized;
  } catch (reason) {
    console.warn("通信速度の測定に失敗しました", reason);
    return networkSpeedCache;
  }
}

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped", syncPendingCount?: number): Promise<number | null> {
  const db = getFirebaseDb();
  const pendingCount = typeof syncPendingCount === "number"
    ? syncPendingCount
    : (await getPendingSyncItems()).length;
  const reference = doc(db, "terminals", terminalId);
  const existing = await getDoc(reference);
  const data = existing.exists() ? existing.data() : {};
  const networkMbps = await measureNetworkSpeed(db, reference);

  await setDoc(reference, {
    terminalId,
    name: typeof data.name === "string" ? data.name : `受付端末 ${terminalId.slice(-4)}`,
    type: "Web / iPad",
    role: data.role === "management" || data.role === "both" ? data.role : "reception",
    mode: mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止",
    status: "online",
    approved: data.managementApproved === true || data.receptionApproved === true || data.approved === true,
    managementApproved: data.managementApproved === true,
    receptionApproved: data.receptionApproved === true,
    syncPendingCount: pendingCount,
    lastSeen: new Date().toISOString(),
    networkMbps: networkMbps ?? (typeof data.networkMbps === "number" ? data.networkMbps : null),
    battery: typeof data.battery === "number" ? data.battery : null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
  return networkMbps;
}

export function subscribeTerminalControl(terminalId: string, onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(doc(db, "terminals", terminalId), snapshot => {
    const value = snapshot.data()?.desiredMode;
    if (value === "入口受付" || value === "出口受付" || value === "停止") { const updatedAt = snapshot.data()?.desiredModeUpdatedAt; onMode(value, typeof updatedAt === "string" ? updatedAt : null); }
  }, onError);
}
