import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { ensureFirebaseAuth, getFirebaseDb } from "./firebaseClient";
import { doc, runTransaction, serverTimestamp, setDoc } from "firebase/firestore";



export async function syncReceptionErrorLog(log: ReceptionErrorLog): Promise<void> {
  await ensureFirebaseAuth();
  const terminalId = getTerminalIdForRegistration();
  const db = getFirebaseDb();
  const errorRef = doc(db, "receptionErrors", log.errorId);
  await runTransaction(db, async transaction => {
    const existing = await transaction.get(errorRef);
    if (existing.exists()) {
      const saved = existing.data();
      const sameLog = saved.eventId === log.eventId &&
        saved.terminalId === terminalId &&
        saved.category === log.category &&
        saved.mode === log.mode &&
        saved.timestamp === log.timestamp;
      if (!sameLog) throw new Error("RECEPTION_ERROR_ID_COLLISION");
      return;
    }
    transaction.set(errorRef, {
      errorId: log.errorId,
      eventId: log.eventId,
      terminalId,
      category: log.category,
      mode: log.mode,
      timestamp: log.timestamp,
      receivedAt: serverTimestamp(),
    });
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
  const terminalId = getTerminalIdForRegistration();
  const current = await callBackend<Record<string, never>, { terminalId: string | null }>(
    "getTerminalInstallationStatus", {},
  );
  if (current.terminalId) {
    await callBackend<{ terminalId: string }, { released: boolean }>("releaseOwnReceptionRegistration", { terminalId });
    return;
  }
  await callBackend<{ terminalId: string }, { cancelled: boolean }>("cancelOwnTerminalApplication", { terminalId });
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
  if (existing && /^T-[A-Za-z0-9-]{8,40}$/.test(existing)) return existing;
  const id = "T-" + crypto.randomUUID().slice(0, 8).toUpperCase();
  localStorage.setItem(key, id);
  localStorage.setItem("qr-ticket-device-id", id);
  return id;
}
export async function syncReceptionRecord(record: ReceptionRecord, ticket: Ticket): Promise<void> {
  await ensureFirebaseAuth();
  const terminalId = getTerminalIdForRegistration();
  if (!record.recordId || !record.eventId || !record.ticketId ||
      record.ticketId !== ticket.ticketId || record.eventId !== ticket.eventId ||
      !["entry", "exit", "reentry"].includes(record.type) ||
      !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error("INVALID_RECEPTION_RECORD");
  }

  const db = getFirebaseDb();
  const eventRef = doc(db, "events", record.eventId);
  const ticketRef = doc(db, "events", record.eventId, "tickets", record.ticketId);
  const recordRef = doc(db, "events", record.eventId, "receptionRecords", record.recordId);
  await runTransaction(db, async transaction => {
    const [eventSnapshot, ticketSnapshot, recordSnapshot] = await Promise.all([
      transaction.get(eventRef),
      transaction.get(ticketRef),
      transaction.get(recordRef),
    ]);

    if (recordSnapshot.exists()) {
      const saved = recordSnapshot.data();
      const sameRecord = saved.eventId === record.eventId &&
        saved.ticketId === record.ticketId &&
        saved.terminalId === terminalId &&
        saved.type === record.type &&
        saved.timestamp === record.timestamp;
      if (!sameRecord) throw new Error("RECEPTION_RECORD_ID_COLLISION");
      return;
    }
    if (!eventSnapshot.exists() || eventSnapshot.data().receptionTarget !== true ||
        eventSnapshot.data().eventStatus === "finished") {
      throw new Error("RECEPTION_EVENT_NOT_ACTIVE");
    }
    if (!ticketSnapshot.exists()) throw new Error("RECEPTION_TICKET_NOT_FOUND");

    const currentTicket = ticketSnapshot.data();
    const allowed =
      (record.type === "entry" && currentTicket.currentStatus === "unused") ||
      (record.type === "reentry" && currentTicket.currentStatus === "exited") ||
      (record.type === "exit" && currentTicket.currentStatus === "inside");
    if (currentTicket.valid !== true || !allowed) {
      throw new Error("RECEPTION_TICKET_STATE_CONFLICT");
    }

    transaction.update(ticketRef, {
      currentStatus: record.type === "exit" ? "exited" : "inside",
      updatedAt: record.timestamp,
      lastReceptionRecordId: record.recordId,
    });
    transaction.set(recordRef, {
      recordId: record.recordId,
      eventId: record.eventId,
      ticketId: record.ticketId,
      terminalId,
      type: record.type,
      timestamp: record.timestamp,
    });
  });
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
