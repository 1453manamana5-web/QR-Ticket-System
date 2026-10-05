import { doc, getDoc } from "firebase/firestore";
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

export async function getEventAuthPayloadByToken(token: string): Promise<EventAuthPayload | null> {
  const normalizedToken = token.trim();
  if (!normalizedToken) return null;
  const db = getFirebaseDb();
  const snapshot = await getDoc(doc(db, "eventBundles", normalizedToken));
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
  const snapshot = await getDoc(doc(db, "eventBundles", payload.authToken));

  if (!snapshot.exists()) {
    throw new Error("EVENT_DATA_NOT_FOUND");
  }

  const bundle = snapshot.data() as Partial<EventBundle>;

  if (
    bundle.authToken !== payload.authToken ||
    bundle.event?.eventId !== payload.eventId ||
    bundle.event?.eventName !== payload.eventName ||
    bundle.event?.dataVersion !== payload.dataVersion ||
    !Array.isArray(bundle.tickets) ||
    typeof bundle.ticketCount !== "number" ||
    bundle.ticketCount !== bundle.tickets.length
  ) {
    throw new Error("EVENT_DATA_INVALID");
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
    ticketCount: bundle.tickets.length,
  };

  return { localEvent, tickets: bundle.tickets };
}
