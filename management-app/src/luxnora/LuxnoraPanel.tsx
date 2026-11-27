import {useEffect,useRef,useState,type FormEvent} from "react";
import {answer,watchAlerts,type Answer,type Evidence,type Target} from "./assistant";
import {interpret,type Plan} from "./language";

export function LuxnoraPanel({evidence,focus,cancel}:{evidence:Evidence;focus:(target:Target,plan?:Plan)=>void;cancel:()=>void}) {
  const [open,setOpen]=useState(false),[input,setInput]=useState("");
  const [motion,setMotion]=useState("idle");
  const motionTimer=useRef<number|undefined>(undefined);
  useEffect(()=>()=>clearTimeout(motionTimer.current),[]);
  function changeMotion(next:string,after:string,ms:number) {
    clearTimeout(motionTimer.current);
    setMotion(next);
    motionTimer.current=window.setTimeout(()=>setMotion(after),ms);
  }
  function changeOpen(next:boolean) {
    setOpen(next);
    changeMotion(next?"ignition":"verified",next?"living":"idle",next?580:750);
    if(next) requestAnimationFrame(()=>prompt.current?.focus());
    else trigger.current?.focus();
  }
  const [notes,setNotes]=useState<{prompt:string;response:Answer[]}[]>([]);
  const [setting,setSetting]=useState(()=>{
    try {return localStorage.getItem("counter-lux-support")??"smart";}catch{return "smart";}
  }),[working,setWorking]=useState(false);
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
  useEffect(()=>{if(replies.current) replies.current.scrollTop=replies.current.scrollHeight;},[notes]);
  const inFlight=useRef(false),active=useRef(true);
  useEffect(()=>{active.current=true;return ()=>{active.current=false;};},[]);
  const previous=useRef<Plan|undefined>(undefined);
  const prompt=useRef<HTMLInputElement>(null);
  const trigger=useRef<HTMLButtonElement>(null);
  async function submit(event:FormEvent) {
    event.preventDefault();
    const text=input.trim();
    if(!text||inFlight.current) return;
    let plan=interpret(text,previous.current);
    if(!plan.plans.length&&!plan.reset&&plan.message?.startsWith("依頼の対象")) {
      inFlight.current=true;
      setWorking(true);
      const intent=await import("./semantic").then(module=>module.semanticRead(text)).catch(()=>null);
      if(!active.current) return;
      if(intent) plan={plans:[{intent,focus:false,readOnly:true,role:text.includes("入口")?"in":text.includes("出口")?"out":undefined}]};
      inFlight.current=false;
      setWorking(false);
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
    if(open&&response.some(item=>item.target==="graph")&&evidence.prediction.length>0) changeMotion("forecast","living",1800);
  }
  return <aside className="lux-dock" aria-label="Luxnora">
    {open&&<section id="lux-panel" className="lux-panel" aria-label="Luxnoraとの会話" onKeyDown={e=>{
      if(e.key==="Escape"){changeOpen(false);}
    }}>
      <header><strong>Luxnora</strong><button onClick={()=>{changeOpen(false);}} aria-label="会話を閉じる">閉じる</button></header>
      <div ref={replies} className="lux-answers" role="log" aria-label="会話">
        {!notes.length&&<p>「今何人おる？」「出口の状態を確認して」など、表示中のイベントについて入力できます。</p>}
        {notes.map((note,i)=><div key={i}><b>{note.prompt}</b>{note.response.map((item,index)=><p key={index}>{item.text}{item.target&&note.response.length>1&&<button type="button" className="cm-text-action" onClick={()=>focus(item.target!,item.plan)}>該当箇所を表示</button>}</p>)}</div>)}
      </div>
      <form onSubmit={event=>void submit(event)}><input ref={prompt} aria-label="Luxnoraへの依頼" value={input} onChange={e=>setInput(e.target.value)} maxLength={320} autoComplete="off" disabled={working}/><button className="cm-primary" disabled={working}>{working?"解析中":"送信"}</button></form>
      <label className="lux-setting">支援 <select value={setting} onChange={e=>{setSetting(e.target.value);try {localStorage.setItem("counter-lux-support",e.target.value);}catch{}}}><option value="onRequest">指示したときのみ</option><option value="smart">スマートサポート</option><option value="active">積極的なサポート</option></select></label>
      {setting!=="onRequest"&&evidence.config?.opened!=null&&!evidence.current&&<small>端末の通信状態または未同期記録を確認してください。</small>}
      {setting==="active"&&!!evidence.analysis?.issues.length&&<small>整合性の指摘 {evidence.analysis.issues.length}件を通過記録と照合できます。</small>}
      {offered&&<button onClick={()=>{monitorSnapshot.current="";setActivity([]);setMonitor({role:offered.role,until:Date.now()+15*60000});setOffered(null);}}>15分間の見守りを開始</button>}
      {monitor&&<button onClick={()=>{setMonitor(null);setActivity(rows=>[...rows.slice(-5),"見守りを終了しました。"]);}}>見守りを終了</button>}
      {!!activity.length&&<div className="lux-activity" aria-live="polite">{activity.map((text,i)=><p key={i}>{text}</p>)}</div>}
    </section>}
    <button ref={trigger} className="lux-trigger" aria-expanded={open} aria-controls="lux-panel" onClick={()=>changeOpen(!open)}>
      <picture>
        <source media="(prefers-reduced-motion: reduce)" srcSet={import.meta.env.BASE_URL+"people-counter/luxnora-mark.svg?v=17#idle"}/>
        <img className="lux-mark" alt="" width="31" height="28" src={import.meta.env.BASE_URL+"people-counter/luxnora-mark.svg?v=17#"+motion}/>
      </picture>
      Luxnora
    </button>
  </aside>;
}
