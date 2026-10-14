import { collection, doc, getDoc, getDocFromServer, getDocs, setDoc, writeBatch } from "firebase/firestore";
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
  // React stateが未読込の瞬間に公開操作されても、Firestoreに保存済みのチケットを空配信しない。
  // 明示的なチケット一覧が空の場合だけ、Firestoreの保存済み一覧を復元元として使う。
  let publishedTickets = tickets;
  if (publishedTickets.length === 0) {
    const savedTicketsSnapshot = await getDocs(collection(db, "events", event.eventId, "tickets"));
    if (!savedTicketsSnapshot.empty) {
      publishedTickets = savedTicketsSnapshot.docs.map(item => item.data() as Ticket);
    }
  }
  const existingEvents = await getDocs(collection(db, "events"));
  await Promise.all(existingEvents.docs
    .filter(item => item.id !== event.eventId && item.data().receptionTarget === true)
    .map(item => setDoc(item.ref, { receptionTarget: false, updatedAt: new Date().toISOString() }, { merge: true })));
  const publishedEvent: Event = {
    ...event,
    eventStatus: event.eventStatus === "finished" ? "finished" : "ready",
  };
  const bundle: PublishedEventBundle = {
    event: publishedEvent,
    settings,
    tickets: publishedTickets,
    ticketCount: publishedTickets.length,
    authToken,
    publishedAt: new Date().toISOString(),
  };

  // 管理端末のリアルタイム一覧と受付用バンドルで、同じチケット群を使う。
  for (let start = 0; start < publishedTickets.length; start += 450) {
    const batch = writeBatch(db);
    for (const ticket of publishedTickets.slice(start, start + 450)) {
      batch.set(doc(db, "events", event.eventId, "tickets", ticket.ticketId), ticket, { merge: true });
    }
    await batch.commit();
  }

  // 先にチケットを含む公開バンドルを保存し、その後イベント一覧のメタデータを更新する。
  // merge:true にして、同時に保存される他のイベント管理情報を消さない。
  await setDoc(doc(db, "eventBundles", authToken), {
    event: publishedEvent,
    settings,
    tickets: publishedTickets,
    ticketCount: publishedTickets.length,
    authToken,
    publishedAt: bundle.publishedAt,
  });

  const eventRef = doc(db, "events", event.eventId);
  await setDoc(eventRef, {
    ...publishedEvent,
    authToken,
    receptionTarget: publishedEvent.eventStatus !== "finished",
    ticketCount: publishedTickets.length,
    updatedAt: bundle.publishedAt,
  }, { merge: true });

  // 成功表示だけ先行しないよう、サーバー側に公開情報が残ったことを確認する。
  const savedEvent = await getDocFromServer(eventRef);
  const savedData = savedEvent.data();
  if (
    !savedEvent.exists() ||
    savedData?.eventId !== event.eventId ||
    savedData?.authToken !== authToken
  ) {
    throw new Error("EVENT_PUBLISH_VERIFICATION_FAILED");
  }

  return bundle;
}
