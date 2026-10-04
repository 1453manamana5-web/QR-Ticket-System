import { useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { publishEventBundle, saveEventMetadata, type PublishedEventBundle } from "./eventPublisher";

const baseEvent: Event = {
  eventId: "DEMO-2027",
  eventName: "○○文化祭 2027",
  eventDate: "2027-10-01",
  startTime: "10:00",
  endTime: "16:00",
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

function createTickets(eventId: string, count: number, startNumber = 1, prefix = "TKT"): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const ticketNumber = startNumber + index;
    const id = `${prefix}-${String(ticketNumber).padStart(5, "0")}`;
    return {
      ticketId: id,
      eventId,
      basicInfo: { ticketNumber },
      currentStatus: "unused",
      valid: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

function ticketQrValue(eventId: string, ticket: Ticket) {
  return JSON.stringify({
    type: "qr-ticket",
    eventId,
    ticketId: ticket.ticketId,
    ticketNumber: ticket.basicInfo.ticketNumber,
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
  const [eventHistory, setEventHistory] = useState<Event[]>([baseEvent]);
  const [selectedHistoryEventId, setSelectedHistoryEventId] = useState(baseEvent.eventId);
  const [newEventModalOpen, setNewEventModalOpen] = useState(false);
  const [newEventName, setNewEventName] = useState("");
  const [newEventDate, setNewEventDate] = useState("");
  const [newStartTime, setNewStartTime] = useState("10:00");
  const [newEndTime, setNewEndTime] = useState("16:00");
  const [bundle, setBundle] = useState<PublishedEventBundle | null>(null);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");
  const [eventName, setEventName] = useState(baseEvent.eventName);
  const [eventDate, setEventDate] = useState(baseEvent.eventDate);
  const [startTime, setStartTime] = useState(baseEvent.startTime);
  const [endTime, setEndTime] = useState(baseEvent.endTime);
  const [ticketCount, setTicketCount] = useState(500);
  const [ticketPrefix, setTicketPrefix] = useState("TKT");
  const [ticketStartNumber, setTicketStartNumber] = useState(1);
  const [ticketTitle, setTicketTitle] = useState("入場チケット");
  const [ticketDesignImage, setTicketDesignImage] = useState("");
  const [savedEventName, setSavedEventName] = useState(baseEvent.eventName);
  const [settings, setSettings] = useState<ReceptionSettings>({
    entryEnabled: true,
    exitEnabled: true,
    reentryEnabled: true,
  });
  const [ticketQuery, setTicketQuery] = useState("");
  const [ticketStatusFilter, setTicketStatusFilter] = useState<"all" | "unused" | "inside" | "exited">("all");
  const [ticketCreateModalOpen, setTicketCreateModalOpen] = useState(false);
  const [ticketDesignModalOpen, setTicketDesignModalOpen] = useState(false);
  const [ticketQrModalTicket, setTicketQrModalTicket] = useState<Ticket | null>(null);
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
    return tickets.filter(ticket => {
      const matchesQuery = !query ||
        ticket.ticketId.toLowerCase().includes(query) ||
        String(ticket.basicInfo.ticketNumber).includes(query);
      const matchesStatus = ticketStatusFilter === "all" || ticket.currentStatus === ticketStatusFilter;
      return matchesQuery && matchesStatus;
    }).slice(0, 10);
  }, [tickets, ticketQuery, ticketStatusFilter]);

  const saveEvent = async () => {
    const normalizedName = eventName.trim() || baseEvent.eventName;
    if (!eventDate || !startTime || !endTime) {
      setError("開催日・開始時刻・終了時刻を入力してください。");
      return;
    }
    if (startTime >= endTime) {
      setError("終了時刻は開始時刻より後にしてください。");
      return;
    }

    const updatedEvent: Event = {
      ...event,
      eventName: normalizedName,
      eventDate,
      startTime,
      endTime,
    };

    setEvent(updatedEvent);
    setEventHistory(current => current.map(item => item.eventId === event.eventId ? updatedEvent : item));
    setSelectedHistoryEventId(updatedEvent.eventId);
    setSavedEventName(normalizedName);
    setError("");

    try {
      await saveEventMetadata(updatedEvent);
      setBundle(null);
    } catch (reason) {
      console.error(reason);
      setError("イベント情報をFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
    }
  };

  const openNewEventModal = () => {
    const today = new Date().toISOString().slice(0, 10);
    setNewEventName("新しいイベント");
    setNewEventDate(today);
    setNewStartTime("10:00");
    setNewEndTime("16:00");
    setError("");
    setNewEventModalOpen(true);
  };

  const closeNewEventModal = () => {
    setNewEventModalOpen(false);
  };

  const createNewEvent = () => {
    const normalizedName = newEventName.trim();
    if (!normalizedName || !newEventDate || !newStartTime || !newEndTime) {
      setError("イベント名・開催日・開始時刻・終了時刻を入力してください。");
      return;
    }
    if (newStartTime >= newEndTime) {
      setError("終了時刻は開始時刻より後にしてください。");
      return;
    }

    const next: Event = {
      eventId: createEventId(),
      eventName: normalizedName,
      eventDate: newEventDate,
      startTime: newStartTime,
      endTime: newEndTime,
      eventStatus: "preparing",
      dataVersion: 1,
    };

    setEvent(next);
    setEventHistory(current => [next, ...current.filter(item => item.eventId !== next.eventId)]);
    setSelectedHistoryEventId(next.eventId);
    setEventName(next.eventName);
    setEventDate(next.eventDate);
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setSavedEventName(next.eventName);
    setBundle(null);
    setTickets([]);
    setError("");
    setNewEventModalOpen(false);
    setPage("イベント管理");
  };

  const changeEventStatus = (status: Event["eventStatus"]) => {
    const updated = { ...event, eventStatus: status };
    setEvent(updated);
    setEventHistory(current => current.map(item => item.eventId === updated.eventId ? updated : item));
    setSelectedHistoryEventId(updated.eventId);
    setError("");
    void saveEventMetadata(updated).catch(reason => {
      console.error(reason);
      setError("イベント状態をFirebaseへ保存できませんでした。Firestoreの権限を確認してください。");
    });
  };

  const selectHistoryEvent = (selected: Event) => {
    setEvent(selected);
    setEventName(selected.eventName);
    setEventDate(selected.eventDate);
    setStartTime(selected.startTime);
    setEndTime(selected.endTime);
    setSavedEventName(selected.eventName);
    setSelectedHistoryEventId(selected.eventId);
    setBundle(null);
    setTickets([]);
    setError("");
  };

  const deleteHistoryEvent = (eventId: string) => {
    const target = eventHistory.find(item => item.eventId === eventId);
    if (!target) return;
    if (!window.confirm("「" + target.eventName + "」をイベント履歴から削除しますか？")) return;

    const remaining = eventHistory.filter(item => item.eventId !== eventId);
    if (remaining.length === 0) {
      setError("最後のイベントは削除できません。新しいイベントを作成してから削除してください。");
      return;
    }

    setEventHistory(remaining);
    selectHistoryEvent(remaining[0]);
  };

  const generateTickets = () => {
    const count = Math.min(5000, Math.max(1, ticketCount));
    const startNumber = Math.max(1, ticketStartNumber);
    const prefix = ticketPrefix.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 12) || "TKT";
    setTicketPrefix(prefix);
    setTicketStartNumber(startNumber);
    setTickets(createTickets(event.eventId, count, startNumber, prefix));
    setTicketStatusFilter("all");
    setError("");
  };

  const updateTicketStatus = (ticketId: string, status: Ticket["currentStatus"]) => {
    setTickets(current => current.map(ticket =>
      ticket.ticketId === ticketId
        ? { ...ticket, currentStatus: status, updatedAt: new Date().toISOString() }
        : ticket,
    ));
  };

  const toggleTicketValidity = (ticketId: string) => {
    setTickets(current => current.map(ticket =>
      ticket.ticketId === ticketId
        ? { ...ticket, valid: !ticket.valid, updatedAt: new Date().toISOString() }
        : ticket,
    ));
  };

  const deleteTicket = (ticketId: string) => {
    if (!window.confirm("このチケットを削除しますか？")) return;
    setTickets(current => current.filter(ticket => ticket.ticketId !== ticketId));
  };

  const handleTicketDesignChange = (file?: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("チケットデザインには画像ファイルを選択してください。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setTicketDesignImage(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => setError("チケットデザイン画像を読み込めませんでした。");
    reader.readAsDataURL(file);
  };

  const publish = async () => {
    if (publishing) return;
    const normalizedName = eventName.trim() || baseEvent.eventName;
    const preparedTickets = tickets.length === ticketCount
      ? tickets
      : createTickets(event.eventId, ticketCount, ticketStartNumber, ticketPrefix);
    const readyEvent: Event = {
      ...event,
      eventName: normalizedName,
      eventDate,
      startTime,
      endTime,
    };
    setPublishing(true);
    setError("");
    setEvent(readyEvent);
    setEventHistory(current => current.map(item => item.eventId === readyEvent.eventId ? readyEvent : item));
    setSelectedHistoryEventId(readyEvent.eventId);
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

      <div className="event-history">
        <div className="event-history-header">
          <div><small>EVENT HISTORY</small><h2>イベント履歴</h2></div>
          <span>{eventHistory.length}件</span>
        </div>
        <div className="event-history-list">
          {eventHistory.map(item => {
            const selected = item.eventId === selectedHistoryEventId;
            return <div className={selected ? "event-history-card selected" : "event-history-card"} key={item.eventId}>
              <button className="event-history-main" onClick={() => selectHistoryEvent(item)}>
                <div>
                  <b>{item.eventName}</b>
                  <small>{item.eventDate} ・ {item.startTime}–{item.endTime}</small>
                  <span>{item.eventId}</span>
                </div>
                <span className="pill">{statusLabel[item.eventStatus]}</span>
              </button>
              {selected && <div className="event-history-actions">
                <span className="event-history-label">このイベントを操作</span>
                <div>
                  <button className="secondary" onClick={() => changeEventStatus("preparing")}>準備中</button>
                  <button className="secondary" onClick={() => changeEventStatus("ready")}>受付開始</button>
                  <button className="secondary" onClick={() => changeEventStatus("active")}>開催中</button>
                  <button className="secondary" onClick={() => changeEventStatus("finalizing")}>終了処理</button>
                  <button className="secondary" onClick={() => changeEventStatus("finished")}>終了</button>
                  <button className="danger-action" onClick={() => deleteHistoryEvent(item.eventId)}>削除</button>
                </div>
              </div>}
            </div>;
          })}
        </div>
      </div>

      <div className="actions event-actions">
        <button className="secondary" onClick={openNewEventModal}>＋ 新しいイベント</button>
        <button className="secondary" onClick={() => void saveEvent()}>イベント情報を保存</button>
        <button className="secondary" onClick={() => changeEventStatus(nextStatus(eventStatus))} disabled={eventStatus === "finished"}>
          {eventStatus === "preparing" ? "受付可能にする" : eventStatus === "ready" ? "開催を開始" : eventStatus === "active" ? "終了処理へ" : "イベントを終了"}
        </button>
        <button className="primary-action" disabled={publishing || eventStatus === "finished"} onClick={() => void publish()}>
          {publishing ? "公開中…" : "Firebaseへ公開"}
        </button>
      </div>

      <div className="form-grid">
        <label>イベント名<input value={eventName} onChange={e => setEventName(e.target.value)} /></label>
        <label>開催日<input type="date" value={eventDate} onChange={e => setEventDate(e.target.value)} /></label>
        <label>開始時刻<input type="time" value={startTime} onChange={e => setStartTime(e.target.value)} /></label>
        <label>終了時刻<input type="time" value={endTime} onChange={e => setEndTime(e.target.value)} /></label>
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

    if (page === "チケット管理") return <>
      <div className="ticket-screen">
        <header className="ticket-screen-header">
          <div className="ticket-brand">
            <div className="ticket-brand-mark">QR</div>
            <div>
              <h1>交通研究部QRコード管理システム</h1>
              <div className="ticket-brand-meta">
                <span className="online-dot"><i />オンライン</span>
                <span className="ticket-divider" />
                <span className="event-chip">EVENT&nbsp;&nbsp; {event.eventName}</span>
              </div>
            </div>
          </div>
          <div className="ticket-page-title">
            <span className="ticket-page-icon"><TicketIcon /></span>
            <div><small>TICKET MANAGEMENT</small><strong>チケット管理</strong></div>
          </div>
        </header>

        <div className="ticket-screen-grid">
          <div className="ticket-left-column">
            <section className="ticket-tool-card">
              <small>TICKET TOOLS</small>
              <h2>チケット操作</h2>
              <button className="ticket-tool-button ticket-tool-create" onClick={() => setTicketCreateModalOpen(true)}>
                <span className="tool-icon"><PlusIcon /></span>
                <span><small>CREATE TICKETS</small><b>チケットを新規発行</b></span>
              </button>
              <button className="ticket-tool-button ticket-tool-design" onClick={() => setTicketDesignModalOpen(true)}>
                <span className="tool-icon"><PaletteIcon /></span>
                <span><small>DESIGN & PRINT</small><b>デザイン・まとめて印刷</b></span>
              </button>
            </section>

            <section className="ticket-status-card">
              <div className="ticket-status-heading">
                <div><small>TICKET STATUS</small><h2>チケット状況</h2></div>
                <strong>{ticketStats.total}<span>枚</span></strong>
              </div>
              <div className="ticket-status-grid">
                <div className="ticket-status-box unused"><span>未使用</span><strong>{ticketStats.unused}</strong><em>枚</em></div>
                <div className="ticket-status-box inside"><span>入場中</span><strong>{ticketStats.inside}</strong><em>枚</em></div>
                <div className="ticket-status-box used"><span>使用済み</span><strong>{ticketStats.exited}</strong><em>枚</em></div>
                <div className="ticket-status-box invalid"><span>無効</span><strong>{tickets.filter(ticket => !ticket.valid).length}</strong><em>枚</em></div>
              </div>
              <div className="ticket-sync-state"><i />リアルタイム同期中</div>
            </section>
          </div>

          <section className="ticket-list-screen-card">
            <div className="ticket-list-screen-heading">
              <div><small>ALL TICKETS</small><h2>チケット一覧</h2></div>
              <div className="ticket-count-badge">表示件数 <strong>{Math.min(10, filteredTickets.length || (tickets.length ? 10 : 0))}</strong>件</div>
            </div>

            <div className="ticket-search-row">
              <div className="ticket-search-box"><SearchIcon /><input placeholder="QR番号を検索" value={ticketQuery} onChange={e => setTicketQuery(e.target.value)} /></div>
              <div className="ticket-filter-box"><FilterIcon /><select value={ticketStatusFilter} onChange={e => setTicketStatusFilter(e.target.value as typeof ticketStatusFilter)}>
                <option value="all">すべての状態</option>
                <option value="unused">未使用</option>
                <option value="inside">入場中</option>
                <option value="exited">使用済み</option>
              </select></div>
            </div>

            {tickets.length > 0 ? <div className="ticket-screen-table">
              <div className="ticket-screen-table-head"><span>QR番号</span><span>状態</span><span>操作</span></div>
              {filteredTickets.map(ticket => (
                <div className="ticket-screen-row" key={ticket.ticketId}>
                  <div className="ticket-number-cell"><span className="mini-qr"><QrIcon /></span><strong>{String(ticket.basicInfo.ticketNumber).padStart(5, "0")}</strong></div>
                  <select
                    className={`ticket-status-select status-${ticket.currentStatus}`}
                    value={ticket.currentStatus}
                    onChange={e => updateTicketStatus(ticket.ticketId, e.target.value as Ticket["currentStatus"])}
                  >
                    <option value="unused">未使用</option>
                    <option value="inside">入場中</option>
                    <option value="exited">使用済み</option>
                  </select>
                  <div className="ticket-row-actions">
                    <button className="ticket-row-view" onClick={() => setTicketQrModalTicket(ticket)}>QR表示</button>
                    <button className="ticket-row-disable" onClick={() => toggleTicketValidity(ticket.ticketId)}>{ticket.valid ? "無効化" : "有効化"}</button>
                    <button className="ticket-row-delete" onClick={() => deleteTicket(ticket.ticketId)}>削除</button>
                  </div>
                </div>
              ))}
            </div> : <div className="ticket-list-empty"><h3>チケットがありません</h3><p>「チケットを新規発行」からQRチケットを作成してください。</p></div>}

            {tickets.length > 10 && <div className="ticket-list-footer">先頭10件を表示中　・　全{tickets.length}件</div>}
          </section>
        </div>

        <button className="ticket-back-button" onClick={() => setPage("ホーム")}><BackIcon />管理モードに戻る</button>

        {tickets.length > 0 && <div className="ticket-print-area">
          {tickets.map(ticket => (
            <article className="print-ticket" key={`print-${ticket.ticketId}`}>
              {ticketDesignImage && <img className="print-ticket-design" src={ticketDesignImage} alt="" />}
              <div className="print-ticket-header"><strong>{event.eventName}</strong><span>{ticketTitle}</span></div>
              <div className="print-ticket-content">
                <div className="print-ticket-number"><small>TICKET NO.</small><b>{String(ticket.basicInfo.ticketNumber).padStart(5, "0")}</b><span>{ticket.ticketId}</span></div>
                <QRCodeSVG value={ticketQrValue(event.eventId, ticket)} size={118} includeMargin />
              </div>
              <div className="print-ticket-footer">このQRは入場・退場認証に使用します</div>
            </article>
          ))}
        </div>}
      </div>

      {ticketCreateModalOpen && <div className="ticket-modal-backdrop" onMouseDown={() => setTicketCreateModalOpen(false)}>
        <div className="ticket-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="ticket-modal-close" onClick={() => setTicketCreateModalOpen(false)}>×</button>
          <small>CREATE TICKETS</small><h2>チケットを新規発行</h2><p>番号とQRコードをまとめて生成します。</p>
          <div className="ticket-modal-grid">
            <label>チケットタイトル<input value={ticketTitle} onChange={e => setTicketTitle(e.target.value)} /></label>
            <label>発行枚数<input type="number" min="1" max="5000" value={ticketCount} onChange={e => setTicketCount(Math.min(5000, Math.max(1, Number(e.target.value) || 1)))} /></label>
            <label>番号プレフィックス<input value={ticketPrefix} maxLength={12} onChange={e => setTicketPrefix(e.target.value)} /></label>
            <label>開始番号<input type="number" min="1" value={ticketStartNumber} onChange={e => setTicketStartNumber(Math.max(1, Number(e.target.value) || 1))} /></label>
          </div>
          <div className="ticket-modal-actions">
            <button className="secondary" onClick={() => setTicketCreateModalOpen(false)}>キャンセル</button>
            <button className="ticket-modal-primary" onClick={() => { generateTickets(); setTicketCreateModalOpen(false); }}>QR・チケットを発行</button>
          </div>
        </div>
      </div>}

      {ticketDesignModalOpen && <div className="ticket-modal-backdrop" onMouseDown={() => setTicketDesignModalOpen(false)}>
        <div className="ticket-modal ticket-design-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="ticket-modal-close" onClick={() => setTicketDesignModalOpen(false)}>×</button>
          <small>DESIGN & PRINT</small><h2>デザイン・まとめて印刷</h2><p>チケットデザイン画像を設定して、発行済みチケットを一括印刷します。</p>
          <label className="ticket-design-upload">チケットデザイン画像
            <input type="file" accept="image/*" onChange={e => handleTicketDesignChange(e.target.files?.[0])} />
          </label>
          {ticketDesignImage && <div className="ticket-design-current"><img src={ticketDesignImage} alt="" /><button className="secondary" onClick={() => setTicketDesignImage("")}>デザインを外す</button></div>}
          <div className="ticket-print-preview"><strong>{event.eventName}</strong><span>{ticketTitle}</span><b>{tickets.length || ticketCount}枚</b></div>
          <div className="ticket-modal-actions">
            <button className="secondary" onClick={() => setTicketDesignModalOpen(false)}>閉じる</button>
            <button className="ticket-modal-primary" disabled={!tickets.length} onClick={() => window.print()}>まとめて印刷</button>
          </div>
        </div>
      </div>}

      {ticketQrModalTicket && <div className="ticket-modal-backdrop" onMouseDown={() => setTicketQrModalTicket(null)}>
        <div className="ticket-modal ticket-qr-modal" onMouseDown={e => e.stopPropagation()}>
          <button className="ticket-modal-close" onClick={() => setTicketQrModalTicket(null)}>×</button>
          <small>QR CODE</small><h2>QR表示</h2><p>{event.eventName}</p>
          <div className="ticket-qr-large"><QRCodeSVG value={ticketQrValue(event.eventId, ticketQrModalTicket)} size={280} includeMargin /></div>
          <strong className="ticket-qr-number">TKT {String(ticketQrModalTicket.basicInfo.ticketNumber).padStart(5, "0")}</strong>
          <div className="ticket-modal-actions"><button className="secondary" onClick={() => setTicketQrModalTicket(null)}>閉じる</button></div>
        </div>
      </div>}
    </>;

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
        <div className="staff-row" key={`${name}-${index}`}><div><b>{name}</b><small>スタッフQR #${index + 1}</small></div><button className="secondary" onClick={() => setStaffNames(current => current.filter((_, i) => i !== index))}>削除</button></div>
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
        <div><small>EVENT CONTROL CENTER</small><h2>{savedEventName}</h2><p>{event.eventDate} {event.startTime}–{event.endTime} ・ {event.eventId} ・ {statusLabel[eventStatus]} ・ チケット {ticketStats.total}枚</p></div>
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

function TicketIcon(){return <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M8 13h32v22H8z"/><path d="M14 13v7m0 8v7M34 13v7m0 8v7"/><path d="M21 18h8v12h-8z"/></svg>;}
function PlusIcon(){return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 7v18M7 16h18"/></svg>;}
function PaletteIcon(){return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 5C9.9 5 5 9.5 5 15.2 5 20 8.6 23 13 23h2.5c1.8 0 2.6 2.3 1.6 3.6-.4.5 0 .9.7.9C24.2 27.5 27 22.2 27 16c0-6.1-4.9-11-11-11Z"/><circle cx="10.5" cy="14" r="1.2"/><circle cx="15" cy="10.5" r="1.2"/><circle cx="21" cy="11.5" r="1.2"/><circle cx="23" cy="17" r="1.2"/></svg>;}
function SearchIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>;}
function FilterIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M7 12h10M10 18h4"/></svg>;}
function QrIcon(){return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v6H4zm10 0h6v6h-6zM4 14h6v6H4zM14 14h3v3h-3zm5 0h1v1h-1zm-5 5h1v1h-1zm3-2h3v3h-3z"/></svg>;}
function BackIcon(){return <svg viewBox="0 0 28 28" aria-hidden="true"><path d="M18 5 7 14l11 9M8 14h15"/></svg>;}

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><small>QR TICKET SYSTEM</small><strong>管理アプリ</strong></div>
      <div className="event-mini"><small>現在のイベント</small><b>{savedEventName}</b><span>● {statusLabel[eventStatus]}</span></div>
      <nav>{pages.map(item => <button key={item} className={page === item ? "active" : ""} onClick={() => setPage(item)}>{item}<b>›</b></button>)}</nav>
    </aside>
    <main className="management-main">
      <header className="management-header">
        <div><small>管理画面</small><h1>{page}</h1></div>
        <div className="header-actions"><button className="secondary" onClick={openNewEventModal}>＋ 新規イベント</button><span className={bundle ? "pill ok" : "pill"}>{bundle ? "公開済み" : statusLabel[eventStatus]}</span></div>
      </header>
      {pageContent()}
    </main>

    {newEventModalOpen && <div className="modal-backdrop" role="presentation" onMouseDown={closeNewEventModal}>
      <div className="new-event-modal" role="dialog" aria-modal="true" aria-labelledby="new-event-title" onMouseDown={e => e.stopPropagation()}>
        <div className="new-event-modal-header">
          <div><small>NEW EVENT</small><h2 id="new-event-title">新しいイベントを作成</h2><p>イベントの基本情報を入力してください。</p></div>
          <button className="modal-close" aria-label="閉じる" onClick={closeNewEventModal}>×</button>
        </div>
        <div className="form-grid new-event-form">
          <label>イベント名<input autoFocus value={newEventName} onChange={e => setNewEventName(e.target.value)} /></label>
          <label>開催日<input type="date" value={newEventDate} onChange={e => setNewEventDate(e.target.value)} /></label>
          <label>開始時刻<input type="time" value={newStartTime} onChange={e => setNewStartTime(e.target.value)} /></label>
          <label>終了時刻<input type="time" value={newEndTime} onChange={e => setNewEndTime(e.target.value)} /></label>
        </div>
        {error && <div className="notice error">{error}</div>}
        <div className="modal-actions">
          <button className="secondary" onClick={closeNewEventModal}>キャンセル</button>
          <button className="primary-action" onClick={createNewEvent}>イベントを作成</button>
        </div>
      </div>
    </div>}
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
