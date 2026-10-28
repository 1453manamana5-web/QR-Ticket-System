type Sound = "detected" | "success" | "error";
const files:Record<Sound,string>={detected:"qr_scan_detected.wav",success:"qr_result_chime.wav",error:"qr_gate_error_chime_v1.wav"};
const players=new Map<Sound,HTMLAudioElement>();
const objectUrls=new Map<Sound,string>();
const generations=new Map<Sound,number>();
const unlocked=new Set<Sound>();
let preload:Promise<void>|null=null;
function path(kind:Sound){return `${import.meta.env.BASE_URL}sounds/${files[kind]}`;}
function next(kind:Sound){const version=(generations.get(kind)??0)+1;generations.set(kind,version);return version;}
function player(kind:Sound){
  let audio=players.get(kind);
  if(!audio){audio=new Audio(path(kind));audio.preload="auto";audio.volume=1;audio.load();players.set(kind,audio);}
  const cached=objectUrls.get(kind);
  if(cached&&audio.src!==cached&&audio.paused){audio.src=cached;audio.load();}
  return audio;
}
function preloadSounds(){
  if(preload)return preload;
  preload=Promise.all((Object.keys(files) as Sound[]).map(async kind=>{
    player(kind);
    try{
      let cache:Cache|undefined;
      try{if(window.caches)cache=await window.caches.open("qr-reception-sounds-v2");}catch{/* private browsing can deny Cache Storage */}
      let response=await cache?.match(path(kind));
      if(!response?.ok){response=await fetch(path(kind));if(!response.ok)throw Error(`Audio HTTP ${response.status}`);try{await cache?.put(path(kind),response.clone());}catch{/* playback still works without a cache write */}}
      // The legacy app uses Blob URLs: iPad's media player need not make Range
      // requests against the service worker's complete cached WAV response.
      const url=URL.createObjectURL(await response.blob());objectUrls.set(kind,url);
      player(kind);
    }catch(error){console.warn("受付音の端末保存に失敗しました。元の音源で再生します。",error);}
  })).then(()=>{});
  return preload;
}
function unlockRecordedSounds(){
  const preferences=getReceptionAudioSettings();
  if(preferences.volume===0)return;
  // Like the old receptionSound.ts, prime each reusable media element inside
  // the gesture. Never await network/cache preparation before calling play().
  for(const kind of Object.keys(files) as Sound[]){
    if(unlocked.has(kind)||(kind==="success"&&!preferences.successSound))continue;
    const audio=player(kind),version=next(kind);
    try{
      audio.pause();audio.currentTime=0;audio.volume=.01;
      void audio.play().then(()=>{
        // A delayed unlock must not pause/mute a newer real scan or test sound.
        if(generations.get(kind)===version){unlocked.add(kind);audio.pause();audio.currentTime=0;audio.volume=preferences.volume;}
      }).catch(()=>{if(generations.get(kind)===version)audio.volume=preferences.volume;});
    }catch{/* retry on the next gesture */}
  }
}
export function prepareReceptionAudio(){
  void preloadSounds();
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
export async function playReceptionAudio(kind:Sound){
  const preferences=getReceptionAudioSettings();
  if(kind!=="detected")for(const previous of ["success","error"] as Sound[]){if(previous!==kind)next(previous);players.get(previous)?.pause();}
  const version=next(kind);
  if(preferences.volume===0||(kind==="success"&&!preferences.successSound)){players.get(kind)?.pause();return "muted";}
  try{
    const audio=player(kind);audio.pause();audio.currentTime=0;audio.volume=preferences.volume;
    // HTMLAudio is the primary legacy playback path, even if AudioContext exists.
    // Calling play synchronously preserves the tap's activation on Safari.
    await audio.play();
    if(generations.get(kind)!==version)return "superseded";
    unlocked.add(kind);return "played";
  }catch(error){unlocked.delete(kind);console.warn("受付音を再生できません。音の確認を押してください。",error);return "blocked";}
}
