import { collection, doc, getDoc, getDocs, getDocFromServer, onSnapshot, setDoc } from "firebase/firestore";
import type { Event, ReceptionRecord, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";

export type MemberRecord = { memberId: string; memberNumber: number; name: string; };
export type TerminalRecord = { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; mode: "入口受付" | "出口受付" | "停止"; desiredMode?: "入口受付" | "出口受付" | "停止"; desiredModeUpdatedAt?: string; status: "online" | "offline" | "pending"; approved: boolean; lastSeen: string | null; networkMbps: number | null; battery: number | null; role?: "management" | "reception" | "both"; managementApproved?: boolean; receptionApproved?: boolean; syncPendingCount?: number; };
export type AnalysisRecord = { eventId: string; eventName: string; eventDate: string; total: number; unused: number; inside: number; exited: number; savedAt: string; };

export async function deleteEvent(eventId: string): Promise<void> {
  const db = getFirebaseDb();
  const { deleteDoc } = await import("firebase/firestore");

  // Firestoreでは親ドキュメントを削除してもサブコレクションは残るため、
  // イベント配下の運用データもまとめて削除する。
  const subcollections = ["tickets", "receptionRecords", "analysis", "members", "settings"] as const;
  for (const subcollection of subcollections) {
    const snapshot = await getDocs(collection(db, "events", eventId, subcollection));
    await Promise.all(snapshot.docs.map(item => deleteDoc(item.ref)));
  }
  await deleteDoc(doc(db, "events", eventId));
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

export async function saveTickets(eventId: string, tickets: Ticket[]): Promise<void> {
  const db = getFirebaseDb();
  await Promise.all(tickets.map(ticket => setDoc(doc(db, "events", eventId, "tickets", ticket.ticketId), ticket, { merge: true })));
}
export async function saveTicket(eventId: string, ticket: Ticket): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", eventId, "tickets", ticket.ticketId), ticket, { merge: true });
}
export async function deleteTicket(eventId: string, ticketId: string): Promise<void> {
  const db = getFirebaseDb();
  const { deleteDoc } = await import("firebase/firestore");
  await deleteDoc(doc(db, "events", eventId, "tickets", ticketId));
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
  const ownTerminalId =
    typeof window !== "undefined"
      ? localStorage.getItem("qr-ticket-terminal-id") ??
        localStorage.getItem("qr-ticket-device-id")
      : null;

  if (ownTerminalId !== null && terminalId === ownTerminalId) {
    throw new Error("OWN_TERMINAL_DELETE_BLOCKED");
  }

  const db = getFirebaseDb();
  const { deleteDoc, getDoc } = await import("firebase/firestore");
  const targetRef = doc(db, "terminals", terminalId);
  const targetSnapshot = await getDoc(targetRef);
  if (targetSnapshot.exists() && targetSnapshot.data().admin === true) {
    throw new Error("ADMIN_TERMINAL_DELETE_BLOCKED");
  }

  await deleteDoc(targetRef);
}

export async function saveTerminal(terminal: TerminalRecord): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "terminals", terminal.terminalId), { ...terminal, updatedAt: new Date().toISOString() }, { merge: true });
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
  const snapshot = await getDocs(collection(db, "events", eventId, "tickets"));
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
export function subscribeTerminals(onChange: (terminals: TerminalRecord[]) => void, onError: (error: unknown) => void): () => void {
  const db = getFirebaseDb();
  return onSnapshot(collection(db, "terminals"), snapshot => onChange(snapshot.docs.map(item => item.data() as TerminalRecord)), onError);
}
export async function loadTerminals(): Promise<TerminalRecord[]> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "terminals"));
  return snapshot.docs.map(item => item.data() as TerminalRecord);
}
export async function loadReceptionSettings(eventId: string): Promise<ReceptionSettings | null> {
  const db = getFirebaseDb();
  const snapshot = await getDocs(collection(db, "events", eventId, "settings"));
  const first = snapshot.docs[0]?.data();
  return first ? first as ReceptionSettings : null;
}
