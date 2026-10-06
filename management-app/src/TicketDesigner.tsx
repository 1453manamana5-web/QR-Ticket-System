import { useMemo, useRef, useState, type ChangeEvent, type CSSProperties } from "react";
import LazyQrCode from "./LazyQrCode";
import { analyzeTicketBackgroundFromDataUrl, type PresetTicketRatio } from "./pinkQrMarkerDetection";
import "./TicketDesigner.css";

type TicketStatus = "unused" | "inside" | "exited";
export type TicketDesignerTicket = {
  id: string;
  qrNumber: string;
  status: TicketStatus;
  valid: boolean;
};

type CardRatio = PresetTicketRatio | "custom";
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
  showTicketNumber: boolean;
  numberX: number;
  numberY: number;
  numberSize: number;
};

type Props = {
  tickets: TicketDesignerTicket[];
  eventName: string;
  initialTicketNumber?: string;
  qrValue: (ticket: TicketDesignerTicket) => string;
  onClose: () => void;
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
  showTicketNumber: true,
  numberX: 31,
  numberY: 72,
  numberSize: 18,
};

function storageKey(eventName: string) {
  const safe = eventName.trim() === "" ? "event-not-set" : encodeURIComponent(eventName.trim());
  return `qr-management-ticket-design-${safe}`;
}

function loadSettings(eventName: string): TicketDesignSettings {
  try {
    const raw = localStorage.getItem(storageKey(eventName));
    return raw ? { ...defaultSettings, ...JSON.parse(raw) } : { ...defaultSettings };
  } catch {
    return { ...defaultSettings };
  }
}

function TicketDesigner({ tickets, eventName, initialTicketNumber, qrValue, onClose }: Props) {
  const printable = useMemo(() => tickets.filter(t => t.valid), [tickets]);
  const initial = Math.max(0, printable.findIndex(t => t.qrNumber === initialTicketNumber));
  const [settings, setSettings] = useState(() => loadSettings(eventName));
  const [startIndex, setStartIndex] = useState(initial);
  const [endIndex, setEndIndex] = useState(initialTicketNumber === undefined ? Math.max(printable.length - 1, 0) : initial);
  const [manualPrintMode, setManualPrintMode] = useState(false);
  const [markerStatus, setMarkerStatus] = useState("");
  const detectionId = useRef(0);

  const update = <K extends keyof TicketDesignSettings>(key: K, value: TicketDesignSettings[K]) =>
    setSettings(current => ({ ...current, [key]: value }));

  const ratio = (() => {
    switch (settings.cardRatio) {
      case "4:3": return { width: 4, height: 3 };
      case "3:2": return { width: 3, height: 2 };
      case "card": return { width: 1.586, height: 1 };
      case "square": return { width: 1, height: 1 };
      case "9:16": return { width: 9, height: 16 };
      case "custom": return { width: Math.max(1, settings.customWidth), height: Math.max(1, settings.customHeight) };
      default: return { width: 16, height: 9 };
    }
  })();

  const widthMm = Math.max(30, settings.printWidthMm);
  const heightMm = widthMm * ratio.height / ratio.width;
  const selected = useMemo(() => {
    if (!printable.length) return [];
    const s = Math.min(Math.max(startIndex, 0), printable.length - 1);
    const e = Math.min(Math.max(endIndex, s), printable.length - 1);
    return printable.slice(s, e + 1);
  }, [printable, startIndex, endIndex]);
  const preview = selected[0] ?? printable[0] ?? null;
  const previewTicket = preview ?? printable[0];

  const handleBackground = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      alert("PNGやJPEGなどの画像を選択してください。");
      return;
    }
    const reader = new FileReader();
    const id = ++detectionId.current;
    reader.onload = async () => {
      if (typeof reader.result !== "string") return;
      const image = reader.result;
      update("backgroundImage", image);
      setMarkerStatus("画像の縦横比とピンクのQR位置マーカーを解析しています…");
      try {
        const analysis = await analyzeTicketBackgroundFromDataUrl(image);
        if (detectionId.current !== id) return;
        const marker = analysis.marker;
        if (!marker) {
          setSettings(current => ({ ...current, backgroundImage: image, cardRatio: analysis.ratio.cardRatio }));
          setMarkerStatus(`画像比率を${analysis.ratio.label}に自動設定しました。ピンクの正方形は見つからなかったため、QRコード欄で手動調整できます。`);
          return;
        }
        const round = (v: number) => Math.round(v * 10) / 10;
        const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
        setSettings(current => ({
          ...current,
          backgroundImage: image,
          cardRatio: analysis.ratio.cardRatio,
          qrX: round(clamp(marker.centerXPercent, 5, 95)),
          qrY: round(clamp(marker.centerYPercent, 5, 95)),
          qrSize: round(clamp(marker.sizePercent, 12, 55)),
        }));
        setMarkerStatus(`ピンクのQR位置マーカーを検出しました。QR位置・大きさを自動設定しました。`);
      } catch {
        if (detectionId.current === id) setMarkerStatus("画像を解析できませんでした。QRコード欄から手動調整できます。");
      }
    };
    reader.readAsDataURL(file);
  };

  const save = () => {
    try {
      localStorage.setItem(storageKey(eventName), JSON.stringify(settings));
      alert(`${eventName || "現在のイベント"}のチケットデザインを保存しました。`);
    } catch {
      alert("デザインを保存できませんでした。画像が大きすぎる可能性があります。");
    }
  };

  const reset = () => {
    if (!window.confirm("背景画像や配置を初期状態に戻しますか？")) return;
    setSettings({ ...defaultSettings });
    ++detectionId.current;
    setMarkerStatus("");
    localStorage.removeItem(storageKey(eventName));
  };

  const print = () => {
    if (!selected.length) {
      alert("印刷できるチケットがありません。");
      return;
    }
    const ipad = /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ipad) setManualPrintMode(true);
    else window.print();
  };

  const sheet = (
    <div className="ticket-print-sheet" style={{ "--ticket-print-width": `${widthMm}mm`, "--ticket-print-height": `${heightMm}mm`, "--ticket-print-gap": `${Math.max(0, settings.printGapMm)}mm` } as CSSProperties}>
      {selected.map(ticket => (
        <div className="ticket-print-card" key={ticket.id} style={{ backgroundImage: settings.backgroundImage ? `url("${settings.backgroundImage}")` : undefined }}>
          <div className="ticket-design-qr" style={{ left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
            <LazyQrCode value={qrValue(ticket)} size={500} level="M" marginSize={1} />
          </div>
          {settings.showTicketNumber && <div className="ticket-design-number" style={{ left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize}px` }}>{ticket.qrNumber}</div>}
        </div>
      ))}
    </div>
  );

  if (!printable.length) {
    return <div className="ticket-designer-background"><section className="ticket-designer-empty"><h2>印刷できるチケットがありません</h2><p>チケットを発行するか、有効状態にしてください。</p><button type="button" onClick={onClose}>閉じる</button></section></div>;
  }

  if (manualPrintMode) {
    return <div className="ticket-manual-print-page">
      <header className="ticket-manual-print-toolbar"><div><h2>iPad用印刷画面</h2><p>Safariの共有ボタンから「プリント」を選択してください。</p><strong>印刷対象：{selected.length}枚</strong></div><button type="button" onClick={() => setManualPrintMode(false)}>デザイン画面に戻る</button></header>
      <main className="ticket-manual-print-content">{sheet}</main>
    </div>;
  }

  return <div className="ticket-designer-background">
    <section className="ticket-designer-window">
      <header className="ticket-designer-header"><div><h2>チケットデザイン・印刷</h2><p>背景画像にQRコードとチケット番号を配置します</p></div><button type="button" className="ticket-designer-close" onClick={onClose}>×</button></header>
      <main className="ticket-designer-content">
        <section className="ticket-designer-preview-section">
          <div className="ticket-preview-heading"><h3>印刷プレビュー</h3><span>{widthMm.toFixed(1)}mm × {heightMm.toFixed(1)}mm</span></div>
          <div className="ticket-preview-container">
            <div className="ticket-design-card" style={{ aspectRatio: `${ratio.width} / ${ratio.height}`, backgroundImage: settings.backgroundImage ? `url("${settings.backgroundImage}")` : undefined }}>
              {!settings.backgroundImage && <div className="ticket-no-background">背景画像を選択してください</div>}
              <div className="ticket-design-qr" style={{ left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
                <LazyQrCode value={preview ? qrValue(preview) : ""} size={500} level="M" marginSize={1} />
              </div>
              {settings.showTicketNumber && <div className="ticket-design-number" style={{ left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize}px` }}>{previewTicket?.qrNumber}</div>}
            </div>
          </div>
          <section className="ticket-print-range"><h3>印刷する範囲</h3><div className="ticket-range-inputs">
            <label>最初のチケット<select value={startIndex} onChange={e => { const v = Number(e.target.value); setStartIndex(v); if (endIndex < v) setEndIndex(v); }}>{printable.map((t, i) => <option key={t.id} value={i}>{t.qrNumber}</option>)}</select></label>
            <span>～</span>
            <label>最後のチケット<select value={endIndex} onChange={e => setEndIndex(Number(e.target.value))}>{printable.map((t, i) => <option key={t.id} value={i} disabled={i < startIndex}>{t.qrNumber}</option>)}</select></label>
          </div><div className="ticket-range-summary">印刷対象：<strong>{selected.length}</strong><span>枚</span></div></section>
        </section>

        <aside className="ticket-designer-settings">
          <h3>デザイン設定</h3>
          <div className="ticket-setting-group"><h4>背景画像</h4>
            <label className="ticket-background-label">PNG・JPEG画像<input type="file" accept="image/png,image/jpeg" onChange={handleBackground} /></label>
            <p className="ticket-designer-help">KeynoteやPowerPointから書き出したPNG画像も使用できます。</p>
            <div className="ticket-marker-instruction"><span className="ticket-marker-swatch" /><p>QRを置きたい場所に、鮮やかなピンクの塗りつぶし正方形を1つ置いてください。</p></div>
            {markerStatus && <div className="ticket-marker-status ticket-marker-status-success">{markerStatus}</div>}
            {settings.backgroundImage && <button type="button" className="ticket-remove-background" onClick={() => { ++detectionId.current; update("backgroundImage", ""); setMarkerStatus(""); }}>背景画像を削除</button>}
          </div>

          <div className="ticket-setting-group"><h4>チケットサイズ</h4>
            <label className="ticket-select-setting">比率<select value={settings.cardRatio} onChange={e => update("cardRatio", e.target.value as CardRatio)}><option value="16:9">16:9</option><option value="4:3">4:3</option><option value="3:2">3:2</option><option value="card">カード比率</option><option value="square">正方形</option><option value="9:16">9:16</option><option value="custom">カスタム</option></select></label>
            {settings.cardRatio === "custom" && <div className="ticket-custom-ratio"><label>横<input type="number" value={settings.customWidth} onChange={e => update("customWidth", Math.max(1, Number(e.target.value)))}/></label><span>:</span><label>縦<input type="number" value={settings.customHeight} onChange={e => update("customHeight", Math.max(1, Number(e.target.value)))}/></label></div>}
            <label className="ticket-number-setting">印刷時の横幅<input type="number" min="30" max="210" step="0.1" value={settings.printWidthMm} onChange={e => update("printWidthMm", Math.max(30, Number(e.target.value)))} /><span>mm</span></label>
          </div>

          <div className="ticket-setting-group"><h4>QRコード</h4>
            {(["qrX","qrY","qrSize"] as const).map((key, i) => <label key={key}>{i === 0 ? "横位置" : i === 1 ? "縦位置" : "大きさ"}<input type="range" min={i === 2 ? 12 : 5} max={i === 2 ? 55 : 95} step="0.1" value={settings[key]} onChange={e => update(key, Number(e.target.value))}/><span>{settings[key]}%</span></label>)}
          </div>

          <div className="ticket-setting-group"><h4>チケット番号</h4>
            <label className="ticket-visibility-setting"><span>チケット番号を印刷する</span><input type="checkbox" checked={settings.showTicketNumber} onChange={e => update("showTicketNumber", e.target.checked)}/></label>
            {(["numberX","numberY","numberSize"] as const).map((key, i) => <label key={key}>{i === 0 ? "横位置" : i === 1 ? "縦位置" : "文字サイズ"}<input type="range" disabled={!settings.showTicketNumber} min={i === 2 ? 10 : 0} max={i === 2 ? 60 : 100} value={settings[key]} onChange={e => update(key, Number(e.target.value))}/><span>{settings[key]}{i === 2 ? "px" : "%"}</span></label>)}
          </div>

          <div className="ticket-setting-group"><h4>まとめて印刷</h4>
            <label className="ticket-select-setting">1行に並べる枚数<select value={settings.cardsPerRow} onChange={e => update("cardsPerRow", Number(e.target.value))}>{[1,2,3,4].map(n => <option key={n} value={n}>{n}枚</option>)}</select></label>
            <label className="ticket-number-setting">チケット間の余白<input type="number" min="0" max="20" value={settings.printGapMm} onChange={e => update("printGapMm", Math.max(0, Number(e.target.value)))} /><span>mm</span></label>
          </div>
        </aside>
      </main>
      <footer className="ticket-designer-buttons"><button className="ticket-design-save" onClick={save}>デザインを保存</button><button className="ticket-design-print" onClick={print}>選択した範囲を印刷</button><button className="ticket-design-reset" onClick={reset}>初期状態に戻す</button><button className="ticket-design-cancel" onClick={onClose}>閉じる</button></footer>
    </section>
    {sheet}
  </div>;
}

export default TicketDesigner;
