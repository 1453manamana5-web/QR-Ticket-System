import { deleteDoc, doc, getDoc, getDocFromServer, onSnapshot, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { getFirebaseDb } from "./firebaseClient";
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
export async function syncReceptionRecord(record: ReceptionRecord, _ticket: Ticket): Promise<void> {
  await callBackend<{ record: Record<string, unknown> }, { saved: boolean; recordId: string }>(
    "recordReception",
    { record: { ...record, terminalId: getTerminalIdForRegistration() } },
  );
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
