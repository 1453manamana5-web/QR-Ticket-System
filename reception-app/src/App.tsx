import {useCallback, useEffect, useRef, useState} from "react";
import type {EventAuthPayload,LocalEventData,ReceptionRecord,ReceptionType,Ticket} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {countTickets,getPendingSyncItems,getReceptionRecord,getTicket,loadLocalEvent,markSyncStatus,prepareLocalEventData,saveReceptionTransaction,clearLocalEvent} from "./localDb";
import {downloadCurrentFirebaseEventData,downloadEventData,getEventAuthPayloadByToken} from "./eventDownloader";
import {getTerminalRegistration,registerReceptionTerminal,resetReceptionTerminalRegistration,saveTerminalHeartbeat,subscribeTerminalControl,subscribeTerminalRegistration,syncReceptionRecord} from "./receptionSync";

type Mode="entry"|"exit";
type Screen="registration"|"auth"|"authScan"|"confirm"|"preparing"|"ready"|"reception"|"test";
type Result={kind:"success"|"error";title:string;detail:string};

function parseAuthPayload(text:string):EventAuthPayload|null{
  try{
    const value=JSON.parse(text) as Partial<EventAuthPayload>;
    if(value.type!=="qr-ticket-event-auth"||typeof value.eventId!=="string"||typeof value.eventName!=="string"||typeof value.dataVersion!=="number"||typeof value.authToken!=="string")return null;
    return value as EventAuthPayload;
  }catch{return null;}
}

function QrIcon({size=26}:{size?:number}){
  return <svg className="qr-icon" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M3 3h7v7H3zM5 5v3h3V5zM14 3h7v7h-7zM16 5v3h3V5zM3 14h7v7H3zM5 16v3h3v-3zM14 14h3v3h-3zM19 14h2v7h-2zM14 19h5v2h-5z"/>
  </svg>;
}

function EntryIcon(){
  return <svg className="entry-icon" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M30 8l12 16-12 16" />
    <path d="M42 24H8M16 16l-8 8 8 8" />
    <path d="M28 10v28" />
  </svg>;
}

export default function App(){
  const [screen,setScreen]=useState<Screen>("registration");
  const [terminalRegistrationName,setTerminalRegistrationName]=useState(()=>localStorage.getItem("qr-ticket-reception-name")||"受付端末");
  const [terminalRegistration,setTerminalRegistration]=useState<{approved:boolean;status:"online"|"offline"|"pending";name:string}|null>(null);
  const [mode,setMode]=useState<Mode>("entry");
  const [authPayload,setAuthPayload]=useState<EventAuthPayload|null>(null);
  const [authCode,setAuthCode]=useState("");
  const [authCodeMode,setAuthCodeMode]=useState(false);
  const [localEvent,setLocalEvent]=useState<LocalEventData|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<Result|null>(null);
  const [testResultKind,setTestResultKind]=useState<"entry"|"exit"|"error">("entry");
  const [remoteStopped,setRemoteStopped]=useState(false);
  const [scannerKey,setScannerKey]=useState(0);
  const [online,setOnline]=useState(()=>navigator.onLine);
  const [networkMbps,setNetworkMbps]=useState<number|null>(null);
  const modeSwipeStartX=useRef<number|null>(null);
  const modeSwipeMoved=useRef(false);

  const syncPendingRecords=useCallback(async()=>{
    if(!navigator.onLine)return;
    try{
      const items=await getPendingSyncItems();
      for(const item of items){
        try{
          const record=await getReceptionRecord(item.recordId);
          if(!record)continue;
          const ticket=await getTicket(record.ticketId);
          if(!ticket)continue;
          await syncReceptionRecord(record,ticket);
          await markSyncStatus(item.recordId,"synced",item.retryCount);
        }catch(reason){
          console.error("受付記録のFirebase同期に失敗しました",reason);
          await markSyncStatus(item.recordId,"failed",item.retryCount+1).catch(()=>undefined);
        }
      }
    }catch(reason){
      console.error("同期キューの読み込みに失敗しました",reason);
    }
  },[]);

  useEffect(()=>{
    let unsubscribe:(()=>void)|undefined;
    const applyRegistration=(value:{approved:boolean;status:"online"|"offline"|"pending";name:string}|null)=>{
      setTerminalRegistration(value);
      if(value?.name) setTerminalRegistrationName(value.name);
      if(value?.approved){
        if(screen==="registration") setScreen("auth");
      }else{
        // Firebase側で受付承認が外れた場合は、以前のローカルイベントを使って受付画面へ進ませない。
        setAuthPayload(null);
        setLocalEvent(null);
        setResult(null);
        setScreen("registration");
      }
    };
    void getTerminalRegistration().then(applyRegistration).catch(reason=>console.error("受付端末登録状態の取得に失敗しました",reason));
    try{
      unsubscribe=subscribeTerminalRegistration(applyRegistration,reason=>console.error("受付端末登録状態の購読に失敗しました",reason));
    }catch(reason){
      console.error("受付端末登録状態の購読開始に失敗しました",reason);
    }
    return()=>unsubscribe?.();
  },[screen]);

  useEffect(()=>{
    if(!terminalRegistration?.approved)return;

    let cancelled=false;
    const loadCurrentFirebaseEvent=async()=>{
      try{
        const downloaded=await downloadCurrentFirebaseEventData(getTerminalId());
        if(!downloaded || cancelled)return;

        const existing=await loadLocalEvent();
        if(
          existing?.dataReady &&
          existing.event.eventId===downloaded.localEvent.event.eventId &&
          existing.event.dataVersion===downloaded.localEvent.event.dataVersion
        ){
          return;
        }

        const localEvent:LocalEventData={
          ...downloaded.localEvent,
          dataReady:false,
        };
        await prepareLocalEventData(localEvent,downloaded.tickets);
        localEvent.dataReady=true;
        if(cancelled)return;
        setLocalEvent(localEvent);
        setAuthPayload({
          type:"qr-ticket-event-auth",
          eventId:localEvent.event.eventId,
          eventName:localEvent.event.eventName,
          dataVersion:localEvent.event.dataVersion,
          authToken:"firebase"
        });
        setError("");
        setResult(null);
        setScreen("ready");
      }catch(reason){
        console.error("Firebaseから開催イベントデータを自動取得できませんでした",reason);
      }
    };

    void loadCurrentFirebaseEvent();
    const interval=window.setInterval(()=>void loadCurrentFirebaseEvent(),10000);
    return()=>{
      cancelled=true;
      window.clearInterval(interval);
    };
  },[terminalRegistration?.approved]);

  useEffect(()=>{
    if(!terminalRegistration?.approved)return;
    void saveTerminalHeartbeat(getTerminalId(), "stopped").then(speed=>setNetworkMbps(speed)).catch(reason=>console.error("起動時の通信速度測定に失敗しました",reason));
  },[terminalRegistration?.approved]);

  useEffect(()=>{
    void syncPendingRecords();
    const interval=window.setInterval(()=>void syncPendingRecords(),10000);
    window.addEventListener("online",syncPendingRecords);
    return()=>{
      window.clearInterval(interval);
      window.removeEventListener("online",syncPendingRecords);
    };
  },[syncPendingRecords]);

  useEffect(()=>{
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener("online",update);
    window.addEventListener("offline",update);
    return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update);};
  },[]);

  useEffect(()=>{
    if(!terminalRegistration?.approved)return;
    void (async()=>{
      try{
        const saved=await loadLocalEvent();
        if(!saved)return;

        if(saved.dataReady){
          const ticketCount=await countTickets(saved.event.eventId);
          if(ticketCount!==saved.ticketCount){
            await clearLocalEvent();
            setError("端末に保存されたイベントデータが不完全です。もう一度イベントを準備してください。");
            return;
          }
        }

        setLocalEvent(saved);
        setAuthPayload({
          type:"qr-ticket-event-auth",
          eventId:saved.event.eventId,
          eventName:saved.event.eventName,
          dataVersion:saved.event.dataVersion,
          authToken:"local"
        });
        setScreen(saved.dataReady?"ready":"preparing");
      }catch{
        setError("ローカルデータを確認できませんでした。");
      }
    })();
  },[]);

  useEffect(()=>{
    if(!result)return;
    const timer=window.setTimeout(()=>setResult(null),2500);
    return()=>window.clearTimeout(timer);
  },[result]);

  useEffect(()=>{
    if(!localEvent?.dataReady)return;
    let unsubscribe:(()=>void)|undefined;
    try{
      unsubscribe=subscribeTerminalControl(localEvent.terminalId,(remoteMode,updatedAt)=>{
        const manualChangedAt=localStorage.getItem(`qr-ticket-terminal-mode-changed:${localEvent.terminalId}`);
        if(updatedAt&&manualChangedAt&&new Date(updatedAt).getTime()<=new Date(manualChangedAt).getTime())return;
        const nextMode=remoteMode==="入口受付"?"entry":remoteMode==="出口受付"?"exit":mode;
        if(remoteMode==="停止"){
          setRemoteStopped(true);
          setResult({kind:"error",title:"受付が停止されています",detail:"管理画面から受付停止の指示を受けています。"});
          return;
        }
        setRemoteStopped(false);
        setMode(nextMode);
        setResult(null);
      },reason=>console.error("端末リモート操作の購読に失敗しました",reason));
    }catch(reason){
      console.error("端末リモート操作の購読に失敗しました",reason);
    }
    const heartbeat=()=>void saveTerminalHeartbeat(localEvent.terminalId,remoteStopped||screen==="ready"?"stopped":mode).then(speed=>setNetworkMbps(speed)).catch(reason=>console.error("端末ハートビートに失敗しました",reason));
    heartbeat();
    const interval=window.setInterval(heartbeat,10000);
    return()=>{unsubscribe?.();window.clearInterval(interval);};
  },[localEvent?.dataReady,localEvent?.terminalId,mode,remoteStopped,screen]);

  const submitReceptionRegistration = async () => {
    if(busy)return;
    const name=terminalRegistrationName.trim();
    if(!name){
      setError("端末名を入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try{
      await registerReceptionTerminal(name);
      localStorage.setItem("qr-ticket-reception-name",name);
      setTerminalRegistration({approved:false,status:"pending",name});
    }catch(reason){
      console.error("受付端末の登録申請に失敗しました",reason);
      setError("登録申請を送信できませんでした。");
    }finally{
      setBusy(false);
    }
  };

  const resetTerminalRegistration = async () => {
    if(busy)return;
    setBusy(true);
    setError("");
    try {
      await resetReceptionTerminalRegistration().catch(reason=>console.error("Firebase上の受付端末登録削除に失敗しました",reason));
      localStorage.removeItem("qr-ticket-terminal-id");
      const nextId=getTerminalId();
      console.info("受付端末登録をリセットしました",nextId);
      setTerminalRegistration(null);
      setScreen("registration");
    } catch (reason) {
      console.error("受付端末登録のリセットに失敗しました", reason);
      setError("登録申請をリセットできませんでした。");
    } finally {
      setBusy(false);
    }
  };

  const handleAuthScan=useCallback((text:string)=>{
    const payload=parseAuthPayload(text);
    if(!payload){setError("このQRコードはイベント認証QRではありません。");return;}
    setError("");
    setAuthPayload(payload);
    setScreen("confirm");
  },[]);

  const authenticateEvent=async()=>{
    if(!authPayload||busy)return;
    setBusy(true);
    setError("");
    const event:LocalEventData={
      event:{eventId:authPayload.eventId,eventName:authPayload.eventName,eventStatus:"ready",dataVersion:authPayload.dataVersion},
      settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
      terminalId:getTerminalId(),
      authenticatedAt:new Date().toISOString(),
      dataReady:false,
      ticketCount:0
    };
    try{
      const downloaded=await downloadEventData(authPayload,event.terminalId);
      event.dataVersion=downloaded.localEvent.event.dataVersion;
      event.eventStatus=downloaded.localEvent.event.eventStatus;
      event.settings=downloaded.localEvent.settings;
      event.authenticatedAt=downloaded.localEvent.authenticatedAt;
      event.ticketCount=downloaded.localEvent.ticketCount;
      await prepareLocalEventData(event,downloaded.tickets);
      event.dataReady=true;
      setLocalEvent(event);
      setScreen("ready");
      setResult(null);
      setAuthCode("");
      setAuthCodeMode(false);
    }catch{
      setError("イベントデータを端末に保存できませんでした。");
      setScreen("confirm");
    }finally{setBusy(false);}
  };

  const handleAuthCodeSubmit=async()=>{
    const token=authCode.trim();
    if(!token||busy)return;
    setBusy(true);
    setError("");
    try{
      const payload=await getEventAuthPayloadByToken(token);
      if(!payload)throw new Error("EVENT_DATA_NOT_FOUND");
      setAuthPayload(payload);
      setAuthCodeMode(false);
      setScreen("confirm");
    }catch{
      setError("イベント連携コードが正しくないか、イベントデータが見つかりません。");
    }finally{setBusy(false);}
  };

  const handleTicketScan=useCallback(async(rawText:string)=>{
    if(!localEvent||busy)return;
    const ticketId=rawText.trim();
    if(!ticketId)return;

    setBusy(true);
    setResult(null);

    try{
      const ticket=await getTicket(ticketId);
      if(!ticket||ticket.eventId!==localEvent.event.eventId){
        setResult({kind:"error",title:"チケットを確認できません",detail:"このチケットは確認できません。"});
        return;
      }
      if(!ticket.valid){
        setResult({kind:"error",title:"このチケットは無効です",detail:"管理アプリで無効になっているチケットです。"});
        return;
      }

      const receptionType=getReceptionType(mode,ticket.currentStatus,localEvent.settings);
      if(!receptionType){
        const detail=mode==="entry"
          ?ticket.currentStatus==="inside"?"このチケットはすでに入場しています。":"このチケットは受付できません。"
          :ticket.currentStatus==="unused"?"このチケットはまだ入場していません。":"このチケットは受付できません。";
        setResult({kind:"error",title:"受付できません",detail});
        return;
      }

      const nextStatus=receptionType==="exit"?"exited":"inside";
      const now=new Date().toISOString();
      const updatedTicket:Ticket={...ticket,currentStatus:nextStatus,updatedAt:now};
      const record:ReceptionRecord={
        recordId:crypto.randomUUID(),
        eventId:localEvent.event.eventId,
        ticketId,
        type:receptionType,
        timestamp:now,
        terminalId:localEvent.terminalId
      };

      await saveReceptionTransaction(updatedTicket,record);
      if(navigator.onLine){
        void syncReceptionRecord(record,updatedTicket)
          .then(()=>markSyncStatus(record.recordId,"synced",0))
          .catch(reason=>console.error("受付記録の即時Firebase同期に失敗しました",reason));
      }
      setResult({
        kind:"success",
        title:receptionType==="entry"?"入場を確認しました":receptionType==="reentry"?"再入場を確認しました":"退場を確認しました",
        detail:ticketId
      });
      speakReception(receptionType);
      playSuccessSound();
    }catch{
      setResult({
        kind:"error",
        title:"受付データを保存できませんでした",
        detail:"受付を確定できていないため、もう一度読み取ってください。"
      });
    }finally{
      setBusy(false);
      window.setTimeout(()=>setScannerKey(value=>value+1),650);
    }
  },[localEvent,mode,busy]);

  const switchMode=()=>{
    if(remoteStopped)return;
    if(localEvent?.terminalId)localStorage.setItem(`qr-ticket-terminal-mode-changed:${localEvent.terminalId}`,new Date().toISOString());
    setMode(current=>current==="entry"?"exit":"entry");
    setResult(null);
    // モード切替ではQRカメラを再生成しない。
    // Safariではカメラ停止→再起動が競合して画面が白くなることがあるため、
    // QrScannerはそのまま維持し、最新のmodeをhandleTicketScan側で参照する。
  };

  const handleModePointerDown=(event:React.PointerEvent<HTMLButtonElement>)=>{
    modeSwipeStartX.current=event.clientX;
    modeSwipeMoved.current=false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleModePointerUp=(event:React.PointerEvent<HTMLButtonElement>)=>{
    const startX=modeSwipeStartX.current;
    modeSwipeStartX.current=null;
    if(startX===null)return;
    const deltaX=event.clientX-startX;
    if(Math.abs(deltaX)>=45){
      modeSwipeMoved.current=true;
      switchMode();
    }
  };

  const handleModeClick=()=>{
    if(modeSwipeMoved.current){
      modeSwipeMoved.current=false;
      return;
    }
    switchMode();
  };

  const handleModeKeyDown=(event:React.KeyboardEvent<HTMLButtonElement>)=>{
    if(event.key==="Enter"||event.key===" "){
      event.preventDefault();
      switchMode();
    }
  };

  if(screen==="registration")return <div className="entry-reception-page waiting reception-registration-page">
    <main className="entry-reception-main">
      <section className="entry-result-panel reception-registration-panel">
        <span className="entry-result-eyebrow">RECEPTION TERMINAL</span>
        <h2>{terminalRegistration ? "受付端末の承認待ち" : "受付端末を登録"}</h2>
        <p className="entry-result-primary">{terminalRegistration ? "この端末の登録申請を受け付けました。" : "このiPadを受付専用端末として使用するため、最初に登録申請してください。"}</p>
        {!terminalRegistration ? <>
          <label className="reception-registration-field"><span>端末名</span><input value={terminalRegistrationName} onChange={e=>setTerminalRegistrationName(e.target.value)} placeholder="例：入口受付 iPad"/></label>
          <div className="reception-registration-info"><span>端末種別</span><strong>Web / iPad</strong></div>
          <button type="button" className="primary" disabled={busy} onClick={()=>void submitReceptionRegistration()}>{busy?"申請中…":"受付端末を登録申請"}</button>
        </> : <>
          <div className="reception-registration-info"><span>端末名</span><strong>{terminalRegistration.name}</strong></div>
          <div className="reception-registration-info"><span>状態</span><strong>管理者の承認待ち</strong></div>
          <p className="entry-result-secondary">承認されるとイベント認証画面へ自動的に進めるようになります。</p>
          <button type="button" className="secondary" disabled={busy} onClick={()=>void resetTerminalRegistration()}>{busy?"リセット中…":"申請をリセット"}</button>
        </>}
        {error&&<p className="entry-result-secondary">{error}</p>}
      </section>
    </main>
  </div>;

  if(!terminalRegistration || terminalRegistration.approved!==true){
    return <div className="entry-reception-page waiting reception-registration-page">
      <main className="entry-reception-main">
        <section className="entry-result-panel reception-registration-panel">
          <span className="entry-result-eyebrow">RECEPTION TERMINAL</span>
          <h2>{terminalRegistration ? "受付端末の承認待ち" : "受付端末を登録"}</h2>
          <p className="entry-result-primary">{terminalRegistration ? "この端末の登録申請を受け付けました。" : "このiPadを受付専用端末として使用するため、最初に登録申請してください。"}</p>
          {!terminalRegistration ? <>
            <label className="reception-registration-field"><span>端末名</span><input value={terminalRegistrationName} onChange={e=>setTerminalRegistrationName(e.target.value)} placeholder="例：入口受付 iPad"/></label>
            <div className="reception-registration-info"><span>端末種別</span><strong>Web / iPad</strong></div>
            <button type="button" className="primary" disabled={busy} onClick={()=>void submitReceptionRegistration()}>{busy?"申請中…":"受付端末を登録申請"}</button>
          </> : <>
            <div className="reception-registration-info"><span>端末名</span><strong>{terminalRegistration.name}</strong></div>
            <div className="reception-registration-info"><span>状態</span><strong>管理者の承認待ち</strong></div>
            <p className="entry-result-secondary">承認されるとイベント認証画面へ自動的に進めるようになります。</p>
          </>}
          {error&&<p className="entry-result-secondary">{error}</p>}
        </section>
      </main>
    </div>;
  }

  if(screen==="auth")return <div className="entry-reception-page waiting event-auth-page">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-network-speed">通信 {networkMbps!==null?`${networkMbps.toFixed(1)} Mbps`:"測定中…"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>イベント未認証</strong></div></div>
      </div>
    </header>
    <main className="entry-reception-main">
      <section className="entry-waiting-panel event-auth-waiting-panel">
        <div className="entry-scanner-card event-auth-card">
          <div className="entry-scanner-card-header">
            <div className="entry-scanner-heading"><span className="entry-scanner-heading-icon"><QrIcon size={30}/></span><span className="entry-scanner-heading-copy"><small>EVENT AUTHENTICATION</small><strong>イベント認証</strong></span></div>
            <div className="entry-scanner-ready"><span className="entry-scanner-ready-dot"/>待機中</div>
          </div>
          <div className="entry-scanner-wrapper event-auth-wrapper">
            <div className="camera-qr-scanner reception-start-panel event-auth-viewport">
              <div className="reception-start-content event-auth-content">
                <div className="entry-result-icon">✓</div>
                <h2>イベント認証の準備完了</h2>
                <p className="entry-result-primary">管理アプリのイベントデータQRを読み取るか、連携コードを入力してください</p>
                <p className="entry-result-secondary">この画面ではカメラを起動しません</p>
                <div className="event-auth-actions">
                  <button type="button" className="primary" onClick={()=>{setError("");setScreen("authScan");}}>イベントデータQRを読み取る</button>
                  <button type="button" className="secondary" onClick={()=>{setError("");setAuthCodeMode(current=>!current);}}>{authCodeMode?"QRで連携する":"コードで連携する"}</button>\n                  <button type="button" className="secondary" onClick={()=>{setError("");setTestResultKind(mode==="entry"?"entry":"exit");setScreen("test");speakReception(mode==="entry"?"entry":"exit");playSuccessSound();}}>受付結果を試験表示</button>
                </div>
                {authCodeMode&&<div className="reception-auth-code-form">
                  <label><span>イベント連携コード</span><input value={authCode} onChange={e=>setAuthCode(e.target.value)} placeholder="管理アプリに表示されたコード" autoCapitalize="none" autoCorrect="off" /></label>
                  <button type="button" className="primary" disabled={busy||!authCode.trim()} onClick={()=>void handleAuthCodeSubmit()}>{busy?"確認中…":"コードで連携"}</button>
                </div>}
              </div>
            </div>
          </div>
        </div>
        {error&&<div className="entry-auth-error">{error}</div>}
      </section>
    </main>
  </div>;

  if(screen==="test"){
    const testEntry=testResultKind==="entry";
    const testExit=testResultKind==="exit";
    return <div className={`entry-reception-page ${testResultKind==="error"?"error":"ticket-success"} reception-mode-${testEntry?"entry":"exit"}`}>
      <main className="entry-reception-main">
        <section className={testEntry||testResultKind==="error" ? "entry-result-panel entry-ticket-result" : "exit-result-panel exit-ticket-result"} role="status" aria-live="polite">
          {testResultKind==="error" ? <>
            <div className="entry-result-icon">×</div>
            <span className="entry-result-eyebrow">RECEPTION ERROR</span>
            <h2>受付失敗</h2>
            <p className="entry-result-primary">受付できません</p>
            <p className="entry-result-number">このチケットはすでに入場しています。</p>
            <p className="entry-result-secondary">約2.5秒後に読み取り画面へ戻ります</p>
          </> : <>
            <div className={testEntry ? "entry-result-icon entry-ticket-success-icon" : "exit-result-icon exit-ticket-success-icon"} aria-hidden="true">
              <svg viewBox="0 0 120 120" focusable="false">
                <circle className={testEntry ? "entry-ticket-success-circle" : "exit-ticket-success-circle"} cx="60" cy="60" r="48"/>
                <path className={testEntry ? "entry-ticket-success-check" : "exit-ticket-success-check"} d="M35 61.5 52 78 86 42"/>
              </svg>
            </div>
            <span className={testEntry ? "entry-result-eyebrow" : "exit-result-eyebrow"}>{testEntry ? "ADMISSION COMPLETE" : "EXIT COMPLETE"}</span>
            <h2 className={testEntry ? "entry-ticket-success-title" : "exit-ticket-success-title"}>{testEntry ? "入場OK" : "退出OK"}</h2>
            {testEntry
              ? <p className="entry-ticket-success-message">入場を確認しました</p>
              : <p className="exit-thank-you-message">御来場いただきありがとうございました</p>}
            <p className={testEntry ? "entry-result-number" : "exit-result-number"}><span>TICKET</span>TEST-0001</p>
            {testExit && <p className="exit-result-secondary">退場を確認しました</p>}
            <div className={testEntry ? "entry-result-return" : "exit-result-return"} aria-hidden="true">
              <span>次の読み取り画面へ戻ります</span>
              <div className={testEntry ? "entry-result-return-track" : "exit-result-return-track"}><span/></div>
            </div>
          </>}
          <div style={{display:"flex",gap:"10px",justifyContent:"center",flexWrap:"wrap",marginTop:"24px"}}>
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("entry");speakReception("entry");void playSuccessSound();}}>入口結果</button>
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("exit");speakReception("exit");void playSuccessSound();}}>出口結果</button>
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("error");window.speechSynthesis?.cancel();}}>エラー結果</button>
          </div>
          <button type="button" className="secondary reception-test-close" onClick={()=>{setResult(null);setScreen("auth");}}>試験を終了</button>
        </section>
      </main>
    </div>;
  }

  if(screen==="authScan")return <div className="entry-reception-page waiting">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-network-speed">通信 {networkMbps!==null?`${networkMbps.toFixed(1)} Mbps`:"測定中…"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>イベント認証QR読み取り</strong></div></div>
      </div>
    </header>
    <main className="entry-reception-main">
      <section className="entry-waiting-panel">
        <div className="entry-scanner-card">
          <div className="entry-scanner-card-header">
            <div className="entry-scanner-heading"><span className="entry-scanner-heading-icon"><QrIcon size={30}/></span><span className="entry-scanner-heading-copy"><small>EVENT AUTHENTICATION</small><strong>イベント認証QRを読み取り</strong></span></div>
            <div className="entry-scanner-ready"><span className="entry-scanner-ready-dot"/>読み取り中</div>
          </div>
          <div className="entry-scanner-wrapper">
            <div className="camera-qr-scanner"><QrScanner readerId="event-auth-reader" onResult={handleAuthScan} onError={setError}/></div>
          </div>
        </div>
        <div className="entry-scan-instruction">
          <span className="entry-scan-instruction-number">1</span>
          <span className="entry-scan-instruction-copy"><strong>管理アプリのイベント認証QRをカメラに向けてください</strong><small>読み取り後、イベントデータの準備を開始します</small></span>
        </div>
        {error&&<div className="entry-auth-error">{error}</div>}
        <button type="button" className="secondary" onClick={()=>{setError("");setScreen("auth");}}>戻る</button>
      </section>
    </main>
  </div>;

  if(screen==="confirm"&&authPayload)return <div className="entry-reception-page waiting">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-network-speed">通信 {networkMbps!==null?`${networkMbps.toFixed(1)} Mbps`:"測定中…"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{authPayload.eventName}</strong></div></div>
      </div>
    </header>
    <main className="entry-reception-main"><section className="entry-result-panel entry-ticket-result">
      <div className="entry-result-icon">?</div><span className="entry-result-eyebrow">EVENT AUTHENTICATION</span>
      <h2>このイベントで認証しますか？</h2><p className="entry-result-primary">{authPayload.eventName}</p><p className="entry-result-number">{authPayload.eventId}</p>
      {error&&<p className="entry-result-secondary">{error}</p>}
      <button type="button" className="primary" disabled={busy} onClick={()=>void authenticateEvent()}>{busy?"イベントデータを準備中…":"このイベントで認証"}</button>
      <button type="button" className="secondary" disabled={busy} onClick={()=>setScreen("auth")}>別のQRを読み取る</button>
    </section></main>
  </div>;

  if(screen==="preparing")return <div className="entry-reception-page waiting">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-network-speed">通信 {networkMbps!==null?`${networkMbps.toFixed(1)} Mbps`:"測定中…"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{localEvent?.event.eventName??authPayload?.eventName??"イベント未設定"}</strong></div></div>
      </div>
    </header>
    <main className="entry-reception-main"><section className="entry-result-panel entry-processing-result">
      <div className="entry-processing-spinner" aria-hidden="true"/>
      <span className="entry-result-eyebrow">EVENT DATA</span><h2>イベントデータ準備中</h2>
      <p className="entry-result-primary">管理アプリからチケットデータを取得すると受付を開始できます</p>
      {error&&<p className="entry-result-secondary">{error}</p>}
    </section></main>
  </div>;

  if(screen==="ready"&&localEvent?.dataReady)return <div className={`entry-reception-page waiting reception-mode-${mode}`}>
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-network-speed">通信 {networkMbps!==null?`${networkMbps.toFixed(1)} Mbps`:"測定中…"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{localEvent.event.eventName}</strong></div></div>
        <button
          type="button"
          className={`entry-reception-mode-switch ${mode==="entry"?"is-entry":"is-exit"}`}
          onPointerDown={handleModePointerDown}
          onPointerUp={handleModePointerUp}
          onClick={handleModeClick}
          onKeyDown={handleModeKeyDown}
          aria-label={mode==="entry"?"入口受付。左右にスワイプして出口受付へ切り替え":"出口受付。左右にスワイプして入口受付へ切り替え"}
          aria-pressed={mode==="exit"}
        >
          <span className="entry-reception-mode-switch-face entry-reception-mode-switch-front">
            <EntryIcon />
            <span><small>ENTRY</small><strong>入口受付</strong></span>
          </span>
          <span className="entry-reception-mode-switch-face entry-reception-mode-switch-back">
            <EntryIcon />
            <span><small>EXIT</small><strong>出口受付</strong></span>
          </span>
        </button>
      </div>
    </header>
    <main className="entry-reception-main">
      <section className="entry-waiting-panel">
        <div className="entry-scanner-card">
          <div className="entry-scanner-card-header">
            <div className="entry-scanner-heading">
              <span className="entry-scanner-heading-icon"><QrIcon size={30}/></span>
              <span className="entry-scanner-heading-copy">
                <small>RECEPTION READY</small>
                <strong>受付を開始</strong>
              </span>
            </div>
            <div className="entry-scanner-ready">
              <span className="entry-scanner-ready-dot" aria-hidden="true"/>
              準備完了
            </div>
          </div>
          <div className="entry-scanner-wrapper">
            <div className="camera-qr-scanner reception-start-panel">
              <div className="reception-start-content">
                <div className="entry-result-icon">✓</div>
                <h2>受付準備完了</h2>
                <p className="entry-result-primary">チケット {localEvent.ticketCount}枚を端末に保存しました</p>
                <p className="entry-result-secondary">受付を開始すると、ここにQRコードカメラが表示されます</p>
                <button type="button" className="primary" onClick={()=>{setResult(null);setScreen("reception");setScannerKey(value=>value+1);}}>受付を開始する</button>
                <button type="button" className="secondary" onClick={()=>{speakReception(mode==="entry"?"entry":"exit");void playSuccessSound();setScreen("test");}}>受付結果を試験表示</button>
              </div>
            </div>
          </div>
        </div>
        <div className="entry-scan-instruction">
          <span className="entry-scan-instruction-number">1</span>
          <span className="entry-scan-instruction-copy">
            <strong>「受付を開始する」を押して受付を開始してください</strong>
            <small>開始後、自動的にQRコード読み取り画面へ切り替わります</small>
          </span>
        </div>
      </section>
    </main>
  </div>;

  const entry=mode==="entry";
  const eventName=localEvent?.event.eventName??"イベント";
  const receptionClass=result?.kind==="success"?"ticket-success":result?.kind==="error"?"error":"waiting";

  return <div className={`entry-reception-page ${receptionClass} reception-mode-${mode}`}>
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>

    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta">
          <span className="connection-status">
            <span className={`online-dot ${online?"is-online":"is-offline"}`}/> {online?"オンライン":"オフライン"}
          </span>
          <span className="entry-header-meta-divider" aria-hidden="true"/>
          <div className="entry-current-event">
            <span className="entry-current-event-label">EVENT</span>
            <strong>{eventName}</strong>
          </div>
        </div>
        <button
          type="button"
          className={`entry-reception-mode-switch ${entry?"is-entry":"is-exit"}`}
          onPointerDown={handleModePointerDown}
          onPointerUp={handleModePointerUp}
          onClick={handleModeClick}
          onKeyDown={handleModeKeyDown}
          aria-label={entry?"入口受付。左右にスワイプして出口受付へ切り替え":"出口受付。左右にスワイプして入口受付へ切り替え"}
          aria-pressed={!entry}
        >
          <span className="entry-reception-mode-switch-face entry-reception-mode-switch-front">
            <EntryIcon />
            <span><small>ENTRY</small><strong>入口受付</strong></span>
          </span>
          <span className="entry-reception-mode-switch-face entry-reception-mode-switch-back">
            <EntryIcon exit />
            <span><small>EXIT</small><strong>出口受付</strong></span>
          </span>
        </button>
      </div>
    </header>

    <main className="entry-reception-main">
      {!result && (
        <section className="entry-waiting-panel">
          <div className="entry-scanner-card">
            <div className="entry-scanner-card-header">
              <div className="entry-scanner-heading">
                <span className="entry-scanner-heading-icon"><QrIcon size={30}/></span>
                <span className="entry-scanner-heading-copy">
                  <small>QR SCANNER</small>
                  <strong>QRコード読み取り</strong>
                </span>
              </div>
  
            </div>
            <div className="entry-scanner-wrapper">
              <div className="camera-qr-scanner">
                {remoteStopped ? <div className="reception-start-content"><div className="entry-result-icon">×</div><h2>受付停止中</h2><p className="entry-result-primary">管理画面から受付停止の指示を受けています</p><p className="entry-result-secondary">管理画面から入口・出口受付へ戻すと再開します</p></div> : <QrScanner
                  key={scannerKey}
                  readerId="ticket-reader"
                  onResult={handleTicketScan}
                  onError={message=>setResult({kind:"error",title:"カメラを起動できません",detail:message})}
                />}
              </div>
            </div>
          </div>

          <div className="entry-scan-instruction">
            <span className="entry-scan-instruction-number">1</span>
            <span className="entry-scan-instruction-copy">
              <strong>QRコードをカメラに向けてください</strong>
              <small>読み取り枠に入ると自動で受付します</small>
            </span>
          </div>
        </section>
      )}

      {result && (
        <section
          className={entry ? "entry-result-panel entry-ticket-result" : "exit-result-panel exit-ticket-result"}
          role="status"
          aria-live="polite"
        >
          {result.kind==="success" ? <>
            <div className={entry ? "entry-result-icon entry-ticket-success-icon" : "exit-result-icon exit-ticket-success-icon"} aria-hidden="true">
              <svg viewBox="0 0 120 120" focusable="false">
                <circle className={entry ? "entry-ticket-success-circle" : "exit-ticket-success-circle"} cx="60" cy="60" r="48"/>
                <path className={entry ? "entry-ticket-success-check" : "exit-ticket-success-check"} d="M35 61.5 52 78 86 42"/>
              </svg>
            </div>
            <span className={entry ? "entry-result-eyebrow" : "exit-result-eyebrow"}>
              {entry ? "ADMISSION COMPLETE" : "EXIT COMPLETE"}
            </span>
            <h2 className={entry ? "entry-ticket-success-title" : "exit-ticket-success-title"}>
              {entry ? (result.title.includes("再入場") ? "再入場OK" : "入場OK") : "退出OK"}
            </h2>
            {entry ? (
              <p className="entry-ticket-success-message">{result.title}</p>
            ) : (
              <p className="exit-thank-you-message">御来場いただきありがとうございました</p>
            )}
            <p className={entry ? "entry-result-number" : "exit-result-number"}>
              <span>TICKET</span>{result.detail}
            </p>
            {!entry && <p className="exit-result-secondary">{result.title}</p>}
            <div className={entry ? "entry-result-return" : "exit-result-return"} aria-hidden="true">
              <span>次の読み取り画面へ戻ります</span>
              <div className={entry ? "entry-result-return-track" : "exit-result-return-track"}><span/></div>
            </div>
          </> : <>
            <div className={entry ? "entry-result-icon" : "exit-result-icon"}>×</div>
            <span className={entry ? "entry-result-eyebrow" : "exit-result-eyebrow"}>RECEPTION ERROR</span>
            <h2>受付失敗</h2>
            <p className={entry ? "entry-result-primary" : "exit-result-primary"}>{result.title}</p>
            <p className={entry ? "entry-result-number" : "exit-result-number"}>{result.detail}</p>
            <p className={entry ? "entry-result-secondary" : "exit-result-secondary"}>約2.5秒後に読み取り画面へ戻ります</p>
          </>}
        </section>
      )}
    </main>

  </div>;
}

function getReceptionType(mode:Mode,status:Ticket["currentStatus"],settings:LocalEventData["settings"]):ReceptionType|null{
  if(mode==="entry"){
    if(status==="unused"&&settings.entryEnabled)return "entry";
    if(status==="exited"&&settings.reentryEnabled)return "reentry";
    return null;
  }
  if(status==="inside"&&settings.exitEnabled)return "exit";
  return null;
}

function speakReception(type:ReceptionType){
  if(!("speechSynthesis" in window))return;

  const synth=window.speechSynthesis;
  synth.cancel();

  const message=type==="exit"
    ?"ご来場ありがとうございました。"
    :"ご来場ありがとうございます。";

  const utterance=new SpeechSynthesisUtterance(message);
  utterance.lang="ja-JP";
  utterance.rate=0.9;
  utterance.pitch=0.96;
  utterance.volume=1.0;

  const speakWithJapaneseVoice=()=>{
    const voices=synth.getVoices();
    const japaneseVoice=voices.find(voice=>voice.lang.toLowerCase()==="ja-jp")
      ??voices.find(voice=>voice.lang.toLowerCase().startsWith("ja"));
    if(japaneseVoice)utterance.voice=japaneseVoice;
    synth.speak(utterance);
  };

  const voices=synth.getVoices();
  if(voices.length){
    speakWithJapaneseVoice();
  }else{
    synth.addEventListener("voiceschanged",speakWithJapaneseVoice,{once:true});
    window.setTimeout(()=>{
      synth.removeEventListener("voiceschanged",speakWithJapaneseVoice);
      if(!utterance.voice)synth.speak(utterance);
    },500);
  }
}

function playSuccessSound(){
  try{
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    const context=new AudioContextClass();
    const oscillator=context.createOscillator();
    const gain=context.createGain();
    oscillator.type="sine";
    oscillator.frequency.value=880;
    gain.gain.setValueAtTime(0.0001,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12,context.currentTime+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,context.currentTime+0.16);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime+0.17);
    oscillator.onended=()=>void context.close();
  }catch{}
}

function getTerminalId():string{
  const key="qr-ticket-terminal-id";
  const existing=localStorage.getItem(key);
  if(existing)return existing;
  const id="T-"+crypto.randomUUID().slice(0,8).toUpperCase();
  localStorage.setItem(key,id);
  return id;
}

declare global{
  interface Window{
    webkitAudioContext?:typeof AudioContext;
  }
}