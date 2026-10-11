import { collection, doc, getDoc, getDocs, setDoc } from "firebase/firestore";
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

export async function loadPublishedEventBundle(eventId: string): Promise<PublishedEventBundle | null> {
  const db = getFirebaseDb();
  const eventSnapshot = await getDoc(doc(db, "events", eventId));
  if (!eventSnapshot.exists()) return null;
  const authToken = eventSnapshot.data().authToken;
  if (typeof authToken !== "string" || !authToken) return null;
  const bundleSnapshot = await getDoc(doc(db, "eventBundles", authToken));
  if (!bundleSnapshot.exists()) return null;
  const data = bundleSnapshot.data() as Partial<PublishedEventBundle>;
  if (data.authToken !== authToken || data.event?.eventId !== eventId ||
      !Array.isArray(data.tickets) || typeof data.ticketCount !== "number" ||
      data.ticketCount !== data.tickets.length) return null;
  return data as PublishedEventBundle;
}

export async function saveEventMetadata(event: Event): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", event.eventId), {
    ...event,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
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
  const existingEvents = await getDocs(collection(db, "events"));
  await Promise.all(existingEvents.docs
    .filter(item => item.id !== event.eventId && item.data().receptionTarget === true)
    .map(item => setDoc(item.ref, { receptionTarget: false, updatedAt: new Date().toISOString() }, { merge: true })));
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
    receptionTarget: true,
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
