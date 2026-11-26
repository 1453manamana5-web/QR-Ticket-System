import {useEffect,useRef,useState} from "react";
import type {SeriesAndDays} from "./counterEvents";
import type {Day} from "./counterLifecycle";
import {readComparisonDays} from "./counterComparisonData";
import {aggregateComparison,fiscalYear,hourMs,type ComparisonDay} from "./counterComparisonMetrics";
import {csv} from "./counterManagementData";

type Dataset={key:string;name:string;title:string;days:Day[]};
type AnnualDataset=Dataset & {year:number};
type DisplayRow={key:string;title:string;days:ComparisonDay[]};
type Snapshot={at:number;groups:DisplayRow[]};
const dateTime=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",dateStyle:"short",timeStyle:"short"});
const numberText=new Intl.NumberFormat("ja-JP",{maximumFractionDigits:1});
const metric=(value:number|null)=>value===null?"—":numberText.format(value);

function datasets(catalog:SeriesAndDays):Dataset[] {
  const byEvent=new Map<string,Day[]>();
  for (const day of catalog.days) {
    const rows=byEvent.get(day.eventId)??[];
    rows.push(day);
    byEvent.set(day.eventId,rows);
  }
  return catalog.series.flatMap(series=>{
    const days=byEvent.get(series.id)?.sort((a,b)=>a.date.localeCompare(b.date));
    return days?.length?[{key:series.id,name:series.name,title:series.name+" · "+days[0].date,days}]:[];
  }).sort((a,b)=>b.days[0].date.localeCompare(a.days[0].date));
}

function annualDatasets(events:Dataset[]):AnnualDataset[] {
  return events.flatMap(event=>{
    const byYear=new Map<number,Day[]>();
    for (const day of event.days) {
      const year=fiscalYear(day.date),days=byYear.get(year)??[];
      days.push(day);
      byYear.set(year,days);
    }
    return [...byYear].map(([year,days])=>({key:year+"/"+event.key,name:event.name,
      title:year+"年度 · "+event.name+" · "+days[0].date,days,year}));
  }).sort((a,b)=>b.year-a.year);
}

function coverage(row:DisplayRow) {
  const summary=aggregateComparison(row.days);
  const unavailable=row.days.filter(day=>day.status==="unavailable").length;
  const unopened=row.days.filter(day=>day.status==="unopened").length;
  const provisional=summary.loaded-summary.verified;
  const state=[summary.verified?summary.verified+"日確定":"",provisional?provisional+"日暫定":"",
    unopened?unopened+"日未開場":"",unavailable?unavailable+"日取得不可":""].filter(Boolean).join(" / ");
  return {...summary,state};
}

export function CounterComparison({catalog,initialSeriesId,initialView}:{catalog:SeriesAndDays;initialSeriesId?:string;initialView?:"day"|"year"}) {
  const events=datasets(catalog);
  const annual=annualDatasets(events);
  const [view,setView]=useState<"day"|"year">(initialView??"day");
  useEffect(()=>{if(initialView)setView(initialView);},[initialView]);
  const [eventKey,setEventKey]=useState(initialSeriesId??"");
  const [annualKeys,setAnnualKeys]=useState<[string,string]>(["",""]);
  const [allDays,setAllDays]=useState(false);
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [pending,setPending]=useState(false);
  const [error,setError]=useState("");
  const flight=useRef<AbortController|null>(null);
  useEffect(()=>()=>flight.current?.abort(),[]);
  const selected=events.find(item=>item.key===eventKey)??events[0];
  const primary=annual.find(item=>item.key===annualKeys[0])??annual[0];
  const alternatives=annual.filter(item=>item.year!==primary?.year);
  const secondary=alternatives.find(item=>item.key===annualKeys[1])??alternatives[0];
  const appointment=[selected,primary,secondary].map(item=>item?.key+":"+item?.title+":"+item?.days.map(day=>day.id).join(",")).join("|");
  useEffect(()=>{clear();},[appointment]);

  function clear() {
    flight.current?.abort();
    flight.current=null;
    setPending(false);
    setSnapshot(null);
    setError("");
  }
  async function load() {
    const plan=view==="day"?[selected]:[primary,secondary];
    if (plan.some(item=>!item) || flight.current) return;
    const controller=new AbortController();
    flight.current=controller;
    setPending(true);setError("");setSnapshot(null);
    try {
      const groups:DisplayRow[]=[];
      for (const item of plan) {
        const days=await readComparisonDays(item.days,controller.signal);
        if (controller.signal.aborted) return;
        groups.push({key:item.key,title:item.title,days});
      }
      setSnapshot({at:Date.now(),groups});
    } catch {
      if (!controller.signal.aborted) setError("集計を取得できませんでした。通信を確認して再試行してください。");
    } finally {
      if (flight.current===controller) {flight.current=null;setPending(false);}
    }
  }
  const rows=snapshot?.groups.flatMap(group=>view==="day"&&!allDays
    ? group.days.map(day=>({key:day.id,title:day.date,days:[day]})): [group])??[];
  const summaries=rows.map(row=>({...row,result:coverage(row)}));
  const maxRate=Math.max(1,...summaries.map(({result})=>result.rate??0));
  function exportCsv() {
    if (!snapshot) return;
    const data=csv([["本番のみ","集計取得時刻（JST）",dateTime.format(snapshot.at)],
      ["集計対象","確定日数","記録取得日数","対象日数","累計入場（回）","累計退場（回）","開場時間（時間）",
        "1時間あたり入場（回）","最大滞在（人）","最大滞在時刻（JST）","確定平均滞在（分）","整合性の指摘（件）","データ状態"],
      ...summaries.map(({title,result:r})=>[title,r.verified,r.loaded,r.expected,r.loaded?r.entries:null,r.loaded?r.exits:null,
        r.loaded?r.duration/hourMs:null,r.rate,r.loaded?r.peak:null,r.peakAt===null?null:dateTime.format(r.peakAt),
        r.average===null?null:r.average/60000,r.issues,r.state])]);
    const url=URL.createObjectURL(new Blob([data],{type:"text/csv;charset=utf-8"}));
    const link=document.createElement("a");
    link.href=url;link.download="counter-"+(view==="year"?"annual":"days")+"-live.csv";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }

  return <section className="cm-section" aria-labelledby="cm-comparison-title">
    <h2 id="cm-comparison-title">開催日・年度の比較</h2>
    <p className="cm-caption">人数カウントの本番記録を使用します。入退場は再入場を含む回数です。</p>
    {!events.length?<p className="cm-empty">人数カウント専用イベントを作成すると比較できます。</p>:<>
      <div className="cm-form">
        <label>比較方法
          <select value={view} onChange={event=>{clear();setView(event.target.value==="year"?"year":"day");}}>
            <option value="day">開催日別・全日程</option><option value="year">年度別</option>
          </select>
        </label>
        {view==="day"?<label>対象イベント<select value={selected?.key??""}
          onChange={event=>{clear();setEventKey(event.target.value);}}>
          {events.map(item=><option key={item.key} value={item.key}>{item.title}</option>)}
        </select></label>:<>
          <label>対象年度・イベント<select value={primary?.key??""}
            onChange={event=>{clear();setAnnualKeys([event.target.value,annualKeys[1]]);}}>
            {annual.map(item=><option key={item.key} value={item.key}>{item.title}</option>)}
          </select></label>
          <label>比較する年度・イベント<select value={secondary?.key??""} disabled={!alternatives.length}
            onChange={event=>{clear();setAnnualKeys([annualKeys[0],event.target.value]);}}>
            {!alternatives.length&&<option value="">他年度のイベントがありません</option>}
            {alternatives.map(item=><option key={item.key} value={item.key}>{item.title}</option>)}
          </select></label>
        </>}
        <button type="button" disabled={pending||(view==="year"?!secondary:!selected)} onClick={()=>void load()}>
          {pending?"取得中…":snapshot?"最新の記録で再集計":"比較を表示"}
        </button>
      </div>
      {view==="year"&&<p className="cm-caption">年度は4月から翌年3月です。年度ごとに選んだイベントを、実際の開場時間で比較します。</p>}
      {error&&<p role="alert" className="cm-warning">{error}</p>}
      {pending&&<p role="status" className="cm-caption">開催日ごとの集計を取得しています。</p>}
    </>}
    {snapshot&&<>
      <div className="cm-form">
        {view==="day"&&<label>表示範囲<select value={allDays?"all":"each"} onChange={event=>setAllDays(event.target.value==="all")}>
          <option value="each">開催日ごと</option><option value="all">全日程の合計</option>
        </select></label>}
        <button type="button" onClick={exportCsv}>比較結果のCSV</button>
      </div>
      <p className="cm-caption">取得日時 {dateTime.format(snapshot.at)}（日本時間）</p>
      {summaries.some(({result})=>result.verified<result.expected)&&<p className="cm-warning" role="status">
        暫定値を含みます。取得できた開場日の小計を表示し、未同期・欠損・未開場の記録がある場合は変わることがあります。
      </p>}
      <div className="cm-table-wrap" tabIndex={0} role="region" aria-label="比較結果">
        <table><thead><tr><th scope="col">対象</th><th scope="col">取得状況</th><th scope="col">累計入場</th>
          <th scope="col">累計退場</th><th scope="col">開場時間</th><th scope="col">1時間あたり入場</th>
          <th scope="col">最大滞在</th><th scope="col">確定平均滞在</th></tr></thead>
          <tbody>{summaries.map(({key,title,result:r})=><tr key={key}>
            <th scope="row">{title}</th><td>{r.loaded}/{r.expected}日取得<br/>{r.state}{r.issues>0&&<><br/>整合性の指摘 {r.issues}件</>}</td>
            <td>{r.loaded?metric(r.entries)+"回":"—"}</td><td>{r.loaded?metric(r.exits)+"回":"—"}</td>
            <td>{r.loaded?metric(r.duration/hourMs)+"時間":"—"}</td><td>{metric(r.rate)}{r.rate!==null?"回":""}</td>
            <td>{r.loaded?metric(r.peak)+"人":"—"}{r.peakAt!==null&&<><br/>{dateTime.format(r.peakAt)}</>}</td>
            <td>{r.average===null?"算出不可":metric(r.average/60000)+"分"}</td>
          </tr>)}</tbody>
        </table>
      </div>
      <h3>1時間あたりの入場回数</h3>
      <dl className="cm-definition">{summaries.map(({key,title,result:r})=><div key={key} style={{display:"contents"}}>
        <dt>{title}</dt><dd>{r.rate===null?"算出不可":<><meter style={{width:"min(55%, 240px)",marginInlineEnd:"0.5rem"}}
          min={0} max={maxRate} value={r.rate} aria-label={title+"の1時間あたり入場回数"}/>{metric(r.rate)}回</>}</dd>
      </div>)}</dl>
      <p className="cm-caption">平均滞在時間は、対象の全開催日が確定した場合に、総滞在時間を累計入場回数で割って計算します。</p>
    </>}
  </section>;
}
