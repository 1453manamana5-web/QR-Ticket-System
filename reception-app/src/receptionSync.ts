import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import type { ReceptionErrorLog } from "./localDb";
import { getPendingSyncItems } from "./localDb";
import { ensureFirebaseAuth, getFirebaseDb, getFirebaseUid } from "./firebaseClient";
import { collection, doc, getDoc, getDocFromServer, getDocsFromServer, getDocs, limit, query, runTransaction, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";



export async function syncReceptionErrorLog(log: ReceptionErrorLog): Promise<void> {
  await ensureFirebaseAuth();
  const terminalId = getTerminalIdForRegistration();
  if (log.terminalId !== terminalId) throw new Error("RECEPTION_TERMINAL_CHANGED");
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
            pendingApplication: terminalSnapshot.data().approved === false
              ? (await getDocs(query(collection(db, "terminalApplications"), where("requestedByUid", "==", uid), limit(5))))
                .docs.find(item => item.id === installation.terminalId && item.data().status === "pending")?.data() ?? null
              : null,
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
    if (terminal.approved === false && !state.pendingApplication) return null;
    const role = terminal.role;
    const managementOwner = terminal.approved === true && terminal.managementApproved === true &&
      (role === "management" || role === "both")
      ? await getDocFromServer(doc(getFirebaseDb(), "terminalOwners", state.terminalId!)) : null;
    const managementAllowed = managementOwner?.exists() === true &&
      managementOwner.data().enabled === true && managementOwner.data().ownerUid === await getFirebaseUid();
    const approved = terminal.approved === true && (managementAllowed ||
      (terminal.receptionApproved !== false && (role === "reception" || role === "both")));
    if (approved && state.terminalId) {
      localStorage.setItem("qr-ticket-terminal-id", state.terminalId);
      localStorage.setItem("qr-ticket-device-id", state.terminalId);
    }
    return {
      approved,
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

export async function resetReceptionTerminalRegistration(): Promise<string | null> {
  const current = await readOwnTerminalState();
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const applications = await getDocsFromServer(query(collection(db, "terminalApplications"), where("requestedByUid", "==", uid), limit(5)));
  const pending = applications.docs.find(item => item.data().status === "pending");
  if (!pending) {
    if (current.terminalId) throw new Error("RECEPTION_RELEASE_REQUIRES_MANAGEMENT_APPROVAL");
    return null;
  }
  const localTerminalId = pending.id;
  const applicationRef = doc(db, "terminalApplications", localTerminalId);
  await runTransaction(db, async tx => {
    const application = await tx.get(applicationRef);
    if (!application.exists() || application.data().requestedByUid !== uid ||
        application.data().status !== "pending") return;
    const terminalRef = doc(db, "terminals", localTerminalId);
    const terminal = await tx.get(terminalRef);
    if (terminal.exists()) {
      if (terminal.data().approved !== false || terminal.data().requestedByUid !== uid) {
        throw new Error("RECEPTION_RELEASE_REQUIRES_MANAGEMENT_APPROVAL");
      }
      if (current.terminalId === localTerminalId) {
        tx.update(terminalRef, {status: "offline", updatedAt: new Date().toISOString()});
      } else {
        tx.delete(terminalRef);
      }
    }
    tx.delete(applicationRef);
  });
  return current.terminalId;
}

export async function registerReceptionTerminal(name: string): Promise<void> {
  const terminalId = getTerminalIdForRegistration();
  const type = typeof navigator !== "undefined" && /Macintosh|Windows|Linux/i.test(navigator.userAgent)
    ? "Web / PC" : "Web / iPad";
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const state = await readOwnTerminalState();
  if (state.terminalId && state.terminal?.approved === false) {
    const id = state.terminalId;
    const now = new Date().toISOString();
    await runTransaction(db, async tx => {
      const terminalRef = doc(db, "terminals", id);
      const ownerRef = doc(db, "terminalOwners", id);
      const installationRef = doc(db, "terminalInstallations", uid);
      const [terminal, owner, installation] = await Promise.all([
        tx.get(terminalRef), tx.get(ownerRef), tx.get(installationRef),
      ]);
      const data = terminal.data();
      if (!data || data.approved !== false || data.receptionApproved !== false ||
          data.managementApproved !== false || data.role !== "reception" || data.requestedRole !== "reception" ||
          data.requestedByUid !== uid || data.admin === true || data.subAdmin === true ||
          !owner.exists() || owner.data().enabled !== true || owner.data().ownerUid !== uid ||
          !installation.exists() || installation.data().authUid !== uid ||
          installation.data().approved !== true || installation.data().terminalId !== id) {
        throw new Error("RECEPTION_REAPPLICATION_NOT_AUTHORIZED");
      }
      const application = {terminalId: id, requestedByUid: uid, requestedRole: "reception",
        name: name.trim() || "受付端末", type, status: "pending", requestedAt: now, updatedAt: now};
      tx.set(doc(db, "terminalApplications", id), application);
      tx.update(terminalRef, {name: application.name, type, status: "pending", requestedAt: now, updatedAt: now});
    });
    localStorage.setItem("qr-ticket-terminal-id", id);
    localStorage.setItem("qr-ticket-device-id", id);
    return;
  }
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

/** Release only reception-only permission before an event-specific reapplication.
 * Verified management owners keep their management installation and reauthenticate
 * the event locally instead of changing their management role.
 */
export async function requestReceptionEventReapproval(name: string): Promise<boolean> {
  const state = await readOwnTerminalState();
  if (!state.terminalId || !state.terminal) throw new Error("TERMINAL_NOT_FOUND");
  if (state.terminal.managementApproved === true) return false;
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const now = new Date().toISOString();
  await runTransaction(db, async tx => {
    const ref = doc(db, "terminals", state.terminalId!);
    const snapshot = await tx.get(ref);
    const data = snapshot.data();
    if (!data || data.role !== "reception" || data.managementApproved !== false || data.requestedByUid !== uid) {
      throw new Error("RECEPTION_REAPPLICATION_NOT_AUTHORIZED");
    }
    if (data.approved === false) return;
    tx.update(ref, {
      approved: false, receptionApproved: false,
      receptionApprovalVersion: (Number.isSafeInteger(data.receptionApprovalVersion) ? Number(data.receptionApprovalVersion) : 0) + 1,
      mode: "停止", desiredMode: "停止", desiredModeUpdatedAt: now,
      approvalUpdatedAt: now, approvalUpdatedByUid: uid, updatedAt: now,
    });
  });
  await registerReceptionTerminal(name);
  return true;
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
export async function syncReceptionRecord(record: ReceptionRecord, ticket?: Ticket): Promise<void> {
  await ensureFirebaseAuth();
  const terminalId = getTerminalIdForRegistration();
  if (record.terminalId !== terminalId) throw new Error("RECEPTION_TERMINAL_CHANGED");
  if (!record.recordId || !record.eventId || !record.ticketId ||
      (ticket && (record.ticketId !== ticket.ticketId || record.eventId !== ticket.eventId)) ||
      !["entry", "exit", "reentry"].includes(record.type) ||
      !Number.isFinite(Date.parse(record.timestamp))) {
    throw new Error("INVALID_RECEPTION_RECORD");
  }

  const db = getFirebaseDb();
  const ticketRef = doc(db, "events", record.eventId, "tickets", record.ticketId);
  const recordRef = doc(db, "events", record.eventId, "receptionRecords", record.recordId);
  const existingRecord = await getDocFromServer(recordRef);
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
  // writes to succeed atomically, including when another terminal changed it.
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

export async function getLatestReceptionTicket(eventId: string, ticketId: string): Promise<Ticket | null> {
  await ensureFirebaseAuth();
  const snapshot = await getDocFromServer(doc(getFirebaseDb(), "events", eventId, "tickets", ticketId));
  return snapshot.exists() ? snapshot.data() as Ticket : null;
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
