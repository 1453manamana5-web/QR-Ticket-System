import {useEffect,useRef} from "react";
import {Html5Qrcode,Html5QrcodeSupportedFormats} from "html5-qrcode";
import jsQR from "jsqr";
import QrDecodeWorker from "./qrDecodeWorker?worker&inline";
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
    let lastLegacyAttempt=0;
    let workerRequestId=0;
    let qrWorker:Worker|null=null;
    let workerJob:{
      id:number;start:number;sourceX:number;sourceY:number;
      sourceWidth:number;sourceHeight:number;videoWidth:number;videoHeight:number
    }|null=null;
    const onWorkerMessage=(event:MessageEvent<{
      id:number;text:string|null;x?:number;y?:number
    }>)=>{
      if(!active||!workerJob||event.data.id!==workerJob.id)return;
      const job=workerJob;
      workerJob=null;
      fallbackBusy=false;
      // A primary scan that completed after the worker snapshot wins.
      // Discard slow/stale snapshots instead of accepting the previous ticket.
      if(lastDecodedAt>job.start || performance.now()-job.start>1300)return;
      if(!event.data.text)return;
      if(Number.isFinite(event.data.x)&&Number.isFinite(event.data.y)){
        const x=(job.sourceX+(event.data.x as number)*job.sourceWidth)/job.videoWidth;
        const y=(job.sourceY+(event.data.y as number)*job.sourceHeight)/job.videoHeight;
        lastQrSpot={focus:{x:Math.max(0,Math.min(1,x)),
          y:Math.max(0,Math.min(1,y))},seenAt:performance.now()};
      }
      acceptDecoded(event.data.text);
    };

    const stopCamera=async()=>{
      if(fallbackTimer!==undefined){window.clearInterval(fallbackTimer);fallbackTimer=undefined;}
      if(qrWorker){qrWorker.onmessage=null;qrWorker.onerror=null;qrWorker.terminate();qrWorker=null;}
      workerJob=null;fallbackBusy=false;
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
    // Two-tier scanner: the existing camera reader is always the fast path.
    // An optional worker decodes more candidates without blocking UI/ZXing.
    // Detail crops inspect native sensor pixels, not enlarged low-res frames.
    const fallbackDecode=()=>{
      if(workerJob && performance.now()-workerJob.start>2200){
        // A failed/stalled worker must never block the scanner indefinitely.
        qrWorker?.terminate();qrWorker=null;workerJob=null;fallbackBusy=false;
      }
      if(!active||scanLocked||fallbackBusy||!fallbackContext||!readerElement||
        document.visibilityState==="hidden")return;
      const now=performance.now();
      if(!qrWorker&&now-lastLegacyAttempt<350)return;
      const video=readerElement.querySelector("video");
      if(!video||video.readyState<2||!video.videoWidth||!video.videoHeight)return;
      lastLegacyAttempt=now;
      fallbackBusy=true;
      let handedOff=false;
      try{
        fallbackPasses++;
        // Motion is just a suggestion; stationary tickets still get scanned.
        if(motionContext){
          motionContext.drawImage(video,0,0,motionCanvas.width,motionCanvas.height);
          const thumbnail=motionContext.getImageData(0,0,motionCanvas.width,motionCanvas.height);
          const focus=findMotionFocus(previousMotionPixels,thumbnail.data,
            motionCanvas.width,motionCanvas.height);
          previousMotionPixels=new Uint8ClampedArray(thumbnail.data);
          if(focus)movingSpot={focus,seenAt:now};
        }
        const focus=lastQrSpot&&now-lastQrSpot.seenAt<5500 ? lastQrSpot.focus
          : movingSpot&&now-movingSpot.seenAt<1200 ? movingSpot.focus : null;
        const detailedCrop=fallbackPasses%2===0
          ? chooseDetailedCrop(video.videoWidth,video.videoHeight,
            Math.floor(fallbackPasses/2)-1,focus)
          : null;
        const detailed=!!detailedCrop&&!!detailContext;
        const sourceX=detailed?detailedCrop!.x:0;
        const sourceY=detailed?detailedCrop!.y:0;
        const sourceWidth=detailed?detailedCrop!.size:video.videoWidth;
        const sourceHeight=detailed?detailedCrop!.size:video.videoHeight;
        const width=detailed?sourceWidth:Math.min(960,video.videoWidth);
        const height=detailed?sourceHeight:Math.max(1,
          Math.round(width*video.videoHeight/video.videoWidth));
        const canvas=detailed?detailCanvas:fallbackCanvas;
        const context=detailed?detailContext!:fallbackContext;
        if(canvas.width!==width)canvas.width=width;
        if(canvas.height!==height)canvas.height=height;
        context.drawImage(video,sourceX,sourceY,sourceWidth,sourceHeight,0,0,width,height);
        const frame=context.getImageData(0,0,width,height);
        if(qrWorker){
          const id=++workerRequestId;
          workerJob={id,start:now,sourceX,sourceY,sourceWidth,sourceHeight,
            videoWidth:video.videoWidth,videoHeight:video.videoHeight};
          const pixels=frame.data.buffer as ArrayBuffer;
          qrWorker.postMessage({id,width,height,pixels,detailed},[pixels]);
          handedOff=true;
          return;
        }
        // If workers are blocked/unsupported, keep the proven synchronous fallback.
        let decoded=jsQR(frame.data,width,height,{inversionAttempts:"attemptBoth"});
        if(!decoded&&detailed){
          boostQrContrast(frame);
          decoded=jsQR(frame.data,width,height,{inversionAttempts:"attemptBoth"});
        }
        if(decoded?.data){
          rememberQrSpot(decoded,sourceX,sourceY,sourceWidth/width,
            sourceHeight/height,video.videoWidth,video.videoHeight);
          acceptDecoded(decoded.data);
        }
      }catch(error){
        workerJob=null;
        console.debug("補助QR解析をスキップしました",error);
      }finally{
        if(!handedOff)fallbackBusy=false;
      }
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
        if(active && typeof Worker!=="undefined"){
          try{
            qrWorker=new QrDecodeWorker();
            qrWorker.onmessage=onWorkerMessage;
            qrWorker.onerror=()=>{
              console.warn("QR補助ワーカーの起動に失敗しました。標準方式へ切り替えます。");
              qrWorker?.terminate();qrWorker=null;workerJob=null;fallbackBusy=false;
            };
          }catch(error){
            console.info("QR補助ワーカーを使用できないため標準方式に切り替えます",error);
          }
        }
        // Worker scans opportunistically; the primary reader keeps 30fps.
        if(active)fallbackTimer=window.setInterval(fallbackDecode,qrWorker?170:350);
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
