// Research worker: no DOM, camera access, or image persistence.
const remote='https://cdn.jsdelivr.net/gh/alanross/AlvaAR@7796af500ee92001ac2a9888363ff64d7a3bee75/dist/alva_ar.js';
let engine=null,width=0,height=0;
self.onmessage=async ({data:m})=>{
 try{
  if(m.type==='init'){
   if(engine)throw Error('Already initialized');
   if(!['cdn','local'].includes(m.source))throw Error('Unsupported source');
   width=m.width;height=m.height;
   if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width*height>2000000)throw Error('Invalid frame dimensions');
   const mod=await import(m.source==='local'?'./vendor/alva_ar.js':remote);
   if(typeof mod.AlvaAR?.Initialize!=='function')throw Error('SLAM API not available');
   engine=await mod.AlvaAR.Initialize(width,height);
   self.postMessage({type:'ready'});
  }else if(m.type==='frame'){
   if(!engine||m.width!==width||m.height!==height||!(m.data instanceof Uint8ClampedArray)||m.data.length!==width*height*4)throw Error('Invalid frame');
   const start=performance.now();
   const pose=engine.findCameraPose({data:m.data,width,height});
   const points=engine.getFramePoints()||[];
   const poseArray=pose?Array.from(pose):null;
   const processingMs=performance.now()-start+(Number.isFinite(m.copyMs)?m.copyMs:0);
   let plane=null,planeError=null,planeMs=null;
   if(m.detectPlane){
    const ps=performance.now();
    try{
     if(!poseArray||!poseArray.every(Number.isFinite))throw Error('姿勢が未取得です');
     if(typeof engine.findPlane!=='function')throw Error('平面推定API非対応');
     const result=engine.findPlane(100);
     if(result&&result.length===16&&Array.from(result).every(Number.isFinite))plane=Array.from(result);
     else planeError='平面候補を取得できませんでした';
    }catch(e){planeError=e?.message||String(e)}
    planeMs=performance.now()-ps;
   }
   self.postMessage({type:'result',pose:poseArray,points,processingMs,planeRequested:!!m.detectPlane,plane,planeError,planeMs});
  }
 }catch(e){self.postMessage({type:'error',message:e?.message||String(e)});}
};
