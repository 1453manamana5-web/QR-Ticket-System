import {useState} from 'react';

/** Practice-only scanner: no camera, Firebase, device identity or reception writes. */
export default function GuideReceptionPractice(){
  const [running,setRunning]=useState(false),[mode,setMode]=useState<'entry'|'exit'>('entry'),[status,setStatus]=useState<'unused'|'inside'|'exited'>('unused');
  const [result,setResult]=useState('受付を開始してください。'),[error,setError]=useState(false),[visitors,setVisitors]=useState(0);
  const scan=()=>{
    setError(false);
    if(mode==='entry'){
      if(status==='inside'){setResult('エラー：このチケットは入場済みです。');setError(true);return;}
      setResult(status==='exited'?'再入場を受け付けました。ご来場ありがとうございます。':'入場を受け付けました。ご来場ありがとうございます。');
      if(status==='unused')setVisitors(v=>v+1);setStatus('inside');
    }else{
      if(status!=='inside'){setResult('エラー：入場中のチケットではありません。');setError(true);return;}
      setResult('退場を受け付けました。ご来場ありがとうございました。');setStatus('exited');
    }
  };
  return <section className={`guide-reception-practice ${error?'is-error':mode}`}>
    <header><small>受付の練習・カメラは使用しません</small><h2>{mode==='entry'?'入口受付':'出口受付'}</h2><button onClick={()=>{setMode(v=>v==='entry'?'exit':'entry');setError(false);}}>{mode==='entry'?'出口受付へ切り替え':'入口受付へ切り替え'}</button></header>
    <div className="guide-reception-result" role="status">{result}</div>
    <p>初回来場者 {visitors}人 ／ 入場中 {status==='inside'?1:0}人</p>
    {running?<><button onClick={scan}>練習QRを読み取る</button><button onClick={()=>{setRunning(false);setResult('受付を停止しました。');}}>受付を停止する</button></>:<button onClick={()=>{setRunning(true);setResult('練習QRの読み取りを待っています。');}}>受付を開始する</button>}
    <p>本番では事前に全データを保存し、実際のカメラ・音・暗所での読み取りを確認してください。複数端末のオフライン状態は即時共有されません。</p>
  </section>;
}
