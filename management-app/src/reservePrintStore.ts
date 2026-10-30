export type ReserveTicket={id:string;number:string;svg:string};
export type ReservePackage={eventId:string;eventName:string;preparedAt:string;template:string;css:string;sheetStyle:string;columns:number;tickets:ReserveTicket[];confirmed:string[];synced?:string[];pending:{id:string;ids:string[]}|null};
const databaseName='qr-ticket-reserve-print';
function validate(value:ReservePackage,eventId:string):ReservePackage{
  if(!value||value.eventId!==eventId||typeof value.eventName!=='string'||typeof value.preparedAt!=='string'||typeof value.template!=='string'||typeof value.css!=='string'||typeof value.sheetStyle!=='string'||
    !Number.isInteger(value.columns)||value.columns<1||value.columns>4||!Array.isArray(value.tickets)||!value.tickets.length||value.tickets.length>5000||
    value.tickets.some(t=>!t||typeof t.id!=='string'||!t.id||typeof t.number!=='string'||typeof t.svg!=='string')||new Set(value.tickets.map(t=>t.id)).size!==value.tickets.length||
    !Array.isArray(value.confirmed)||value.confirmed.some(id=>typeof id!=='string')||(value.synced!==undefined&&(!Array.isArray(value.synced)||value.synced.some(id=>typeof id!=='string'))))throw Error('保存済みの予備印刷データが不完全です。オンラインの管理画面で確認してください。');
  if(value.pending){const ids=new Set(value.tickets.map(t=>t.id));if(typeof value.pending.id!=='string'||!Array.isArray(value.pending.ids)||!value.pending.ids.length||new Set(value.pending.ids).size!==value.pending.ids.length||value.pending.ids.some(id=>!ids.has(id)||value.confirmed.includes(id)))throw Error('予備印刷の確認待ち記録が不正です。');}
  return value;
}
function open():Promise<IDBDatabase>{return new Promise((resolve,reject)=>{
  const r=indexedDB.open(databaseName,1);r.onupgradeneeded=()=>r.result.createObjectStore('packages',{keyPath:'eventId'});
  r.onsuccess=()=>{r.result.onversionchange=()=>r.result.close();resolve(r.result);};r.onerror=()=>reject(r.error??Error('予備印刷の保存先を開けませんでした。'));
});}
export async function loadReservePackage(eventId:string):Promise<ReservePackage|null>{
  const db=await open();try{return await new Promise((resolve,reject)=>{const r=db.transaction('packages').objectStore('packages').get(eventId);r.onsuccess=()=>{try{resolve(r.result?validate(r.result,eventId):null);}catch(e){reject(e);}};r.onerror=()=>reject(r.error);});}finally{db.close();}
}
async function change(eventId:string,update:(current:ReservePackage|null)=>ReservePackage):Promise<ReservePackage>{
  const db=await open();try{return await new Promise((resolve,reject)=>{
    const tx=db.transaction('packages','readwrite'),store=tx.objectStore('packages'),r=store.get(eventId);let value:ReservePackage;
    r.onsuccess=()=>{try{value=update(r.result?validate(r.result,eventId):null);store.put(validate(value,eventId));}catch(e){reject(e);tx.abort();}};
    tx.oncomplete=()=>resolve(value);tx.onerror=()=>reject(tx.error??Error('予備印刷を保存できませんでした。'));tx.onabort=()=>reject(tx.error??Error('予備印刷の保存が中断されました。'));
  });}finally{db.close();}
}
export function saveReservePackage(value:ReservePackage){
  const ids=new Set(value.tickets.map(t=>t.id));
  if(!value.eventId||!value.tickets.length||value.tickets.length>5000||ids.size!==value.tickets.length||!Number.isInteger(value.columns)||value.columns<1||value.columns>4)throw Error('予備チケットの指定が不正です。');
  return change(value.eventId,old=>{
    if(old?.pending)throw Error('印刷確認待ちのチケットがあります。先に印刷完了または中止を確認してください。');
    return {...value,confirmed:old?.confirmed??[],synced:old?.synced??[],pending:null};
  });
}
export function claimReserveBatch(eventId:string,count:number){
  if(!Number.isSafeInteger(count)||count<1||count>5000)throw Error('印刷枚数は1〜5000枚の整数で指定してください。');
  return change(eventId,old=>{
    if(!old)throw Error('このイベントの予備印刷が保存されていません。');
    if(old.pending)throw Error('別の画面で準備した印刷が確認待ちです。同じ分の再印刷か、完了確認を行ってください。');
    const done=new Set(old.confirmed),ids=old.tickets.filter(t=>!done.has(t.id)).slice(0,count).map(t=>t.id);
    if(ids.length!==count)throw Error('予備の残数より印刷枚数が多くなっています。');
    return {...old,pending:{id:crypto.randomUUID(),ids}};
  });
}
export function finishReserveBatch(eventId:string,batchId:string,printed:boolean){return change(eventId,old=>{
  if(!old?.pending||old.pending.id!==batchId)throw Error('印刷の状態が別の画面で変更されました。状態を更新してください。');
  return {...old,confirmed:printed?[...new Set([...old.confirmed,...old.pending.ids])]:old.confirmed,pending:null};
});}
export function selectReserveTickets<T extends {id:string;qrNumber:string;valid:boolean;status:string}>(tickets:T[],start:number,end:number):T[]{
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<1||end<start||end-start>=5000)throw Error('予備番号は1以上、5000枚以内の範囲で指定してください。');
  const selected=tickets.filter(t=>Number(t.qrNumber)>=start&&Number(t.qrNumber)<=end).sort((a,b)=>Number(a.qrNumber)-Number(b.qrNumber));
  if(selected.length!==end-start+1||new Set(selected.map(t=>Number(t.qrNumber))).size!==selected.length||selected.some(t=>t.valid!==true||t.status!=='unused'))throw Error('指定範囲に未発行・無効・使用済み・重複番号のチケットがあります。事前に未使用のチケットを発行してください。');
  return selected;
}

export function markReservePrintsSynced(eventId:string,ids:string[]){return change(eventId,old=>{
  if(!old)throw Error('予備印刷の保存データがありません。');
  return {...old,synced:[...new Set([...(old.synced??[]),...ids.filter(id=>old.confirmed.includes(id))])]};
});}
