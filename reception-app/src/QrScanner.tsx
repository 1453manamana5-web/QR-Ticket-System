import {useEffect,useRef} from "react";
import {Html5Qrcode,Html5QrcodeSupportedFormats} from "html5-qrcode";

type Props={
  readerId:string;
  onResult:(text:string)=>void|Promise<void>;
  onError?:(message:string)=>void;
  className?:string;
};

type ExtendedVideoConstraints=MediaTrackConstraints&{
  advanced?:Array<MediaTrackConstraintSet&{
    focusMode?:string|string[];
    exposureMode?:string|string[];
  }>;
};

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
  const fastConstraints:ExtendedVideoConstraints={
    width:{ideal:1280},
    height:{ideal:720},
    frameRate:{ideal:30,min:15},
    advanced:[{focusMode:"continuous",exposureMode:"continuous"}]
  };
  try{
    await scanner.applyVideoConstraints(fastConstraints);
  }catch(advancedError){
    console.warn("連続フォーカス設定を使用できないため、基本設定を試します",advancedError);
    try{
      await scanner.applyVideoConstraints({
        width:{ideal:1280},
        height:{ideal:720},
        frameRate:{ideal:30,min:15}
      });
    }catch(basicError){
      console.warn("端末標準のカメラ設定を使用します",basicError);
    }
  }
}

export default function QrScanner({readerId,onResult,onError,className}:Props){
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

    const stopCamera=async()=>{
      const current=scanner;
      scanner=null;
      if(current){
        try{if(current.isScanning)await current.stop();}catch(error){console.warn("QRカメラの停止に失敗しました",error);}
        try{current.clear();}catch(error){console.warn("QR表示領域のクリアに失敗しました",error);}
      }
      // Limit fallback cleanup to this reader; never stop another app's video.
      stopVideoTracks(readerElement);
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

        // iPad/SafariではカメラID指定の方が安定するため、端末の前面カメラを明示的に選択。
        const preferredCamera=cameras.find(camera=>isFrontCameraLabel(camera.label));
        // Safariでカメラ名が隠される場合は、ID順に依存せず facingMode=user を指定する。
        const cameraConfig:string|MediaTrackConstraints=preferredCamera?.id??{facingMode:"user"};
        if(preferredCamera){
          console.info("使用する前面カメラ:",preferredCamera.label||preferredCamera.id);
        }else{
          console.info("カメラ名を判定できないため facingMode=user で前面カメラを要求します");
        }
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
            aspectRatio:16/9,
            disableFlip:true
          },
          decodedText=>{
            if(!active)return;
            const normalizedValue=decodedText.trim();
            if(!normalizedValue)return;

            const now=Date.now();
            const previousSeenAt=lastHandledSeenAt;
            if(normalizedValue===lastDecodedText)lastHandledSeenAt=now;
            if(scanLocked)return;
            // Require removal from view before accepting the same QR again.
            if(normalizedValue===lastDecodedText&&(now-lastDecodedAt<1000||now-previousSeenAt<450))return;
            lastHandledSeenAt=now;
            lastDecodedText=normalizedValue;
            lastDecodedAt=now;
            scanLocked=true;
            // Serialize acceptance, without waiting for the result animation.
            void Promise.resolve()
              .then(()=>onResultRef.current(normalizedValue))
              .catch(error=>console.error("QRコードの受付処理に失敗しました",error))
              .finally(()=>{
                window.setTimeout(()=>{
                  if(active)scanLocked=false;
                },60);
              });
          },
          ()=>undefined
        );

        if(!active){await stopCamera();return;}
        await applyFastCameraSettings(instance);
      }catch(reason){
        console.error("前面カメラのQR読み取りを開始できませんでした",reason);
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
  },[readerId]);

  return <div id={readerId} className={className??"qr-reader"} aria-label="前面カメラのQRコード読み取りエリア"/>;
}
