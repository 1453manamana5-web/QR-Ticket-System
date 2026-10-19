import {
  type ChangeEvent,
  type CSSProperties,
  useMemo,
  useRef,
  useState,
} from "react";

import LazyQrCode from "./LazyQrCode";
import { analyzeTicketBackgroundFromDataUrl } from "./pinkQrMarkerDetection";

import "./TicketDesigner.css";

export type TicketDesignerTicket = {
  id: string;
  qrNumber: string;
  status: "unused" | "inside" | "exited";
  valid: boolean;
};

type TicketDesignerProps = {
  tickets: TicketDesignerTicket[];
  eventName: string;
  initialTicketNumber?: string;
  qrValue: (ticket: TicketDesignerTicket) => string;
  onClose: () => void;
};

type CardRatio =
  | "16:9"
  | "4:3"
  | "3:2"
  | "card"
  | "square"
  | "9:16"
  | "custom";

type TicketDesignSettings = {
  backgroundImage: string;

  cardRatio: CardRatio;
  customWidth: number;
  customHeight: number;

  printWidthMm: number;
  printHeightMm: number;
  cardsPerRow: number;
  printGapMm: number;

  qrX: number;
  qrY: number;
  qrSize: number;

  numberX: number;
  numberY: number;
  numberSize: number;
};

type PreviewTicketStyle = CSSProperties & {
  "--ticket-preview-ratio": string;
  "--ticket-print-width": string;
  "--ticket-print-height": string;
  "--ticket-print-gap": string;
  "--ticket-columns": number;
};

type PrintSheetStyle = CSSProperties & {
  "--ticket-print-width": string;
  "--ticket-print-height": string;
  "--ticket-print-gap": string;
};

const defaultSettings: TicketDesignSettings = {
  backgroundImage: "",

  cardRatio: "16:9",
  customWidth: 16,
  customHeight: 9,

  printWidthMm: 90,
  printHeightMm: 50.625,
  cardsPerRow: 2,
  printGapMm: 4,

  qrX: 76,
  qrY: 50,
  qrSize: 29,

  numberX: 31,
  numberY: 72,
  numberSize: 18,
};

function createDesignStorageKey(
  eventName: string
) {
  const safeEventName =
    eventName.trim() === ""
      ? "event-not-set"
      : encodeURIComponent(
          eventName.trim()
        );

  return `qr-management-ticket-design-${safeEventName}`;
}

function loadDesignSettings(
  eventName: string
): TicketDesignSettings {
  try {
    const savedDesign =
      localStorage.getItem(
        createDesignStorageKey(
          eventName
        )
      );

    if (savedDesign === null) {
      return defaultSettings;
    }

    const parsedDesign =
      JSON.parse(
        savedDesign
      ) as Partial<TicketDesignSettings>;

    return {
      ...defaultSettings,
      ...parsedDesign,
    };
  } catch (error) {
    console.error(
      "チケットデザインの読み込みに失敗しました。",
      error
    );

    return defaultSettings;
  }
}

function TicketDesigner({
  tickets,
  eventName,
  initialTicketNumber,
  qrValue,
  onClose,
}: TicketDesignerProps) {
  const printableTickets =
    useMemo(
      () =>
        tickets.filter(
          (ticket) =>
            ticket.valid
        ),
      [tickets]
    );

  const foundInitialIndex =
    printableTickets.findIndex(
      (ticket) =>
        ticket.qrNumber ===
        initialTicketNumber
    );

  const initialIndex =
    foundInitialIndex >= 0
      ? foundInitialIndex
      : 0;

  const detectionId = useRef(0);

  const [settings, setSettings] =
    useState<TicketDesignSettings>(
      () => loadDesignSettings(eventName)
    );
  const [showEditor, setShowEditor] = useState(
    () => loadDesignSettings(eventName).backgroundImage !== ""
  );
  const [previewZoom, setPreviewZoom] = useState(1);
  const [previewPan, setPreviewPan] = useState({ x: 0, y: 0 });
  const panDragStart = useRef<{ pointerId: number; x: number; y: number; panX: number; panY: number } | null>(null);
  const [showActualSize, setShowActualSize] = useState(false);
  const [sizeUnit, setSizeUnit] = useState<"mm" | "cm">("mm");
  const [screenScale, setScreenScale] = useState(() => {
    try {
      const saved = Number(localStorage.getItem("qr-ticket-screen-scale"));
      return Number.isFinite(saved) && saved >= 0.5 && saved <= 2.5 ? saved : 1;
    } catch {
      return 1;
    }
  });
  const [selectedPart, setSelectedPart] = useState<"qr" | "number" | null>(null);
  const pinchStartDistance = useRef<number | null>(null);
  const pinchStartZoom = useRef(1);
  const liveZoom = useRef(1);
  const ticketCardRef = useRef<HTMLDivElement | null>(null);
  const dragTarget = useRef<"qr" | "number" | null>(null);
  const dragStart = useRef({ x: 0, y: 0, left: 0, top: 0 });

  const [
    startIndex,
    setStartIndex,
  ] = useState(initialIndex);

  const [
    endIndex,
    setEndIndex,
  ] = useState(
    initialTicketNumber ===
      undefined
      ? Math.max(
          printableTickets.length - 1,
          0
        )
      : initialIndex
  );

  const updateSetting = <
    Key extends keyof TicketDesignSettings,
  >(
    key: Key,
    value: TicketDesignSettings[Key]
  ) => {
    setSettings(
      (currentSettings) => ({
        ...currentSettings,
        [key]: value,
      })
    );
  };

  const getRatioNumbers = () => {
    switch (settings.cardRatio) {
      case "4:3":
        return {
          width: 4,
          height: 3,
        };

      case "3:2":
        return {
          width: 3,
          height: 2,
        };

      case "card":
        return {
          width: 1.586,
          height: 1,
        };

      case "square":
        return {
          width: 1,
          height: 1,
        };

      case "9:16":
        return {
          width: 9,
          height: 16,
        };

      case "custom":
        return {
          width: Math.max(
            1,
            settings.customWidth
          ),
          height: Math.max(
            1,
            settings.customHeight
          ),
        };

      case "16:9":
      default:
        return {
          width: 16,
          height: 9,
        };
    }
  };

  const ratio = getRatioNumbers();

  const safePrintWidth =
    Math.max(
      30,
      settings.printWidthMm
    );

  const printHeightMm =
    settings.cardRatio === "custom"
      ? Math.max(10, settings.printHeightMm || safePrintWidth * (ratio.height / ratio.width))
      : safePrintWidth * (ratio.height / ratio.width);

  const selectedTickets =
    useMemo(() => {
      if (
        printableTickets.length === 0
      ) {
        return [];
      }

      const safeStart =
        Math.min(
          Math.max(
            startIndex,
            0
          ),
          printableTickets.length - 1
        );

      const safeEnd =
        Math.min(
          Math.max(
            endIndex,
            safeStart
          ),
          printableTickets.length - 1
        );

      return printableTickets.slice(
        safeStart,
        safeEnd + 1
      );
    }, [
      printableTickets,
      startIndex,
      endIndex,
    ]);

  const previewTicket =
    selectedTickets[0] ??
    printableTickets[0] ??
    null;

  const previewTicketStyle:
    PreviewTicketStyle = {
    aspectRatio:
      `${ratio.width} / ${ratio.height}`,

    "--ticket-preview-ratio":
      String(ratio.width / ratio.height),

    backgroundImage:
      settings.backgroundImage === ""
        ? undefined
        : `url("${settings.backgroundImage}")`,

    "--ticket-print-width":
      `${safePrintWidth}mm`,

    "--ticket-print-height":
      `${printHeightMm}mm`,

    "--ticket-print-gap":
      `${Math.max(
        0,
        settings.printGapMm
      )}mm`,

    "--ticket-columns":
      Math.max(
        1,
        Math.min(
          4,
          settings.cardsPerRow
        )
      ),
  };

  const printSheetStyle:
    PrintSheetStyle = {
    "--ticket-print-width":
      `${safePrintWidth}mm`,

    "--ticket-print-height":
      `${printHeightMm}mm`,

    "--ticket-print-gap":
      `${Math.max(
        0,
        settings.printGapMm
      )}mm`,
  };

  const handleBackgroundImage = (
    event: ChangeEvent<HTMLInputElement>
  ) => {
    const file =
      event.target.files?.[0];

    event.target.value = "";

    if (file === undefined) {
      return;
    }

    if (
      !file.type.startsWith(
        "image/"
      )
    ) {
      alert(
        "PNGやJPEGなどの画像を選択してください。"
      );

      return;
    }

    const reader =
      new FileReader();
    const id = ++detectionId.current;

    reader.onload = async () => {
      if (
        typeof reader.result !==
        "string"
      ) {
        return;
      }

      const image = reader.result;
      setShowEditor(true);

      updateSetting(
        "backgroundImage",
        image
      );

      try {
        const analysis =
          await analyzeTicketBackgroundFromDataUrl(
            image
          );

        if (detectionId.current !== id) {
          return;
        }

        const marker = analysis.marker;

        if (marker === null) {
          setSettings(
            currentSettings => ({
              ...currentSettings,
              backgroundImage: image,
              cardRatio:
                analysis.ratio.cardRatio,
            })
          );
          return;
        }

        const round = (value: number) =>
          Math.round(value * 10) / 10;
        const clamp = (
          value: number,
          minimum: number,
          maximum: number
        ) =>
          Math.min(
            maximum,
            Math.max(minimum, value)
          );

        setSettings(
          currentSettings => ({
            ...currentSettings,
            backgroundImage: image,
            cardRatio:
              analysis.ratio.cardRatio,
            qrX: round(
              clamp(
                marker.centerXPercent,
                5,
                95
              )
            ),
            qrY: round(
              clamp(
                marker.centerYPercent,
                5,
                95
              )
            ),
            qrSize: round(
              clamp(
                marker.sizePercent,
                12,
                55
              )
            ),
          })
        );
      } catch (error) {
        console.warn(
          "チケット背景画像の自動解析に失敗しました。",
          error
        );
      }
    };

    reader.onerror = () => {
      alert(
        "画像を読み込めませんでした。"
      );
    };

    reader.readAsDataURL(file);
  };

  const saveDesign = () => {
    try {
      localStorage.setItem(
        createDesignStorageKey(
          eventName
        ),
        JSON.stringify(settings)
      );

      alert(
        `${
          eventName ||
          "現在のイベント"
        }のチケットデザインを保存しました。`
      );
    } catch (error) {
      console.error(
        "チケットデザインの保存に失敗しました。",
        error
      );

      alert(
        "デザインを保存できませんでした。画像が大きすぎる可能性があります。"
      );
    }
  };

  const resetDesign = () => {
    const confirmed =
      window.confirm(
        "背景画像や配置を初期状態に戻しますか？"
      );

    if (!confirmed) {
      return;
    }

    setSettings({
      ...defaultSettings,
    });
    ++detectionId.current;

    try {
      localStorage.removeItem(
        createDesignStorageKey(
          eventName
        )
      );
    } catch (error) {
      console.error(
        "保存済みデザインの削除に失敗しました。",
        error
      );
    }
  };

  const printTickets = () => {
    if (
      selectedTickets.length === 0
    ) {
      alert(
        "印刷できるチケットがありません。"
      );

      return;
    }

    /*
      iPad Safariでは、確認ダイアログや非同期処理を挟むと
      印刷操作がユーザーの直接操作として扱われず、
      window.print()が無視される場合があります。

      印刷ボタンを押した同じ処理内で、
     直接window.print()を実行します。
    */
    try {
      window.focus();

      /*
        印刷用DOMとCSSを確実に再計算させます。
      */
      void document.body.offsetHeight;

      window.print();
    } catch (error) {
      console.error(
        "印刷画面を開けませんでした。",
        error
      );

      alert(
        "印刷画面を開けませんでした。Safariで開き直して、もう一度お試しください。"
      );
    }
  };

  if (
    printableTickets.length === 0
  ) {
    return (
      <div className="ticket-designer-background ticket-designer-glass">
        <section className="ticket-designer-empty">
          <h2>
            印刷できるチケットがありません
          </h2>

          <p>
            チケットを発行するか、無効状態を解除してください。
          </p>

          <button
            type="button"
            onClick={onClose}
          >
            閉じる
          </button>
        </section>
      </div>
    );
  }

  if (!showEditor) {
    return (
      <div className="ticket-designer-background ticket-designer-glass">
        <section className="ticket-image-start">
          <header className="ticket-image-start-header">
            <div>
              <span className="ticket-glass-eyebrow">TICKET STUDIO</span>
              <h2>チケットデザインを作成</h2>
              <p>まずはベースにするチケット画像を選択してください。</p>
            </div>
            <button type="button" className="ticket-designer-close" onClick={onClose} aria-label="閉じる">×</button>
          </header>
          <label className="ticket-image-dropzone">
            <input type="file" accept="image/*" onChange={handleBackgroundImage} />
            <span className="ticket-image-icon">＋</span>
            <strong>チケット画像をここから選択</strong>
            <span>写真ライブラリ・ファイルから画像を読み込めます</span>
            <span className="ticket-image-actions"><span>写真を選択</span><span>ファイルを選択</span></span>
          </label>
          <button type="button" className="ticket-glass-secondary" onClick={() => setShowEditor(true)}>画像を使わず新規作成</button>
          <p className="ticket-image-note">PNG・JPEG・WebPなどの画像に対応。画像はチケットの背景として読み込みます。</p>
        </section>
      </div>
    );
  }

  return (
    <div className="ticket-designer-background ticket-designer-glass">
      <section className="ticket-designer-window">
        <header className="ticket-designer-header">
          <div className="ticket-designer-title-group">
            <span className="ticket-glass-eyebrow">TICKET STUDIO <span>／</span> {eventName || "イベント未選択"}</span>
            <h2>
              チケットデザイン
            </h2>

            <p>
              プレビューを直接操作して、配置・サイズ・印刷設定をまとめて編集
            </p>
          </div>

          <button
            type="button"
            className="ticket-designer-close"
            onClick={onClose}
            aria-label="デザイン画面を閉じる"
          >
            ×
          </button>
        </header>

        <main className="ticket-designer-content">
          <section className="ticket-designer-preview-section">
            <div className="ticket-preview-heading">
              <h3>
                チケットキャンバス
              </h3>
              <button type="button" className="ticket-actual-size-button" onClick={() => setShowActualSize(true)}>実寸・印刷サイズを確認</button>

              <span>
                {safePrintWidth.toFixed(
                  1
                )}
                mm ×{" "}
                {printHeightMm.toFixed(
                  1
                )}
                mm
              </span>
            </div>

            <div
              className="ticket-preview-container ticket-touch-canvas"
              onTouchStart={(event) => {
                if (event.touches.length === 2) {
                  const dx = event.touches[0].clientX - event.touches[1].clientX;
                  const dy = event.touches[0].clientY - event.touches[1].clientY;
                  pinchStartDistance.current = Math.max(1, Math.hypot(dx, dy));
                  pinchStartZoom.current = liveZoom.current;
                  dragTarget.current = null;
                  panDragStart.current = null;
                  event.preventDefault();
                }
              }}
              onTouchMove={(event) => {
                if (event.touches.length === 2 && pinchStartDistance.current !== null) {
                  const dx = event.touches[0].clientX - event.touches[1].clientX;
                  const dy = event.touches[0].clientY - event.touches[1].clientY;
                  const distance = Math.hypot(dx, dy);
                  const nextZoom = Math.max(0.5, Math.min(3, pinchStartZoom.current * distance / pinchStartDistance.current));
                  liveZoom.current = nextZoom;
                  // Update only the ticket transform during the gesture; do not re-render
                  // the entire editor for every touch-move event.
                  if (ticketCardRef.current) {
                    ticketCardRef.current.style.transform = `translate(${previewPan.x}px, ${previewPan.y}px) scale(${nextZoom}) translateZ(0)`;
                  }
                  event.preventDefault();
                }
              }}
              onTouchEnd={(event) => {
                if (event.touches.length < 2 && pinchStartDistance.current !== null) {
                  pinchStartDistance.current = null;
                  setPreviewZoom(liveZoom.current);
                }
              }}
            >
              <div className="ticket-canvas-zoom-tools">
                <button type="button" onClick={() => { const next = Math.max(0.5, +(liveZoom.current - 0.1).toFixed(2)); liveZoom.current = next; setPreviewZoom(next); }} aria-label="縮小">−</button>
                <span>{Math.round(previewZoom * 100)}%</span>
                <button type="button" onClick={() => { const next = Math.min(3, +(liveZoom.current + 0.1).toFixed(2)); liveZoom.current = next; setPreviewZoom(next); }} aria-label="拡大">＋</button>
                <button type="button" onClick={() => { liveZoom.current = 1; setPreviewZoom(1); setPreviewPan({ x: 0, y: 0 }); if (ticketCardRef.current) ticketCardRef.current.style.transform = "translate(0px, 0px) scale(1) translateZ(0)"; }}>位置・倍率をリセット</button>
              </div>
              {previewTicket !==
                null && (
                <div
                  ref={ticketCardRef}
                  className="ticket-design-card"
                  onPointerDown={(event) => {
                    if ((event.target as HTMLElement).closest(".ticket-draggable-part")) return;
                    panDragStart.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, panX: previewPan.x, panY: previewPan.y };
                    event.currentTarget.setPointerCapture(event.pointerId);
                    event.preventDefault();
                  }}
                  onPointerMove={(event) => {
                    const start = panDragStart.current;
                    if (!start || start.pointerId !== event.pointerId) return;
                    setPreviewPan({ x: start.panX + event.clientX - start.x, y: start.panY + event.clientY - start.y });
                  }}
                  onPointerUp={(event) => {
                    if (panDragStart.current?.pointerId === event.pointerId) panDragStart.current = null;
                  }}
                  onPointerCancel={() => { panDragStart.current = null; }}
                  style={{
                    ...previewTicketStyle,
                    transform: `translate(${previewPan.x}px, ${previewPan.y}px) scale(${previewZoom}) translateZ(0)`,
                    transformOrigin: "top left",
                  }}
                >
                  {settings.backgroundImage ===
                    "" && (
                    <div className="ticket-no-background">
                      背景画像を選択してください
                    </div>
                  )}

                  <div
                    className="ticket-design-qr ticket-draggable-part"
                    onPointerDown={(event) => {
                      if (selectedPart !== "qr") {
                        setSelectedPart("qr");
                        dragTarget.current = null;
                        event.stopPropagation();
                        return;
                      }
                      dragTarget.current = "qr";
                      dragStart.current = { x: event.clientX, y: event.clientY, left: settings.qrX, top: settings.qrY };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.stopPropagation();
                    }}
                    onPointerMove={(event) => {
                      if (dragTarget.current !== "qr") return;
                      const card = event.currentTarget.parentElement as HTMLDivElement;
                      const scale = Math.max(0.5, liveZoom.current);
                      const baseWidth = card.offsetWidth;
                      const baseHeight = card.offsetHeight;
                      if (!baseWidth || !baseHeight) return;
                      updateSetting("qrX", Math.max(0, Math.min(100, dragStart.current.left + (event.clientX - dragStart.current.x) / scale / baseWidth * 100)));
                      updateSetting("qrY", Math.max(0, Math.min(100, dragStart.current.top + (event.clientY - dragStart.current.y) / scale / baseHeight * 100)));
                    }}
                    onPointerUp={() => { dragTarget.current = null; }}
                    style={{
                      left: `${settings.qrX}%`,
                      top: `${settings.qrY}%`,
                      width: `${settings.qrSize}%`,
                    }}
                  >
                    <LazyQrCode
                      value={qrValue(previewTicket)}
                      size={500}
                      level="M"
                      marginSize={1}
                    />
                  </div>

                  <div
                    className="ticket-design-number ticket-draggable-part"
                    onPointerDown={(event) => {
                      if (selectedPart !== "number") {
                        setSelectedPart("number");
                        dragTarget.current = null;
                        event.stopPropagation();
                        return;
                      }
                      dragTarget.current = "number";
                      dragStart.current = { x: event.clientX, y: event.clientY, left: settings.numberX, top: settings.numberY };
                      event.currentTarget.setPointerCapture(event.pointerId);
                      event.stopPropagation();
                    }}
                    onPointerMove={(event) => {
                      if (dragTarget.current !== "number") return;
                      const card = event.currentTarget.parentElement as HTMLDivElement;
                      const scale = Math.max(0.5, liveZoom.current);
                      const baseWidth = card.offsetWidth;
                      const baseHeight = card.offsetHeight;
                      if (!baseWidth || !baseHeight) return;
                      updateSetting("numberX", Math.max(0, Math.min(100, dragStart.current.left + (event.clientX - dragStart.current.x) / scale / baseWidth * 100)));
                      updateSetting("numberY", Math.max(0, Math.min(100, dragStart.current.top + (event.clientY - dragStart.current.y) / scale / baseHeight * 100)));
                    }}
                    onPointerUp={() => { dragTarget.current = null; }}
                    style={{
                      left: `${settings.numberX}%`,
                      top: `${settings.numberY}%`,
                      fontSize:
                        `${settings.numberSize}px`,
                    }}
                  >
                    {
                      previewTicket.qrNumber
                    }
                  </div>
                </div>
              )}
            </div>

            <section className="ticket-print-range">
              <h3>
                印刷する範囲
              </h3>

              <div className="ticket-range-inputs">
                <label>
                  最初のチケット

                  <select
                    value={
                      startIndex
                    }
                    onChange={(
                      event
                    ) => {
                      const newStart =
                        Number(
                          event.target
                            .value
                        );

                      setStartIndex(
                        newStart
                      );

                      if (
                        endIndex <
                        newStart
                      ) {
                        setEndIndex(
                          newStart
                        );
                      }
                    }}
                  >
                    {printableTickets.map(
                      (
                        ticket,
                        index
                      ) => (
                        <option
                          key={
                            ticket.id
                          }
                          value={
                            index
                          }
                        >
                          {
                            ticket.qrNumber
                          }
                        </option>
                      )
                    )}
                  </select>
                </label>

                <span>～</span>

                <label>
                  最後のチケット

                  <select
                    value={
                      endIndex
                    }
                    onChange={(
                      event
                    ) =>
                      setEndIndex(
                        Number(
                          event.target
                            .value
                        )
                      )
                    }
                  >
                    {printableTickets.map(
                      (
                        ticket,
                        index
                      ) => (
                        <option
                          key={
                            ticket.id
                          }
                          value={
                            index
                          }
                          disabled={
                            index <
                            startIndex
                          }
                        >
                          {
                            ticket.qrNumber
                          }
                        </option>
                      )
                    )}
                  </select>
                </label>
              </div>

              <div className="ticket-range-summary">
                印刷対象：

                <strong>
                  {
                    selectedTickets.length
                  }
                  枚
                </strong>

                <span>
                  ※無効なチケットは除外されます
                </span>
              </div>
            </section>
          </section>

          <section className="ticket-designer-settings">
            <h3>
              デザイン設定
            </h3>

            <div className="ticket-setting-group">
              <h4>
                チケットサイズ
              </h4>

              <label className="ticket-select-setting">
                比率

                <select
                  value={
                    settings.cardRatio
                  }
                  onChange={(event) => {
                    const nextRatio = event.target.value as CardRatio;
                    if (nextRatio === "custom") {
                      const currentHeight = safePrintWidth * (ratio.height / ratio.width);
                      setSettings(current => ({
                        ...current,
                        cardRatio: "custom",
                        customWidth: current.printWidthMm,
                        customHeight: currentHeight,
                        printHeightMm: currentHeight,
                      }));
                    } else {
                      updateSetting("cardRatio", nextRatio);
                    }
                  }}
                >
                  <option value="16:9">
                    16:9
                  </option>

                  <option value="4:3">
                    4:3
                  </option>

                  <option value="3:2">
                    3:2
                  </option>

                  <option value="card">
                    カード比率
                  </option>

                  <option value="square">
                    正方形
                  </option>

                  <option value="9:16">
                    9:16（縦長）
                  </option>

                  <option value="custom">
                    自由設定
                  </option>
                </select>
              </label>

              {settings.cardRatio ===
                "custom" && (
                <div className="ticket-custom-ratio">
                  <label>
                    横

                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={
                        settings.customWidth
                      }
                      onChange={(
                        event
                      ) =>
                        updateSetting(
                          "customWidth",
                          Number(
                            event.target
                              .value
                          )
                        )
                      }
                    />
                  </label>

                  <span>：</span>

                  <label>
                    縦

                    <input
                      type="number"
                      min="1"
                      step="0.1"
                      value={
                        settings.customHeight
                      }
                      onChange={(
                        event
                      ) =>
                        updateSetting(
                          "customHeight",
                          Number(
                            event.target
                              .value
                          )
                        )
                      }
                    />
                  </label>
                </div>
              )}

              <label className="ticket-select-setting">
                寸法の単位
                <select value={sizeUnit} onChange={(event) => setSizeUnit(event.target.value as "mm" | "cm")}>
                  <option value="mm">mm（ミリメートル）</option>
                  <option value="cm">cm（センチメートル）</option>
                </select>
              </label>
              <div className="ticket-physical-size-inputs">
                <label>
                  幅（{sizeUnit}）
                  <input
                    type="number"
                    min={sizeUnit === "cm" ? "3" : "30"}
                    max={sizeUnit === "cm" ? "25" : "250"}
                    step={sizeUnit === "cm" ? "0.1" : "1"}
                    value={Number((settings.printWidthMm / (sizeUnit === "cm" ? 10 : 1)).toFixed(2))}
                    onChange={(event) => {
                      const next = Math.max(30, Math.min(250, Number(event.target.value) * (sizeUnit === "cm" ? 10 : 1)));
                      updateSetting("printWidthMm", next);
                      if (settings.cardRatio === "custom") setSettings(current => ({ ...current, customWidth: next, customHeight: current.printHeightMm }));
                    }}
                  />
                </label>
                <label>
                  高さ（{sizeUnit}）
                  <input
                    type="number"
                    min={sizeUnit === "cm" ? "1" : "10"}
                    max={sizeUnit === "cm" ? "25" : "250"}
                    step={sizeUnit === "cm" ? "0.1" : "1"}
                    value={Number((printHeightMm / (sizeUnit === "cm" ? 10 : 1)).toFixed(2))}
                    onChange={(event) => {
                      const next = Math.max(10, Math.min(250, Number(event.target.value) * (sizeUnit === "cm" ? 10 : 1)));
                      setSettings(current => ({
                        ...current,
                        cardRatio: "custom",
                        customWidth: current.printWidthMm,
                        customHeight: next,
                        printHeightMm: next,
                      }));
                    }}
                  />
                </label>
              </div>
              <p className="ticket-designer-help">自由設定では幅・高さがそれぞれ印刷実寸になります。画面の拡大率には影響しません。</p>
            </div>

            <div className="ticket-selected-part">
              <span>選択中のパーツ</span>
              <div>
                <button type="button" className={selectedPart === "qr" ? "active" : ""} onClick={() => setSelectedPart("qr")}>QRコード</button>
                <button type="button" className={selectedPart === "number" ? "active" : ""} onClick={() => setSelectedPart("number")}>チケット番号</button>
              </div>
              <p>キャンバス上のパーツをタップしても切り替わります。</p>
            </div>
            {selectedPart === "qr" && (
            <div className="ticket-setting-group">
              <h4>QRコード</h4>

              <label>
                横位置

                <input
                  type="range"
                  min="5"
                  max="95"
                  value={
                    settings.qrX
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "qrX",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="5" max="95" step="0.1" aria-label="qrXの数値" value={settings.qrX} onChange={(event) => updateSetting("qrX", Math.max(5, Math.min(95, Number(event.target.value))))} />
              </label>

              <label>
                縦位置

                <input
                  type="range"
                  min="5"
                  max="95"
                  value={
                    settings.qrY
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "qrY",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="5" max="95" step="0.1" aria-label="qrYの数値" value={settings.qrY} onChange={(event) => updateSetting("qrY", Math.max(5, Math.min(95, Number(event.target.value))))} />
              </label>

              <label>                大きさ

                <input
                  type="range"
                  min="12"
                  max="55"
                  value={
                    settings.qrSize
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "qrSize",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="12" max="55" step="0.1" aria-label="qrSizeの数値" value={settings.qrSize} onChange={(event) => updateSetting("qrSize", Math.max(12, Math.min(55, Number(event.target.value))))} />
              </label>
            </div>

            )}
            {selectedPart === "number" && (
            <div className="ticket-setting-group">
              <h4>チケット番号</h4>
              <label>
                横位置

                <input
                  type="range"
                  min="0"
                  max="100"
                  value={
                    settings.numberX
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "numberX",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="0" max="100" step="0.1" aria-label="numberXの数値" value={settings.numberX} onChange={(event) => updateSetting("numberX", Math.max(0, Math.min(100, Number(event.target.value))))} />
              </label>

              <label>
                縦位置

                <input
                  type="range"
                  min="0"
                  max="100"
                  value={
                    settings.numberY
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "numberY",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="0" max="100" step="0.1" aria-label="numberYの数値" value={settings.numberY} onChange={(event) => updateSetting("numberY", Math.max(0, Math.min(100, Number(event.target.value))))} />
              </label>

              <label>
                文字サイズ

                <input
                  type="range"
                  min="10"
                  max="60"
                  value={
                    settings.numberSize
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "numberSize",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                />

                <input className="ticket-value-input" type="number" min="10" max="60" step="1" aria-label="文字サイズの数値" value={settings.numberSize} onChange={(event) => updateSetting("numberSize", Math.max(10, Math.min(60, Number(event.target.value))))} />
              </label>
            </div>
            )}

            <div className="ticket-setting-group">
              <h4>
                まとめて印刷
              </h4>

              <label className="ticket-select-setting">
                1行に並べる枚数

                <select
                  value={
                    settings.cardsPerRow
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "cardsPerRow",
                      Number(
                        event.target
                          .value
                      )
                    )
                  }
                >
                  <option value={1}>
                    1枚
                  </option>

                  <option value={2}>
                    2枚
                  </option>

                  <option value={3}>
                    3枚
                  </option>

                  <option value={4}>
                    4枚
                  </option>
                </select>
              </label>

              <label className="ticket-number-setting">
                チケット間の余白

                <input
                  type="number"
                  min="0"
                  max="20"
                  step="1"
                  value={
                    settings.printGapMm
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "printGapMm",
                      Math.max(
                        0,
                        Number(
                          event.target
                            .value
                        )
                      )
                    )
                  }
                />

                <span>mm</span>
              </label>
            </div>
          </section>
        </main>

        <footer className="ticket-designer-buttons">
          <button
            type="button"
            className="ticket-design-save"
            onClick={saveDesign}
          >
            デザインを保存
          </button>

          <button
            type="button"
            className="ticket-design-print"
            onClick={printTickets}
          >
            選択した範囲を印刷
          </button>

          <button
            type="button"
            className="ticket-design-reset"
            onClick={resetDesign}
          >
            初期状態に戻す
          </button>

          <button
            type="button"
            className="ticket-design-cancel"
            onClick={onClose}
          >
            閉じる
          </button>
        </footer>
      </section>

      {showActualSize && (
        <div className="ticket-actual-size-overlay" role="dialog" aria-modal="true" aria-label="チケット実寸確認">
          <section className="ticket-actual-size-dialog">
            <header>
              <div>
                <h2>チケットの実寸確認</h2>
                <p>画面表示を定規で校正すると、画面上でも指定寸法に合わせて表示できます。</p>
              </div>
              <button type="button" onClick={() => setShowActualSize(false)} aria-label="閉じる">×</button>
            </header>
            <div className="ticket-actual-size-measurement">
              <span>幅</span><strong>{safePrintWidth.toFixed(1)} mm（{(safePrintWidth / 10).toFixed(2)} cm）</strong>
              <span>高さ</span><strong>{printHeightMm.toFixed(1)} mm（{(printHeightMm / 10).toFixed(2)} cm）</strong>
            </div>
            <div className="ticket-actual-size-preview-wrap">
              <div className="ticket-actual-size-preview" style={({ "--ticket-actual-size-width": `${safePrintWidth * (96 / 25.4) * screenScale}px`, aspectRatio: `${ratio.width} / ${ratio.height}`, backgroundImage: settings.backgroundImage ? `url("${settings.backgroundImage}")` : "none" } as CSSProperties & { "--ticket-actual-size-width": string })}>
                <div className="ticket-design-qr" style={{ left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
                  <LazyQrCode value={previewTicket ? qrValue(previewTicket) : ""} size={500} level="M" marginSize={1} />
                </div>
                <div className="ticket-design-number" style={{ left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize * screenScale}px` }}>{previewTicket?.qrNumber ?? ""}</div>
              </div>
            </div>
            <div className="ticket-screen-calibration">
              <strong>画面表示の校正</strong>
              <p>下の線が、手元の定規で正確に10 cmになるように調整してください。校正後は、この画面のチケット表示を指定寸法に合わせます。</p>
              <div className="ticket-calibration-ruler">
                <span style={{ width: `${100 * (96 / 25.4) * screenScale}px` }} />
                <small>10 cm</small>
              </div>
              <label className="ticket-calibration-control">
                <span>表示倍率</span>
                <input type="range" min="0.5" max="2.5" step="0.01" value={screenScale} onChange={(event) => {
                  const next = Number(event.target.value);
                  setScreenScale(next);
                  try { localStorage.setItem("qr-ticket-screen-scale", String(next)); } catch {}
                }} />
                <output>{Math.round(screenScale * 100)}%</output>
              </label>
              <p className="ticket-actual-size-note">校正はこのブラウザーの画面表示用です。印刷寸法は上記のmm/cm指定を使い、印刷設定は「実際のサイズ」または倍率100%にしてください。</p>
            </div>
            <button type="button" className="ticket-actual-size-done" onClick={() => setShowActualSize(false)}>編集に戻る</button>
          </section>
        </div>
      )}

      <div
        className="ticket-print-sheet"
        style={printSheetStyle}
      >
        {selectedTickets.map(
          (ticket) => (
            <div
              key={ticket.id}
              className="ticket-print-card"
              style={{
                backgroundImage:
                  settings.backgroundImage ===
                  ""
                    ? undefined
                    : `url("${settings.backgroundImage}")`,
              }}
            >
              <div
                className="ticket-design-qr"
                style={{
                  left: `${settings.qrX}%`,
                  top: `${settings.qrY}%`,
                  width: `${settings.qrSize}%`,
                }}
              >
                <LazyQrCode
                  value={qrValue(ticket)}
                  size={500}
                  level="M"
                  marginSize={1}
                />
              </div>

              <div
                className="ticket-design-number"
                style={{
                  left: `${settings.numberX}%`,
                  top: `${settings.numberY}%`,
                  fontSize:
                    `${settings.numberSize}px`,
                }}
              >
                {ticket.qrNumber}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}



export function TicketQrPreview({ eventName, ticketNumber, qrValue }: { eventName: string; ticketNumber: string; qrValue: string }) {
  const settings = loadDesignSettings(eventName);
  const ratio = (() => {
    switch (settings.cardRatio) {
      case "4:3": return "4 / 3";
      case "3:2": return "3 / 2";
      case "card": return "1.586 / 1";
      case "square": return "1 / 1";
      case "9:16": return "9 / 16";
      case "custom": return `${Math.max(1, settings.customWidth)} / ${Math.max(1, settings.customHeight)}`;
      default: return "16 / 9";
    }
  })();
  const cardStyle: CSSProperties = {
    aspectRatio: ratio,
    backgroundImage: settings.backgroundImage ? `url("${settings.backgroundImage}")` : undefined,
    backgroundSize: "contain",
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
    position: "relative",
    width: "min(100%, 560px)",
    overflow: "hidden",
    borderRadius: 12,
    boxShadow: "0 8px 28px rgba(0,0,0,.16)",
    margin: "0 auto",
  };
  return (
    <div className="ticket-qr-design-preview" style={cardStyle}>
      {!settings.backgroundImage && <div className="ticket-no-background" style={{ background: "linear-gradient(135deg,#f2f5fa,#dce4f0)" }}>背景画像が未設定です</div>}
      <div className="ticket-design-qr" style={{ left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
        <LazyQrCode value={qrValue} size={500} level="M" marginSize={1} />
      </div>
      <div className="ticket-design-number" style={{ left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize}px` }}>{ticketNumber}</div>
    </div>
  );
}

export default TicketDesigner;