import { collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, query, where } from "firebase/firestore";
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


export async function getCurrentFirebaseEventAuthPayload(): Promise<EventAuthPayload> {
  const db = getFirebaseDb();
  // Firestoreルールが公開対象イベントだけを許可する構成でも取得できるよう、
  // 全イベントを読まず receptionTarget=true の文書だけをサーバー側で検索する。
  const publishedEventsQuery = query(collection(db, "events"), where("receptionTarget", "==", true));
  const snapshot = await getDocsFromServer(publishedEventsQuery);
  const candidates = snapshot.docs
    .map(item => item.data() as Event & { authToken?: unknown; receptionTarget?: unknown })
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

  const payload: EventAuthPayload = {
    type: "qr-ticket-event-auth",
    eventId: current.eventId,
    eventName: current.eventName,
    dataVersion: current.dataVersion,
    authToken: current.authToken,
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
  const snapshot = await getDocFromServer(doc(db, "eventBundles", normalizedToken));
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
  const snapshot = await getDocFromServer(doc(db, "eventBundles", payload.authToken));

  if (!snapshot.exists()) {
    throw new Error("EVENT_DATA_NOT_FOUND");
  }

  const bundle = snapshot.data() as Partial<EventBundle>;

  if (
    bundle.authToken !== payload.authToken ||
    bundle.event?.eventId !== payload.eventId ||
    bundle.event?.eventName !== payload.eventName ||
    bundle.event?.dataVersion !== payload.dataVersion
  ) {
    throw new Error("EVENT_DATA_INVALID");
  }

  // チケットの正本はイベント配下のサブコレクション。単一文書に全件を格納すると
  // Firestoreの文書サイズ上限や古い枚数情報により、受付端末へ反映されなくなる。
  const savedTickets = await getDocsFromServer(collection(db, "events", payload.eventId, "tickets"));
  let tickets = savedTickets.docs.map(item => item.data() as Ticket);

  // 旧形式の公開バンドルからの移行互換。新形式では必ずサブコレクションが正本。
  if (tickets.length === 0 && bundle.ticketCount !== 0 && Array.isArray(bundle.tickets) && bundle.tickets.length > 0) {
    tickets = bundle.tickets;
  }

  if (typeof bundle.ticketCount === "number" && bundle.ticketCount !== tickets.length) {
    throw new Error("EVENT_TICKET_COUNT_MISMATCH");
  }

  const event = bundle.event;
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
