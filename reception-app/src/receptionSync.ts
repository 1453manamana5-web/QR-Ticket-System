import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { callBackend } from "./firebaseFunctions";



export async function syncReceptionErrorLog(log: ReceptionErrorLog): Promise<void> {
  await callBackend<{ log: Record<string, unknown> }, { saved: boolean }>("recordReceptionError", {
    log: { ...log, terminalId: getTerminalIdForRegistration() },
  });
}

export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const result = await callBackend<Record<string, never>, {
    approved: boolean; terminalId: string | null; name?: string; status?: "online"|"offline"|"pending";
    receptionApproved?: boolean; role?: string;
  }>("getTerminalInstallationStatus", {});
  if (!result.terminalId && !result.name) return null;
  return {
    approved: result.approved && result.receptionApproved !== false && (result.role === "reception" || result.role === "both"),
    status: result.status ?? "pending",
    name: result.name ?? "受付端末",
  };
}

export async function resetReceptionTerminalRegistration(): Promise<void> {
  await callBackend<{ terminalId: string }, { released: boolean }>("releaseOwnReceptionRegistration", {
    terminalId: getTerminalIdForRegistration(),
  });
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const terminalId = getTerminalIdForRegistration();
  const type = typeof navigator !== "undefined" && /Macintosh|Windows|Linux/i.test(navigator.userAgent)
    ? "Web / PC" : "Web / iPad";
  await callBackend<{ terminalId: string; name: string; type: string; role: string }, { applicationId: string }>(
    "registerTerminalApplication",
    { terminalId, name: name.trim() || "受付端末", type, role: "reception" },
  );
}

export function subscribeTerminalRegistration(onChange: (value: {approved:boolean;status:"online"|"offline"|"pending";name:string}|null) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const value = await getTerminalRegistration();
      if (active) onChange(value);
    } catch (error) {
      if (active) onError(error);
    } finally {
      if (active) timer = setTimeout(() => { void refresh(); }, 5000);
    }
  };
  void refresh();
  return () => { active = false; if (timer) clearTimeout(timer); };
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
  await callBackend<{ record: Record<string, unknown>; ticket: Record<string, unknown> }, { saved: boolean; recordId: string }>(
    "recordReception",
    { record: { ...record, terminalId: getTerminalIdForRegistration() }, ticket },
  );
}

function getBrowserDownlink(): number | null {
  if (typeof navigator === "undefined") return null;
  const connection = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  const value = connection?.downlink;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped", syncPendingCount?: number): Promise<number | null> {
  const pendingCount = typeof syncPendingCount === "number" ? syncPendingCount : (await getPendingSyncItems()).length;
  const networkMbps = getBrowserDownlink();
  await callBackend<{ terminalId: string; mode: string; syncPendingCount: number; networkMbps?: number }, { saved: boolean }>(
    "updateTerminalHeartbeat",
    { terminalId, mode: mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止",
      syncPendingCount: pendingCount, ...(networkMbps !== null ? { networkMbps } : {}) },
  );
  return networkMbps;
}

export function subscribeTerminalControl(terminalId: string, onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const value = await callBackend<Record<string, never>, {
        terminalId: string | null; desiredMode?: "入口受付" | "出口受付" | "停止" | null;
        desiredModeUpdatedAt?: string | null;
      }>("getTerminalInstallationStatus", {});
      if (active && value.terminalId === terminalId &&
          (value.desiredMode === "入口受付" || value.desiredMode === "出口受付" || value.desiredMode === "停止")) {
        onMode(value.desiredMode, value.desiredModeUpdatedAt ?? null);
      }
    } catch (error) {
      if (active) onError(error);
    } finally {
      if (active) timer = setTimeout(() => { void refresh(); }, 5000);
    }
  };
  void refresh();
  return () => { active = false; if (timer) clearTimeout(timer); };
}
