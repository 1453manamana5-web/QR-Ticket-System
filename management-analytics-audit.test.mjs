import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {webcrypto} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import React from 'react';
import {act,create} from 'react-test-renderer';
const require=createRequire(import.meta.url),ts=require('typescript');
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
function load(path,deps={},globals={}) {
  if(path==='management-app/src/App.tsx')deps={...deps,'../../shared/src/receptionTiming':load('shared/src/receptionTiming.ts')};
  const out={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n in deps?deps[n]:require(n),...Object.values(globals));return out;
}

const nodeText=node=>node.children.map(child=>typeof child==='string'?child:nodeText(child)).join('');
const analysisMetric=(h,label)=>h.renderer.root.findAll(node=>typeof node.props.className==='string'&&node.props.className.split(' ').includes('analysis-metric')).find(node=>node.findByType('small').children.join('')===label).findByType('strong').children.join('');
const analysisStatus=(h,label)=>h.renderer.root.findAllByProps({className:'analysis-status-row'}).find(node=>node.findByType('b').children.join('')===label).findByType('strong').children.join('');
async function selectAnalysis(h,name){
  const button=h.renderer.root.findAllByType('button').find(node=>String(node.props.className).includes('analysis-history-item')&&nodeText(node).includes(name));
  assert.ok(button,'Missing analysis '+name);await act(async()=>button.props.onClick());await h.flush();
}

test('automatic event transitions use the Japanese timetable on every device timezone',()=>{
  const automatic=load('management-app/src/eventUtils.ts').getAutomaticEventStatus;
  const original=process.env.TZ;
  try{
    for(const zone of ['UTC','Asia/Tokyo','America/Los_Angeles']){
      process.env.TZ=zone;
      const target={...event(),eventDate:'2026-11-06',eventStatus:'ready'};
      const opening=Date.parse('2026-11-06T09:00:00+09:00'),closing=Date.parse('2026-11-06T17:00:00+09:00');
      assert.equal(automatic(target,opening-1),null,zone);
      assert.equal(automatic(target,opening),'active',zone);
      assert.equal(automatic({...target,eventStatus:'active'},closing-1),null,zone);
      assert.equal(automatic(target,closing),'finalizing',zone);
      assert.equal(automatic({...target,eventStatus:'finished'},closing),null,zone);
      assert.equal(automatic({...target,endTime:'08:00'},opening),null,zone);
    }
  }finally{if(original===undefined)delete process.env.TZ;else process.env.TZ=original;}
});

test('malformed reception acknowledgements block finalization without crashing management',()=>{
  const terminal={terminalId:'T-RECEPTION',approved:true,role:'reception',receptionApproved:true,status:'online',lastSeen:null,syncPendingCount:0,receptionMode:'stopped',receptionEventId:'event-a'};
  for(const reported of [{},{toMillis:0},null,undefined])assert.equal(safety.receptionDataCollected([{...terminal,receptionReportedAt:reported}],'event-a'),false);
});

test('real admissions count reserve tickets before print confirmation syncs while trial stock stays excluded',()=>{
  const timing=load('shared/src/receptionTiming.ts');
  const target={...event(),eventDate:'2026-11-06'};
  const stock={...ticket(),basicInfo:{reserve:true},currentStatus:'unused'};
  const admitted={...stock,currentStatus:'inside',updatedAt:'2026-11-06T00:00:00.000Z'};
  assert.equal(safety.isCountedTicket(stock),false);
  assert.equal(safety.isCountedTicket(admitted),true);
  assert.equal(safety.isCountedTicket({...admitted,currentStatus:'exited'}),true);
  const trial=timing.productionTicketStates([{...admitted,updatedAt:'2026-11-05T23:59:59.999Z'}],target)[0];
  assert.equal(safety.isCountedTicket(trial),false);
});

test('historical analysis retains saved totals while loading and after a network failure',async()=>{
  let rejectTickets;
  const saved={eventId:'event-b',eventName:'event-b',eventDate:'2099-10-27',total:10,unused:3,inside:4,exited:3,savedAt:new Date().toISOString()};
  const h=await harness({loadAnalysis:async()=>[saved],loadEventTickets:()=>new Promise((_resolve,reject)=>{rejectTickets=reject;})});
  try{
    await h.nav('分析');await selectAnalysis(h,'event-b');
    assert.equal(analysisMetric(h,'来場者数'),'7');assert.equal(analysisStatus(h,'入場中'),'4');assert.equal(analysisStatus(h,'退場済み'),'3');
    const csv=()=>h.renderer.root.findAllByType('button').find(node=>nodeText(node)==='CSV出力');
    assert.equal(csv().props.disabled,true);
    await act(async()=>rejectTickets(Error('network unavailable')));await h.flush();
    assert.equal(analysisMetric(h,'来場者数'),'7');assert.equal(analysisStatus(h,'入場中'),'4');assert.equal(analysisStatus(h,'退場済み'),'3');
    assert.match(h.text(),/過去データを取得できませんでした/);assert.equal(csv().props.disabled,true);
  }finally{await h.close();}
});

test('historical status cards and Japan-time charts use the selected event and fresh schedule',async()=>{
  const previous={...event('event-b'),eventDate:'2026-11-06',eventStatus:'finished'};
  const before='2026-11-05T23:59:59.000Z',insideAt='2026-11-06T00:00:00.000Z',exitAt='2026-11-06T00:03:00.000Z';
  const tickets=[['TKT1','inside',insideAt],['TKT2','exited',exitAt],['TRIAL','inside',before]].map(([id,status,at])=>({...ticket('event-b'),ticketId:id,currentStatus:status,updatedAt:at}));
  const records=[['entry',insideAt,'TKT1'],['exit',exitAt,'TKT2'],['entry',before,'TRIAL']].map(([type,at,id],index)=>({recordId:'r'+index,eventId:'event-b',ticketId:id,type,timestamp:at,terminalId:'T-RECEPTION'}));
  const h=await harness({events:[event(),previous],loadEventTickets:async()=>tickets,loadEventReceptionRecords:async()=>records});
  try{
    await h.nav('分析');await selectAnalysis(h,'event-b');
    assert.equal(analysisMetric(h,'来場者数'),'2');assert.equal(analysisStatus(h,'未使用'),'1');assert.equal(analysisStatus(h,'入場中'),'1');assert.equal(analysisStatus(h,'退場済み'),'1');
    const nine=h.renderer.root.findAllByProps({className:'analysis-live-bar-column'}).find(node=>node.findByType('span').children.join('')==='09:00');
    assert.equal(nine.findByType('b').children.join(''),'1');
    assert.match(nodeText(h.renderer.root.findByType('output')),/09:03:00/);
    await h.click('CSV出力');
    const csv=await h.downloads[0].text();
    assert.match(csv,/"イベント名","event-b"/);assert.match(csv,/"来場者数","2"/);
    assert.match(csv,/"入場中","1"/);assert.match(csv,/"退場済み","1"/);
    assert.match(csv,/TKT1/);assert.doesNotMatch(csv,/TRIAL/);
    await h.events([event(),{...previous,startTime:'10:00'}]);
    assert.equal(analysisMetric(h,'来場者数'),'0');assert.equal(analysisStatus(h,'未使用'),'3');
    assert.equal(h.renderer.root.findAllByType('polyline').length,0);
  }finally{await h.close();}
});

test('switching the current event retains saved analysis for earlier events',async()=>{
  const saved={eventId:'event-a',eventName:'event-a',eventDate:'2099-10-27',total:10,unused:3,inside:4,exited:3,savedAt:new Date().toISOString()};
  const h=await harness({loadAnalysis:async id=>id==='event-a'?[saved]:[],loadEventTickets:async()=>{throw Error('offline');}});
  try{
    await h.nav('イベント管理');
    await act(async()=>h.renderer.root.findByProps({'aria-label':'event-bを選択'}).props.onClick());await h.flush();
    await h.nav('分析');await selectAnalysis(h,'event-a');
    assert.equal(analysisMetric(h,'来場者数'),'7');assert.equal(analysisStatus(h,'入場中'),'4');
    assert.match(h.storage.get('qr-ticket-analysis-history'),/event-a/);
  }finally{await h.close();}
});

async function openAssistant(h){
  await act(async()=>h.renderer.root.findByProps({'aria-label':'AI試験メニューを開く'}).props.onClick());await h.flush();
  const menu=h.renderer.root.findAllByProps({role:'menuitem'}).find(node=>nodeText(node).includes('AIイベント分析アシスタント'));
  assert.ok(menu);await act(async()=>menu.props.onClick());await h.flush();
}

test('the analysis assistant falls back to saved history after previous-event loading fails',async()=>{
  const saved={eventId:'event-b',eventName:'event-b',eventDate:'2099-10-27',total:10,unused:3,inside:4,exited:3,savedAt:new Date().toISOString()};
  const h=await harness({loadAppSettings:async()=>({aiLabEnabled:true}),loadAnalysis:async()=>[saved],loadEventTickets:async()=>{throw Error('offline');}});
  try{
    await openAssistant(h);
    assert.match(h.text(),/保存済み分析：/);assert.match(h.text(),/10/);assert.match(h.text(),/チケット /);
    assert.doesNotMatch(h.text(),/過去イベント：総チケット 0枚/);
  }finally{await h.close();}
});

test('the analysis assistant uses the same issued-ticket and admission totals as normal analysis',async()=>{
  const previous={...event('event-b'),eventDate:'2026-11-06',eventStatus:'finished'};
  const used={...ticket('event-b'),updatedAt:'2026-11-06T01:00:00.000Z'};
  const tickets=[{...used,ticketId:'used',currentStatus:'inside',valid:false},{...used,ticketId:'printed',currentStatus:'exited',basicInfo:{reserve:true,reservePrinted:true}},{...used,ticketId:'reserve',basicInfo:{reserve:true}}];
  const h=await harness({loadAppSettings:async()=>({aiLabEnabled:true}),events:[event(),previous],loadEventTickets:async()=>tickets});
  try{
    await openAssistant(h);
    const comparison=h.renderer.root.findByProps({className:'ai-event-comparison'});
    assert.match(nodeText(comparison),/過去イベント：総チケット 2枚・未使用 0枚・入場中 1人・退場済み 1人/);
  }finally{await h.close();}
});

function publisherHarness(seed,{beforeTransaction}={}){
  const documents=new Map(Object.entries(seed).map(([path,data])=>[path,structuredClone(data)]));
  const writes=[];let transactions=0;
  const snapshot=path=>({id:path.split('/').at(-1),ref:path,exists:()=>documents.has(path),data:()=>documents.get(path)});
  const list=path=>({docs:[...documents.keys()].filter(key=>key.startsWith(path+'/')&&key.slice(path.length+1).indexOf('/')<0).map(snapshot)});
  const firestore={doc:(_db,...path)=>path.join('/'),collection:(_db,...path)=>path.join('/'),getDoc:async path=>snapshot(path),getDocFromServer:async path=>snapshot(path),getDocsFromServer:async path=>list(path),getDocsFromCache:async path=>list(path),runTransaction:async(_db,action)=>{
    transactions++;beforeTransaction?.(documents,transactions);
    const pending=[];const result=await action({get:async path=>snapshot(path),update:(path,data)=>pending.push([path,data])});
    for(const [path,data] of pending){documents.set(path,{...documents.get(path),...data});writes.push([path,data]);}return result;
  }};
  const api=load('management-app/src/eventPublisher.ts',{'firebase/firestore':firestore,'./operationSafety':safety,'./firebaseClient':{getFirebaseDb:()=>({})}},{navigator:{onLine:true},crypto:webcrypto});
  return {api,documents,writes,transactions:()=>transactions};
}

test('manager bundle restoration uses canonical metadata and repairs only unchanged pre-opening states',async()=>{
  const current={...event('old-trial'),eventDate:'2026-11-06',eventStatus:'active',authToken:'token'};
  const pre='2026-11-05T23:59:59.000Z',real='2026-11-06T00:00:00.000Z';
  const make=(id,at,extra={})=>({...ticket('old-trial'),ticketId:id,currentStatus:'inside',updatedAt:at,...extra});
  const prefix='events/old-trial/tickets/';
  const seed={
    'events/old-trial':current,
    'eventBundles/token':{authToken:'token',event:{...current,startTime:'08:00',eventStatus:'ready'},settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},ticketCount:5},
    [prefix+'legacy']:make('legacy',pre),
    [prefix+'linked']:make('linked',pre,{lastReceptionRecordId:'trial-record'}),
    [prefix+'official']:make('official',real,{lastReceptionRecordId:'official-record'}),
    [prefix+'edited']:make('edited',real,{lastReceptionRecordId:'trial-record'}),
    [prefix+'race']:make('race',pre),
    'events/old-trial/receptionRecords/trial-record':{recordId:'trial-record',eventId:'old-trial',ticketId:'linked',type:'entry',timestamp:pre},
    'events/old-trial/receptionRecords/official-record':{recordId:'official-record',eventId:'old-trial',ticketId:'official',type:'entry',timestamp:real},
  };
  const h=publisherHarness(seed,{beforeTransaction:docs=>docs.set(prefix+'race',make('race',real,{lastReceptionRecordId:'new-official-record'}))});
  const result=await h.api.loadPublishedEventBundle('old-trial');
  assert.equal(result.event.eventStatus,'active');assert.equal(result.event.startTime,'09:00');
  for(const id of ['legacy','linked'])assert.equal(h.documents.get(prefix+id).currentStatus,'unused',id);
  for(const id of ['official','edited','race'])assert.equal(h.documents.get(prefix+id).currentStatus,'inside',id);
  assert.equal(result.tickets.find(item=>item.ticketId==='legacy').currentStatus,'unused');
  assert.equal(h.writes.length,2);assert.equal(h.documents.get('events/old-trial/receptionRecords/trial-record').timestamp,pre);
});

test('legacy trial repair trusts the canonical schedule and keeps finished events and missing linked records intact',async()=>{
  const prefix='events/event-a/tickets/';
  const consumed={...ticket(),currentStatus:'inside',updatedAt:'2026-11-05T23:59:59.000Z',lastReceptionRecordId:'missing'};
  const target={...event(),eventDate:'2026-11-06'};
  const h=publisherHarness({'events/event-a':target,[prefix+consumed.ticketId]:consumed});
  assert.equal(await h.api.repairPreopeningTicketStates('event-a'),0);
  h.documents.set('events/event-a',{...target,eventStatus:'finished'});
  h.documents.set(prefix+consumed.ticketId,{...consumed,lastReceptionRecordId:undefined});
  assert.equal(await h.api.repairPreopeningTicketStates('event-a'),0);
  h.documents.set('events/event-a',{...target,startTime:'08:00'});
  h.documents.set(prefix+consumed.ticketId,{...consumed,lastReceptionRecordId:undefined,updatedAt:'2026-11-05T23:30:00.000Z'});
  assert.equal(await h.api.repairPreopeningTicketStates('event-a'),0,'a stale 09:00 schedule must not reset a real 08:30 admission');
  assert.equal(h.writes.length,0);
});
const safety=load('management-app/src/operationSafety.ts');
const event=(id='event-a')=>({eventId:id,eventName:id,eventDate:'2099-10-27',startTime:'09:00',endTime:'17:00',eventStatus:'preparing',dataVersion:1});
const ticket=(eventId='event-a')=>({eventId,ticketId:'TKT000001',basicInfo:{ticketNumber:1},currentStatus:'unused',valid:true,updatedAt:'2026-10-27T00:00:00.000Z'});
const manager={terminalId:'T-TEST-MANAGER',name:'Manager',type:'Web / iPad',role:'management',approved:true,managementApproved:true,receptionApproved:false,status:'online',lastSeen:null,networkMbps:null,battery:null,admin:true};
async function harness(overrides={}, {quota=false,fileText,geometry,motion=false,ledger={confirmed:[],unsynced:0},practice=false}={}) {
  const storage=new Map([['qr-ticket-terminal-id',manager.terminalId],['qr-ticket-device-id',manager.terminalId]]);
  let eventsCallback;const ticketCallbacks=new Map(),recordCallbacks=new Map(),savedSettings=[],deleted=[],downloads=[];
  const intervals=new Map();let next=0;
  const api={
    subscribeEvents:cb=>{eventsCallback=cb;cb(overrides.events??[event(),event('event-b')]);return()=>{};},
    subscribeTickets:(id,cb)=>{ticketCallbacks.set(id,cb);cb([ticket(id)]);return()=>{};},
    subscribeReceptionRecords:(id,cb)=>{recordCallbacks.set(id,cb);cb([]);return()=>{};},
    subscribeTerminals:cb=>{cb([manager]);return()=>{};},loadTerminals:async()=>[manager],loadPendingReceptionEventApprovals:async()=>[],approveReceptionEvent:async()=>{},
    loadAppSettings:async()=>({volume:25,deviceName:'Saved manager'}),saveAppSettings:async(_id,value)=>savedSettings.push({...value}),
    loadReceptionSettings:async()=>({entryEnabled:true,exitEnabled:true,reentryEnabled:true}),
    loadMembers:async()=>[],loadAnalysis:async()=>[],loadReceptionErrors:async()=>[],
    loadEventTickets:async id=>[ticket(id)],loadNextTicketNumber:async()=>2,loadEventReceptionRecords:async()=>[],
    deleteEvent:async id=>deleted.push(id),saveManagementTerminalHeartbeat:async()=>null,
    saveAnalysis:async()=>{},saveTicket:async()=>{},appendTickets:async()=>{},
    ...overrides,
  };
  const publisher={loadPublishedEventBundle:async()=>null,saveEventMetadata:async()=>{},saveEventStatus:async()=>{},publishEventBundle:async updated=>({event:updated,tickets:[],authToken:'token',settings:{},ticketCount:0}),...(overrides.publisher??{})};
  const window={addEventListener(){},removeEventListener(){},matchMedia:()=>({matches:motion}),setInterval:(fn,ms)=>{intervals.set(++next,{fn,ms});return next;},clearInterval:id=>intervals.delete(id),setTimeout:()=>++next,clearTimeout:()=>{},confirm:()=>true,prompt:()=>null};
  const exported=load('management-app/src/App.tsx',{'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'qrcode.react':{QRCodeSVG:()=>null},'./SurfaceMotion':load('management-app/src/SurfaceMotion.tsx',{'react':React,'react/jsx-runtime':require('react/jsx-runtime')},{window}), './VenueOccupancyChart':load('management-app/src/VenueOccupancyChart.tsx',{'react':React,'react/jsx-runtime':require('react/jsx-runtime')}),'./OfflineEventTransfer':{default:()=>null},'./TicketDesigner':{default:()=>null,TicketQrPreview:()=>null},'./guidePractice':load('management-app/src/guidePractice.ts'),'./ManagementGuide':{default:()=>null,managementGuideTopics:[],useManagementGuide:()=>({open:false,start(){}})},'./reservePrintLedger':{useReservePrintLedger:()=>ledger},'./operationSafety':safety,'./backup':load('management-app/src/backup.ts'),'./eventUtils':load('management-app/src/eventUtils.ts',{}, {crypto:webcrypto}),'./firebaseData':api,'./eventPublisher':publisher},{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(quota&&k!=='qr-ticket-terminal-id'&&k!=='qr-ticket-device-id')throw Error('QuotaExceeded');storage.set(k,v);},removeItem:k=>storage.delete(k)},window,document:{body:{appendChild(){}},querySelector:selector=>selector===".management-main"?(geometry?.main??null):null,querySelectorAll:()=>geometry?.items??[],createElement:()=>{const input={files:[{}],click(){input.onchange?.();},remove(){}};return input;}},FileReader:class{readAsText(){this.result=fileText;void this.onload();}},navigator:{},URL:{createObjectURL:blob=>{downloads.push(blob);return "blob:test";},revokeObjectURL(){}},crypto:webcrypto,console:{warn(){},error(){}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(exported.default,{practice}));});
  const flush=async()=>{await act(async()=>{for(let i=0;i<8;i++)await tick();});};await flush();
  const label=n=>n.children.map(c=>typeof c==='string'?c:label(c)).join('');
  const click=async text=>{const node=renderer.root.findAllByType('button').find(n=>label(n)===text);assert.ok(node,'Missing '+text);await act(async()=>{await node.props.onClick({currentTarget:null});});await flush();};
  const nav=async name=>{const node=renderer.root.findAll(n=>n.props['data-nav-label']===name)[0];assert.ok(node,'Nav '+name);await act(async()=>node.props.onClick({currentTarget:null}));await flush();};
  return {renderer,storage,api,publisher,deleted,savedSettings,click,nav,flush,ticketCallbacks,recordCallbacks,intervals,downloads,
    text:()=>JSON.stringify(renderer.toJSON()),
    events:async list=>{await act(async()=>eventsCallback(list));await flush();},
    close:async()=>{await act(async()=>renderer.unmount());}};
}
