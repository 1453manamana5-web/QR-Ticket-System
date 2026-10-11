import { doc, getDoc, getDocFromServer, onSnapshot } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getPendingSyncItems } from "./localDb";
import { getFirebaseDb } from "./firebaseClient";
import { getTerminalInstallationStatus, releaseOwnReceptionRegistration, submitReceptionRecord } from "./terminalHandoff";


export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const terminalId = getTerminalIdForRegistration();
  // A browser that completed handoff must re-validate its server-issued installation
  // record on every registration check, including after reload or app relaunch.
  if (localStorage.getItem("qr-ticket-terminal-handoff-verified") === "true") {
    const serverStatus = await getTerminalInstallationStatus();
    if (!serverStatus.approved || serverStatus.terminalId !== terminalId) return null;
    return {
      approved: true,
      status: serverStatus.status ?? "offline",
      name: serverStatus.name ?? "受付端末",
    };
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
  const terminalId = getTerminalIdForRegistration();
  // 受付申請はサーバー側で未承認状態として登録する。
  // 既存の管理権限・承認フラグをブラウザから変更しない。
  const { registerTerminalApplication } = await import("./terminalHandoff");
  await registerTerminalApplication(
    terminalId,
    name.trim() || "受付端末",
    "Web / iPad",
    "reception",
  );
}

export function subscribeTerminalRegistration(onChange: (value: {approved:boolean;status:"online"|"offline"|"pending";name:string}|null) => void, onError: (error: unknown) => void): () => void {
  if (localStorage.getItem("qr-ticket-terminal-handoff-verified") === "true") {
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await getTerminalInstallationStatus();
        if (cancelled) return;
        if (!status.approved || status.terminalId !== getTerminalIdForRegistration()) {
          onChange(null);
          return;
        }
        onChange({
          approved: true,
          status: status.status ?? "offline",
          name: status.name ?? "受付端末",
        });
      } catch (error) {
        if (!cancelled) onError(error);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }
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
  if (ticket.ticketId !== record.ticketId || ticket.eventId !== record.eventId) {
    throw new Error("受付記録とチケットの情報が一致しません。");
  }
  // Ticket state is recomputed and validated on the server; never trust the client copy.
  await submitReceptionRecord(record);
}

let networkSpeedCache: number | null = null;
let networkSpeedMeasuredAt = 0;
const NETWORK_SPEED_MEASURE_INTERVAL_MS = 30000;

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

async function measureNetworkSpeed(
  _db: ReturnType<typeof getFirebaseDb>,
  _reference: ReturnType<typeof doc>,
): Promise<number | null> {
  const now = Date.now();
  if (now - networkSpeedMeasuredAt < NETWORK_SPEED_MEASURE_INTERVAL_MS) return networkSpeedCache;
  // Do not write probe payloads into the terminal document. Use browser-provided
  // estimates where available; otherwise keep the value unknown.
  const browserDownlink = getBrowserDownlink();
  networkSpeedCache = browserDownlink;
  networkSpeedMeasuredAt = now;
  return browserDownlink;
}

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped", syncPendingCount?: number): Promise<number | null> {
  const pendingCount = typeof syncPendingCount === "number"
    ? syncPendingCount
    : (await getPendingSyncItems()).length;
  const db = getFirebaseDb();
  const reference = doc(db, "terminals", terminalId);
  const networkMbps = await measureNetworkSpeed(db, reference);
  const { updateTerminalHeartbeat } = await import("./terminalHandoff");
  const modeLabel = mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止";
  await updateTerminalHeartbeat(terminalId, modeLabel, pendingCount, networkMbps);
  return networkMbps;
}

export function subscribeTerminalControl(terminalId: string, onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void, onError: (error: unknown) => void): () => void {
  if (localStorage.getItem("qr-ticket-terminal-handoff-verified") === "true") {
    let cancelled = false;
    const refresh = async () => {
      try {
        const status = await getTerminalInstallationStatus();
        if (cancelled || !status.approved || status.terminalId !== terminalId) return;
        const value = status.desiredMode;
        if (value === "入口受付" || value === "出口受付" || value === "停止") {
          onMode(value, status.desiredModeUpdatedAt ?? null);
        }
      } catch (error) {
        if (!cancelled) onError(error);
      }
    };
    void refresh();
    const interval = window.setInterval(() => void refresh(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }
  const db = getFirebaseDb();
  return onSnapshot(doc(db, "terminals", terminalId), snapshot => {
    const value = snapshot.data()?.desiredMode;
    if (value === "入口受付" || value === "出口受付" || value === "停止") { const updatedAt = snapshot.data()?.desiredModeUpdatedAt; onMode(value, typeof updatedAt === "string" ? updatedAt : null); }
  }, onError);
}
