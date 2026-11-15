import {useEffect,useRef} from "react";
import {Html5Qrcode,Html5QrcodeSupportedFormats} from "html5-qrcode";
import jsQR from "jsqr";

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

    // Independent jsQR fallback: run only a few times per second, so the
    // primary native/ZXing reader remains responsive on school iPads.
    const fallbackDecode=()=>{
      if(!active||scanLocked||fallbackBusy||!fallbackContext||!readerElement)return;
      const video=readerElement.querySelector("video");
      if(!video||video.readyState<2||!video.videoWidth)return;
      fallbackBusy=true;
      try{
        const width=Math.min(960,video.videoWidth);
        const height=Math.max(1,Math.round(width*video.videoHeight/video.videoWidth));
        if(fallbackCanvas.width!==width)fallbackCanvas.width=width;
        if(fallbackCanvas.height!==height)fallbackCanvas.height=height;
        fallbackContext.drawImage(video,0,0,width,height);
        const frame=fallbackContext.getImageData(0,0,width,height);
        const decoded=jsQR(frame.data,width,height,{inversionAttempts:"attemptBoth"});
        if(decoded?.data)acceptDecoded(decoded.data);
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
