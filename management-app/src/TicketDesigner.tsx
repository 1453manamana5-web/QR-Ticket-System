import {
  type ChangeEvent,
  type CSSProperties,
  useEffect,
  type ReactNode,
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

type StudioImage={id:string;src:string;x:number;y:number;width:number;name:string};
type TicketDesignSettings = {
  images?:StudioImage[];
  layerOrder?:string[];
  locked?:Record<string,boolean>;
  titleColor?:string;
  titleFont?:string;
  titleBold?:boolean;

  backgroundImage: string;
  title?: string;
  titleX?: number;
  titleY?: number;
  titleSize?: number;

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

function layerStyle(settings:TicketDesignSettings,id:string):CSSProperties {
  const order=settings.layerOrder??["number","qr","title",...(settings.images??[]).map(image=>image.id)];
  return {zIndex:Math.max(0,order.indexOf(id))+2};
}
function textStyle(settings:TicketDesignSettings):CSSProperties{return {...layerStyle(settings,"title"),color:settings.titleColor??"#162e4a",fontFamily:settings.titleFont??"sans-serif",fontWeight:settings.titleBold===false?400:700};}
function AddedImages({settings,onSelect,onResize,selected}:{settings:TicketDesignSettings;onSelect?:(id:string,e:React.PointerEvent<HTMLElement>)=>void;onResize?:(id:string,e:React.PointerEvent<HTMLElement>)=>void;selected?:string|null}){
 return <>{(settings.images??[]).map(image=><div key={image.id} className={`studio-image ${onSelect?"ticket-draggable-part":""} ${selected===image.id?"is-selected":""}`} style={{position:"absolute",left:`${image.x}%`,top:`${image.y}%`,width:`${image.width}%`,transform:"translate(-50%,-50%)",...layerStyle(settings,image.id)}} onPointerDown={onSelect?e=>onSelect(image.id,e):undefined}><img src={image.src} alt={image.name} draggable={false} style={{display:"block",width:"100%",height:"auto"}}/>{onResize&&selected===image.id&&!settings.locked?.[image.id]&&<button type="button" className="studio-resize" aria-label="画像をリサイズ" onPointerDown={e=>onResize(image.id,e)}/>}</div>)}</>;
}

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

function FloatingPanel({title,className,children,onClose}:{title:string;className:string;children:ReactNode;onClose:()=>void}) {
  const ref=useRef<HTMLElement>(null);
  const drag=useRef<{x:number;y:number;left:number;top:number}|null>(null);
  useEffect(()=>{
    const panel=ref.current;if(!panel)return;
    const clamp=()=>{const host=panel.offsetParent as HTMLElement;if(!host)return;
      if(panel.style.left)panel.style.left=`${Math.max(8,Math.min(parseFloat(panel.style.left),host.clientWidth-panel.offsetWidth-8))}px`;
      if(panel.style.top)panel.style.top=`${Math.max(8,Math.min(parseFloat(panel.style.top),host.clientHeight-panel.offsetHeight-8))}px`;
    };
    const observer=new ResizeObserver(clamp);observer.observe(panel);if(panel.offsetParent)observer.observe(panel.offsetParent);return()=>observer.disconnect();
  },[]);
  return <section ref={ref} className={`studio-panel ${className}`}><header onPointerDown={e=>{
    if((e.target as HTMLElement).closest('button'))return;
    drag.current={x:e.clientX,y:e.clientY,left:ref.current!.offsetLeft,top:ref.current!.offsetTop};e.currentTarget.setPointerCapture(e.pointerId);
  }} onPointerMove={e=>{const start=drag.current,panel=ref.current;if(!start||!panel)return;const host=panel.offsetParent as HTMLElement;
    panel.style.left=`${Math.max(8,Math.min(host.clientWidth-panel.offsetWidth-8,start.left+e.clientX-start.x))}px`;
    panel.style.top=`${Math.max(8,Math.min(host.clientHeight-panel.offsetHeight-8,start.top+e.clientY-start.y))}px`;
    panel.style.right='auto';panel.style.bottom='auto';
  }} onPointerUp={()=>{drag.current=null;}} onPointerCancel={()=>{drag.current=null;}}><strong>⠿ &nbsp;{title}</strong><button type="button" onClick={onClose} aria-label={`${title}を閉じる`}>×</button></header><div className="studio-panel-body">{children}</div></section>;
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
  const [panel,setPanel]=useState<"settings"|"range"|"layers"|null>(null);
  const [titleSelected,setTitleSelected]=useState(false);
  const [selectedImage,setSelectedImage]=useState<string|null>(null);
  const [guides,setGuides]=useState<{x?:number;y?:number}>({});
  const [snapEnabled,setSnapEnabled]=useState(true);

  const [saved,setSaved]=useState(false);
  const undo=useRef<TicketDesignSettings[]>([]),redo=useRef<TicketDesignSettings[]>([]);
  const [,refreshHistory]=useState(0);
  const checkpoint=()=>{undo.current.push({...settings});if(undo.current.length>40)undo.current.shift();redo.current=[];refreshHistory(n=>n+1);setSaved(false);};
  const restore=(from:typeof undo,to:typeof redo)=>{const value=from.current.pop();if(value){to.current.push(settings);setSettings(value);refreshHistory(n=>n+1);setSaved(false);}};


  const [settings, setSettings] =
    useState<TicketDesignSettings>(
      () => loadDesignSettings(eventName)
    );
  const [showEditor, setShowEditor] = useState(
    () => {const saved=loadDesignSettings(eventName);return Boolean(saved.backgroundImage||saved.title||saved.images?.length);}
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

  useEffect(()=>{setSaved(false);},[settings]);
  const updateSetting = <
    Key extends keyof TicketDesignSettings,
  >(
    key: Key,
    value: TicketDesignSettings[Key]
  ) => {
    const part=String(key).startsWith("qr")?"qr":String(key).startsWith("number")?"number":String(key).startsWith("title")?"title":null;
    if(part&&settings.locked?.[part])return;
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

      setSaved(true);
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
    if (selectedTickets.length === 0) {
      alert("印刷できるチケットがありません。");
      return;
    }

    /*
      Safariやホーム画面起動では、現在の画面に対する
      window.print() が反応しないことがあります。
      ユーザー操作中に印刷専用ウィンドウを開き、
      チケット一覧だけを複製して印刷します。
    */
    try {
      const sourceSheet = document.querySelector<HTMLElement>(".ticket-print-sheet");
      if (!sourceSheet) {
        throw new Error("印刷用チケット一覧が見つかりません。");
      }

      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        // ポップアップが制限されている環境では従来の印刷方法へフォールバック。
        window.focus();
        void document.body.offsetHeight;
        window.print();
        return;
      }

      const sheet = sourceSheet.cloneNode(true) as HTMLElement;
      sheet.style.display = "block";
      sheet.style.visibility = "visible";

      printWindow.document.open();
      printWindow.document.write(`<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${eventName || "チケット"} - 印刷</title>
<style>
  @page { size: auto; margin: 8mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", sans-serif; }
  .ticket-print-sheet {
    display: block;
    width: 100%;
    margin: 0;
    padding: 0;
    border: 0;
    background: #fff;
    font-size: 0;
    line-height: 0;
    text-align: left;
  }
  .ticket-print-row {
    display: flex;
    flex-flow: row nowrap;
    align-items: flex-start;
    gap: var(--ticket-print-gap, 4mm);
    width: max-content;
    max-width: 100%;
    margin: 0 0 var(--ticket-print-gap, 4mm);
    break-inside: avoid;
    page-break-inside: avoid;
    -webkit-column-break-inside: avoid;
  }
  .ticket-print-card {
    position: relative;
    display: block;
    flex: 0 0 var(--ticket-print-width, 90mm);
    width: var(--ticket-print-width, 90mm);
    height: var(--ticket-print-height, 50.625mm);
    min-width: var(--ticket-print-width, 90mm);
    min-height: var(--ticket-print-height, 50.625mm);
    max-width: var(--ticket-print-width, 90mm);
    max-height: var(--ticket-print-height, 50.625mm);
    margin: 0;
    padding: 0;
    box-sizing: border-box;
    overflow: hidden;
    background-color: #fff;
    background-position: center;
    background-size: contain;
    background-repeat: no-repeat;
    break-inside: avoid;
    page-break-inside: avoid;
    -webkit-column-break-inside: avoid;
    print-color-adjust: exact;
    -webkit-print-color-adjust: exact;
  }
  .ticket-design-qr, .ticket-design-number, .ticket-design-title { position: absolute; }
  .ticket-design-title { transform:translate(-50%,-50%); font-weight:700; white-space:pre-wrap; max-width:95%; line-height:1.2; }
  .ticket-design-qr {
    z-index: 3;
    aspect-ratio: 1 / 1;
    box-sizing: border-box;
    padding: .8%;
    background: #fff;
    transform: translate(-50%, -50%);
    transform-origin: center center;
  }
  .ticket-design-qr svg {
    display: block;
    width: 100%;
    height: 100%;
    max-width: none;
  }
  .ticket-design-number {
    z-index: 2;
    max-width: 65%;
    color: #000;
    font-weight: bold;
    line-height: 1.1;
    white-space: nowrap;
    transform: translate(-50%, -50%);
    transform-origin: center center;
  }
  @media print {
    html, body { margin: 0; padding: 0; width: auto; height: auto; overflow: visible; }
    body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .ticket-print-sheet { break-inside: auto; page-break-inside: auto; }
    .ticket-print-row { break-inside: avoid; page-break-inside: avoid; }
    .ticket-print-card { break-inside: avoid; page-break-inside: avoid; }
  }
</style>
</head>
<body></body>
</html>`);
      printWindow.document.body.appendChild(sheet);
      printWindow.document.close();

      // loadイベントとreadyStateの両方から呼ばれても、印刷ダイアログは一度だけ開く。
      let printStarted = false;
      const startPrint = () => {
        if (printStarted || printWindow.closed) return;
        printStarted = true;
        printWindow.focus();
        printWindow.print();
      };
      printWindow.addEventListener("load", startPrint, { once: true });
      if (printWindow.document.readyState === "complete") {
        window.setTimeout(startPrint, 300);
      }
    } catch (error) {
      console.error("印刷画面を開けませんでした。", error);
      alert("印刷画面を開けませんでした。ポップアップを許可して、もう一度お試しください。");
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

  const selectLayer=(id:string)=>{setSelectedImage(id.startsWith("image-")?id:null);setTitleSelected(id==="title");setSelectedPart(id==="qr"||id==="number"?id:null);};
  const images=settings.images??[];
  const layers=settings.layerOrder??["number","qr","title",...images.map(image=>image.id)];
  const activeLayer=selectedImage??(titleSelected?"title":selectedPart);
  const activeLocked=Boolean(activeLayer&&settings.locked?.[activeLayer]);
  const imageUpload=(event:ChangeEvent<HTMLInputElement>)=>{const file=event.target.files?.[0];event.target.value="";if(!file)return;if(!file.type.startsWith("image/")||file.type==="image/svg+xml"){alert("PNG・JPEG・WebPなどの画像を選択してください。");return;}if(file.size>5*1024*1024){alert("追加画像は5MB以下にしてください。");return;}const reader=new FileReader();reader.onload=()=>{if(typeof reader.result!=="string")return;checkpoint();const id="image-"+crypto.randomUUID();const image={id,src:reader.result,x:50,y:50,width:30,name:file.name};setSettings(current=>({...current,images:[...(current.images??[]),image],layerOrder:[...(current.layerOrder??["number","qr","title",...(current.images??[]).map(i=>i.id)]),id]}));selectLayer(id);};reader.onerror=()=>alert("画像を読み込めませんでした。");reader.readAsDataURL(file);};
  const resizePart=(part:string,e:React.PointerEvent<HTMLElement>)=>{
    e.stopPropagation();selectLayer(part);if(settings.locked?.[part])return;checkpoint();const target=e.currentTarget;target.setPointerCapture(e.pointerId);
    const image=images.find(i=>i.id===part),start=e.clientX,size=image?image.width:part==="qr"?settings.qrSize:part==="number"?settings.numberSize:settings.titleSize??28;
    const width=ticketCardRef.current?.getBoundingClientRect().width||500;
    const move=(ev:PointerEvent)=>{const value=Math.max(image?5:part==="qr"?12:10,Math.min(image?100:part==="qr"?55:part==="number"?60:80,size+(ev.clientX-start)/width*(image||part==="qr"?100:120)));if(image)setSettings(current=>({...current,images:current.images?.map(i=>i.id===part?{...i,width:value}:i)}));else updateSetting(part==="qr"?"qrSize":part==="number"?"numberSize":"titleSize",value);};
    const stop=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',stop);target.removeEventListener('pointercancel',stop);};target.addEventListener('pointermove',move);target.addEventListener('pointerup',stop);target.addEventListener('pointercancel',stop);
  };
  const movePart=(part:string,e:React.PointerEvent<HTMLElement>)=>{
    e.stopPropagation();selectLayer(part);if(settings.locked?.[part])return;checkpoint();
    const card=ticketCardRef.current;if(!card)return;const rect=card.getBoundingClientRect(),item=e.currentTarget.getBoundingClientRect();
    const x=e.clientX,y=e.clientY,image=images.find(i=>i.id===part);
    const left=image?image.x:part==="qr"?settings.qrX:part==="number"?settings.numberX:settings.titleX??32;
    const top=image?image.y:part==="qr"?settings.qrY:part==="number"?settings.numberY:settings.titleY??30;
    const halfX=item.width/rect.width*50,halfY=item.height/rect.height*50;
    const peers=[{id:"qr",x:settings.qrX,y:settings.qrY},{id:"number",x:settings.numberX,y:settings.numberY},...(settings.title?[{id:"title",x:settings.titleX??32,y:settings.titleY??30}]:[]),...images].filter(i=>i.id!==part);
    const snap=(value:number,targets:{value:number;line:number}[],threshold:number)=>{const closest=targets.reduce((a,b)=>Math.abs(b.value-value)<Math.abs(a.value-value)?b:a);return snapEnabled&&Math.abs(closest.value-value)<threshold?{value:closest.value,line:closest.line}:{value:Math.max(0,Math.min(100,value)),line:undefined};};
    const target=e.currentTarget;target.setPointerCapture(e.pointerId);
    const move=(event:PointerEvent)=>{const nx=snap(left+(event.clientX-x)/rect.width*100,[{value:halfX,line:0},{value:50,line:50},{value:100-halfX,line:100},...peers.map(p=>({value:p.x,line:p.x}))],7/rect.width*100);const ny=snap(top+(event.clientY-y)/rect.height*100,[{value:halfY,line:0},{value:50,line:50},{value:100-halfY,line:100},...peers.map(p=>({value:p.y,line:p.y}))],7/rect.height*100);setGuides({x:nx.line,y:ny.line});setSettings(current=>image?({...current,images:current.images?.map(i=>i.id===part?{...i,x:nx.value,y:ny.value}:i)}):({...current,[part==="qr"?"qrX":part==="number"?"numberX":"titleX"]:nx.value,[part==="qr"?"qrY":part==="number"?"numberY":"titleY"]:ny.value}));};
    const stop=()=>{setGuides({});target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',stop);target.removeEventListener('pointercancel',stop);};target.addEventListener('pointermove',move);target.addEventListener('pointerup',stop);target.addEventListener('pointercancel',stop);
  };
  return (
    <div className="ticket-designer-background ticket-designer-glass ticket-studio">
      <section className="ticket-designer-window" role="dialog" aria-modal="true" aria-label="チケットデザイン">
        <header className="studio-header"><div><strong>チケットデザイン</strong><span>{eventName}</span></div>
          <nav><span className="studio-save-state">{saved?"✓ 保存済み":"編集中"}</span>
          <button type="button" disabled={!undo.current.length} onClick={()=>restore(undo,redo)} aria-label="元に戻す">↶</button>
          <button type="button" disabled={!redo.current.length} onClick={()=>restore(redo,undo)} aria-label="やり直す">↷</button>
          <button type="button" onClick={()=>setShowActualSize(true)}>実寸確認</button>
          <button type="button" className="studio-primary" onClick={saveDesign}>保存</button>
          <button type="button" onClick={printTickets}>印刷</button>
          <button type="button" onClick={onClose} aria-label="デザイン画面を閉じる">×</button></nav>
        </header>
        <main className="studio-workspace">
          <nav className="studio-dock" aria-label="編集ツール">
            <button type="button" onClick={()=>{setPanel(null);setSelectedImage(null);setTitleSelected(false);setSelectedPart(null);}}>↖<small>選択</small></button>
            <button type="button" onClick={()=>{checkpoint();if(!settings.title)updateSetting("title",eventName||"イベント名");setSelectedImage(null);setTitleSelected(true);setSelectedPart(null);}}>T<small>文字</small></button>
            <label>▧<small>画像</small><input aria-label="画像を追加" type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={imageUpload}/></label>
            <button type="button" onClick={()=>setPanel(panel==="layers"?null:"layers")}>▱<small>レイヤー</small></button>
            <label>▧<small>背景</small><input type="file" accept="image/*" onChange={handleBackgroundImage}/></label>
            <button type="button" onClick={()=>{setSelectedImage(null);setTitleSelected(false);setSelectedPart("qr");}}>▦<small>QR</small></button>
            <button type="button" onClick={()=>{setSelectedImage(null);setTitleSelected(false);setSelectedPart("number");}}>＃<small>番号</small></button>
            <button type="button" className={panel==="settings"?"active":""} onClick={()=>setPanel(panel==="settings"?null:"settings")}>⚙<small>設定</small></button>
            <button type="button" className={panel==="range"?"active":""} onClick={()=>setPanel(panel==="range"?null:"range")}>▤<small>一覧</small></button>
          </nav>
          <div className="studio-canvas" onClick={()=>{}}>
            <div className="studio-context" onPointerDownCapture={checkpoint}>
              <span>{titleSelected?"イベント名":selectedPart==="qr"?"QRコード":selectedPart==="number"?"チケット番号":"キャンバス"}</span>
              {selectedImage?<><span>追加画像{activeLocked?"（ロック中）":""}</span><button type="button" disabled={activeLocked} onClick={()=>{checkpoint();setSettings(current=>({...current,images:current.images?.filter(i=>i.id!==selectedImage),layerOrder:layers.filter(id=>id!==selectedImage)}));setSelectedImage(null);}}>削除</button></>:titleSelected?<><input disabled={activeLocked} aria-label="イベント名の文字" value={settings.title??""} onChange={e=>updateSetting("title",e.target.value)}/><input disabled={activeLocked} type="number" aria-label="イベント名の文字サイズ" min="10" max="80" value={settings.titleSize??28} onChange={e=>updateSetting("titleSize",Math.max(10,Math.min(80,Number(e.target.value))))}/><input aria-label="文字色" type="color" disabled={activeLocked} value={settings.titleColor??"#162e4a"} onChange={e=>updateSetting("titleColor",e.target.value)}/><select aria-label="フォント" disabled={activeLocked} value={settings.titleFont??"sans-serif"} onChange={e=>updateSetting("titleFont",e.target.value)}><option value="sans-serif">ゴシック</option><option value="serif">明朝</option><option value="monospace">等幅</option></select><button type="button" disabled={activeLocked} aria-pressed={settings.titleBold!==false} onClick={()=>updateSetting("titleBold",settings.titleBold===false)}>太字</button><button type="button" disabled={activeLocked} onClick={()=>updateSetting("title","")}>削除</button></>:
              selectedPart?<><span>サイズ</span><input disabled={activeLocked} type="range" aria-label="選択パーツのサイズ" min={selectedPart==="qr"?12:10} max={selectedPart==="qr"?55:60} value={selectedPart==="qr"?settings.qrSize:settings.numberSize} onChange={e=>updateSetting(selectedPart==="qr"?"qrSize":"numberSize",Number(e.target.value))}/><button type="button" onClick={()=>setPanel("settings")}>配置を調整</button></>:<span>文字・QR・番号をドラッグして配置</span>}
            </div>
            <div className="studio-paper-area" onPointerDown={e=>{if((e.target as HTMLElement).closest('.ticket-draggable-part'))return;panDragStart.current={pointerId:e.pointerId,x:e.clientX,y:e.clientY,panX:previewPan.x,panY:previewPan.y};e.currentTarget.setPointerCapture(e.pointerId);}} onPointerMove={e=>{const start=panDragStart.current;if(start?.pointerId===e.pointerId)setPreviewPan({x:start.panX+e.clientX-start.x,y:start.panY+e.clientY-start.y});}} onPointerUp={()=>{panDragStart.current=null;}} onPointerCancel={()=>{panDragStart.current=null;}} onTouchStart={e=>{if(e.touches.length===2){pinchStartDistance.current=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);pinchStartZoom.current=previewZoom;}}} onTouchMove={e=>{if(e.touches.length===2&&pinchStartDistance.current){const distance=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);setPreviewZoom(Math.max(.5,Math.min(3,pinchStartZoom.current*distance/pinchStartDistance.current)));}}} onTouchEnd={()=>{pinchStartDistance.current=null;}}>
              <div ref={ticketCardRef} className="ticket-design-card" style={{...previewTicketStyle,transform:`translate(${previewPan.x}px,${previewPan.y}px) scale(${previewZoom})`,transformOrigin:"center"}}>
                <AddedImages settings={settings} selected={selectedImage} onSelect={movePart} onResize={resizePart}/>
                {guides.x!==undefined&&<div className="studio-guide vertical" style={{left:`${guides.x}%`}}/>}{guides.y!==undefined&&<div className="studio-guide horizontal" style={{top:`${guides.y}%`}}/>}
                {!settings.backgroundImage&&<div className="studio-paper-placeholder"><span>TICKET</span><small>{eventName}</small></div>}
                {settings.title&&<div className={`ticket-design-title ticket-draggable-part ${titleSelected?"is-selected":""}`} style={{...textStyle(settings),left:`${settings.titleX??32}%`,top:`${settings.titleY??30}%`,fontSize:`${settings.titleSize??28}px`}} onPointerDown={e=>movePart("title",e)}>{settings.title}{titleSelected&&<button className="studio-resize" aria-label="文字をリサイズ" onPointerDown={e=>resizePart("title",e)}/>}</div>}
                <div className={`ticket-design-qr ticket-draggable-part ${selectedPart==="qr"?"is-selected":""}`} style={{...layerStyle(settings,"qr"),left:`${settings.qrX}%`,top:`${settings.qrY}%`,width:`${settings.qrSize}%`}} onPointerDown={e=>movePart("qr",e)}><LazyQrCode value={previewTicket?qrValue(previewTicket):""} size={500} level="M" marginSize={1}/>{selectedPart==="qr"&&<button className="studio-resize" aria-label="QRをリサイズ" onPointerDown={e=>resizePart("qr",e)}/>}</div>
                <div className={`ticket-design-number ticket-draggable-part ${selectedPart==="number"?"is-selected":""}`} style={{...layerStyle(settings,"number"),left:`${settings.numberX}%`,top:`${settings.numberY}%`,fontSize:`${settings.numberSize}px`}} onPointerDown={e=>movePart("number",e)}>{previewTicket?.qrNumber}{selectedPart==="number"&&<button className="studio-resize" aria-label="番号をリサイズ" onPointerDown={e=>resizePart("number",e)}/>}</div>
              </div>
            </div>
            <div className="studio-zoom"><button type="button" aria-label="縮小" onClick={()=>setPreviewZoom(z=>Math.max(.5,z-.1))}>−</button><span>{Math.round(previewZoom*100)}%</span><button type="button" aria-label="拡大" onClick={()=>setPreviewZoom(z=>Math.min(3,z+.1))}>＋</button><button type="button" onClick={()=>{setPreviewZoom(1);setPreviewPan({x:0,y:0});}}>画面に合わせる</button></div>
          </div>
          {panel==="layers"&&<FloatingPanel title="レイヤー" className="studio-inspector" onClose={()=>setPanel(null)}><div className="studio-layers"><label><input type="checkbox" checked={snapEnabled} onChange={e=>setSnapEnabled(e.target.checked)}/>吸着・整列ガイド</label><p>上の項目ほど手前に表示されます</p>{[...layers].reverse().filter(id=>id!=="title"||settings.title).map(id=><div key={id} className={activeLayer===id?"active":""}><button type="button" onClick={()=>selectLayer(id)}>{id==="qr"?"QRコード":id==="number"?"チケット番号":id==="title"?"文字":images.find(i=>i.id===id)?.name??"画像"}</button><button type="button" aria-label={`${id}をロック切替`} aria-pressed={Boolean(settings.locked?.[id])} onClick={()=>{checkpoint();setSettings(current=>({...current,locked:{...current.locked,[id]:!current.locked?.[id]}}));}}>{settings.locked?.[id]?"固定":"自由"}</button><button type="button" aria-label={`${id}を前へ`} disabled={layers.indexOf(id)===layers.length-1} onClick={()=>{checkpoint();const order=[...layers],i=order.indexOf(id);[order[i],order[i+1]]=[order[i+1],order[i]];updateSetting("layerOrder",order);}}>↑</button><button type="button" aria-label={`${id}を後ろへ`} disabled={layers.indexOf(id)===0} onClick={()=>{checkpoint();const order=[...layers],i=order.indexOf(id);[order[i],order[i-1]]=[order[i-1],order[i]];updateSetting("layerOrder",order);}}>↓</button></div>)}<p>背景画像は常に最背面に固定されます。</p></div></FloatingPanel>}
          {panel==="settings"&&<FloatingPanel title="配置・サイズ" className="studio-inspector" onClose={()=>setPanel(null)}><div className="ticket-designer-settings" onPointerDownCapture={checkpoint}>            <div className="ticket-setting-group">
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
<div className="studio-reset"><button type="button" onClick={resetDesign}>初期状態に戻す</button></div></div></FloatingPanel>}
          {panel==="range"&&<FloatingPanel title="チケット一覧・印刷範囲" className="studio-inventory" onClose={()=>setPanel(null)}><div className="ticket-print-range"><div className="studio-thumbnails">{printableTickets.slice(Math.max(0,startIndex-2),Math.max(0,startIndex-2)+12).map(ticket=><button type="button" key={ticket.id} aria-label={`チケット ${ticket.qrNumber} を表示`} onClick={()=>{const index=printableTickets.indexOf(ticket);setStartIndex(index);if(endIndex<index)setEndIndex(index);}} style={{backgroundImage:settings.backgroundImage?`url("${settings.backgroundImage}")`:undefined}}><span>{ticket.qrNumber}</span></button>)}</div><div className="ticket-range-inputs">
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
</div></FloatingPanel>}
          <div className="studio-status"><span>{safePrintWidth.toFixed(1)} × {printHeightMm.toFixed(1)} mm</span><span>印刷対象 {selectedTickets.length}枚</span></div>
        </main>
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
                <AddedImages settings={settings}/>{settings.title&&<div className="ticket-design-title" style={{...textStyle(settings),left:`${settings.titleX??32}%`,top:`${settings.titleY??30}%`,fontSize:`${settings.titleSize??28}px`}}>{settings.title}</div>}
      <div className="ticket-design-qr" style={{ ...layerStyle(settings,"qr"), left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
                  <LazyQrCode value={previewTicket ? qrValue(previewTicket) : ""} size={500} level="M" marginSize={1} />
                </div>
                <div className="ticket-design-number" style={{ ...layerStyle(settings,"number"), left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize * screenScale}px` }}>{previewTicket?.qrNumber ?? ""}</div>
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
        {Array.from(
          {
            length: Math.ceil(
              selectedTickets.length /
              Math.max(1, Math.min(4, settings.cardsPerRow))
            ),
          },
          (_, rowIndex) => (
            <div className="ticket-print-row" key={`print-row-${rowIndex}`}>
              {selectedTickets
                .slice(
                  rowIndex * Math.max(1, Math.min(4, settings.cardsPerRow)),
                  (rowIndex + 1) * Math.max(1, Math.min(4, settings.cardsPerRow))
                )
                .map((ticket) => (
                  <div
                    key={ticket.id}
                    className="ticket-print-card"
                    style={{
                      backgroundImage:
                        settings.backgroundImage === ""
                          ? undefined
                          : `url("${settings.backgroundImage}")`,
                    }}
                  >
                    <AddedImages settings={settings}/>{settings.title&&<div className="ticket-design-title" style={{...textStyle(settings),left:`${settings.titleX??32}%`,top:`${settings.titleY??30}%`,fontSize:`${settings.titleSize??28}px`}}>{settings.title}</div>}
                    <div
                      className="ticket-design-qr"
                      style={{
                        ...layerStyle(settings,"qr"), left: `${settings.qrX}%`,
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
                        ...layerStyle(settings,"number"), left: `${settings.numberX}%`,
                        top: `${settings.numberY}%`,
                        fontSize: `${settings.numberSize}px`,
                      }}
                    >
                      {ticket.qrNumber}
                    </div>
                  </div>
                ))}
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
      <AddedImages settings={settings}/>{settings.title&&<div className="ticket-design-title" style={{...textStyle(settings),left:`${settings.titleX??32}%`,top:`${settings.titleY??30}%`,fontSize:`${settings.titleSize??28}px`}}>{settings.title}</div>}
      <div className="ticket-design-qr" style={{ ...layerStyle(settings,"qr"), left: `${settings.qrX}%`, top: `${settings.qrY}%`, width: `${settings.qrSize}%` }}>
        <LazyQrCode value={qrValue} size={500} level="M" marginSize={1} />
      </div>
      <div className="ticket-design-number" style={{ ...layerStyle(settings,"number"), left: `${settings.numberX}%`, top: `${settings.numberY}%`, fontSize: `${settings.numberSize}px` }}>{ticketNumber}</div>
    </div>
  );
}

export default TicketDesigner;