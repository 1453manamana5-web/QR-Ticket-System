import {useCallback, useEffect, useState} from "react";
import type {EventAuthPayload,LocalEventData,ReceptionRecord,ReceptionType,Ticket} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {getTicket,loadLocalEvent,replaceTickets,saveLocalEvent,saveReceptionTransaction} from "./localDb";

type Mode="entry"|"exit";
type Screen="auth"|"confirm"|"preparing"|"reception";
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

function EntryIcon({exit=false}:{exit?:boolean}){
  return <svg className="entry-icon" width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
    <path d={exit?"M30 8l12 16-12 16":"M18 8L6 24l12 16"} />
    <path d={exit?"M42 24H8M16 16l-8 8 8 8":"M6 24h34"} />
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

  useEffect(()=>{
    const update=()=>setOnline(navigator.onLine);
    window.addEventListener("online",update);
    window.addEventListener("offline",update);
    return()=>{window.removeEventListener("online",update);window.removeEventListener("offline",update);};
  },[]);

  useEffect(()=>{
    void loadLocalEvent().then(saved=>{
      if(!saved)return;
      setLocalEvent(saved);
      setAuthPayload({
        type:"qr-ticket-event-auth",
        eventId:saved.event.eventId,
        eventName:saved.event.eventName,
        dataVersion:saved.event.dataVersion,
        authToken:"local"
      });
      setScreen(saved.dataReady?"reception":"preparing");
    }).catch(()=>setError("ローカルデータを確認できませんでした。"));
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
      await replaceTickets(tickets);
      event.dataReady=true;
      event.ticketCount=tickets.length;
      await saveLocalEvent(event);
      setLocalEvent(event);
      setScreen("reception");
      setResult(null);
      setScannerKey(value=>value+1);
    }catch{
      setError("開発用イベントデータを端末に保存できませんでした。");
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
        await replaceTickets(tickets);
        event.dataReady=true;
        event.ticketCount=tickets.length;
      }
      await saveLocalEvent(event);
      setLocalEvent(event);
      setScreen(event.dataReady?"reception":"preparing");
      setResult(null);
      if(event.dataReady)setScannerKey(value=>value+1);
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
    setScannerKey(value=>value+1);
  };

  if(screen==="auth")return <main className="auth-shell"><div className="auth-card">
    <small className="eyebrow">QR TICKET SYSTEM</small>
    <h1>イベント認証</h1>
    <p>管理アプリに表示されたイベント認証QRを読み取ってください。</p>
    <div className="auth-reader"><QrScanner readerId="event-auth-reader" onResult={handleAuthScan} onError={setError}/></div>
    {error&&<div className="error">{error}</div>}
    <button className="secondary" onClick={()=>void startDemoEvent()}>開発用イベントで試す</button>
  </div></main>;

  if(screen==="confirm"&&authPayload)return <main className="auth-shell"><div className="auth-card confirm-card">
    <small className="eyebrow">EVENT AUTHENTICATION</small>
    <h1>このイベントで認証しますか？</h1>
    <div className="event-preview"><span>イベント</span><strong>{authPayload.eventName}</strong><small>{authPayload.eventId}</small></div>
    {error&&<div className="error">{error}</div>}
    <button className="primary" disabled={busy} onClick={()=>void authenticateEvent()}>{busy?"準備しています…":"このイベントで認証"}</button>
    <button className="secondary" disabled={busy} onClick={()=>setScreen("auth")}>別のQRを読み取る</button>
  </div></main>;

  if(screen==="preparing")return <main className="auth-shell"><div className="auth-card">
    <div className="spinner"/>
    <small className="eyebrow">EVENT DATA</small>
    <h1>{localEvent?.event.eventName??authPayload?.eventName}</h1>
    <p>イベント認証情報を保存しました。管理アプリからチケットデータを取得すると受付を開始できます。</p>
    <div className="status-row"><span>イベント認証</span><b>✓ 保存済み</b></div>
    <div className="status-row"><span>チケットデータ</span><b>準備待ち</b></div>
    {error&&<div className="error">{error}</div>}
  </div></main>;

  const entry=mode==="entry";
  const eventName=localEvent?.event.eventName??"イベント";
  const receptionClass=result?.kind==="success"?"ticket-success":result?.kind==="error"?"error":"waiting";

  const backHome=()=>{
    setResult(null);
    setScreen("auth");
  };

  return <div className={`entry-reception-page ${entry?receptionClass:receptionClass}`}>
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
      </div>

      <button type="button" className="entry-reception-mode" onClick={switchMode} aria-label={entry?"出口受付に切り替え":"入口受付に切り替え"}>
        <span className="entry-reception-mode-icon">
          <EntryIcon exit={!entry}/>
        </span>
        <span className="entry-reception-mode-copy">
          <small>{entry?"ENTRY":"EXIT"}</small>
          <strong>{entry?"入口受付":"出口受付"}</strong>
        </span>
      </button>
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
              <div className="entry-scanner-ready">
                <span className="entry-scanner-ready-dot" aria-hidden="true"/>
                読み取り待機中
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

    <footer className="entry-reception-footer">
      <button type="button" className="entry-home-button" onClick={backHome}>
        <span className="entry-footer-button-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/></svg>
        </span>
        <span>ホームへ戻る</span>
      </button>
      <button type="button" className="entry-admin-button">
        <span className="entry-footer-button-icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.7 2.9 8.4 7 10 4.1-1.6 7-5.3 7-10V6z"/><path d="M9 11.5a3 3 0 1 1 6 0M8 17c.8-1.7 2.1-2.5 4-2.5s3.2.8 4 2.5"/></svg>
        </span>
        <span>管理モード</span>
      </button>
    </footer>
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