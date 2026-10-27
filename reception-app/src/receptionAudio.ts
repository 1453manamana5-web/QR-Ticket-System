type Sound = "detected" | "success" | "error";
const files:Record<Sound,string>={detected:"qr_scan_detected.wav",success:"qr_result_chime.wav",error:"qr_gate_error_chime_v1.wav"};
let context:AudioContext|null=null;
let resultVersion=0;
const buffers=new Map<Sound,Promise<AudioBuffer>>();
const fallback=new Map<Sound,HTMLAudioElement>();
const active=new Map<Sound,AudioBufferSourceNode>();
function getContext(){
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
export function prepareReceptionAudio(){
  const unlock=()=>{
    try{const ctx=getContext();if(ctx){void ctx.resume().catch(()=>{});}else{for(const kind of Object.keys(files) as Sound[]){const audio=element(kind);audio.volume=0;void audio.play().then(()=>{audio.pause();audio.currentTime=0;audio.volume=1;}).catch(()=>{audio.volume=1;});}}}catch(error){console.warn("受付音の有効化に失敗しました",error);}
  };
  for(const kind of Object.keys(files) as Sound[]){try{const ready=buffer(kind);if(ready)void ready.catch(()=>{});else element(kind).load();}catch(error){console.warn("受付音を先読みできませんでした",error);}}
  document.addEventListener("pointerdown",unlock,{passive:true});document.addEventListener("keydown",unlock);
  return()=>{document.removeEventListener("pointerdown",unlock);document.removeEventListener("keydown",unlock);};
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
  if(preferences.volume===0 || (kind==="success"&&!preferences.successSound))return;
  try{
    const ctx=getContext(),ready=buffer(kind);
    if(ctx&&ready){if(ctx.state!=="running")await ctx.resume();const data=await ready;if(version!==resultVersion)return;try{active.get(kind)?.stop();}catch{}const source=ctx.createBufferSource();source.buffer=data;const gain=typeof ctx.createGain === "function"?ctx.createGain():null;if(gain){gain.gain.value=preferences.volume;gain.connect(ctx.destination);}source.connect(gain??ctx.destination);active.set(kind,source);source.onended=()=>{source.disconnect();gain?.disconnect();if(active.get(kind)===source)active.delete(kind);};source.start();return;}
    const audio=element(kind);audio.pause();audio.currentTime=0;audio.volume=preferences.volume;await audio.play();
  }catch(error){console.warn("受付音を再生できませんでした。画面を一度タップしてください。",error);}
}
