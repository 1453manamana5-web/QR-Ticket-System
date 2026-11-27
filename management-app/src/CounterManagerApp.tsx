import {previousOperation} from "./luxnora/adapt";
import type {Plan} from "./luxnora/language";
import {LuxnoraPanel} from "./luxnora/LuxnoraPanel";
import {diagnose,type Target} from "./luxnora/assistant";
import {forecast,type Forecast} from "./luxnora/forecast";
import {useEffect, useMemo, useRef, useState, type FormEvent} from "react";
import {bounded, counterEvents, permissionDenied, verifyManager, watchCounterAuth, type CounterEvent, type CounterManager} from "./counterAuth";
import {
  addCounterPassage, analyze, csv, pauseCounterEvent, reviseCounterPassage, saveCounterConfig, saveCounterStation,
  subscribeCounterEvent, type CounterConfig, type CounterMode, type CounterOperation, type CounterSnapshot, type CounterStation,
} from "./counterManagementData";
import {createCounterSeries,editCounterSchedule,listCounterSeries,operateCounterDay,watchCounterDay,type SeriesAndDays} from "./counterEvents";
import {stageLabels,type Day} from "./counterLifecycle";
import {CounterDayPanel,CounterScheduleEditor,NewCounterEvent,type EventDraft,type LuxnoraEventProvider} from "./CounterEventPanels";
import {CounterComparison} from "./CounterComparison";
import {CounterRestorePanel} from "./CounterRestorePanel";
import {CounterPairPanel,CounterRemotePanel} from "./CounterStationCommands";
import {CounterAnalysisTools} from "./CounterAnalysisTools";
import type {EffectiveCounterPassage} from "../../reception-app/public/people-counter/ledger.mjs";

const base = import.meta.env.BASE_URL;
const stamp = (at?: number | null) => typeof at === "number" && Number.isFinite(at)
  ? new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}).format(at) : "—";
const hour = (at: number) => new Intl.DateTimeFormat("ja-JP",{timeZone:"Asia/Tokyo",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(at);
const localInput = (at: number) => new Date(at + 32400000).toISOString().slice(0,16);
const parsedInput = (value: FormDataEntryValue | null) => value ? Date.parse(String(value) + ":00+09:00") : null;
const failure = (part:CounterSnapshot<unknown>) => /permission-denied|unauthenticated/.test(part.errorCode ?? '');
const count = (value: number) => value.toLocaleString("ja-JP");
const freshMs = 180000;
const modeTitle = {live:"本番",test:"試験"};
const roleTitle = {in:"入口",out:"出口"};
const statusTitle = {pending:"承認待ち",approved:"承認済み",rejected:"拒否",revoked:"解除済み"};
const alertTitle: Record<string,string> = {paused:"停止指示あり",setup:"設置設定を確認",recalibrate:"再キャリブレーション",camera:"カメラ要確認",storage:"保存エラー",network:"通信要確認"};
const modeLabels: Record<string,string> = {baseline:"無補正",detail:"細部優先",lighting:"暗部補助",unknown:"未確認"};
const pages = {home:"ホーム",analysis:"来場者分析",stations:"受付端末",records:"通過記録",event:"イベント管理",settings:"設定"} as const;
type Page = keyof typeof pages;
type AuthState = {kind:"loading"|"ready"|"stale"|"denied"|"error"; manager?:CounterManager; message?:string};
type DataState = {config:CounterSnapshot<CounterConfig|null>; stations:CounterSnapshot<CounterStation[]>; operations:CounterSnapshot<CounterOperation[]>};
const initialData = (): DataState => ({config:{data:null,source:"pending"},stations:{data:[],source:"pending"},operations:{data:[],source:"pending"}});

function useManager(locked: boolean) {
  const [state,setState] = useState<AuthState>({kind:"loading"});
  const [request,refresh] = useState(0);
  useEffect(() => {
    if (locked) return;
    let active = true, version = 0, loading = false, currentUid: string|null|undefined;
    let unsubscribe: (() => void)|undefined;
    const verify = (force = false) => {
      if (loading && !force) return;
      loading = true;
      const generation = ++version;
      void bounded(verifyManager()).then(manager => {
        if (active && generation === version) setState({kind:"ready",manager});
      }).catch(error => {
        if (active && generation === version) setState(previous =>
          permissionDenied(error) ? {kind:"denied"} :
            previous.manager ? {kind:"stale",manager:previous.manager,message:"管理端末の権限を現在確認できません。"} :
              {kind:"error",message:"サーバーとの接続を確認してから再試行してください。"});
      }).finally(() => {if (generation === version) loading = false;});
    };
    void watchCounterAuth(uid => {
      if (!active || currentUid === uid) return;
      currentUid = uid;
      setState({kind:"loading"});
      verify(true);
    }).then(stop => {if (active) unsubscribe = stop; else stop();}).catch(() => {});
    verify();
    const update = () => verify();
    const offline = () => setState(prev => prev.manager ? {kind:"stale",manager:prev.manager} : prev);
    const interval = setInterval(update,45000);
    window.addEventListener("focus",update);
    window.addEventListener("online",update);
    window.addEventListener("offline",offline);
    return () => {
      active = false; unsubscribe?.(); clearInterval(interval);
      window.removeEventListener("focus",update);
      window.removeEventListener("online",update);
      window.removeEventListener("offline",offline);
    };
  },[locked,request]);
  return {state,retry:() => refresh(n => n + 1),clear:() => setState({kind:"loading"})};
}

export function CounterManagerApp({suggest}: {suggest?:LuxnoraEventProvider} = {}) {
  const [locked,setLocked] = useState(() => {try {return sessionStorage.getItem("counter-manager-lock") === "1";} catch {return false;}});
  const {state,retry,clear} = useManager(locked);
  function lock(value: boolean) {
    clear(); setLocked(value);
    try {sessionStorage.setItem("counter-manager-lock",value ? "1" : "0");} catch { /* browser-only lock */ }
  }
  if (!locked && state.manager) return <Dashboard key={state.manager.uid} manager={state.manager} authReady={state.kind === "ready"} suggest={suggest} recheck={retry} lock={() => lock(true)} />;
  return <div className="cm-gate-layout">
    <main className="cm-gate">
      <div className="cm-brand-mark" aria-hidden="true"><i/><i/><i/></div>
      <p className="cm-tenant">交通研究部 · 文化祭</p>
      <h1>人数カウント管理</h1>
      <p className="cm-gate-copy">入退場の集計と、入口・出口に設置する端末を管理します。</p>
      {locked ? <div className="cm-gate-state"><strong>管理画面はロックされています</strong><p>再接続時にこの端末の権限を確認します。</p><button className="cm-primary" onClick={() => lock(false)}>管理画面を開く</button></div>
      : state.kind === "loading" ? <div className="cm-gate-state" role="status"><strong>管理端末の権限を確認しています</strong><p>初回はインターネット接続が必要です。</p></div>
      : <div className="cm-gate-state" role="status"><strong>{state.kind === "denied" ? "この端末に管理権限がありません" : "サーバーに接続できません"}</strong>
        <p>{state.kind === "denied" ? "QR受付管理で承認済みの管理者または副管理者の端末で開いてください。" : state.message}</p>
        <button className="cm-primary" onClick={() => {clear();retry();}}>接続を再確認</button></div>}
      <div className="cm-gate-links"><a href={base + "management-app/"}>QR受付管理</a><a href={base + "people-counter/"}>計測端末を開く</a></div>
    </main>
  </div>;
}

function Dashboard({manager,authReady,recheck,lock,suggest}: {manager:CounterManager;authReady:boolean;recheck:()=>void;lock:()=>void;suggest?:LuxnoraEventProvider}) {
  const [page,setPage] = useState<Page>("home");
  const [mode,setMode] = useState<CounterMode>("live");
  const [eventId,setEventId] = useState("");
  const [events,setEvents] = useState<CounterEvent[]|null>(null);
  const [eventsError,setEventsError] = useState("");
  const [catalog,setCatalog] = useState<SeriesAndDays|null>(null);
  const [catalogError,setCatalogError] = useState("");
  const [create,setCreate] = useState(false);
  const [createBusy,setCreateBusy] = useState(false);
  const [search,setSearch] = useState("");
  const eventMenu=useRef<HTMLDetailsElement>(null);
  const creating=useRef(false);
  const [activeDay,setActiveDay] = useState<{id:string;row:Day|null;verified:boolean}|null>(null);
  const [snapshot,setSnapshot] = useState<{key:string;value:DataState} | null>(null);
  const [now,setNow] = useState(Date.now);
  const [notice,setNotice] = useState("");
  const [working,setWorking] = useState(false);
  const [revision,setRevision] = useState(0);
  const scope = eventId + "/" + mode;
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const submitting = useRef(false);
  const admin = manager.role === "admin";
  const day = activeDay?.id===eventId ? activeDay.row : catalog?.days.find(item=>item.id===eventId);
  const event = events?.find(item => item.id === eventId);
  const series = catalog?.series.find(item=>item.id===day?.eventId);
  const eventName = series?.name ?? event?.name ?? "イベントを選ぶ";
  const data = snapshot?.key === scope ? snapshot.value : null;
  const fetchEvents = () => setRevision(n => n + 1);

  useEffect(() => {
    if (!authReady) return;
    let current = true;
    setEventsError("");
    void bounded(counterEvents()).then(items => {
      if (!current) return;
      setEvents(items);
      setEventId(prior => prior || items[0]?.id || "");
    }).catch(error => {if (current) setEventsError(permissionDenied(error) ? "イベントを閲覧する権限がありません。" : "イベント一覧を取得できませんでした。");});
    return () => {current = false;};
  },[manager.uid,authReady,revision]);

  useEffect(() => {
    if (!authReady) return;
    let current=true;
    setCatalogError("");
    void bounded(listCounterSeries()).then(next=>{
      if (!current) return;
      setCatalog(next);
      setEventId(prior=>prior || [...next.days].sort((a,b)=>b.date.localeCompare(a.date))[0]?.id || "");
    }).catch(()=>{if(current)setCatalogError("人数カウントのイベント一覧を取得できませんでした。");});
    return ()=>{current=false;};
  },[authReady,revision,manager.uid]);

  const nativeDay = !!catalog?.days.some(item=>item.id===eventId);
  useEffect(()=>{
    if (!nativeDay) return;
    return watchCounterDay(eventId,(row,verified)=>{
      if (verified) setActiveDay({id:eventId,row,verified});
      else setActiveDay(prior=>prior?.id===eventId ? {...prior,verified:false} : null);
    },()=>setActiveDay(prior=>prior?.id===eventId ? {...prior,verified:false}:null));
  },[eventId,nativeDay]);

  useEffect(() => {
    if (!eventId) return;
    let current = true;
    const setPart = <K extends keyof DataState>(part: K) => (value:DataState[K]) => {
      if (!current) return;
      setSnapshot(previous => ({key:scope,value:{...(previous?.key === scope ? previous.value : initialData()),[part]:value}}));
    };
    const stop = subscribeCounterEvent(eventId,mode,{config:setPart("config"),stations:setPart("stations"),operations:setPart("operations")});
    return () => {current = false;stop();};
  },[scope,eventId,mode,manager.uid,revision]);

  useEffect(() => {const id = setInterval(() => setNow(Date.now()),10000);return () => clearInterval(id);},[]);

  const denied = !!data && Object.values(data).some(failure);
  const ready = authReady && !denied && !!data && Object.values(data).every(part => part.source === "server");
  const config = denied ? null : data?.config.data ?? null;
  const operations = denied ? undefined : data?.operations.data;
  const stations = denied ? [] : data?.stations.data ?? [];
  const scopeStations = stations.filter(station => station.status === "approved" && station.mode === mode);
  const stationsCurrent = (["in","out"] as const).every(role => scopeStations.some(station =>
     station.role === role && station.lastSeen !== undefined && now - station.lastSeen <= freshMs)) &&
     stations.filter(station => station.status === "approved").every(station =>
       station.lastSeen !== undefined && now - station.lastSeen <= freshMs);
  const pending = scopeStations.reduce((sum,station) => sum + (station.pending ?? 0),0);
  const invalidRows = (data?.operations.invalid ?? 0) + (data?.config.invalid ?? 0) + (data?.stations.invalid ?? 0);
  const sealed = ready && !invalidRows && pending === 0 && config?.verified === true && config.closed != null &&
    (["in","out"] as const).every(role => scopeStations.some(station => station.role === role)) &&
    scopeStations.every(station => (station.lastSeen ?? 0) >= config.closed!);
  const analysisTime = config?.closed == null ? now : Math.min(now,config.closed);
  const analysis = useMemo(() => config?.opened != null && operations
    ? analyze(operations,{eventId,mode,opened:config.opened,closed:config.closed,now:analysisTime,verified:sealed}) : null,
    [operations,config,eventId,mode,analysisTime,sealed]);
  const current = ready&&!invalidRows&&stationsCurrent&&pending===0;
  const prediction=useMemo(()=>analysis&&config?.opened!=null?forecast({
    now,opened:config.opened,
    ends:day?Date.parse(day.date+"T"+day.end+":00+09:00"):undefined,
    healthy:current&&mode==="live"&&config.closed==null&&!config.paused&&(!day||["open","restricted"].includes(day.stage))&&
      !analysis.issues.length&&scopeStations.every(station=>station.camera===true&&station.ai===true&&station.alert==="none"&&station.pending===0),
    total:analysis.entries,occupancy:analysis.occupancy,events:analysis.effective,
  }):[],[analysis,config,day,current,mode,now,scopeStations]);
  const [focusRequest,setFocusRequest]=useState<{target:Target;stamp:number;plan?:Plan}|null>(null);
  useEffect(()=>{
    if(!focusRequest) return;
    const targetId=focusRequest.target==="graph"&&focusRequest.plan?.period!==undefined?"range":focusRequest.target;
    const target=document.querySelector<HTMLElement>('[data-lux-focus="'+targetId+'"]');
    if(!target) return;
    target.classList.add("lux-highlight");
    target.scrollIntoView({block:"center",behavior:window.matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
    const reduced=window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const trigger=document.querySelector(".lux-trigger");
    const ray=!reduced&&trigger?document.createElement("span"):null;
    if(ray&&trigger) {
      const origin=trigger.getBoundingClientRect(), destination=target.getBoundingClientRect();
      const x=origin.left+origin.width/2,y=origin.top+origin.height/2;
      const dx=Math.min(innerWidth-8,Math.max(8,destination.right))-x;
      const dy=Math.min(innerHeight-8,Math.max(8,destination.top+16))-y;
      ray.className="lux-focus-ray";
      ray.style.setProperty("--ray-angle",Math.atan2(dy,dx)+"rad");
      Object.assign(ray.style,{left:x+"px",top:y+"px",width:Math.hypot(dx,dy)+"px"});
      ray.setAttribute("aria-hidden","true");
      document.body.append(ray);
    }
    const timer=setTimeout(()=>{target.classList.remove("lux-highlight");ray?.remove();},2400);
    return ()=>{clearTimeout(timer);target.classList.remove("lux-highlight");ray?.remove();};
  },[focusRequest,page]);
  const luxFocus=(target:Target,plan?:Plan)=>{
    if(!eventId||denied||create) return;
    if(target==="compare"||target==="graph") setPage("analysis");
    else if(target==="in"||target==="out"||target==="stations") setPage("stations");
    else setPage(target);
    setFocusRequest({target,plan,stamp:Date.now()});
  };
  const lastUpdate = denied ? undefined : data?.operations.lastChangeAt;

  async function perform(task: () => Promise<unknown>, success: string) {
    if (!ready || submitting.current) return;
    const current = scope;
    submitting.current = true;
    setWorking(true);setNotice("");
    try {
      await bounded(task());
      if (activeScope.current === current) setNotice(success);
    } catch(error) {
      if (activeScope.current === current) setNotice(permissionDenied(error)
        ? "権限が変更されたか、他の端末で先に更新されました。再確認してください。"
        : error instanceof Error && !("code" in error) ? error.message
        : "更新を確認できませんでした。表示を確認してから再試行してください。");
      if (permissionDenied(error)) recheck();
    } finally {submitting.current=false;setWorking(false);}
  }
  const choose = (next:string,nextMode=mode) => {
    setFocusRequest(null);setNotice("");setEventId(next);setMode(nextMode);
    if (eventMenu.current) eventMenu.current.open=false;
  };
  const navigate = (next:Page) => {setFocusRequest(null);setPage(next);setNotice("");};
  async function saveNew(draft:EventDraft) {
    if (!authReady || creating.current) return false;
    creating.current=true;setCreateBusy(true);setNotice("");
    try {
      const dayId=await createCounterSeries(draft);
      setEventId(dayId);setMode("live");setPage("event");setCreate(false);
      setNotice("イベントを作成しました。開催準備を確認してください。");fetchEvents();
      return true;
    } catch(error) {
      setNotice(error instanceof Error ? error.message : "イベントを保存できませんでした。");
      return false;
    } finally {creating.current=false;setCreateBusy(false);}
  }
  const eventSuggestions:LuxnoraEventProvider=async draft=>previousOperation(catalog,draft);
  const pendingRequests = stations.filter(row => row.status === "pending").length;
  const updating = Object.values(data ?? initialData()).some(part => part.source === "pending");
  const status = denied ? "権限を再確認中" : ready ? "接続済み" : updating ? "同期を確認中" : "現在の同期を確認できません";

  return <div className="cm-shell">
    <a className="cm-skip" href="#cm-content">内容へ移動</a>
    <div className="cm-main">
      <header className="cm-bar"><div className="cm-brand"><div className="cm-brand-mark" aria-hidden="true"><i/><i/><i/></div><b>人数カウント管理</b></div>
        <div><span className={"cm-health"+(ready ? " is-ready":"")}>{status}</span><button onClick={lock}>ロック</button></div></header>
      <main id="cm-content" tabIndex={-1}>
        <div className="cm-title"><div>
          <details className="cm-picker" ref={eventMenu}><summary>{eventName}</summary>
            <div className="cm-picker-menu">
              <label>イベントを検索<input type="search" value={search} onChange={e=>setSearch(e.target.value)}/></label>
              <button className="cm-primary" disabled={!authReady} onClick={()=>{setCreate(true);if(eventMenu.current)eventMenu.current.open=false;}}>新規作成</button>
              {catalog?.series.filter(item=>(item.name+" "+item.venue).includes(search.trim())).map(item=><div className="cm-event-option" key={item.id}>
                <strong>{item.name}</strong><p>{item.venue}</p>
                {catalog.days.filter(row=>row.eventId===item.id).sort((a,b)=>a.date.localeCompare(b.date)).map(row=><button
                  key={row.id} aria-current={eventId===row.id?"true":undefined} onClick={()=>{choose(row.id,"live");navigate("home");}}>
                  {row.date}　{stageLabels[row.id===day?.id ? day.stage : row.stage]}
                </button>)}
              </div>)}
              {events?.filter(item=>(item.name+" "+item.date).includes(search.trim())).map(item=><div className="cm-event-option" key={item.id}>
                <button aria-current={eventId===item.id?"true":undefined} onClick={()=>{choose(item.id,"live");navigate("home");}}>
                  {item.name}　{item.date} <small>従来のイベント</small>
                </button>
              </div>)}
            </div>
          </details>
          {series&&<p className="cm-venue">{series.venue} · {day?.date}</p>}
          <h1>{pages[page]}</h1>
        </div>
          <div className="cm-selectors">
            {eventId&&<label>表示する集計<select value={mode} onChange={e => choose(eventId,e.target.value as CounterMode)}><option value="live">本番</option><option value="test">試験</option></select></label>}
          </div>
        </div>
        <nav aria-label="管理メニュー" className="cm-nav">{Object.entries(pages).map(([id,title]) =>
          <button key={id} className={page===id?"is-current":""} aria-current={page===id?"page":undefined} onClick={()=>navigate(id as Page)}>
            {title}{id==="stations"&&pendingRequests>0&&<small>{pendingRequests}</small>}
          </button>)}</nav>
        {catalogError&&<p role="alert" className="cm-warning">{catalogError} <button onClick={fetchEvents}>再試行</button></p>}
        {eventsError && <p role="alert" className="cm-warning">{eventsError} <button onClick={fetchEvents}>再試行</button></p>}
        {notice && <p role="status" className="cm-notice">{notice}</p>}
        {!authReady && <p className="cm-warning" role="status">管理端末の権限を現在確認できません。表示済みの情報は古い可能性があります。 <button onClick={recheck}>再確認</button></p>}
        {create ? <NewCounterEvent owner={manager.uid} busy={createBusy} onSave={saveNew} onClose={()=>setCreate(false)} provider={suggest??eventSuggestions}/>
        : page === "settings" ? <section className="cm-section"><h2>この管理端末</h2><dl className="cm-definition"><dt>名称</dt><dd>{manager.name}</dd><dt>権限</dt><dd>{admin ? "管理者" : "副管理者"}</dd><dt>承認先</dt><dd>QR受付の管理端末認証</dd></dl>
          <p>管理者・副管理者の登録と権限変更は、既存の管理端末設定で行います。</p><a href={base+"management-app/"}>QR受付管理を開く ↗</a></section>
        : !eventId ? <p className="cm-empty">{events?.length === 0 && catalog?.days.length === 0 ? "イベント名のメニューから新規作成できます。" : "イベントを読み込んでいます。"}</p>
        : denied ? <p className="cm-warning" role="alert">人数カウントの閲覧権限をサーバーで確認できません。 <button onClick={() => {recheck();fetchEvents();}}>再確認</button></p>
        : <>
          {mode === "test" && <p className="cm-test">試験運用　ここで表示・修正した内容は本番集計に含まれません。</p>}
          {(data?.operations.source === "error" || data?.config.source === "error" || data?.stations.source === "error") &&
            <p className="cm-warning" role="status">イベントの一部を取得できませんでした。 <button onClick={fetchEvents}>再試行</button></p>}
          {invalidRows > 0 && <p className="cm-warning" role="status">読み取れないデータが {invalidRows}件あります。集計を確認してください。</p>}
          {(page === "home" || page === "analysis") && <Home day={day??undefined} navigate={navigate} detailed={page==="analysis"} analysis={analysis} config={config} stations={stations} mode={mode} now={now}
            lastUpdate={lastUpdate} prediction={prediction} current={current} waiting={updating} />}
          {page==="analysis"&&analysis&&operations&&config?.opened!=null&&<CounterAnalysisTools key={scope}
            luxPeriod={focusRequest?.target==="graph"?focusRequest.plan?.period:undefined} luxStamp={focusRequest?.stamp}
            report={analysis} rows={operations} from={config.opened} to={config.closed??now} mode={mode} scope={eventId}
            name={eventName} venue={series?.venue} current={ready&&!invalidRows&&stationsCurrent&&pending===0}/>}
          {page==="analysis"&&catalog&&<div data-lux-focus="compare"><CounterComparison key={day?.eventId??"catalog"} catalog={catalog} initialSeriesId={day?.eventId} initialView={focusRequest?.target==="compare"?"year":undefined}/></div>}
          {page==="stations"&&nativeDay&&<CounterPairPanel key={eventId} day={eventId} enabled={ready&&!working}/>}
          {page === "stations" && <StationList stations={stations} mode={mode} now={now} admin={admin} dedicated={nativeDay} enabled={ready&&!working}
            loading={data?.stations.source === "pending" || !data} perform={perform} eventId={eventId} version={day?.version} />}
          {page === "records" && <div data-lux-focus="records"><Records key={scope} eventId={eventId} mode={mode} rows={operations ?? []} enabled={ready&&!working}
            loading={data?.operations.source==="pending" || !data} perform={perform} now={now} /></div>}
          {page==="records"&&admin&&config?.verified&&<section className="cm-section">
            <h2>確定済みの集計を再確認</h2>
            <p>JSONからの復元前に、集計を確認待ちへ戻してください。開催日と計測端末は閉場したままです。</p>
            <button disabled={!ready||working||nativeDay&&(activeDay?.id!==eventId||!activeDay.verified)} onClick={()=>{
              if (!window.confirm("この日の集計を確認待ちに戻しますか？ 復元後に記録を確認し、再度確定できます。")) return;
              void perform(()=>nativeDay&&day
                ? operateCounterDay(day.id,day.version,"unverify",{empty:false,synced:false})
                : saveCounterConfig(eventId,mode,{...config,verified:false},config),"集計を確認待ちに戻しました。");
            }}>集計確定を取り消す</button>
          </section>}
          {page==="records"&&admin&&<CounterRestorePanel key={scope} scope={eventId} mode={mode} name={eventName}
            config={config} rows={operations??[]} enabled={ready&&!working}/>}
          {page==="event"&&series&&day&&<CounterScheduleEditor key={day.id+"/"+series.name+"/"+series.venue+"/"+day.start+"/"+day.end}
            suggestion={focusRequest?.plan?.schedule} suggestionId={focusRequest?.stamp}
            series={series} day={day} enabled={ready&&!working&&activeDay?.id===eventId&&activeDay.verified}
            onSave={fields=>{void perform(async()=>{await editCounterSchedule(series,day,fields);fetchEvents();},"イベント情報を保存しました。");}}/>}
          {page === "event" && <div data-lux-focus="event">{nativeDay && day ? <CounterDayPanel key={day.id+"/"+day.version} day={day} now={now}
            proposal={focusRequest?.plan?.operation} proposalId={focusRequest?.stamp}
            canOperate={ready&&!working&&activeDay?.id===eventId&&activeDay.verified} stations={stations}
            synced={mode==="live"&&ready&&!invalidRows&&pending===0&&analysis?.occupancy===0&&analysis.issues.length===0&&
              (["in","out"] as const).every(role=>scopeStations.some(station=>station.role===role))&&
              scopeStations.every(station=>station.pending===0&&(station.lastSeen??0)>=(day.ended??Infinity))}
            goStations={()=>navigate("stations")} openTest={()=>{choose(eventId,"test");navigate("analysis");}}
            onAction={(command,review)=>{setFocusRequest(null);void perform(()=>operateCounterDay(day.id,day.version,command,review),
              "操作を保存しました。端末の通信状況を確認してください。");}}
          /> : <EventControls key={scope+"/"+data?.config.serverAt} eventId={eventId} mode={mode} config={config}
            enabled={ready&&!working&&!nativeDay} admin={admin} perform={perform} />}</div>}
        </>}
      </main>
    </div>
    {!denied&&<LuxnoraPanel key={scope} evidence={{name:eventName,mode,now,config,day,stations,analysis,prediction,current}} focus={luxFocus} cancel={()=>setFocusRequest(null)}/>}
  </div>;
}
type Analysis = ReturnType<typeof analyze>;
type Mutation = (task:()=>Promise<unknown>,success:string)=>Promise<void>;

function Home({analysis,config,stations,mode,now,lastUpdate,current,waiting,day,navigate,detailed,prediction}: {
  analysis:Analysis|null; config:CounterConfig|null;stations:CounterStation[];mode:CounterMode;now:number;lastUpdate?:number;current:boolean;waiting:boolean;day?:Day;navigate:(page:Page)=>void;detailed:boolean;prediction:Forecast;
}) {
  const peak = analysis?.timeline.reduce<{at:number;occupancy:number} | null>((max,row) => row.occupancy > (max?.occupancy ?? 0) ? row : max,null);
  const average = analysis?.sumAverage ?? (current ? analysis?.estimate : null);
  const hasCount = !!analysis;
  const open = config?.opened;
  const lifecycle = day ? stageLabels[day.stage] : config?.closed != null ? "閉場" : open == null ? "開場時刻未設定" : open > now ? "開場前" : config?.paused ? "受付停止中" : "開場中";
  return <>
    <div className="cm-event-strip"><button className="cm-status-action" onClick={()=>navigate("event")}>{lifecycle} <span aria-hidden="true">⌄</span></button><span>{modeTitle[mode]}集計</span><span>記録の最終更新 {stamp(lastUpdate)}</span></div>
    {!current && <p className="cm-warning" role="status">{waiting ? "人数と端末の状況を取得しています。" : "未同期または通信を確認できない端末があります。表示人数は最新とは限りません。"}</p>}
    {open == null && !waiting && <p className="cm-empty">イベント管理で開場時刻を設定すると集計を表示します。</p>}
    <dl className="cm-metrics">
      <Metric title="累計入場" value={hasCount ? count(analysis.entries) : "—"} unit={hasCount ? "回" : ""} detail="再入場を含む"/>
      <Metric title="累計退場" value={hasCount ? count(analysis.exits) : "—"} unit={hasCount ? "回" : ""}/>
      <Metric title="現在の滞在" value={hasCount ? count(analysis.occupancy) : "—"} unit={hasCount ? "人" : ""} accent drill={!detailed?()=>navigate("analysis"):undefined}/>
      <Metric title="平均滞在" value={average == null ? "—" : (average/60000).toFixed(1)} unit={average == null ? "" : "分"}
        detail={average == null ? "算出不可" : analysis?.sumAverage == null ? "暫定値" : "確定値"}/>
      <Metric title="最大同時滞在" value={peak ? count(peak.occupancy) : "—"} unit={peak ? "人" : ""} detail={peak ? stamp(peak.at) : ""}/>
    </dl>
    <div className="cm-overview">
      <section className="cm-section" data-lux-focus="graph"><h2>{detailed?"滞在人数の推移":<button className="cm-text-action" onClick={()=>navigate("analysis")}>滞在人数の推移 <span aria-hidden="true">›</span></button>}</h2><p className="cm-caption">通過時刻に基づく集計</p>
        {analysis?.timeline.length && open != null ? <OccupancyChart rows={analysis.timeline} from={open} to={config?.closed ?? now} prediction={prediction}/> : <p className="cm-chart-empty">表示できる通過記録がありません。</p>}
      </section>
      <section className="cm-section"><h2>時間帯別の入退場</h2><p className="cm-caption"><span className="cm-legend in">入場</span><span className="cm-legend out">退場</span></p>
        {analysis?.hours.length ? <HourlyChart rows={analysis.hours}/> : <p className="cm-chart-empty">表示できる通過記録がありません。</p>}
      </section>
    </div>
    <section className="cm-section"><h2>計測端末の稼働状況</h2>
      {!stations.length ? <p className="cm-empty">表示できる端末がありません。</p> : <ul className="cm-status-list">
        {stations.filter(row => row.status === "approved").map(station => <li key={station.uid}><StationBadge role={station.role}/><button className="cm-text-action" onClick={()=>navigate("stations")}>{station.name}</button><DeviceSignal station={station} now={now}/><span>AI {station.ai == null ? "—" : station.ai ? "稼働" : "停止"} · 未同期 {station.pending ?? "—"}件</span><span>最終通信 {stamp(station.lastSeen)}</span></li>)}
        {!stations.some(row => row.status==="approved") && <li>承認済み端末がありません。</li>}</ul>}
      {analysis?.issues.length ? <details><summary>整合性の注意 {analysis.issues.length}件</summary><ul>{[...new Set(analysis.issues.map(row => row.code))].map(label => <li key={label}>{label}</li>)}</ul></details> : null}
    </section>
  </>;
}
function Metric({title,value,unit,detail,accent,drill}: {title:string;value:string;unit:string;detail?:string;accent?:boolean;drill?:()=>void}) {
  return <div className={accent ? "cm-metric cm-feature":"cm-metric"}><dt>{title}</dt><dd>{drill?<button className="cm-text-action" onClick={drill}>{value}<small>{unit}</small></button>:<>{value}<small>{unit}</small></>}</dd>{detail && <p>{detail}</p>}</div>;
}
function OccupancyChart({rows,from,to,prediction}: {rows:Analysis["timeline"];from:number;to:number;prediction:Forecast}) {
  const chunk = Math.ceil(rows.length/800);
  const points = rows.filter((_,i) => i % chunk === 0 || i === rows.length-1);
  const upper = rows.reduce((max,row) => Math.max(max,row.occupancy),Math.max(1,...prediction.map(row=>row.high)));
  const limit=prediction.at(-1)?.at??to;
  const last=rows.at(-1)!.occupancy;
  const lower = rows.reduce((min,row) => Math.min(min,row.occupancy),0);
  const px = (at:number) => 36 + 510 * (at-from)/Math.max(1,limit-from);
  const py = (people:number) => 156 - (people-lower)*130/(upper-lower);
  const plot = points.map(row => "H"+px(row.at)+"V"+py(row.occupancy)).join("");
  const projected=[{at:to,occupancy:last,low:last,high:last},...prediction];
  const projection=(key:"occupancy"|"low"|"high",points:typeof projected)=>points.map(row=>px(row.at)+","+py(row[key])).join(" ");
  return <figure className="cm-plot"><svg viewBox="0 0 572 190" role="img" aria-label={"滞在人数の時系列。現在 "+rows[rows.length-1].occupancy+"人。"}>
    {[upper,lower,...lower<0 ? [0] : []].map(value => <g key={value}><path d={"M36 "+py(value)+"H546"} className="cm-axis"/><text x="4" y={py(value)+4}>{value}</text></g>)}
    <path d={"M36 "+py(0)+plot+"H"+px(to)} className="cm-line"/>
    {!!prediction.length&&<g aria-label="推計の範囲">
      <polygon points={projection("high",projected)+" "+projection("low",[...projected].reverse())} className="lux-forecast-band"/>
      <line x1={px(to)} x2={px(to)} y1="26" y2="156" className="lux-forecast-border"/>
      <polyline points={projection("occupancy",projected)} className="lux-forecast-line"/>
    </g>}
    <text x="36" y="180">{hour(from)}</text><text x="546" y="180" textAnchor="end">{hour(limit)}</text>
  </svg>{!!prediction.length&&<p className="cm-caption">青紫の破線は滞在人数の予測、帯は直近の変動から算出した目安です。</p>}<details><summary>推移の数値を表示（直近20点）</summary><table><thead><tr><th>時刻</th><th>滞在</th></tr></thead><tbody>
    {rows.slice(-20).map(row => <tr key={row.at}><td>{stamp(row.at)}</td><td>{row.occupancy}人</td></tr>)}</tbody></table></details></figure>;
}
function HourlyChart({rows}: {rows:Analysis["hours"]}) {
  const max = rows.reduce((a,b) => Math.max(a,b.entries,b.exits),1);
  return <div className="cm-hour-list">{rows.map(row => <div key={row.at} className="cm-hour">
    <span>{hour(row.at)}</span><div><div className="cm-hour-bar"><i className="in" style={{width:(row.entries/max*100)+"%"}}/><b aria-label={"入場 "+row.entries}>{row.entries}</b></div>
    <div className="cm-hour-bar"><i className="out" style={{width:(row.exits/max*100)+"%"}}/><b aria-label={"退場 "+row.exits}>{row.exits}</b></div></div></div>)}</div>;
}

function StationBadge({role}:{role:"in"|"out"}) {return <span className={"cm-role "+role}>{roleTitle[role]}</span>;}
function DeviceSignal({station,now}:{station:CounterStation;now:number}) {
  const live = station.lastSeen !== undefined && now-station.lastSeen<=freshMs;
  return <span className={live ? "cm-health is-ready":"cm-health"}>{live ? "通信確認済み" : "現在は未確認"}</span>;
}
function StationList({stations,mode,now,admin,dedicated,enabled,loading,perform,eventId,version}: {
  stations:CounterStation[];mode:CounterMode;now:number;admin:boolean;dedicated:boolean;enabled:boolean;loading:boolean;perform:Mutation;eventId:string;version?:number;
}) {
  return <section className="cm-section" data-lux-focus="stations"><h2>登録端末</h2><p className="cm-caption">計測画面からこのイベントIDで申請してください。 <code>{eventId}</code></p>
    {loading ? <p className="cm-empty">端末を読み込んでいます。</p> : stations.length === 0 ? <p className="cm-empty">申請された端末がありません。</p> :
      <ul className="cm-stations">{[...stations].sort((a,b) => Number(b.status==="pending")-Number(a.status==="pending") || a.name.localeCompare(b.name,"ja")).map(station =>
        <li key={station.uid} data-lux-focus={station.status==="approved"?station.role:undefined}><div className="cm-device-title"><StationBadge role={station.role}/><h3>{station.name}</h3><span>{statusTitle[station.status]}</span></div>
          <div className="cm-device-meta"><DeviceSignal station={station} now={now}/><span>最終通信 {stamp(station.lastSeen)}</span>
            <span>{station.mode ? modeTitle[station.mode]+"運用" : "運用未確認"}</span>{station.mode && station.mode !== mode && <span>表示中の運用と異なります</span>}</div>
          <dl className="cm-definition cm-telemetry"><dt>カメラ</dt><dd>{station.camera === undefined ? "—" : station.camera ? "稼働" : "停止"}</dd>
            <dt>AI</dt><dd>{station.ai === undefined ? "—" : station.ai ? "稼働" : "停止"}</dd><dt>認識</dt><dd>{modeLabels[station.profile ?? ""] ?? "—"}</dd>
            <dt>未同期</dt><dd>{station.pending ?? "—"}件</dd><dt>バージョン</dt><dd>{station.version ?? "—"}</dd>
            {version!==undefined&&<><dt>配信設定</dt><dd>{station.mode===mode&&station.configVersion===version&&station.lastSeen!=null&&now-station.lastSeen<=freshMs
              ? "端末で確認済み · v"+version : "端末で未確認 · v"+version}</dd></>}</dl>
          {station.lastSeen && now-station.lastSeen>freshMs && <p className="cm-caption">表示は最後に取得した状態です。</p>}
          {alertTitle[station.alert ?? ""] && <p className="cm-caption">端末からの通知　{alertTitle[station.alert ?? ""]}</p>}
          {station.status==="approved"&&<details><summary>Luxnoraの診断</summary><p>{diagnose(station,now)}</p>
            {Number(station.version)>=16&&station.lux&&<p>端末からの最終報告　{station.lux.fps??"—"} FPS · 推論 {station.lux.inferenceMs??"—"} ms</p>}
            {station.lux?.activity&&<p>直近の自己診断・復旧　{stamp(station.lux.activity.at)} ·
              {({camera:"カメラ",inference:"認識処理",storage:"端末内保存"})[station.lux.activity.reason as "camera"|"inference"|"storage"]??"状態未確認"} ·
              {({recovering:"復旧開始",verified:"復旧確認",failed:"現地確認待ち"})[station.lux.activity.state as "recovering"|"verified"|"failed"]??"結果未確認"}</p>}
          </details>}
          {dedicated&&station.status==="approved"&&<CounterRemotePanel day={eventId} station={station} enabled={enabled} now={now}/>}
          {dedicated&&station.status!=="approved"&&<p className="cm-caption">計測端末で接続コードを表示し、上のペアリング欄で承認してください。</p>}
          {((!dedicated&&admin)||(dedicated&&station.status==="approved")) && <form className="cm-inline-form" key={station.uid+":"+station.name+":"+station.role+":"+station.status} onSubmit={event => {
            event.preventDefault();
            const button = (event.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
            const fields = new FormData(event.currentTarget);
            const name = String(fields.get("name") ?? "").trim(), role = fields.get("role") === "out" ? "out":"in";
            if (!name || !enabled) return;
            const status = button?.value as "approved" | "rejected" | "revoked" | "" | undefined;
            if (status === "revoked" && !window.confirm("旧端末が現地で停止していることを確認してください。同期済み記録は保持されます。承認を解除しますか？")) return;
            if (role !== station.role && station.status === "approved" &&
                (station.pending !== 0 || station.camera !== false || station.lastSeen == null || now-station.lastSeen>freshMs)) {
              window.alert("端末を停止して同期を完了し、最終通信状態が更新されてから役割を変更してください。");
              return;
            }
            if (role !== station.role && station.status === "approved" &&
                !window.confirm("役割変更の前に端末を停止し、以前の役割の未同期記録がないことを確認してください。続行しますか？")) return;
            void perform(() => saveCounterStation(eventId,station.uid,{name,role,...(status ? {status}:{})}),"端末情報を更新しました。");
          }}><label>端末名<input name="name" defaultValue={station.name} maxLength={60} required disabled={!enabled}/></label>
            <label>役割<select name="role" defaultValue={station.role} disabled={!enabled}><option value="in">入口</option><option value="out">出口</option></select></label>
            {station.status === "pending" ? <><button className="cm-primary" disabled={!enabled} value="approved">承認</button><button disabled={!enabled} value="rejected">拒否</button></>
              : station.status === "approved" ? <><button disabled={!enabled}>変更を保存</button>{admin&&<button disabled={!enabled} value="revoked">承認を解除</button>}</>
              : <button disabled={!enabled} value="approved">再承認</button>}
          </form>}
        </li>)}</ul>}
  </section>;
}

function EventControls({eventId,mode,config,enabled,admin,perform}:{eventId:string;mode:CounterMode;config:CounterConfig|null;enabled:boolean;admin:boolean;perform:Mutation}) {
  return <section className="cm-section"><h2>{modeTitle[mode]}の運用設定</h2>
    <p className="cm-caption">時刻は日本時間で入力します。停止・再開は通信が届いた計測端末で反映されます。</p>
    {config && <p><button className={config.paused ? "cm-primary":""} disabled={!enabled || config.closed != null} onClick={() =>
      void perform(() => pauseCounterEvent(eventId,mode,!config.paused),config.paused ? "再開を指示しました。" : "停止を指示しました。")}>
      {config.paused ? "受付を再開" : "受付を停止"}</button></p>}
    {admin && <form className="cm-form" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const opened = parsedInput(form.get("opened")),closed = parsedInput(form.get("closed"));
      if (opened == null || !Number.isFinite(opened) || (closed != null && (!Number.isFinite(closed) || closed < opened || closed > Date.now()))) {
        window.alert("開場日時と閉場日時の順序を確認してください。閉場日時は現在以前を指定してください。");return;
      }
      void perform(() => saveCounterConfig(eventId,mode,{opened,closed,paused:closed != null || !!config?.paused,
        verified:closed != null && form.get("verified") === "on"},config),"運用設定を保存しました。");
    }}>
      <label>開場日時<input name="opened" type="datetime-local" defaultValue={config?.opened != null ? localInput(config.opened) : ""} required disabled={!enabled}/></label>
      <label>閉場日時<input name="closed" type="datetime-local" defaultValue={config?.closed != null ? localInput(config.closed) : ""} disabled={!enabled}/></label>
      <label className="cm-check"><input name="verified" type="checkbox" defaultChecked={config?.verified} disabled={!enabled}/>開場・閉場時は空室で、入退場記録を確認済み</label>
      <button className="cm-primary" disabled={!enabled}>運用設定を保存</button>
    </form>}
    {!admin && !config && <p className="cm-empty">管理者が運用設定を作成すると、受付の停止と再開を操作できます。</p>}
  </section>;
}

function Records({eventId,mode,rows,enabled,loading,perform,now}:{
  eventId:string;mode:CounterMode;rows:CounterOperation[];enabled:boolean;loading:boolean;perform:Mutation;now:number;
}) {
  const operations = useMemo(() => analyze(rows,{eventId,mode,opened:0,closed:null,now}),[rows,eventId,mode,now]);
  const [target,setTarget] = useState("");
  const [page,setPage] = useState(0);
  const sorted = useMemo(() => [...operations.effective].sort((a,b) => b.at-a.at),[operations.effective]);
  const selected = sorted.find(row => row.originalId === target);
  const start = Math.min(page,Math.max(0,Math.ceil(sorted.length/25)-1))*25;
  const conflict = selected && operations.issues.some(row => row.target === selected.originalId && row.code === "修正競合");
  const revisions = selected ? rows.filter(row => row.kind==="revision" && row.target===selected.originalId) : [];
  const siblings = conflict && selected ? revisions.filter(row => row.kind === "revision" && row.parent === selected.id).map(row => row.id) : [];
  return <section className="cm-section">
    <div className="cm-section-top"><div><h2>正方向の通過記録</h2><p className="cm-caption">時刻は日本時間 · {sorted.length}件</p></div><button disabled={!sorted.length} onClick={() => {
      const content = csv([["記録ID","日時（UTC）","方向","区分","無効"],...sorted.map(row =>
        [row.originalId,new Date(row.at).toISOString(),row.direction==="in"?"入場":"退場",row.person==="staff"?"部員":"来場者",row.invalid?"無効":""])]);
      const url = URL.createObjectURL(new Blob([content],{type:"text/csv;charset=utf-8"}));
      const anchor = document.createElement("a");anchor.href=url;anchor.download="counter-"+eventId+"-"+mode+".csv";document.body.append(anchor);anchor.click();anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url),1500);
    }}>CSVを出力</button></div>
    {loading ? <p className="cm-empty">記録を読み込んでいます。</p> : sorted.length === 0 ? <p className="cm-empty">保存済みの通過記録がありません。</p> :
      <div className="cm-table-wrap"><table><thead><tr><th>日時</th><th>方向</th><th>状態</th><th>操作</th></tr></thead><tbody>
        {sorted.slice(start,start+25).map(row => <tr key={row.originalId}><td>{stamp(row.at)}</td><td><StationBadge role={row.direction}/></td>
          <td>{row.invalid ? "無効" : row.person==="staff" ? "部員・除外" : row.source==="manual" ? "手動" : "自動"}</td>
          <td><button onClick={() => setTarget(row.originalId)}>修正</button></td></tr>)}</tbody></table>
        {sorted.length>25 && <div className="cm-pagination"><button disabled={start===0} onClick={() => setPage(start/25-1)}>前へ</button><span>{start+1}–{Math.min(start+25,sorted.length)} / {sorted.length}</span><button disabled={start+25>=sorted.length} onClick={() => setPage(start/25+1)}>次へ</button></div>}
      </div>}
    <details open={selected ? true : undefined}><summary>{selected ? "選択した記録を修正" : "未計測の通過を手動追加"}</summary>
      {selected && <p><button onClick={() => setTarget("")}>選択を解除</button></p>}
      <PassageEditor key={selected?.id??"new"} selected={selected} enabled={enabled} now={now}
        conflict={!!conflict} commit={(form) => {
          if (conflict && (siblings.length < 2 || !window.confirm("競合した修正履歴を保持し、入力した内容を採用しますか？"))) return;
          const entered = String(form.get("at") ?? "");
          const unchanged = selected && entered === localInput(selected.at);
          const at = unchanged ? selected.at : parsedInput(entered),reason = String(form.get("reason") ?? "").trim();
          if (at == null || !Number.isFinite(at) || at > Date.now() || !reason) {window.alert("現在以前の通過日時と、修正理由を入力してください。");return;}
          const fields = {at,direction:form.get("direction")==="out" ? "out" as const:"in" as const,
            person:form.get("person")==="staff" ? "staff" as const:"visitor" as const,invalid:form.get("invalid")==="on",
            ...(unchanged ? {clockWarning:selected.clockWarning,clockUncertainty:selected.clockUncertainty} : {})};
          void perform(() => selected ? reviseCounterPassage(eventId,mode,selected,fields,reason,siblings)
            : addCounterPassage(eventId,mode,fields,reason),"通過記録を保存しました。");
        }} />
      {revisions.length>0 && <details><summary>修正履歴 {revisions.length}件</summary><ul>{revisions.map(row => <li key={row.id}>{stamp(row.rawAt)}　{row.reason}</li>)}</ul></details>}
    </details>
  </section>;
}
function PassageEditor({selected,enabled,now,commit,conflict}:{selected?:EffectiveCounterPassage;enabled:boolean;now:number;commit:(form:FormData)=>void;conflict:boolean}) {
  return <form className="cm-form" onSubmit={(event:FormEvent<HTMLFormElement>) => {event.preventDefault();if (enabled) commit(new FormData(event.currentTarget));}}>
    {conflict && <p className="cm-warning">競合した修正があります。履歴を確認して、採用する内容を入力してください。</p>}
    <label>通過日時<input name="at" type="datetime-local" defaultValue={localInput(selected?.at ?? now)} required disabled={!enabled}/></label>
    <label>方向<select name="direction" defaultValue={selected?.direction??"in"} disabled={!enabled}><option value="in">入場</option><option value="out">退場</option></select></label>
    {selected && <><label>来場者区分<select name="person" defaultValue={selected.person} disabled={!enabled}><option value="visitor">来場者</option><option value="staff">部員・集計から除外</option></select></label>
      <label className="cm-check"><input name="invalid" type="checkbox" defaultChecked={selected.invalid} disabled={!enabled}/>集計から除外する</label></>}
    <label>理由<input name="reason" required maxLength={180} disabled={!enabled}/></label>
    <button className="cm-primary" disabled={!enabled}>{selected ? "修正を保存" : "通過を追加"}</button>
  </form>;
}
