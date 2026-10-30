import type * as Data from './firebaseData';
import type * as Publisher from './eventPublisher';
import type {Event,Ticket,ReceptionSettings,ReceptionRecord} from '@qr-ticket-system/shared';

/** A separate in-memory backend. No live adapter is called or inherited. */
export function createGuidePractice(){
  const terminalId='T-GUIDE-MANAGER';
  const storageMap=new Map<string,string>([['qr-ticket-terminal-id',terminalId],['qr-ticket-device-id',terminalId]]);
  const storage={getItem:(key:string)=>storageMap.get(key)??null,setItem:(key:string,value:string)=>{storageMap.set(key,value);},removeItem:(key:string)=>{storageMap.delete(key);}};
  const event:Event={eventId:'GUIDE-EVENT',eventName:'練習用・文化祭',eventDate:'2099-11-01',startTime:'09:00',endTime:'17:00',eventStatus:'preparing',dataVersion:1};
  let events:Event[]=[event];
  const inventories=new Map<string,Ticket[]>([[event.eventId,Array.from({length:8},(_,i)=>({eventId:event.eventId,ticketId:'GUIDE'+String(i+1).padStart(6,'0'),basicInfo:{ticketNumber:i+1},valid:true,currentStatus:i===0?'inside':i===1?'exited':'unused',updatedAt:new Date().toISOString()}))]]);
  const now=()=>new Date().toISOString();
  let terminals:any[]=[{terminalId,name:'練習用・管理iPad',type:'Web / iPad',role:'management',mode:'停止',approved:true,managementApproved:true,admin:true,status:'online',lastSeen:now(),networkMbps:20,battery:85},
    {terminalId:'T-GUIDE-RECEPTION',name:'練習用・入口iPad',type:'Web / iPad',role:'reception',mode:'入口受付',approved:false,receptionApproved:false,status:'pending',lastSeen:now(),networkMbps:15,battery:80}];
  const settings:ReceptionSettings={entryEnabled:true,exitEnabled:true,reentryEnabled:true};
  let appSettings={volume:70,successSound:true,voiceGuidance:false,controlAssist:false,deviceName:'練習用・管理iPad',aiLabEnabled:false};
  const recordMap=new Map<string,ReceptionRecord[]>([[event.eventId,[{eventId:event.eventId,recordId:'GUIDE-ENTRY',ticketId:'GUIDE000001',type:'entry',terminalId:'T-GUIDE-RECEPTION',timestamp:new Date(Date.now()-600000).toISOString()},{eventId:event.eventId,recordId:'GUIDE-EXIT',ticketId:'GUIDE000002',type:'exit',terminalId:'T-GUIDE-RECEPTION',timestamp:now()}]]]);
  const eventListeners=new Set<Function>(),terminalListeners=new Set<Function>(),ticketListeners=new Map<string,Set<Function>>(),recordListeners=new Map<string,Set<Function>>();
  const copy=<T,>(v:T):T=>JSON.parse(JSON.stringify(v));
  const emitEvents=()=>eventListeners.forEach(cb=>cb(copy(events)));
  const emitTerminals=()=>terminalListeners.forEach(cb=>cb(copy(terminals)));
  const emitTickets=(id:string)=>ticketListeners.get(id)?.forEach(cb=>cb(copy(inventories.get(id)??[])));
  const watch=(listeners:Set<Function>,cb:Function,value:unknown)=>{listeners.add(cb);cb(copy(value));return()=>{listeners.delete(cb);};};
  const getTickets=(id:string)=>copy(inventories.get(id)??[]);
  const saveEvent=async(e:Event)=>{events=[...events.filter(v=>v.eventId!==e.eventId),copy(e)];if(!inventories.has(e.eventId))inventories.set(e.eventId,[]);emitEvents();};
  const bundles=new Map<string,any>();
  const api={
    subscribeEvents:(cb:Function)=>watch(eventListeners,cb,events),
    subscribeTerminals:(cb:Function)=>watch(terminalListeners,cb,terminals),
    subscribeTickets:(id:string,cb:Function)=>{if(!ticketListeners.has(id))ticketListeners.set(id,new Set());return watch(ticketListeners.get(id)!,cb,getTickets(id));},
    subscribeReceptionRecords:(id:string,cb:Function)=>{if(!recordListeners.has(id))recordListeners.set(id,new Set());return watch(recordListeners.get(id)!,cb,recordMap.get(id)??[]);},
    loadEventTickets:async(id:string)=>getTickets(id),loadEventReceptionRecords:async(id:string)=>copy(recordMap.get(id)??[]),
    loadTerminals:async()=>copy(terminals),getOwnTerminalStatus:async()=>copy(terminals[0]),
    loadAppSettings:async()=>copy(appSettings),saveAppSettings:async(_id:string,v:any)=>{appSettings=copy(v);},
    loadReceptionSettings:async()=>copy(settings),saveReceptionSettings:async(_id:string,v:ReceptionSettings)=>Object.assign(settings,copy(v)),
    loadMembers:async()=>[],loadAnalysis:async()=>[],loadReceptionErrors:async()=>[],saveAnalysis:async()=>{},
    saveManagementTerminalHeartbeat:async()=>{},
    loadNextTicketNumber:async(id:string)=>Math.max(0,...getTickets(id).map(t=>Number(t.basicInfo.ticketNumber)))+1,
    appendTickets:async(id:string,items:Ticket[])=>{inventories.set(id,[...getTickets(id),...copy(items)]);emitTickets(id);},
    saveTicket:async(id:string,ticket:Ticket)=>{inventories.set(id,getTickets(id).map(t=>t.ticketId===ticket.ticketId?copy(ticket):t));emitTickets(id);},
    deleteTicket:async(id:string,ticketId:string)=>{inventories.set(id,getTickets(id).filter(t=>t.ticketId!==ticketId));emitTickets(id);},
    deleteEvent:async(id:string)=>{events=events.filter(e=>e.eventId!==id);inventories.delete(id);emitEvents();},
    saveTerminal:async(t:any)=>{terminals=terminals.map(v=>v.terminalId===t.terminalId?copy(t):v);emitTerminals();},
    approveTerminal:async(id:string)=>{terminals=terminals.map(t=>t.terminalId===id?{...t,approved:true,receptionApproved:true,status:'online',lastSeen:now()}:t);emitTerminals();},
    setManagedTerminalMode:async(id:string,mode:string)=>{terminals=terminals.map(t=>t.terminalId===id?{...t,mode,desiredMode:mode,lastSeen:now()}:t);emitTerminals();},
    setManagedSubAdmin:async(id:string,subAdmin:boolean)=>{terminals=terminals.map(t=>t.terminalId===id?{...t,subAdmin}:t);emitTerminals();},
    deleteTerminal:async(id:string)=>{terminals=terminals.filter(t=>t.terminalId!==id);emitTerminals();},
    revokeManagedReception:async()=>{},releaseOwnReception:async()=>{},requestTerminalRegistration:async()=>{},saveMember:async()=>{},deleteMember:async()=>{},
  } as unknown as typeof Data;
  const publisher={saveEventMetadata:saveEvent,saveEventStatus:async(id:string,status:Event["eventStatus"])=>{const e=events.find(e=>e.eventId===id);if(e)await saveEvent({...e,eventStatus:status});},loadPublishedEventBundle:async(id:string)=>copy(bundles.get(id)??null),publishEventBundle:async(e:Event,s:ReceptionSettings)=>{
    const result={event:{...e,receptionTarget:true},settings:copy(s),tickets:getTickets(e.eventId),ticketCount:getTickets(e.eventId).length,authToken:'GUIDE-INVALID-TOKEN',publishedAt:now()};bundles.set(e.eventId,result);await saveEvent(result.event);return copy(result);
  }} as unknown as typeof Publisher;
  return {storage,api,publisher,terminalId};
}

export function createGuideReserveStore(){
  type Packet=import('./reservePrintStore').ReservePackage;
  let packet:Packet|null=null;
  const copy=(p:Packet)=>JSON.parse(JSON.stringify(p)) as Packet;
  return {
    loadReservePackage:async(_eventId:string)=>packet?copy(packet):null,
    saveReservePackage:async(p:Packet)=>{if(packet?.pending)throw Error('先に印刷を確認してください。');packet={...copy(p),confirmed:packet?.confirmed??[],pending:null};return copy(packet);},
    claimReserveBatch:async(_id:string,count:number)=>{if(!packet||packet.pending||!Number.isInteger(count)||count<1)throw Error('印刷枚数を確認してください。');const ids=packet.tickets.filter(t=>!packet!.confirmed.includes(t.id)).slice(0,count).map(t=>t.id);if(ids.length!==count)throw Error('予備の残数を確認してください。');packet={...packet,pending:{id:'GUIDE-BATCH',ids}};return copy(packet);},
    finishReserveBatch:async(_id:string,batchId:string,printed:boolean)=>{if(!packet?.pending||packet.pending.id!==batchId)throw Error('印刷状態を確認してください。');packet={...packet,confirmed:printed?[...new Set([...packet.confirmed,...packet.pending.ids])]:packet.confirmed,pending:null};return copy(packet);},
  };
}
