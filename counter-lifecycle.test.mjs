import { strict as assert } from "node:assert";
import { test } from "node:test";
import {readFileSync} from "node:fs";
import ts from "typescript";

const input=readFileSync(new URL("management-app/src/counterLifecycle.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(input,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const target={};
new Function("exports",compiled)(target);
const {emptyDay,transition,stationConfig,scheduleValid}=target;

test("the same event day switches trial and production controls independently",()=>{
  const trial=transition(emptyDay,"trial",1000);
  assert.deepEqual(stationConfig(trial,"live"),{opened:null,closed:null,paused:true,verified:false});
  assert.deepEqual(stationConfig(trial,"test"),{opened:1000,closed:null,paused:false,verified:false});
  const prepared=transition(trial,"prepare",1200);
  assert.equal(stationConfig(prepared,"test").paused,true);
  const live=transition(prepared,"open",1300);
  assert.equal(stationConfig(live,"live").opened,1300);
  assert.equal(stationConfig(live,"test").paused,true);
});

test("restriction and closing continue capture, and ending and verification are separate",()=>{
  const opened=transition(emptyDay,"open",1800);
  const restricted=transition(opened,"restrict",2000);
  const closing=transition(restricted,"close",2400);
  assert.equal(stationConfig(restricted,"live").paused,false);
  assert.equal(stationConfig(closing,"live").paused,false);
  assert.equal(stationConfig(transition(closing,"reopen",2500),"live").closed,null);
  assert.throws(()=>transition(closing,"finish",3000),/会場内/);
  const ended=transition(closing,"finish",3000,{empty:true,synced:false});
  assert.equal(ended.closing,2400);
  assert.deepEqual(stationConfig(ended,"live"),{opened:1800,closed:3000,paused:true,verified:false});
  assert.throws(()=>transition(ended,"verify",3200,{empty:true,synced:false}),/回収/);
  const verified=transition(ended,"verify",3400,{empty:true,synced:true});
  assert.equal(verified.ended,3000);
  assert.equal(verified.finalized,3400);
  assert.throws(()=>transition(verified,"verify",3500,{empty:true,synced:true}),/運用状態/);
});

test("invalid days, decreasing clocks, and invalid state jumps are rejected",()=>{
  assert.equal(scheduleValid({date:"2026-11-28",start:"09:00",end:"16:00"}),true);
  assert.equal(scheduleValid({date:"2026-02-29",start:"09:00",end:"16:00"}),false);
  assert.equal(scheduleValid({date:"2026-11-28",start:"16:00",end:"09:00"}),false);
  assert.throws(()=>transition(emptyDay,"finish",500),/運用状態/);
  assert.throws(()=>transition(transition(emptyDay,"open",1000),"close",900),/時刻/);
});
