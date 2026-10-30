import type {Event, ReceptionSettings, Ticket} from "@qr-ticket-system/shared";

type Member = {memberId:string;memberNumber:number;name:string};
type Analysis = {eventId:string;eventName:string;eventDate:string;total:number;unused:number;inside:number;exited:number;savedAt:string};
export type ManagementBackup = {
  version:1; eventId:string; eventHistory:Event[]; tickets:Ticket[]; members:Member[];
  receptionSettings?:ReceptionSettings; appSettings?:Record<string,unknown>; analysisHistory:Analysis[];
};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==="object"&&!Array.isArray(value);
const id=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=160&&!value.includes("/");
const date=(value:unknown)=>typeof value==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&
  Number.isFinite(Date.parse(value+"T00:00:00.000Z"))&&new Date(value+"T00:00:00.000Z").toISOString().slice(0,10)===value;
const time=(value:unknown)=>typeof value==="string"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function parseManagementBackup(value:unknown):ManagementBackup {
  if(!object(value)||value.version!==1||!Array.isArray(value.eventHistory)||!Array.isArray(value.tickets)||!Array.isArray(value.members))throw Error("バックアップの形式・バージョンが正しくありません");
  const events:Event[]=value.eventHistory.map(event=>{
    if(!object(event)||!id(event.eventId)||typeof event.eventName!=="string"||!date(event.eventDate)||!time(event.startTime)||!time(event.endTime)||String(event.startTime)>=String(event.endTime)||!["preparing","ready","active","finalizing","finished"].includes(String(event.eventStatus))||!Number.isSafeInteger(event.dataVersion)||Number(event.dataVersion)<1)throw Error("イベント情報が不正です");
    // Do not import auth tokens, publication targets or terminal grants from files.
    return {eventId:event.eventId,eventName:event.eventName,eventDate:String(event.eventDate),startTime:String(event.startTime),endTime:String(event.endTime),eventStatus:event.eventStatus as Event["eventStatus"],dataVersion:Number(event.dataVersion)};
  });
  const eventIds=new Set(events.map(event=>event.eventId));
  if(eventIds.size!==events.length)throw Error("イベントIDが重複しています");
  const ticketIds=new Set<string>();
  const tickets:Ticket[]=value.tickets.map(ticket=>{
    if(!object(ticket)||!id(ticket.ticketId)||!id(ticket.eventId)||!eventIds.has(ticket.eventId)||!object(ticket.basicInfo)||typeof ticket.valid!=="boolean"||!["unused","inside","exited"].includes(String(ticket.currentStatus))||typeof ticket.updatedAt!=="string"||!Number.isFinite(Date.parse(ticket.updatedAt)))throw Error("チケット情報が不正です");
    const key=JSON.stringify([ticket.eventId,ticket.ticketId]);if(ticketIds.has(key))throw Error("チケットIDが重複しています");ticketIds.add(key);
    return {eventId:ticket.eventId,ticketId:ticket.ticketId,basicInfo:ticket.basicInfo,valid:ticket.valid,currentStatus:ticket.currentStatus as Ticket["currentStatus"],updatedAt:ticket.updatedAt};
  });
  if(value.eventId!==undefined && value.eventId!=="" && (!id(value.eventId)||!eventIds.has(value.eventId)))throw Error("復元先イベントが見つかりません");
  const eventId=id(value.eventId)?value.eventId:tickets[0]?.eventId??(events.length===1?events[0].eventId:"");
  if(value.members.length&&(!eventId||!eventIds.has(eventId)))throw Error("部員の復元先イベントが特定できません");
  const memberIds=new Set<string>(),memberNumbers=new Set<number>();
  const members:Member[]=value.members.map(member=>{
    if(!object(member)||!id(member.memberId)||!Number.isSafeInteger(member.memberNumber)||Number(member.memberNumber)<1||typeof member.name!=="string")throw Error("部員情報が不正です");
    if(memberIds.has(member.memberId)||memberNumbers.has(Number(member.memberNumber)))throw Error("部員IDまたは部員番号が重複しています");
    memberIds.add(member.memberId);memberNumbers.add(Number(member.memberNumber));
    return {memberId:member.memberId,memberNumber:Number(member.memberNumber),name:member.name};
  });
  let receptionSettings:ReceptionSettings|undefined;
  if(value.receptionSettings!==undefined){
    const setting=value.receptionSettings;if(!object(setting)||![setting.entryEnabled,setting.exitEnabled,setting.reentryEnabled].every(item=>typeof item==="boolean"))throw Error("受付設定が不正です");
    receptionSettings={entryEnabled:setting.entryEnabled as boolean,exitEnabled:setting.exitEnabled as boolean,reentryEnabled:setting.reentryEnabled as boolean};
  }
  const appSettings:Record<string,unknown>={};
  if(value.appSettings!==undefined){
    if(!object(value.appSettings))throw Error("アプリ設定が不正です");
    for(const [key,item] of Object.entries(value.appSettings)){
      if(key==="volume"){if(typeof item!=="number"||!Number.isFinite(item)||item<0||item>100)throw Error("音量が不正です");appSettings[key]=item;}
      else if(key==="deviceName"){if(typeof item!=="string"||item.length>80)throw Error("端末名が不正です");appSettings[key]=item;}
      else if(["successSound","voiceGuidance","controlAssist","aiLabEnabled"].includes(key)){if(typeof item!=="boolean")throw Error("設定値が不正です");appSettings[key]=item;}
    }
  }
  const analysisHistory:Analysis[]=[];
  if(value.analysisHistory!==undefined){
    if(!Array.isArray(value.analysisHistory))throw Error("分析情報が不正です");
    for(const item of value.analysisHistory){
      if(!object(item)||!id(item.eventId)||!eventIds.has(item.eventId)||typeof item.eventName!=="string"||typeof item.eventDate!=="string"||typeof item.savedAt!=="string"||!Number.isFinite(Date.parse(item.savedAt))||![item.total,item.unused,item.inside,item.exited].every(number=>typeof number==="number"&&Number.isSafeInteger(number)&&number>=0))throw Error("分析情報が不正です");
      analysisHistory.push(item as Analysis);
    }
  }
  return {version:1,eventId,eventHistory:events,tickets,members,receptionSettings,appSettings:value.appSettings===undefined?undefined:appSettings,analysisHistory};
}
