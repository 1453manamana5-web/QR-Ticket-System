import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFileSync} from "node:fs";
import {IDBFactory} from "fake-indexeddb";
import {initialConnection,observeConnection} from "./reception-app/public/people-counter/connection.mjs";
import {openRecordStore} from "./reception-app/public/people-counter/records.mjs";
import {analyze,csv,estimateClock,uploadPending} from "./reception-app/public/people-counter/ledger.mjs";

const source = readFileSync(new URL("./reception-app/public/people-counter/ledger-ui.mjs",import.meta.url),"utf8")
  .replace(/^import .*;\n/gm,"")
  .replace("await import('./counter-sync.js?v=14&try=' + remoteAttempts++)","fakeServer");

function station(initial = {}) {
  const settings = {eventId:"festival",mode:"live",role:"in",opened:0,closed:null,verified:false};
  const values = new Map(Object.entries({
    "counter-ledger-settings-v1":JSON.stringify(settings),
    "counter-device-v1":JSON.stringify("12345678-1234-1234-1234-123456789abc"),
    ...initial,
  }));
  const nodes = new Map(), notices = [], timers = new Set();
  let info = {status:"approved",role:"in",device:JSON.parse(values.get("counter-device-v1"))};
  let config = {opened:0,closed:null,paused:false,verified:false};
  const heartbeats = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id,{addEventListener(){},replaceChildren(){},textContent:"",value:"",checked:false});
    return nodes.get(id);
  };
  const fakeServer = {
    async readCounterStation() {if (info instanceof Error) throw info;return info;},
    async readCounterConfig() {return config;},
    async heartbeatCounterStation(_eventId,health) {heartbeats.push(health);},
  };
  const context = vm.createContext({analyze,csv,estimateClock,uploadPending,initialConnection,observeConnection,performance,console,Event,
    fakeServer,document:{getElementById:element,hidden:false,addEventListener(){}},navigator:{onLine:true},
    setTimeout(fn,ms) {const id={fn,ms};timers.add(id);return id;},clearTimeout:id=>timers.delete(id),
    setInterval:()=>0,window:{addEventListener(){},dispatchEvent(e){notices.push(e.type);}},
    localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},
  });
  vm.runInContext(source+"\nglobalThis.check=()=>checkStation(settings,fakeServer);",context);
  return {
    get gate() {return context.window.counterLedger.captureBlockReason();},
    check:context.check, element, values, heartbeats, notices,
    station(next) {info = {...info,...next};},
    control(next) {config={...config,...next};},
  };
}

test("registration reflects approval, keeps the same identity and sends only enumerated scalar diagnostics", async () => {
  const app = station();
  app.station({status:"pending"});
  assert.equal(await app.check(),false);
  assert.match(app.element("counterStationState").textContent,/承認待ち/);
  assert.equal(app.heartbeats.length,0);
  app.station({status:"approved"});
  assert.equal(await app.check(),true);
  assert.match(app.element("counterStationState").textContent,/承認済み/);
  assert.deepEqual(Object.keys(app.heartbeats[0]).sort(),["ai","alert","camera","configVersion","mode","pending","profile","version"]);
  assert.equal(app.heartbeats[0].profile,"unknown");
});

test("confirmed close or pause is restored offline and a reassigned station requires direction confirmation",async () => {
  const app = station();
  app.control({closed:Date.now()-10});
  await app.check();
  assert.match(app.gate,/閉場/);
  assert.match(station(Object.fromEntries(app.values)).gate,/閉場/);
  app.control({closed:null,paused:true});
  await app.check();
  assert.match(station(Object.fromEntries(app.values)).gate,/一時停止/);
  app.control({paused:false});
  app.station({role:"out"});
  await app.check();
  assert.match(app.gate,/設置区分/);
  app.station({status:"revoked"});
  await app.check();
  assert.match(station(Object.fromEntries(app.values)).gate,/本番承認/);
});

test("reading historical operations with reordered server map keys does not invalidate the local queue",async () => {
  const store = await openRecordStore({indexedDB:new IDBFactory()});
  const row = {id:"edit:record",kind:"revision",eventId:"festival",mode:"live",device:"station",rawAt:1000,
    before:{at:1,direction:"in"},after:{at:2,direction:"out"}, synced:false};
  await store.addLedger(row);
  await store.mergeLedger([{device:"station", mode:"live",eventId:"festival",kind:"revision",id:row.id,rawAt:1000,
    after:{direction:"out",at:2},before:{direction:"in",at:1},synced:true}]);
  assert.equal((await store.ledger())[0].synced,true);
  await assert.rejects(store.mergeLedger([{...row,after:{at:3,direction:"out"}}]));
  store.close();
});


test("a dedicated day waits for a versioned setting and switches according to the acknowledged settings offline",async()=>{
  const id="81111111-1111-4111-8111-111111111119_2026-11-24";
  const app=station({"counter-ledger-settings-v1":JSON.stringify({eventId:id,mode:"live",role:"in",opened:0,closed:null})});
  assert.match(app.gate,/運用設定をまだ確認できません/);
  app.control({version:1,opened:1000,paused:false});
  await app.check();
  assert.equal(app.gate,"");
  assert.equal(app.heartbeats.at(-1).configVersion,1);
  assert.equal(station(Object.fromEntries(app.values)).gate,"");
});

test("connection indicator debounces a brief failure and requires stable recovery",()=>{
  let state=observeConnection(initialConnection,{success:true,roundTrip:50,now:1});
  state=observeConnection(state,{success:false,now:2});
  assert.equal(state.label,"正常");
  state=observeConnection(state,{success:false,now:3});
  assert.equal(state.label,"不安定");
  state=observeConnection(state,{success:false,now:4});
  assert.equal(state.label,"オフライン");
  state=observeConnection(state,{success:true,roundTrip:3000,now:5});
  assert.equal(state.label,"再接続中");
  state=observeConnection(state,{success:true,roundTrip:3000,now:6});
  assert.equal(state.label,"遅延");
  assert.equal(state.lastSeen,6);
});
