import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import ts from "typescript";
import {IDBFactory} from "fake-indexeddb";
import {openRecordStore} from "./reception-app/public/people-counter/records.mjs";

const source=readFileSync(new URL("./management-app/src/counterRestore.ts",import.meta.url),"utf8");
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const api={};
new Function("exports",compiled)(api);
const {readCounterBackup,restorePlan,restorePayload,restoreIsStopped}=api;

const id=(kind,n)=>kind+":f500f1dd-4a99-4c7b-b493-"+String(n).padStart(12,"0");
const fields={at:2100,direction:"in",person:"visitor",invalid:false,clockWarning:"",clockUncertainty:null};
const base={eventId:"day-one",mode:"live",device:"2486d065-2f31-42fc-b263-dee13e0a0079",station:"in",rawAt:2100};
const passage={...base,...fields,id:id("ledger",1),kind:"passage",source:"auto",synced:false,configVersion:1,sequence:1};
const revision={...base,id:id("edit",2),kind:"revision",target:passage.id,parent:passage.id,reason:"時刻確認",
  before:fields,after:{...fields,at:2300},resolves:[],synced:false};
const make=(operations,others={})=>JSON.stringify({schema:"counter-day-backup",version:1,scope:"day-one",mode:"live",
  name:"本番",savedAt:6000,window:{from:900,to:5000},operations,...others});
const parse=(operations,override={})=>readCounterBackup(make(operations,override),"day-one","live");

test("restore previews append-only differences and skips existing operation IDs with the same content",()=>{
  const backup=parse([revision,passage]);
  assert.deepEqual(restorePlan(backup,[]).add.map(row=>row.id),[passage.id,revision.id]);
  assert.deepEqual(restorePlan(backup,[{...passage,synced:true}]),{add:[revision],duplicates:1});
  assert.equal(restorePlan(backup,[revision,passage]).duplicates,2);
  assert.throws(()=>restorePlan(backup,[{...passage,at:2323}]),/違う記録/);
  assert.throws(()=>restorePlan(parse([revision]),[]),/元記録/);
});

test("restore rejects mismatched modes, bad versions, malformed records, and unsafe auto directions",()=>{
  assert.throws(()=>parse([passage],{mode:"test"}),/一致しません/);
  assert.throws(()=>parse([passage],{scope:"day-two"}),/一致しません/);
  assert.throws(()=>parse([passage],{version:2}),/対応していない/);
  assert.throws(()=>parse([passage],{accessToken:"secret"}),/対応していない/);
  assert.throws(()=>parse([passage,passage]),/複数/);
  assert.throws(()=>parse([{...passage,direction:"out"}]),/記録が不正/);
  assert.throws(()=>parse([{...passage,configVersion:-1}]),/記録が不正/);
  assert.throws(()=>parse([{...revision,after:{...fields,rawFrame:"private"}}]),/記録が不正/);
});

test("restore detects cycles and passes through automatic records without changing retry identity",()=>{
  const a={...revision,parent:id("edit",3)};
  const b={...revision,id:id("edit",3),parent:a.id};
  assert.throws(()=>restorePlan(parse([passage,a,b]),[]),/循環/);
  const {synced,...original}=passage;
  assert.deepEqual(restorePayload(parse([passage]).operations[0]),original);
});

test("old pending corrections can be recognized when the restored row reaches the station",async()=>{
  const store=await openRecordStore({indexedDB:new IDBFactory()});
  try {
    await store.addLedger({...revision,direction:"in",person:"visitor",invalid:false,
      configVersion:1,at:revision.rawAt,source:"manual",clockWarning:"",clockUncertainty:null});
    await store.mergeLedger([restorePayload(revision)]);
    assert.equal((await store.ledger())[0].synced,true);
    await assert.rejects(store.mergeLedger([{...restorePayload(revision),after:{...fields,at:2444}}]),/一致しません/);
  } finally {store.close();}
});

test("legacy closed windows allow recovery, but active or scheduled windows do not",()=>{
  assert.equal(restoreIsStopped({paused:false,closed:4500},5000),true);
  assert.equal(restoreIsStopped({paused:false,closed:5500},5000),false);
  assert.equal(restoreIsStopped({paused:false,closed:null},5000),false);
  assert.equal(restoreIsStopped({paused:true,closed:null},5000),true);
});
