import {useMemo,useState} from "react";
import type {ReceptionRecord} from "@qr-ticket-system/shared";

export function buildOccupancyPoints(records:readonly ReceptionRecord[]){
  const ordered=records.flatMap((record,index)=>{
    const time=Date.parse(record.timestamp);
    return Number.isFinite(time)&&["entry","reentry","exit"].includes(record.type)
      ?[{time,type:record.type,key:record.recordId||String(index)}]:[];
  }).sort((a,b)=>a.time-b.time);
  let inside=0;
  return ordered.map(record=>{
    inside=Math.max(0,inside+(record.type==="exit"?-1:1));
    return {time:record.time,value:inside,key:record.key};
  });
}
const width=680,height=270,left=52,right=18,top=24,bottom=44;
const timeLabel=(value:number,seconds=false)=>new Date(value).toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",...(seconds?{second:"2-digit"}: {})});
export default function VenueOccupancyChart({records}:{records:readonly ReceptionRecord[]}){
  const points=useMemo(()=>buildOccupancyPoints(records),[records]);
  const [selected,setSelected]=useState<string|null>(null);
  if(!points.length)return <div className="analysis-capacity-empty"><div><strong>まだ推移データがありません</strong><span>入退場記録が蓄積されると、会場内人数の変化を確認できます。</span></div></div>;
  const peak=points.reduce((max,point)=>Math.max(max,point.value),0);
  const step=Math.max(1,Math.ceil(peak/4)),max=step*4;
  const start=points[0].time,end=points[points.length-1].time;
  const minTime=start===end?start-60000:start,maxTime=start===end?end+60000:end;
  const plotWidth=width-left-right,plotHeight=height-top-bottom;
  const x=(time:number)=>left+(time-minTime)/(maxTime-minTime)*plotWidth;
  const y=(value:number)=>top+(1-value/max)*plotHeight;
  const found=points.findIndex(point=>point.key===selected);
  const index=found<0?points.length-1:found,active=points[index];
  const line=points.map(point=>`${x(point.time)},${y(point.value)}`).join(" ");
  const chooseTime=(event:React.PointerEvent<SVGSVGElement>)=>{
    const rect=event.currentTarget.getBoundingClientRect();if(!rect.width)return;
    const plotPosition=((event.clientX-rect.left)/rect.width*width-left)/plotWidth;
    const time=minTime+Math.max(0,Math.min(1,plotPosition))*(maxTime-minTime);
    let lo=0,hi=points.length-1;
    while(lo<hi){const mid=Math.floor((lo+hi)/2);if(points[mid].time<time)lo=mid+1;else hi=mid;}
    const chosen=lo>0&&time-points[lo-1].time<points[lo].time-time?lo-1:lo;
    setSelected(points[chosen].key);
  };
  return <div className="venue-occupancy-chart">
    <div className="venue-occupancy-summary"><span>最大 <strong>{peak}人</strong></span><span>受付記録 {points.length}件</span></div>
    <div className="venue-occupancy-scroll">
      <svg className="venue-occupancy-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`会場内人数の折れ線グラフ。最大${peak}人、受付記録${points.length}件。`} onPointerDown={chooseTime}>
        <title>会場内人数の推移</title>
        <desc>横軸は時刻、縦軸は人数です。グラフをタップするか、下の時刻スライダーで人数を確認できます。</desc>
        {[0,1,2,3,4].map(i=><g key={i}><line x1={left} x2={width-right} y1={y(i*step)} y2={y(i*step)} className="venue-grid"/><text x={left-10} y={y(i*step)+4} textAnchor="end">{i*step}</text></g>)}
        <text x={left} y={14}>人数（人）</text>
        {[0,1,2,3,4].map(i=>{const time=minTime+(maxTime-minTime)*i/4;return <text key={i} x={x(time)} y={height-18} textAnchor={i===0?"start":i===4?"end":"middle"}>{timeLabel(time,maxTime-minTime<240000)}</text>;})}
        <polyline className="venue-occupancy-line" points={line} fill="none" vectorEffect="non-scaling-stroke"/>
        <line className="venue-selection-guide" x1={x(active.time)} x2={x(active.time)} y1={top} y2={height-bottom}/>
        <circle className="venue-occupancy-point" cx={x(active.time)} cy={y(active.value)} r={5} vectorEffect="non-scaling-stroke"/>
      </svg>
    </div>
    <div className="venue-occupancy-inspection">
      <output aria-live="polite">{timeLabel(active.time,true)}：<strong>{active.value}人</strong></output>
      <label>表示時刻<input type="range" min={0} max={points.length-1} step={1} value={index} aria-label="会場内人数を確認する時刻" disabled={points.length===1} onChange={event=>setSelected(points[Number(event.target.value)]?.key??null)}/></label>
    </div>
    <p className="analysis-note">同期済みの受付記録を時刻順に集計しています。入場・再入場で＋1、退場で−1です。</p>
  </div>;
}
