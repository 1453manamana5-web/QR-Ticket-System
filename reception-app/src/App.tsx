import {useCallback, useEffect, useRef, useState} from "react";
import type {EventAuthPayload,LocalEventData,ReceptionRecord,ReceptionType,Ticket} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {prepareReceptionAudio,playReceptionAudio,getReceptionAudioSettings} from "./receptionAudio";
import {syncPendingReceptionRecords} from "./syncQueue";
import {getPendingSyncItems,getReceptionRecord,getTicket,loadLocalEvent,prepareLocalEventData,saveReceptionTransaction,clearLocalEvent,saveReceptionErrorLog,getPendingReceptionErrorLogs,markReceptionErrorLogSynced,type ReceptionErrorCategory} from "./localDb";
import {getCurrentFirebaseEventAuthPayload,downloadCurrentFirebaseEventData,downloadEventData,getEventAuthPayloadByToken} from "./eventDownloader";
import {registerReceptionTerminal,requestReceptionEventReapproval,resetReceptionTerminalRegistration,saveTerminalHeartbeat,subscribeTerminalControl,subscribeTerminalRegistration,getLatestReceptionTicket,syncReceptionErrorLog} from "./receptionSync";

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

function EntryIcon({exit=false}:{exit?:boolean}){
  return <svg className="entry-icon" style={exit?{transform:"rotate(180deg)"}:undefined} width="48" height="48" viewBox="0 0 48 48" aria-hidden="true">
    <path d="M30 8l12 16-12 16" />
    <path d="M42 24H8M16 16l-8 8 8 8" />
    <path d="M28 10v28" />
  </svg>;
}


async function logReceptionError(
  eventId:string,
  terminalId:string,
  mode:Mode,
  category:ReceptionErrorCategory
):Promise<void>{
  const log={
    errorId:crypto.randomUUID(),
    eventId,
    terminalId,
    category,
    mode,
    timestamp:new Date().toISOString()
  };
  try{
    await saveReceptionErrorLog(log);
  }catch(reason){
    console.error("受付エラーの端末内保存に失敗しました",reason);
  }
  if(navigator.onLine){
    void syncReceptionErrorLog(log).then(
      ()=>markReceptionErrorLogSynced(log.errorId)
    ).catch(reason=>{
      // 未同期ログは端末内に残り、次の定期同期で再送される。
      console.error("受付エラーのFirebase同期に失敗しました。後で再試行します",reason);
    });
  }
}

export default function App(){
  const [audioNotice,setAudioNotice]=useState("");
  const checkReceptionSound=async()=>{
    const status=await playReceptionAudio("success");
    setAudioNotice(status==="muted"?"音量が0、または成功音がオフです。管理アプリの設定を確認してください。":status==="blocked"?"音を再生できません。端末の音量・消音設定を確認して、もう一度「音の確認」を押してください。":"");
  };
  useEffect(()=>prepareReceptionAudio(),[]);
  const [screen,setScreen]=useState<Screen>("registration");
  const screenRef=useRef<Screen>(screen);
  screenRef.current=screen;
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
  const [cameraFailed,setCameraFailed]=useState(false);
  const [online,setOnline]=useState(()=>navigator.onLine);
  const [pendingSyncCount,setPendingSyncCount]=useState(0);
  const [networkMbps,setNetworkMbps]=useState<number|null>(null);
  const eventLoadingRef=useRef(false);
  const eventAuthenticationRequiredRef=useRef(false);
  const scanProcessingRef=useRef(false);
  const registrationActiveRef=useRef(false);
  const registrationVersionRef=useRef(0);
  const pendingRemoteModeRef=useRef<Mode|null>(null);
  const registrationIsCurrent=(version:number)=>registrationActiveRef.current&&version===registrationVersionRef.current;
  const lastRemoteCommandRef=useRef("");
  const receptionAllowedRef=useRef(false);
  receptionAllowedRef.current=terminalRegistration?.approved===true&&!remoteStopped&&screen==="reception";
  const modeSwipeStartX=useRef<number|null>(null);
  const modeSwipeMoved=useRef(false);

  const syncPendingRecords=useCallback(async()=>{
    try{
      if(!navigator.onLine)return;
      await syncPendingReceptionRecords();
      const pendingErrors=await getPendingReceptionErrorLogs();
      for(const log of pendingErrors){
        try{
          await syncReceptionErrorLog(log);
          await markReceptionErrorLogSynced(log.errorId);
        }catch(reason){
          console.error("受付エラーログの再同期に失敗しました。次回再試行します",reason);
        }
      }
    }catch(reason){
      console.error("同期キューの読み込みに失敗しました",reason);
    }finally{
      await Promise.all([getPendingSyncItems(),getPendingReceptionErrorLogs()]).then(([items,errors])=>setPendingSyncCount(items.length+errors.length)).catch(()=>undefined);
    }
  },[]);

  useEffect(()=>{
    let unsubscribe:(()=>void)|undefined;
    const readCachedApproval=()=>{
      try{
        const raw=localStorage.getItem("qr-ticket-reception-approved");
        if(!raw)return null;
        const saved=JSON.parse(raw) as {approved?:unknown;name?:unknown;terminalId?:unknown};
        if(saved.approved!==true||saved.terminalId!==getTerminalId())return null;
        return {
          approved:true,
          status:"offline" as const,
          name:typeof saved.name==="string"&&saved.name.trim()?saved.name:"受付端末"
        };
      }catch{return null;}
    };
    const applyRegistration=(incoming:{approved:boolean;status:"online"|"offline"|"pending";name:string}|null)=>{
      // オフライン時にFirebaseのキャッシュが空でも、オンラインで承認済みだった端末は
      // ローカルの承認記録を使う。オンラインで承認取消が確認できた場合は従来どおり停止する。
      const value=(!navigator.onLine&&!incoming?.approved)?readCachedApproval():incoming;
      const approved=value?.approved===true;
      if(registrationActiveRef.current!==approved)++registrationVersionRef.current;
      registrationActiveRef.current=approved;
      setTerminalRegistration(value);
      if(value?.name)setTerminalRegistrationName(value.name);
      if(value?.approved){
        if(navigator.onLine){
          try{
            localStorage.setItem("qr-ticket-reception-approved",JSON.stringify({
              approved:true,
              name:value.name,
              terminalId:getTerminalId(),
              savedAt:new Date().toISOString()
            }));
          }catch(reason){console.warn("受付承認状態を端末に保存できませんでした",reason);}
        }
        if(screenRef.current==="registration"){
          eventAuthenticationRequiredRef.current=false;
          setScreen("auth");
        }
      }else{
        pendingRemoteModeRef.current=null;
        receptionAllowedRef.current=false;
        if(navigator.onLine){
          try{localStorage.removeItem("qr-ticket-reception-approved");}catch{}
        }
        // オフライン時は、未取得を「承認取消」と誤認して保存済みデータを消さない。
        if(navigator.onLine){
          setAuthPayload(null);
          setLocalEvent(null);
          setResult(null);
          setScreen("registration");
        }else if(!value){
          setScreen("registration");
        }
      }
    };
    try{
      unsubscribe=subscribeTerminalRegistration(applyRegistration,reason=>{
        console.error("受付端末登録状態の購読に失敗しました",reason);
        if(!navigator.onLine || (typeof reason==="object" && reason!==null && "code" in reason && reason.code==="permission-denied"))applyRegistration(null);
      });
    }catch(reason){
      console.error("受付端末登録状態の購読開始に失敗しました",reason);
      if(!navigator.onLine)applyRegistration(null);
    }
    const handleOffline=()=>applyRegistration(null);
    window.addEventListener("offline",handleOffline);
    return()=>{
      registrationActiveRef.current=false;
      ++registrationVersionRef.current;
      unsubscribe?.();
      window.removeEventListener("offline",handleOffline);
    };
  },[]);

  const requireApprovalForNewEvent=useCallback(async(eventId:string)=>{
    const registrationVersion=registrationVersionRef.current;
    const saved=await loadLocalEvent();
    if(!registrationIsCurrent(registrationVersion))return true;
    if(!saved?.dataReady||saved.event.eventId===eventId)return false;
    eventAuthenticationRequiredRef.current=true;
    const name=terminalRegistrationName.trim()||"受付端末";
    const pending=await requestReceptionEventReapproval(name);
    if(!pending)return false; // Management owners keep their management grant.
    registrationActiveRef.current=false;
    ++registrationVersionRef.current;
    pendingRemoteModeRef.current=null;
    await clearLocalEvent(); // Queue/history remain durable.
    setLocalEvent(null);
    setAuthPayload(null);
    setResult(null);
    setTerminalRegistration({approved:false,status:"pending",name});
    setScreen("registration");
    setError("イベントが切り替わりました。新しいイベントの受付申請を送信しました。管理者の承認をお待ちください。");
    return true;
  },[terminalRegistrationName]);

  const receiveEventByCommunication=useCallback(async()=>{
    if(busy||eventLoadingRef.current)return;
    if(!navigator.onLine){
      setError("通信で受信するにはインターネット接続が必要です。保存済みイベントがある場合はオフラインで利用できます。");
      return;
    }
    eventLoadingRef.current=true;
    const registrationVersion=registrationVersionRef.current;
    setBusy(true);
    setError("");
    try{
      const downloaded=await downloadCurrentFirebaseEventData(getTerminalId());
      if(!registrationIsCurrent(registrationVersion))return;
      if(!downloaded)throw new Error("NO_PUBLISHED_EVENT");
      if(await requireApprovalForNewEvent(downloaded.localEvent.event.eventId))return;
      if(!registrationIsCurrent(registrationVersion))return;
      const eventData:LocalEventData={
        ...downloaded.localEvent,
        ticketCount:downloaded.tickets.length,
        dataReady:false,
      };
      await prepareLocalEventData(eventData,downloaded.tickets);
      if(!registrationIsCurrent(registrationVersion))return;
      eventData.dataReady=true;
      eventAuthenticationRequiredRef.current=false;
      setLocalEvent(eventData);
      setAuthPayload({
        type:"qr-ticket-event-auth",
        eventId:eventData.event.eventId,
        eventName:eventData.event.eventName,
        dataVersion:eventData.event.dataVersion,
        authToken:downloaded.authPayload.authToken
      });
      setResult(null);
      setScreen("ready");
    }catch(reason){
      console.error("通信によるイベントデータ受信に失敗しました",reason);
      if(!registrationIsCurrent(registrationVersion))return;
      const code=reason instanceof Error?reason.message:"";
      if(code==="NO_PUBLISHED_EVENT"){
        setError("管理アプリで受付対象イベントを公開してください。");
      }else if(code==="MULTIPLE_PUBLISHED_EVENTS"){
        setError("受付対象の公開イベントが複数あります。管理アプリで1件にしてください。");
      }else{
        setError("通信でイベントデータを受信できませんでした。通信状態と管理アプリの公開設定を確認してください。");
      }
    }finally{
      eventLoadingRef.current=false;
      setBusy(false);
    }
  },[busy,requireApprovalForNewEvent]);

  useEffect(()=>{
    if(!terminalRegistration?.approved)return;

    let cancelled=false;
    const registrationVersion=registrationVersionRef.current;
    let cachedEvent:LocalEventData|null=null;

    const restoreCachedEvent=async()=>{
      const saved=await loadLocalEvent(true);
      if(!saved?.dataReady||saved.terminalId!==getTerminalId()||cancelled||!registrationIsCurrent(registrationVersion)||eventAuthenticationRequiredRef.current)return null;
      if(cancelled||!["auth","ready","registration"].includes(screenRef.current))return null;
      cachedEvent=saved;
      setLocalEvent(saved);
      setAuthPayload({
        type:"qr-ticket-event-auth",
        eventId:saved.event.eventId,
        eventName:saved.event.eventName,
        dataVersion:saved.event.dataVersion,
        authToken:"local"
      });
      setError("");
      setResult(null);
      setScreen("ready");
      return saved;
    };

    const loadCurrentFirebaseEvent=async()=>{
      if(eventLoadingRef.current||eventAuthenticationRequiredRef.current)return;
      if(!["auth","ready","reception","registration"].includes(screenRef.current))return;
      eventLoadingRef.current=true;
      try{
        // まず端末内の保存済みデータを復元する。Firebaseの応答を待たず受付準備画面を開ける。
        if(!cachedEvent && screenRef.current!=="reception"){
          try{
            await restoreCachedEvent();
          }catch(reason){
            console.error("端末内イベントデータの復元に失敗しました",reason);
            if(reason instanceof Error&&reason.message==="LOCAL_EVENT_INCOMPLETE"){
              if(!cancelled)setError("端末に保存されたイベントデータが不完全です。もう一度イベントデータを受信してください。");
            }
          }
        }
        if(cancelled||!registrationIsCurrent(registrationVersion)||!navigator.onLine)return;

        // Poll only the small publication document. Downloading every ticket on
        // every 10-second check could exhaust Firestore reads during reception.
        const payload=await getCurrentFirebaseEventAuthPayload();
        if(cancelled||!registrationIsCurrent(registrationVersion))return;

        const existing=await loadLocalEvent();
        if(cancelled||!registrationIsCurrent(registrationVersion))return;
        // Event authentication is reset without overwriting the approved terminal
        // or deleting its unsent records. A fresh event must be selected explicitly.
        if(existing?.dataReady && existing.event.eventId!==payload.eventId){
          if(await requireApprovalForNewEvent(payload.eventId))return;
          eventAuthenticationRequiredRef.current=true;
          cachedEvent=null;
          setLocalEvent(null);
          setAuthPayload(null);
          setResult(null);
          setError("イベントが切り替わりました。新しいイベントのデータを受信して認証してください。");
          setScreen("auth");
          return;
        }

        // 受付スキャン中は同一イベントの定期更新で画面を切り替えない。
        if(!["ready","auth","registration","reception"].includes(screenRef.current))return;

        if(
          existing?.dataReady &&
          existing.terminalId===getTerminalId() &&
          existing.event.eventId===payload.eventId &&
          existing.event.dataVersion===payload.dataVersion
        ){
          cachedEvent=existing;
          if(screenRef.current==="reception")return;
          setLocalEvent(existing);
          setAuthPayload({
            type:"qr-ticket-event-auth",
            eventId:existing.event.eventId,
            eventName:existing.event.eventName,
            dataVersion:existing.event.dataVersion,
            authToken:payload.authToken
          });
          setError("");
          setResult(null);
          setScreen("ready");
          return;
        }

        const downloaded=await downloadEventData(payload,getTerminalId());
        if(cancelled||!registrationIsCurrent(registrationVersion)||!["ready","auth","registration","reception"].includes(screenRef.current))return;
        const nextEvent:LocalEventData={
          ...downloaded.localEvent,
          ticketCount:downloaded.tickets.length,
          dataReady:false,
        };
        await prepareLocalEventData(nextEvent,downloaded.tickets);
        nextEvent.dataReady=true;
        if(cancelled||!registrationIsCurrent(registrationVersion))return;
        cachedEvent=nextEvent;
        setLocalEvent(nextEvent);
        setAuthPayload({
          type:"qr-ticket-event-auth",
          eventId:nextEvent.event.eventId,
          eventName:nextEvent.event.eventName,
          dataVersion:nextEvent.event.dataVersion,
          authToken:payload.authToken
        });
        setError("");
        if(screenRef.current!=="reception"){
          setResult(null);
          setScreen("ready");
        }
      }catch(reason){
        console.error("Firebaseから開催イベントデータを自動取得できませんでした",reason);
        if(cancelled)return;
        const code=reason instanceof Error?reason.message:"";
        if(code==="NO_PUBLISHED_EVENT"){
          // Keep the durable queue even after publication ends.
          eventAuthenticationRequiredRef.current=true;
          cachedEvent=null;
          setLocalEvent(null);
          setAuthPayload(null);
          setResult(null);
          setScreen("auth");
          setError("受付対象の公開イベントが見つかりません。管理アプリの公開設定を確認して、イベントデータを受信してください。");
        }else if(code==="MULTIPLE_PUBLISHED_EVENTS"){
          setError("受付対象の公開イベントが複数あります。管理アプリで受付対象を1件だけにしてください。");
        }else if(code==="INVALID_PUBLISHED_EVENT"){
          setError("公開イベントの情報が不足しています。管理アプリからイベントを再公開してください。");
        }else if(!cachedEvent){
          setError("Firebaseからイベントを取得できませんでした。通信状態・Firestoreルール・イベントデータを確認してください。");
        }
        // 通信失敗時は、正常に保存済みのイベントとチケットを端末内でそのまま使う。
      }finally{
        eventLoadingRef.current=false;
      }
    };

    void loadCurrentFirebaseEvent();
    const interval=window.setInterval(()=>void loadCurrentFirebaseEvent(),10000);
    const handleOnline=()=>void loadCurrentFirebaseEvent();
    window.addEventListener("online",handleOnline);
    return()=>{
      cancelled=true;
      window.clearInterval(interval);
      window.removeEventListener("online",handleOnline);
    };
  },[terminalRegistration?.approved,requireApprovalForNewEvent]);

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
    if(!result)return;
    if(result.kind==="error")void playReceptionAudio("error");
    const timer=window.setTimeout(()=>setResult(null),result.kind==="success"?1100:1800);
    return()=>window.clearTimeout(timer);
  },[result]);

  useEffect(()=>{
    if(!localEvent?.dataReady)return;
    let unsubscribe:(()=>void)|undefined;
    try{
      unsubscribe=subscribeTerminalControl(localEvent.terminalId,(remoteMode,updatedAt)=>{
        if(!updatedAt)return; // Initial desiredMode is not a management command.
        const command=JSON.stringify([localEvent.terminalId,remoteMode,updatedAt]);
        if(lastRemoteCommandRef.current===command)return;
        lastRemoteCommandRef.current=command;
        const manualChangedAt=localStorage.getItem(`qr-ticket-terminal-mode-changed:${localEvent.terminalId}`);
        if(updatedAt&&manualChangedAt&&new Date(updatedAt).getTime()<=new Date(manualChangedAt).getTime())return;
        const nextMode=remoteMode==="入口受付"?"entry":remoteMode==="出口受付"?"exit":mode;
        if(remoteMode==="停止"){
          pendingRemoteModeRef.current=null;
          receptionAllowedRef.current=false;
          setRemoteStopped(true);
          setResult({kind:"error",title:"受付が停止されています",detail:"管理画面から受付停止の指示を受けています。"});
          return;
        }
        setRemoteStopped(false);
        if(scanProcessingRef.current){pendingRemoteModeRef.current=nextMode;return;}
        setMode(nextMode);
        setResult(null);
      },reason=>console.error("端末リモート操作の購読に失敗しました",reason));
    }catch(reason){
      console.error("端末リモート操作の購読に失敗しました",reason);
    }
    const heartbeat=()=>void saveTerminalHeartbeat(localEvent.terminalId,remoteStopped||screen!=="reception"?"stopped":mode,undefined,localEvent.event.eventId).then(speed=>setNetworkMbps(speed)).catch(reason=>console.error("端末ハートビートに失敗しました",reason));
    heartbeat();
    const interval=window.setInterval(heartbeat,10000);
    return()=>{unsubscribe?.();window.clearInterval(interval);};
  },[localEvent?.dataReady,localEvent?.terminalId,mode,remoteStopped,screen]);

  const submitReceptionRegistration = async () => {
    if(busy)return;
    const name=terminalRegistrationName.trim();
    if(!name||name.length>80){
      setError("端末名を1〜80文字で入力してください。");
      return;
    }
    setBusy(true);
    setError("");
    try{
      await registerReceptionTerminal(name);
      // A manually resubmitted terminal must not restore its previous event
      // after approval and immediately request another approval for that event.
      await clearLocalEvent();
      setLocalEvent(null);
      setAuthPayload(null);
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
      const retainedId = await resetReceptionTerminalRegistration();
      if (retainedId) {
        localStorage.setItem("qr-ticket-terminal-id", retainedId);
        localStorage.setItem("qr-ticket-device-id", retainedId);
      } else {
        localStorage.removeItem("qr-ticket-terminal-id");
      }
      const nextId=getTerminalId();
      console.info("受付端末登録をリセットしました",nextId);
      setTerminalRegistration(null);
      setScreen("registration");
      if (retainedId) setError("未承認の申請を取り消しました。元の端末IDと管理権限を維持しています。受付アプリを再読み込みしてください。");
    } catch (reason) {
      console.error("受付端末登録のリセットに失敗しました", reason);
      setError(reason instanceof Error && reason.message === "RECEPTION_RELEASE_REQUIRES_MANAGEMENT_APPROVAL"
        ? "このブラウザーには承認済みの端末登録があります。再申請は不要です。受付アプリを再読み込みしてください。"
        : "登録申請をリセットできませんでした（" + (reason instanceof Error ? reason.message : String(reason)) + "）。");
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
    if(eventLoadingRef.current){setBusy(false);return;}
    eventLoadingRef.current=true;
    const registrationVersion=registrationVersionRef.current;
    try{
      const downloaded=await downloadEventData(authPayload,getTerminalId());
      if(!registrationIsCurrent(registrationVersion))return;
      if(await requireApprovalForNewEvent(downloaded.localEvent.event.eventId))return;
      if(!registrationIsCurrent(registrationVersion))return;
      const event:LocalEventData={...downloaded.localEvent,dataReady:false};
      await prepareLocalEventData(event,downloaded.tickets);
      if(!registrationIsCurrent(registrationVersion))return;
      event.dataReady=true;
      eventAuthenticationRequiredRef.current=false;
      setLocalEvent(event);
      setScreen("ready");
      setResult(null);
      setAuthCode("");
      setAuthCodeMode(false);
    }catch{
      if(!registrationIsCurrent(registrationVersion))return;
      setError("イベントデータを端末に保存できませんでした。");
      setScreen("confirm");
    }finally{eventLoadingRef.current=false;setBusy(false);}
  };

  const handleAuthCodeSubmit=async()=>{
    const token=authCode.trim();
    if(!token||busy)return;
    setBusy(true);
    setError("");
    const registrationVersion=registrationVersionRef.current;
    try{
      const payload=await getEventAuthPayloadByToken(token);
      if(!registrationIsCurrent(registrationVersion))return;
      if(!payload)throw new Error("EVENT_DATA_NOT_FOUND");
      setAuthPayload(payload);
      setAuthCodeMode(false);
      setScreen("confirm");
    }catch{
      if(!registrationIsCurrent(registrationVersion))return;
      setError("イベント連携コードが正しくないか、イベントデータが見つかりません。");
    }finally{setBusy(false);}
  };

  const handleTicketScan=useCallback(async(rawText:string)=>{
    if(!localEvent||busy||!receptionAllowedRef.current||scanProcessingRef.current)return;
    let ticketId=rawText.trim();
    let qrEventId:string|null=null;
    if(!ticketId)return;

    // 現行のチケットQRは { type, eventId, ticketId, ticketNumber } のJSON。
    // 生文字列のまま検索するとチケットIDと一致せず、毎回「チケットを確認できません」になる。
    // 旧形式のQRとの互換性を保つため、JSONでない値は従来どおりチケットIDとして扱う。
    try{
      const decoded:unknown=JSON.parse(ticketId);
      if(decoded&&typeof decoded==="object"&&!Array.isArray(decoded)){
        const payload=decoded as {type?:unknown;eventId?:unknown;ticketId?:unknown};
        if(payload.type==="qr-ticket"){
          if(typeof payload.ticketId!=="string"||!payload.ticketId.trim()){
            void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"unknown_ticket");
            setResult({kind:"error",title:"QRコードを確認できません",detail:"チケット情報が不足しています。"});
            return;
          }
          ticketId=payload.ticketId.trim();
          if(typeof payload.eventId==="string")qrEventId=payload.eventId;
        }
      }
    }catch{
      // 旧形式のチケットIDはJSONではないため、そのまま照合する。
    }

    scanProcessingRef.current=true;
    void playReceptionAudio("detected");
    setBusy(true);
    setResult(null);

    try{
      if(qrEventId&&qrEventId!==localEvent.event.eventId){
        void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"unknown_ticket");
        setResult({kind:"error",title:"別のイベントのチケットです",detail:"現在の受付イベントのチケットを読み取ってください。"});
        return;
      }
      const expectedLocalTicket=await getTicket(ticketId);
      let ticket=expectedLocalTicket;
      if(navigator.onLine){
        void syncPendingRecords();
        const pending=await getPendingSyncItems();
        let hasPending=false;
        for(const item of pending){
          const record=await getReceptionRecord(item.recordId);
          if(record?.eventId===localEvent.event.eventId && record.ticketId===ticketId){hasPending=true;break;}
        }
        if(!hasPending){
          try{ticket=await getLatestReceptionTicket(localEvent.event.eventId,ticketId);}
          catch(reason){
            const code=typeof reason==="object"&&reason!==null&&"code" in reason?reason.code:"";
            if(code!=="unavailable"&&code!=="deadline-exceeded")throw reason;
            // A temporary network outage may still use the downloaded inventory.
          }
        }
      }
      if(!receptionAllowedRef.current||eventAuthenticationRequiredRef.current)return;
      if(!ticket||ticket.eventId!==localEvent.event.eventId){
        void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"unknown_ticket");
        setResult({kind:"error",title:"チケットを確認できません",detail:"このチケットは確認できません。"});
        return;
      }
      if(!ticket.valid){
        void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"invalid_ticket");
        setResult({kind:"error",title:"このチケットは無効です",detail:"管理アプリで無効になっているチケットです。"});
        return;
      }

      const receptionType=getReceptionType(mode,ticket.currentStatus,localEvent.settings);
      if(!receptionType){
        const detail=mode==="entry"
          ?ticket.currentStatus==="inside"?"このチケットはすでに入場しています。":"このチケットは受付できません。"
          :ticket.currentStatus==="unused"?"このチケットはまだ入場していません。":"このチケットは受付できません。";
        void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"invalid_state");
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

      await saveReceptionTransaction(updatedTicket,record,expectedLocalTicket);
      void syncPendingRecords();
      setResult({
        kind:"success",
        title:receptionType==="entry"?"入場を確認しました":receptionType==="reentry"?"再入場を確認しました":"退場を確認しました",
        detail:ticketId
      });
      speakReception(receptionType);
      playSuccessSound();
    }catch(reason){
      console.error("受付処理に失敗しました",reason);
      void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"save_failed");
      setResult({
        kind:"error",
        title:"受付データを保存できませんでした",
        detail:"受付を確定できていないため、もう一度読み取ってください。"
      });
    }finally{
      scanProcessingRef.current=false;
      setBusy(false);
      const nextMode=pendingRemoteModeRef.current;
      pendingRemoteModeRef.current=null;
      if(nextMode && registrationActiveRef.current && !eventAuthenticationRequiredRef.current){setMode(nextMode);setResult(null);}
      // カメラは連続稼働するため、受付のたびに再生成しない。
    }
  },[localEvent,mode,busy,remoteStopped,syncPendingRecords]);

  const switchMode=()=>{
    if(remoteStopped||scanProcessingRef.current)return;
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
                  <button type="button" className="primary" disabled={busy||!online} onClick={()=>void receiveEventByCommunication()}>{busy?"イベントデータ受信中…":"通信でイベントデータを受信"}</button>
                  <button type="button" className="secondary" onClick={()=>{setError("");setAuthCodeMode(current=>!current);}}>{authCodeMode?"QRで連携する":"コードで連携する"}</button>
                  <button type="button" className="secondary" onClick={()=>void checkReceptionSound()}>音の確認</button>{audioNotice&&<p className="entry-result-secondary" role="status">{audioNotice}</p>}
                  <button type="button" className="secondary" onClick={()=>{setError("");setTestResultKind(mode==="entry"?"entry":"exit");setScreen("test");speakReception(mode==="entry"?"entry":"exit");playSuccessSound();}}>受付結果を試験表示</button>
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
            <p className="entry-result-secondary">次のQRは続けて読み取れます</p>
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
            <button type="button" className="secondary" onClick={()=>void checkReceptionSound()}>音の確認</button>{audioNotice&&<p className="entry-result-secondary" role="status">{audioNotice}</p>}
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("entry");speakReception("entry");void playSuccessSound();}}>入口結果</button>
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("exit");speakReception("exit");void playSuccessSound();}}>出口結果</button>
            <button type="button" className="secondary" onClick={()=>{setTestResultKind("error");void playReceptionAudio("error");window.speechSynthesis?.cancel();}}>エラー結果</button>
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
                <button type="button" className="secondary" onClick={()=>void checkReceptionSound()}>音の確認</button>{audioNotice&&<p className="entry-result-secondary" role="status">{audioNotice}</p>}
                <button type="button" className="primary" onClick={()=>{setResult(null);setCameraFailed(false);setScreen("reception");setScannerKey(value=>value+1);}}>受付を開始する</button>
                <button type="button" className="secondary" onClick={()=>{setTestResultKind(mode==="entry"?"entry":"exit");speakReception(mode==="entry"?"entry":"exit");void playSuccessSound();setScreen("test");}}>受付結果を試験表示</button>
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
          {pendingSyncCount>0&&<span role="status" className="connection-status">未同期 {pendingSyncCount}件（端末内保存済み）</span>}
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
      <section className={result ? "entry-waiting-panel entry-waiting-panel-background" : "entry-waiting-panel"}>
          <div className="entry-scanner-card">
            <div className="entry-scanner-card-header">
              <div className="entry-scanner-heading">
                <span className="entry-scanner-heading-icon"><QrIcon size={30}/></span>
                <span className="entry-scanner-heading-copy">
                  <small>QR SCANNER</small>
                  <strong>QRコード読み取り</strong>
                </span>
              </div>
              <button type="button" className="secondary" disabled={busy} onClick={()=>{if(scanProcessingRef.current)return;receptionAllowedRef.current=false;setResult(null);setScreen("ready");void syncPendingRecords();}}>受付を停止</button>
            </div>
            <div className="entry-scanner-wrapper">
              <div className="camera-qr-scanner">
                {remoteStopped ? <div className="reception-start-content"><div className="entry-result-icon">×</div><h2>受付停止中</h2><p className="entry-result-primary">管理画面から受付停止の指示を受けています</p><p className="entry-result-secondary">管理画面から入口・出口受付へ戻すと再開します</p></div> : <QrScanner
                  key={scannerKey}
                  readerId="ticket-reader"
                  onResult={handleTicketScan}
                  onError={message=>{
                    setCameraFailed(true);
                    setResult({kind:"error",title:"カメラを起動できません",detail:message});
                    if(localEvent?.event.eventId)void logReceptionError(localEvent.event.eventId,localEvent.terminalId,mode,"camera_failed");
                  }}
                />}
                {cameraFailed&&!remoteStopped&&<button type="button" className="secondary" onClick={()=>{setCameraFailed(false);setResult(null);setScannerKey(current=>current+1);}}>カメラを再起動</button>}
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
            <p className={entry ? "entry-result-secondary" : "exit-result-secondary"}>次のQRは続けて読み取れます</p>
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

let speechVersion=0;
function speakReception(type:ReceptionType){
  if(!("speechSynthesis" in window))return;

  const synth=window.speechSynthesis;
  synth.cancel();
  const version=++speechVersion;
  const preferences=getReceptionAudioSettings();
  if(!preferences.voiceGuidance||preferences.volume===0)return;
  let spoken=false;

  const message=type==="exit"
    ?"ご来場ありがとうございました。"
    :"ご来場ありがとうございます。";

  const utterance=new SpeechSynthesisUtterance(message);
  utterance.lang="ja-JP";
  utterance.rate=0.9;
  utterance.pitch=0.96;
  utterance.volume=preferences.volume;

  const speakWithJapaneseVoice=()=>{
    if(spoken||version!==speechVersion)return;
    spoken=true;
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
      speakWithJapaneseVoice();
    },500);
  }
}

function playSuccessSound(){void playReceptionAudio("success");}
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
