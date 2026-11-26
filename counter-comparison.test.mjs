import {strict as assert} from "node:assert";
import {readFileSync} from "node:fs";
import {test} from "node:test";
import ts from "typescript";
import * as ledger from "./reception-app/public/people-counter/ledger.mjs";

const file=new URL("./management-app/src/counterComparisonMetrics.ts",import.meta.url);
const compiled=ts.transpileModule(readFileSync(file,"utf8"),{compilerOptions:{
  module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,
}}).outputText;
const exports={};
new Function("exports","require",compiled)(exports,id=>{
  assert.equal(id,"../../reception-app/public/people-counter/ledger.mjs");
  return ledger;
});
const {aggregateComparison,fiscalYear,hourMs,summarizeCounterDay}=exports;

const minute=60000,opened=Date.UTC(2027,2,31,1);
function config(hours,verified=true) {
  return {opened,closed:opened+hours*hourMs,verified};
}
function row(day,id,offset,direction,extras={}) {
  return {id,eventId:day,mode:"live",kind:"passage",source:"auto",at:opened+offset*minute,
    rawAt:opened+offset*minute,direction,person:"visitor",invalid:false,device:"ipad",synced:true,...extras};
}
const summarize=(id,day,limits,rows,invalid=0)=>summarizeCounterDay(id,day,limits,rows,opened+8*hourMs,invalid);

test("Japan fiscal year rolls over between March 31 and April 1",()=>{
  assert.equal(fiscalYear("2027-03-31"),2026);
  assert.equal(fiscalYear("2027-04-01"),2027);
});

test("full-event rates use total actual hours and average dwell is weighted by visits",()=>{
  const one=summarize("one","2027-03-30",config(1),[
    row("one","a",10,"in"),row("one","b",20,"out"),
    row("one","trial",12,"in",{mode:"test"}),row("one","staff",13,"in",{person:"staff"}),
  ]);
  const two=summarize("two","2027-03-31",config(4),[
    row("two","d",10,"in"),row("two","e",15,"in"),row("two","f",30,"out"),row("two","g",55,"out"),
    row("one","other",20,"in"),
  ]);
  assert.equal(one.entries,1);
  const aggregate=aggregateComparison([one,two]);
  assert.equal(aggregate.entries,3);
  assert.equal(aggregate.duration,5*hourMs);
  assert.equal(aggregate.rate,0.6);
  assert.equal(aggregate.average,(10+20+40)*minute/3);
  assert.equal(aggregate.peak,2);
  assert.equal(aggregate.peakAt,opened+15*minute);
  assert.equal(aggregate.verified,2);
});

test("unverified and invalid data yield labeled partial statistics without a certified average",()=>{
  const good=summarize("good","2027-03-31",config(1),[row("good","a",1,"in"),row("good","b",5,"out")]);
  const invalid=summarize("bad","2027-03-31",config(1),[row("bad","d",10,"out")],1);
  const unopened={id:"scheduled",date:"2027-04-01",status:"unopened"};
  const unavailable={id:"missing",date:"2027-04-01",status:"unavailable"};
  const aggregate=aggregateComparison([good,invalid,unopened,unavailable]);
  assert.equal(invalid.status,"provisional");
  assert.ok(aggregate.issues>1);
  assert.equal(aggregate.average,null);
  assert.equal(aggregate.expected,4);
  assert.equal(aggregate.loaded,2);
  assert.equal(aggregate.verified,1);
  assert.equal(aggregateComparison([unavailable]).rate,null);
});

test("a certified empty day is an observed zero, and real visit revisions enter the totals",()=>{
  const empty=summarize("empty","2027-03-31",config(1),[]);
  assert.equal(empty.status,"verified");
  assert.equal(aggregateComparison([empty]).rate,0);
  assert.equal(aggregateComparison([empty]).average,null);
  const before=row("edited","a",1,"in");
  const after={...before,at:opened+2*minute};
  const revised=summarize("edited","2027-03-31",config(3),[
    before,row("edited","b",22,"out"),
    {id:"rev",eventId:"edited",mode:"live",kind:"revision",target:"a",parent:"a",before,after,synced:true,rawAt:opened+40*minute},
  ]);
  assert.equal(aggregateComparison([empty,revised]).average,20*minute);
});

test("open sessions use elapsed hours but never provide a verified dwell average",()=>{
  const ongoing=summarize("open","2027-03-31",{opened,closed:null,verified:false},[
    row("open","a",10,"in"),row("open","b",20,"out"),
  ]);
  const result=aggregateComparison([ongoing]);
  assert.equal(result.rate,1/8);
  assert.equal(result.average,null);
  assert.equal(ongoing.status,"provisional");
});


test("a corrected clock warning follows the ledger's certification outcome",()=>{
  const certified=summarize("corrected","2027-03-31",config(1),[
    row("corrected","a",10,"in",{clockWarning:"端末時刻差が30秒超（補正済み）"}),
    row("corrected","b",20,"out"),
  ]);
  assert.equal(certified.status,"verified");
  assert.equal(certified.issues,1);
  assert.equal(aggregateComparison([certified]).average,10*minute);
});
