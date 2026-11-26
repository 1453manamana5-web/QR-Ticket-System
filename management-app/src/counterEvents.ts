import {collection,doc,getDocsFromServer,onSnapshot,runTransaction,serverTimestamp,writeBatch} from "firebase/firestore";
import {getFirebaseDb,getFirebaseUid} from "../../reception-app/src/firebaseClient";
import {emptyDay,scheduleValid,stationConfig,transition,stageLabels,type Day,type DaySchedule,type Command} from "./counterLifecycle";

export type CounterSeries = {id:string;name:string;venue:string};
export type SeriesAndDays = {series:CounterSeries[];days:Day[]};
const scopeId = (eventId:string,date:string) => eventId+"_"+date;
const audit = (uid:string) => ({updatedByUid:uid,updatedAt:serverTimestamp()});
function readDay(id:string,data:Record<string,unknown>|undefined): Day | null {
  if (!data || typeof data.eventId!=="string" || !(String(data.stage) in stageLabels) || !Number.isSafeInteger(data.version)) return null;
  const schedule = {date:String(data.date),start:String(data.start),end:String(data.end)};
  if (!scheduleValid(schedule) || id!==scopeId(data.eventId,schedule.date)) return null;
  for (const key of ["opened","trialOpened","closing","ended","emptyConfirmed","finalized"]) {
    if (data[key] !== null && !Number.isSafeInteger(data[key])) return null;
  }
  return {...(data as Omit<Day,"id">),id};
}

export async function listCounterSeries(): Promise<SeriesAndDays> {
  const db = getFirebaseDb();
  const [events,days] = await Promise.all([getDocsFromServer(collection(db,"counterEvents")),getDocsFromServer(collection(db,"counterDays"))]);
  const series = events.docs.flatMap(row => {
    const {name,venue} = row.data();
    return typeof name==="string" && typeof venue==="string" ? [{id:row.id,name,venue}] : [];
  });
  return {series,days:days.docs.flatMap(row => {
    const day = readDay(row.id,row.data()); return day ? [day] : [];
  })};
}

export function watchCounterDay(id:string, next:(data:Day|null,verified:boolean)=>void, error:(cause:unknown)=>void) {
  return onSnapshot(doc(getFirebaseDb(),"counterDays",id),{includeMetadataChanges:true},snap =>
    next(readDay(snap.id,snap.data()), !snap.metadata.fromCache && !snap.metadata.hasPendingWrites),error);
}

export async function createCounterSeries(details:{name:string;venue:string;days:DaySchedule[]}) {
  const name=details.name.trim(),venue=details.venue.trim(),schedules=details.days;
  if (!name || name.length>100 || !venue || venue.length>100 || !schedules.length || schedules.length>7 ||
      !schedules.every(scheduleValid) || new Set(schedules.map(d=>d.date)).size!==schedules.length) {
    throw new Error("イベント名、会場、日程を確認してください。同じ開催日は一度だけ入力できます。");
  }
  const uid=await getFirebaseUid(),db=getFirebaseDb(),id=crypto.randomUUID();
  const batch=writeBatch(db);
  batch.set(doc(db,"counterEvents",id),{name,venue,...audit(uid)});
  for (const schedule of schedules) {
    const dayId=scopeId(id,schedule.date);
    batch.set(doc(db,"counterDays",dayId),{eventId:id,...schedule,...emptyDay,version:0,operation:"",...audit(uid)});
    for (const mode of ["live","test"] as const) {
      batch.set(doc(db,"events",dayId,"counterConfig",mode),{...stationConfig(emptyDay,mode),version:0,...audit(uid)});
    }
  }
  await batch.commit();
  return scopeId(id,[...schedules].sort((a,b)=>a.date.localeCompare(b.date))[0].date);
}

export async function operateCounterDay(id:string, expected:number, command:Command, review:{empty:boolean;synced:boolean}) {
  const uid=await getFirebaseUid(),db=getFirebaseDb(),op=crypto.randomUUID();
  const ref=doc(db,"counterDays",id);
  await runTransaction(db,async transaction=>{
    const snap=await transaction.get(ref), current=readDay(id,snap.data());
    if (!current || current.version!==expected) throw new Error("他の管理端末で状態が更新されました。最新の表示を確認してください。");
    const {id:_id,...fields}=current;
    const next=transition(current,command,Date.now(),review);
    const version=current.version+1;
    const {stage,opened,trialOpened,closing,ended,emptyConfirmed,finalized}=next;
    transaction.set(ref,{eventId:fields.eventId,date:fields.date,start:fields.start,end:fields.end,
      stage,opened,trialOpened,closing,ended,emptyConfirmed,finalized,version,operation:op,...audit(uid)});
    transaction.set(doc(db,"counterDays",id,"actions",op),{from:current.stage,to:stage,command,version,...audit(uid)});
    for (const mode of ["live","test"] as const) {
      transaction.set(doc(db,"events",id,"counterConfig",mode),{...stationConfig(next,mode),version,...audit(uid)});
    }
  });
}


export async function editCounterSchedule(series:CounterSeries, day:Day, fields:{name:string;venue:string;start:string;end:string}) {
  const {start,end}=fields,name=fields.name.trim(),venue=fields.venue.trim();
  if (!name || name.length>100 || !venue || venue.length>100 || !scheduleValid({...day,start,end}))
    throw new Error("イベント情報と開場・閉場予定を確認してください。");
  const uid=await getFirebaseUid(),db=getFirebaseDb();
  await runTransaction(db,async tx=>{
    const eventRef=doc(db,"counterEvents",series.id),dayRef=doc(db,"counterDays",day.id);
    const oldEvent=(await tx.get(eventRef)).data(),oldDay=readDay(day.id,(await tx.get(dayRef)).data());
    if (!oldDay || !oldEvent || oldEvent.name!==series.name || oldEvent.venue!==series.venue || oldDay.version!==day.version ||
      oldDay.start!==day.start || oldDay.end!==day.end) throw new Error("他の管理端末が設定を変更しました。");
    if ((oldDay.start!==start || oldDay.end!==end) && oldDay.stage!=="prepare") throw new Error("準備中の予定のみ編集できます。");
    if (oldEvent.name!==name || oldEvent.venue!==venue) tx.update(eventRef,{name,venue,...audit(uid)});
    if (oldDay.start!==start || oldDay.end!==end) tx.update(dayRef,{start,end,...audit(uid)});
  });
}
