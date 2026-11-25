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
   self.postMessage({type:'result',pose:pose?Array.from(pose):null,points,processingMs:performance.now()-start+(Number.isFinite(m.copyMs)?m.copyMs:0)});
  }
 }catch(e){self.postMessage({type:'error',message:e?.message||String(e)});}
};
