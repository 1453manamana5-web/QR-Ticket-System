import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";


export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const db = getFirebaseDb();
  const snapshot = await getDoc(doc(db, "terminals", getTerminalIdForRegistration()));
  if (!snapshot.exists()) return null;
  const data = snapshot.data();
  if (data.role !== "reception") return null;
  return {
    role: data.role === "reception" ? "reception" : data.role,\n    approved: data.approved === true,
    status: data.status === "online" || data.status === "offline" ? data.status : "pending",
    name: typeof data.name === "string" ? data.name : "受付端末",
  };
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const db = getFirebaseDb();
  const terminalId = getTerminalIdForRegistration();
  await setDoc(doc(db, "terminals", terminalId), {
    terminalId,
    name,
    type: "Web / iPad",
    role: "reception",
    mode: "停止",
    status: "pending",
    approved: false,
    lastSeen: new Date().toISOString(),
    networkMbps: null,
    battery: null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

export function subscribeTerminalRegistration(onChange: (value: {approved:boolean;status:"online"|"offline"|"pending";name:string}|null) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(doc(db, "terminals", getTerminalIdForRegistration()), snapshot => {
    if (!snapshot.exists() || snapshot.data()?.role !== "reception") { onChange(null); return; }
    const data = snapshot.data();
    onChange({
      approved: data.approved === true,
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

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped"): Promise<void> {
  const db = getFirebaseDb();
  const reference = doc(db, "terminals", terminalId);
  const existing = await getDoc(reference);
  const data = existing.exists() ? existing.data() : {};
  await setDoc(reference, {
    terminalId,
    name: typeof data.name === "string" ? data.name : `受付端末 ${terminalId.slice(-4)}`,
    type: "Web / iPad",
    mode: mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止",
    status: "online",
    approved: data.approved === true,
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
