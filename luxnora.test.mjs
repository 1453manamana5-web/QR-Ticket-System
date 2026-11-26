import assert from "node:assert/strict";
import test from "node:test";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {appendActivity,recoveryDecision} from "./reception-app/public/people-counter/luxnora-core.mjs";
async function load(name) {
  const source=readFileSync(new URL("./management-app/src/luxnora/"+name+".ts",import.meta.url),"utf8");
  const js=ts.transpile(source,{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022});
  return import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
}
const {interpret}=await load("language");
const {forecast}=await load("forecast");

test("Japanese plans distinguish an occupancy snapshot, cumulative entries and a contextual time correction",()=>{
  assert.equal(interpret("今何人おるん？").plans[0].intent,"occupancy");
  const plan=interpret("本日って何人入りましたか？").plans[0];
  assert.equal(plan.intent,"entries");
  assert.equal(interpret("あ、午前中だけで。",plan).plans[0].period,"am");
  const routes=interpret("入口端末の状態を確認して。それから出口の方も調べて。").plans;
  assert.deepEqual(routes.map(x=>x.role),["in","out"]);
});

test("important or unknown requests cannot silently execute",()=>{
  assert.equal(interpret("やっぱりキャンセル").reset,true);
  assert.equal(interpret("データを削除して").plans.length,0);
  assert.equal(interpret("天気を教えて").plans.length,0);
  assert.equal(interpret("今すぐ開場して").plans[0].intent,"event");
  assert.equal(interpret("設定は変えないで。入口の状態を確認して。").plans[0].readOnly,true);
});

test("forecast uses observations, a bounded closing horizon, and suspends on unhealthy data",()=>{
  const min=60000, now=30*min, ends=45*min;
  const events=Array.from({length:10},(_,i)=>({at:(12+i)*min,direction:"in",invalid:false,person:"visitor"}));
  const input={now,opened:0,ends,healthy:true,total:20,occupancy:4,events};
  assert.deepEqual(forecast({...input,healthy:false}),[]);
  assert.deepEqual(forecast({...input,events:events.slice(0,2)}),[]);
  const points=forecast(input);
  assert.deepEqual(points.map(p=>p.at),[35*min,45*min]);
  assert.ok(points.every(point=>point.low<=point.occupancy&&point.occupancy<=point.high&&point.entries>=20));
  assert.equal(input.events.length,10);
});

test("station recovery requires the existing verified profile and does not interrupt active tracks",()=>{
  const safe={verified:true,visible:true,tracking:0,attempts:0,enabled:true};
  assert.equal(recoveryDecision(safe),true);
  for(const values of [{tracking:1},{visible:false},{verified:false},{attempts:1},{enabled:false}])
    assert.equal(recoveryDecision({...safe,...values}),false);
});
test("station activity stores only bounded scalar diagnostics and suppresses duplicates",()=>{
  const entry={at:10,reason:"camera",state:"recovering",image:"never retain this"};
  const events=appendActivity([],entry);
  assert.deepEqual(events,[{at:10,reason:"camera",state:"recovering"}]);
  assert.equal(appendActivity(events,{...entry,at:11}),events);
  assert.equal(appendActivity(events,{...entry,reason:"a person"}),events);
});
