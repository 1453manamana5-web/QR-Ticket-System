import { doc, getDoc, onSnapshot, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";

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
