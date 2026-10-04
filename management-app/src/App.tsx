import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { publishEventBundle, type PublishedEventBundle } from "./eventPublisher";

const baseEvent: Event = {
  eventId: "DEMO-2027",
  eventName: "○○文化祭 2027",
  eventStatus: "preparing",
  dataVersion: 1,
};

const pages = ["ホーム", "イベント管理", "チケット管理", "端末管理", "スタッフ管理", "分析", "設定"];

const statusLabel: Record<Event["eventStatus"], string> = {
  preparing: "準備中",
  ready: "受付可能",
  active: "開催中",
  finalizing: "終了処理中",
  finished: "終了",
};

function createEventId() {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("");
  const random = crypto.getRandomValues(new Uint32Array(1))[0].toString(36).toUpperCase().slice(0, 4);
  return `EV-${stamp}-${random}`;
}

function createTickets(eventId: string, count: number): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const id = Array.from(random, value => value.toString(36).toUpperCase()).join("").slice(0, 10).padEnd(10, "0");
    return {
      ticketId: id,
      eventId,
      basicInfo: { ticketNumber: index + 1 },
      currentStatus: "unused",
      valid: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

function nextStatus(status: Event["eventStatus"]): Event["eventStatus"] {
  if (status === "preparing") return "ready";
  if (status === "ready") return "active";
  if (status === "active") return "finalizing";
  if (status === "finalizing") return "finished";
  return "finished";
}

export default function App() {
  const [page, setPage] = useState("ホーム");
  const [event, setEvent] = useState<Event>(baseEvent);
  const [bundle, setBundle] = useState<PublishedEventBundle | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [eventName, setEventName] = useState(baseEvent.eventName);
  const [ticketCount, setTicketCount] = useState(500);
  const [savedEventName, setSavedEventName] = useState(baseEvent.eventName);
  const [settings, setSettings] = useState<ReceptionSettings>({
    entryEnabled: true,
    exitEnabled: true,
    reentryEnabled: true,
  });
  const [ticketQuery, setTicketQuery] = useState("");
  const [staffNames, setStaffNames] = useState<string[]>([]);
  const [staffName, setStaffName] = useState("");

  const eventStatus = event.eventStatus;
  const ticketStats = useMemo(() => ({
    total: tickets.length || ticketCount,
    unused: tickets.filter(ticket => ticket.currentStatus === "unused").length,
    inside: tickets.filter(ticket => ticket.currentStatus === "inside").length,
    exited: tickets.filter(ticket => ticket.currentStatus === "exited").length,
  }), [tickets, ticketCount]);

  const filteredTickets = useMemo(() => {
    const query = ticketQuery.trim().toLowerCase();
    if (!query) return tickets.slice(0, 20);
    return tickets.filter(ticket =>
      ticket.ticketId.toLowerCase().includes(query) ||
      String(ticket.basicInfo.ticketNumber).includes(query),
    ).slice(0, 20);
  }, [tickets, ticketQuery]);

  const saveEvent = () => {
    const normalizedName = eventName.trim() || baseEvent.eventName;
    setEvent(current => ({ ...current, eventName: normalizedName }));
    setSavedEventName(normalizedName);
    setError("");
  };

  const createNewEvent = () => {
    const next: Event = {
      eventId: createEventId(),
      eventName: "新しいイベント",
      eventStatus: "preparing",
      dataVersion: 1,
    };
    setEvent(next);
    setEventName(next.eventName);
    setSavedEventName(next.eventName);
    setBundle(null);
    setTickets([]);
    setError("");
    setPage("イベント管理");
  };

  const changeEventStatus = (status: Event["eventStatus"]) => {
    setEvent(current => ({ ...current, eventStatus: status }));
    setError("");
  };

  const generateTickets = () => {
    const count = Math.min(5000, Math.max(1, ticketCount));
    setTickets(createTickets(event.eventId, count));
    setError("");
  };

  const publish = async () => {
    if (publishing) return;
    const normalizedName = eventName.trim() || baseEvent.eventName;
    const preparedTickets = tickets.length === ticketCount ? tickets : createTickets(event.eventId, ticketCount);
    const readyEvent: Event = { ...event, eventName: normalizedName };
    setPublishing(true);
    setError("");
    setEvent(readyEvent);
    setSavedEventName(normalizedName);
    try {
      const result = await publishEventBundle(readyEvent, settings, preparedTickets);
      setTickets(preparedTickets);
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
    authToken: bundle.authToken,
  }) : "";

  const toggleSetting = (key: keyof ReceptionSettings) => {
    setSettings(current => ({ ...current, [key]: !current[key] }));
  };

  const addStaff = () => {
    const normalized = staffName.trim();
    if (!normalized) return;
    setStaffNames(current => [...current, normalized]);
    setStaffName("");
  };

  const pageContent = () => {
    if (page === "イベント管理") return <section className="panel">
      <div className="panel-title">
        <div><small>EVENT MANAGEMENT</small><h2>イベント管理</h2></div>
        <span className="pill">{statusLabel[eventStatus]}</span>
      </div>

      <div className="actions event-actions">
        <button className="secondary" onClick={createNewEvent}>＋ 新しいイベント</button>
        <button className="secondary" onClick={saveEvent}>イベント情報を保存</button>
        <button className="secondary" onClick={() => changeEventStatus(nextStatus(eventStatus))} disabled={eventStatus === "finished"}>
          {eventStatus === "preparing" ? "受付可能にする" : eventStatus === "ready" ? "開催を開始" : eventStatus === "active" ? "終了処理へ" : "イベントを終了"}
        </button>
        <button className="primary-action" disabled={publishing || eventStatus === "finished"} onClick={() => void publish()}>
          {publishing ? "公開中…" : "Firebaseへ公開"}
        </button>
      </div>

      <div className="form-grid">
        <label>イベント名<input value={eventName} onChange={e => setEventName(e.target.value)} /></label>
        <label>イベントID<input value={event.eventId} onChange={e => setEvent(current => ({ ...current, eventId: e.target.value }))} /></label>
        <label>チケット枚数<input type="number" min="1" max="5000" value={ticketCount} onChange={e => setTicketCount(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))} /></label>
        <label>データバージョン<input value={event.dataVersion} disabled /></label>
      </div>

      <div className="status-stepper">
        {(["preparing", "ready", "active", "finalizing", "finished"] as Event["eventStatus"][]).map(status => (
          <button key={status} className={eventStatus === status ? "status-step active" : "status-step"} onClick={() => changeEventStatus(status)}>
            <b>{statusLabel[status]}</b><span>{status}</span>
          </button>
        ))}
      </div>

      {error && <div className="notice error">{error}</div>}
      {bundle && <div className="notice success">イベントデータはFirebaseへ公開済みです。受付端末は下のQRで認証できます。</div>}

      {bundle && <div className="auth-card">
        <div>
          <small>EVENT AUTHENTICATION</small>
          <h2>受付端末用イベント認証QR</h2>
          <p>受付アプリで読み取ると、チケット{bundle.tickets.length}枚を端末へ保存します。</p>
          <p className="token">{bundle.authToken}</p>
          <button className="secondary" onClick={() => window.print()}>認証QRを印刷</button>
        </div>
        <div className="qr-box"><QRCodeSVG value={authQrValue} size={220} includeMargin /></div>
      </div>}
    </section>;

    if (page === "チケット管理") return <section className="panel">
      <div className="panel-title">
        <div><small>TICKET MANAGEMENT</small><h2>チケット管理</h2></div>
        <span className="pill">{ticketStats.total}枚</span>
      </div>
      <div className="metrics">
        <Metric title="総チケット" value={String(ticketStats.total)} sub="枚" />
        <Metric title="未使用" value={String(ticketStats.unused)} sub="枚" />
        <Metric title="入場中" value={String(ticketStats.inside)} sub="人" />
      </div>
      <div className="actions">
        <button className="primary-action" onClick={generateTickets}>チケットを生成・更新</button>
        <button className="secondary" onClick={() => window.print()} disabled={!tickets.length}>チケットを印刷</button>
      </div>
      <div className="ticket-toolbar">
        <input placeholder="チケット番号・IDを検索" value={ticketQuery} onChange={e => setTicketQuery(e.target.value)} />
        <span>{tickets.length ? `表示 ${filteredTickets.length}件 / ${tickets.length}件` : "チケット未生成"}</span>
      </div>
      {tickets.length > 0 ? <div className="ticket-table">
        <div className="ticket-row ticket-head"><b>番号</b><b>チケットID</b><b>状態</b><b>有効</b></div>
        {filteredTickets.map(ticket => (
          <div className="ticket-row" key={ticket.ticketId}>
            <span>{String(ticket.basicInfo.ticketNumber)}</span>
            <span className="mono">{ticket.ticketId}</span>
            <span>{ticket.currentStatus === "unused" ? "未使用" : ticket.currentStatus === "inside" ? "入場中" : "退場済み"}</span>
            <span>{ticket.valid ? "有効" : "無効"}</span>
          </div>
        ))}
      </div> : <div className="empty"><h3>まだチケットがありません</h3><p>イベントのチケット枚数を設定して、チケットを生成してください。</p></div>}
    </section>;

    if (page === "端末管理") return <section className="panel">
      <div className="panel-title"><div><small>TERMINAL MANAGEMENT</small><h2>端末管理</h2></div></div>
      <div className="actions">
        <button className="secondary" onClick={() => setPage("端末管理")}>端末状態を更新</button>
        <button className="secondary" onClick={() => setPage("イベント管理")}>イベント認証QRを表示</button>
      </div>
      <Terminal name="受付端末 01" mode="入口受付" onAction={() => setPage("イベント管理")} />
      <Terminal name="受付端末 02" mode="出口受付" onAction={() => setPage("イベント管理")} />
      <div className="notice">旧アプリの端末管理に合わせ、今後ここから受付状態・端末名・接続状態・リモート操作を追加します。</div>
    </section>;

    if (page === "スタッフ管理") return <section className="panel">
      <div className="panel-title"><div><small>STAFF MANAGEMENT</small><h2>スタッフ管理</h2></div></div>
      <div className="staff-add">
        <input placeholder="スタッフ名" value={staffName} onChange={e => setStaffName(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addStaff(); }} />
        <button className="primary-action" onClick={addStaff}>スタッフを追加</button>
      </div>
      {staffNames.length ? staffNames.map((name, index) => (
        <div className="staff-row" key={`${name}-${index}`}><div><b>{name}</b><small>スタッフQR #{index + 1}</small></div><button className="secondary" onClick={() => setStaffNames(current => current.filter((_, i) => i !== index))}>削除</button></div>
      )) : <div className="empty"><h3>スタッフを登録</h3><p>旧アプリと同じように、スタッフ名とスタッフ用QRをここで管理します。</p></div>}
    </section>;

    if (page === "分析") return <section className="panel">
      <div className="panel-title"><div><small>ANALYSIS</small><h2>分析</h2></div></div>
      <div className="metrics">
        <Metric title="来場者数" value={String(ticketStats.inside + ticketStats.exited)} sub="人" />
        <Metric title="現在の会場内" value={String(ticketStats.inside)} sub="人" />
        <Metric title="退場者数" value={String(ticketStats.exited)} sub="人" />
      </div>
      <div className="actions">
        <button className="secondary">時間帯別グラフ</button>
        <button className="secondary">データを保存</button>
        <button className="secondary">CSV出力</button>
      </div>
      <div className="chart">受付記録が蓄積されると、時間帯別の来場者数・会場内人数を表示します。</div>
    </section>;

    if (page === "設定") return <section className="panel">
      <div className="panel-title"><div><small>SETTINGS</small><h2>設定</h2></div></div>
      <Setting title="入口受付" text="入場処理を有効にする" checked={settings.entryEnabled} onChange={() => toggleSetting("entryEnabled")} />
      <Setting title="出口受付" text="退場処理を有効にする" checked={settings.exitEnabled} onChange={() => toggleSetting("exitEnabled")} />
      <Setting title="再入場" text="退場後の再入場を許可する" checked={settings.reentryEnabled} onChange={() => toggleSetting("reentryEnabled")} />
      <div className="actions">
        <button className="secondary" onClick={() => setSettings({ entryEnabled: true, exitEnabled: true, reentryEnabled: true })}>初期設定に戻す</button>
        <button className="primary-action" onClick={() => void publish()}>設定をFirebaseへ反映</button>
      </div>
      <div className="notice">設定はFirebase公開後に受付端末へ反映されます。</div>
    </section>;

    return <>
      <section className="hero">
        <div><small>EVENT CONTROL CENTER</small><h2>{savedEventName}</h2><p>{event.eventId} ・ {statusLabel[eventStatus]} ・ チケット {ticketStats.total}枚</p></div>
        <span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : statusLabel[eventStatus]}</span>
      </section>
      <div className="metrics">
        <Metric title="チケット" value={String(ticketStats.total)} sub="枚" />
        <Metric title="入場中" value={String(ticketStats.inside)} sub="人" />
        <Metric title="公開状態" value={bundle ? "OK" : "—"} sub="Firebase" />
      </div>
      <section className="panel">
        <small>QUICK ACTION</small><h2>よく使う操作</h2>
        <div className="quick">
          <button onClick={() => setPage("イベント管理")}>イベントを管理 <b>›</b></button>
          <button onClick={() => setPage("チケット管理")}>チケットを確認 <b>›</b></button>
          <button onClick={() => setPage("端末管理")}>受付端末を管理 <b>›</b></button>
          <button onClick={() => setPage("分析")}>分析を見る <b>›</b></button>
        </div>
      </section>
    </>;
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><small>QR TICKET SYSTEM</small><strong>管理アプリ</strong></div>
      <div className="event-mini"><small>現在のイベント</small><b>{savedEventName}</b><span>● {statusLabel[eventStatus]}</span></div>
      <nav>{pages.map(item => <button key={item} className={page === item ? "active" : ""} onClick={() => setPage(item)}>{item}<b>›</b></button>)}</nav>
    </aside>
    <main className="management-main">
      <header className="management-header">
        <div><small>管理画面</small><h1>{page}</h1></div>
        <div className="header-actions"><button className="secondary" onClick={createNewEvent}>＋ 新規イベント</button><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : statusLabel[eventStatus]}</span></div>
      </header>
      {pageContent()}
    </main>
  </div>;
}

function Metric({ title, value, sub }: { title: string; value: string; sub: string }) {
  return <div className="metric"><small>{title}</small><strong>{value}</strong><span>{sub}</span></div>;
}

function Terminal({ name, mode, onAction }: { name: string; mode: string; onAction: () => void }) {
  return <div className="terminal">
    <div><b>{name}</b><small>{mode} ・ イベント未認証</small></div>
    <div className="terminal-actions"><span className="pill">未接続</span><button className="secondary" onClick={onAction}>操作</button></div>
  </div>;
}

function Setting({ title, text, checked, onChange }: { title: string; text: string; checked: boolean; onChange: () => void }) {
  return <div className="setting"><div><b>{title}</b><small>{text}</small></div><input type="checkbox" checked={checked} onChange={onChange} /></div>;
}
