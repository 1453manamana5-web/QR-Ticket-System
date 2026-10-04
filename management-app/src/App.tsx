import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { publishEventBundle, type PublishedEventBundle } from "./eventPublisher";

const initialEvent: Event = { eventId: "DEMO-2027", eventName: "○○文化祭 2027", eventStatus: "ready", dataVersion: 1 };
const pages = ["ホーム", "イベント管理", "チケット管理", "端末管理", "スタッフ管理", "分析", "設定"];

function createTickets(eventId: string, count: number): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const id = Array.from(random, value => value.toString(36).toUpperCase()).join("").slice(0, 10).padEnd(10, "0");
    return { ticketId: id, eventId, basicInfo: { ticketNumber: index + 1 }, currentStatus: "unused", valid: true, updatedAt: new Date().toISOString() };
  });
}

export default function App() {
  const [page, setPage] = useState("ホーム");
  const [bundle, setBundle] = useState<PublishedEventBundle | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [eventName, setEventName] = useState(initialEvent.eventName);
  const [ticketCount, setTicketCount] = useState(500);
  const [savedEventName, setSavedEventName] = useState(initialEvent.eventName);
  const [settings, setSettings] = useState<ReceptionSettings>({ entryEnabled: true, exitEnabled: true, reentryEnabled: true });

  const saveEvent = () => {
    setSavedEventName(eventName.trim() || initialEvent.eventName);
    setError("");
  };

  const publish = async (nameToPublish = savedEventName, settingsToPublish = settings) => {
    if (publishing) return;
    const normalizedName = nameToPublish.trim() || initialEvent.eventName;
    setPublishing(true);
    setError("");
    setSavedEventName(normalizedName);
    try {
      const event = { ...initialEvent, eventName: normalizedName };
      const result = await publishEventBundle(event, settingsToPublish, createTickets(event.eventId, ticketCount));
      setBundle(result);
    } catch (reason) {
      console.error(reason);
      setError("Firebaseへ公開できませんでした。Firebase設定とFirestoreの権限を確認してください。");
    } finally {
      setPublishing(false);
    }
  };

  const authQrValue = bundle ? JSON.stringify({
    type: "qr-ticket-event-auth",
    eventId: bundle.event.eventId,
    eventName: bundle.event.eventName,
    dataVersion: bundle.event.dataVersion,
    authToken: bundle.authToken
  }) : "";

  const toggleSetting = (key: keyof ReceptionSettings) => {
    setSettings(current => ({ ...current, [key]: !current[key] }));
  };

  const pageContent = () => {
    if (page === "イベント管理") return <section className="panel">
      <div className="panel-title"><div><small>EVENT MANAGEMENT</small><h2>イベント管理</h2></div><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : "未公開"}</span></div>
      <div className="form-grid">
        <label>イベント名<input value={eventName} onChange={e => setEventName(e.target.value)} /></label>
        <label>イベントID<input value={initialEvent.eventId} disabled /></label>
        <label>チケット枚数<input type="number" min="1" max="5000" value={ticketCount} onChange={e => setTicketCount(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label>データバージョン<input value={initialEvent.dataVersion} disabled /></label>
      </div>
      <div className="actions">
        <button className="secondary" onClick={saveEvent}>イベント情報を保存</button>
        <button className="primary-action" disabled={publishing} onClick={() => void publish(eventName)}>{publishing ? "公開中…" : "Firebaseへ公開"}</button>
      </div>
      {error && <div className="notice error">{error}</div>}
      {bundle && <div className="notice success">イベントデータはFirebaseへ公開済みです。受付端末は下のQRで認証できます。</div>}
      {bundle && <div className="auth-card">
        <div><small>EVENT AUTHENTICATION</small><h2>受付端末用イベント認証QR</h2><p>受付アプリで読み取ると、チケット{bundle.tickets.length}枚を端末へ保存します。</p><p className="token">{bundle.authToken}</p></div>
        <div className="qr-box"><QRCodeSVG value={authQrValue} size={220} includeMargin /></div>
      </div>}
    </section>;

    if (page === "チケット管理") return <section className="panel">
      <div className="panel-title"><div><small>TICKET MANAGEMENT</small><h2>チケット管理</h2></div></div>
      <div className="metrics"><Metric title="総チケット" value={String(ticketCount)} sub="枚" /><Metric title="未使用" value={String(ticketCount)} sub="初期状態" /><Metric title="入場中" value="0" sub="人" /></div>
      <div className="notice">現在は公開時にチケットを一括生成します。次の段階でチケット一覧・検索・再発行を追加します。</div>
    </section>;

    if (page === "端末管理") return <section className="panel">
      <div className="panel-title"><div><small>TERMINAL MANAGEMENT</small><h2>端末管理</h2></div></div>
      <Terminal name="受付端末 01" /><Terminal name="受付端末 02" />
      <div className="notice">端末認証・入口/出口状態・接続状態を受付アプリと連携します。</div>
    </section>;

    if (page === "スタッフ管理") return <section className="panel">
      <div className="panel-title"><div><small>STAFF MANAGEMENT</small><h2>スタッフ管理</h2></div></div>
      <div className="empty"><h3>スタッフを登録</h3><p>スタッフ名とスタッフ用QRを管理します。</p><button className="secondary">スタッフを追加</button></div>
    </section>;

    if (page === "分析") return <section className="panel">
      <div className="panel-title"><div><small>ANALYSIS</small><h2>分析</h2></div></div>
      <div className="metrics"><Metric title="来場者数" value="0" sub="人" /><Metric title="現在の会場内" value="0" sub="人" /><Metric title="退場者数" value="0" sub="人" /></div>
      <div className="chart">受付記録が蓄積されると、時間帯別の来場者数・会場内人数を表示します。</div>
    </section>;

    if (page === "設定") return <section className="panel">
      <div className="panel-title"><div><small>SETTINGS</small><h2>設定</h2></div></div>
      <Setting title="入口受付" text="入場処理を有効にする" checked={settings.entryEnabled} onChange={() => toggleSetting("entryEnabled")} />
      <Setting title="出口受付" text="退場処理を有効にする" checked={settings.exitEnabled} onChange={() => toggleSetting("exitEnabled")} />
      <Setting title="再入場" text="退場後の再入場を許可する" checked={settings.reentryEnabled} onChange={() => toggleSetting("reentryEnabled")} />
      <div className="notice">設定は次回のFirebase公開から受付端末へ反映されます。</div>
    </section>;

    return <>
      <section className="hero"><div><small>EVENT CONTROL CENTER</small><h2>{savedEventName}</h2><p>{initialEvent.eventId} ・ チケット {ticketCount}枚</p></div><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : "未公開"}</span></section>
      <div className="metrics"><Metric title="チケット" value={String(ticketCount)} sub="枚" /><Metric title="入場中" value="0" sub="人" /><Metric title="公開状態" value={bundle ? "OK" : "—"} sub="Firebase" /></div>
      <section className="panel"><small>QUICK ACTION</small><h2>よく使う操作</h2><div className="quick"><button onClick={() => setPage("イベント管理")}>イベントを管理 <b>›</b></button><button onClick={() => setPage("チケット管理")}>チケットを確認 <b>›</b></button></div></section>
    </>;
  };

  return <div className="app-shell">
    <aside className="sidebar"><div className="brand"><small>QR TICKET SYSTEM</small><strong>管理アプリ</strong></div>
      <div className="event-mini"><small>現在のイベント</small><b>{savedEventName}</b><span>{bundle ? "● 公開済み" : "○ 未公開"}</span></div>
      <nav>{pages.map(item => <button key={item} className={page === item ? "active" : ""} onClick={() => setPage(item)}>{item}<b>›</b></button>)}</nav>
    </aside>
    <main className="management-main"><header className="management-header"><div><small>管理画面</small><h1>{page}</h1></div><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : "未公開"}</span></header>{pageContent()}</main>
  </div>;
}

function Metric({ title, value, sub }: { title: string; value: string; sub: string }) { return <div className="metric"><small>{title}</small><strong>{value}</strong><span>{sub}</span></div>; }
function Terminal({ name }: { name: string }) { return <div className="terminal"><div><b>{name}</b><small>イベント未認証</small></div><span className="pill">未接続</span></div>; }
function Setting({ title, text, checked, onChange }: { title: string; text: string; checked: boolean; onChange: () => void }) { return <div className="setting"><div><b>{title}</b><small>{text}</small></div><input type="checkbox" checked={checked} onChange={onChange} /></div>; }
