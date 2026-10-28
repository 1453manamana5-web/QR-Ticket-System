type Sound = "detected" | "success" | "error";
const files:Record<Sound,string>={detected:"qr_scan_detected.wav",success:"qr_result_chime.wav",error:"qr_gate_error_chime_v1.wav"};
let context:AudioContext|null=null;
let resultVersion=0;
const buffers=new Map<Sound,Promise<AudioBuffer>>();
const fallback=new Map<Sound,HTMLAudioElement>();
const active=new Map<Sound,AudioBufferSourceNode>();
const mediaPreferred=new Set<Sound>();
function getContext(){
  if(context?.state==="closed"){context=null;buffers.clear();}
  if(!context){const Constructor=window.AudioContext||window.webkitAudioContext;if(Constructor)context=new Constructor();}
  return context;
}
function path(kind:Sound){return `${import.meta.env.BASE_URL}sounds/${files[kind]}`;}
function buffer(kind:Sound){
  let value=buffers.get(kind);if(value)return value;
  const ctx=getContext();if(!ctx)return null;
  value=fetch(path(kind)).then(response=>{if(!response.ok)throw Error(`Audio HTTP ${response.status}`);return response.arrayBuffer();}).then(data=>ctx.decodeAudioData(data));
  buffers.set(kind,value);void value.catch(()=>buffers.delete(kind));return value;
}
function element(kind:Sound){let audio=fallback.get(kind);if(!audio){audio=new Audio(path(kind));audio.preload="auto";fallback.set(kind,audio);}return audio;}
function unlockReceptionAudio(){
  try{
    const ctx=getContext();
    if(ctx && ctx.state!=="running"){
      // Run resume and the silent priming source directly in the user gesture.
      void ctx.resume().catch(()=>{});
      if(typeof ctx.createBuffer==="function"){
        const source=ctx.createBufferSource();source.buffer=ctx.createBuffer(1,1,ctx.sampleRate||44100);
        source.connect(ctx.destination);source.onended=()=>source.disconnect();source.start(0);
      }
    }
  }catch(error){console.warn("受付音の有効化に失敗しました",error);}
}
export function prepareReceptionAudio(){
  for(const kind of Object.keys(files) as Sound[]){try{const ready=buffer(kind);if(ready)void ready.catch(()=>{});else element(kind).load();}catch(error){console.warn("受付音を先読みできませんでした",error);}}
  // Touch pointerdown is not an activation event on every Safari version.
  const events=["pointerdown","touchend","click","keydown"] as const;
  const options={passive:true,capture:true};
  for(const event of events)document.addEventListener(event,unlockReceptionAudio,options);
  return()=>{for(const event of events)document.removeEventListener(event,unlockReceptionAudio,options);};
}
async function resumeForPlayback(ctx:AudioContext){
  const running=()=>ctx.state==="running";
  if(running())return;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([ctx.resume(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error("Audio resume timeout")),350);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
  if(!running())throw Error("Audio is not running");
}
export function getReceptionAudioSettings(){
  try{
    const value=JSON.parse(localStorage.getItem("qr-ticket-app-settings")??"{}");
    return {volume:typeof value?.volume === "number" && Number.isFinite(value.volume)?Math.max(0,Math.min(100,value.volume))/100:1,successSound:value?.successSound!==false,voiceGuidance:value?.voiceGuidance!==false};
  }catch{return {volume:1,successSound:true,voiceGuidance:true};}
}
export async function playReceptionAudio(kind:Sound){
  const version=kind==="detected"?resultVersion:++resultVersion;
  if(kind!=="detected")for(const previous of ["success","error"] as Sound[]){try{active.get(previous)?.stop();}catch{}fallback.get(previous)?.pause();}
  const preferences=getReceptionAudioSettings();
  if(preferences.volume===0 || (kind==="success"&&!preferences.successSound))return "muted";
  const current=()=>version===resultVersion;
  try{
    const ctx=mediaPreferred.has(kind)?null:getContext(),ready=ctx?buffer(kind):null;
    if(ctx&&ready){
      // Observe decode failures immediately even while resume is pending.
      void ready.catch(()=>{});
      await resumeForPlayback(ctx);
      const data=await ready;
      if(!current())return "superseded";
      try{active.get(kind)?.stop();}catch{}
      const source=ctx.createBufferSource();source.buffer=data;
      const gain=typeof ctx.createGain==="function"?ctx.createGain():null;if(gain){gain.gain.value=preferences.volume;gain.connect(ctx.destination);}source.connect(gain??ctx.destination);
      active.set(kind,source);source.onended=()=>{source.disconnect();gain?.disconnect();if(active.get(kind)===source)active.delete(kind);};
      source.start();return "played";
    }
  }catch(error){mediaPreferred.add(kind);console.warn("Web Audioで再生できないため音声プレーヤーへ切り替えます",error);}
  if(!current())return "superseded";
  try{
    const audio=element(kind);audio.pause();audio.currentTime=0;audio.volume=preferences.volume;await audio.play();return "played";
  }catch(error){console.warn("受付音を再生できませんでした。音の確認を押してください。",error);return "blocked";}
}
