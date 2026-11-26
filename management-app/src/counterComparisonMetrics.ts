import {analyze,type CounterOperation} from "../../reception-app/public/people-counter/ledger.mjs";

export const hourMs=3600000;
export function fiscalYear(date:string) {
  const year=Number(date.slice(0,4));
  return Number(date.slice(5,7))<4?year-1:year;
}

type Count = {
  entries:number; exits:number; duration:number; peak:number; peakAt:number|null;
  area:number|null; status:"verified"|"provisional"; issues:number;
};
export type ComparisonDay = {id:string;date:string} &
  (Count | {status:"unavailable"} | {status:"unopened"});

export function summarizeCounterDay(id:string,date:string,config:{opened:number;closed:number|null;verified:boolean},
  rows:CounterOperation[],now:number,invalid:number):ComparisonDay {
  const end=config.closed??now;
  const duration=end-config.opened;
  if (duration<0 || end>now) return {id,date,status:"unavailable"};
  const report=analyze(rows,{eventId:id,mode:"live",...config,now});
  const issues=report.issues.length+invalid;
  const peak=report.timeline.reduce((highest,point)=>point.occupancy>highest.occupancy?point:highest,
    {occupancy:0,at:config.opened});
  const certifiedEmpty=config.verified&&config.closed!==null&&report.pending===0&&
    report.entries===0&&report.exits===0&&report.issues.length===0;
  const verified=invalid===0&&(certifiedEmpty||report.integralAverage!==null);
  return {id,date,entries:report.entries,exits:report.exits,duration,peak:peak.occupancy,
    peakAt:peak.occupancy>0?peak.at:null,status:verified?"verified":"provisional",issues,area:verified?report.area:null};
}

export function aggregateComparison(days:ComparisonDay[]) {
  let entries=0,exits=0,duration=0,peak=0,peakAt:number|null=null,issues=0,loaded=0,verified=0,area=0;
  for (const row of days) {
    if (row.status==="unavailable" || row.status==="unopened") continue;
    loaded++;
    if (row.status==="verified") verified++;
    entries+=row.entries;
    exits+=row.exits;
    duration+=row.duration;
    issues+=row.issues;
    area+=row.area??0;
    if (row.peak>peak || (row.peak===peak&&row.peakAt!==null&&(peakAt===null||row.peakAt<peakAt))) {
      peak=row.peak;peakAt=row.peakAt;
    }
  }
  return {entries,exits,duration,peak,peakAt,issues,loaded,verified,expected:days.length,
    rate:duration>0?entries/(duration/hourMs):null,
    average:days.length>0&&verified===days.length&&entries>0?area/entries:null};
}
