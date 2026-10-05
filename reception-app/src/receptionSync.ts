import { deleteDoc, doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getPendingSyncItems } from "./localDb";
import { getFirebaseDb } from "./firebaseClient";


export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const db = getFirebaseDb();
  const snapshot = await getDoc(doc(db, "terminals", getTerminalIdForRegistration()));
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
  const db = getFirebaseDb();
  await deleteDoc(doc(db, "terminals", getTerminalIdForRegistration()));
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
  const receptionApproved = data.receptionApproved ?? (data.role === "reception" || data.role === "both" ? data.approved === true : false);
  const status = data.status === "online" || data.status === "offline" || data.status === "pending"
    ? data.status
    : "pending";

  await setDoc(reference, {
    terminalId,
    name: name.trim() || (typeof data.name === "string" ? data.name : "受付端末"),
    type: data.type === "Web / PC" ? "Web / PC" : "Web / iPad",
    role,
    mode: data.mode === "入口受付" || data.mode === "出口受付" || data.mode === "停止" ? data.mode : "停止",
    status,
    approved: data.managementApproved === true || receptionApproved,
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
  return onSnapshot(doc(db, "terminals", getTerminalIdForRegistration()), snapshot => {
    if (!snapshot.exists() || (snapshot.data()?.role !== "reception" && snapshot.data()?.role !== "both")) { onChange(null); return; }
    const data = snapshot.data();
    onChange({
      approved: data.receptionApproved ?? data.approved === true,
      status: data.status === "online" || data.status === "offline" ? data.status : "pending",
      name: typeof data.name === "string" ? data.name : "受付端末",
    });
  }, onError);
}

function getTerminalIdForRegistration(): string {
  const key = "qr-ticket-terminal-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = "T-" + crypto.randomUUID().slice(0,8).toUpperCase();
  localStorage.setItem(key, id);
  return id;
}

export async function syncReceptionRecord(record: ReceptionRecord, ticket: Ticket): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", record.eventId, "tickets", ticket.ticketId), ticket, { merge: true });
  await setDoc(doc(db, "events", record.eventId, "receptionRecords", record.recordId), record, { merge: true });
}

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped", syncPendingCount?: number): Promise<void> {
  const db = getFirebaseDb();
  const pendingCount = typeof syncPendingCount === "number"
    ? syncPendingCount
    : (await getPendingSyncItems()).length;
  const reference = doc(db, "terminals", terminalId);
  const existing = await getDoc(reference);
  const data = existing.exists() ? existing.data() : {};
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
    networkMbps: typeof data.networkMbps === "number" ? data.networkMbps : null,
    battery: typeof data.battery === "number" ? data.battery : null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

export function subscribeTerminalControl(terminalId: string, onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(doc(db, "terminals", terminalId), snapshot => {
    const value = snapshot.data()?.desiredMode;
    if (value === "入口受付" || value === "出口受付" || value === "停止") { const updatedAt = snapshot.data()?.desiredModeUpdatedAt; onMode(value, typeof updatedAt === "string" ? updatedAt : null); }
  }, onError);
}
