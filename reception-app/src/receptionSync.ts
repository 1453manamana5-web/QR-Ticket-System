import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { getTerminalInstallationStatus, releaseOwnReceptionRegistration, submitReceptionRecord } from "./terminalHandoff";


export async function syncReceptionErrorLog(log: ReceptionErrorLog): Promise<void> {
  const { submitReceptionError } = await import("./terminalHandoff");
  await submitReceptionError(log);
}

export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const terminalId = getTerminalIdForRegistration();
  const serverStatus = await getTerminalInstallationStatus();
  if (serverStatus.approved && serverStatus.terminalId === terminalId && serverStatus.receptionApproved === true && (serverStatus.role === "reception" || serverStatus.role === "both")) {
    localStorage.setItem("qr-ticket-terminal-handoff-verified", "true");
    return {
      approved: true,
      status: serverStatus.status ?? "offline",
      name: serverStatus.name ?? "受付端末",
    };
  }
  if (serverStatus.status === "pending" && serverStatus.name) {
    return { approved: false, status: "pending", name: serverStatus.name };
  }
  return null;
}

export async function resetReceptionTerminalRegistration(): Promise<void> {
  const serverStatus = await getTerminalInstallationStatus();
  if (serverStatus.approved && serverStatus.terminalId) {
    await releaseOwnReceptionRegistration(serverStatus.terminalId);
  }
  localStorage.removeItem("qr-ticket-terminal-handoff-verified");
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const terminalId = getTerminalIdForRegistration();
  const { registerTerminalApplication } = await import("./terminalHandoff");
  await registerTerminalApplication(
    terminalId,
    name.trim() || "受付端末",
    "Web / iPad",
    "reception",
  );
}

export function subscribeTerminalRegistration(onChange: (value: {approved:boolean;status:"online"|"offline"|"pending";name:string}|null) => void, onError: (error: unknown) => void): () => void {
  let cancelled = false;
  const refresh = async () => {
    try {
      const value = await getTerminalRegistration();
      if (!cancelled) onChange(value);
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

async function measureNetworkSpeed(): Promise<number | null> {
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
  const networkMbps = await measureNetworkSpeed();
  const { updateTerminalHeartbeat } = await import("./terminalHandoff");
  const modeLabel = mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止";
  await updateTerminalHeartbeat(terminalId, modeLabel, pendingCount, networkMbps);
  return networkMbps;
}

export function subscribeTerminalControl(
  terminalId: string,
  onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void,
  onError: (error: unknown) => void,
): () => void {
  // Strict Firestore rules deliberately prevent reception clients from reading
  // terminal documents. Read the desired mode only through the authenticated
  // server endpoint, even before the local verification marker is populated.
  let cancelled = false;
  let lastMode: string | null = null;
  let lastUpdatedAt: string | null = null;
  const refresh = async () => {
    try {
      const status = await getTerminalInstallationStatus();
      if (cancelled || !status.approved || status.terminalId !== terminalId) return;
      const mode = status.desiredMode;
      if (mode !== "入口受付" && mode !== "出口受付" && mode !== "停止") return;
      const updatedAt = status.desiredModeUpdatedAt ?? null;
      if (mode === lastMode && updatedAt === lastUpdatedAt) return;
      lastMode = mode;
      lastUpdatedAt = updatedAt;
      onMode(mode, updatedAt);
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
