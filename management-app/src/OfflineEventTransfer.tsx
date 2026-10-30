import {useState} from 'react';
import {QRCodeSVG} from 'qrcode.react';
import {renderToStaticMarkup} from 'react-dom/server';
import {encodeOfflineEvent,type OfflineEventData} from '../../shared/src/offlineTransfer';

export default function OfflineEventTransfer({data}:{data:OfflineEventData}){
  const [frames,setFrames]=useState<string[]>([]),[index,setIndex]=useState(0),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [label,setLabel]=useState('');
  const prepare=async()=>{if(busy)return;setBusy(true);setError('');try{const snapshot=data;setFrames(await encodeOfflineEvent(snapshot));setLabel(`${snapshot.event.eventName}・版 ${snapshot.event.dataVersion}・${snapshot.tickets.length}枚・${new Date().toLocaleString('ja-JP')}`);setIndex(0);}catch(e){setError(e instanceof Error?e.message:'QRを作成できませんでした。');}finally{setBusy(false);}};
  const save=()=>{
    const escapedLabel=label.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
    const svgs=frames.map(value=>renderToStaticMarkup(<QRCodeSVG value={value} size={480} level="M" marginSize={4}/>));
    // Only generated SVGs and numeric page indexes enter this document.
    const html=`<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>オフラインイベントQR</title><style>body{text-align:center;font:18px sans-serif;margin:16px;background:white;color:black}svg{max-width:90vw;height:auto}button{font-size:20px;padding:14px;margin:8px}.page{display:block;margin-bottom:32px}@media print{.page{display:block!important;break-after:page}nav{display:none}}</style><h1>オフラインイベントQR</h1><p>${escapedLabel}</p><p>受付で全てのQRを読み取ってください。</p>${svgs.map((svg,i)=>`<section class="page"><h2>${i+1} / ${svgs.length}</h2>${svg}</section>`).join('')}</html>`;
    const url=URL.createObjectURL(new Blob([html],{type:'text/html'})),a=document.createElement('a');a.href=url;a.download='offline-event-qr.html';a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
  };
  return <section className="auth-card"><div><h2>オフライン受け渡しQR</h2><p>管理者の画面から、受付で全てのQRを読み取ってください。データは作成時点の内容です。受付開始前に作成してください。</p><button className="secondary" disabled={busy} onClick={prepare}>{busy?'作成中…':'オフラインQRを作成・更新'}</button>{error&&<p role="alert">{error}</p>}{frames.length>0&&<><p>この画面を離れても使えるよう、QRをHTMLファイルに保存できます。通信を切る前に保存したファイルをブラウザーで開いて確認してください。</p><button className="secondary" onClick={save}>QRをファイルに保存</button><p>このQRには全チケット情報が含まれます。管理者と受付担当者の間で受け渡してください。</p></>}</div>{frames.length>0&&<div style={{background:'white',color:'black',padding:16,textAlign:'center'}}><p>{label}</p><strong>{index+1} / {frames.length}</strong><QRCodeSVG value={frames[index]} size={400} level="M" marginSize={4} style={{display:'block',maxWidth:'100%',height:'auto'}}/><button className="secondary" disabled={index===0} onClick={()=>setIndex(i=>i-1)}>前のQR</button><button className="secondary" disabled={index===frames.length-1} onClick={()=>setIndex(i=>i+1)}>次のQR</button></div>}</section>;
}
