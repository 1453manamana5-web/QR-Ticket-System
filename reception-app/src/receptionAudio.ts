type Sound = "detected" | "success" | "error" | "entryGuidance" | "entrySuccess";
const files:Record<Sound,string>={detected:"qr_scan_detected.wav",success:"qr_result_chime.wav",error:"qr_gate_error_chime_v1.wav",entryGuidance:"entry_osusumi_voice_d_v1.mp3",entrySuccess:"entry_success_voice_d_v1.mp3"};
const objectUrls=new Map<Sound,string>();
let media:HTMLAudioElement|null=null;
let activeKind:Sound|null=null;
let mediaSource="";
let generation=0;
let unlocked=false;
let preload:Promise<void>|null=null;
function path(kind:Sound){return `${import.meta.env.BASE_URL}sounds/${files[kind]}`;}
function player(kind:Sound){
  const src=objectUrls.get(kind)??path(kind);
  if(!media){media=new Audio(src);mediaSource=src;media.preload="auto";media.load();}
  else if(mediaSource!==src){media.pause();media.src=src;mediaSource=src;media.load();}
  activeKind=kind;
  return media;
}
function preloadSounds(){
  if(preload)return preload;
  let failed=false;
  preload=Promise.all((Object.keys(files) as Sound[]).map(async kind=>{
    if(objectUrls.has(kind))return;
    try{
      let cache:Cache|undefined;
      try{if(window.caches)cache=await window.caches.open("qr-reception-sounds-v2");}catch{/* Cache Storage may be unavailable */}
      let response=await cache?.match(path(kind));
      if(!response?.ok){response=await fetch(path(kind));if(!response.ok)throw Error(`Audio HTTP ${response.status}`);try{await cache?.put(path(kind),response.clone());}catch{/* Playback can still use the downloaded blob. */}}
      objectUrls.set(kind,URL.createObjectURL(await response.blob()));
      // Do not replace a source during playback or after gesture activation.
      // The cached source is applied only at the next explicit play request.
    }catch(error){failed=true;console.warn("受付音の端末保存に失敗しました。元の音源で再生します。",error);}
  })).then(()=>{if(failed)preload=null;});
  return preload;
}
function unlockRecordedSounds(){
  void preloadSounds();
  const preferences=getReceptionAudioSettings();
  if(unlocked||preferences.volume===0||(media&&!media.paused))return;
  // Safari activation belongs to this single reusable element, not to each file.
  // Play inside the gesture, without waiting for downloads or cache reads.
  const audio=player(preferences.voiceGuidance?(preferences.successSound?"entrySuccess":"entryGuidance"):"detected"),version=++generation;
  try{
    audio.volume=.01;audio.currentTime=0;
    void audio.play().then(()=>{
      if(generation===version){unlocked=true;audio.pause();audio.currentTime=0;audio.volume=preferences.volume;}
    }).catch(()=>{if(generation===version)audio.volume=preferences.volume;});
  }catch{/* retry on the next gesture */}
}
export function prepareReceptionAudio(){
  player("success");void preloadSounds();
  const events=["pointerdown","touchend","click","keydown"] as const;
  const options={passive:true,capture:true};
  for(const event of events)document.addEventListener(event,unlockRecordedSounds,options);
  return()=>{for(const event of events)document.removeEventListener(event,unlockRecordedSounds,options);};
}
export function getReceptionAudioSettings(){
  try{
    const value=JSON.parse(localStorage.getItem("qr-ticket-app-settings")??"{}");
    return {volume:typeof value?.volume === "number" && Number.isFinite(value.volume)?Math.max(0,Math.min(100,value.volume))/100:1,successSound:value?.successSound!==false,voiceGuidance:value?.voiceGuidance!==false};
  }catch{return {volume:1,successSound:true,voiceGuidance:true};}
}
export function enableReceptionVoice(){
  try{
    const parsed=JSON.parse(localStorage.getItem("qr-ticket-app-settings")??"{}");
    const settings=parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:{};
    const volume=getReceptionAudioSettings().volume;
    localStorage.setItem("qr-ticket-app-settings",JSON.stringify({...settings,voiceGuidance:true,volume:volume>0?volume*100:70}));
    return true;
  }catch{return false;}
}
export function stopReceptionGuidance(){
  if(activeKind!=="entryGuidance"&&activeKind!=="entrySuccess")return;
  ++generation;media?.pause();if(media)media.currentTime=0;
}
export async function playReceptionAudio(kind:Sound){
  const preferences=getReceptionAudioSettings();
  const isVoice=kind==="entryGuidance"||kind==="entrySuccess";
  if(preferences.volume===0||(kind==="success"&&!preferences.successSound)||(isVoice&&!preferences.voiceGuidance))return "muted";
  const selected=kind==="entrySuccess"&&!preferences.successSound?"entryGuidance":kind;
  const version=++generation;
  try{
    const audio=player(selected);audio.pause();audio.currentTime=0;audio.volume=preferences.volume;
    await audio.play();
    if(generation!==version)return "superseded";
    unlocked=true;return "played";
  }catch(error){
    if(generation!==version)return "superseded";
    unlocked=false;console.warn("受付音を再生できません。音声を有効にして確認してください。",error);return "blocked";
  }
}
