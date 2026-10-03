import {useEffect, useRef} from "react";
import {Html5Qrcode} from "html5-qrcode";

type Props = {
  onResult: (text: string) => void;
  onError?: (message: string) => void;
};

export default function QrScanner({onResult,onError}: Props) {
  const scannerRef = useRef<Html5Qrcode | null>(null);

  useEffect(() => {
    const scanner = new Html5Qrcode("event-auth-reader");
    scannerRef.current = scanner;

    void scanner.start(
      {facingMode: "environment"},
      {fps: 10, qrbox: {width: 280, height: 280}, aspectRatio: 1},
      (decodedText) => {
        onResult(decodedText);
        void scanner.stop().catch(() => undefined);
      },
      () => undefined
    ).catch(() => {
      onError?.("カメラを起動できませんでした。Safariのカメラ許可を確認してください。");
    });

    return () => {
      if (scanner.isScanning) {
        void scanner.stop().catch(() => undefined);
      }
      scanner.clear().catch(() => undefined);
      scannerRef.current = null;
    };
  }, [onResult,onError]);

  return <div id="event-auth-reader" aria-label="イベント認証QR読み取りエリア"/>;
}