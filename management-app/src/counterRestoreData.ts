import {collection,doc,getDocsFromServer,runTransaction,serverTimestamp} from "firebase/firestore";
import {getFirebaseDb,getFirebaseUid} from "../../reception-app/src/firebaseClient";
import {decodeConfig,decodeOperation,type CounterMode,type CounterOperation} from "./counterManagementData";
import {operationSignature,restoreIsStopped,restorePayload,restorePlan,type CounterBackup} from "./counterRestore";

export async function restoreCounterOperations(backup:CounterBackup,reviewed:CounterOperation[],
  progress:(recorded:number)=>void) {
  const {scope,mode}=backup;
  const uid=await getFirebaseUid(),db=getFirebaseDb();
  const ops=collection(db,"events",scope,"counterRuns",mode,"operations");
  const settings=doc(db,"events",scope,"counterConfig",mode);
  const remote=await getDocsFromServer(ops);
  const expected=new Map(reviewed.map(row=>[row.id,operationSignature(row)]));
  if (remote.size!==expected.size||remote.docs.some(row=>{
    const decoded=decodeOperation(row.id,scope,mode,row.get("payload"));
    return !decoded||expected.get(row.id)!==operationSignature(decoded);
  })) throw new Error("確認後にサーバーの通過記録が変わりました。画面に表示された最新の内容で差分を確認してください。");
  const {add}=restorePlan(backup,reviewed);
  let restored=0;
  for (let offset=0;offset<add.length;offset+=80) {
    const batch=add.slice(offset,offset+80);
    const inBatch=new Map(batch.map(row=>[row.id,row]));
    const dependencies=new Set(batch.flatMap(row=>row.kind==="revision"?[row.target,row.parent]:[]));
    try {
      const added=await runTransaction(db,async tx=>{
        const config=decodeConfig((await tx.get(settings)).data());
        if (!config||config.verified||!restoreIsStopped(config)) throw new Error("計測が停止中で、集計の確定が解除されているときに復元できます。");
        const ids=[...new Set([...inBatch.keys(),...dependencies])];
        const reads=await Promise.all(ids.map(id=>tx.get(doc(ops,id))));
        const newRows:CounterOperation[]=[];
        for (const snap of reads) {
          const row=inBatch.get(snap.id);
          if (!snap.exists()) {
            if (!row) throw new Error("修正の参照先が見つかりません。");
            newRows.push(row);
          } else if (row) {
            const current=decodeOperation(snap.id,scope,mode,snap.get("payload"));
            if (!current||operationSignature(current)!==operationSignature(row)) {
              throw new Error(`同じIDに違う記録があります。（${snap.id}）`);
            }
          }
        }
        for (const row of newRows) tx.set(doc(ops,row.id),{
          payload:restorePayload(row),receivedAt:serverTimestamp(),restoredByUid:uid,
        });
        return newRows.length;
      },{maxAttempts:3});
      restored+=added;
      progress(restored);
    } catch (cause) {
      const detail=cause instanceof Error&&!("code" in cause)?cause.message:"通信状態または権限を確認してください。";
      const saved=restored===0?"復元の完了を確認できませんでした。":`${restored}件を復元した時点で停止しました。`;
      throw new Error(`${saved} ${detail} 最新の差分を確認してから再試行できます。`,{cause});
    }
  }
  return restored;
}
