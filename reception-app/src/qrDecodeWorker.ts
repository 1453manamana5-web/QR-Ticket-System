// QR decoding runs outside the UI thread so the primary 30fps reader remains responsive.
// Camera frames are transferred, not uploaded or persisted.
import jsQR from "jsqr";
import {boostQrContrast,adaptiveQrThreshold} from "./qrEnhancement";

type Request={
  id:number; width:number; height:number; pixels:ArrayBuffer; detailed:boolean
};
type Result={
  id:number; text:string|null; x?:number; y?:number
};
type Scope={
  onmessage:((event:MessageEvent<Request>)=>void)|null;
  postMessage:(message:Result)=>void
};
const scope=self as unknown as Scope;
scope.onmessage=event=>{
  const {id,width,height,pixels,detailed}=event.data;
  if(!(pixels instanceof ArrayBuffer) || width<1 || height<1 ||
     width*height*4!==pixels.byteLength || width>4096 || height>4096){
    scope.postMessage({id,text:null});return;
  }
  try{
    const raw=new Uint8ClampedArray(pixels);
    let found=jsQR(raw,width,height,{inversionAttempts:"attemptBoth"});
    if(!found && detailed){
      // Rescue attempts run only after a native-resolution decode has failed.
      const rescue=new Uint8ClampedArray(raw);
      boostQrContrast({data:rescue} as ImageData);
      found=jsQR(rescue,width,height,{inversionAttempts:"attemptBoth"});
      if(!found){
        adaptiveQrThreshold({data:rescue,width,height} as ImageData);
        found=jsQR(rescue,width,height,{inversionAttempts:"attemptBoth"});
      }
    }
    if(!found?.data){scope.postMessage({id,text:null});return;}
    const location=found.location;
    const corners=[location.topLeftCorner,location.topRightCorner,
      location.bottomLeftCorner,location.bottomRightCorner];
    scope.postMessage({
      id,text:found.data,
      x:corners.reduce((sum,point)=>sum+point.x,0)/(4*width),
      y:corners.reduce((sum,point)=>sum+point.y,0)/(4*height)
    });
  }catch{
    scope.postMessage({id,text:null});
  }
};
