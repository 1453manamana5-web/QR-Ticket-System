import { collection, doc, getDoc, getDocs, getDocsFromServer, getDocFromServer, onSnapshot, query, setDoc, where, writeBatch } from "firebase/firestore";
import type { Event, ReceptionRecord, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";
import { callBackend } from "./firebaseFunctions";

export type MemberRecord = { memberId: string; memberNumber: number; name: string; };
export type TerminalRecord = { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; mode: "入口受付" | "出口受付" | "停止"; desiredMode?: "入口受付" | "出口受付" | "停止"; desiredModeUpdatedAt?: string; status: "online" | "offline" | "pending"; approved: boolean; lastSeen: string | null; networkMbps: number | null; battery: number | null; role?: "management" | "reception" | "both"; managementApproved?: boolean; receptionApproved?: boolean; syncPendingCount?: number; };
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
  if (authToken) {
    await deleteDoc(doc(db, "eventBundles", authToken));
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
  const eventSnapshot = await getDocFromServer(eventRef);
  if (!eventSnapshot.exists()) throw new Error("EVENT_NOT_FOUND");
  const eventData = eventSnapshot.data();
  const authToken = typeof eventData.authToken === "string" ? eventData.authToken : "";
  const now = new Date().toISOString();
  let nextDataVersion = Math.max(1, Number(eventData.dataVersion) || 1);
  let bundleRef: ReturnType<typeof doc> | null = null;
  let savedBundle: Record<string, unknown> | null = null;

  if (authToken) {
    bundleRef = doc(db, "eventBundles", authToken);
    const bundleSnapshot = await getDocFromServer(bundleRef);
    if (bundleSnapshot.exists()) {
      savedBundle = bundleSnapshot.data();
      nextDataVersion += 1;
    }
  }

  await setDoc(eventRef, {
    ticketCount: tickets.length,
    ...(savedBundle ? { dataVersion: nextDataVersion } : {}),
    updatedAt: now,
  }, { merge: true });

  if (!bundleRef || !savedBundle) return;
  // バンドルに全チケットを再格納しない。件数・版数だけ更新し、実データはサブコレクションを参照する。
  await setDoc(bundleRef, {
    event: {
      ...((savedBundle.event as Record<string, unknown> | undefined) ?? {}),
      eventId,
      dataVersion: nextDataVersion,
    },
    ticketCount: tickets.length,
    publishedAt: now,
  }, { merge: true });
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
  const ownTerminalId = typeof window !== "undefined"
    ? localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id")
    : null;
  if (ownTerminalId && terminalId === ownTerminalId) throw new Error("OWN_TERMINAL_DELETE_BLOCKED");
  await callBackend<{ managerTerminalId: string; targetTerminalId: string }, { deleted: boolean }>(
    "deleteManagedTerminal",
    { managerTerminalId: ownTerminalId ?? "", targetTerminalId: terminalId },
  );
}

function getManagerTerminalId(): string {
  return localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
}
export async function getOwnTerminalStatus(): Promise<{
  approved: boolean; terminalId: string | null; name?: string; status?: "online" | "offline" | "pending";
  role?: "management" | "reception" | "both" | null; managementApproved?: boolean; receptionApproved?: boolean;
}> {
  return callBackend<Record<string, never>, {
    approved: boolean; terminalId: string | null; name?: string; status?: "online" | "offline" | "pending";
    role?: "management" | "reception" | "both" | null; managementApproved?: boolean; receptionApproved?: boolean;
  }>("getTerminalInstallationStatus", {});
}
export async function requestTerminalRegistration(input: { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; role: "management" | "reception" | "both" }): Promise<void> {
  await callBackend<{ terminalId: string; name: string; type: string; role: string }, { applicationId: string }>(
    "registerTerminalApplication", input,
  );
}
export async function approveTerminal(targetTerminalId: string): Promise<void> {
  await callBackend<{ managerTerminalId: string; targetTerminalId: string }, { approved: boolean }>(
    "approveTerminalRegistration", { managerTerminalId: getManagerTerminalId(), targetTerminalId },
  );
}
export async function setManagedTerminalMode(targetTerminalId: string, mode: "入口受付" | "出口受付" | "停止"): Promise<void> {
  await callBackend<{ managerTerminalId: string; targetTerminalId: string; mode: string }, { updated: boolean }>(
    "setManagedTerminalMode", { managerTerminalId: getManagerTerminalId(), targetTerminalId, mode },
  );
}
export async function setManagedSubAdmin(targetTerminalId: string, enabled: boolean): Promise<void> {
  await callBackend<{ managerTerminalId: string; targetTerminalId: string; enabled: boolean }, { updated: boolean }>(
    "setTerminalSubAdmin", { managerTerminalId: getManagerTerminalId(), targetTerminalId, enabled },
  );
}
export async function releaseOwnReception(): Promise<void> {
  const terminalId = getManagerTerminalId();
  await callBackend<{ terminalId: string }, { released: boolean }>(
    "releaseOwnReceptionRegistration", { terminalId },
  );
}
export async function revokeManagedReception(targetTerminalId: string): Promise<void> {
  await callBackend<{ managerTerminalId: string; targetTerminalId: string }, { released: boolean }>(
    "revokeTerminalReception", { managerTerminalId: getManagerTerminalId(), targetTerminalId },
  );
}

export async function saveTerminal(terminal: TerminalRecord): Promise<void> {
  const ownTerminalId = localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
  if (!ownTerminalId || terminal.terminalId !== ownTerminalId) {
    throw new Error("TERMINAL_SERVER_WRITE_REQUIRED");
  }
  const previous = await callBackend<Record<string, never>, {
    terminalId: string | null; name?: string; desiredMode?: string | null;
  }>("getTerminalInstallationStatus", {});
  if (typeof terminal.name === "string" && terminal.name.trim() && terminal.name !== previous.name) {
    await callBackend<{ terminalId: string; name: string }, { terminalId: string; name: string }>(
      "updateManagedTerminalName", { terminalId: ownTerminalId, name: terminal.name.trim() },
    );
  }
  await callBackend<{
    terminalId: string; mode: string; syncPendingCount: number; networkMbps?: number;
  }, { saved: boolean }>("updateTerminalHeartbeat", {
    terminalId: ownTerminalId,
    mode: terminal.mode,
    syncPendingCount: terminal.syncPendingCount ?? 0,
    ...(typeof terminal.networkMbps === "number" ? { networkMbps: terminal.networkMbps } : {}),
  });
}


let managementNetworkSpeedCache: number | null = null;
let managementNetworkSpeedMeasuredAt = 0;
const MANAGEMENT_NETWORK_SPEED_MEASURE_INTERVAL_MS = 30000;
const MANAGEMENT_NETWORK_PROBE_SIZE_BYTES = 32768;

function getManagementBrowserDownlink(): number | null {
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

function createManagementNetworkProbe(): string {
  return "0123456789abcdef".repeat(MANAGEMENT_NETWORK_PROBE_SIZE_BYTES / 16);
}

async function measureManagementNetworkSpeed(
  reference: ReturnType<typeof doc>,
): Promise<number | null> {
  const now = Date.now();
  if (now - managementNetworkSpeedMeasuredAt < MANAGEMENT_NETWORK_SPEED_MEASURE_INTERVAL_MS) {
    return managementNetworkSpeedCache;
  }

  const browserDownlink = getManagementBrowserDownlink();
  if (browserDownlink !== null) {
    managementNetworkSpeedCache = browserDownlink;
    managementNetworkSpeedMeasuredAt = now;
    return browserDownlink;
  }

  try {
    const probe = createManagementNetworkProbe();
    const startedAt = performance.now();
    await setDoc(reference, {
      networkProbe: probe,
      networkProbeAt: new Date().toISOString(),
    }, { merge: true });
    await getDocFromServer(reference);
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const roundTripBytes = probe.length * 2;
    const measuredMbps = (roundTripBytes * 8) / (elapsedMs * 1000);
    const normalized = Math.max(0.1, Math.min(10000, measuredMbps));
    managementNetworkSpeedCache = normalized;
    managementNetworkSpeedMeasuredAt = Date.now();
    return normalized;
  } catch (reason) {
    console.warn("管理端末の通信速度測定に失敗しました", reason);
    return managementNetworkSpeedCache;
  }
}

export async function saveManagementTerminalHeartbeat(terminalId: string): Promise<number | null> {
  const db = getFirebaseDb();
  const reference = doc(db, "terminals", terminalId);
  const existingSnapshot = await getDoc(reference);
  const existing = existingSnapshot.exists() ? existingSnapshot.data() : {};
  const networkMbps = await measureManagementNetworkSpeed(reference);

  await setDoc(reference, {
    terminalId,
    name: typeof existing.name === "string" ? existing.name : "管理端末",
    type: existing.type === "Web / PC" ? "Web / PC" : "Web / iPad",
    role: existing.role === "both" || existing.role === "reception" ? existing.role : "management",
    mode: existing.mode === "入口受付" || existing.mode === "出口受付" ? existing.mode : "停止",
    status: "online",
    approved: existing.managementApproved === true || existing.approved === true,
    managementApproved: existing.managementApproved === true || existing.approved === true,
    receptionApproved: existing.receptionApproved === true,
    lastSeen: new Date().toISOString(),
    networkMbps: networkMbps ?? (typeof existing.networkMbps === "number" ? existing.networkMbps : null),
    battery: typeof existing.battery === "number" ? existing.battery : null,
    updatedAt: new Date().toISOString(),
  }, { merge: true });

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

export function subscribeTerminals(onChange: (terminals: TerminalRecord[]) => void, onError: (error: unknown) => void): () => void {
  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    try {
      const managerTerminalId = localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
      const result = await callBackend<{ managerTerminalId: string }, { terminals: TerminalRecord[] }>(
        "listManagedTerminals", { managerTerminalId },
      );
      if (active) onChange(result.terminals);
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
  const managerTerminalId = localStorage.getItem("qr-ticket-terminal-id") ?? localStorage.getItem("qr-ticket-device-id") ?? "";
  const result = await callBackend<{ managerTerminalId: string }, { terminals: TerminalRecord[] }>(
    "listManagedTerminals", { managerTerminalId },
  );
  return result.terminals;
}
export async function loadReceptionSettings(eventId: string): Promise<ReceptionSettings | null> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "settings"));
  const first = snapshot.docs[0]?.data();
  return first ? first as ReceptionSettings : null;
}
