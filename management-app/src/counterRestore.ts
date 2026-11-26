import type {CounterMode,CounterOperation,CounterPassageFields} from "../../reception-app/public/people-counter/ledger.mjs";

const opId=/^(ledger|edit):[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const uuid=/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const path=/^[A-Za-z0-9_-]{1,160}$/;
const baseFields=["id","kind","eventId","mode","device","rawAt","createdAt","station","actorUid","synced"];
const passageFields=["at","direction","person","invalid","clockWarning","clockUncertainty"];
const isRecord=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const keys=(row:Record<string,unknown>,allowed:string[])=>Object.keys(row).every(key=>allowed.includes(key));
const millis=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=8.64e15;
const direction=(value:unknown)=>value==="in"||value==="out";
const id=(value:unknown):value is string=>typeof value==="string"&&opId.test(value);
const optionalInt=(value:unknown,min:number)=>value===undefined||(typeof value==="number"&&Number.isSafeInteger(value)&&value>=min);
const optionalText=(value:unknown,length:number)=>value===undefined||(typeof value==="string"&&[...value].length<=length);

function validFields(row:Record<string,unknown>) {
  return millis(row.at)&&direction(row.direction)&&(row.person==="visitor"||row.person==="staff")&&
    typeof row.invalid==="boolean"&&optionalText(row.clockWarning,80)&&
    (row.clockUncertainty==null||millis(row.clockUncertainty));
}

export type CounterBackup={
  schema:"counter-day-backup";version:1;scope:string;mode:CounterMode;name:string;venue?:string;
  savedAt:number;window:{from:number;to:number};operations:CounterOperation[];
};

export function restoreIsStopped(config:{paused:boolean;closed:number|null},now=Date.now()) {
  return config.paused||(config.closed!==null&&config.closed<=now);
}

export function readCounterBackup(text:string,scope:string,mode:CounterMode):CounterBackup {
  let value:unknown;
  try {value=JSON.parse(text);} catch {throw new Error("有効なJSONファイルを選んでください。");}
  if (!isRecord(value)||value.schema!=="counter-day-backup"||value.version!==1||
      !keys(value,["schema","version","scope","mode","name","venue","savedAt","window","operations"])) {
    throw new Error("対応していないバックアップ形式です。");
  }
  if (value.scope!==scope||value.mode!==mode) throw new Error("開催日または本番・試験の区分が一致しません。ファイルと同じ開催日・区分を開いてください。");
  const window=value.window;
  if (!Array.isArray(value.operations)||value.operations.length>5000||typeof value.name!=="string"||
      !optionalText(value.name,160)||!optionalText(value.venue,160)||!millis(value.savedAt)||
      !isRecord(window)||!keys(window,["from","to"])||!millis(window.from)||!millis(window.to)||window.from>window.to) {
    throw new Error("バックアップの項目または件数が不正です。1ファイルは5,000件までです。");
  }
  const seen=new Set<string>();
  const operations=value.operations.map((row,index):CounterOperation=>{
    const bad=()=>new Error(`バックアップの${index+1}件目の記録が不正です。`);
    if (!isRecord(row)||!id(row.id)||row.eventId!==scope||row.mode!==mode||typeof row.device!=="string"||!path.test(row.device)||
        !millis(row.rawAt)||(row.createdAt!==undefined&&!millis(row.createdAt))||!direction(row.station)||
        (row.actorUid!==undefined&&(typeof row.actorUid!=="string"||!path.test(row.actorUid)))||
        (row.synced!==undefined&&typeof row.synced!=="boolean")) throw bad();
    if (seen.has(row.id)) throw new Error("同じ記録IDがファイルに複数あります。");
    seen.add(row.id);
    if (row.kind==="passage") {
      if (!row.id.startsWith("ledger:")||!validFields(row)||row.invalid!==false||
          !keys(row,[...baseFields,...passageFields,"source","sequence","configVersion","passageId","reason"])||
          (row.source!=="manual"&&(row.source!=="auto"||row.person!=="visitor"||row.station!==row.direction))||
          !optionalInt(row.sequence,1)||!optionalInt(row.configVersion,0)||!optionalText(row.reason,180)||
          (row.passageId!==undefined&&(typeof row.passageId!=="string"||!uuid.test(row.passageId)))) throw bad();
      return row as unknown as CounterOperation;
    }
    if (row.kind!=="revision"||!row.id.startsWith("edit:")||!id(row.target)||!row.target.startsWith("ledger:")||
        !id(row.parent)||row.parent===row.id||!optionalText(row.reason,180)||typeof row.reason!=="string"||!row.reason.trim()||
        !keys(row,[...baseFields,"before","after","target","parent","reason","resolves","at","source"])||
        (row.at!==undefined&&!millis(row.at))||(row.source!==undefined&&row.source!=="manual")||
        (row.resolves!==undefined&&(!Array.isArray(row.resolves)||row.resolves.length>100||!row.resolves.every(id)))||
        !isRecord(row.before)||!keys(row.before,passageFields)||!validFields(row.before)||
        !isRecord(row.after)||!keys(row.after,passageFields)||!validFields(row.after)) throw bad();
    return row as unknown as CounterOperation;
  });
  return {schema:"counter-day-backup",version:1,scope,mode,name:value.name,venue:value.venue as string|undefined,
    savedAt:value.savedAt,window:{from:window.from,to:window.to},operations};
}

function revisionFields(fields:CounterPassageFields) {
  return {...fields,clockWarning:fields.clockWarning??"",clockUncertainty:fields.clockUncertainty??null};
}

export function restorePayload(row:CounterOperation) {
  const {synced:_synced,...fields}=row;
  return row.kind==="revision"?{...fields,before:revisionFields(row.before),after:revisionFields(row.after),resolves:row.resolves??[]}:fields;
}

export function operationSignature(row:CounterOperation):string {
  const stringify=(value:unknown):unknown=>Array.isArray(value)?value.map(stringify):isRecord(value)
    ?Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,stringify(value[key])])):value;
  const payload={...restorePayload(row)} as Record<string,unknown>;
  if (row.kind==="revision") {delete payload.at;delete payload.source;}
  else {payload.clockWarning??="";payload.clockUncertainty??=null;}
  return JSON.stringify(stringify(payload));
}

export function restorePlan(backup:CounterBackup,current:CounterOperation[]) {
  const existing=new Map(current.map(row=>[row.id,row]));
  const missing=new Map<string,CounterOperation>();
  let duplicates=0;
  for (const row of backup.operations) {
    const saved=existing.get(row.id);
    if (!saved) missing.set(row.id,row);
    else if (operationSignature(saved)===operationSignature(row)) duplicates++;
    else throw new Error(`同じIDに違う記録があります。上書きは行いません。（${row.id}）`);
  }

  const ordered:CounterOperation[]=[];
  const dependencies=new Map<string,number>();
  const dependents=new Map<string,CounterOperation[]>();
  for (const row of missing.values()) {
    if (row.kind==="passage") {ordered.push(row);continue;}
    const root=missing.get(row.target)??existing.get(row.target);
    const parent=missing.get(row.parent)??existing.get(row.parent);
    if (root?.kind!=="passage"||!parent||(parent.kind==="passage"?parent.id!==root.id:parent.target!==root.id)) {
      throw new Error(`修正履歴の元記録または直前版がありません。（${row.id}）`);
    }
    const refs=[...new Set([root.id,parent.id])].filter(key=>missing.has(key));
    if (!refs.length) ordered.push(row);
    else {
      dependencies.set(row.id,refs.length);
      for (const ref of refs) {
        const children=dependents.get(ref)??[];
        children.push(row);
        dependents.set(ref,children);
      }
    }
  }
  for (let next=0;next<ordered.length;next++) {
    for (const row of dependents.get(ordered[next].id)??[]) {
      const remaining=(dependencies.get(row.id)??0)-1;
      dependencies.set(row.id,remaining);
      if (!remaining) ordered.push(row);
    }
  }
  if (ordered.length!==missing.size) throw new Error("修正履歴の参照が循環しています。");
  return {add:ordered,duplicates};
}
