import { collection, doc, getDoc, getDocFromServer, getDocs, getDocsFromServer, setDoc, updateDoc, runTransaction } from "firebase/firestore";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import {receptionDataCollected, type ReceptionTerminalState} from "./operationSafety";
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
      typeof data.ticketCount !== "number") return null;

  // チケット一覧はサイズ制限のある単一バンドルではなく、イベント配下の一覧を正本にする。
  const savedTickets = await getDocsFromServer(collection(db, "events", eventId, "tickets"));
  let tickets = savedTickets.docs.map(item => item.data() as Ticket);
  // 旧形式のバンドルだけにチケットが残っている場合は互換用に復元する。
  if (tickets.length === 0 && data.ticketCount !== 0 && Array.isArray(data.tickets) && data.tickets.length > 0) {
    tickets = data.tickets;
  }
  return { ...data, tickets, ticketCount: tickets.length } as PublishedEventBundle;
}

export async function saveEventMetadata(event: Event, onlyIfMissing = false): Promise<void> {
  const db = getFirebaseDb();
  const ref = doc(db,"events",event.eventId);
  await runTransaction(db,async tx=>{
    const existing=await tx.get(ref);
    if(existing.exists()){
      if(onlyIfMissing)return;
      throw new Error("EVENT_ALREADY_EXISTS");
    }
    tx.set(ref,{...event,updatedAt:new Date().toISOString()});
  });
}

export async function saveEventStatus(eventId: string, status: Event["eventStatus"]): Promise<void> {
  const db=getFirebaseDb(),ref=doc(db,"events",eventId);
  await runTransaction(db,async tx=>{
    const saved=await tx.get(ref);
    if(!saved.exists())throw new Error("EVENT_NOT_FOUND");
    if(saved.data().eventStatus==="finished" && status!=="finished")throw new Error("EVENT_FINISHED");
    tx.update(ref,{eventStatus:status,updatedAt:new Date().toISOString(),...(status==="finished"?{receptionTarget:false}:{})});
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
  _tickets: Ticket[],
): Promise<PublishedEventBundle> {
  if (event.eventStatus === "finished") throw new Error("EVENT_FINISHED");
  const db = getFirebaseDb();
  const authToken = createAuthToken();
  // Firestore is authoritative even when a stale UI still contains deleted tickets.
  const savedTicketsSnapshot = await getDocsFromServer(collection(db, "events", event.eventId, "tickets"));
  const publishedTickets = savedTicketsSnapshot.docs.map(item => item.data() as Ticket);
  // A stale UI/backup must never resurrect tickets deliberately removed on the server.
  const existingEvents = await getDocsFromServer(collection(db,"events"));
  const terminalList = await getDocsFromServer(collection(db,"terminals"));
  const eventRef=doc(db,"events",event.eventId);
  const eventRefs=new Map(existingEvents.docs.map(item=>[item.id,item.ref]));
  eventRefs.set(event.eventId,eventRef);
  const bundle = await runTransaction(db,async tx=>{
    const events = await Promise.all([...eventRefs.values()].map(ref=>tx.get(ref)));
    const terminals = await Promise.all(terminalList.docs.map(item=>tx.get(item.ref)));
    const previousTargets=events.filter(item=>item.exists()&&item.id!==event.eventId&&item.data().receptionTarget===true);
    if(previousTargets.length>448)throw new Error("TOO_MANY_RECEPTION_TARGETS");
    const terminalData=terminals.filter(item=>item.exists()).map(item=>({...item.data(),terminalId:item.id}) as ReceptionTerminalState);
    if(previousTargets.some(previous=>!receptionDataCollected(terminalData,previous.id)))throw new Error("RECEPTION_DATA_NOT_COLLECTED");
    const storedEvent=events.find(item=>item.id===event.eventId)?.data();
    if(!storedEvent)throw new Error("EVENT_NOT_FOUND");
    if(storedEvent?.eventStatus==="finished")throw new Error("EVENT_FINISHED");
    const savedVersion=Number.isSafeInteger(storedEvent?.dataVersion)?Number(storedEvent?.dataVersion):1;
    const savedStatus=storedEvent.eventStatus;
    const publishedEvent:Event={eventId:event.eventId,eventName:event.eventName,eventDate:event.eventDate,startTime:event.startTime,endTime:event.endTime,dataVersion:Math.max(1,event.dataVersion,savedVersion)+(storedEvent?.authToken?1:0),eventStatus:savedStatus==="active"||savedStatus==="finalizing"?savedStatus:"ready"};
    const ticketCount=Number.isSafeInteger(storedEvent?.ticketCount)?Number(storedEvent?.ticketCount):publishedTickets.length;
    const result:PublishedEventBundle={event:publishedEvent,settings,tickets:publishedTickets,ticketCount,authToken,publishedAt:new Date().toISOString()};
    for(const previous of previousTargets)tx.update(previous.ref,{receptionTarget:false,updatedAt:result.publishedAt});
    tx.set(doc(db,"eventBundles",authToken),{event:publishedEvent,settings,ticketCount,authToken,publishedAt:result.publishedAt});
    tx.set(eventRef,{...publishedEvent,authToken,receptionTarget:true,ticketCount,updatedAt:result.publishedAt},{merge:true});
    return result;
  });

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
