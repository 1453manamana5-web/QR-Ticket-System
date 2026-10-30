import {useEffect,useState} from 'react';
import {claimReserveBatch,finishReserveBatch,loadReservePackage,saveReservePackage,selectReserveTickets,type ReservePackage} from './reservePrintStore';

export function openReservePrint(packet:ReservePackage,popup:Window){
  if(!packet.pending)throw Error('印刷対象がありません。');
  const ids=new Set(packet.pending.ids),tickets=packet.tickets.filter(t=>ids.has(t.id));
  if(tickets.length!==ids.size)throw Error('印刷対象のデータが不足しています。');
  const doc=popup.document;doc.open();doc.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>予備チケット印刷</title><style>${packet.css}\n.reserve-print-actions{padding:16px;font:16px sans-serif}.reserve-print-actions button{padding:12px;font-size:18px}@media print{.reserve-print-actions{display:none!important}}</style></head><body></body></html>`);
  doc.title=packet.eventName+' - 予備チケット';
  const actions=doc.createElement('nav');actions.className='reserve-print-actions';
  const retry=doc.createElement('button');retry.textContent='印刷する';retry.onclick=()=>popup.print();
  const help=doc.createElement('p');help.textContent='紙が正しく出たら、元の予備印刷画面で「印刷完了して次へ」を押してください。';actions.append(retry,help);doc.body.appendChild(actions);
  const sheet=doc.createElement('div');sheet.className='ticket-print-sheet';sheet.setAttribute('style',packet.sheetStyle);
  tickets.forEach((ticket,i)=>{
    if(i%packet.columns===0){const row=doc.createElement('div');row.className='ticket-print-row';sheet.appendChild(row);}
    const host=doc.createElement('div');host.innerHTML=packet.template;
    const card=host.querySelector<HTMLElement>('.ticket-print-card'),qr=card?.querySelector('.ticket-design-qr'),number=card?.querySelector('.ticket-design-number');
    if(!card||!qr||!number)throw Error('印刷デザインが不完全です。');
    qr.innerHTML=ticket.svg;number.textContent=ticket.number;sheet.lastElementChild!.appendChild(card);
  });
  doc.body.appendChild(sheet);
  let started=false;const print=()=>{if(started||popup.closed)return;started=true;popup.focus();popup.print();};
  popup.addEventListener('load',print,{once:true});doc.close();if(doc.readyState==='complete')setTimeout(print,300);
}

export function ReservePrintControls({packet,onChange}:{packet:ReservePackage;onChange:(value:ReservePackage)=>void}){
  const [count,setCount]=useState(20),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const done=new Set(packet.confirmed),remaining=packet.tickets.filter(t=>!done.has(t.id));
  useEffect(()=>{setCount(current=>Math.max(1,Math.min(current,remaining.length||1)));},[remaining.length]);
  const update=async()=>{const current=await loadReservePackage(packet.eventId);if(current)onChange(current);};
  const print=async(repeat=false)=>{
    if(busy)return;setError('');
    const popup=window.open('','_blank');if(!popup){setError('印刷画面を開けません。ポップアップを許可してください。');return;}
    setBusy(true);
    try{
      const latest=repeat?await loadReservePackage(packet.eventId):await claimReserveBatch(packet.eventId,count);
      if(!latest?.pending||(repeat&&latest.pending.id!==packet.pending?.id))throw Error('印刷状態が変わりました。状態を更新してください。');
      onChange(latest);openReservePrint(latest,popup);
    }catch(e){popup.close();setError(e instanceof Error?e.message:'印刷を準備できませんでした。');await update().catch(()=>{});}finally{setBusy(false);}
  };
  const finish=async(printed:boolean)=>{
    if(!packet.pending||busy)return;
    if(!window.confirm(printed?'紙が正しく出たことを確認しましたか？この分を印刷済みにして次の番号へ進みます。':'手元にこの分の印刷物がないことを確認してください。番号を未印刷に戻します。'))return;
    setBusy(true);setError('');try{onChange(await finishReserveBatch(packet.eventId,packet.pending.id,printed));}catch(e){setError(e instanceof Error?e.message:'印刷記録を保存できませんでした。');await update().catch(()=>{});}finally{setBusy(false);}
  };
  return <div className="reserve-print-controls">
    <p>予備 {packet.tickets.length}枚／印刷済み {packet.tickets.filter(t=>done.has(t.id)).length}枚／残り {remaining.length}枚</p>
    <p>次の番号：<strong>{remaining[0]?.number??'予備を使い切りました'}</strong></p>
    {packet.pending?<><p role="status">{packet.pending.ids.length}枚が印刷確認待ちです。紙が出るまで次の番号へは進みません。</p><p>再印刷する場合は、先に出た同じ番号の紙を回収してください。</p><button disabled={busy} onClick={()=>void print(true)}>同じ分を再印刷</button><button disabled={busy} onClick={()=>void finish(true)}>印刷完了して次へ</button><button disabled={busy} onClick={()=>void finish(false)}>印刷を中止・未印刷に戻す</button></>:<><label>今回の印刷枚数<input aria-label="予備の印刷枚数" type="number" min="1" max={remaining.length} value={count} onChange={e=>setCount(Number(e.target.value))}/></label><button disabled={busy||!remaining.length} onClick={()=>void print()}>予備チケットを印刷</button></>}
    <button disabled={busy} onClick={()=>void update().catch(()=>setError('状態を取得できませんでした。'))}>印刷状態を更新</button>
    <p>印刷記録はこの端末・ブラウザー内のものです。予備印刷は1台で担当してください。印刷画面を閉じただけでは印刷済みになりません。</p>
    {error&&<p role="alert">{error}</p>}
  </div>;
}

export function ReserveConfiguration({eventId,tickets,build,onSaved}:{eventId:string;tickets:{id:string;qrNumber:string;valid:boolean;status:string;reserve?:boolean}[];build:(ids:string[])=>Promise<ReservePackage>;onSaved:(ids:string[])=>void}){
  const issuedReserves=tickets.filter(t=>t.reserve===true);
  const [useIssued,setUseIssued]=useState(true);
  const [start,setStart]=useState(501),[end,setEnd]=useState(700),[packet,setPacket]=useState<ReservePackage|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{let active=true;void loadReservePackage(eventId).then(p=>{if(!active||!p)return;setPacket(p);setStart(Number(p.tickets[0].number));setEnd(Number(p.tickets.at(-1)!.number));}).catch(()=>setError('予備印刷の保存状態を読み込めませんでした。'));return()=>{active=false;};},[eventId]);
  const save=async()=>{if(busy)return;setBusy(true);setError('');try{const selected=useIssued&&issuedReserves.length?issuedReserves.filter(t=>t.valid&&t.status==='unused').sort((a,b)=>Number(a.qrNumber)-Number(b.qrNumber)):selectReserveTickets(tickets,start,end);if(!selected.length)throw Error('保存できる未使用の予備がありません。');const ids=selected.map(t=>t.id);const p=await saveReservePackage(await build(ids));setPacket(p);onSaved(ids);}catch(e){setError(e instanceof Error?e.message:'予備印刷を保存できませんでした。');}finally{setBusy(false);}};
  return <div className="reserve-print-controls"><p>発行済み・未使用のチケット番号から予備分を指定します。発行時に指定した予備は、通常印刷から除外済みです。ここでデザインとQRを保存するとオフラインで印刷できます。</p><p>受付の入場用・退場用の両端末には、予備分を含む全チケットを事前に読み込んでください。デザインを変更したときは、予備分も保存し直してください。</p><label>予備の指定方法<select aria-label="予備の指定方法" value={useIssued&&issuedReserves.length?'issued':'range'} onChange={e=>setUseIssued(e.target.value==='issued')}>{issuedReserves.length>0&&<option value="issued">発行時に指定した予備（{issuedReserves.length}枚）</option>}<option value="range">番号の範囲を指定</option></select></label>{!(useIssued&&issuedReserves.length)&&<><label>予備の開始番号<input aria-label="予備の開始番号" type="number" min="1" value={start} onChange={e=>setStart(Number(e.target.value))}/></label><label>予備の終了番号<input aria-label="予備の終了番号" type="number" min="1" value={end} onChange={e=>setEnd(Number(e.target.value))}/></label></>}<button disabled={busy} onClick={()=>void save()}>{busy?'デザインとQRを保存中…':'予備のデザインとQRを端末に保存'}</button>{error&&<p role="alert">{error}</p>}{packet&&<><p>保存日時：{new Date(packet.preparedAt).toLocaleString('ja-JP')}</p><a href={`?reserve-print=${encodeURIComponent(eventId)}`} target="_blank" rel="noopener">オフライン用の予備印刷画面を開く</a><ReservePrintControls packet={packet} onChange={setPacket}/></>}</div>;
}

export default function OfflineReserveRoot({eventId}:{eventId:string}){
  const [packet,setPacket]=useState<ReservePackage|null>(null),[error,setError]=useState('');
  const [offlineReady,setOfflineReady]=useState(false);
  useEffect(()=>{
    let active=true;
    const check=async()=>{
      if(!('serviceWorker' in navigator)||!('caches' in window))return;
      const reg=await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
      if(!reg?.active||new URL(reg.scope).pathname!==import.meta.env.BASE_URL)return;
      const cache=await caches.open('qr-ticket-management-shell-v1');
      const saved=await cache.match(new URL('index.html',reg.scope).href);
      if(active)setOfflineReady(Boolean(saved));
    };
    void check().catch(()=>{});const timer=setInterval(()=>void check().catch(()=>{}),1500);
    return()=>{active=false;clearInterval(timer);};
  },[]);
  useEffect(()=>{let active=true;void loadReservePackage(eventId).then(p=>{if(!active)return;if(p)setPacket(p);else setError('この端末に予備印刷が保存されていません。オンラインの管理画面で事前準備してください。');}).catch(()=>setError('端末内の予備印刷を読み込めませんでした。'));return()=>{active=false;};},[eventId]);
  return <main className="offline-reserve-root"><h1>予備チケット印刷</h1>{packet?<><h2>{packet.eventName}</h2><p>保存したデザインとQRを使用します。この画面をブックマークし、本番前に通信を切って開き直せることを確認してください。</p><p role="status">{offlineReady?'オフライン起動の準備完了':'オフライン起動の準備を確認中です。オンラインでこの画面を開いてください。'}</p><p>保存日時：{new Date(packet.preparedAt).toLocaleString('ja-JP')}</p><ReservePrintControls packet={packet} onChange={setPacket}/></>:<p role="status">{error||'保存済みデータを読み込んでいます…'}</p>}</main>;
}
