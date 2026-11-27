import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {recoveryBudget} from "./reception-app/public/people-counter/luxnora-core.mjs";

async function source(name) {
  const text=readFileSync(new URL(`./management-app/src/luxnora/${name}.ts`,import.meta.url),"utf8");
  return import("data:text/javascript;base64,"+Buffer.from(ts.transpile(text,{
    module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022,
  })).toString("base64"));
}
const {interpret}=await source("language");
const {previousOperation}=await source("adapt");

const questions=[
  ["展示室に残ってる人はどのくらい","occupancy"],
  ["今は館内に何にんおるんやろ","occupancy"],
  ["ここに今何人いてはる？","occupancy"],
  ["会場に足を運んだ人は何名","entries"],
  ["本日何名お越しになった？","entries"],
  ["何人来はったん？","entries"],
  ["何名がもう帰っちゃったんですか","exits"],
  ["帰らはった人の人数は？","exits"],
  ["どれくらいの人数が退場したの","exits"],
  ["受付の機械がうまく動いてるか知りたい","stations"],
  ["出口の端末、同期はできてんの？","stations"],
  ["どの程度この先人が増えるんやろ","forecast"],
  ["これから混むんかな","forecast"],
  ["平均でどれくらい滞在してはる？","dwell"],
  ["前年比の違いを見たい","compare"],
  ["通過の履歴を出して","records"],
  ["端末をしばらく監視して","routine"],
  ["おかしな記録がないか調べて","issues"],
  ["今日の開催結果をざっくりまとめて","briefing"],
  ["受付を始められるか確認したい","readiness"],
];
test("held-out paraphrases select the expected read-only action",()=>{
  const failures=questions.flatMap(([text,intent])=>{
    const plan=interpret(text).plans[0];
    return plan?.intent===intent&&!plan.operation&&!plan.schedule?[]:[{text,intent,actual:plan?.intent}];
  });
  assert.deepEqual(failures,[]);
});
test("time ranges, corrections, multiple queries and unsafe or unsupported instructions",()=>{
  const from=interpret("午前10時半から午後1時まで何人来はった？").plans[0];
  assert.deepEqual(from.period,{from:630,to:780});
  assert.equal(interpret("ここ2時間の来場者は何人？").plans[0].period,120);
  assert.deepEqual(interpret("あ、10:15〜11:45だけ",from).plans[0].period,{from:615,to:705});
  assert.deepEqual(interpret("開場予定を午前9時半に変更して").plans[0].schedule,{field:"start",time:"09:30"});
  assert.equal(interpret("午後1時から午前10時まで何人来た？").plans.length,0);
  assert.equal(interpret("明日の開場予定を8時に変更して").plans.length,0);
  assert.equal(interpret("今すぐ開場して、それはせんといて").plans.every(p=>!p.operation&&!p.schedule),true);
  assert.equal(interpret("データを消去して").plans.length,0);
  assert.equal(interpret("どこの駅に特急が停まる？").plans.length,0);
  assert.deepEqual(interpret("今日何人来た？それから出口も調べて").plans.map(p=>p.intent),["entries","stations"]);
});
test("annual suggestions reference an earlier verified day for the selected event and venue",()=>{
  const series=[{id:"same",name:"文化祭",venue:"展示室"},{id:"else",name:"授業",venue:"体育館"}];
  const day=(eventId,date,finalized)=>({eventId,date,opened:1,ended:2,finalized,start:"10:00",end:"15:00"});
  const days=[day("same","2025-11-15",3),day("same","2026-11-14",null),day("else","2026-11-20",3),day("same","2027-11-15",3)];
  const draft={name:"文化祭",venue:"展示室",days:[{date:"2027-11-14",start:"09:00",end:"16:00"}]};
  assert.deepEqual(previousOperation({series,days},draft),{sourceDate:"2025-11-15",start:"10:00",end:"15:00"});
  assert.equal(previousOperation({series,days},{...draft,venue:"別室"}),null);
});
test("another unattended recovery requires verified uptime and remains bounded",()=>{
  const minute=60000;
  assert.equal(recoveryBudget([],0,null).ready,true);
  assert.equal(recoveryBudget([0],11*minute,null).ready,false);
  assert.equal(recoveryBudget([0],9*minute,1000).ready,false);
  assert.equal(recoveryBudget([0],11*minute,1000).ready,true);
  assert.equal(recoveryBudget([0,11*minute],24*minute,12*minute).ready,false);
  assert.deepEqual(recoveryBudget([0,11*minute],72*minute,12*minute),{recent:[],ready:true});
});
