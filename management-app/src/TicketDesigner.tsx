import {
  type ChangeEvent,
  type CSSProperties,
  useMemo,
  useState,
} from "react";

import LazyQrCode from "./LazyQrCode";

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

  const [settings, setSettings] =
    useState<TicketDesignSettings>(
      () =>
        loadDesignSettings(
          eventName
        )
    );

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
    safePrintWidth *
    (ratio.height / ratio.width);

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

    reader.onload = () => {
      if (
        typeof reader.result !==
        "string"
      ) {
        return;
      }

      updateSetting(
        "backgroundImage",
        reader.result
      );
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
      <div className="ticket-designer-background">
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

  return (
    <div className="ticket-designer-background">
      <section className="ticket-designer-window">
        <header className="ticket-designer-header">
          <div>
            <h2>
              チケットデザイン・印刷
            </h2>

            <p>
              背景画像にQRコードとチケット番号を配置します
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
                印刷プレビュー
              </h3>

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

            <div className="ticket-preview-container">
              {previewTicket !==
                null && (
                <div
                  className="ticket-design-card"
                  style={
                    previewTicketStyle
                  }
                >
                  {settings.backgroundImage ===
                    "" && (
                    <div className="ticket-no-background">
                      背景画像を選択してください
                    </div>
                  )}

                  <div
                    className="ticket-design-qr"
                    style={{
                      left: `${settings.qrX}%`,
                      top: `${settings.qrY}%`,
                      width: `${settings.qrSize}%`,
                    }}
                  >
                    <LazyQrCode
                      value={createTicketQrValue(
                        previewTicket
                      )}
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
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "cardRatio",
                      event.target
                        .value as CardRatio
                    )
                  }
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

              <label className="ticket-number-setting">
                印刷時の横幅

                <input
                  type="number"
                  min="30"
                  max="250"
                  step="1"
                  value={
                    settings.printWidthMm
                  }
                  onChange={(
                    event
                  ) =>
                    updateSetting(
                      "printWidthMm",
                      Math.max(
                        30,
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

            <div className="ticket-setting-group">
              <h4>
                背景画像
              </h4>

              <label className="ticket-background-label">
                PNG・JPEG画像

                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={
                    handleBackgroundImage
                  }
                />
              </label>

              <p className="ticket-designer-help">
                KeynoteやPowerPointから書き出したPNG画像も使用できます。
              </p>

              {settings.backgroundImage !==
                "" && (
                <button
                  type="button"
                  className="ticket-remove-background"
                  onClick={() =>
                    updateSetting(
                      "backgroundImage",
                      ""
                    )
                  }
                >
                  背景画像を削除
                </button>
              )}
            </div>

            <div className="ticket-setting-group">
              <h4>
                QRコード
              </h4>

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

                <span>
                  {settings.qrX}%
                </span>
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

                <span>
                  {settings.qrY}%
                </span>
              </label>

              <label>