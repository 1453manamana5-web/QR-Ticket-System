import {useCallback, useEffect, useRef, useState} from "react";
import type {EventAuthPayload,LocalEventData,ReceptionRecord,ReceptionType,Ticket} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {countTickets,getTicket,loadLocalEvent,prepareLocalEventData,saveReceptionTransaction,clearLocalEvent} from "./localDb";
import {downloadEventData} from "./eventDownloader";

type Mode="entry"|"exit";
type Screen="auth"|"authScan"|"confirm"|"preparing"|"ready"|"reception";
type Result={kind:"success"|"error";title:string;detail:string};

const DEMO_EVENT:EventAuthPayload={
  type:"qr-ticket-event-auth",
  eventId:"DEMO-2027",
  eventName:"○○文化祭 2027",
  dataVersion:1,
  authToken:"demo-auth-token"
};

function parseAuthPayload(text:string):EventAuthPayload|null{
  try{
    const value=JSON.parse(text) as Partial<EventAuthPayload>;
    if(value.type!=="qr-ticket-event-auth"||typeof value.eventId!=="string"||typeof value.eventName!=="string"||typeof value.dataVersion!=="number"||typeof value.authToken!=="string")return null;
    return value as EventAuthPayload;
  }catch{return null;}
}

function createDemoTickets(eventId:string):Ticket[]{
  return Array.from({length:500},(_,index)=>({
    ticketId:"DEMO-"+String(index+1).padStart(4,"0"),
    eventId,
    basicInfo:{ticketNumber:index+1},
    currentStatus:"unused" as const,
    valid:true,
    updatedAt:new Date().toISOString()
  }));
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
  const [screen,setScreen]=useState<Screen>("auth");
  const [mode,setMode]=useState<Mode>("entry");
  const [authPayload,setAuthPayload]=useState<EventAuthPayload|null>(null);
  const [localEvent,setLocalEvent]=useState<LocalEventData|null>(null);
  const [error,setError]=useState("");
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<Result|null>(null);
  const [scannerKey,setScannerKey]=useState(0);
  const [online,setOnline]=useState(()=>navigator.onLine);
  const modeSwipeStartX=useRef<number|null>(null);
  const modeSwipeMoved=useRef(false);

  useEffect(()=>{
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener("online",update);
    window.addEventListener("offline",update);
    return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update);};
  },[]);

  useEffect(()=>{
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

  const handleAuthScan=useCallback((text:string)=>{
    const payload=parseAuthPayload(text);
    if(!payload){setError("このQRコードはイベント認証QRではありません。");return;}
    setError("");
    setAuthPayload(payload);
    setScreen("confirm");
  },[]);

  const startDemoEvent=async()=>{
    if(busy)return;
    setAuthPayload(DEMO_EVENT);
    setError("");
    setBusy(true);
    try{
      const tickets=createDemoTickets(DEMO_EVENT.eventId);
      const event:LocalEventData={
        event:{eventId:DEMO_EVENT.eventId,eventName:DEMO_EVENT.eventName,eventStatus:"ready",dataVersion:DEMO_EVENT.dataVersion},
        settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
        terminalId:getTerminalId(),
        authenticatedAt:new Date().toISOString(),
        dataReady:false,
        ticketCount:0
      };
      event.dataReady=true;
      event.ticketCount=tickets.length;
      await prepareLocalEventData(event,tickets);
      setLocalEvent(event);
      setScreen("ready");
      setResult(null);
    }catch(error){
      console.error("開発用イベントの端末保存に失敗しました",error);
      const detail=error instanceof Error&&error.message?error.message:"原因不明の保存エラー";
      setError(`開発用イベントデータを端末に保存できませんでした。(${detail})`);
    }finally{setBusy(false);}
  };

  const authenticateEvent=async()=>{
    if(!authPayload||busy)return;
    setBusy(true);
    setError("");
    const isDemo=authPayload.eventId===DEMO_EVENT.eventId;
    const event:LocalEventData={
      event:{eventId:authPayload.eventId,eventName:authPayload.eventName,eventStatus:"ready",dataVersion:authPayload.dataVersion},
      settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
      terminalId:getTerminalId(),
      authenticatedAt:new Date().toISOString(),
      dataReady:false,
      ticketCount:0
    };
    try{
      if(isDemo){
        const tickets=createDemoTickets(authPayload.eventId);
        event.dataReady=true;
        event.ticketCount=tickets.length;
        await prepareLocalEventData(event,tickets);
      }else{
        const downloaded=await downloadEventData(authPayload,event.terminalId);
        event.dataVersion=downloaded.localEvent.event.dataVersion;
        event.eventStatus=downloaded.localEvent.event.eventStatus;
        event.settings=downloaded.localEvent.settings;
        event.authenticatedAt=downloaded.localEvent.authenticatedAt;
        event.ticketCount=downloaded.localEvent.ticketCount;
        await prepareLocalEventData(event,downloaded.tickets);
        event.dataReady=true;
      }
      setLocalEvent(event);
      setScreen("ready");
      setResult(null);
    }catch{
      setError("イベントデータを端末に保存できませんでした。");
      setScreen("confirm");
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

  if(screen==="auth")return <div className="entry-reception-page waiting">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>イベント未認証</strong></div></div>
      </div>
    </header>
    <main className="entry-reception-main">
      <section className="entry-waiting-panel">
        <div className="entry-scanner-card">
          <div className="entry-scanner-card-header">
            <div className="entry-scanner-heading"><span className="entry-scanner-heading-icon"><QrIcon size={30}/></span><span className="entry-scanner-heading-copy"><small>EVENT AUTHENTICATION</small><strong>イベント認証</strong></span></div>
            <div className="entry-scanner-ready"><span className="entry-scanner-ready-dot"/>待機中</div>
          </div>
          <div className="entry-scanner-wrapper">
            <div className="camera-qr-scanner reception-start-panel">
              <div className="reception-start-content">
                <div className="entry-result-icon">✓</div>
                <h2>イベント認証の準備完了</h2>
                <p className="entry-result-primary">管理アプリのイベント認証QRを読み取ってください</p>
                <p className="entry-result-secondary">この画面ではカメラを起動しません</p>
                <button type="button" className="primary" onClick={()=>{setError("");setScreen("authScan");}}>イベント認証を開始する</button>
              </div>
            </div>
          </div>
        </div>
        {error&&<div className="entry-auth-error">{error}</div>}
        <button type="button" className="entry-auth-dev-button" disabled={busy} onClick={()=>void startDemoEvent()}>{busy?"開発用イベントを準備中…":"開発用イベントで試す"}</button>
      </section>
    </main>
  </div>;

  if(screen==="authScan")return <div className="entry-reception-page waiting">
    <div className="entry-background-circle entry-background-circle-one" aria-hidden="true"/>
    <div className="entry-background-circle entry-background-circle-two" aria-hidden="true"/>
    <header className="entry-reception-header">
      <div className="entry-header-main">
        <h1>交通研究部QRコード管理システム</h1>
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>イベント認証QR読み取り</strong></div></div>
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
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{authPayload.eventName}</strong></div></div>
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
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{localEvent?.event.eventName??authPayload?.eventName??"イベント未設定"}</strong></div></div>
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
        <div className="entry-header-meta"><span className="connection-status"><span className={`online-dot ${online?"is-online":"is-offline"}`}/>{online?"オンライン":"オフライン"}</span><span className="entry-header-meta-divider"/><div className="entry-current-event"><span className="entry-current-event-label">EVENT</span><strong>{localEvent.event.eventName}</strong></div></div>
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
                <QrScanner
                  key={scannerKey}
                  readerId="ticket-reader"
                  onResult={handleTicketScan}
                  onError={message=>setResult({kind:"error",title:"カメラを起動できません",detail:message})}
                />
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
        <section className={`entry-result-panel ${result.kind==="success"?"entry-ticket-result":"entry-error-result"}`}>
          <div className="entry-result-icon">{result.kind==="success"?"✓":"×"}</div>
          <span className="entry-result-eyebrow">{result.kind==="success"?"ENTRY ACCEPTED":"RECEPTION ERROR"}</span>
          <h2>{result.kind==="success"?"受付完了":"受付失敗"}</h2>
          <p className="entry-result-primary">{result.title}</p>
          <p className="entry-result-number">{result.detail}</p>
          {result.kind==="success" && <p className="entry-result-secondary">{entry?"入場を確認しました":"退場を確認しました"}</p>}
          {result.kind==="error" && <p className="entry-result-secondary">もう一度読み取ってください</p>}
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
  window.speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(type==="entry"?"入場を確認しました":type==="reentry"?"再入場を確認しました":"退場を確認しました");
  utterance.lang="ja-JP";
  utterance.rate=1.05;
  window.speechSynthesis.speak(utterance);
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