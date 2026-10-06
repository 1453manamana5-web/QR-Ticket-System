import { doc, setDoc } from "firebase/firestore";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";

export type PublishedEventBundle = {
  event: Event;
  settings: ReceptionSettings;
  tickets: Ticket[];
  ticketCount: number;
  authToken: string;
  publishedAt: string;
};

export async function saveEventMetadata(event: Event): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", event.eventId), {
    ...event,
    updatedAt: new Date().toISOString(),
  });
}

export function createAuthToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

export async function publishEventBundle(
  event: Event,
  settings: ReceptionSettings,
  tickets: Ticket[],
): Promise<PublishedEventBundle> {
  const db = getFirebaseDb();
  const authToken = createAuthToken();
  const bundle: PublishedEventBundle = {
    event,
    settings,
    tickets,
    ticketCount: tickets.length,
    authToken,
    publishedAt: new Date().toISOString(),
  };

  await setDoc(doc(db, "events", event.eventId), {
    ...event,
    authToken,
    updatedAt: bundle.publishedAt,
  });

  await setDoc(doc(db, "eventBundles", authToken), {
    event,
    settings,
    tickets,
    ticketCount: tickets.length,
    authToken,
    publishedAt: bundle.publishedAt,
  });

  return bundle;
}
