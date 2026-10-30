import {useEffect,useRef,useState} from 'react';
import GuideReceptionPractice from '../../management-app/src/GuideReceptionPractice';
import './ReceptionGuide.css';
export const receptionGuideSteps=[
  {title:'受付の使い方ガイド',body:'端末登録・承認が完了しました。カメラや本物のQRを使わず、受付ボタンを操作して練習します。練習結果は保存・送信しません。',action:''},
  {title:'受付を開始',body:'「受付を開始する」を押します。本番ではこの後にカメラが起動します。',action:'受付を開始する'},
  {title:'入場',body:'「練習QRを読み取る」を押して入場結果を確認してください。',action:'練習QRを読み取る'},
  {title:'重複読み取り',body:'同じQRをもう一度読み取ってください。二重入場はエラーになります。',action:'練習QRを読み取る'},
  {title:'出口モード',body:'切替ボタンで出口受付にしてください。本番は左右スワイプでも切り替えられます。',action:'出口受付へ切り替え'},
  {title:'退場',body:'練習QRを読み取り、出口用の結果を確認してください。',action:'練習QRを読み取る'},
  {title:'入口へ戻す',body:'切替ボタンで入口受付に戻してください。',action:'入口受付へ切り替え'},
  {title:'再入場',body:'同じQRを読み取ってください。再入場は初回来場者の人数へ追加しません。',action:'練習QRを読み取る'},
  {title:'受付を止める',body:'「受付を停止する」を押してください。現場で操作を止めたいときに使います。',action:'受付を停止する'},
  {title:'本番の準備と音の確認',body:'本番前に全QRデータ（未印刷予備を含む）を保存し、通信を切って開き直せることを確認します。「音の確認」と「受付結果を試験表示」で実際の音・表示を確認してください。練習では実機のカメラ・音・印刷は検証しません。',action:''},
  {title:'オフライン運用の注意',body:'オフラインの入場端末と退場端末は、互いの最新状態を即時共有できません。未送信件数を確認し、終了時は全端末をオンラインに戻して同期します。承認・イベント変更にはオンラインの事前準備が必要です。設定の「使い方ガイドを始める」でいつでも練習できます。',action:''},
];
export const receptionGuideTopics=[{id:'entry',label:'受付開始・入場・重複',start:1,end:3,scenario:'start'},{id:'exit',label:'退場・再入場・停止',start:4,end:8,scenario:'inside'},{id:'prepare',label:'本番準備・音の確認',start:9,end:9,scenario:'start'},{id:'offline',label:'オフライン運用',start:10,end:10,scenario:'start'}] as const;
export function useReceptionGuide(terminalId:string,approved:boolean){
  const [open,setOpen]=useState(false),[step,setStep]=useState(0),[saveError,setSaveError]=useState(false),[topic,setTopic]=useState<string|null>(null);const initialized=useRef('');
  const key='qr-ticket-guide-reception-v1:'+terminalId;
  const save=(status:string,index=step)=>{try{localStorage.setItem(key,JSON.stringify({status,step:index}));setSaveError(false);}catch{setSaveError(true);}};
  useEffect(()=>{if(!approved||initialized.current===key)return;initialized.current=key;setTopic(null);let r;try{r=JSON.parse(localStorage.getItem(key)??'null');}catch{}if(!r||!['paused','completed'].includes(r.status)){setStep(0);setOpen(true);save('active',0);}},[approved,key]);
  const start=()=>{if(!approved)return;setTopic(null);setStep(0);setOpen(true);save('active',0);};
  const startTopic=(id:string)=>{const selected=receptionGuideTopics.find(t=>t.id===id);if(!approved||!selected)return;setTopic(id);setStep(selected.start);setOpen(true);};
  const pause=()=>{setOpen(false);if(!topic)save('paused');};
  const next=()=>{if(topic&&step===receptionGuideTopics.find(t=>t.id===topic)?.end){setOpen(false);return;}if(step===receptionGuideSteps.length-1){setOpen(false);save('completed');}else{setStep(s=>s+1);if(!topic)save('active',step+1);}};
  return {open,step,topic,start,startTopic,pause,next,saveError};
}
export default function ReceptionGuide({controller:c}:{controller:ReturnType<typeof useReceptionGuide>}){
  const selected=receptionGuideTopics.find(t=>t.id===c.topic);
  const position=selected?c.step-selected.start+1:c.step+1,total=selected?selected.end-selected.start+1:receptionGuideSteps.length;
  const last=selected?c.step===selected.end:c.step===receptionGuideSteps.length-1;
  const step=receptionGuideSteps[c.step],[acted,setActed]=useState(false),root=useRef<HTMLElement>(null);
  useEffect(()=>{setActed(false);root.current?.querySelector<HTMLElement>('h1')?.focus();},[c.step]);
  return <section className="reception-guide" ref={root} role="dialog" aria-modal="true" aria-labelledby="reception-guide-title" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();c.pause();}if(event.key==='Tab'){const items=[...root.current!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];const first=items[0],last=items.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}}}>
    <header><small>使い方ガイド · 練習専用 · {position}/{total}{selected?" · "+selected.label:""}</small><h1 id="reception-guide-title" tabIndex={-1}>{step.title}</h1><p>{step.body}</p>{c.saveError&&<p role="alert">進行状況を端末に保存できません。設定から再開できます。</p>}</header>
    <div className="reception-guide-workspace" onClickCapture={event=>{const button=(event.target as HTMLElement).closest('button');if(step.action&&button?.textContent===step.action)setActed(true);}}><GuideReceptionPractice initialScenario={selected?.scenario??'start'}/></div>
    <footer><button onClick={c.pause}>中断する</button><span role="status">{step.action&&!acted?'上の練習画面で「'+step.action+'」を押してください。':'次へ進めます。'}</span><button disabled={Boolean(step.action)&&!acted} onClick={c.next}>{last?(selected?'この項目を完了する':'ガイドを完了する'):'次へ'}</button></footer>
  </section>;
}
