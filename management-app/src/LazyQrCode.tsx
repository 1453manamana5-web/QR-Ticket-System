import {
  lazy,
  Suspense,
  type ComponentProps,
} from "react";

type QrCodeModule =
  typeof import("qrcode.react");

type LazyQrCodeProps =
  ComponentProps<
    QrCodeModule["QRCodeSVG"]
  >;

const QRCodeSVG = lazy(
  async () => {
    const {
      QRCodeSVG,
    } = await import(
      "qrcode.react"
    );

    return {
      default: QRCodeSVG,
    };
  }
);

function LazyQrCode({
  size = 128,
  ...props
}: LazyQrCodeProps) {
  return (
    <Suspense
      fallback={
        <span
          aria-label="QRコードを準備しています"
          role="status"
          style={{
            display:
              "inline-block",
            width: size,
            height: size,
            borderRadius:
              "12px",
            background:
              "#f0edf7",
          }}
        />
      }
    >
      <QRCodeSVG
        {...props}
        size={size}
      />
    </Suspense>
  );
}

export default LazyQrCode;
