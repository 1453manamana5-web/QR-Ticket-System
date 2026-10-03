import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import type { Event, ReceptionSettings, Ticket } from "@qr-ticket-system/shared";
import { publishEventBundle, type PublishedEventBundle } from "./eventPublisher";

const initialEvent: Event = {
  eventId: "DEMO-2027",
  eventName: "○○文化祭 2027",
  eventStatus: "ready",
  dataVersion: 1,
};

const settings: ReceptionSettings = {
  entryEnabled: true,
  exitEnabled: true,
  reentryEnabled: true,
};

function createTickets(eventId: string, count: number): Ticket[] {
  return Array.from({ length: count }, (_, index) => {
    const random = crypto.getRandomValues(new Uint32Array(2));
    const randomText = Array.from(random, value => value.toString(36).toUpperCase()).join("");
    return {
      ticketId: randomText.slice(0, 10).padEnd(10, "0"),
      eventId,
      basicInfo: { ticketNumber: index + 1 },
      currentStatus: "unused",
      valid: true,
      updatedAt: new Date().toISOString(),
    };
  });
}

export default function App() {
  const [bundle, setBundle] = useState<PublishedEventBundle | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [error, setError] = useState("");

  const publish = async () => {
    if (publishing) return;
    setPublishing(true);
    setError("");
    try {
      const tickets = createTickets(initialEvent.eventId, 500);
      const result = await publishEventBundle(initialEvent, settings, tickets);
      setBundle(result);
    } catch (reason) {
      console.error(reason);
      setError(
        "Firebaseへ公開できませんでした。Firebase環境変数とFirestoreの権限設定を確認してください。"
      );
    } finally {
      setPublishing(false);
    }
  };

  const authQrValue = bundle
    ? JSON.stringify({
        type: "qr-ticket-event-auth",
        eventId: bundle.event.eventId,
        eventName: bundle.event.eventName,
        dataVersion: bundle.event.dataVersion,
        authToken: bundle.authToken,
      })
    : "";

  return (
    <main>
      <header>
        <div>
          <small>QR TICKET SYSTEM</small>
          <h1>管理アプリ</h1>
        </div>
        <b>{bundle ? "公開済み" : "準備中"}</b>
      </header>

      <section>
        <small>現在のイベント</small>
        <h2>{initialEvent.eventName}</h2>
        <p>イベントID: {initialEvent.eventId}</p>
        <p>チケット: 500枚 / 標準QRの中身はチケットIDのみ</p>
        <button className="primary-action" type="button" disabled={publishing} onClick={() => void publish()}>
          {publishing ? "イベントデータを公開中…" : "イベントデータをFirebaseへ公開"}
        </button>
        {error && <p className="error-message">{error}</p>}
      </section>

      {bundle && (
        <section className="auth-card">
          <div>
            <small>EVENT AUTHENTICATION</small>
            <h2>受付端末用イベント認証QR</h2>
            <p>受付アプリでこのQRを読み取ると、チケット500枚を端末へ一括保存します。</p>
            <p className="token-label">認証トークン: {bundle.authToken}</p>
          </div>
          <div className="qr-box">
            <QRCodeSVG value={authQrValue} size={260} includeMargin />
          </div>
        </section>
      )}

      <nav>
        {["ホーム","イベント管理","チケット管理","端末管理","スタッフ管理","分析","設定"].map(x => (
          <button key={x} type="button">
            {x}<span>›</span>
          </button>
        ))}
      </nav>
    </main>
  );
}
