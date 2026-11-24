import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import {IDBFactory} from 'fake-indexeddb';
import {LineTracker} from './reception-app/public/people-counter/tracker.mjs';
import {PROFILES,peopleFromResult} from './reception-app/public/people-counter/detection.mjs';
import {verifyBodies} from './reception-app/public/people-counter/body-check.mjs';
import {openRecordStore,totalOf} from './reception-app/public/people-counter/records.mjs';
import {CameraHealth,MAX_INFERENCE_MS,withDeadline} from './reception-app/public/people-counter/health.mjs';
import {analyze,csv,uploadPending} from './reception-app/public/people-counter/ledger.mjs';
const source=readFileSync(new URL('./reception-app/public/people-counter/app.js',import.meta.url),'utf8')
 .replace(/^import .*;\n/gm,'').replace('void initialize();','');
function harness({factory=new IDBFactory(), denyLocal=false, savedOptions=null, pipelineFactory, ledger, online=true}={}) {
 const nodes=new Map(), listeners=new Map(), tracks=[], raf=new Map(), timers=new Map(), clock={now:0};
 let modelLoads=0,mediaStarts=0,next=0;
 const ctx=Object.fromEntries(['clearRect','drawImage','setLineDash','beginPath','moveTo','lineTo','stroke','fillText','strokeRect','fillRect','arc','fill'].map(k=>[k,()=>{}]));
 const element=id=>{
  if(!nodes.has(id))nodes.set(id,{width:320,height:240,videoWidth:640,videoHeight:480,readyState:4,currentTime:1,style:{},disabled:false,children:[],
   classList:{toggle(){}},getContext:()=>ctx,play:async()=>{},pause(){},addEventListener(name,fn){this['on'+name]=fn},
   append(...xs){this.children.push(...xs)},replaceChildren(...xs){this.children=xs},remove(){}});
  return nodes.get(id);
 };
 const document={hidden:false,getElementById:element,createElement:name=>element(name+'-'+ ++next),addEventListener(name,fn){listeners.set(name,fn)},body:element('body')};
 const map=new Map();if(savedOptions)map.set('koken-counter-options-v1',JSON.stringify(savedOptions));
 const localStorage={getItem:k=>map.get(k)||null,setItem(k,v){if(denyLocal)throw Error('quota');map.set(k,String(v))}};
 const context=vm.createContext({document,window:{indexedDB:factory,counterLedger:ledger,addEventListener(name,fn){listeners.set(name,fn)}},indexedDB:factory,localStorage,
  navigator:{onLine:online,mediaDevices:{async getUserMedia(){mediaStarts++;const callbacks=new Map();const track={readyState:'live',stop(){this.readyState='ended'},
   addEventListener(name,fn){callbacks.set(name,fn)},end(){this.readyState='ended';callbacks.get('ended')?.()}};tracks.push(track);return{getTracks:()=>[track]}}}},
  crypto:webcrypto,console,Blob,URL,setTimeout,clearTimeout,performance:{now:()=>clock.now},
  setInterval:(fn,ms)=>{const id=++next;timers.set(id,{fn,ms});return id},clearInterval:id=>timers.delete(id),
  requestAnimationFrame:fn=>{const id=++next;raf.set(id,fn);return id},cancelAnimationFrame:id=>raf.delete(id),confirm:()=>true,
  LineTracker,PROFILES,peopleFromResult,verifyBodies,openRecordStore:options=>openRecordStore({...options,indexedDB:factory}),totalOf,CameraHealth,MAX_INFERENCE_MS,withDeadline,
  createVisionPipeline:async()=>{modelLoads++;return pipelineFactory?pipelineFactory(modelLoads,clock):{async detectForVideo(){return{objects:{detections:[]},parts:null}},close(){}}}
 });
 vm.runInContext(source+`\nglobalThis.api={initialize,record,flush:()=>eventQueue,startCamera,stopCamera,tick,newSession,checkCameraHealth,refreshRecords,
  ledger:()=>recordStore.ledger(), options:()=>localGet(OPTIONS_KEY),
  release:()=>leaseRelease,state:()=>({counter,session,records:events.map(e=>({...e})),running,status:$('status').textContent,message:$('message').textContent,detectorCached:!!detector})};`,context);
 const api=context.api;
 return{api,element,document,listeners,tracks,clock,stats:()=>({modelLoads,mediaStarts}),async close(){api.stopCamera();await api.flush();await api.release()}};
}
function frame(x){const data=new Int32Array(10000).fill(-1);for(let y=30;y<60;y++)for(let xx=Math.round(x*100)-4;xx<Math.round(x*100)+4;xx++)data[y*100+xx]=12;
 return{objects:{detections:[{boundingBox:{originX:(x-.15)*640,originY:.15*480,width:.3*640,height:.7*480},categories:[{categoryName:'person',score:.9}]}]},parts:{width:100,height:100,data}};}

test('a queued +1 during storage startup survives initialization and reload',async()=>{
 const factory=new IDBFactory(),a=harness({factory});const init=a.api.initialize();
 assert.equal(a.element('addButton').disabled,true);a.api.record(1,'manual');await a.api.flush();await init;
 assert.equal(a.api.state().counter,1);const b=harness({factory});await b.api.initialize();assert.equal(b.api.state().counter,1);await a.close();await b.close();
});
test('app reload restores the same total when localStorage writes fail',async()=>{
 const factory=new IDBFactory(),a=harness({factory,denyLocal:true});await a.api.initialize();await a.api.record(1,'manual');
 const b=harness({factory,denyLocal:true});await b.api.initialize();assert.equal(b.api.state().session,a.api.state().session);assert.equal(b.api.state().counter,1);await a.close();await b.close();
});
test('two app tabs cannot create a negative correction debt',async()=>{
 const factory=new IDBFactory(),a=harness({factory});await a.api.initialize();await a.api.record(1,'manual');
 const b=harness({factory});await b.api.initialize();await Promise.all([a.api.record(-1,'manual'),b.api.record(-1,'manual')]);
 const c=harness({factory});await c.api.initialize();await c.api.record(1,'manual');
 assert.equal(c.api.state().counter,1);assert.equal(c.api.state().records.reduce((s,e)=>s+e.delta,0),1);await a.close();await b.close();await c.close();
});
test('only one tab can start a camera, and stopping releases the other tab',async()=>{
 const factory=new IDBFactory(),a=harness({factory}),b=harness({factory});await a.api.initialize();await b.api.initialize();
 await a.api.startCamera();await b.api.startCamera();assert.equal(a.api.state().running,true);assert.equal(b.api.state().running,false);assert.equal(b.stats().mediaStarts,0);
 a.api.stopCamera();await a.api.release();await b.api.startCamera();assert.equal(b.api.state().running,true);await a.close();await b.close();
});
test('an ended camera immediately removes the normal counting status',async()=>{
 const a=harness();await a.api.initialize();await a.api.startCamera();a.tracks[0].end();
 assert.equal(a.api.state().running,false);assert.notEqual(a.api.state().status,'自動計測中');assert.match(a.api.state().message,/カメラ/);await a.close();
});
test('a frozen video is stopped by the watchdog even without an ended event',async()=>{
 const a=harness();await a.api.initialize();await a.api.startCamera();a.clock.now=3000;a.api.checkCameraHealth();
 assert.equal(a.api.state().running,false);assert.match(a.api.state().message,/更新/);await a.close();
});
test('a broken model is discarded and the next start creates a fresh model',async()=>{
 const a=harness({pipelineFactory:async n=>({async detectForVideo(){if(n===1)throw Error('context lost');return{objects:{detections:[]},parts:null}},close(){}})});
 await a.api.initialize();await a.api.startCamera();await a.api.tick(100);assert.equal(a.api.state().running,false);assert.equal(a.api.state().detectorCached,false);
 await a.api.startCamera();a.element('video').currentTime=2;await a.api.tick(200);assert.equal(a.stats().modelLoads,2);assert.equal(a.api.state().running,true);await a.close();
});
test('a verified visitor still counts at a steady 1.1-second inference cadence',async()=>{
 const path=[.25,.4,.55,.7];let i=0;
 const a=harness({pipelineFactory:async(_,clock)=>({async detectForVideo(){clock.now+=1100;return frame(path[i++])},close(){}})});
 await a.api.initialize();await a.api.startCamera();
 for(let n=0;n<path.length;n++){a.element('video').currentTime=n+2;await a.api.tick(100+n*1100)}await a.api.flush();
 assert.equal(a.api.state().counter,1);assert.equal(a.api.state().running,true);await a.close();
});
test('an excessively slow model stops visibly before accepting the unsafe frame',async()=>{
 const a=harness({pipelineFactory:async(_,clock)=>({async detectForVideo(){clock.now+=1600;return frame(.5)},close(){}})});
 await a.api.initialize();await a.api.startCamera();await a.api.tick(100);
 assert.equal(a.api.state().running,false);assert.match(a.api.state().message,/遅い/);assert.equal(a.api.state().counter,0);await a.close();
});
test('a session change in another tab stops a camera that is still loading its model',async()=>{
 let finish;const pending=new Promise(resolve=>{finish=resolve});
 const factory=new IDBFactory(),a=harness({factory,pipelineFactory:()=>pending}),b=harness({factory});
 await a.api.initialize();await b.api.initialize();const starting=a.api.startCamera();
 // Wait until the camera/model loading has actually begun, without wall-clock sleeps.
 for(let n=0;n<30&&a.stats().modelLoads===0;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(a.stats().modelLoads,1);await b.api.newSession();await a.api.refreshRecords();
 finish({async detectForVideo(){return{objects:{detections:[]},parts:null}},close(){}});await starting;
 assert.equal(a.api.state().running,false);await a.close();await b.close();
});
test('counting lines keep the required gap and invalid saved settings cannot block startup',async()=>{
 const a=harness({savedOptions:{movement:'x+',profile:'side',first:48,second:52}});
 assert.equal(await a.api.initialize(),true);assert.equal(a.element('firstLine').value,'40');
 a.element('firstLine').value='48';a.element('firstLine').oninput({target:{id:'firstLine'}});
 a.element('secondLine').value='52';a.element('secondLine').oninput({target:{id:'secondLine'}});
 assert.equal(a.element('secondLine').value,'58');await a.api.record(1,'manual');assert.equal(a.api.state().counter,1);await a.close();
});

test('leg mode is restored and wired into the camera loop instead of accepting torso-only frames',async()=>{
 const a=harness({savedOptions:{movement:'x+',profile:'side',first:40,second:60,bodyMode:'legs'},pipelineFactory:async()=>({async detectForVideo(){return frame(.5)},close(){}})});
 await a.api.initialize();assert.equal(a.element('bodyMode').value,'legs');await a.api.startCamera();await a.api.tick(100);
 assert.match(a.element('tracking').textContent,/胴体＋脚足確認 0人/);
 a.element('bodyMode').value='torso';a.element('bodyMode').oninput();a.element('video').currentTime=3;await a.api.tick(300);
 assert.match(a.element('tracking').textContent,/胴体確認 1人/);await a.close();
});

test('venue trials count only complete passages inside the area and compare independently of normal records', async () => {
  const path = [.25, .4, .55, .7, .25, .4, .3, .22, .22, .22];
  let index = 0;
  const a = harness({
    savedOptions: {movement:'x+', profile:'side', first:40, second:60, top:20, bottom:70},
    pipelineFactory: async () => ({
      async detectForVideo() {
        const input = frame(path[index]);
        if (index++ < 4) {
          input.parts.data.fill(-1);
          const x = Math.round(path[index - 1] * 100);
          for (let y = 9; y < 27; y++) input.parts.data.fill(12, y * 100 + x - 4, y * 100 + x + 4);
          input.objects.detections[0].boundingBox.originY = 0;
        }
        return input;
      },
      close() {},
    }),
  });
  await a.api.initialize();
  await a.api.startCamera();
  a.element('trialAngle').value = '25';
  a.element('trialNote').value = '入口横の机';
  a.element('trialStart').onclick();
  assert.equal(a.element('firstLine').disabled, true);
  for (let n = 0; n < path.length; n++) {
    a.element('video').currentTime = n + 2;
    await a.api.tick(100 + n * 120);
  }
  assert.match(a.element('trialStatus').textContent, /自動 0人/);
  a.element('trialEnd').onclick();
  a.element('trialActual').value = '1';
  a.element('trialSave').onclick();
  assert.match(a.element('trialResults').children[0].textContent, /斜め25°.*自動 0人.*実際 1人.*差 -1人/);
  assert.equal(a.element('firstLine').disabled, false);
  assert.equal(a.api.state().counter, 0);
  await a.close();
});

test('a complete verified passage increments only the active venue trial', async () => {
  const path = [.25, .4, .55, .7];
  let index = 0;
  const a = harness({pipelineFactory: async () => ({async detectForVideo(){return frame(path[index++]);}, close(){}})});
  await a.api.initialize();
  await a.api.startCamera();
  a.element('trialAngle').value = '45';
  a.element('trialNote').value = '';
  a.element('trialStart').onclick();
  for (let n = 0; n < path.length; n++) {
    a.element('video').currentTime = n + 2;
    await a.api.tick(100 + n * 120);
  }
  assert.match(a.element('trialStatus').textContent, /斜め45°.*自動 1人/);
  assert.equal(a.api.state().counter, 0);
  await a.close();
});

test('a tap on the live preview moves a line in the selected reverse direction', async () => {
  const a = harness({savedOptions: {movement:'x-', profile:'side', first:40, second:60}});
  await a.api.initialize();
  await a.api.startCamera();
  a.element('cameraFrame').getBoundingClientRect = () => ({left:100, top:0, width:500, height:300});
  a.element('overlayTarget').value = 'firstLine';
  const input = a.element('firstLine');
  input.min = '20';
  input.max = '48';
  input.id = 'firstLine';
  a.element('cameraFrame').onclick({clientX:425, clientY:100});
  assert.equal(input.value, '35');
  assert.equal(a.element('firstValue').textContent, '35%');
  await a.close();
});

function directionFrame(points) {
  const data = new Int32Array(10000).fill(-1);
  const detections = points.map(([x, y]) => {
    for (let row = Math.round(y * 100) - 10; row < Math.round(y * 100) + 10; row++) {
      const center = row * 100 + Math.round(x * 100);
      data.fill(12, center - 4, center + 4);
    }
    return {boundingBox:{originX:(x-.10)*640, originY:(y-.22)*480, width:.20*640, height:.44*480},
      categories:[{categoryName:'person',score:.9}]};
  });
  return {objects:{detections}, parts:{width:100,height:100,data}};
}

const forward = [.22,.34,.46,.58,.70,.81];
const backward = forward.map(x => 1 - x);
const directionCases = [
  {name:'entrance visitor', role:'in', paths:[forward], count:1},
  {name:'exit visitor', role:'out', paths:[forward], count:1},
  {name:'reverse passage at entrance', role:'in', paths:[backward], count:0},
  {name:'reverse passage at exit', role:'out', paths:[backward], count:0},
  {name:'two forward passages', role:'in', paths:[forward,forward], count:2},
  {name:'two reverse passages', role:'out', paths:[backward,backward], count:0},
  {name:'opposite-direction crossing', role:'in', paths:[forward,backward], count:1},
  {name:'stop before B', role:'in', paths:[[.21,.35,.45,.50,.50,.50]], count:0},
  {name:'turn back before B', role:'out', paths:[[.21,.35,.45,.50,.39,.29]], count:0},
  {name:'offline visitor', role:'in', paths:[forward], count:1, online:false},
  {name:'offline reverse passage', role:'in', paths:[backward], count:0, online:false},
  {name:'vertically reversed camera', role:'out', paths:[backward,forward], count:1, movement:'y-'},
];

for (const {name, role, paths, count, online, movement} of directionCases) {
  test('camera to IndexedDB, upload and CSV: ' + name, async () => {
    const factory = new IDBFactory();
    const captured = [];
    const ledger = {
      role: () => role,
      capture(at, source) {
        captured.push(at);
        return {eventId:'venue',mode:'live',device:'test-device',station:role,direction:role,rawAt:at,at,
          invalid:false,person:'visitor',source};
      },
      changed() {},
      attach() {},
    };
    let index = 0;
    const a = harness({factory, ledger, online, savedOptions:{movement:movement ?? 'x+',first:40,second:60},
      pipelineFactory:async () => ({
        detectForVideo() {
          const points = paths.map((path, lane) => [path[index],lane === 0 ? .35 : .65]);
          index++;
          return directionFrame(movement ? points.map(([x,y]) => [y, Math.max(.22, Math.min(.77, x))]) : points);
        },
        close() {},
      })});
    assert.equal(await a.api.initialize(),true);
    assert.match(a.element('directionGuide').textContent, role === 'out' ? /A（展示室側）→ B（廊下側）/ : /A（廊下側）→ B（展示室側）/);
    await a.api.startCamera();
    a.element('showTracking').checked = true;
    for (let n = 0; n < paths[0].length; n++) {
      a.element('video').currentTime = n + 2;
      await a.api.tick(100 + n * 120);
    }
    await a.api.flush();
    assert.equal(a.api.state().counter,count);
    assert.equal(a.api.state().records.length,count);
    assert.equal(captured.length,count);
    const reversePaths = paths.filter(path => path === (movement ? forward : backward)).length;
    const reverseStates = a.element('diagnostics').textContent.match(/逆方向 B→A・対象外/g) ?? [];
    assert.equal(reverseStates.length,reversePaths);
    await a.close();
    const restored = await openRecordStore({indexedDB:factory});
    const rows = await restored.ledger();
    assert.equal(restored.initial.events.length,count);
    assert.equal(rows.length,count);
    assert.ok(rows.every(row => row.station === role && row.direction === role && !row.synced));
    // On reconnect, only actual visitor operations can enter the transport.
    const sent = [];
    await uploadPending(restored,rows,'venue','live',async (_,__,batch) => sent.push(...batch));
    assert.equal(sent.length,count);
    const result = analyze(await restored.ledger(),{eventId:'venue',mode:'live',opened:0});
    assert.equal(result.entries,count * Number(role === 'in'));
    assert.equal(result.exits,count * Number(role === 'out'));
    const report = csv([['id','at'],...result.effective.map(row => [row.originalId,row.at])]);
    assert.equal(report.split('\r\n').length,1+count);
    restored.close();
  });
}

test('direction test confirms both paths transiently and reversing keeps the physical lines in place', async () => {
  let index = 0;
  const a = harness({savedOptions:{movement:'x+',first:33,second:63},pipelineFactory: async () => ({
    detectForVideo() {
      const n = index++;
      return directionFrame([[forward[n],.35],[backward[n],.65]]);
    },
    close() {},
  })});
  await a.api.initialize();
  a.element('reverseDirection').onclick();
  assert.equal(a.element('movement').value,'x-');
  assert.equal(a.element('firstLine').value,'37');
  assert.equal(a.element('secondLine').value,'67');
  const b = harness({savedOptions:JSON.parse(a.api.options())});
  await b.api.initialize();
  assert.equal(b.element('movement').value,'x-');
  assert.equal(b.element('firstLine').value,'37');
  await b.close();
  await a.api.startCamera();
  a.element('trialAngle').value = '25';
  a.element('trialNote').value = '';
  a.element('trialStart').onclick();
  assert.equal(a.element('reverseDirection').disabled,true);
  for (let n = 0; n < forward.length; n++) {
    a.element('video').currentTime = n + 2;
    await a.api.tick(100 + n * 120);
  }
  assert.match(a.element('directionTest').textContent,/正方向 A→B 確認済み.*逆方向 B→A 除外を確認/);
  assert.match(a.element('trialStatus').textContent,/自動 1人/);
  a.element('trialEnd').onclick();
  assert.equal(a.element('directionTest').textContent,'');
  a.element('trialActual').value = '1';
  a.element('trialSave').onclick();
  assert.equal(a.api.state().counter,0);
  assert.equal((await a.api.ledger()).length,0);
  await a.close();
});
