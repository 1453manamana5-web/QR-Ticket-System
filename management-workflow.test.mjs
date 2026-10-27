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
  const out={};new Function('exports','require',...Object.keys(globals),ts.transpileModule(readFileSync(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText)(out,n=>n in deps?deps[n]:require(n),...Object.values(globals));return out;
}
const safety=load('management-app/src/operationSafety.ts');
const event=(id='event-a')=>({eventId:id,eventName:id,eventDate:'2099-10-27',startTime:'09:00',endTime:'17:00',eventStatus:'preparing',dataVersion:1});
const ticket=(eventId='event-a')=>({eventId,ticketId:'TKT000001',basicInfo:{ticketNumber:1},currentStatus:'unused',valid:true,updatedAt:'2026-10-27T00:00:00.000Z'});
const manager={terminalId:'T-TEST-MANAGER',name:'Manager',type:'Web / iPad',role:'management',approved:true,managementApproved:true,receptionApproved:false,status:'online',lastSeen:null,networkMbps:null,battery:null,admin:true};
async function harness(overrides={}, {quota=false,fileText}={}) {
  const storage=new Map([['qr-ticket-terminal-id',manager.terminalId],['qr-ticket-device-id',manager.terminalId]]);
  let eventsCallback;const ticketCallbacks=new Map(),recordCallbacks=new Map(),savedSettings=[],deleted=[];
  const intervals=new Map();let next=0;
  const api={
    subscribeEvents:cb=>{eventsCallback=cb;cb([event(),event('event-b')]);return()=>{};},
    subscribeTickets:(id,cb)=>{ticketCallbacks.set(id,cb);cb([ticket(id)]);return()=>{};},
    subscribeReceptionRecords:(id,cb)=>{recordCallbacks.set(id,cb);cb([]);return()=>{};},
    subscribeTerminals:cb=>{cb([manager]);return()=>{};},loadTerminals:async()=>[manager],
    loadAppSettings:async()=>({volume:25,deviceName:'Saved manager'}),saveAppSettings:async(_id,value)=>savedSettings.push({...value}),
    loadReceptionSettings:async()=>({entryEnabled:true,exitEnabled:true,reentryEnabled:true}),
    loadMembers:async()=>[],loadAnalysis:async()=>[],loadReceptionErrors:async()=>[],
    loadEventTickets:async id=>[ticket(id)],loadEventReceptionRecords:async()=>[],
    deleteEvent:async id=>deleted.push(id),saveManagementTerminalHeartbeat:async()=>null,
    saveAnalysis:async()=>{},saveTicket:async()=>{},appendTickets:async()=>{},
    ...overrides,
  };
  const publisher={loadPublishedEventBundle:async()=>null,saveEventMetadata:async()=>{},saveEventStatus:async()=>{},publishEventBundle:async updated=>({event:updated,tickets:[],authToken:'token',settings:{},ticketCount:0}),...(overrides.publisher??{})};
  const window={setInterval:(fn,ms)=>{intervals.set(++next,{fn,ms});return next;},clearInterval:id=>intervals.delete(id),setTimeout:()=>++next,clearTimeout:()=>{},confirm:()=>true,prompt:()=>null};
  const exported=load('management-app/src/App.tsx',{'react':React,'react/jsx-runtime':require('react/jsx-runtime'),'./firebaseFunctions':{callBackend:async()=>{}},'qrcode.react':{QRCodeSVG:()=>null},'./TicketDesigner':{default:()=>null,TicketQrPreview:()=>null},'./operationSafety':safety,'./backup':load('management-app/src/backup.ts'),'./eventUtils':load('management-app/src/eventUtils.ts',{}, {crypto:webcrypto}),'./firebaseData':api,'./eventPublisher':publisher},{localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(quota&&k!=='qr-ticket-terminal-id'&&k!=='qr-ticket-device-id')throw Error('QuotaExceeded');storage.set(k,v);},removeItem:k=>storage.delete(k)},window,document:{querySelector:()=>null,querySelectorAll:()=>[],createElement:()=>{const input={files:[{}],click(){input.onchange?.();}};return input;}},FileReader:class{readAsText(){this.result=fileText;void this.onload();}},navigator:{},crypto:webcrypto,console:{warn(){},error(){}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(exported.default));});
  const flush=async()=>{await act(async()=>{for(let i=0;i<8;i++)await tick();});};await flush();
  const label=n=>n.children.map(c=>typeof c==='string'?c:label(c)).join('');
  const click=async text=>{const node=renderer.root.findAllByType('button').find(n=>label(n)===text);assert.ok(node,'Missing '+text);await act(async()=>{await node.props.onClick({currentTarget:null});});await flush();};
  const nav=async name=>{const node=renderer.root.findAll(n=>n.props['data-nav-label']===name)[0];assert.ok(node,'Nav '+name);await act(async()=>node.props.onClick({currentTarget:null}));await flush();};
  return {renderer,storage,api,publisher,deleted,savedSettings,click,nav,flush,ticketCallbacks,recordCallbacks,intervals,
    text:()=>JSON.stringify(renderer.toJSON()),
    events:async list=>{await act(async()=>eventsCallback(list));await flush();},
    close:async()=>{await act(async()=>renderer.unmount());}};
}

test('management startup loads server settings before the first write and never deletes a demo event',async()=>{
  let finish;const h=await harness({loadAppSettings:()=>new Promise(resolve=>{finish=resolve;})});
  try{
    assert.equal(h.savedSettings.length,0);assert.deepEqual(h.deleted,[]);
    await act(async()=>finish({volume:17,deviceName:'Recovered'}));await h.flush();
    assert.ok(h.savedSettings.length>0);assert.ok(h.savedSettings.every(value=>value.volume===17));
  }finally{await h.close();}
});

test('management ignores late settings/member/analysis results and subscriptions after switching events',async()=>{
  const pending=new Map();const h=await harness({loadReceptionSettings:id=>new Promise(resolve=>pending.set(id,resolve))});
  try{
    await h.events([event('event-b')]);
    await act(async()=>pending.get('event-b')({entryEnabled:true,exitEnabled:true,reentryEnabled:false}));await h.flush();
    await act(async()=>pending.get('event-a')({entryEnabled:false,exitEnabled:false,reentryEnabled:true}));await h.flush();
    await act(async()=>h.ticketCallbacks.get('event-a')([{...ticket('event-a'),ticketId:'STALE-TICKET'}]));
    await h.nav('チケット管理');
    await act(async()=>h.renderer.root.findByProps({className:'ticket-home-card ticket-list-launch'}).props.onClick());await h.flush();
    assert.doesNotMatch(h.text(),/STALE-TICKET/);
    // The stale event's settings cannot leak into the next publication.
    let sent;h.publisher.publishEventBundle=async (e,settings)=>{sent=settings;return {event:e,tickets:[],authToken:'new',ticketCount:0};};
    await h.nav('イベント管理');
    await act(async()=>h.renderer.root.findByProps({'aria-label':'event-bを選択'}).props.onClick());await h.flush();
    const buttons=h.renderer.root.findAllByType('button');
    const save=buttons.find(n=>n.children.some(c=>typeof c==='string'&&c.includes('保存')));
    assert.ok(save);
    await act(async()=>save.props.onClick());await h.flush();
    assert.ok(sent,'publication must run');
    assert.deepEqual(sent,{entryEnabled:true,exitEnabled:true,reentryEnabled:false});
  }finally{await h.close();}
});

test('management cache quota failure does not crash the approved application',async()=>{
  const h=await harness({}, {quota:true});try{assert.match(h.text(),/ホーム/);}finally{await h.close();}
});

test('finalization requires a recent stopped acknowledgement for the correct event and zero pending',()=>{
  const now=Date.now(),terminal={terminalId:'T-RECEPTION',approved:true,role:'reception',receptionApproved:true,status:'online',lastSeen:new Date(now).toISOString(),syncPendingCount:0,receptionMode:'stopped',receptionEventId:'event-a',receptionReportedAt:new Date(now).toISOString()};
  assert.equal(safety.receptionDataCollected([terminal],'event-a',now),true);
  for(const change of [{status:'offline'},{receptionReportedAt:new Date(now-31000).toISOString()},{syncPendingCount:1},{syncPendingCount:undefined},{receptionMode:'entry'},{receptionMode:undefined},{receptionEventId:'other'}])assert.equal(safety.receptionDataCollected([{...terminal,...change}],'event-a',now),false,JSON.stringify(change));
});

test('all enabled management pages render, and reselecting the same event retains tickets',async()=>{
  const h=await harness();try{
    for(const page of ['ホーム','イベント管理','チケット管理','端末管理','分析','設定'])await h.nav(page);
    await h.nav('イベント管理');
    await act(async()=>h.renderer.root.findByProps({'aria-label':'event-aを選択'}).props.onClick());await h.flush();
    await h.nav('チケット管理');
    await act(async()=>h.renderer.root.findByProps({className:'ticket-home-card ticket-list-launch'}).props.onClick());await h.flush();
    assert.equal(h.renderer.root.findAll(n=>n.props.className==='ticket-screen-row').length,1);
    await h.nav('イベント管理');
    await act(async()=>h.renderer.root.findByProps({'aria-label':'event-aを選択'}).props.onClick());await h.flush();
    await h.nav('チケット管理');
    assert.equal(h.renderer.root.findAll(n=>n.props.className==='ticket-screen-row').length,1);
    const memberNav=h.renderer.root.findAll(n=>n.props['data-nav-label']==='部員管理')[0];assert.equal(memberNav.props.disabled,true);
  }finally{await h.close();}
});

test('failed event publication preserves the saved event instead of showing unsaved metadata as saved',async()=>{
  const h=await harness({publisher:{publishEventBundle:async()=>{throw Error('offline');}}});
  try{
    await h.nav('イベント管理');
    await act(async()=>h.renderer.root.findByProps({'aria-label':'event-aを選択'}).props.onClick());await h.flush();
    const name=h.renderer.root.findAllByType('input').find(node=>node.props.value==='event-a'&&!node.props.readOnly);
    assert.ok(name);await act(async()=>name.props.onChange({target:{value:'unsaved rename'}}));
    await h.click('保存してFirebaseへ公開');
    assert.match(h.text(),/保存・公開できませんでした/);
    const heading=h.renderer.root.findByProps({className:'event-current-heading'}).findByType('h3');
    assert.equal(heading.children.join(''),'event-a');
    assert.equal(h.renderer.root.findAllByType('input').find(node=>node.props.value==='event-a'&&node.props.readOnly)?.props.readOnly,true);
  }finally{await h.close();}
});

test('backup parser rejects corrupt/cross-event data and never imports roles or publication grants',()=>{
  const parse=load('management-app/src/backup.ts').parseManagementBackup;
  const valid={version:1,eventId:'event-a',eventHistory:[{...event(),authToken:'do-not-import',receptionTarget:true}],tickets:[ticket()],members:[],appSettings:{deviceName:'Restored',volume:80,admin:true}};
  const parsed=parse(valid);assert.equal(parsed.eventHistory[0].authToken,undefined);assert.equal(parsed.appSettings.admin,undefined);
  for(const value of [null,[],{...valid,version:2},{...valid,tickets:[{...ticket(),eventId:'missing'}]},{...valid,tickets:[{...ticket(),valid:'true'}]},{...valid,tickets:[ticket(),ticket()]},{...valid,appSettings:{volume:Infinity}},{...valid,receptionSettings:{entryEnabled:'false'}}])assert.throws(()=>parse(value));
});

test('CSV exports quote data and prevent event names being interpreted as spreadsheet formulas',()=>{
  assert.equal(safety.csvCell('Normal,"title"'),'"Normal,""title"""');
  for(const value of ['=1+1','+SUM(1)','-1+2','@SUM(A1)','\t=CMD()'])assert.ok(safety.csvCell(value).startsWith('"\''));
});

test('backup restoration saves missing data to Firebase and preserves newer existing ticket state',async()=>{
  const appended=[],members=[];
  const backup={version:1,eventId:'event-a',eventHistory:[event()],tickets:[ticket(),{...ticket(),ticketId:'TKT000002',basicInfo:{ticketNumber:2}}],members:[{memberId:'member-1',memberNumber:1,name:'Member'}]};
  const h=await harness({loadEventTickets:async()=>[{...ticket(),currentStatus:'inside',valid:false}],appendTickets:async(id,items)=>appended.push({id,items}),saveMember:async(id,member)=>members.push({id,member})},{fileText:JSON.stringify(backup)});
  try{
    await h.nav('設定');
    const buttons=h.renderer.root.findAllByType('button');const restore=buttons.find(node=>node.children.some(child=>typeof child==='string'&&child.includes('復元')));assert.ok(restore);
    await act(async()=>restore.props.onClick());await h.flush();
    assert.equal(appended.length,1);assert.deepEqual(appended[0].items.map(item=>item.ticketId),['TKT000002']);
    assert.equal(members.length,1);assert.match(h.text(),/不足するデータをFirebaseへ復元しました/);
    assert.equal(h.savedSettings.at(-1).deviceName,'Saved manager');
  }finally{await h.close();}
});
