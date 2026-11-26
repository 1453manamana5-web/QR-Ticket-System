export type Stage = "prepare" | "trial" | "open" | "restricted" | "closing" | "finished";
export type Command = "trial" | "prepare" | "open" | "restrict" | "unrestrict" | "close" | "reopen" | "finish" | "verify" | "unverify";
export type DaySchedule = {date:string;start:string;end:string};
export type DayState = {
  stage:Stage; opened:number|null; trialOpened:number|null; closing:number|null; ended:number|null;
  emptyConfirmed:number|null; finalized:number|null;
};
export type Day = DaySchedule & DayState & {id:string;eventId:string;version:number};
export const emptyDay: DayState = {stage:"prepare",opened:null,trialOpened:null,closing:null,ended:null,emptyConfirmed:null,finalized:null};

export const stageLabels: Record<Stage,string> = {
  prepare:"開催準備中",trial:"試験運用中",open:"開場中",restricted:"入場制限中",closing:"閉場処理中",finished:"開催日終了",
};
export const commandLabels: Record<Command,string> = {
  trial:"試験運用を開始",prepare:"準備に戻る",open:"開場する",restrict:"入場を一時制限",unrestrict:"入場制限を解除",
  close:"閉場処理へ進む",reopen:"閉場処理を取り消す",finish:"開催日を終了",verify:"集計を確定",unverify:"集計確定を取り消す",
};
const available: Record<Stage,Command[]> = {
  prepare:["trial","open"],trial:["prepare","open"],open:["restrict","close"],restricted:["unrestrict","close"],
  closing:["reopen","finish"],finished:["verify"],
};
export function actionsFor(day:DayState): Command[] {
  return day.finalized !== null ? [] : available[day.stage];
}

export function scheduleValid(day:DaySchedule) {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !time.test(day.start) || !time.test(day.end) || day.start >= day.end) return false;
  const date = new Date(day.date + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === day.date;
}

export function transition(day:DayState, command:Command, now:number, review={empty:false,synced:false}): DayState {
  if (!Number.isSafeInteger(now) || now < 0 || !(command==="unverify" ? day.stage==="finished"&&day.finalized!==null : actionsFor(day).includes(command))) throw new Error("現在の運用状態では実行できません。");
  if (now < Math.max(day.opened ?? 0,day.trialOpened ?? 0,day.closing ?? 0,day.ended ?? 0)) throw new Error("管理端末の時刻を確認してください。");
  switch (command) {
    case "trial": return {...day,stage:"trial",trialOpened:day.trialOpened ?? now};
    case "prepare": return {...day,stage:"prepare"};
    case "open": return {...day,stage:"open",opened:now};
    case "restrict": return {...day,stage:"restricted"};
    case "unrestrict": return {...day,stage:"open"};
    case "close": return {...day,stage:"closing",closing:now};
    case "reopen": return {...day,stage:"open",closing:null};
    case "finish":
      if (!review.empty) throw new Error("会場内を確認してから開催日を終了してください。");
      return {...day,stage:"finished",ended:now,emptyConfirmed:now};
    case "unverify": return {...day,finalized:null};
    case "verify":
      if (!review.empty || !review.synced) throw new Error("会場が空で、記録の回収と整合性確認を終えてから確定してください。");
      return {...day,finalized:now};
  }
}

/** Translate operating status into the existing station control contract. */
export function stationConfig(day:DayState,mode:"live"|"test") {
  if (mode === "test") return {opened:day.trialOpened,closed:null,paused:day.stage!=="trial",verified:false};
  return {opened:day.opened,closed:day.ended,paused:!(["open","restricted","closing"] as Stage[]).includes(day.stage),
    verified:day.finalized!==null};
}
