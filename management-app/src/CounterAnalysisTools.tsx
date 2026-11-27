import {luxRange} from "./luxnora/assistant";
import type {Plan} from "./luxnora/language";
import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";
import {analyze,csv,type CounterOperation,type CounterMode} from "./counterManagementData";

type Analysis=ReturnType<typeof analyze>;
type Range={start:number;end:number};
const formatter=new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"});
const dateText=(at:number)=>formatter.format(at);
const jstInput=(at:number)=>new Date(at+32400000).toISOString().slice(0,16);
function download(contents:Blob,name:string) {
  const url=URL.createObjectURL(contents);
  const anchor=document.createElement("a");
  anchor.download=name;anchor.href=url;document.body.append(anchor);anchor.click();anchor.remove();
  setTimeout(()=>URL.revokeObjectURL(url),2000);
}

export function CounterAnalysisTools({report,rows,from,to,mode,scope,name,venue,current,luxPeriod,luxStamp}: {
  report:Analysis; rows:CounterOperation[]; from:number;to:number;mode:CounterMode;scope:string;
  name:string;venue?:string;current:boolean;luxPeriod?:Plan["period"];luxStamp?:number;
}) {
  const [period,setPeriod]=useState("all");
  const [custom,setCustom]=useState<Range|null>(null);
  const [notice,setNotice]=useState("");
  const print=useRef<HTMLElement>(null);
  const [cursor,setCursor]=useState(0);
  useEffect(()=>{
    document.body.classList.add("cm-report-ready");
    return ()=>document.body.classList.remove("cm-report-ready");
  },[]);
  useEffect(()=>{
    if(luxPeriod!==undefined){setPeriod("lux");setCursor(0);}
  },[luxPeriod,luxStamp]);
  const requested=luxPeriod!==undefined&&period==="lux"?luxRange(luxPeriod,from,to):null;
  const start=requested?.from??(period==="15"?Math.max(from,to-15*60000):period==="60"?Math.max(from,to-3600000):period==="custom"?Math.max(from,custom?.start??from):from);
  const end=requested?.to??(period==="custom"?Math.min(to,custom?.end??to):to);
  const within=(at:number)=>at>=start&&at<=end&&(!requested?.untilExclusive||at!==end);
  const valid=end>start;
  const series=valid? report.timeline.filter(point=>within(point.at)):[];
  const first=report.timeline.reduce((value,point)=>point.at<start?point.occupancy:value,0);
  const records=valid?report.effective.filter(row=>within(row.at)&&!row.invalid&&row.person==="visitor"):[];
  const entries=records.filter(row=>row.direction==="in").length;
  const exits=records.filter(row=>row.direction==="out").length;
  const peak=series.reduce((state,point)=>point.occupancy>state.occupancy?point:state,{at:start,occupancy:first});
  const last=series.at(-1)?.occupancy??first;
  const duration=(end-start)/3600000;
  const mean=period==="all"?(report.sumAverage??(current?report.estimate:null)):null;
  const graph=[{at:start,occupancy:first},...series,{at:end,occupancy:last}];
  const highlighted=Math.min(cursor,graph.length-1);
  const min=graph.reduce((value,point)=>Math.min(value,point.occupancy),0);
  const max=graph.reduce((value,point)=>Math.max(value,point.occupancy),1);
  const x=(at:number)=>30+(at-start)*530/Math.max(1,end-start);
  const y=(people:number)=>125-(people-min)*105/(max-min);
  const path=graph.reduce((line,point,index)=>index===0?"M"+x(point.at)+" "+y(point.occupancy):line+"H"+x(point.at)+"V"+y(point.occupancy),"");
  const items=[
    ["累計入場",entries+"回"],["累計退場",exits+"回"],["区間終了時の滞在",last+"人"],["最大滞在",peak.occupancy+"人"],
    ["平均滞在",mean==null?"算出不可":(mean/60000).toFixed(1)+"分 "+(report.sumAverage==null?"（暫定）":"（確定）")],
    ["1時間あたりの入場",valid?(entries/duration).toFixed(1)+"回":"—"],
  ];
  const key="counter-"+scope+"-"+mode;
  function png() {
    const canvas=document.createElement("canvas");
    canvas.width=1100;canvas.height=560;
    const ctx=canvas.getContext("2d");
    if (!ctx) return setNotice("このブラウザではグラフ画像を生成できません。");
    ctx.fillStyle="#fff";ctx.fillRect(0,0,1100,560);
    ctx.fillStyle="#20272b";ctx.font="24px sans-serif";ctx.fillText("滞在人数の推移",42,45);
    ctx.font="15px sans-serif";ctx.fillText(name+" · "+dateText(start)+"–"+dateText(end),42,73,990);
    const lo=series.reduce((a,b)=>Math.min(a,b.occupancy),Math.min(first,0));
    const hi=series.reduce((a,b)=>Math.max(a,b.occupancy),Math.max(first,1));
    const x=(at:number)=>90+(at-start)/(end-start)*950;
    const y=(n:number)=>474-(n-lo)/(hi-lo)*350;
    ctx.font="15px sans-serif";
    for(const mark of new Set([lo,0,hi])) {
      ctx.strokeStyle="#e0e4e6";ctx.beginPath();ctx.moveTo(90,y(mark));ctx.lineTo(1040,y(mark));ctx.stroke();
      ctx.fillText(String(mark),50,y(mark)+5);
    }
    ctx.strokeStyle="#1b639d";ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(x(start),y(first));
    let previous=first;
    for(const point of series){ctx.lineTo(x(point.at),y(previous));ctx.lineTo(x(point.at),y(point.occupancy));previous=point.occupancy;}
    ctx.lineTo(x(end),y(previous));ctx.stroke();
    ctx.fillStyle="#20272b";ctx.fillText(dateText(start),90,515);ctx.textAlign="right";ctx.fillText(dateText(end),1040,515);
    canvas.toBlob(blob=>blob?download(blob,key+".png"):setNotice("グラフ画像を保存できませんでした。"),"image/png");
  }
  return <section className="cm-section cm-analysis-tools" data-lux-focus="range">
    <div className="cm-section-top"><div><h2>期間別の集計</h2><p className="cm-caption">{valid?dateText(start)+" – "+dateText(end):"集計期間がありません"}</p></div>
      <label>表示期間 <select value={period} onChange={e=>{setPeriod(e.target.value);setCursor(0);}}><option value="all">選択中の開催日</option><option value="15">直近15分</option><option value="60">直近1時間</option><option value="custom">任意期間</option>{luxPeriod!==undefined&&<option value="lux">Luxnoraの指定期間</option>}</select></label></div>
    {period==="custom"&&<form className="cm-form" onSubmit={e=>{
      e.preventDefault();const fields=new FormData(e.currentTarget);
      const a=Date.parse(String(fields.get("start"))+":00+09:00"),b=Date.parse(String(fields.get("end"))+":00+09:00");
      if (!Number.isFinite(a)||!Number.isFinite(b)||a>=b) return setNotice("終了を開始より後に指定してください。");
      setNotice("");setCustom({start:a,end:b});setCursor(0);
    }}><label>開始（JST）<input type="datetime-local" name="start" required defaultValue={jstInput(start)}/></label>
      <label>終了（JST）<input type="datetime-local" name="end" required defaultValue={jstInput(end)}/></label><button>期間を適用</button></form>}
    {valid&&<dl className="cm-event-times">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
    {valid&&<figure className="cm-plot cm-range-plot">
      <svg viewBox="0 0 585 150" role="img" aria-label="選択期間の滞在人数">
        <path className="cm-axis" d={"M30 "+y(0)+"H560"}/><path className="cm-line" d={path}/>
        <circle cx={x(graph[highlighted].at)} cy={y(graph[highlighted].occupancy)} r="4" fill="#1b639d"/>
      </svg>
      <label>グラフ上の時刻 <input type="range" min="0" max={graph.length-1} value={highlighted} onChange={e=>setCursor(Number(e.target.value))}/></label>
      <output>{dateText(graph[highlighted].at)} · {graph[highlighted].occupancy}人</output>
    </figure>}
    <div className="cm-form">
      <button disabled={!valid} onClick={()=>download(new Blob([csv([["日時（UTC）","記録","区分"],...records.map(row=>[new Date(row.at).toISOString(),row.direction==="in"?"入場":"退場",row.source==="auto"?"自動":"手動"])])],{type:"text/csv;charset=utf-8"}),key+".csv")}>期間のCSV</button>
      <button disabled={!valid} onClick={png}>グラフPNG</button>
      <button disabled={!valid} onClick={()=>{if(print.current){window.print();}}}>報告書を印刷・PDF保存</button>
      <button onClick={()=>download(new Blob([JSON.stringify({schema:"counter-day-backup",version:1,scope,mode,name,venue,
        savedAt:Date.now(),window:{from,to},operations:rows},null,2)],{type:"application/json"}),key+".json")}>開催日のJSONバックアップ</button>
    </div>
    {notice&&<p role="status" className="cm-warning">{notice}</p>}
    {createPortal(<section ref={print} className="cm-print-report">
      <h1>開催実績報告書</h1><p>{name}{venue?" · "+venue:""}　{mode==="live"?"本番":"試験"}</p>
      <p>{valid?dateText(start)+" – "+dateText(end):"—"} （日本時間）</p>
      <table><tbody>{items.map(([label,value])=><tr key={label}><th scope="row">{label}</th><td>{value}</td></tr>)}</tbody></table>
      <p>{current?"入退場は実際の通過時刻に基づく集計です。":"端末状態または未同期の記録により、集計が変わる場合があります。"}</p>
      <h2>時間帯別の入退場（選択期間）</h2>
      <table><thead><tr><th>時間帯</th><th>入場</th><th>退場</th></tr></thead><tbody>{[...records.reduce((slots,row)=>{
        const hour=Math.floor(row.at/3600000)*3600000;
        const slot=slots.get(hour)??{in:0,out:0};slot[row.direction]++;slots.set(hour,slot);return slots;
      },new Map<number,{in:number;out:number}>())].sort(([a],[b])=>a-b).map(([at,slot])=><tr key={at}><th>{dateText(at)}</th><td>{slot.in}</td><td>{slot.out}</td></tr>)}</tbody></table>
    </section>,document.body)}
  </section>;
}
