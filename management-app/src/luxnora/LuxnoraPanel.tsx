import {useEffect,useId,useRef,useState,type FormEvent} from "react";
import {answer,watchAlerts,type Answer,type Evidence,type Target} from "./assistant";
import {interpret,type Plan} from "./language";

// Keep the same glass frames mounted across every motion state.
// Only their energy changes; the phase never restarts on a new state.
function GlassMark({motion,className}:{motion:string;className?:string}) {
  const id=useId().replace(/[^a-zA-Z0-9_-]/g,"");
  const a=useRef<SVGGElement>(null),b=useRef<SVGGElement>(null);
  const phase=useRef(0),energy=useRef(0);
  useEffect(()=>{
    const media=window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame=0,last=performance.now();
    const goal=motion==="idle"||motion==="convergence" ? 0 : motion==="checking" ? 1 : motion==="forecast" ? .75 : motion==="ignition" ? .62 : .30;
    function paint(now:number){
      const dt=Math.min(.05,Math.max(0,(now-last)/1000));last=now;
      if(media.matches||document.hidden){energy.current=0; a.current?.removeAttribute("transform");b.current?.removeAttribute("transform");return;}
      energy.current+=(goal-energy.current)*(1-Math.exp(-dt*6));
      const e=energy.current;
      if(goal===0&&e<.004){energy.current=0;a.current?.removeAttribute("transform");b.current?.removeAttribute("transform");return;}
      phase.current+=dt*(.85+e*1.5);
      const w=Math.sin(phase.current)*e,h=Math.cos(phase.current*.83)*e;
      a.current?.setAttribute("transform",`translate(54 85) translate(${-5*w} ${4*h}) skewX(${9*w}) skewY(${5*h}) scale(${1+.07*h} ${1-.05*w}) translate(-54 -85)`);
      b.current?.setAttribute("transform",`translate(105 54) translate(${5*w} ${-4*h}) skewX(${-9*h}) skewY(${-5*w}) scale(${1-.05*w} ${1+.06*h}) translate(-105 -54)`);
      frame=requestAnimationFrame(paint);
    }
    function restart(){cancelAnimationFrame(frame);last=performance.now();frame=requestAnimationFrame(paint);}
    restart();media.addEventListener("change",restart);document.addEventListener("visibilitychange",restart);
    return ()=>{cancelAnimationFrame(frame);media.removeEventListener("change",restart);document.removeEventListener("visibilitychange",restart);};
  },[motion]);
  return <svg className={className} viewBox="0 0 160 136" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id={id+"a"} x1="0" y1="1" x2="1" y2="0"><stop stopColor="#b0f7ff"/><stop offset=".34" stopColor="#54c4fb"/><stop offset=".74" stopColor="#667ef0"/><stop offset="1" stopColor="#bab2ff"/></linearGradient>
      <linearGradient id={id+"b"} x1="0" y1="1" x2="1" y2="0"><stop stopColor="#7ce6fb"/><stop offset=".43" stopColor="#858fff"/><stop offset=".78" stopColor="#aa83ee"/><stop offset="1" stopColor="#f1d7ff"/></linearGradient>
      <linearGradient id={id+"g"} x2=".65" y2="1"><stop stopColor="#b9c8ff" stopOpacity=".24"/><stop offset="1" stopColor="#8d9bed" stopOpacity=".025"/></linearGradient>
      <path id={id+"p"} d="M27 58 91 45Q102 42 100 53L93 100Q92 108 83 110L20 124Q10 126 12 115L19 70Q20 60 27 58Z"/>
      <path id={id+"q"} d="M78 32 144 13Q154 10 152 21L143 71Q142 79 134 81L70 97Q59 100 61 89L70 44Q72 35 78 32Z"/>
    </defs>
    <g ref={a}><use href={"#"+id+"p"} fill={"url(#"+id+"g)"} stroke="#395d9d" strokeWidth="12" opacity=".45"/><use href={"#"+id+"p"} fill="none" stroke={"url(#"+id+"a)"} strokeWidth="8"/><use href={"#"+id+"p"} fill="none" stroke="#e5fbff" strokeWidth="1.5" opacity=".7"/><use className="lux-mark-trace" href={"#"+id+"p"} fill="none" stroke="#efffff" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="32 280"/></g>
    <g ref={b}><use href={"#"+id+"q"} fill={"url(#"+id+"g)"} stroke="#5d429c" strokeWidth="12" opacity=".4"/><use href={"#"+id+"q"} fill="none" stroke={"url(#"+id+"b)"} strokeWidth="8"/><use href={"#"+id+"q"} fill="none" stroke="#f3e7ff" strokeWidth="1.5" opacity=".7"/><use className="lux-mark-trace lux-mark-trace-rear" href={"#"+id+"q"} fill="none" stroke="#f6ecff" strokeWidth="2.4" strokeLinecap="round" strokeDasharray="32 280"/></g>
  </svg>;
}


const profiles=[
  {id:"auto",name:"Luxnora Auto",description:"通常の理解処理と意味認識AIを自動で使い分ける"},
  {id:"swift",name:"Luxnora Swift",description:"軽量な理解処理だけで素早く応答する"},
] as const;
type Profile=typeof profiles[number]["id"];
function savedProfile():Profile {
  try {return localStorage.getItem("counter-lux-profile")==="swift"?"swift":"auto";}catch{return "auto";}
}

export function LuxnoraPanel({evidence,focus,cancel}:{evidence:Evidence;focus:(target:Target,plan?:Plan)=>void;cancel:()=>void}) {
  const [open,setOpen]=useState(false),[input,setInput]=useState("");
  const isOpen=useRef(false);
  const [motion,setMotion]=useState("idle");
  const [mounted,setMounted]=useState(false);
  const closeTimer=useRef<number|undefined>(undefined);
  const motionTimer=useRef<number|undefined>(undefined);
  useEffect(()=>()=>{clearTimeout(motionTimer.current);clearTimeout(closeTimer.current);},[]);
  function changeMotion(next:string,after:string,ms:number) {
    clearTimeout(motionTimer.current);
    setMotion(next);
    motionTimer.current=window.setTimeout(()=>setMotion(after),ms);
  }
  function changeOpen(next:boolean) {
    clearTimeout(closeTimer.current);
    isOpen.current=next;
    setOpen(next);
    setPicker(false);
    changeMotion(next?"ignition":"convergence",next?"living":"idle",next?740:540);
    if(next) {setMounted(true);if(!window.matchMedia("(pointer: coarse)").matches) requestAnimationFrame(()=>prompt.current?.focus({preventScroll:true}));}
    else {
      trigger.current?.focus();
      if(window.matchMedia("(prefers-reduced-motion: reduce)").matches) setMounted(false);
      else closeTimer.current=window.setTimeout(()=>setMounted(false),540);
    }
  }
  const [notes,setNotes]=useState<{prompt:string;response:Answer[]}[]>([]);
  const [profile,setProfile]=useState<Profile>(savedProfile);
  const [picker,setPicker]=useState(false),[working,setWorking]=useState(false);
  const pickerButton=useRef<HTMLButtonElement>(null);
  function selectProfile(value:Profile){
    if(inFlight.current)return;
    setProfile(value);setPicker(false);
    try{localStorage.setItem("counter-lux-profile",value);}catch{}
    pickerButton.current?.focus();
  }
  const [monitor,setMonitor]=useState<{role?:Plan["role"];until:number}|null>(null);
  const [offered,setOffered]=useState<Plan|null>(null);
  const [activity,setActivity]=useState<string[]>([]);
  const monitorSnapshot=useRef("");
  useEffect(()=>{
    if(!monitor) return;
    if(Date.now()>=monitor.until){setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守り時間が終了しました。"]);return;}
    if(document.hidden) return;
    const alarms=watchAlerts(evidence,monitor.role),status=alarms.join("\n");
    if(status===monitorSnapshot.current) return;
    monitorSnapshot.current=status;
    setActivity(rows=>[...rows.slice(-3),...(alarms.length?alarms:["取得済みの端末に新たな注意はありません。"])].slice(-6));
  },[evidence,monitor]);
  const replies=useRef<HTMLDivElement>(null);
  useEffect(()=>{if(replies.current) replies.current.scrollTop=replies.current.scrollHeight;},[notes,mounted,working]);
  const inFlight=useRef(false),active=useRef(true);
  useEffect(()=>{active.current=true;return ()=>{active.current=false;};},[]);
  const previous=useRef<Plan|undefined>(undefined);
  const prompt=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  function submit(event:FormEvent) {event.preventDefault();void run(input);}
  async function run(value:string) {
    const text=value.trim();
    if(!text||inFlight.current) return;
    setPicker(false);
    let plan=interpret(text,previous.current);
    if(profile==="auto"&&!plan.plans.length&&!plan.reset&&plan.message?.startsWith("依頼の対象")) {
      inFlight.current=true;
      setWorking(true);
      clearTimeout(motionTimer.current);
      if(isOpen.current) setMotion("checking");
      const intent=await import("./semantic").then(module=>module.semanticRead(text)).catch(()=>null);
      if(!active.current) return;
      if(intent) plan={plans:[{intent,focus:false,readOnly:true,role:text.includes("入口")?"in":text.includes("出口")?"out":undefined}]};
      inFlight.current=false;
      setWorking(false);
      if(isOpen.current) setMotion("living");
    }
    const response=plan.plans.map(item=>answer(item,evidence));
    if(plan.reset) {previous.current=undefined;cancel();setOffered(null);setMonitor(null);}
    const routine=plan.plans.find(item=>item.intent==="routine");
    if(routine&&!routine.readOnly) setOffered(routine);
    if(plan.plans.length) previous.current=plan.plans.at(-1);
    setNotes(current=>[...current.slice(-11),{prompt:text,response:response.length?response:[{text:plan.message??"対象を指定してください。"}]}]);
    setInput("");
    const item=response.find(result=>result.target);
    if(item?.target) focus(item.target,item.plan);
    if(isOpen.current&&response.some(item=>item.target==="graph")&&evidence.prediction.length>0) changeMotion("forecast","living",1800);
  }
  const last=notes.at(-1);
  const detailed=last?.response.some(row=>row.target==="compare"||row.target==="graph"||row.text.length>150);
  const stage=detailed?3:(notes.length>1||monitor||offered)?2:1;
  return <aside className="lux-dock" data-open={open} data-mounted={mounted} data-stage={stage} data-motion={motion} data-has-answer={notes.length>0||working} aria-label="Luxnora">
    {mounted&&<div className="lux-screen-aura" aria-hidden="true" data-closing={!open}><div className="lux-aura-blue"/><div className="lux-aura-violet"/></div>}
    {mounted&&<section id="lux-panel" className="lux-panel" data-closing={!open} inert={!open} aria-label="Luxnoraとの会話" onKeyDown={e=>{
      if(e.key==="Escape"){e.stopPropagation();if(picker){setPicker(false);pickerButton.current?.focus();}else changeOpen(false);}
    }}>
      <header><span className="lux-panel-brand"><span className="lux-header-mark"><GlassMark motion={motion}/></span><button ref={pickerButton} type="button" className="lux-profile-trigger" aria-label={"モデル選択："+profiles.find(item=>item.id===profile)?.name} aria-expanded={picker} aria-controls={picker?"lux-profile-menu":undefined} disabled={working} onClick={()=>setPicker(value=>!value)}><span>{profiles.find(item=>item.id===profile)?.name}</span><svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></button></span><button className="lux-close" onClick={()=>changeOpen(false)} aria-label="会話を閉じる"><svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="m6 6 12 12M18 6 6 18"/></svg></button></header>
      {picker&&<div id="lux-profile-menu" className="lux-profile-menu" role="group" aria-label="モデル・動作モード">
        <p>モデル・動作モード</p>
        {profiles.map(item=><button key={item.id} type="button" aria-pressed={profile===item.id} onClick={()=>selectProfile(item.id)} disabled={working}>
          <span><strong>{item.name}</strong><small>{item.description}</small></span>
          {profile===item.id&&<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 4 4 10-10"/></svg>}
        </button>)}
        <small>現在は同じLuxnora基盤の処理モードです。</small>
      </div>}
      {!notes.length&&!working&&!picker&&<div className="lux-welcome">
        <small>{evidence.name||"イベント管理"}</small>
        <h2>何をしましょうか？</h2>
        <div className="lux-suggestions">
          {["今の状況をまとめて","この後混みそう？"].map(question=><button type="button" key={question} onClick={()=>void run(question)}>{question}<svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10"/></svg></button>)}
        </div>
      </div>}
      <div ref={replies} className="lux-answers" role="log" aria-label="会話">
        {working&&<p className="lux-progress" role="status">依頼を確認しています…</p>}
        {notes.map((note,i)=><div className="lux-turn" key={i}><p className="lux-question">{note.prompt}</p>{note.response.map((item,index)=><p className="lux-response" key={index}>{item.text}{item.target&&note.response.length>1&&<button type="button" className="cm-text-action" onClick={()=>focus(item.target!,item.plan)}>該当箇所を表示</button>}</p>)}</div>)}
      </div>

      {evidence.config?.opened!=null&&!evidence.current&&<small>端末の通信状態または未同期記録を確認してください。</small>}
      {!!evidence.analysis?.issues.length&&<small>整合性の指摘 {evidence.analysis.issues.length}件を通過記録と照合できます。</small>}
      {offered&&<button onClick={()=>{monitorSnapshot.current="";setActivity([]);setMonitor({role:offered.role,until:Date.now()+15*60000});setOffered(null);}}>15分間の見守りを開始</button>}
      {monitor&&<button onClick={()=>{setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守りを終了しました。"]);}}>見守りを終了</button>}
      {!!activity.length&&<div className="lux-activity" aria-live="polite">{activity.map((text,i)=><p key={i}>{text}</p>)}</div>}
      <form className="lux-composer" onSubmit={event=>void submit(event)}>
        <input ref={prompt} aria-label="Luxnoraへの依頼" placeholder="Luxnoraに伝える" value={input} onChange={e=>setInput(e.target.value)} maxLength={320} autoComplete="off" disabled={working}/>
        <button type="submit" className="lux-send" aria-label={working?"解析中":"送信"} disabled={working||!input.trim()}>
          {working?<span className="lux-send-progress" aria-hidden="true"/>:<svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5"/></svg>}
        </button>
      </form>
    </section>}
    <button ref={trigger} className="lux-trigger" aria-label="Luxnora" aria-expanded={open} aria-controls="lux-panel" onClick={()=>changeOpen(!open)}>
      <GlassMark className="lux-mark" motion={motion}/>
    </button>
  </aside>;
}
