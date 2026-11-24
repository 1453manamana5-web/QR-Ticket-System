import { onAuthStateChanged } from "firebase/auth";
import { collection, doc, getDocFromServer, getDocsFromServer } from "firebase/firestore";
import { ensureFirebaseAuth, getFirebaseDb } from "../../reception-app/src/firebaseClient";

export type CounterManager = {uid: string; terminalId: string; role: "admin" | "subAdmin"; name: string};
export type CounterEvent = {id: string; name: string; date: string; start: string};

const denied = () => Object.assign(new Error("承認済みの管理者・副管理者の端末を使用してください。"), {code:"permission-denied"});

export async function verifyManager(): Promise<CounterManager> {
  const auth = await ensureFirebaseAuth();
  const uid = auth.currentUser?.uid;
  if (!uid) throw denied();
  const db = getFirebaseDb();
  const grant = (await getDocFromServer(doc(db,"terminalInstallations",uid))).data();
  if (!grant || grant.authUid !== uid || grant.approved !== true || typeof grant.terminalId !== "string") throw denied();
  const terminalId = grant.terminalId;
  const [terminalDoc, ownerDoc] = await Promise.all([
    getDocFromServer(doc(db,"terminals",terminalId)), getDocFromServer(doc(db,"terminalOwners",terminalId)),
  ]);
  const terminal = terminalDoc.data(), owner = ownerDoc.data();
  if (auth.currentUser?.uid !== uid || owner?.enabled !== true || owner.ownerUid !== uid ||
      terminal?.approved !== true || terminal.managementApproved !== true ||
      !["management","both"].includes(terminal.role) || (terminal.admin !== true && terminal.subAdmin !== true)) throw denied();
  return {uid,terminalId,role:terminal.admin === true ? "admin" : "subAdmin",
    name:typeof terminal.name === "string" ? terminal.name : "認証済み端末"};
}

export async function watchCounterAuth(change: (uid: string | null) => void) {
  return onAuthStateChanged(await ensureFirebaseAuth(), user => change(user?.uid ?? null));
}

export async function counterEvents(): Promise<CounterEvent[]> {
  const snapshot = await getDocsFromServer(collection(getFirebaseDb(),"events"));
  return snapshot.docs.map(row => {
    const data = row.data();
    return {id:row.id, name:typeof data.eventName === "string" && data.eventName.trim() ? data.eventName : row.id,
      date:typeof data.eventDate === "string" ? data.eventDate : "", start:typeof data.startTime === "string" ? data.startTime : ""};
  }).sort((a,b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name,"ja"));
}

export function permissionDenied(error: unknown) {
  return /permission-denied|unauthenticated/.test((error as {code?: string} | null)?.code ?? "");
}

export async function bounded<T>(promise: Promise<T>, ms = 12000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise,new Promise<never>((_,reject) => {
      timer = setTimeout(() => reject(new Error("サーバーから応答がありません。接続を確認してください。")),ms);
    })]);
  } finally {clearTimeout(timer);}
}
