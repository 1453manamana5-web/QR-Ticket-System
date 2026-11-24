import { collection, doc, documentId, getDocFromServer, getDocsFromServer, limit, orderBy,
  query, runTransaction, serverTimestamp, startAfter, Timestamp, type QueryConstraint } from "firebase/firestore";
import { ensureFirebaseAuth, getFirebaseDb } from "./firebaseClient";

type Operation = {id: string; eventId: string; mode: string; synced?: boolean};
type Cursor = {seconds: number; nanoseconds: number; id: string};

export async function serverClock() {
  const auth = await ensureFirebaseAuth();
  const db = getFirebaseDb();
  const ref = doc(db, "counterClocks", auth.currentUser!.uid);
  await runTransaction(db, async tx => {
    await tx.get(ref);
    tx.set(ref, {at: serverTimestamp()});
  }, {maxAttempts: 1});
  const at = (await getDocFromServer(ref)).get("at");
  if (!(at instanceof Timestamp)) throw new Error("サーバー時刻が取得できません");
  return at.toMillis();
}

export async function pushOperations(eventId: string, mode: string, rows: Operation[]) {
  await ensureFirebaseAuth();
  const db = getFirebaseDb();
  const refs = rows.map(row => doc(db, "events", eventId, "counterRuns", mode, "operations", row.id));
  await runTransaction(db, async tx => {
    const existing = await Promise.all(refs.map(ref => tx.get(ref)));
    for (const [index, {synced: _synced, ...row}] of rows.entries()) {
      const payload = JSON.stringify(row);
      if (existing[index].exists()) {
        if (existing[index].get("payload") !== payload) throw new Error("同じIDに異なる記録があります");
      } else tx.set(refs[index], {payload, receivedAt: serverTimestamp()});
    }
  });
}

export async function pullOperations(eventId: string, mode: string, cursor?: Cursor) {
  await ensureFirebaseAuth();
  const source = collection(getFirebaseDb(), "events", eventId, "counterRuns", mode, "operations");
  const constraints: QueryConstraint[] = [orderBy("receivedAt"), orderBy(documentId()), limit(200)];
  if (cursor) constraints.push(startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.id));
  const page = await getDocsFromServer(query(source, ...constraints));
  const rows = page.docs.map(snapshot => {
    const row = JSON.parse(snapshot.get("payload"));
    if (row.id !== snapshot.id || row.eventId !== eventId || row.mode !== mode) throw new Error("同期データのイベントまたはIDが不正です");
    return row;
  });
  const last = page.docs.at(-1);
  const at = last?.get("receivedAt") as Timestamp | undefined;
  return {rows, cursor: last && at ? {seconds: at.seconds, nanoseconds: at.nanoseconds, id: last.id} : cursor};
}
