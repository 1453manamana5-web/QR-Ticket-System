import {useEffect,useRef} from "react";
import {Html5Qrcode,Html5QrcodeSupportedFormats} from "html5-qrcode";
import jsQR from "jsqr";
import {findMotionFocus,chooseDetailedCrop,boostQrContrast,type ScanFocus} from "./qrEnhancement";

type Props={
  readerId:string;
  cameraFacing?:"user"|"environment";
  onResult:(text:string)=>void|Promise<void>;
  onError?:(message:string)=>void;
  className?:string;
};

type ExtendedVideoConstraints=MediaTrackConstraints&{
  advanced?:Array<MediaTrackConstraintSet&{
    focusMode?:string|string[];
    exposureMode?:string|string[];
    whiteBalanceMode?:string|string[];
  }>;
};

function isBackCameraLabel(cameraLabel:string){
  const label=cameraLabel.toLowerCase();
  return label.includes("back")||label.includes("rear")||label.includes("environment")||
    label.includes("背面")||label.includes("アウトカメラ");
}

function isFrontCameraLabel(cameraLabel:string){
  const label=cameraLabel.toLowerCase();
  return label.includes("front")||
    label.includes("user")||
    label.includes("facetime")||
    label.includes("前面")||
    label.includes("内側")||
    label.includes("インカメラ");
}

// Serialize start/stop across StrictMode remounts and reader changes. An old
// asynchronous cleanup must finish before another reader acquires the camera.
let cameraLifecycle=Promise.resolve();
function enqueueCameraOperation(operation:()=>Promise<void>){
  cameraLifecycle=cameraLifecycle.then(operation,operation);
}

function stopVideoTracks(reader:HTMLElement|null){
  reader?.querySelectorAll("video").forEach(video=>{
    const stream=video.srcObject;
    if(stream instanceof MediaStream){
      stream.getTracks().forEach(track=>track.stop());
      video.srcObject=null;
    }
  });
}

async function applyFastCameraSettings(scanner:Html5Qrcode){
  // Prefer the sharpest supported capture. An unsupported focus constraint
  // must not undo the resolution settings or prevent scanning.
  try{
    await scanner.applyVideoConstraints({width:{ideal:1920},height:{ideal:1080},frameRate:{ideal:30}});
  }catch(basicError){
    console.warn("端末標準のカメラ画質設定を使用します",basicError);
  }
  // Safari may ignore unsupported constraints; request only supported controls.
  try{
    const exposureConstraints:ExtendedVideoConstraints={advanced:[{exposureMode:"continuous",whiteBalanceMode:"continuous"}]};
    await scanner.applyVideoConstraints(exposureConstraints);
  }catch{console.info("自動露出・ホワイトバランスは端末標準設定を使用します");}
  try{
    const focusConstraints:ExtendedVideoConstraints={advanced:[{focusMode:"continuous"}]};
    await scanner.applyVideoConstraints(focusConstraints);
  }catch(focusError){
    console.info("このカメラは連続フォーカス指定に対応していません",focusError);
  }
}

export default function QrScanner({readerId,onResult,onError,className,cameraFacing="user"}:Props){
  const onResultRef=useRef(onResult);
  const onErrorRef=useRef(onError);

  useEffect(()=>{onResultRef.current=onResult;},[onResult]);
  useEffect(()=>{onErrorRef.current=onError;},[onError]);

  useEffect(()=>{
    let active=true;
    let scanner:Html5Qrcode|null=null;
    const readerElement=document.getElementById(readerId);
    let scanLocked=false;
    let lastDecodedText="";
    let lastDecodedAt=0;
    let lastHandledSeenAt=0;
    let fallbackTimer:number|undefined;
    const fallbackCanvas=document.createElement("canvas");
    const fallbackContext=fallbackCanvas.getContext("2d",{willReadFrequently:true});
    const detailCanvas=document.createElement("canvas");
    const detailContext=detailCanvas.getContext("2d",{willReadFrequently:true});
    const motionCanvas=document.createElement("canvas");
    motionCanvas.width=64;
    motionCanvas.height=36;
    const motionContext=motionCanvas.getContext("2d",{willReadFrequently:true});
    let previousMotionPixels:Uint8ClampedArray|null=null;
    let movingSpot:({focus:ScanFocus;seenAt:number})|null=null;
    let lastQrSpot:({focus:ScanFocus;seenAt:number})|null=null;
    let fallbackPasses=0;
    let fallbackBusy=false;

    const stopCamera=async()=>{
      if(fallbackTimer!==undefined){window.clearInterval(fallbackTimer);fallbackTimer=undefined;}
      const current=scanner;
      scanner=null;
      if(current){
        try{if(current.isScanning)await current.stop();}catch(error){console.warn("QRカメラの停止に失敗しました",error);}
        try{current.clear();}catch(error){console.warn("QR表示領域のクリアに失敗しました",error);}
      }
      // Limit fallback cleanup to this reader; never stop another app's video.
      stopVideoTracks(readerElement);
    };

    const acceptDecoded=(decodedText:string)=>{
      if(!active)return;
      const normalizedValue=decodedText.trim();
      if(!normalizedValue)return;
      const now=performance.now();
      const previousSeenAt=lastHandledSeenAt;
      if(normalizedValue===lastDecodedText)lastHandledSeenAt=now;
      if(scanLocked)return;
      if(normalizedValue===lastDecodedText&&(now-lastDecodedAt<1000||now-previousSeenAt<450))return;
      lastHandledSeenAt=now;
      lastDecodedText=normalizedValue;
      lastDecodedAt=now;
      scanLocked=true;
      void Promise.resolve().then(()=>{if(active)return onResultRef.current(normalizedValue);})
        .catch(error=>console.error("QRコードの受付処理に失敗しました",error))
        .finally(()=>window.setTimeout(()=>{if(active)scanLocked=false;},60));
    };

    // Remember a successfully decoded position, as with tracked objects.
    // Pixel coordinates are converted back to the original camera frame.
    const rememberQrSpot=(
      decoded:NonNullable<ReturnType<typeof jsQR>>,
      sourceX:number,sourceY:number,scaleX:number,scaleY:number,
      videoWidth:number,videoHeight:number
    )=>{
      const location=decoded.location;
      if(!location)return;
      const points=[location.topLeftCorner,location.topRightCorner,
        location.bottomLeftCorner,location.bottomRightCorner];
      const meanX=points.reduce((sum,point)=>sum+point.x,0)/points.length;
      const meanY=points.reduce((sum,point)=>sum+point.y,0)/points.length;
      const x=(sourceX+meanX*scaleX)/videoWidth;
      const y=(sourceY+meanY*scaleY)/videoHeight;
      if(Number.isFinite(x)&&Number.isFinite(y)){
        lastQrSpot={focus:{x:Math.max(0,Math.min(1,x)),y:Math.max(0,Math.min(1,y))},seenAt:performance.now()};
      }
    };

    // The standard reader remains the fast path. On failure, inspect
    // native-resolution regions (not digitally enlarged low-res pixels).
    // Small motion gives a temporary candidate; fixed presets still cover
    // stationary tickets. No images are recorded, uploaded or persisted.
    const fallbackDecode=()=>{
      if(!active||scanLocked||fallbackBusy||!fallbackContext||!readerElement||
          document.visibilityState==="hidden")return;
      const video=readerElement.querySelector("video");
      if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return;
      fallbackBusy=true;
      try{
        const now=performance.now();
        const width=Math.min(960,video.videoWidth);
        const height=Math.max(1,Math.round(width*video.videoHeight/video.videoWidth));
        if(fallbackCanvas.width!==width)fallbackCanvas.width=width;
        if(fallbackCanvas.height!==height)fallbackCanvas.height=height;
        fallbackContext.drawImage(video,0,0,width,height);
        const frame=fallbackContext.getImageData(0,0,width,height);
        const decoded=jsQR(frame.data,width,height,{inversionAttempts:"attemptBoth"});
        if(decoded?.data){
          rememberQrSpot(decoded,0,0,video.videoWidth/width,video.videoHeight/height,video.videoWidth,video.videoHeight);
          acceptDecoded(decoded.data);
          return;
        }

        fallbackPasses++;
        // A tiny motion thumbnail costs much less than running an AI model
        // and proposes which area might contain the held-up ticket.
        if(motionContext){
          motionContext.drawImage(video,0,0,motionCanvas.width,motionCanvas.height);
          const thumbnail=motionContext.getImageData(0,0,motionCanvas.width,motionCanvas.height);
          const focus=findMotionFocus(previousMotionPixels,thumbnail.data,motionCanvas.width,motionCanvas.height);
          previousMotionPixels=new Uint8ClampedArray(thumbnail.data);
          if(focus)movingSpot={focus,seenAt:now};
        }
        // Limit expensive full-resolution attempts to approximately 1.4/s.
        if(fallbackPasses%2!==0||!detailContext)return;
        const focus=lastQrSpot&&now-lastQrSpot.seenAt<8000 ? lastQrSpot.focus
          : movingSpot&&now-movingSpot.seenAt<1400 ? movingSpot.focus : null;
        const detailPass=fallbackPasses/2;
        const crop=chooseDetailedCrop(video.videoWidth,video.videoHeight,detailPass,focus);
        if(!crop)return;
        if(detailCanvas.width!==crop.size)detailCanvas.width=crop.size;
        if(detailCanvas.height!==crop.size)detailCanvas.height=crop.size;
        detailContext.drawImage(video,crop.x,crop.y,crop.size,crop.size,0,0,crop.size,crop.size);
        const region=detailContext.getImageData(0,0,crop.size,crop.size);
        let closeUp=jsQR(region.data,crop.size,crop.size,{inversionAttempts:"attemptBoth"});
        // Only rarely pay for an additional low-light contrast pass.
        if(!closeUp && detailPass%3===0){
          boostQrContrast(region);
          closeUp=jsQR(region.data,crop.size,crop.size,{inversionAttempts:"attemptBoth"});
        }
        if(closeUp?.data){
          rememberQrSpot(closeUp,crop.x,crop.y,1,1,video.videoWidth,video.videoHeight);
          acceptDecoded(closeUp.data);
        }
      }catch(error){console.debug("補助QR解析をスキップしました",error);}
      finally{fallbackBusy=false;}
    };

    const startCamera=async()=>{
      try{
        if(!active)return;
        if(!readerElement)throw new Error("カメラ表示領域が見つかりません。");
        readerElement.innerHTML="";

        const instance=new Html5Qrcode(readerId,{
          formatsToSupport:[Html5QrcodeSupportedFormats.QR_CODE],
          useBarCodeDetectorIfSupported:true,
          verbose:false
        });
        scanner=instance;

        const cameras=await Html5Qrcode.getCameras();
        if(!active){await stopCamera();return;}
        if(cameras.length===0)throw new Error("使用できるカメラが見つかりませんでした。");

        // Prefer a known device ID on iPad/Safari. If labels are hidden,
        // facingMode asks the browser rather than guessing the camera order.
        const preferredCamera=cameras.find(camera=>cameraFacing==="user"
          ?isFrontCameraLabel(camera.label):isBackCameraLabel(camera.label));
        const cameraConfig:string|MediaTrackConstraints=preferredCamera?.id??
          {facingMode:{exact:cameraFacing}};
        console.info("使用するQRカメラ:",preferredCamera?.label||cameraFacing);
        await instance.start(
          cameraConfig,
          {
            fps:30,
            qrbox:(viewfinderWidth,viewfinderHeight)=>{
              const minimumSide=Math.min(viewfinderWidth,viewfinderHeight);
              const calculatedSize=Math.min(450,Math.floor(minimumSide*0.9));
              const availableSize=Math.max(160,minimumSide-16);
              const finalSize=Math.min(calculatedSize,availableSize);
              return {width:finalSize,height:finalSize};
            },
            // Front camera previews can be mirrored on iPad. Try both
            // orientations instead of skipping half of the QR candidates.
            disableFlip:cameraFacing==="environment"
          },
          acceptDecoded,
          ()=>undefined
        );

        if(!active){await stopCamera();return;}
        await applyFastCameraSettings(instance);
        if(active)fallbackTimer=window.setInterval(fallbackDecode,350);
      }catch(reason){
        console.error("QRカメラの読み取りを開始できませんでした",reason);
        await stopCamera();
        if(active){
          const message=reason instanceof Error
            ? `カメラを起動できませんでした: ${reason.message}`
            : "カメラを起動できませんでした。Safariのカメラ許可を確認してください。";
          onErrorRef.current?.(message);
        }
      }
    };

    enqueueCameraOperation(startCamera);
    return()=>{
      active=false;
      scanLocked=true;
      enqueueCameraOperation(stopCamera);
    };
  },[readerId,cameraFacing]);

  return <div id={readerId} className={className??"qr-reader"} aria-label={cameraFacing==="user"?"前面カメラのQRコード読み取りエリア":"背面カメラのQRコード読み取りエリア"}/>;
}
