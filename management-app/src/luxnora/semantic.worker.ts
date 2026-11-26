import {knowledge,type Intent} from "./language";

const allowed:Intent[]=["occupancy","entries","exits","dwell","stations","issues","forecast","briefing","readiness","compare","graph","records"];
let model:ReturnType<typeof initialize>|undefined;
async function initialize(base:string) {
  const url=new URL("transformers.min.js",base).href;
  if(new URL(url).origin!==self.location.origin) throw new Error("Unexpected model origin");
  const {env,pipeline}=await import(/* @vite-ignore */ url) as {
    env:{allowRemoteModels:boolean;allowLocalModels:boolean;localModelPath:string;useBrowserCache:boolean;
      backends:{onnx:{wasm:{numThreads:number;wasmPaths:string}}}};
    pipeline:(task:string,name:string,options:{device:string;dtype:string})=>Promise<
      (input:string[],options:{pooling:string;normalize:boolean})=>Promise<{tolist():unknown}>>;
  };
  env.allowRemoteModels=false;
  env.allowLocalModels=true;
  env.localModelPath=base;
  env.useBrowserCache=true;
  env.backends.onnx.wasm!.numThreads=1;
  env.backends.onnx.wasm!.wasmPaths=base+"wasm/";
  const extract=await pipeline("feature-extraction","ruri-v3-30m",{device:"wasm",dtype:"q8"});
  const embed=async (values:string[])=>{
    const result=await extract(values.map(value=>"トピック: "+value),{pooling:"mean",normalize:true});
    return result.tolist() as number[][];
  };
  const references:{intent:Intent;vector:number[]}[]=[];
  for(const intent of allowed) {
    const vectors=await embed([...knowledge[intent]]);
    for(const vector of vectors) references.push({intent,vector});
  }
  return {embed,references};
}
self.onmessage=async ({data}:{data:{request:number;text:string;base:string}})=>{
  try {
    const {embed,references}=await (model??=initialize(data.base));
    const [vector]=await embed([data.text]);
    const ranks=new Map<Intent,number>();
    for(const sample of references) {
      const score=sample.vector.reduce((sum,number,index)=>sum+number*vector[index],0);
      ranks.set(sample.intent,Math.max(ranks.get(sample.intent)??-1,score));
    }
    const [top,next]=[...ranks].sort((a,b)=>b[1]-a[1]);
    const intent=top[1]>=.86&&top[1]-next[1]>=.065?top[0]:null;
    self.postMessage({request:data.request,intent});
  } catch {
    self.postMessage({request:data.request,intent:null,unavailable:true});
  }
};
