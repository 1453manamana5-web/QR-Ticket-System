import {useEffect} from "react";
import {Html5Qrcode} from "html5-qrcode";

type Props={readerId:string;onResult:(text:string)=>void;onError?:(message:string)=>void};

export default function QrScanner({readerId,onResult,onError}:Props){
  useEffect(()=>{
    const scanner=new Html5Qrcode(readerId);let active=true;
    void scanner.start(
      {facingMode:"environment"},
      {fps:10,qrbox:(w,h)=>{const size=Math.floor(Math.min(w,h)*0.68);return {width:size,height:size};},aspectRatio:1},
      decodedText=>{if(!active)return;active=false;onResult(decodedText);void scanner.stop().catch(()=>undefined);},
      ()=>undefined
    ).catch(()=>{if(active)onError?.("カメラを起動できませんでした。Safariのカメラ許可を確認してください。");});
    return()=>{active=false;if(scanner.isScanning)void scanner.stop().catch(()=>undefined);void scanner.clear().catch(()=>undefined);};
  },[readerId,onResult,onError]);
  return <div id={readerId} className="qr-reader" aria-label="QRコード読み取りエリア"/>;
}