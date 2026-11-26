import type {Intent} from "./language";

let worker:Worker|undefined;
let sequence=0;
let unavailableUntil=0;

export async function semanticRead(raw:string):Promise<Intent|null> {
  const text=raw.trim().replace(/[。？！?!]+$/,"");
  // Only short, read-only, otherwise unresolved queries go to the local model.
  if(text.length<5||text.length>80||/[0-9０-９]|[；;。\n]|変更|設定|操作|削除|修正|やめ|変え|停止|開場|閉場|再起動|権限|午前|午後|明日|昨日/.test(text)) return null;
  if (typeof Worker==="undefined"||typeof WebAssembly==="undefined"||Date.now()<unavailableUntil) return null;
  const base=new URL(import.meta.env.BASE_URL+"luxnora-assets/",location.origin).href;
  if(!worker) {
    try {
      let check:Response|undefined;
      const cache=typeof caches==="undefined"?undefined:await caches.open("luxnora-model-index-v1").catch(()=>undefined);
      try {
        check=await fetch(base+"ready.json",{signal:AbortSignal.timeout(4000)});
        if(check.ok) await cache?.put(base+"ready.json",check.clone()).catch(()=>{});
      }catch {check=await cache?.match(base+"ready.json");}
      if(!check?.ok||(await check.json()).model!=="ruri-v3-30m") throw Error("Model unavailable");
      worker??=new Worker(new URL("./semantic.worker.ts",import.meta.url),{type:"module"});
    } catch {unavailableUntil=Date.now()+60000;return null;}
  }
  const active=worker;
  const request=++sequence;
  return new Promise(resolve=>{
    const clear=()=>{
      clearTimeout(timer);
      active.removeEventListener("message",response);
      active.removeEventListener("error",broken);
    };
    const broken=()=>{clear();active.terminate();if(worker===active)worker=undefined;unavailableUntil=Date.now()+60000;resolve(null);};
    const response=(message:MessageEvent<{request:number;intent:Intent|null;unavailable?:boolean}>)=>{
      if(message.data.request!==request) return;
      if(message.data.unavailable){broken();return;}
      clear();resolve(message.data.intent);
    };
    const timer=setTimeout(broken,30000);
    active.addEventListener("message",response);
    active.addEventListener("error",broken);
    active.postMessage({request,text,base});
  });
}
