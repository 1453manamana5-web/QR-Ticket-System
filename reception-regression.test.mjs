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

test("simultaneous inventory refreshes never erase a successfully committed offline inventory",async()=>{
  const local=localDb();
  await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  const results=await Promise.allSettled([
    local.prepareLocalEventData(makeEvent("event-two"),[makeTicket("event-two")]),
    local.prepareLocalEventData(makeEvent("event-three"),[makeTicket("event-three")]),
  ]);
  assert.ok(results.every(result=>result.status==="fulfilled"));
  const saved=await local.loadLocalEvent();
  assert.ok(saved?.dataReady);
  assert.equal(await local.countTickets(saved.event.eventId),saved.ticketCount);
});

test("a delayed older inventory refresh cannot roll back a newer offline version",async()=>{
  const local=localDb();
  await local.prepareLocalEventData(makeEvent("event-one",4),[{...makeTicket(),valid:false}]);
  await assert.rejects(local.prepareLocalEventData(makeEvent("event-one",2),[makeTicket()]),/LOCAL_EVENT_VERSION_CHANGED/);
  assert.equal((await local.loadLocalEvent()).event.dataVersion,4);
  assert.equal((await local.getTicket("ticket-one")).valid,false);
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

test("revocation during manual authentication cannot store the late event response",async()=>{
  let finish;
  const h=await harness({saved:false,automatic:async()=>{throw Error("NO_PUBLISHED_EVENT");},download:()=>new Promise(resolve=>{finish=resolve;})});
  try{
    await h.click("イベントデータQRを読み取る");
    await h.scan(JSON.stringify({type:"qr-ticket-event-auth",...makeEvent().event,authToken:"test-token"}));
    const button=h.renderer.root.findAllByType("button").find(node=>node.children.join("")==="このイベントで認証");
    await act(async()=>{button.props.onClick();});await h.flush();
    assert.ok(finish);
    await h.revoke();
    await act(async()=>finish({localEvent:makeEvent(),tickets:[makeTicket()]}));await h.flush();
    assert.equal(await h.local.loadLocalEvent(),null);
    assert.match(h.text(),/受付端末を登録/);
  }finally{await h.close();}
});

test("a remote gate switch waits for the current scan and applies before the next scan",async()=>{
  let finish;
  const h=await harness({latestTicket:()=>new Promise(resolve=>{finish=resolve;})});
  try{
    await h.click("受付を開始する");
    let scan;
    await act(async()=>{scan=h.renderer.root.findByType(h.Scanner).props.onResult("ticket-one");});await h.flush();
    await h.control("出口受付","2099-10-27T01:00:00.000Z");
    assert.equal(h.renderer.root.findAllByType("button").find(node=>node.props.className?.includes("entry-reception-mode-switch")).props["aria-pressed"],false);
    await act(async()=>{finish(makeTicket());await scan;});await h.flush();
    assert.equal(h.renderer.root.findAllByType("button").find(node=>node.props.className?.includes("entry-reception-mode-switch")).props["aria-pressed"],true);
    const items=await h.local.getPendingSyncItems();
    assert.equal(items.length,1);assert.equal((await h.local.getReceptionRecord(items[0].recordId)).type,"entry");
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

test("aborted local reception save rejects and leaves no partial record or ticket change",async()=>{
  const factory=new IDBFactory();let abortNext=false;
  const local=load("./reception-app/src/localDb.ts",{},{indexedDB:{open:(...args)=>{
    const request=factory.open(...args);
    request.addEventListener("success",()=>{
      const db=request.result,transaction=db.transaction.bind(db);
      db.transaction=(...args)=>{
        const tx=transaction(...args);
        if(abortNext&&args[1]==="readwrite"){
          abortNext=false;
          const objectStore=tx.objectStore.bind(tx);
          tx.objectStore=name=>{
            const store=objectStore(name);
            if(name==="syncQueue"){
              const put=store.put.bind(store);
              store.put=(...values)=>{
                const request=put(...values);
                request.addEventListener("success",()=>tx.abort());
                return request;
              };
            }
            return store;
          };
        }
        return tx;
      };
    });return request;
  }}});
  await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  abortNext=true;
  let settled=false;
  const saving=local.saveReceptionTransaction({...makeTicket(),currentStatus:"inside"},record("aborted"));
  const checked=assert.rejects(saving,/中断/).then(()=>{settled=true;});
  for(let i=0;i<50&&!settled;i++)await nextTurn();
  assert.equal(settled,true,"aborted save must not leave reception permanently busy");
  await checked;
  assert.equal((await local.getTicket("ticket-one")).currentStatus,"unused");
  assert.equal(await local.getReceptionRecord("aborted"),null);
  assert.equal((await local.getPendingSyncItems()).length,0);
});

test("exit-mode ready preview displays exit instead of a stale entry result",async()=>{
  const h=await harness();
  try{
    await h.control("出口受付","2026-10-27T01:00:00.000Z");
    await h.click("受付結果を試験表示");
    assert.match(h.text(),/退出OK/);
    assert.doesNotMatch(h.text(),/入場OK/);
  }finally{await h.close();}
});

test("manual gate switch cannot change mode during an in-flight scan",async()=>{
  let release;
  const h=await harness({latestTicket:()=>new Promise(resolve=>{release=()=>resolve(makeTicket());})});
  try{
    await h.click("受付を開始する");
    const scan=h.scan("ticket-one");
    for(let i=0;i<50&&!release;i++)await nextTurn();
    assert.ok(release);
    await act(async()=>{h.renderer.root.findByProps({"aria-label":"入口受付。左右にスワイプして出口受付へ切り替え"}).props.onClick();});
    release();await scan;
    assert.ok(h.renderer.root.findByProps({"aria-label":"入口受付。左右にスワイプして出口受付へ切り替え"}));
    assert.equal((await h.local.getPendingSyncItems()).length,1);
  }finally{await h.close();}
});

test('invalid downloaded inventory is rejected before the previous offline data is replaced',async()=>{
  const local=localDb();await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  for(const ticket of [{...makeTicket(),valid:'true'},{...makeTicket(),currentStatus:'broken'},{...makeTicket(),eventId:'wrong'},makeTicket(),{...makeTicket(),basicInfo:null}]){
    const values=ticket===undefined?[]:[ticket];
    if(ticket.valid===true&&ticket.currentStatus==='unused'&&ticket.eventId==='event-one'&&ticket.basicInfo)values.push(ticket);
    const next={...makeEvent(),ticketCount:values.length};
    await assert.rejects(local.prepareLocalEventData(next,values));
    assert.equal((await local.getTicket('ticket-one')).valid,true);
    assert.equal((await local.loadLocalEvent()).dataReady,true);
  }
});

test('camera failure exposes a retry that remounts the reader and stopping leaves inventory intact',async()=>{
  const h=await harness();try{
    await h.click('受付を開始する');
    const reader=h.renderer.root.findByType(h.Scanner),key=reader._fiber?.key;
    await act(async()=>reader.props.onError('permission temporarily unavailable'));await h.flush();
    assert.match(h.text(),/カメラを再起動/);
    await h.click('カメラを再起動');
    assert.ok(h.renderer.root.findByType(h.Scanner));
    await h.click('受付を停止');assert.equal(h.renderer.root.findAllByType(h.Scanner).length,0);
    assert.equal((await h.local.loadLocalEvent()).dataReady,true);
    assert.equal((await h.local.countTickets('event-one')),1);
  }finally{await h.close();}
});

for(const mode of ['entry','exit'])for(const status of ['unused','inside','exited'])for(const enabled of [true,false]){
  test(`offline reception matrix: ${mode} ${status} settings=${enabled}`,async()=>{
    const data={...makeEvent('event-one',2),settings:{entryEnabled:enabled,exitEnabled:enabled,reentryEnabled:enabled}};
    const bundle=()=>({localEvent:data,tickets:[{...makeTicket(),currentStatus:status}],authPayload:{authToken:'token'}});
    const h=await harness({automatic:async()=>bundle(),download:async()=>bundle()});
    try{
      await h.click('受付を開始する');h.navigator.onLine=false;
      if(mode==='exit')await h.control('出口受付','2026-10-27T02:00:00.000Z');
      await h.scan('ticket-one');
      const allowed=enabled&&(mode==='entry'?status!=='inside':status==='inside');
      assert.equal((await h.local.getPendingSyncItems()).length,allowed?1:0);
      if(allowed)assert.equal((await h.local.getTicket('ticket-one')).currentStatus,mode==='exit'?'exited':'inside');
      else assert.match(h.text(),/受付失敗/);
    }finally{await h.close();}
  });
}

test('delayed Japanese voice discovery never speaks the same result twice or revives an old scan',()=>{
  const callbacks=new Set(),timers=[],spoken=[];
  const synth={cancel(){},getVoices:()=>[],speak:value=>spoken.push(value.text),addEventListener:(_event,fn)=>callbacks.add(fn),removeEventListener:(_event,fn)=>callbacks.delete(fn)};
  const source=readFileSync(new URL('./reception-app/src/App.tsx',import.meta.url),'utf8')+'\nexport {speakReception};';
  const out={};new Function('exports','require','window','SpeechSynthesisUtterance',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,()=>({getReceptionAudioSettings:()=>({volume:1,voiceGuidance:true})}),{speechSynthesis:synth,setTimeout:fn=>timers.push(fn)},class{constructor(text){this.text=text;}});
  out.speakReception('entry');out.speakReception('exit');
  [...callbacks].forEach(fn=>fn());timers.forEach(fn=>fn());
  assert.deepEqual(spoken,['ご来場ありがとうございました。']);
});

test('slow server reads have a bounded read-only deadline so downloaded inventory can be used',async()=>{
  const sync=load('./reception-app/src/receptionSync.ts',{
    './localDb':{},'./firebaseClient':{ensureFirebaseAuth:async()=>{},getFirebaseDb:()=>({})},
    'firebase/firestore':{doc:()=>({}),getDocFromServer:()=>new Promise(()=>{})},
  },{setTimeout:fn=>{fn();return 1;},clearTimeout:()=>{}});
  await assert.rejects(sync.getLatestReceptionTicket('event-one','ticket-one'),error=>error.code==='deadline-exceeded');
});

test('version 7 queue upgrades preserve history and allocate new sequences after the largest stored sequence',async()=>{
  const factory=new IDBFactory();
  await new Promise((resolve,reject)=>{
    const request=factory.open('qr-ticket-reception',7);
    request.onupgradeneeded=()=>{
      const db=request.result;
      db.createObjectStore('event',{keyPath:'event.eventId'});
      db.createObjectStore('tickets',{keyPath:'ticketId'}).createIndex('eventId','eventId');
      db.createObjectStore('receptionRecords',{keyPath:'recordId'});
      db.createObjectStore('syncQueue',{keyPath:'recordId'}).createIndex('status','status');
    };
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result,tx=db.transaction(['receptionRecords','syncQueue'],'readwrite');
      for(let i=1;i<=1000;i++){
        tx.objectStore('receptionRecords').put(record('history-'+i));
        tx.objectStore('syncQueue').put({recordId:'history-'+i,status:i===1000?'syncing':'synced',retryCount:0,sequence:i});
      }
      tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
    };
  });
  const local=load('./reception-app/src/localDb.ts',{},{indexedDB:factory});
  await local.saveReceptionTransaction({...makeTicket(),currentStatus:'inside'},record('new-entry'));
  const pending=await local.getPendingSyncItems();assert.deepEqual(pending.map(item=>item.recordId),['history-1000','new-entry']);
  assert.equal(pending[1].sequence,1001);assert.ok(await local.getReceptionRecord('history-1'));
});

test('simultaneous local readers cannot accept the same unused ticket twice',async()=>{
  const local=localDb();await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  const expected=await local.getTicket('ticket-one');
  const results=await Promise.allSettled([local.saveReceptionTransaction({...expected,currentStatus:'inside'},record('tab-a'),expected),local.saveReceptionTransaction({...expected,currentStatus:'inside'},record('tab-b'),expected)]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((await local.getPendingSyncItems()).length,1);
});

test('accepting a newly issued server ticket updates local inventory count for the next offline restart',async()=>{
  const local=localDb();await local.prepareLocalEventData(makeEvent(),[makeTicket()]);
  const added={...makeTicket(),ticketId:'new-ticket',currentStatus:'inside'};
  await local.saveReceptionTransaction(added,{...record('new-ticket-entry'),ticketId:'new-ticket'},null);
  assert.equal((await local.loadLocalEvent()).ticketCount,2);assert.equal(await local.countTickets('event-one'),2);
});


function recordedAudioHarness({play,fetch:fetchSound,volume=45,successSound=true,cache}={}){
  const players=[],listeners={};let urls=0;
  class Player{
    paused=true;volume=1;currentTime=0;
    constructor(src){this.src=src;players.push(this);}
    load(){}pause(){this.paused=true;}
    play(){this.paused=false;return play?play(this):Promise.resolve();}
  }
  const response={ok:true,blob:async()=>({}),clone(){return this;}};
  const audio=load('./reception-app/src/receptionAudio.ts',{},{
    window:{AudioContext:class{constructor(){throw Error('legacy WAV playback must not use Web Audio');}},...(cache?{caches:{open:async()=>cache}}:{})},
    Audio:Player,URL:{createObjectURL:()=>`blob:sound-${++urls}`},
    document:{addEventListener:(event,fn)=>listeners[event]=fn,removeEventListener:event=>delete listeners[event]},
    fetch:fetchSound??(async()=>response),localStorage:{getItem:()=>JSON.stringify({volume,successSound,voiceGuidance:false})},console:{warn(){}},
  });
  return {audio,players,listeners,response};
}

test('legacy media playback starts synchronously without Web Audio or waiting for preload',async()=>{
  let called=0;const h=recordedAudioHarness({fetch:()=>new Promise(()=>{}),play:()=>{called++;return Promise.resolve();}});
  const cleanup=h.audio.prepareReceptionAudio();assert.equal(h.players.length,3);
  const result=h.audio.playReceptionAudio('success');assert.equal(called,1);
  assert.equal(await result,'played');assert.equal(h.players[1].volume,.45);
  assert.equal(h.audio.getReceptionAudioSettings().voiceGuidance,false);
  cleanup();assert.equal(Object.keys(h.listeners).length,0);
});

test('all original media elements are primed on touch completion and reused for scans',async()=>{
  const h=recordedAudioHarness({fetch:()=>new Promise(()=>{})});
  h.audio.prepareReceptionAudio();h.listeners.touchend();await nextTurn();
  assert.equal(h.players.length,3);assert.ok(h.players.every(p=>p.paused&&p.volume===.45));
  await h.audio.playReceptionAudio('detected');assert.equal(h.players.length,3);assert.equal(h.players[0].paused,false);
});

test('late unlock completion cannot pause or lower the volume of a real result',async()=>{
  const pending=[];const h=recordedAudioHarness({fetch:()=>new Promise(()=>{}),play:p=>p.volume===.01?new Promise(resolve=>pending.push(resolve)):Promise.resolve()});
  h.audio.prepareReceptionAudio();h.listeners.pointerdown();
  await h.audio.playReceptionAudio('success');const success=h.players[1];
  pending.forEach(resolve=>resolve());await nextTurn();
  assert.equal(success.paused,false);assert.equal(success.volume,.45);
});

test('cached original WAVs are played through Blob URLs rather than Range requests',async()=>{
  let fetches=0;const response={ok:true,blob:async()=>({})};
  const h=recordedAudioHarness({fetch:async()=>{fetches++;throw Error('offline');},cache:{match:async()=>response}});
  h.audio.prepareReceptionAudio();await nextTurn();await nextTurn();
  assert.equal(await h.audio.playReceptionAudio('success'),'played');
  assert.match(h.players[1].src,/^blob:sound-/);assert.equal(fetches,0);
});

test('muted preferences stay muted and rejected media playback reports blocked for retry',async()=>{
  let attempts=0;const muted=recordedAudioHarness({volume:0,play:async()=>{attempts++;}});
  assert.equal(await muted.audio.playReceptionAudio('error'),'muted');assert.equal(attempts,0);
  const disabled=recordedAudioHarness({successSound:false});assert.equal(await disabled.audio.playReceptionAudio('success'),'muted');
  const h=recordedAudioHarness({play:async()=>{if(++attempts===1)throw Error('NotAllowedError');}});
  assert.equal(await h.audio.playReceptionAudio('success'),'blocked');
  assert.equal(await h.audio.playReceptionAudio('success'),'played');assert.equal(h.players.length,1);
});
