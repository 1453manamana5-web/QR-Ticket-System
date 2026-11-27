import type {Plan} from "./language";
import type {Forecast} from "./forecast";
import type {CounterConfig,CounterStation} from "../counterManagementData";
import type {Day} from "../counterLifecycle";
import {signals} from "../../../reception-app/public/people-counter/luxnora-core.mjs";

export type Evidence={
  name:string;mode:"live"|"test"; now:number; current:boolean; config:CounterConfig|null;day?:Day|null;
  analysis:ReturnType<typeof import("../counterManagementData").analyze>|null; stations:CounterStation[]; prediction:Forecast;
};
export type Target="graph"|"compare"|"event"|"records"|"stations"|"in"|"out";
export type Answer={text:string;target?:Target;plan?:Plan};
const roles={in:"入口",out:"出口"};
const jst=(at:number)=>new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(at);
const scopeName=(data:Evidence)=>data.name+"（"+(data.mode==="test"?"試験":"本番")+"）";
export function diagnose(station:CounterStation,now:number) {
  if (station.lastSeen==null||now-station.lastSeen>180000) return "最終通信を更新できていません。端末の現在の状態は未確認です。";
  if(station.alert==="storage") return signals.storage+"のエラーが報告されました。端末の画面と保存状態を確認してください。";
  if(station.alert==="camera") return signals.camera+"の異常が報告されました。設置とカメラの許可を確認してください。";
  if(station.alert==="network") return signals.network+"の異常が報告されました。未同期記録の件数を確認してください。";
  if(station.alert==="recalibrate") return "認識環境の変化が報告されました。通過試験で設定を再確認してください。";
  if(station.alert==="paused"||station.alert==="setup") return "停止中、または設置・運用設定の確認待ちです。";
  if(station.camera==null||station.ai==null) return "カメラと認識の状態は未取得です。";
  return "カメラ"+(station.camera?"稼働":"停止")+"、AI"+(station.ai?"稼働":"停止")+"、未同期"+(station.pending??"未確認")+"件です。";
}
export function luxRange(period:Plan["period"],opened:number,end:number) {
  const midnight=Math.floor((opened+32400000)/86400000)*86400000-32400000;
  const boundary=midnight+43200000;
  const range=typeof period==="object"?period:undefined;
  const from=range?Math.max(opened,midnight+range.from*60000):period==="pm"?Math.max(opened,boundary):
    typeof period==="number"?Math.max(opened,end-period*60000):opened;
  const to=range?Math.min(end,midnight+range.to*60000):period==="am"?Math.min(end,boundary):end;
  const untilExclusive=(range!==undefined&&to===midnight+range.to*60000)||(period==="am"&&to===boundary);
  return {from,to,untilExclusive,midnight,range};
}
export function answer(plan:Plan,data:Evidence):Answer {
  const {analysis,stations,now,config,day,prediction}=data;
  const known=stations.filter(station=>station.mode===data.mode&&station.status==="approved");
  const confidence=data.current?"":"端末状態または同期を確認できていないため、取得済みの値です。";
  if(plan.intent==="routine") return {text:"開いている間、端末の通信・保存エラー・未同期件数を最長15分間確認できます。"};
  if(plan.intent==="stations") {
    const devices=known.filter(station=>!plan.role||station.role===plan.role);
    return {target:plan.focus?(plan.role??"stations"):undefined,
      text:devices.length?devices.map(station=>roles[station.role]+"「"+station.name+"」 "+diagnose(station,now)).join("\n"):
        "選択中の運用区分で状態を取得できる"+(plan.role?roles[plan.role]:"承認済み")+"端末がありません。"};
  }
  if(plan.intent==="event") return {target:"event",plan,text:plan.schedule?
    (plan.schedule.field==="start"?"開場":"閉場")+"予定 "+plan.schedule.time+" を候補として表示します。内容を確認して保存してください。":
    plan.operation?"現在の開催状態で操作できる場合、イベント管理に確認画面を表示します。":
    "イベント管理を表示します。重要な操作は画面上の確認を経て確定できます。"};
  if(plan.intent==="records") return {target:"records",text:"選択中の開催日の通過記録を表示します。"};
  if(plan.intent==="compare") return {target:"compare",text:"年度比較を表示します。比較する年度とイベントを選ぶと、本番の通過記録と開場1時間あたりの入場回数を確認できます。差の原因を通過記録だけから特定することはできません。"};
  if(plan.intent==="readiness") {
    const missing=(["in","out"] as const).filter(role=>!stations.some(row=>row.role===role&&row.status==="approved"));
    const failed=stations.some(row=>row.status==="approved"&&(row.lastSeen==null||now-row.lastSeen>180000||row.alert==="storage"||row.alert==="camera"));
    return {target:"event",text:!day?"開催日を選ぶと準備状況を確認できます。":(missing.length?
      missing.map(role=>roles[role]).join("・")+"の承認済み端末がありません。":failed?
      "承認済み端末の通信または診断結果を確認してください。":"入口と出口は割り当て済みです。")+
      " 開場前に両端末の方向・試験通過・空室を現地で確認してください。"};
  }
  if(plan.intent==="forecast") return {target:"graph",text:prediction.length?
    prediction.map(point=>jst(point.at)+"頃の滞在 約"+point.occupancy+"人（目安 "+point.low+"〜"+point.high+"人）、累計入場 約"+point.entries+"回。").join("\n")
    :"予測を表示できません。開場中で安定した両端末の通信と、直近20分の通過記録が必要です。"};
  if(plan.intent==="graph") return {target:"graph",plan,text:plan.period!==undefined?
    "指定した時間帯のグラフを表示します。":"選択中の開催日のグラフを表示します。"};
  if(!analysis||config?.opened==null) return {text:"集計できる開催日の記録をまだ取得できていません。イベントと試験・本番の区分を確認してください。"};
  if(plan.intent==="issues") return {text:scopeName(data)+"の整合性の指摘 "+analysis.issues.length+"件。"+
    (analysis.issues.length?[...new Set(analysis.issues.map(row=>row.code))].join("、")+"。":" ") + confidence};
  const {from,to,untilExclusive,midnight,range}=luxRange(plan.period,config.opened,Math.min(now,config.closed??Infinity));
  const included=(at:number)=>at<=to&&!(untilExclusive&&at===to);
  const period=range?jst(midnight+range.from*60000)+"〜"+jst(midnight+range.to*60000):
    plan.period==="am"?"午前":plan.period==="pm"?"午後":typeof plan.period==="number"?"直近"+plan.period+"分":"";
  if(period&&from>=to) return {text:"指定時間と開場時間が重なっていません。"};
  if(period&&plan.intent==="dwell") return {text:"時間帯だけの平均滞在時間は、個別の入退場を対応付けていないため算出できません。開催日全体の平均を確認できます。"};
  const value=analysis.effective.filter(row=>row.at>=from&&included(row.at)&&row.person==="visitor"&&!row.invalid);
  const entries=period?value.filter(row=>row.direction==="in").length:analysis.entries;
  const exits=period?value.filter(row=>row.direction==="out").length:analysis.exits;
  const occupancy=period?(analysis.timeline.filter(row=>included(row.at)).at(-1)?.occupancy??0):analysis.occupancy;
  const average=analysis.sumAverage??(data.current?analysis.estimate:null);
  const messages={occupancy:(period?"期間終了時の":"現在の")+"滞在 "+occupancy+"人。",
    entries:"入場 "+entries+"回（再入場を含む）。",exits:"退場 "+exits+"回。",
    dwell:average==null?"平均滞在時間は算出できません。":"平均滞在 "+(average/60000).toFixed(1)+"分（"+(analysis.sumAverage==null?"暫定":"確定")+"）。",
    briefing:"入場 "+entries+"回、退場 "+exits+"回、滞在 "+occupancy+"人。整合性の指摘 "+analysis.issues.length+"件。"};
  return {text:scopeName(data)+(period?" "+period:"")+"。"+messages[plan.intent]+" "+confidence};
}

export function watchAlerts(data:Evidence,role?:Plan["role"]) {
  const labels:string[]=[];
  for(const side of (role?[role]:["in","out"] as const)) {
    const station=data.stations.find(row=>row.role===side&&row.mode===data.mode&&row.status==="approved");
    if(!station||station.lastSeen==null||data.now-station.lastSeen>180000) labels.push(roles[side]+"の通信を現在確認できません。");
    else if(station.alert==="camera"||station.alert==="storage"||station.alert==="network"||station.alert==="recalibrate")
      labels.push(roles[side]+" "+diagnose(station,data.now));
    else if(station.pending!=null&&station.pending>0) labels.push(roles[side]+"に未同期 "+station.pending+"件。");
  }
  return labels;
}
