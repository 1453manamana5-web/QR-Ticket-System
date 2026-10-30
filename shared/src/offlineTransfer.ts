import type {Event,ReceptionSettings,Ticket} from './index';

export type OfflineEventData={event:Event;settings:ReceptionSettings;tickets:Ticket[]};
type Part={type:'qr-ticket-offline-v1';id:string;index:number;total:number;data:string};
const maxBytes=2_000_000,maxParts=200;
const validId=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=160&&!v.includes('/');
export function validateOfflineEvent(value:unknown):OfflineEventData{
  const v=value as OfflineEventData;
  if(!v||!v.event||!validId(v.event.eventId)||typeof v.event.eventName!=='string'||v.event.eventName.length>300||
    typeof v.event.eventDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(v.event.eventDate)||!Number.isFinite(Date.parse(v.event.eventDate))||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(v.event.startTime)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(v.event.endTime)||v.event.startTime>=v.event.endTime||
    !Number.isSafeInteger(v.event.dataVersion)||v.event.dataVersion<1||!['ready','active'].includes(v.event.eventStatus)||
    !v.settings||![v.settings.entryEnabled,v.settings.exitEnabled,v.settings.reentryEnabled].every(x=>typeof x==='boolean')||
    !Array.isArray(v.tickets)||v.tickets.length>5000)throw Error('オフラインイベントデータの形式が正しくありません。');
  const ids=new Set<string>();
  for(const t of v.tickets){
    if(!t||!validId(t.ticketId)||t.eventId!==v.event.eventId||ids.has(t.ticketId)||typeof t.valid!=='boolean'||
      !['unused','inside','exited'].includes(t.currentStatus)||!t.basicInfo||typeof t.basicInfo!=='object'||Array.isArray(t.basicInfo)||
      typeof t.updatedAt!=='string'||!Number.isFinite(Date.parse(t.updatedAt)))throw Error('チケット情報が不正または重複しています。');
    ids.add(t.ticketId);
  }
  const e=v.event,s=v.settings;
  return {event:{eventId:e.eventId,eventName:e.eventName,eventDate:e.eventDate,startTime:e.startTime,endTime:e.endTime,eventStatus:e.eventStatus,dataVersion:e.dataVersion},
    settings:{entryEnabled:s.entryEnabled,exitEnabled:s.exitEnabled,reentryEnabled:s.reentryEnabled},
    tickets:v.tickets.map(t=>({ticketId:t.ticketId,eventId:t.eventId,basicInfo:t.basicInfo,currentStatus:t.currentStatus,valid:t.valid,updatedAt:t.updatedAt}))};
}
async function readBounded(stream:ReadableStream<Uint8Array>):Promise<Uint8Array>{
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{for(;;){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>maxBytes)throw Error('データが大きすぎます。');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const out=new Uint8Array(size);let offset=0;for(const c of chunks){out.set(c,offset);offset+=c.length;}return out;
}
async function hash(bytes:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes as BufferSource))].map(b=>b.toString(16).padStart(2,'0')).join('');}
export async function encodeOfflineEvent(value:OfflineEventData):Promise<string[]>{
  const clean=validateOfflineEvent(value);
  if(typeof CompressionStream==='undefined')throw Error('この端末はオフラインQRの作成に未対応です。OSを更新してください。');
  const raw=new TextEncoder().encode(JSON.stringify(clean));if(raw.length>maxBytes)throw Error('データが大きすぎます。');
  const compressed=await readBounded(new Blob([raw]).stream().pipeThrough(new CompressionStream('gzip')));
  const id=await hash(compressed);let binary='';for(const b of compressed)binary+=String.fromCharCode(b);
  const encoded=btoa(binary),total=Math.ceil(encoded.length/1000);
  if(total>maxParts)throw Error('データが大きすぎます。');
  return Array.from({length:total},(_,index)=>JSON.stringify({type:'qr-ticket-offline-v1',id,index,total,data:encoded.slice(index*1000,(index+1)*1000)} satisfies Part));
}
export class OfflineEventCollector{
  private parts=new Map<number,string>();private id='';private total=0;
  get progress(){return {received:this.parts.size,total:this.total};}
  reset(){this.parts.clear();this.id='';this.total=0;}
  async add(text:string):Promise<OfflineEventData|null>{
    if(text.length>1400)throw Error('QRデータが大きすぎます。');
    const p=JSON.parse(text) as Part;
    if(!p||p.type!=='qr-ticket-offline-v1'||typeof p.id!=='string'||!/^[a-f0-9]{64}$/.test(p.id)||!Number.isInteger(p.total)||p.total<1||p.total>maxParts||
      !Number.isInteger(p.index)||p.index<0||p.index>=p.total||typeof p.data!=='string'||p.data.length<1||p.data.length>1000||!/^[A-Za-z0-9+/=]+$/.test(p.data))throw Error('オフラインQRの形式が正しくありません。');
    if(this.id&&(this.id!==p.id||this.total!==p.total))throw Error('別のデータのQRです。最初から読み直す場合は一度戻ってください。');
    this.id=p.id;this.total=p.total;
    const previous=this.parts.get(p.index);if(previous!==undefined&&previous!==p.data)throw Error('同じ番号のQRが一致しません。');
    this.parts.set(p.index,p.data);if(this.parts.size!==this.total)return null;
    const encoded=Array.from({length:this.total},(_,i)=>this.parts.get(i)!).join('');
    const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
    if(await hash(bytes)!==this.id){this.reset();throw Error('読み取ったデータが一致しません。最初から読み直してください。');}
    if(typeof DecompressionStream==='undefined')throw Error('この端末はオフラインQRに未対応です。OSを更新してください。');
    const raw=await readBounded(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')));
    return validateOfflineEvent(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(raw)));
  }
}
