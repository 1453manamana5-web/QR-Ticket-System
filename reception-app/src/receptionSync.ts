import { doc, setDoc } from "firebase/firestore";
import type { ReceptionRecord, Ticket } from "@qr-ticket-system/shared";
import { getFirebaseDb } from "./firebaseClient";

export async function syncReceptionRecord(record: ReceptionRecord, ticket: Ticket): Promise<void> {
  const db = getFirebaseDb();
  await setDoc(doc(db, "events", record.eventId, "tickets", ticket.ticketId), ticket, { merge: true });
  await setDoc(doc(db, "events", record.eventId, "receptionRecords", record.recordId), record, { merge: true });
}
