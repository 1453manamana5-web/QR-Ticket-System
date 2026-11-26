import {useEffect,useState} from "react";
import {collection,doc,getDocsFromServer,limit,onSnapshot,orderBy,query,runTransaction,serverTimestamp,Timestamp} from "firebase/firestore";
import {getFirebaseDb,getFirebaseUid} from "../../reception-app/src/firebaseClient";
import {stationActions,stationResults} from "../../reception-app/public/people-counter/station-command.mjs";
import {findCounterPair,saveCounterStation,type CounterStation} from "./counterManagementData";

type Action=keyof typeof stationActions;
type Command={
  id:string;action:Action;state:"issued"|"running"|"finished";
  issuedAt:Timestamp;startedAt?:Timestamp;finishedAt?:Timestamp;downtimeMs?:number;result?:keyof typeof stationResults;
};
const scope=(day:string,uid:string)=>doc(getFirebaseDb(),"events",day,"counterCommands",uid);
function readCommand(value:Record<string,unknown>|undefined):Command|null {
  return value && value.issuedAt instanceof Timestamp && typeof value.id==="string" && typeof value.action==="string" &&
    Object.prototype.hasOwnProperty.call(stationActions,value.action) ? value as Command : null;
}
function describe(command:Command,now:number) {
  if (command.state==="finished") {
    const elapsed=command.downtimeMs;
    return stationResults[command.result??"failed"]+(elapsed===undefined?"":"（計測停止 約"+Math.max(1,Math.round(elapsed/1000))+"秒）");
  }
  if (command.state==="running") return now-(command.startedAt?.toMillis()??now)>=240000?"実行結果未確認":"端末受信・実行中";
  return now-command.issuedAt.toMillis()>=120000?"期限切れ":"端末の受信待ち";
}
async function issue(day:string,stationUid:string,action:Action) {
  const db=getFirebaseDb(),uid=await getFirebaseUid(),ref=scope(day,stationUid),id=crypto.randomUUID();
  await runTransaction(db,async tx=>{
    const [state,previous]=await Promise.all([
      tx.get(doc(db,"events",day,"counterDevices",stationUid)),tx.get(ref)]);
    const station=state.data(),previousData=previous.data(),old=readCommand(previousData);
    if (!station || station.status!=="approved" || !station.mode || !station.updatedAt ||
        !(station.lastSeen instanceof Timestamp) || Date.now()-station.lastSeen.toMillis()>90000)
      throw new Error("端末の通信と割り当てを確認してください。");
    const config=await tx.get(doc(db,"events",day,"counterConfig",station.mode));
    const version=config.get("version");
    if (!Number.isSafeInteger(version) || version!==station.configVersion)
      throw new Error("端末が最新の運用設定を適用した後に送信できます。");
    if (old) {
      const status=describe(old,Date.now());
      if (status==="端末の受信待ち" || status==="端末受信・実行中")
        throw new Error("前回の指示が処理中です。");
      tx.set(doc(ref,"history",old.id),previousData!);
    }
    tx.set(ref,{id,action,device:station.device,role:station.role,mode:station.mode,
      assignment:station.updatedAt,configVersion:version,state:"issued",issuedAt:serverTimestamp(),issuedBy:uid});
  });
}

export function CounterPairPanel({day,enabled}:{day:string;enabled:boolean}) {
  const [code,setCode]=useState("");
  const [preview,setPreview]=useState<{code:string;station:CounterStation}|null>(null);
  const [busy,setBusy]=useState(false);
  const [note,setNote]=useState("");
  async function search() {
    setBusy(true);setPreview(null);setNote("");
    try {setPreview({code,station:await findCounterPair(day,code)});}
    catch(e){setNote(e instanceof Error&&!("code" in e)?e.message:"コードを確認できませんでした。数秒後に再試行してください。");}
    finally{setBusy(false);}
  }
  async function approve(form:HTMLFormElement) {
    if (!preview) return;
    const fields=new FormData(form),role=fields.get("role")==="out"?"out":"in",name=String(fields.get("name")??"");
    setBusy(true);setNote("");
    try {
      await saveCounterStation(day,preview.station.uid,{name,role,status:"approved"},preview.code);
      setPreview(null);setCode("");setNote("端末の接続を承認しました。端末側で入口・出口の設定を確認してください。");
    }catch(e){setNote(e instanceof Error&&!("code" in e)?e.message:"接続を承認できませんでした。コードの期限と端末の割り当てを確認してください。");}
    finally{setBusy(false);}
  }
  return <section className="cm-section">
    <h2>受付端末をペアリング</h2>
    <p className="cm-caption">計測端末にこの開催日IDを設定してください。<code>{day}</code>　端末に表示された6桁のコードを入力します。有効期限は5分です。</p>
    <form className="cm-form" onSubmit={e=>{e.preventDefault();void search();}}>
      <label>接続コード<input value={code} inputMode="numeric" autoComplete="off" required maxLength={6} pattern="[0-9]{6}"
        onChange={e=>{setCode(e.target.value.replace(/[^0-9]/g,""));setPreview(null);}} disabled={!enabled||busy}/></label>
      <button disabled={!enabled||busy}>端末を確認</button>
    </form>
    {preview&&<form className="cm-form" onSubmit={e=>{e.preventDefault();void approve(e.currentTarget);}}>
      <p>確認した端末　<b>{preview.station.name}</b></p>
      <label>端末名<input name="name" required maxLength={60} defaultValue={preview.station.name}/></label>
      <label>役割<select name="role" defaultValue={preview.station.role}><option value="in">入口</option><option value="out">出口</option></select></label>
      <button className="cm-primary" disabled={!enabled||busy}>接続を承認</button>
    </form>}
    {note&&<p role="status">{note}</p>}
  </section>;
}

export function CounterRemotePanel({day,station,enabled,now}:{day:string;station:CounterStation;enabled:boolean;now:number}) {
  const [open,setOpen]=useState(false),[command,setCommand]=useState<Command|null>(null);
  const [action,setAction]=useState<Action>("diagnose"),[busy,setBusy]=useState(false),[note,setNote]=useState("");
  const [history,setHistory]=useState<Command[]|null>(null);
  const canSend=enabled && station.lastSeen!==undefined && now-station.lastSeen<=90000 && Number(station.version)>=15;
  useEffect(()=>{
    if (!open) return;
    return onSnapshot(scope(day,station.uid),{includeMetadataChanges:true},snapshot=>{
      if (!snapshot.metadata.fromCache&&!snapshot.metadata.hasPendingWrites) setCommand(readCommand(snapshot.data()));
    },()=>setNote("端末への指示を確認できません。"));
  },[open,day,station.uid]);
  async function send() {
    if (["stop","camera","engine"].includes(action)&&!window.confirm("計測が止まる可能性があります。入口・出口の状況を確認して指示を送りますか？")) return;
    setBusy(true);setNote("");
    try {await issue(day,station.uid,action);setHistory(null);}
    catch(e){setNote(e instanceof Error&&!("code" in e)?e.message:"指示を送信できませんでした。最新の端末状態を確認してください。");}
    finally{setBusy(false);}
  }
  async function loadHistory() {
    try {
      const rows=await getDocsFromServer(query(collection(scope(day,station.uid),"history"),orderBy("issuedAt","desc"),limit(12)));
      setHistory(rows.docs.flatMap(row=>{const item=readCommand(row.data());return item?[item]:[];}));
    }catch{setNote("操作履歴を読み込めませんでした。");}
  }
  return <details onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>遠隔操作</summary>
    <p className="cm-caption">カメラ・認識エンジンの再起動は、稼働中で通過追跡や設置試験がない場合に実行します。端末で許可が必要な場合は現地で操作してください。</p>
    <form className="cm-form" onSubmit={e=>{e.preventDefault();void send();}}>
      <label>操作<select value={action} onChange={e=>setAction(e.target.value as Action)}>
        {Object.entries(stationActions).map(([id,label])=><option key={id} value={id}>{label}</option>)}
      </select></label>
      <button disabled={!canSend||busy}>端末へ指示</button>
      <button type="button" onClick={()=>void loadHistory()}>操作履歴</button>
    </form>
    {command&&<p role="status">{stationActions[command.action]}　{describe(command,now)}</p>}
    {history&&(history.length?<ul>{history.map(item=><li key={item.id}>{item.issuedAt.toDate().toLocaleString("ja-JP")}　{stationActions[item.action]}　{describe(item,now)}</li>)}</ul>:<p>過去の指示はありません。</p>)}
    {note&&<p role="status">{note}</p>}
    {!canSend&&<p className="cm-caption">送信には更新済みの計測端末との通信が必要です。</p>}
  </details>;
}
