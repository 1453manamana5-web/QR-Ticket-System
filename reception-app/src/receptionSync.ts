import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { ensureFirebaseAuth, getFirebaseDb, getFirebaseUid } from "./firebaseClient";
import { collection, doc, getDoc, getDocs, limit, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";



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

type OwnTerminalState = {
  terminalId: string | null;
  terminal: Record<string, unknown> | null;
  pendingApplication: Record<string, unknown> | null;
};

async function readOwnTerminalState(): Promise<OwnTerminalState> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const installationSnapshot = await getDoc(doc(db, "terminalInstallations", uid));
  if (installationSnapshot.exists()) {
    const installation = installationSnapshot.data();
    if (installation.authUid === uid && installation.approved === true &&
        typeof installation.terminalId === "string") {
      try {
        const terminalSnapshot = await getDoc(doc(db, "terminals", installation.terminalId));
        if (terminalSnapshot.exists()) {
          return {
            terminalId: installation.terminalId,
            terminal: terminalSnapshot.data(),
            pendingApplication: null,
          };
        }
      } catch (error) {
        // A disabled owner tombstone or revoked terminal must fail closed.
        if (!(typeof error === "object" && error !== null &&
            "code" in error && (error as { code?: string }).code === "permission-denied")) {
          throw error;
        }
      }
    }
  }

  const applicationSnapshot = await getDocs(query(
    collection(db, "terminalApplications"),
    where("requestedByUid", "==", uid),
    limit(5),
  ));
  const pending = applicationSnapshot.docs.find(item => item.data().status === "pending");
  return {
    terminalId: null,
    terminal: null,
    pendingApplication: pending ? pending.data() as Record<string, unknown> : null,
  };
}

export async function getTerminalRegistration(): Promise<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null> {
  const state = await readOwnTerminalState();
  if (state.terminal) {
    const terminal = state.terminal;
    const role = terminal.role;
    return {
      approved: terminal.approved === true &&
        terminal.receptionApproved !== false &&
        (role === "reception" || role === "both"),
      status: terminal.status === "online" || terminal.status === "offline" ? terminal.status : "pending",
      name: typeof terminal.name === "string" ? terminal.name : "受付端末",
    };
  }
  if (state.pendingApplication) {
    return {
      approved: false,
      status: "pending",
      name: typeof state.pendingApplication.name === "string" ? state.pendingApplication.name : "受付端末",
    };
  }
  return null;
}

export async function resetReceptionTerminalRegistration(): Promise<void> {
  const localTerminalId = getTerminalIdForRegistration();
  const current = await readOwnTerminalState();
  if (current.terminalId) {
    throw new Error("RECEPTION_RELEASE_REQUIRES_MANAGEMENT_APPROVAL");
  }
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const applicationRef = doc(db, "terminalApplications", localTerminalId);
  const application = await getDoc(applicationRef);
  if (application.exists() && application.data().requestedByUid === uid &&
      application.data().status === "pending") {
    await import("firebase/firestore").then(({ deleteDoc }) => deleteDoc(applicationRef));
  }
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const terminalId = getTerminalIdForRegistration();
  const type = typeof navigator !== "undefined" && /Macintosh|Windows|Linux/i.test(navigator.userAgent)
    ? "Web / PC" : "Web / iPad";
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const existing = await getDocs(query(
    collection(db, "terminalApplications"),
    where("requestedByUid", "==", uid),
    limit(5),
  ));
  if (existing.docs.some(item => item.data().status === "pending")) {
    throw new Error("TERMINAL_APPLICATION_ALREADY_PENDING");
  }
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.set(doc(db, "terminalApplications", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: "reception",
    name: name.trim() || "受付端末", type, status: "pending",
    requestedAt: now, updatedAt: now,
  });
  batch.set(doc(db, "terminals", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: "reception",
    name: name.trim() || "受付端末", type, role: "reception",
    approved: false, managementApproved: false, receptionApproved: false,
    admin: false, subAdmin: false, status: "pending",
    mode: "停止", desiredMode: "停止", requestedAt: now, updatedAt: now,
    syncPendingCount: 0,
  });
  await batch.commit();
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
  const ticketRef = doc(db, "events", record.eventId, "tickets", record.ticketId);
  const recordRef = doc(db, "events", record.eventId, "receptionRecords", record.recordId);
  const existingRecord = await getDoc(recordRef);
  if (existingRecord.exists()) {
    const saved = existingRecord.data();
    const sameRecord = saved.eventId === record.eventId &&
      saved.ticketId === record.ticketId &&
      saved.terminalId === terminalId &&
      saved.type === record.type &&
      saved.timestamp === record.timestamp;
    if (!sameRecord) throw new Error("RECEPTION_RECORD_ID_COLLISION");
    return;
  }

  // Rules validate the current server-side ticket state and require these two
  // writes to succeed atomically. Reception never reads the raw ticket document.
  const batch = writeBatch(db);
  batch.update(ticketRef, {
    currentStatus: record.type === "exit" ? "exited" : "inside",
    updatedAt: record.timestamp,
    lastReceptionRecordId: record.recordId,
  });
  batch.set(recordRef, {
    recordId: record.recordId,
    eventId: record.eventId,
    ticketId: record.ticketId,
    terminalId,
    type: record.type,
    timestamp: record.timestamp,
  });
  await batch.commit();
}

function getBrowserDownlink(): number | null {
  if (typeof navigator === "undefined") return null;
  const connection = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  const value = connection?.downlink;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export async function saveTerminalHeartbeat(terminalId: string, mode: "entry" | "exit" | "stopped", syncPendingCount?: number): Promise<number | null> {
  await ensureFirebaseAuth();
  const pendingCount = typeof syncPendingCount === "number" ? syncPendingCount : (await getPendingSyncItems()).length;
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0 || pendingCount > 100000) {
    throw new Error("INVALID_PENDING_SYNC_COUNT");
  }
  const networkMbps = getBrowserDownlink();
  const db = getFirebaseDb();
  const timestamp = new Date().toISOString();
  const terminalRef = doc(db, "terminals", terminalId);
  await updateDoc(terminalRef, {
    status: "online",
    lastSeen: timestamp,
    updatedAt: timestamp,
    syncPendingCount: pendingCount,
    ...(networkMbps !== null ? { networkMbps } : {}),
  });

  // Only the owning, management-approved installation may update the stored
  // operating mode. Handed-off reception installations are intentionally denied.
  try {
    await updateDoc(terminalRef, {
      mode: mode === "entry" ? "入口受付" : mode === "exit" ? "出口受付" : "停止",
      updatedAt: timestamp,
    });
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: string }).code : undefined;
    if (code !== "permission-denied") throw error;
  }
  return networkMbps;
}

export function subscribeTerminalControl(terminalId: string, onMode: (mode: "入口受付" | "出口受付" | "停止", updatedAt: string | null) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const state = await readOwnTerminalState();
      const terminal = state.terminal;
      const desiredMode = terminal?.desiredMode;
      if (active && state.terminalId === terminalId &&
          (desiredMode === "入口受付" || desiredMode === "出口受付" || desiredMode === "停止")) {
        onMode(desiredMode, typeof terminal?.desiredModeUpdatedAt === "string" ? terminal.desiredModeUpdatedAt : null);
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
