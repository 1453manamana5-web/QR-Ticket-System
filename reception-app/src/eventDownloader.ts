import { collection, doc, getDocFromServer, getDocsFromServer, query, where } from "firebase/firestore";
import type { EventAuthPayload, Event, LocalEventData, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";

type EventBundle = {
  event: Event;
  settings: ReceptionSettings;
  tickets: Ticket[];
  ticketCount: number;
  authToken: string;
  publishedAt: string;
};

type PublishedEvent = Event & {authToken?: unknown; receptionTarget?: unknown; ticketCount?: unknown};

function eventMetadata(value: Partial<Event> | undefined): Event | null {
  if (!value || typeof value.eventId !== "string" || !value.eventId ||
      typeof value.eventName !== "string" || !value.eventName ||
      typeof value.eventDate !== "string" || typeof value.startTime !== "string" ||
      typeof value.endTime !== "string" || !Number.isSafeInteger(value.dataVersion) || Number(value.dataVersion) < 1 ||
      !["preparing", "ready", "active", "finalizing", "finished"].includes(value.eventStatus ?? "")) return null;
  const date = Date.parse(`${value.eventDate}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.eventDate) || !Number.isFinite(date) ||
      new Date(date).toISOString().slice(0, 10) !== value.eventDate ||
      ![value.startTime, value.endTime].every(time => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time))) return null;
  return {
    eventId: value.eventId, eventName: value.eventName, eventDate: value.eventDate,
    startTime: value.startTime, endTime: value.endTime, eventStatus: value.eventStatus!,
    dataVersion: value.dataVersion!,
  };
}

async function withDownloadDeadline<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("イベント取得の通信がタイムアウトしました"), {code: "deadline-exceeded"})), 5000);
    })]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function getCurrentFirebaseEventAuthPayload(): Promise<EventAuthPayload & {event?: Event}> {
  const db = getFirebaseDb();
  // Firestoreルールが公開対象イベントだけを許可する構成でも取得できるよう、
  // 全イベントを読まず receptionTarget=true の文書だけをサーバー側で検索する。
  const publishedEventsQuery = query(collection(db, "events"), where("receptionTarget", "==", true));
  const snapshot = await withDownloadDeadline(getDocsFromServer(publishedEventsQuery));
  const candidates = snapshot.docs
    .map(item => item.data() as PublishedEvent)
    .filter(item =>
      // receptionTarget が明示されたイベントを優先し、status の表記ゆれや
      // 管理画面側の状態更新だけで受付データを見失わないようにする。
      item.receptionTarget === true &&
      item.eventStatus !== "finished" &&
      typeof item.eventId === "string" &&
      item.eventId.length > 0 &&
      typeof item.eventName === "string" &&
      item.eventName.length > 0 &&
      typeof item.dataVersion === "number" &&
      typeof item.authToken === "string" &&
      item.authToken.length > 0
    );

  // 管理アプリで明示的に公開対象に指定されたイベントだけを自動取得する。
  // 取得対象が0件・複数件の場合は、受付画面に原因を表示できるよう明示的に失敗させる。
  if (candidates.length === 0) {
    throw new Error("NO_PUBLISHED_EVENT");
  }
  if (candidates.length > 1) {
    throw new Error("MULTIPLE_PUBLISHED_EVENTS");
  }
  const current = candidates[0];
  if (!current || typeof current.authToken !== "string") {
    throw new Error("INVALID_PUBLISHED_EVENT");
  }
  const event = eventMetadata(current);
  if (!event) throw new Error("INVALID_PUBLISHED_EVENT");

  const payload: EventAuthPayload & {event?: Event} = {
    type: "qr-ticket-event-auth",
    eventId: current.eventId,
    eventName: current.eventName,
    dataVersion: current.dataVersion,
    authToken: current.authToken,
    event,
  };

  return payload;
}

export async function downloadCurrentFirebaseEventData(
  terminalId: string,
): Promise<{ localEvent: LocalEventData; tickets: Ticket[]; authPayload: EventAuthPayload }> {
  const payload = await getCurrentFirebaseEventAuthPayload();
  const downloaded = await downloadEventData(payload, terminalId);
  return { ...downloaded, authPayload: payload };
}

export async function getEventAuthPayloadByToken(token: string): Promise<EventAuthPayload | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) return null;
  const db = getFirebaseDb();
  const snapshot = await withDownloadDeadline(getDocFromServer(doc(db, "eventBundles", normalizedToken)));
  if (!snapshot.exists()) return null;
  const bundle = snapshot.data() as Partial<EventBundle>;
  if (
    bundle.authToken !== normalizedToken ||
    typeof bundle.event?.eventId !== "string" ||
    typeof bundle.event?.eventName !== "string" ||
    typeof bundle.event?.dataVersion !== "number"
  ) {
    return null;
  }
  return {
    type: "qr-ticket-event-auth",
    eventId: bundle.event.eventId,
    eventName: bundle.event.eventName,
    dataVersion: bundle.event.dataVersion,
    authToken: normalizedToken,
  };
}

export async function downloadEventData(
  payload: EventAuthPayload,
  terminalId: string,
): Promise<{ localEvent: LocalEventData; tickets: Ticket[] }> {
  const db = getFirebaseDb();
  const snapshot = await withDownloadDeadline(getDocFromServer(doc(db, "eventBundles", payload.authToken)));

  if (!snapshot.exists()) {
    throw new Error("EVENT_DATA_NOT_FOUND");
  }

  const bundle = snapshot.data() as Partial<EventBundle>;

  // The published bundle contains a snapshot of the schedule. Edits to the
  // canonical event must also reach terminals when the inventory version did
  // not change. Keep legacy embedded bundles usable when no event doc exists.
  const canonicalSnapshot = await withDownloadDeadline(getDocFromServer(doc(db, "events", payload.eventId)));
  const canonical = canonicalSnapshot.exists() ? canonicalSnapshot.data() as PublishedEvent : null;
  const event = eventMetadata(canonical ?? bundle.event);
  if (
    bundle.authToken !== payload.authToken ||
    bundle.event?.eventId !== payload.eventId ||
    bundle.event?.dataVersion !== payload.dataVersion || !event ||
    event.eventId !== payload.eventId || event.dataVersion !== payload.dataVersion ||
    (canonical ? (
      typeof canonical.authToken === "string" && canonical.authToken !== payload.authToken ||
      canonical.receptionTarget === false || canonical.eventStatus === "finished" ||
      // A printed event-auth code may still carry the old display name.
      payload.eventName !== event.eventName && payload.eventName !== bundle.event.eventName
    ) : bundle.event.eventName !== payload.eventName)
  ) {
    throw new Error("EVENT_DATA_INVALID");
  }

  // チケットの正本はイベント配下のサブコレクション。単一文書に全件を格納すると
  // Firestoreの文書サイズ上限や古い枚数情報により、受付端末へ反映されなくなる。
  const savedTickets = await withDownloadDeadline(getDocsFromServer(collection(db, "events", payload.eventId, "tickets")));
  let tickets = savedTickets.docs.map(item => item.data() as Ticket);
  const ticketCount = canonical?.ticketCount !== undefined ? canonical.ticketCount : bundle.ticketCount;
  if (ticketCount !== undefined && (typeof ticketCount !== "number" || !Number.isSafeInteger(ticketCount) || ticketCount < 0)) {
    throw new Error("EVENT_DATA_INVALID");
  }

  // 旧形式の公開バンドルからの移行互換。新形式では必ずサブコレクションが正本。
  if (tickets.length === 0 && ticketCount !== 0 && Array.isArray(bundle.tickets) && bundle.tickets.length > 0) {
    tickets = bundle.tickets;
  }

  if (typeof ticketCount === "number" && ticketCount !== tickets.length) {
    throw new Error("EVENT_TICKET_COUNT_MISMATCH");
  }

  // Reception cannot read the management-only settings subcollection. The
  // published bundle remains the authorized reception-settings source.
  const settings = bundle.settings ?? {
    entryEnabled: true,
    exitEnabled: true,
    reentryEnabled: true,
  };

  const localEvent: LocalEventData = {
    event,
    settings,
    terminalId,
    authenticatedAt: new Date().toISOString(),
    dataReady: false,
    ticketCount: tickets.length,
  };

  return { localEvent, tickets };
}
