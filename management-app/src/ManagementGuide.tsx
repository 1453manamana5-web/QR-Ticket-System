import {useEffect,useRef,useState,type ReactNode} from 'react';
import {managementGuideSteps as steps,chapterStart,type GuideTarget} from './guideSteps';
import GuideReceptionPractice from './GuideReceptionPractice';
import './ManagementGuide.css';
export type GuideRecord={step:number;status:'active'|'paused'|'completed'};
export function readGuideRecord(storage:Pick<Storage,'getItem'>,key:string):GuideRecord|null{
  try{const r=JSON.parse(storage.getItem(key)??'null');return r&&Number.isInteger(r.step)&&r.step>=0&&r.step<steps.length&&['active','paused','completed'].includes(r.status)?r:null;}catch{return null;}
}
export function useManagementGuide(terminalId:string,enabled:boolean,storage:Pick<Storage,'getItem'|'setItem'>){
  const [open,setOpen]=useState(false),[step,setStep]=useState(0),[saveError,setSaveError]=useState(false);
  const initialized=useRef('');const key='qr-ticket-guide-management-v1:'+terminalId;
  const persist=(index:number,status:GuideRecord['status'])=>{try{storage.setItem(key,JSON.stringify({step:index,status}));setSaveError(false);}catch{setSaveError(true);}};
  useEffect(()=>{
    if(!enabled||initialized.current===key)return;initialized.current=key;
    const saved=readGuideRecord(storage,key);const index=chapterStart(saved?.step??0);setStep(index);
    if(!saved||saved.status==='active'){setOpen(true);persist(index,'active');}
  },[enabled,key]);
  const start=(reset=false)=>{if(!enabled)return;const record=readGuideRecord(storage,key);const index=reset||record?.status==='completed'?0:chapterStart(record?.step??step);setStep(index);setOpen(true);persist(index,'active');};
  const pause=()=>{setOpen(false);persist(step,'paused');};
  const next=()=>{if(step===steps.length-1){setOpen(false);persist(step,'completed');return;}setStep(step+1);persist(step+1,'active');};
  const restartChapter=()=>{const index=chapterStart(step);setStep(index);persist(index,'active');};
  return {open,step,saveError,start,pause,next,restartChapter};
}
export type GuideController=ReturnType<typeof useManagementGuide>;
export function findGuideTarget(root:HTMLElement,target?:GuideTarget):HTMLElement|null{
  if(!target)return null;
  const scope=target.scope?root.querySelector<HTMLElement>(target.scope):root;if(!scope)return null;
  const visible=(node:HTMLElement)=>node.getClientRects().length>0;
  if(target.selector)return [...scope.querySelectorAll<HTMLElement>(target.selector)].find(visible)??null;
  if(target.label){
    const exact=[...scope.querySelectorAll<HTMLElement>('[aria-label]')].find(n=>n.getAttribute('aria-label')===target.label);
    if(exact)return visible(exact)?exact:exact.closest<HTMLElement>('label');
    const label=[...scope.querySelectorAll<HTMLLabelElement>('label')].find(n=>n.textContent?.includes(target.label!));
    if(label)return label.querySelector<HTMLElement>('input,select,textarea')??label;
  }
  return [...scope.querySelectorAll<HTMLElement>('button,a,[role="menuitem"]')].find(n=>visible(n)&&n.textContent?.replace(/\s/g,'').includes(target.text?.replace(/\s/g,'')??'__missing__'))??null;
}
export default function ManagementGuide({controller:c,renderWorkspace}:{controller:GuideController;renderWorkspace:()=>ReactNode}){
  const step=steps[c.step],root=useRef<HTMLDivElement>(null),dialog=useRef<HTMLElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const [acted,setActed]=useState(false),[ready,setReady]=useState(false),[found,setFound]=useState(false),[epoch,setEpoch]=useState(0);
  const chapter=chapterStart(c.step);
  useEffect(()=>{setActed(false);setReady(Boolean(step.note));heading.current?.focus();},[c.step,epoch]);
  useEffect(()=>{
    const host=root.current;if(!host)return;let highlighted:HTMLElement|null=null;
    const update=()=>{
      const target=findGuideTarget(host,step.target);setFound(Boolean(target));
      if(target!==highlighted){highlighted?.removeAttribute('data-guide-highlight');highlighted=target;if(target){target.setAttribute('data-guide-highlight','true');target.scrollIntoView({block:'center',inline:'nearest',behavior:'auto'});}}
      setReady(Boolean(step.note)||(acted&&(!step.after||Boolean(host.querySelector(step.after)))));
    };
    update();const observer=new MutationObserver(update);observer.observe(host,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','aria-expanded','value','class']});
    const timer=window.setInterval(update,400);
    return()=>{observer.disconnect();window.clearInterval(timer);highlighted?.removeAttribute('data-guide-highlight');};
  },[c.step,acted,epoch]);
  const interact=(event:React.SyntheticEvent)=>{
    const host=root.current;if(!host)return;
    const target=findGuideTarget(host,step.target);
    if(target&&(target===event.target||target.contains(event.target as Node))){
      const kind=event.type;
      if((step.event==='click'&&kind==='click')||(step.event==='input'&&['input','change'].includes(kind))||(step.event==='pointerup'&&kind==='pointerup'))setActed(true);
    }
  };
  const sampleImage=()=>{
    const input=root.current?.querySelector<HTMLInputElement>('input[aria-label="画像を追加"]');if(!input)return;
    const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='),v=>v.charCodeAt(0));
    const transfer=new DataTransfer();transfer.items.add(new File([bytes],'練習用マーク.png',{type:'image/png'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}));
  };
  return <section className="management-guide" role="dialog" aria-modal="true" aria-labelledby="guide-heading" ref={dialog} onKeyDown={event=>{
    if(event.key==='Escape'){event.preventDefault();c.pause();}
    if(event.key==='Tab'){
      const items=[...dialog.current!.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(n=>n.getClientRects().length>0);
      const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
    }
  }}>
    <header className="guide-coach"><div className="guide-progress"><strong>使い方ガイド · 練習専用</strong><span>{c.step+1} / {steps.length} · {step.chapter}</span><progress max={steps.length} value={c.step+1}/></div><h2 id="guide-heading" tabIndex={-1} ref={heading}>{step.title}</h2><p>{step.body}</p>{c.saveError&&<p role="alert">進行状況を端末に保存できません。次回は設定から開始してください。</p>}</header>
    <div className="guide-workspace" key={chapter+':'+epoch} ref={root} onClickCapture={interact} onInputCapture={interact} onChangeCapture={interact} onPointerUpCapture={interact}>
      {step.chapter==='受付の練習'?<GuideReceptionPractice/>:renderWorkspace()}
    </div>
    <footer className="guide-footer"><button onClick={c.pause}>中断する</button><button onClick={()=>{c.restartChapter();setEpoch(v=>v+1);}}>この章をやり直す</button><span role="status">{ready?'確認できました。次へ進めます。':!step.note&&!found?'操作する画面の準備中です。見つからない場合は章をやり直してください。':'枠で示した箇所を操作してください。'}</span>{step.target?.label==='画像を追加'&&<button onClick={sampleImage}>練習用画像を選ぶ</button>}<button className="guide-next" disabled={!ready} onClick={c.next}>{c.step===steps.length-1?'ガイドを完了する':step.note?'確認して次へ':'次へ'}</button></footer>
  </section>;
}
