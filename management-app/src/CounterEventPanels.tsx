import {useEffect,useState,type FormEvent} from "react";
import {actionsFor,commandLabels,scheduleValid,stageLabels,type Command,type Day,type DaySchedule} from "./counterLifecycle";
import type {CounterSeries} from "./counterEvents";
import type {CounterStation} from "./counterManagementData";

export type EventDraft = {name:string;venue:string;days:DaySchedule[]};
export type LuxnoraSuggestion = {name?:string;venue?:string;start?:string;end?:string;sourceDate?:string};
export type LuxnoraEventProvider = (draft:EventDraft) => Promise<LuxnoraSuggestion | null>;
const blank = ():DaySchedule => ({date:"",start:"09:00",end:"16:00"});
const initial = ():EventDraft => ({name:"",venue:"",days:[blank()]});

function readDraft(key:string): EventDraft {
  try {
    const value=JSON.parse(sessionStorage.getItem(key) ?? "null");
    if (value && typeof value.name==="string" && typeof value.venue==="string" && Array.isArray(value.days) &&
      value.days.length>=1 && value.days.length<=7 && value.days.every((d:DaySchedule)=>
        d && [d.date,d.start,d.end].every(field => typeof field==="string"))) return value;
  } catch { /* a private browser can restrict session storage */ }
  return initial();
}

export function NewCounterEvent({owner,busy,onSave,onClose,provider}:{
  owner:string;busy:boolean;onSave:(draft:EventDraft)=>Promise<boolean>;onClose:()=>void;provider?:LuxnoraEventProvider;
}) {
  const key="counter-event-draft:"+owner;
  const [draft,setDraft]=useState(()=>readDraft(key));
  const [suggestion,setSuggestion]=useState<LuxnoraSuggestion|null>(null);
  const [note,setNote]=useState("");
  const [draftSaved,setDraftSaved]=useState(false);
  useEffect(()=>{
    try { sessionStorage.setItem(key,JSON.stringify(draft)); setDraftSaved(true); }
    catch { setDraftSaved(false); }
  },[key,draft]);
  function dayField(index:number,key:keyof DaySchedule,value:string) {
    setDraft(prior => ({...prior,days:prior.days.map((day,i)=>i===index ? {...day,[key]:value} : day)}));
  }
  function take(field:Exclude<keyof LuxnoraSuggestion,"sourceDate">,index?:number) {
    if (!suggestion || !suggestion[field]) return;
    if (field==="name" || field==="venue") setDraft(prior=>({...prior,[field]:suggestion[field]}));
    else dayField(index ?? 0,field,suggestion[field]);
    setSuggestion(prior=>({...prior,[field]:undefined}));
  }
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!draft.days.every(scheduleValid) || new Set(draft.days.map(day=>day.date)).size!==draft.days.length) {
      return setNote("開催日を重複させず、閉場予定を開場予定より後に設定してください。");
    }
    setNote("");
    if (await onSave(draft)) { try { sessionStorage.removeItem(key); } catch { /* storage optional */ } }
  }
  const suggest=(field:Exclude<keyof LuxnoraSuggestion,"sourceDate">,index?:number)=> suggestion?.[field] && <p className="cm-caption">
    Luxnoraの提案 {suggestion[field]} <button type="button" onClick={()=>take(field,index)}>適用</button>{" "}
    <button type="button" onClick={()=>setSuggestion(prior=>({...prior,[field]:undefined}))}>使わない</button>
  </p>;
  return <section className="cm-section cm-create">
    <div className="cm-section-top"><div><h2>イベントを新規作成</h2><p className="cm-caption">{draftSaved?"このタブに下書きを保存済み":"現在の表示に下書きがあります"}</p></div>
      <button type="button" onClick={onClose}>閉じる</button></div>
    <form onSubmit={submit}>
      <div className="cm-form cm-basic">
        <label>イベント名<input autoFocus required maxLength={100} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/>{suggest("name")}</label>
        <label>会場名<input required maxLength={100} value={draft.venue} onChange={e=>setDraft({...draft,venue:e.target.value})}/>{suggest("venue")}</label>
      </div>
      {draft.days.map((day,index)=><fieldset className="cm-day-row" key={index}><legend>開催日 {index+1}</legend>
        <label>日付<input required type="date" value={day.date} onChange={e=>dayField(index,"date",e.target.value)}/></label>
        <label>開場予定<input required type="time" value={day.start} onChange={e=>dayField(index,"start",e.target.value)}/>{index===0&&suggest("start",index)}</label>
        <label>閉場予定<input required type="time" value={day.end} onChange={e=>dayField(index,"end",e.target.value)}/>{index===0&&suggest("end",index)}</label>
        {draft.days.length>1&&<button type="button" onClick={()=>setDraft(prior=>({...prior,days:prior.days.filter((_,i)=>i!==index)}))}>この日を外す</button>}
      </fieldset>)}
      {suggestion?.sourceDate&&<p className="cm-caption">参考にした開催日 {suggestion.sourceDate}</p>}
      {note&&<p className="cm-warning" role="alert">{note}</p>}
      <div className="cm-form">
        <button type="button" disabled={draft.days.length>=7} onClick={()=>setDraft(prior=>({...prior,days:[...prior.days,blank()]}))}>開催日を追加</button>
        {provider&&<button type="button" onClick={()=>{void provider(structuredClone(draft)).then(value=>{
          setSuggestion(value);setNote(value?"":"該当する確定済みの開催実績がありません。");
        }).catch(()=>setNote("Luxnoraの提案を受け取れませんでした。"));}}>Luxnoraの提案を確認</button>}
        <button className="cm-primary" disabled={busy}>{busy?"保存中":"イベントを作成"}</button>
      </div>
    </form>
  </section>;
}
export function CounterDayPanel({day,canOperate,stations,synced,now,onAction,goStations,openTest,proposal,proposalId}:{
  day:Day; proposal?:"open"|"close";proposalId?:number;canOperate:boolean; stations:CounterStation[]; synced:boolean; now:number;
  onAction:(command:Command,review:{empty:boolean;synced:boolean})=>void;goStations:()=>void;openTest:()=>void;
}) {
  const [requested,setRequested]=useState<Command|null>(null);
  const [empty,setEmpty]=useState(false);
  const [proposalUnavailable,setProposalUnavailable]=useState(false);
  const [fromLuxnora,setFromLuxnora]=useState(false);
  useEffect(()=>{
    if (!proposal) {
      if(fromLuxnora) {setRequested(null);setProposalUnavailable(false);setFromLuxnora(false);}
      return;
    }
    setFromLuxnora(true);
    setEmpty(false);
    const available=actionsFor(day).includes(proposal);
    setRequested(available?proposal:null);
    setProposalUnavailable(!available);
  },[proposal,proposalId,day.stage,day.finalized,fromLuxnora]);
  const roles=["in","out"] as const;
  const stamp=(value:number|null)=>value===null?"—":new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"short",timeStyle:"short"}).format(value);
  const choose=(action:Command)=>{setEmpty(false);setRequested(action);setProposalUnavailable(false);setFromLuxnora(false);};
  return <section className="cm-section cm-operation">
    <div className="cm-section-top"><div><h2>{stageLabels[day.stage]}</h2><p className="cm-caption">開催日 {day.date}　予定 {day.start} – {day.end}</p></div>
      {day.stage==="trial" && <button onClick={openTest}>試験集計を見る</button>}
    </div>
    {(day.stage==="prepare"||day.stage==="trial")&&<div className="cm-prep">
      <ul>{roles.map(role=>{
        const station=stations.find(s=>s.role===role&&s.status==="approved");
        const label=role==="in"?"入口":"出口";
        const tracked=station?.lastSeen!==undefined&&now-station.lastSeen<=180000;
        return <li key={role}><span>{label}端末</span><strong>{station?tracked?"通信を確認済み":"登録済み・通信未確認":"登録を確認できません"}</strong></li>;
      })}</ul>
      <button onClick={goStations}>端末登録を確認</button>
      <p className="cm-caption">計測端末のプレビューで、カメラの向きとA・Bを確認してください。試験では正方向・逆方向・連続通過・横並び・荷物を確認できます。</p>
    </div>}
    {day.stage==="closing"&&<p className="cm-warning">計測は継続中です。会場内と退場を確認し、各端末が同期したか確認してください。</p>}
    {day.stage==="finished"&&<p className={day.finalized!==null?"cm-notice":"cm-warning"}>{day.finalized!==null?"集計確定":"暫定集計。未回収の記録は、同期され次第反映されます。"}</p>}
    <dl className="cm-event-times">
      <div><dt>実際の開場</dt><dd>{stamp(day.opened)}</dd></div><div><dt>閉場処理の開始</dt><dd>{stamp(day.closing)}</dd></div>
      <div><dt>退場・会場の確認</dt><dd>{stamp(day.emptyConfirmed)}</dd></div><div><dt>開催日の終了</dt><dd>{stamp(day.ended)}</dd></div>
      <div><dt>集計確定</dt><dd>{stamp(day.finalized)}</dd></div>
    </dl>
    {proposalUnavailable&&<p className="cm-warning">現在の開催状態では、その操作を実行できません。</p>}
    {!requested&&<div className="cm-form">{actionsFor(day).map(action=><button key={action} disabled={!canOperate || (action==="verify"&&!synced)} onClick={()=>choose(action)}>{commandLabels[action]}</button>)}</div>}
    {requested&&<div className="cm-confirm" role="group" aria-label={commandLabels[requested]}>
      <strong>{commandLabels[requested]}</strong>
      {requested==="restrict"&&<p>入場制限中も計測は続きます。来場者への案内は現地で行ってください。</p>}
      {requested==="close"&&<p>退場を数えるため、計測は開催日を終了するまで続きます。</p>}
      {requested==="finish"&&<p>終了後は暫定集計になります。遅れて届いた記録を確認した後に確定できます。</p>}
      {(requested==="finish"||requested==="verify")&&<label className="cm-check"><input type="checkbox" checked={empty} onChange={event=>setEmpty(event.target.checked)}/>会場内を確認し、対象の来場者がいないことを確認した</label>}
      <div className="cm-form"><button className="cm-primary" disabled={!canOperate||((requested==="finish"||requested==="verify")&&!empty)} onClick={()=>{
        onAction(requested,{empty,synced});setRequested(null);
      }}>確定する</button><button onClick={()=>setRequested(null)}>戻る</button></div>
    </div>}
  </section>;
}


export function CounterScheduleEditor({series,day,enabled,onSave,suggestion,suggestionId}: {
  series:CounterSeries;day:Day;enabled:boolean;suggestion?:{field:"start"|"end";time:string};suggestionId?:number;onSave:(value:{name:string;venue:string;start:string;end:string})=>void;
}) {
  const [expanded,setExpanded]=useState(false),[start,setStart]=useState(day.start),[end,setEnd]=useState(day.end);
  const [proposed,setProposed]=useState(false);
  useEffect(()=>{
    if(!suggestion) {
      if(proposed){setProposed(false);setStart(day.start);setEnd(day.end);}
      return;
    }
    setProposed(true);
    setExpanded(true);
    if(day.stage==="prepare") {
      if(suggestion.field==="start") setStart(suggestion.time);
      else setEnd(suggestion.time);
    }
  },[suggestion,suggestionId,day.stage,day.start,day.end,proposed]);
  return <details className="cm-section" open={expanded} onToggle={event=>setExpanded(event.currentTarget.open)}><summary>イベント情報と予定時刻</summary>
    {suggestion&&day.stage!=="prepare"&&<p className="cm-warning">予定時刻は準備中の開催日で変更できます。</p>}
    <form className="cm-form" onSubmit={event=>{
      event.preventDefault();const form=new FormData(event.currentTarget);
      const value = {name:String(form.get("name")).trim(),venue:String(form.get("venue")).trim(),
        start:String(form.get("start")??day.start),end:String(form.get("end")??day.end)};
      if (enabled) onSave(value);
    }}>
      <label>イベント名<input name="name" required maxLength={100} defaultValue={series.name} disabled={!enabled}/></label>
      <label>会場名<input name="venue" required maxLength={100} defaultValue={series.venue} disabled={!enabled}/></label>
      <label>開場予定<input name="start" type="time" required value={start} onChange={e=>setStart(e.target.value)} disabled={!enabled||day.stage!=="prepare"}/></label>
      <label>閉場予定<input name="end" type="time" required value={end} onChange={e=>setEnd(e.target.value)} disabled={!enabled||day.stage!=="prepare"}/></label>
      <button className="cm-primary" disabled={!enabled}>変更を保存</button>
    </form>
  </details>;
}
