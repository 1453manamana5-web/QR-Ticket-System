import {useCallback, useEffect, useState} from "react";
import type {EventAuthPayload,LocalEventData,ReceptionRecord,ReceptionType,Ticket} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {getTicket,loadLocalEvent,replaceTickets,saveLocalEvent,saveReceptionTransaction} from "./localDb";

type Mode="entry"|"exit";
type Screen="auth"|"confirm"|"preparing"|"reception";
type Result={kind:"success"|"error";title:string;detail:string};

const DEMO_EVENT:EventAuthPayload={type:"qr-ticket-event-auth",eventId:"DEMO-2027",eventName:"○○文化祭 2027",dataVersion:1,authToken:"demo-auth-token"};

function parseAuthPayload(text:string):EventAuthPayload|null{
  try{
    const value=JSON.parse(text) as Partial<EventAuthPayload>;
    if(value.type!=="qr-ticket-event-auth"||typeof value.eventId!=="string"||typeof value.eventName!=="string"||typeof value.dataVersion!=="number"||typeof value.authToken!=="string") return null;
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

export default function App(){
  const [screen,setScreen]=useState<Screen>("auth");
  const [mode,setMode]=useState<Mode>("entry");
  const [authPayload,setAuthPayload]=useState<EventAuthPayload|null>(null);
  const [localEvent,setLocalEvent]=useState<LocalEventData|null>(null);
  const [error,setError]=useState("");
  const [scanning,setScanning]=useState(false);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState<Result|null>(null);

  useEffect(()=>{
    void loadLocalEvent().then(saved=>{
      if(!saved)return;
      setLocalEvent(saved);
      setAuthPayload({type:"qr-ticket-event-auth",eventId:saved.event.eventId,eventName:saved.event.eventName,dataVersion:saved.event.dataVersion,authToken:"local"});
      setScreen(saved.dataReady?"reception":"preparing");
    }).catch(()=>setError("ローカルデータを確認できませんでした。"));
  },[]);

  const handleAuthScan=useCallback((text:string)=>{
    const payload=parseAuthPayload(text);
    if(!payload){setError("このQRコードはイベント認証QRではありません。");return;}
    setError("");setAuthPayload(payload);setScreen("confirm");
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
        terminalId:getTerminalId(),authenticatedAt:new Date().toISOString(),dataReady:false,ticketCount:0
      };
      await replaceTickets(tickets);
      event.dataReady=true;
      event.ticketCount=tickets.length;
      await saveLocalEvent(event);
      setLocalEvent(event);
      setScreen("reception");
    }catch{
      setError("開発用イベントデータを端末に保存できませんでした。");
    }finally{setBusy(false);}
  };

  const authenticateEvent=async()=>{
    if(!authPayload||busy)return;
    setBusy(true);setError("");
    const isDemo=authPayload.eventId===DEMO_EVENT.eventId;
    const event:LocalEventData={
      event:{eventId:authPayload.eventId,eventName:authPayload.eventName,eventStatus:"ready",dataVersion:authPayload.dataVersion},
      settings:{entryEnabled:true,exitEnabled:true,reentryEnabled:true},
      terminalId:getTerminalId(),authenticatedAt:new Date().toISOString(),dataReady:false,ticketCount:0
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
    }catch{
      setError("イベントデータを端末に保存できませんでした。");setScreen("confirm");
    }finally{setBusy(false);}
  };

  const startReception=()=>{if(!localEvent?.dataReady)return;setResult(null);setScanning(true);};

  const handleTicketScan=useCallback(async(rawText:string)=>{
    if(!localEvent||busy)return;
    const ticketId=rawText.trim();
    if(!ticketId)return;
    setBusy(true);setScanning(false);setResult(null);
    try{
      const ticket=await getTicket(ticketId);
      if(!ticket||ticket.eventId!==localEvent.event.eventId){
        setResult({kind:"error",title:"チケットを確認できません",detail:"このチケットは確認できません。"});return;
      }
      if(!ticket.valid){
        setResult({kind:"error",title:"このチケットは無効です",detail:"管理アプリで無効になっているチケットです。"});return;
      }
      const receptionType=getReceptionType(mode,ticket.currentStatus,localEvent.settings);
      if(!receptionType){
        const detail=mode==="entry"
          ? ticket.currentStatus==="inside"?"このチケットはすでに入場しています。":"このチケットは受付できません。"
          : ticket.currentStatus==="unused"?"このチケットはまだ入場していません。":"このチケットは受付できません。";
        setResult({kind:"error",title:"受付できません",detail});return;
      }
      const nextStatus=receptionType==="exit"?"exited":"inside";
      const now=new Date().toISOString();
      const updatedTicket:Ticket={...ticket,currentStatus:nextStatus,updatedAt:now};
      const record:ReceptionRecord={
        recordId:crypto.randomUUID(),eventId:localEvent.event.eventId,ticketId,type:receptionType,timestamp:now,terminalId:localEvent.terminalId
      };
      await saveReceptionTransaction(updatedTicket,record);
      setResult({kind:"success",title:receptionType==="entry"?"入場を確認しました":receptionType==="reentry"?"再入場を確認しました":"退場を確認しました",detail:ticketId});
      speakReception(receptionType);playSuccessSound();
    }catch{
      setResult({kind:"error",title:"受付データを保存できませんでした",detail:"受付を確定できていないため、もう一度読み取ってください。"});
    }finally{setBusy(false);}
  },[localEvent,mode,busy]);

  if(screen==="auth")return <main className="auth-shell"><div className="auth-card">
    <small className="eyebrow">QR TICKET SYSTEM</small><h1>イベント認証</h1>
    <p>管理アプリに表示されたイベント認証QRを読み取ってください。</p>
    <div className="auth-reader"><QrScanner readerId="event-auth-reader" onResult={handleAuthScan} onError={setError}/></div>
    {error&&<div className="error">{error}</div>}
    <button className="secondary" onClick={()=>void startDemoEvent()}>開発用イベントで試す</button>
  </div></main>;

  if(screen==="confirm"&&authPayload)return <main className="auth-shell"><div className="auth-card confirm-card">
    <small className="eyebrow">EVENT AUTHENTICATION</small><h1>このイベントで認証しますか？</h1>
    <div className="event-preview"><span>イベント</span><strong>{authPayload.eventName}</strong><small>{authPayload.eventId}</small></div>
    {error&&<div className="error">{error}</div>}
    <button className="primary" disabled={busy} onClick={()=>void authenticateEvent()}>{busy?"準備しています…":"このイベントで認証"}</button>
    <button className="secondary" disabled={busy} onClick={()=>setScreen("auth")}>別のQRを読み取る</button>
  </div></main>;

  if(screen==="preparing")return <main className="auth-shell"><div className="auth-card">
    <div className="spinner"/><small className="eyebrow">EVENT DATA</small>
    <h1>{localEvent?.event.eventName??authPayload?.eventName}</h1>
    <p>イベント認証情報を保存しました。管理アプリからチケットデータを取得すると受付を開始できます。</p>
    <div className="status-row"><span>イベント認証</span><b>✓ 保存済み</b></div>
    <div className="status-row"><span>チケットデータ</span><b>準備待ち</b></div>
    {error&&<div className="error">{error}</div>}
  </div></main>;

  const entry=mode==="entry";
  return <main className="reception-shell">
    <button className={"mode mode-"+mode} onClick={()=>{setMode(entry?"exit":"entry");setResult(null);setScanning(false);}}>
      <b>{entry?"入口受付":"出口受付"}</b><small>タップで切り替え</small>
    </button>
    <header className="reception-header"><div><small className="eyebrow">{localEvent?.event.eventName}</small><h1>{entry?"入場受付":"出口受付"}</h1></div><span className="ready-badge">受付準備完了</span></header>
    <section className={"reception-stage "+(scanning?"is-scanning":"")}>
      {scanning?<div className="scanner-panel">
        <div className="ticket-reader"><QrScanner readerId="ticket-reader" onResult={text=>void handleTicketScan(text)} onError={message=>setResult({kind:"error",title:"カメラを起動できません",detail:message})}/><div className="scan-guide"><span/><p>チケットのQRコードを枠内に合わせてください</p></div></div>
        {result&&<div className={"result-card "+result.kind}><strong>{result.title}</strong><span>{result.detail}</span></div>}
        <button className="stop-button" onClick={()=>{setScanning(false);setResult(null);}}>受付を一時停止</button>
      </div>:<div className="standby-panel">
        <div className="standby-icon">QR</div><small className="eyebrow">{entry?"ENTRY":"EXIT"}</small>
        <h2>受付を開始できます</h2><p>「受付を開始する」を押すとカメラが起動します。</p>
        <button className="start-button" onClick={startReception}>受付を開始する</button>
        {result&&<div className={"result-card "+result.kind}><strong>{result.title}</strong><span>{result.detail}</span></div>}
      </div>}
    </section>
  </main>;
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
  utterance.lang="ja-JP";utterance.rate=1.05;window.speechSynthesis.speak(utterance);
}

function playSuccessSound(){
  try{
    const AudioContextClass=window.AudioContext||window.webkitAudioContext;
    const context=new AudioContextClass();
    const oscillator=context.createOscillator();const gain=context.createGain();
    oscillator.type="sine";oscillator.frequency.value=880;
    gain.gain.setValueAtTime(0.0001,context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12,context.currentTime+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,context.currentTime+0.16);
    oscillator.connect(gain);gain.connect(context.destination);oscillator.start();oscillator.stop(context.currentTime+0.17);
    oscillator.onended=()=>void context.close();
  }catch{}
}

function getTerminalId():string{
  const key="qr-ticket-terminal-id";const existing=localStorage.getItem(key);
  if(existing)return existing;
  const id="T-"+crypto.randomUUID().slice(0,8).toUpperCase();localStorage.setItem(key,id);return id;
}

declare global{interface Window{webkitAudioContext?:typeof AudioContext;}}