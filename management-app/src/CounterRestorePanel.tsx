import {useMemo,useRef,useState,type ChangeEvent} from "react";
import {analyze,type CounterConfig,type CounterMode,type CounterOperation} from "./counterManagementData";
import {operationSignature,readCounterBackup,restoreIsStopped,restorePlan,type CounterBackup} from "./counterRestore";
import {restoreCounterOperations} from "./counterRestoreData";

export function CounterRestorePanel({scope,mode,name,config,rows,enabled}:{
  scope:string;mode:CounterMode;name:string;config:CounterConfig|null;rows:CounterOperation[];enabled:boolean;
}) {
  const [file,setFile]=useState<CounterBackup|null>(null);
  const [issue,setIssue]=useState("");
  const [notice,setNotice]=useState("");
  const [saved,setSaved]=useState("");
  const [acknowledged,setAcknowledged]=useState(false);
  const [busy,setBusy]=useState(false);
  const fileGeneration=useRef(0);
  const working=useRef(false);
  const {preview,conflict}=useMemo(()=>{
    if (!file) return {preview:undefined,conflict:""};
    try {return {preview:restorePlan(file,rows),conflict:""};}
    catch (error) {return {preview:undefined,conflict:(error as Error).message};}
  },[file,rows]);
  const before=preview&&config?.opened!=null?analyze(rows,{eventId:scope,mode,opened:config.opened,closed:config.closed}):null;
  const after=before&&preview&&config?.opened!=null?analyze([...rows,...preview.add.map(row=>({...row,synced:true}))],{
    eventId:scope,mode,opened:config.opened,closed:config.closed}):null;
  const signature=useMemo(()=>preview?.add.length?JSON.stringify([
    rows.map(operationSignature).sort(),preview.add.map(operationSignature),
  ]):"",[preview,rows]);
  const currentSignature=acknowledged&&saved===signature&&saved!=="";

  async function choose(event:ChangeEvent<HTMLInputElement>) {
    const selected=event.target.files?.[0];
    const generation=++fileGeneration.current;
    setFile(null);setIssue("");setNotice("");setAcknowledged(false);setSaved("");
    event.target.value="";
    if (!selected) return;
    try {
      if (selected.size>10*1024*1024) throw new Error("10MB以下のバックアップを選んでください。");
      const parsed=readCounterBackup(await selected.text(),scope,mode);
      if (generation===fileGeneration.current) setFile(parsed);
    } catch (cause) {
      if (generation===fileGeneration.current) setIssue((cause as Error).message);
    }
  }

  function downloadCurrent() {
    if (!config) return;
    const savedAt=Date.now();
    const snapshot:CounterBackup={schema:"counter-day-backup",version:1,scope,mode,name,savedAt,
      window:{from:config.opened??0,to:config.closed??Math.max(config.opened??0,savedAt)},operations:rows};
    const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot,null,2)],{type:"application/json"}));
    const link=document.createElement("a");link.href=url;link.download=`counter-${scope}-${mode}-before-restore.json`;
    document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
    setSaved(signature);setAcknowledged(false);
  }

  async function restore() {
    if (!enabled||!currentSignature||!file||!preview?.add.length||!config||config.verified||!restoreIsStopped(config)||working.current) return;
    working.current=true;setBusy(true);setIssue("");setNotice("復元しています。完了するまで画面を開いておいてください。");
    const count=preview.add.length;
    try {
      const restored=await restoreCounterOperations(file,rows,completed=>setNotice(`復元中　${completed} / ${count}件`));
      setFile(null);setSaved("");setAcknowledged(false);
      setNotice(`${restored}件を復元しました。再集計とデータの整合性を確認してください。`);
    } catch (cause) {
      setIssue((cause as Error).message);setAcknowledged(false);setSaved("");setNotice("");
    } finally {working.current=false;setBusy(false);}
  }

  return <section className="cm-section">
    <div className="cm-section-top"><div><h2>JSONバックアップの復元</h2>
      <p className="cm-caption">選択中の開催日・運用区分に、未登録の通過記録と修正履歴を追加します。</p></div></div>
    <label>バックアップファイル <input type="file" accept=".json,application/json" onChange={e=>void choose(e)} disabled={busy}/></label>
    {file&&<p className="cm-caption">{file.name} · {file.mode==="live"?"本番":"試験"} · {new Date(file.savedAt).toLocaleString("ja-JP",{timeZone:"Asia/Tokyo"})}</p>}
    {preview&&<div className="cm-confirm">
      <p>追加 {preview.add.length}件 · 登録済み {preview.duplicates}件</p>
      {before&&after&&<p>復元後の見込み　入場 {before.entries} → {after.entries}回、退場 {before.exits} → {after.exits}回、整合性の指摘 {before.issues.length} → {after.issues.length}件</p>}
      {after&&after.issues.length>0&&<details><summary>整合性の指摘を確認</summary><ul>{[...new Set(after.issues.map(item=>item.code))].map(code=><li key={code}>{code}</li>)}</ul></details>}
      {config?.verified&&preview.add.length>0&&<p className="cm-warning">集計が確定済みです。この画面で集計確定を取り消すと復元できます。</p>}
      {!config&&preview.add.length>0&&<p className="cm-warning">復元するには運用設定をサーバーで確認できる必要があります。</p>}
      {config&&!restoreIsStopped(config)&&preview.add.length>0&&<p className="cm-warning">計測中です。閉場処理を終えるか、試験を終了してから復元してください。</p>}
      {preview.add.length>0&&config&&restoreIsStopped(config)&&!config.verified&&<div className="cm-form">
        <button type="button" onClick={downloadCurrent} disabled={!enabled||busy}>復元前のJSONを保存</button>
        {saved&&saved===signature&&<label><input type="checkbox" checked={acknowledged} onChange={e=>setAcknowledged(e.target.checked)} disabled={busy}/> 復元前のファイルを保存した</label>}
        <button type="button" className="cm-primary" onClick={()=>void restore()} disabled={!enabled||busy||!currentSignature}>追加を確定</button>
      </div>}
    </div>}
    {(issue||conflict)&&<p className="cm-warning" role="alert">{issue||conflict}</p>}
    {notice&&<p className="cm-notice" role="status">{notice}</p>}
  </section>;
}
