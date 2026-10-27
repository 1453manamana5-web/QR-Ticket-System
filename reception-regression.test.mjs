import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import {webcrypto} from "node:crypto";
import {createHash} from "node:crypto";
import {setImmediate as nextTurn} from "node:timers/promises";
import {test} from "node:test";
import {IDBFactory} from "fake-indexeddb";
import React from "react";
import {act, create} from "react-test-renderer";
const require=createRequire(import.meta.url);
const ts=require("typescript");
globalThis.IS_REACT_ACT_ENVIRONMENT=true;

function load(file, dependencies={}, globals={}) {
  const compiled=ts.transpileModule(readFileSync(new URL(file, import.meta.url),"utf8")
    .replaceAll("import.meta.env.BASE_URL",'"/QR-Ticket-System/"'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX},
  }).outputText;
  const exports={};
  new Function("exports","require",...Object.keys(globals),compiled)(exports,name=>{
    if(name in dependencies)return dependencies[name];
    if(name==="react"||name==="react/jsx-runtime")return require(name);
    throw Error("Unexpected dependency: "+name);
  },...Object.values(globals));
  return exports;
}
const makeEvent=(eventId="event-one",dataVersion=1)=>({
  event:{eventId,eventName:"Reception regression",eventDate:"2026-10-27",startTime:"09:00",endTime:"17:00",eventStatus:"active",dataVersion},
  settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
  terminalId:"T-REGRESSION-01",authenticatedAt:"2026-10-27T00:00:00.000Z",dataReady:false,ticketCount:1,
});
const makeTicket=(eventId="event-one")=>({ticketId:"ticket-one",eventId,basicInfo:{},valid:true,currentStatus:"unused",updatedAt:"2026-10-27T00:00:00.000Z"});
const localDb=()=>load("./reception-app/src/localDb.ts",{},{indexedDB:new IDBFactory()});
const record=(recordId,type="entry",timestamp="2026-10-27T01:00:00.000Z")=>({recordId,type,timestamp,eventId:"event-one",ticketId:"ticket-one",terminalId:"T-REGRESSION-01"});

test("inventory refresh preserves unsent ticket state, validity edits and queue",async()=>{
  const local=localDb();
  await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  await local.saveReceptionTransaction({...makeTicket(),currentStatus:"inside"},record("pending-entry"));
  await local.prepareLocalEventData(makeEvent("event-one",2),[{...makeTicket(),valid:false}]);
  assert.equal((await local.getTicket("ticket-one")).currentStatus,"inside");
  assert.equal((await local.getTicket("ticket-one")).valid,false);
  assert.equal((await local.getPendingSyncItems()).length,1);
  await local.clearLocalEvent();
  assert.equal(await local.loadLocalEvent(),null);
  assert.equal((await local.getPendingSyncItems()).length,1);
  assert.equal((await local.getReceptionRecord("pending-entry")).type,"entry");
  await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  assert.equal((await local.getTicket("ticket-one")).currentStatus,"inside");
});

test("queue preserves capture order even for identical timestamps and clock rollback",async()=>{
  const local=localDb();
  for(const item of [record("z-entry"),record("a-exit","exit"),record("b-reentry","reentry","2026-10-26T23:00:00.000Z")]) {
    await local.saveReceptionTransaction({...makeTicket(),currentStatus:item.type==="exit"?"exited":"inside"},item);
  }
  assert.deepEqual((await local.getPendingSyncItems()).map(item=>item.recordId),["z-entry","a-exit","b-reentry"]);
  await local.markSyncStatus("z-entry","failed",1);
  assert.equal((await local.getPendingSyncItems())[0].sequence,1);
});

test("one upload worker serializes concurrent triggers and blocks dependent records after failure",async()=>{
  const local=localDb();
  for(const item of [record("entry"),record("exit","exit")])await local.saveReceptionTransaction(makeTicket(),item);
  const other={...record("other-entry"),ticketId:"other-ticket"};
  await local.saveReceptionTransaction({...makeTicket(),ticketId:other.ticketId},other);
  let fail=true,active=0,maxActive=0;
  const uploaded=[];
  const worker=load("./reception-app/src/syncQueue.ts",{
    "./localDb":local,
    "./receptionSync":{syncReceptionRecord:async item=>{
      maxActive=Math.max(maxActive,++active);
      try{await nextTurn();if(fail&&item.recordId==="entry")throw Error("simulated network error");uploaded.push(item.recordId);}
      finally{active--;}
    }},
  },{navigator:{onLine:true},console:{error:()=>{}}});
  const first=worker.syncPendingReceptionRecords();
  const second=worker.syncPendingReceptionRecords();
  assert.equal(first,second);
  await first;
  assert.equal(maxActive,1);
  assert.deepEqual(uploaded,["other-entry"]);
  fail=false;
  await worker.syncPendingReceptionRecords();
  assert.deepEqual(uploaded,["other-entry","entry","exit"]);
  assert.equal((await local.getPendingSyncItems()).length,0);
});

async function harness({saved=true,automatic,latestTicket,download,reapprove=false,initialRegistration={approved:true,status:"online",name:"Test terminal"}}={}) {
  const local=localDb();
  if(saved)await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  const intervals=new Map(),timeouts=new Map();
  let nextId=0,registrationCallback,registrationError,controlCallback,registerCalls=0,inventoryDownloads=0;
  const storage=new Map([["qr-ticket-terminal-id","T-REGRESSION-01"]]);
  const navigator={onLine:true};
  const window={
    addEventListener:()=>{},removeEventListener:()=>{},
    setInterval:(fn,ms)=>{intervals.set(++nextId,{fn,ms});return nextId;},clearInterval:id=>intervals.delete(id),
    setTimeout:(fn,ms)=>{timeouts.set(++nextId,{fn,ms});return nextId;},clearTimeout:id=>timeouts.delete(id),
  };
  const bundle={localEvent:makeEvent(),tickets:[makeTicket()],authPayload:{type:"qr-ticket-event-auth",...makeEvent().event,authToken:"test-token"}};
  function Scanner(){return null;}
  const dependencies={
    "./QrScanner":{default:Scanner},
    "./receptionAudio":{prepareReceptionAudio:()=>()=>{},playReceptionAudio:async()=>{}},"./localDb":local,
    "./syncQueue":{syncPendingReceptionRecords:async()=>{}},
    "./eventDownloader":{
      getCurrentFirebaseEventAuthPayload:async()=>{
        const data=await (automatic??(async()=>bundle))();
        return {type:"qr-ticket-event-auth",...data.localEvent.event,authToken:data.authPayload.authToken};
      },
      downloadCurrentFirebaseEventData:async()=>{inventoryDownloads++;return (automatic??(async()=>bundle))();},
      downloadEventData:async()=>{inventoryDownloads++;return (download??(async()=>bundle))();},
      getEventAuthPayloadByToken:async()=>bundle.authPayload,
    },
    "./receptionSync":{
      subscribeTerminalRegistration:(cb,onError)=>{registrationCallback=cb;registrationError=onError;cb(initialRegistration);return()=>{};},
      subscribeTerminalControl:(_id,cb)=>{controlCallback=cb;cb("停止",null);return()=>{};},
      registerReceptionTerminal:async()=>{registerCalls++;},
      requestReceptionEventReapproval:async()=>reapprove,
      saveTerminalHeartbeat:async()=>null,
      syncReceptionErrorLog:async()=>{},
      getLatestReceptionTicket:latestTicket??(async()=>makeTicket()),
    },
  };
  const App=load("./reception-app/src/App.tsx",dependencies,{
    navigator,window,crypto:webcrypto,
    localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    console:{error:()=>{},warn:()=>{}},
  }).default;
  let renderer;
  await act(async()=>{renderer=create(React.createElement(App));});
  const flush=async()=>{await act(async()=>{for(let i=0;i<50;i++)await nextTurn();});};
  await flush();
  const label=node=>node.children.map(item=>typeof item==="string"?item:label(item)).join("");
  const click=async text=>{
    const button=renderer.root.findAllByType("button").find(item=>label(item)===text);
    assert.ok(button,"Missing button: "+text);
    await act(async()=>{await button.props.onClick();});await flush();
  };
  return {local,renderer,Scanner,click,flush,navigator,
    text:()=>JSON.stringify(renderer.toJSON()),
    get registerCalls(){return registerCalls;},
    get inventoryDownloads(){return inventoryDownloads;},
    scan:async value=>{await act(async()=>{await renderer.root.findByType(Scanner).props.onResult(value);});await flush();},
    control:async(mode,at)=>{await act(async()=>controlCallback(mode,at));},
    approve:async()=>{await act(async()=>registrationCallback({approved:true,status:"online",name:"Test terminal"}));await flush();},
    revoke:async()=>{await act(async()=>registrationError({code:"permission-denied"}));await flush();},
    poll:async()=>{await act(async()=>{for(const {fn} of [...intervals.values()])await fn();});await flush();},
    close:async()=>{await act(async()=>renderer.unmount());},
  };
}

test("event QR authentication saves the complete downloaded event and is not interrupted by polling",async()=>{
  const h=await harness({saved:false,automatic:async()=>{throw Error("NO_PUBLISHED_EVENT");}});
  try{
    await h.click("イベントデータQRを読み取る");
    await h.scan(JSON.stringify({type:"qr-ticket-event-auth",...makeEvent().event,authToken:"test-token"}));
    await h.poll();
    assert.match(h.text(),/このイベントで認証しますか/);
    await h.click("このイベントで認証");
    const saved=await h.local.loadLocalEvent();
    assert.deepEqual(saved.event,makeEvent().event);
    assert.equal(saved.dataReady,true);
    assert.equal(saved.dataVersion,undefined);
    assert.match(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test("exit reception refreshes another terminal's entry and repeated control polls retain the result",async()=>{
  const h=await harness({latestTicket:async()=>({...makeTicket(),currentStatus:"inside"})});
  try{
    await h.click("受付を開始する");
    // Initial desiredMode=stopped with no command timestamp must not disable scanning.
    await h.control("出口受付","2026-10-27T01:00:00.000Z");
    await h.scan(JSON.stringify({type:"qr-ticket",eventId:"event-one",ticketId:"ticket-one"}));
    assert.match(h.text(),/退出OK/);
    await h.control("出口受付","2026-10-27T01:00:00.000Z");
    assert.match(h.text(),/退出OK/);
    assert.equal((await h.local.getTicket("ticket-one")).currentStatus,"exited");
    assert.equal((await h.local.getPendingSyncItems()).length,1);
    await h.revoke();
    assert.match(h.text(),/受付端末を登録/);
    assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);
  }finally{await h.close();}
});

test("publication switch stops reception without overwriting registration or erasing unsent history",async()=>{
  let switched=false;
  const h=await harness({automatic:async()=>({localEvent:makeEvent(switched?"event-two":"event-one"),tickets:[makeTicket(switched?"event-two":"event-one")],authPayload:{authToken:"token"}})});
  try{
    await h.click("受付を開始する");
    h.navigator.onLine=false;
    await h.scan("ticket-one");
    h.navigator.onLine=true;
    switched=true;
    await h.poll();
    assert.match(h.text(),/イベントが切り替わりました/);
    assert.equal(h.registerCalls,0);
    assert.equal((await h.local.getPendingSyncItems()).length,1);
    await h.poll();
    assert.match(h.text(),/イベントが切り替わりました/);
    await h.click("通信でイベントデータを受信");
    assert.equal((await h.local.loadLocalEvent()).event.eventId,"event-two");
    assert.equal((await h.local.getPendingSyncItems()).length,1);
    assert.match(h.text(),/受付準備完了/);
  }finally{await h.close();}
});

test("a reception-only terminal returns to pending approval when publication switches",async()=>{
  let switched=false;
  const h=await harness({reapprove:true,automatic:async()=>({localEvent:makeEvent(switched?"event-two":"event-one"),tickets:[],authPayload:{authToken:"token"}})});
  try{
    await h.click("受付を開始する");
    h.navigator.onLine=false;
    await h.scan("ticket-one");
    h.navigator.onLine=true;switched=true;
    await h.poll();
    assert.match(h.text(),/受付端末の承認待ち/);
    assert.equal(await h.local.loadLocalEvent(),null);
    assert.equal((await h.local.getPendingSyncItems()).length,1);
  }finally{await h.close();}
});

test("manual reapplication clears the old event and resumes after approval without a second request",async()=>{
  const h=await harness({initialRegistration:null});
  try{
    await h.local.saveReceptionTransaction({...makeTicket(),currentStatus:"inside"},record("before-reapplication"));
    await h.click("受付端末を登録申請");
    assert.equal(await h.local.loadLocalEvent(),null);
    assert.equal((await h.local.getPendingSyncItems()).length,1);
    await h.approve();
    assert.match(h.text(),/受付準備完了/);
    assert.equal(h.registerCalls,1);
    assert.equal((await h.local.getTicket("ticket-one")).currentStatus,"inside");
  }finally{await h.close();}
});

test("unchanged polling skips inventory downloads; changed versions refresh settings during reception",async()=>{
  let version=1;
  const data=()=>({localEvent:{...makeEvent("event-one",version),settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:version===1}},tickets:[makeTicket()],authPayload:{authToken:"token"}});
  const h=await harness({automatic:async()=>data(),download:async()=>data()});
  try{
    await h.poll();
    assert.equal(h.inventoryDownloads,0);
    await h.click("受付を開始する");
    h.navigator.onLine=false;
    await h.scan("ticket-one");
    version=2;h.navigator.onLine=true;
    await h.poll();
    assert.equal(h.inventoryDownloads,1);
    assert.equal((await h.local.loadLocalEvent()).settings.reentryEnabled,false);
    assert.equal((await h.local.getTicket("ticket-one")).currentStatus,"inside");
    assert.equal(h.renderer.root.findAllByType(h.Scanner).length,1);
  }finally{await h.close();}
});

test("reception service worker does not intercept management navigation",()=>{
  const listeners={};
  new Function("self","URL",readFileSync(new URL("./reception-app/public/sw.js",import.meta.url),"utf8"))({
    location:{href:"https://example.test/QR-Ticket-System/sw.js",origin:"https://example.test"},
    addEventListener:(name,handler)=>{listeners[name]=handler;},
  },URL);
  let intercepted=false;
  listeners.fetch({request:{method:"GET",mode:"navigate",url:"https://example.test/QR-Ticket-System/management-app/"},respondWith:()=>{intercepted=true;}});
  assert.equal(intercepted,false);
});

test("camera restart waits for a pending start and old cleanup before starting the next reader",async()=>{
  let releaseStart,firstStarted;
  const started=new Promise(resolve=>{firstStarted=resolve;});
  const operations=[];
  const readers=new Map(["old-reader","new-reader"].map(id=>[id,{innerHTML:"",querySelectorAll:()=>[]}]));
  class Camera {
    static async getCameras(){return [{id:"front-camera",label:"Front camera"}];}
    constructor(id){this.id=id;this.isScanning=false;}
    async start(){
      operations.push("start:"+this.id);
      if(this.id==="old-reader"){
        firstStarted();
        await new Promise(resolve=>{releaseStart=resolve;});
      }
      this.isScanning=true;
    }
    async stop(){operations.push("stop:"+this.id);this.isScanning=false;}
    clear(){operations.push("clear:"+this.id);}
    async applyVideoConstraints(){}
  }
  const Scanner=load("./reception-app/src/QrScanner.tsx",{
    "html5-qrcode":{Html5Qrcode:Camera,Html5QrcodeSupportedFormats:{QR_CODE:0}},
  },{
    document:{getElementById:id=>readers.get(id)},
    console:{info:()=>{},warn:()=>{},error:()=>{}},
  }).default;
  let oldReader,newReader;
  await act(async()=>{oldReader=create(React.createElement(Scanner,{readerId:"old-reader",onResult:()=>{}}));});
  await started;
  await act(async()=>{oldReader.unmount();newReader=create(React.createElement(Scanner,{readerId:"new-reader",onResult:()=>{}}));});
  assert.deepEqual(operations,["start:old-reader"]);
  await act(async()=>{releaseStart();for(let i=0;i<5;i++)await nextTurn();});
  assert.ok(operations.indexOf("stop:old-reader")<operations.indexOf("start:new-reader"));
  await act(async()=>{newReader.unmount();});
});

test("offline shell registration still runs when authentication completes after window.load",async()=>{
  const registered=[];
  load("./reception-app/src/main.tsx",{
    "react-dom/client":{createRoot:()=>({render:()=>{}})},
    "./App":{default:()=>null},"./styles.css":{},
    "./firebaseClient":{ensureFirebaseAuth:async()=>{}},
  },{
    navigator:{serviceWorker:{register:async(...args)=>registered.push(args)}},
    document:{readyState:"complete",getElementById:()=>({})},
    window:{addEventListener:()=>{throw Error("load already fired");}},
  });
  await nextTurn();
  assert.equal(registered.length,1);
  assert.equal(registered[0][0],"/QR-Ticket-System/sw.js");
});

test("fast scanner serializes processing, accepts the next QR after 60ms and suppresses a held QR",async()=>{
  let decode,resolveFirst,now=1000;
  const timers=[],accepted=[];
  class Camera {
    static async getCameras(){return [{id:"front",label:"Front"}];}
    constructor(){this.isScanning=false;}
    async start(_camera,options,onResult){assert.equal(options.fps,30);decode=onResult;this.isScanning=true;}
    async stop(){this.isScanning=false;}
    clear(){}
    async applyVideoConstraints(){}
  }
  const Scanner=load("./reception-app/src/QrScanner.tsx",{"html5-qrcode":{Html5Qrcode:Camera,Html5QrcodeSupportedFormats:{QR_CODE:0}}},{
    document:{getElementById:()=>({innerHTML:"",querySelectorAll:()=>[]})},
    window:{setTimeout:(fn,delay)=>{assert.equal(delay,60);timers.push(fn);}},
    Date:{now:()=>now},console:{info:()=>{},warn:()=>{},error:()=>{}},
  }).default;
  let renderer;
  await act(async()=>{renderer=create(React.createElement(Scanner,{readerId:"test",onResult:async value=>{accepted.push(value);if(value==="A")await new Promise(resolve=>{resolveFirst=resolve;});}}));await nextTurn();});
  decode("A");await nextTurn();decode("B");assert.deepEqual(accepted,["A"]);
  resolveFirst();await nextTurn();timers.shift()();now=1200;decode("B");await nextTurn();timers.shift()();
  for(now=1500;now<=2700;now+=300)decode("B");
  assert.deepEqual(accepted,["A","B"]);
  now=3300;decode("B");await nextTurn();assert.deepEqual(accepted,["A","B","B"]);
  await act(async()=>renderer.unmount());
});

test("legacy WAV assets are byte-identical; audio unlock does not wait for network preloading",async()=>{
  const expected={"qr_scan_detected.wav":"c030f32e524b8c5f9b43b987d9ab78fb28cc5ac52685a4969505140c67967994","qr_result_chime.wav":"fb6d5070938612822bbe550bce935752ff45a69fafb0b02cb457cec70139b55a","qr_gate_error_chime_v1.wav":"6a7ad6060edd3325181aea0bfeb8fbcc59318c21e61a06a0993972d1dc68bd22"};
  for(const [file,hash] of Object.entries(expected))assert.equal(createHash("sha256").update(readFileSync(new URL("./reception-app/public/sounds/"+file,import.meta.url))).digest("hex"),hash);
  const listeners={},requests=[],pending=[];let resumes=0,starts=0;
  class Context {
    state="suspended";destination={};
    async resume(){resumes++;this.state="running";}
    async decodeAudioData(){return {};}
    createBufferSource(){return {connect:()=>{},disconnect:()=>{},start:()=>{starts++;},stop:()=>{}};}
  }
  const audio=load("./reception-app/src/receptionAudio.ts",{},{window:{AudioContext:Context},document:{addEventListener:(event,fn)=>{listeners[event]=fn;},removeEventListener:event=>delete listeners[event]},fetch:url=>{requests.push(url);return new Promise(resolve=>pending.push(()=>resolve({ok:true,arrayBuffer:async()=>new ArrayBuffer(1)})));}});
  const cleanup=audio.prepareReceptionAudio();assert.equal(requests.length,3);
  listeners.pointerdown();assert.equal(resumes,1);
  pending.forEach(resolve=>resolve());await audio.playReceptionAudio("success");assert.equal(starts,1);
  cleanup();assert.equal(listeners.pointerdown,undefined);
});

test("offline shell preloads all three original audio assets at their full paths",async()=>{
  const listeners={},stored=[];let installed;
  const response={ok:true,clone(){return this;},text:async()=>'<script src="/QR-Ticket-System/assets/app.js"></script>'};
  new Function("self","URL","caches","fetch",readFileSync(new URL("./reception-app/public/sw.js",import.meta.url),"utf8"))({
    location:{href:"https://example.test/QR-Ticket-System/sw.js",origin:"https://example.test"},
    addEventListener:(name,fn)=>listeners[name]=fn,skipWaiting:async()=>{},
  },URL,{open:async()=>({put:async url=>stored.push(url)})},async()=>response);
  listeners.install({waitUntil:promise=>{installed=promise;}});await installed;
  for(const file of ["qr_scan_detected.wav","qr_result_chime.wav","qr_gate_error_chime_v1.wav"])assert.ok(stored.includes("https://example.test/QR-Ticket-System/sounds/"+file));
  assert.ok(stored.includes("https://example.test/QR-Ticket-System/assets/app.js"));
});

test("partial shell updates never activate or replace the offline entry point",async()=>{
  const listeners={},stored=new Map();let activated=false,failAsset=false,failHtml=false;
  const origin="https://example.test";
  const index=origin+"/QR-Ticket-System/index.html";
  const response=(text,ok=true)=>({ok,clone(){return this;},text:async()=>text});
  const old=response("old complete shell");stored.set(index,old);
  const cache={put:async(url,value)=>stored.set(url,value),match:async request=>stored.get(typeof request==="string"?request:request.url)};
  new Function("self","URL","caches","fetch","Response",readFileSync(new URL("./reception-app/public/sw.js",import.meta.url),"utf8"))({
    location:{href:origin+"/QR-Ticket-System/sw.js",origin},
    addEventListener:(name,fn)=>listeners[name]=fn,skipWaiting:async()=>{activated=true;},
  },URL,{open:async()=>cache},async request=>{
    const url=typeof request==="string"?request:request.url;
    if(url.endsWith(".js")&&failAsset)return response("missing",false);
    if(url.endsWith("index.html"))return response('<script src="assets/new.js"></script>',!failHtml);
    return response("asset");
  },Response);
  for(const failure of ["asset","html"]){
    failAsset=failure==="asset";failHtml=failure==="html";
    let installed;listeners.install({waitUntil:promise=>{installed=promise;}});
    await assert.rejects(installed);
    assert.equal(activated,false);assert.equal(stored.get(index),old);
    let navigation;listeners.fetch({request:{method:"GET",mode:"navigate",url:index},respondWith:promise=>{navigation=promise;}});
    assert.equal(await navigation,old);
    assert.equal(stored.get(index),old);
  }
});
