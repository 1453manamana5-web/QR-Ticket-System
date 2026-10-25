import { collection, doc, getDoc, getDocs, getDocsFromServer, getDocFromServer, limit, onSnapshot, query, runTransaction, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import type { Event, ReceptionRecord, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { ensureFirebaseAuth, getFirebaseDb, getFirebaseUid } from "./firebaseClient";

export type MemberRecord = { memberId: string; memberNumber: number; name: string; };
export type TerminalRecord = { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; mode: "入口受付" | "出口受付" | "停止"; desiredMode?: "入口受付" | "出口受付" | "停止"; desiredModeUpdatedAt?: string; status: "online" | "offline" | "pending"; approved: boolean; lastSeen: string | null; networkMbps: number | null; battery: number | null; role?: "management" | "reception" | "both"; admin?: boolean; subAdmin?: boolean; managementApproved?: boolean; receptionApproved?: boolean; syncPendingCount?: number; };
export type AnalysisRecord = { eventId: string; eventName: string; eventDate: string; total: number; unused: number; inside: number; exited: number; savedAt: string; };

export async function deleteEvent(eventId: string): Promise<void> {
  const db = getFirebaseDb();
  const { deleteDoc } = await import("firebase/firestore");
  const eventRef = doc(db, "events", eventId);

  // 削除対象のイベントと公開バンドル参照を先にサーバーから確認する。
  const eventSnapshot = await getDocFromServer(eventRef);
  const authToken = eventSnapshot.exists() && typeof eventSnapshot.data().authToken === "string"
    ? eventSnapshot.data().authToken as string
    : "";
  const publishedBundles = await getDocsFromServer(query(
    collection(db, "eventBundles"), where("event.eventId", "==", eventId),
  ));

  // 親ドキュメントの削除だけではサブコレクションは消えない。
  // 大量チケットでも安定して削除できるよう、Firestoreのバッチ上限より少ない件数で分割する。
  const subcollections = ["tickets", "receptionRecords", "analysis", "members", "settings"] as const;
  for (const subcollection of subcollections) {
    const snapshot = await getDocsFromServer(collection(db, "events", eventId, subcollection));
    for (let start = 0; start < snapshot.docs.length; start += 450) {
      const batch = writeBatch(db);
      for (const item of snapshot.docs.slice(start, start + 450)) {
        batch.delete(item.ref);
      }
      await batch.commit();
    }
  }

  // 公開バンドルを先に削除し、失敗した場合にイベント本体を残して再試行できるようにする。
  const bundleRefs = new Map(publishedBundles.docs.map(item => [item.id, item.ref]));
  if (authToken) bundleRefs.set(authToken, doc(db, "eventBundles", authToken));
  const refs = [...bundleRefs.values()];
  for (let start = 0; start < refs.length; start += 450) {
    const batch = writeBatch(db);
    for (const ref of refs.slice(start, start + 450)) batch.delete(ref);
    await batch.commit();
  }
  await deleteDoc(eventRef);
}
export async function saveEvent(event: Event): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", event.eventId), { ...event, updatedAt: new Date().toISOString() }, { merge: true });
}

export function subscribeEvents(onChange: (events: Event[]) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(collection(db, "events"), snapshot => {
    const events = snapshot.docs.map(item => item.data() as Event).filter(item => typeof item.eventId === "string");
    onChange(events.sort((a, b) => (b.eventDate + "T" + b.startTime).localeCompare(a.eventDate + "T" + a.startTime)));
  }, onError);
}

async function syncPublishedTicketInventory(eventId: string, tickets: Ticket[]): Promise<void> {
  const db = getFirebaseDb();
  const eventRef = doc(db, "events", eventId);
  await runTransaction(db, async tx => {
    const eventSnapshot = await tx.get(eventRef);
    if (!eventSnapshot.exists()) throw new Error("EVENT_NOT_FOUND");
    const eventData = eventSnapshot.data();
    const authToken = typeof eventData.authToken === "string" ? eventData.authToken : "";
    const bundleRef = authToken ? doc(db, "eventBundles", authToken) : null;
    const bundleSnapshot = bundleRef ? await tx.get(bundleRef) : null;
    const savedBundle = bundleSnapshot?.exists() ? bundleSnapshot.data() : null;
    const now = new Date().toISOString();
    const nextDataVersion = Math.max(1, Number(eventData.dataVersion) || 1) + (savedBundle ? 1 : 0);
    tx.set(eventRef, {
      ticketCount: tickets.length,
      ...(savedBundle ? { dataVersion: nextDataVersion } : {}),
      updatedAt: now,
    }, { merge: true });
    if (bundleRef && savedBundle) {
      tx.set(bundleRef, {
        event: {
          ...((savedBundle.event as Record<string, unknown> | undefined) ?? {}),
          eventId, dataVersion: nextDataVersion,
        },
        ticketCount: tickets.length, publishedAt: now,
      }, { merge: true });
    }
  });
}

export async function saveTickets(eventId: string, tickets: Ticket[]): Promise<void> {
  const db = getFirebaseDb();
  // この関数は一覧全体の保存として扱い、一覧から消えた古いドキュメントも同期する。
  // 既存データをサーバーから取得してから更新し、オフラインキャッシュで削除対象を誤判定しない。
  const existingSnapshot = await getDocsFromServer(collection(db, "events", eventId, "tickets"));
  const desiredIds = new Set<string>();
  for (const ticket of tickets) {
    if (!ticket.ticketId || desiredIds.has(ticket.ticketId)) {
      throw new Error("INVALID_OR_DUPLICATE_TICKET_ID");
    }
    if (ticket.eventId !== eventId) {
      throw new Error("TICKET_EVENT_ID_MISMATCH");
    }
    desiredIds.add(ticket.ticketId);
  }

  const writes: Array<{ kind: "delete"; ref: ReturnType<typeof doc> } | { kind: "set"; ref: ReturnType<typeof doc>; ticket: Ticket }> = [];
  for (const existing of existingSnapshot.docs) {
    if (!desiredIds.has(existing.id)) writes.push({ kind: "delete", ref: existing.ref });
  }
  for (const ticket of tickets) {
    writes.push({
      kind: "set",
      ref: doc(db, "events", eventId, "tickets", ticket.ticketId),
      ticket,
    });
  }

  // Firestoreの1バッチ上限より少ない件数で削除・更新を分割する。
  for (let start = 0; start < writes.length; start += 450) {
    const batch = writeBatch(db);
    for (const write of writes.slice(start, start + 450)) {
      if (write.kind === "delete") batch.delete(write.ref);
      else batch.set(write.ref, write.ticket);
    }
    await batch.commit();
  }
  await syncPublishedTicketInventory(eventId, tickets);
}

export async function saveTicket(eventId: string, ticket: Ticket): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", eventId, "tickets", ticket.ticketId), ticket, { merge: true });
  // 1枚の変更でも公開データ版数を更新し、受付端末が再ダウンロードできるようにする。
  const currentTickets = await loadEventTickets(eventId);
  await syncPublishedTicketInventory(eventId, currentTickets);
}

export async function deleteTicket(eventId: string, ticketId: string): Promise<void> {
  const db = getFirebaseDb();
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "events", eventId, "tickets", ticketId));
  const remainingTickets = await loadEventTickets(eventId);
  await syncPublishedTicketInventory(eventId, remainingTickets);
}

export function subscribeTickets(eventId: string, onChange: (tickets: Ticket[]) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(collection(db, "events", eventId, "tickets"), snapshot => onChange(snapshot.docs.map(item => item.data() as Ticket)), onError);
}

export function subscribeReceptionRecords(eventId: string, onChange: (records: ReceptionRecord[]) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(
    collection(db, "events", eventId, "receptionRecords"),
    snapshot => onChange(snapshot.docs.map(item => item.data() as ReceptionRecord)),
    onError
  );
}

export async function saveAnalysis(record: AnalysisRecord): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", record.eventId, "analysis", record.eventId), record, { merge: true });
}

export async function saveMember(eventId: string, member: MemberRecord): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", eventId, "members", member.memberId), member, { merge: true });
}
export async function deleteMember(eventId: string, memberId: string): Promise<void> {
  const db = getFirebaseDb();
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "events", eventId, "members", memberId));
}
export async function saveMembers(eventId: string, members: MemberRecord[]): Promise<void> {
  const db = getFirebaseDb();
  await Promise.all(members.map(member => setDoc(doc(db, "events", eventId, "members", member.memberId), member, { merge: true })));
}

export async function deleteTerminal(terminalId: string): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const managerTerminalId = getManagerTerminalId();
  if (!managerTerminalId || terminalId === managerTerminalId) throw new Error("OWN_TERMINAL_DELETE_BLOCKED");
  const db = getFirebaseDb();
  const now = new Date().toISOString();

  await runTransaction(db, async (tx) => {
    const managerRef = doc(db, "terminals", managerTerminalId);
    const managerOwnerRef = doc(db, "terminalOwners", managerTerminalId);
    const managerInstallationRef = doc(db, "terminalInstallations", uid);
    const targetRef = doc(db, "terminals", terminalId);
    const targetOwnerRef = doc(db, "terminalOwners", terminalId);
    const applicationRef = doc(db, "terminalApplications", terminalId);
    const [manager, managerOwner, managerInstallation, target, targetOwner, application] = await Promise.all([
      tx.get(managerRef), tx.get(managerOwnerRef), tx.get(managerInstallationRef),
      tx.get(targetRef), tx.get(targetOwnerRef), tx.get(applicationRef),
    ]);
    if (!manager.exists() || !managerOwner.exists() || !managerInstallation.exists() ||
        managerOwner.data().ownerUid !== uid || managerOwner.data().enabled !== true ||
        managerInstallation.data().authUid !== uid || managerInstallation.data().terminalId !== managerTerminalId ||
        managerInstallation.data().approved !== true || manager.data().approved !== true ||
        manager.data().managementApproved !== true ||
        !["management", "both"].includes(String(manager.data().role)) ||
        (manager.data().admin !== true && manager.data().subAdmin !== true)) {
      throw new Error("MANAGEMENT_PERMISSION_REQUIRED");
    }
    if (!target.exists()) return;
    const td = target.data();
    if (td.admin === true || td.subAdmin === true) throw new Error("ADMIN_TERMINAL_DELETE_BLOCKED");
    if (manager.data().admin !== true && ["management", "both"].includes(String(td.role))) {
      throw new Error("SUBADMIN_CANNOT_DELETE_MANAGEMENT_TERMINAL");
    }
    const ownerData = targetOwner.exists() ? targetOwner.data() : {};
    const ownerUid = typeof ownerData.ownerUid === "string" ? ownerData.ownerUid :
      (typeof td.requestedByUid === "string" ? td.requestedByUid : "");
    if (targetOwner.exists() && (ownerData.enabled !== true || (ownerUid && ownerData.ownerUid !== ownerUid))) {
      throw new Error("TERMINAL_OWNER_TOMBSTONE_BLOCKS_REUSE");
    }
    tx.delete(targetRef);
    tx.set(targetOwnerRef, {
      terminalId, ...(ownerUid ? { ownerUid } : {}), enabled: false,
      deletedAt: now, deletedByUid: uid, updatedAt: now,
    }, { merge: true });
    if (application.exists()) tx.delete(applicationRef);
  });
}

function getManagerTerminalId(): string {
  return localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
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
  const installationSnapshot = await getDocFromServer(doc(db, "terminalInstallations", uid));
  if (installationSnapshot.exists()) {
    const grant = installationSnapshot.data();
    if (grant.authUid === uid && grant.approved === true &&
        typeof grant.terminalId === "string") {
      const terminalSnapshot = await getDocFromServer(doc(db, "terminals", grant.terminalId));
      if (terminalSnapshot.exists()) {
        return {
          terminalId: grant.terminalId,
          terminal: terminalSnapshot.data(),
          pendingApplication: null,
        };
      }
    }
  }

  const applications = await getDocsFromServer(query(
    collection(db, "terminalApplications"),
    where("requestedByUid", "==", uid),
    limit(5),
  ));
  const pending = applications.docs.find(item => item.data().status === "pending");
  return {
    terminalId: null,
    terminal: null,
    pendingApplication: pending ? pending.data() as Record<string, unknown> : null,
  };
}

export async function getOwnTerminalStatus(): Promise<{
  approved: boolean; terminalId: string | null; name?: string; status?: "online" | "offline" | "pending";
  role?: "management" | "reception" | "both" | null; managementApproved?: boolean; receptionApproved?: boolean;
}> {
  const state = await readOwnTerminalState();
  if (state.terminal && state.terminalId) {
    const terminal = state.terminal;
    const role = terminal.role;
    return {
      approved: terminal.approved === true,
      terminalId: state.terminalId,
      name: typeof terminal.name === "string" ? terminal.name : "管理端末",
      status: terminal.status === "online" || terminal.status === "offline" ? terminal.status : "pending",
      role: role === "management" || role === "reception" || role === "both" ? role : null,
      managementApproved: terminal.managementApproved === true ||
        (terminal.managementApproved === undefined && terminal.approved === true && (role === "management" || role === "both")),
      receptionApproved: terminal.receptionApproved === true ||
        (terminal.receptionApproved === undefined && terminal.approved === true && (role === "reception" || role === "both")),
    };
  }
  if (state.pendingApplication) {
    const application = state.pendingApplication;
    const role = application.requestedRole;
    return {
      approved: false,
      terminalId: null,
      name: typeof application.name === "string" ? application.name : "端末",
      status: "pending",
      role: role === "management" || role === "reception" || role === "both" ? role : null,
      managementApproved: false,
      receptionApproved: false,
    };
  }
  return { approved: false, terminalId: null };
}
export async function requestTerminalRegistration(input: { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; role: "management" | "reception" | "both" }): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const db = getFirebaseDb();
  const terminalId = input.terminalId.trim();
  const name = input.name.trim();
  if (!/^T-[A-Za-z0-9-]{8,40}$/.test(terminalId) || !name || name.length > 80) {
    throw new Error("INVALID_TERMINAL_APPLICATION");
  }
  const existing = await getDocs(query(collection(db, "terminalApplications"), where("requestedByUid", "==", uid), limit(5)));
  if (existing.docs.some(item => item.data().status === "pending")) throw new Error("TERMINAL_APPLICATION_ALREADY_PENDING");
  const now = new Date().toISOString();
  const batch = writeBatch(db);
  batch.set(doc(db, "terminalApplications", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: input.role, name, type: input.type,
    status: "pending", requestedAt: now, updatedAt: now,
  });
  batch.set(doc(db, "terminals", terminalId), {
    terminalId, requestedByUid: uid, requestedRole: input.role, name, type: input.type,
    role: input.role, approved: false, managementApproved: false, receptionApproved: false,
    admin: false, subAdmin: false, status: "pending", mode: "停止",
    desiredMode: "停止", requestedAt: now, updatedAt: now, syncPendingCount: 0,
  });
  await batch.commit();
}

export async function approveTerminal(targetTerminalId: string): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const managerTerminalId = getManagerTerminalId();
  if (!managerTerminalId || managerTerminalId === targetTerminalId) throw new Error("INVALID_TERMINAL_APPROVAL");
  const db = getFirebaseDb();
  const now = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const managerRef = doc(db, "terminals", managerTerminalId);
    const managerOwnerRef = doc(db, "terminalOwners", managerTerminalId);
    const managerInstallationRef = doc(db, "terminalInstallations", uid);
    const targetRef = doc(db, "terminals", targetTerminalId);
    const applicationRef = doc(db, "terminalApplications", targetTerminalId);
    const [manager, managerOwner, managerInstallation, target, application] = await Promise.all([
      tx.get(managerRef), tx.get(managerOwnerRef), tx.get(managerInstallationRef),
      tx.get(targetRef), tx.get(applicationRef),
    ]);
    if (!manager.exists() || !managerOwner.exists() || !managerInstallation.exists() ||
        managerOwner.data().ownerUid !== uid || managerOwner.data().enabled !== true ||
        managerInstallation.data().authUid !== uid || managerInstallation.data().terminalId !== managerTerminalId ||
        managerInstallation.data().approved !== true || manager.data().approved !== true ||
        manager.data().managementApproved !== true ||
        !["management", "both"].includes(String(manager.data().role)) ||
        (manager.data().admin !== true && manager.data().subAdmin !== true)) throw new Error("MANAGEMENT_PERMISSION_REQUIRED");
    if (!target.exists() || !application.exists()) throw new Error("TERMINAL_APPLICATION_NOT_FOUND");
    const td = target.data(), ad = application.data();
    if (td.admin === true || td.subAdmin === true || ad.status !== "pending" ||
        ad.terminalId !== targetTerminalId || ad.requestedByUid !== td.requestedByUid ||
        ad.requestedRole !== td.requestedRole || td.role !== ad.requestedRole ||
        !["management", "reception", "both"].includes(String(ad.requestedRole))) {
      throw new Error("TERMINAL_APPLICATION_INVALID");
    }
    const role = ad.requestedRole as "management" | "reception" | "both";
    if (manager.data().admin !== true && (role === "management" || role === "both")) {
      throw new Error("SUBADMIN_CANNOT_APPROVE_MANAGEMENT_TERMINAL");
    }
    const targetUid = String(ad.requestedByUid);
    const targetOwnerRef = doc(db, "terminalOwners", targetTerminalId);
    const targetInstallationRef = doc(db, "terminalInstallations", targetUid);
    const [owner, installation] = await Promise.all([tx.get(targetOwnerRef), tx.get(targetInstallationRef)]);
    if (owner.exists() && (owner.data().ownerUid !== targetUid || owner.data().enabled !== true)) {
      throw new Error("TERMINAL_OWNER_TOMBSTONE_BLOCKS_REUSE");
    }
    if (installation.exists() && (installation.data().terminalId !== targetTerminalId ||
        installation.data().authUid !== targetUid || installation.data().approved !== true)) {
      throw new Error("TERMINAL_INSTALLATION_CONFLICT");
    }
    tx.update(targetRef, {
      approved: true, status: "offline",
      managementApproved: role === "management" || role === "both",
      receptionApproved: role === "reception" || role === "both",
      approvalUpdatedAt: now, approvalUpdatedByUid: uid, updatedAt: now,
    });
    tx.set(targetOwnerRef, { terminalId: targetTerminalId, ownerUid: targetUid, enabled: true, updatedAt: now }, { merge: true });
    tx.set(targetInstallationRef, {
      terminalId: targetTerminalId, authUid: targetUid, approved: true, registrationApprovedAt: now,
    }, { merge: true });
    tx.update(applicationRef, { status: "approved", decidedAt: now, decidedByUid: uid, updatedAt: now });
  });
}

export async function setManagedTerminalMode(targetTerminalId: string, mode: "入口受付" | "出口受付" | "停止"): Promise<void> {
  await ensureFirebaseAuth();
  const managerTerminalId = getManagerTerminalId();
  if (!managerTerminalId || !targetTerminalId || managerTerminalId === targetTerminalId) {
    throw new Error("INVALID_REMOTE_TERMINAL");
  }
  const state = await readOwnTerminalState();
  if (state.terminalId !== managerTerminalId || state.terminal?.managementApproved !== true) {
    throw new Error("MANAGEMENT_TERMINAL_NOT_APPROVED");
  }
  await updateDoc(doc(getFirebaseDb(), "terminals", targetTerminalId), {
    desiredMode: mode,
    desiredModeUpdatedAt: new Date().toISOString(),
  });
}
export async function setManagedSubAdmin(targetTerminalId: string, enabled: boolean): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const managerTerminalId = getManagerTerminalId();
  if (!managerTerminalId || managerTerminalId === targetTerminalId) throw new Error("INVALID_REMOTE_TERMINAL");
  const db = getFirebaseDb();
  await runTransaction(db, async (tx) => {
    const managerRef = doc(db, "terminals", managerTerminalId);
    const managerOwnerRef = doc(db, "terminalOwners", managerTerminalId);
    const managerInstallationRef = doc(db, "terminalInstallations", uid);
    const targetRef = doc(db, "terminals", targetTerminalId);
    const targetOwnerRef = doc(db, "terminalOwners", targetTerminalId);
    const [manager, managerOwner, managerInstallation, target, targetOwner] = await Promise.all([
      tx.get(managerRef), tx.get(managerOwnerRef), tx.get(managerInstallationRef), tx.get(targetRef), tx.get(targetOwnerRef),
    ]);
    if (!manager.exists() || !managerOwner.exists() || !managerInstallation.exists() ||
        manager.data().admin !== true || manager.data().approved !== true || manager.data().managementApproved !== true ||
        managerOwner.data().ownerUid !== uid || managerOwner.data().enabled !== true ||
        managerInstallation.data().authUid !== uid || managerInstallation.data().terminalId !== managerTerminalId ||
        managerInstallation.data().approved !== true || !["management", "both"].includes(String(manager.data().role))) {
      throw new Error("PRIMARY_ADMIN_REQUIRED");
    }
    if (!target.exists() || target.data().admin === true || target.data().approved !== true ||
        target.data().managementApproved !== true || !["management", "both"].includes(String(target.data().role))) {
      throw new Error("APPROVED_MANAGEMENT_TERMINAL_REQUIRED");
    }
    if (!targetOwner.exists() || targetOwner.data().enabled !== true || typeof targetOwner.data().ownerUid !== "string") {
      throw new Error("TERMINAL_OWNER_NOT_VERIFIED");
    }
    const targetUid = targetOwner.data().ownerUid as string;
    const targetInstallation = await tx.get(doc(db, "terminalInstallations", targetUid));
    if (!targetInstallation.exists() || targetInstallation.data().authUid !== targetUid ||
        targetInstallation.data().approved !== true || targetInstallation.data().terminalId !== targetTerminalId) {
      throw new Error("TERMINAL_INSTALLATION_NOT_VERIFIED");
    }
    tx.update(targetRef, { subAdmin: enabled, subAdminUpdatedAt: new Date().toISOString(), subAdminUpdatedByUid: uid });
  });
}

export async function releaseOwnReception(): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const terminalId = getManagerTerminalId();
  if (!terminalId) throw new Error("TERMINAL_ID_NOT_FOUND");
  const db = getFirebaseDb();
  const now = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const terminalRef = doc(db, "terminals", terminalId);
    const ownerRef = doc(db, "terminalOwners", terminalId);
    const installationRef = doc(db, "terminalInstallations", uid);
    const [terminal, owner, installation] = await Promise.all([tx.get(terminalRef), tx.get(ownerRef), tx.get(installationRef)]);
    const ownsTerminal = owner.exists() && owner.data().enabled === true && owner.data().ownerUid === uid;
    const hasGrant = installation.exists() && installation.data().authUid === uid &&
      installation.data().approved === true && installation.data().terminalId === terminalId;
    if (!ownsTerminal && !hasGrant) throw new Error("RECEPTION_RELEASE_NOT_AUTHORIZED");
    if (!terminal.exists()) {
      if (hasGrant) tx.update(installationRef, { approved: false, releasedAt: now });
      return;
    }
    if (!ownsTerminal) {
      tx.update(installationRef, { approved: false, releasedAt: now });
      return;
    }
    const td = terminal.data();
    const managementApproved = td.managementApproved === true;
    const nextVersion = (Number.isSafeInteger(td.receptionApprovalVersion) ? Number(td.receptionApprovalVersion) : 0) + 1;
    tx.update(terminalRef, {
      receptionApproved: false, receptionApprovalVersion: nextVersion,
      approved: managementApproved, mode: "停止", desiredMode: "停止",
      desiredModeUpdatedAt: now, updatedAt: now, approvalUpdatedAt: now, approvalUpdatedByUid: uid,
      ...(td.role === "both" && managementApproved ? { role: "management" } : {}),
    });
  });
}

export async function revokeManagedReception(targetTerminalId: string): Promise<void> {
  await ensureFirebaseAuth();
  const uid = await getFirebaseUid();
  const managerTerminalId = getManagerTerminalId();
  if (!managerTerminalId || managerTerminalId === targetTerminalId) throw new Error("INVALID_REMOTE_TERMINAL");
  const db = getFirebaseDb();
  const now = new Date().toISOString();
  await runTransaction(db, async (tx) => {
    const managerRef = doc(db, "terminals", managerTerminalId);
    const managerOwnerRef = doc(db, "terminalOwners", managerTerminalId);
    const managerInstallationRef = doc(db, "terminalInstallations", uid);
    const targetRef = doc(db, "terminals", targetTerminalId);
    const [manager, managerOwner, managerInstallation, target] = await Promise.all([
      tx.get(managerRef), tx.get(managerOwnerRef), tx.get(managerInstallationRef), tx.get(targetRef),
    ]);
    if (!manager.exists() || !managerOwner.exists() || !managerInstallation.exists() ||
        managerOwner.data().ownerUid !== uid || managerOwner.data().enabled !== true ||
        managerInstallation.data().authUid !== uid || managerInstallation.data().terminalId !== managerTerminalId ||
        managerInstallation.data().approved !== true || manager.data().approved !== true ||
        manager.data().managementApproved !== true || !["management", "both"].includes(String(manager.data().role)) ||
        (manager.data().admin !== true && manager.data().subAdmin !== true)) throw new Error("MANAGEMENT_PERMISSION_REQUIRED");
    if (!target.exists()) throw new Error("TERMINAL_NOT_FOUND");
    const td = target.data();
    if (td.admin === true || td.subAdmin === true) throw new Error("PROTECTED_TERMINAL_RECEPTION_RELEASE_BLOCKED");
    const role = td.role;
    if (!["management", "reception", "both"].includes(String(role))) throw new Error("TERMINAL_ROLE_INVALID");
    const managementApproved = td.managementApproved === true;
    const nextVersion = (Number.isSafeInteger(td.receptionApprovalVersion) ? Number(td.receptionApprovalVersion) : 0) + 1;
    tx.update(targetRef, {
      receptionApproved: false, receptionApprovalVersion: nextVersion,
      approved: managementApproved, mode: "停止", desiredMode: "停止",
      desiredModeUpdatedAt: now, updatedAt: now, approvalUpdatedAt: now, approvalUpdatedByUid: uid,
      ...(role === "both" ? { role: "management" } : {}),
    });
  });
}

export async function saveTerminal(terminal: TerminalRecord): Promise<void> {
  await ensureFirebaseAuth();
  const ownTerminalId = localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
  if (!ownTerminalId || terminal.terminalId !== ownTerminalId) {
    throw new Error("OWN_TERMINAL_ONLY");
  }
  const pendingCount = terminal.syncPendingCount ?? 0;
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0 || pendingCount > 100000) {
    throw new Error("INVALID_PENDING_SYNC_COUNT");
  }
  const db = getFirebaseDb();
  const terminalRef = doc(db, "terminals", ownTerminalId);
  const timestamp = new Date().toISOString();
  await updateDoc(terminalRef, {
    status: "online",
    lastSeen: timestamp,
    updatedAt: timestamp,
    syncPendingCount: pendingCount,
    ...(typeof terminal.networkMbps === "number" && Number.isFinite(terminal.networkMbps)
      ? { networkMbps: terminal.networkMbps } : {}),
  });

  const state = await readOwnTerminalState();
  if (state.terminalId !== ownTerminalId || !state.terminal) {
    throw new Error("OWN_TERMINAL_NOT_APPROVED");
  }
  if (state.terminal.managementApproved === true &&
      (state.terminal.role === "management" || state.terminal.role === "both")) {
    const patch: Record<string, unknown> = { updatedAt: timestamp, mode: terminal.mode };
    if (typeof terminal.name === "string" && terminal.name.trim() &&
        terminal.name.trim() !== state.terminal.name) {
      if (terminal.name.trim().length > 80) throw new Error("TERMINAL_NAME_TOO_LONG");
      patch.name = terminal.name.trim();
    }
    await updateDoc(terminalRef, patch);
  }
}


function getManagementBrowserDownlink(): number | null {
  if (typeof navigator === "undefined") return null;
  const connection = (navigator as Navigator & { connection?: { downlink?: number } }).connection;
  const downlink = connection?.downlink;
  return typeof downlink === "number" && Number.isFinite(downlink) && downlink > 0 ? downlink : null;
}

export async function saveManagementTerminalHeartbeat(terminalId: string): Promise<number | null> {
  await ensureFirebaseAuth();
  const networkMbps = getManagementBrowserDownlink();
  const timestamp = new Date().toISOString();
  await updateDoc(doc(getFirebaseDb(), "terminals", terminalId), {
    status: "online",
    lastSeen: timestamp,
    updatedAt: timestamp,
    syncPendingCount: 0,
    ...(networkMbps !== null ? { networkMbps } : {}),
  });
  return networkMbps;
}

export async function saveReceptionSettings(eventId: string, settings: ReceptionSettings): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", eventId, "settings", "reception"), settings, { merge: true });
}
export async function loadAppSettings(deviceId: string): Promise<Record<string, unknown> | null> {
  const db = getFirebaseDb();
  const { getDoc } = await import("firebase/firestore");
  const snapshot = await getDoc(doc(db, "devices", deviceId));
  return snapshot.exists() ? snapshot.data() : null;
}
export async function saveAppSettings(deviceId: string, settings: Record<string, unknown>): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "devices", deviceId), { ...settings, updatedAt: new Date().toISOString() }, { merge: true });
}

export async function loadEventTickets(eventId: string): Promise<Ticket[]> {
  const db = getFirebaseDb();
  const snapshot = await getDocsFromServer(collection(db, "events", eventId, "tickets"));
  return snapshot.docs.map(item => item.data() as Ticket);
}

export async function loadEventReceptionRecords(eventId: string): Promise<ReceptionRecord[]> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "receptionRecords"));
  return snapshot.docs.map(item => item.data() as ReceptionRecord);
}
export async function loadAnalysis(eventId: string): Promise<AnalysisRecord[]> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "analysis"));
  return snapshot.docs.map(item => item.data() as AnalysisRecord);
}
export async function loadMembers(eventId: string): Promise<MemberRecord[]> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "members"));
  return snapshot.docs.map(item => item.data() as MemberRecord);
}

export type ReceptionErrorRecord = {
  errorId: string;
  eventId: string;
  terminalId: string;
  category: "unknown_ticket" | "invalid_ticket" | "invalid_state" | "save_failed" | "camera_failed" | "event_load_failed" | "sync_failed";
  mode: "entry" | "exit";
  timestamp: string;
  syncedAt?: string;
};

export async function loadReceptionErrors(eventId: string): Promise<ReceptionErrorRecord[]> {
  const db = getFirebaseDb();
  // イベントIDでサーバー側から絞り込み、他イベントのログを読み込まない。
  const errorsQuery = query(collection(db, "receptionErrors"), where("eventId", "==", eventId));
  const snapshot = await getDocs(errorsQuery);
  return snapshot.docs
    .map(item => item.data() as ReceptionErrorRecord)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
}

function terminalFromDocument(terminalId: string, value: Record<string, unknown>): TerminalRecord {
  const mode = value.mode === "入口受付" || value.mode === "出口受付" ? value.mode : "停止";
  const desiredMode = value.desiredMode === "入口受付" || value.desiredMode === "出口受付" || value.desiredMode === "停止"
    ? value.desiredMode : undefined;
  const role = value.role === "management" || value.role === "reception" || value.role === "both"
    ? value.role : undefined;
  return {
    terminalId,
    name: typeof value.name === "string" ? value.name : terminalId,
    type: value.type === "Web / PC" ? "Web / PC" : "Web / iPad",
    mode,
    ...(desiredMode ? { desiredMode } : {}),
    ...(typeof value.desiredModeUpdatedAt === "string" ? { desiredModeUpdatedAt: value.desiredModeUpdatedAt } : {}),
    status: value.status === "online" || value.status === "offline" ? value.status : "pending",
    approved: value.approved === true,
    lastSeen: typeof value.lastSeen === "string" ? value.lastSeen : null,
    networkMbps: typeof value.networkMbps === "number" ? value.networkMbps : null,
    battery: typeof value.battery === "number" ? value.battery : null,
    ...(role ? { role } : {}),
    admin: value.admin === true,
    subAdmin: value.subAdmin === true,
    managementApproved: value.managementApproved === true,
    receptionApproved: value.receptionApproved === true,
    syncPendingCount: typeof value.syncPendingCount === "number" ? value.syncPendingCount : 0,
  };
}

export function subscribeTerminals(onChange: (terminals: TerminalRecord[]) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const terminals = await loadTerminals();
      if (active) onChange(terminals);
    } catch (error) {
      if (active) onError(error);
    } finally {
      if (active) timer = setTimeout(() => { void refresh(); }, 5000);
    }
  };
  void refresh();
  return () => { active = false; if (timer) clearTimeout(timer); };
}

export async function loadTerminals(): Promise<TerminalRecord[]> {
  const state = await readOwnTerminalState();
  if (!state.terminal || !state.terminalId) {
    const pending = state.pendingApplication;
    if (!pending || typeof pending.terminalId !== "string") return [];
    return [terminalFromDocument(pending.terminalId, {
      ...pending, role: pending.requestedRole, approved: false,
      managementApproved: false, receptionApproved: false,
    })];
  }

  const own = terminalFromDocument(state.terminalId, state.terminal);
  if (own.approved && own.managementApproved &&
      (own.role === "management" || own.role === "both")) {
    const uid = await getFirebaseUid();
    const owner = await getDocFromServer(doc(getFirebaseDb(), "terminalOwners", state.terminalId));
    // A handed-off reception installation never inherits the owner's management role.
    if (owner.exists() && owner.data().enabled === true && owner.data().ownerUid === uid) {
      const snapshot = await getDocsFromServer(collection(getFirebaseDb(), "terminals"));
      return snapshot.docs.map(item => terminalFromDocument(item.id, item.data()));
    }
  }
  // Reception-only and handed-off installations cannot unlock management UI.
  return [];
}
export async function loadReceptionSettings(eventId: string): Promise<ReceptionSettings | null> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "settings"));
  const first = snapshot.docs[0]?.data();
  return first ? first as ReceptionSettings : null;
}
