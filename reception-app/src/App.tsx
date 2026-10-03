import {useCallback, useEffect, useState} from "react";
import type {EventAuthPayload, LocalEventData} from "@qr-ticket-system/shared";
import QrScanner from "./QrScanner";
import {loadLocalEvent, saveLocalEvent} from "./localDb";

type Mode = "entry" | "exit";
type Screen = "auth" | "confirm" | "preparing" | "reception";

const DEMO_EVENT: EventAuthPayload = {
  type: "qr-ticket-event-auth",
  eventId: "DEMO-2027",
  eventName: "○○文化祭 2027",
  dataVersion: 1,
  authToken: "demo-auth-token",
};

function parseAuthPayload(text: string): EventAuthPayload | null {
  try {
    const value = JSON.parse(text) as Partial<EventAuthPayload>;
    if (
      value.type !== "qr-ticket-event-auth" ||
      typeof value.eventId !== "string" ||
      typeof value.eventName !== "string" ||
      typeof value.dataVersion !== "number" ||
      typeof value.authToken !== "string"
    ) {
      return null;
    }
    return value as EventAuthPayload;
  } catch {
    return null;
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("auth");
  const [mode, setMode] = useState<Mode>("entry");
  const [authPayload, setAuthPayload] = useState<EventAuthPayload | null>(null);
  const [localEvent, setLocalEvent] = useState<LocalEventData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void loadLocalEvent()
      .then((saved) => {
        if (saved) {
          setLocalEvent(saved);
          setAuthPayload({
            type: "qr-ticket-event-auth",
            eventId: saved.event.eventId,
            eventName: saved.event.eventName,
            dataVersion: saved.event.dataVersion,
            authToken: "local",
          });
          setScreen(saved.dataReady ? "reception" : "preparing");
        }
      })
      .catch(() => {
        setError("ローカルデータを確認できませんでした。");
      });
  }, []);

  const handleScan = useCallback((text: string) => {
    const payload = parseAuthPayload(text);
    if (!payload) {
      setError("このQRコードはイベント認証QRではありません。");
      return;
    }
    setError("");
    setAuthPayload(payload);
    setScreen("confirm");
  }, []);

  const authenticateEvent = async () => {
    if (!authPayload) return;
    setError("");
    setScreen("preparing");

    const event: LocalEventData = {
      event: {
        eventId: authPayload.eventId,
        eventName: authPayload.eventName,
        eventStatus: "ready",
        dataVersion: authPayload.dataVersion,
      },
      settings: {
        entryEnabled: true,
        exitEnabled: true,
        reentryEnabled: true,
      },
      terminalId: getTerminalId(),
      authenticatedAt: new Date().toISOString(),
      dataReady: false,
      ticketCount: 0,
    };

    try {
      await saveLocalEvent(event);
      setLocalEvent(event);
    } catch {
      setError("イベント認証情報を端末に保存できませんでした。");
      setScreen("confirm");
      return;
    }
  };

  const startReception = () => {
    if (!localEvent?.dataReady) return;
    setScreen("reception");
  };

  if (screen === "auth") {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <small className="eyebrow">QR TICKET SYSTEM</small>
          <h1>イベント認証</h1>
          <p>管理アプリに表示されたイベント認証QRを読み取ってください。</p>
          <div className="auth-reader">
            <QrScanner onResult={handleScan} onError={setError} />
          </div>
          {error && <div className="error">{error}</div>}
          <button className="secondary" onClick={() => handleScan(JSON.stringify(DEMO_EVENT))}>
            開発用イベントで試す
          </button>
        </div>
      </main>
    );
  }

  if (screen === "confirm" && authPayload) {
    return (
      <main className="auth-shell">
        <div className="auth-card confirm-card">
          <small className="eyebrow">EVENT AUTHENTICATION</small>
          <h1>このイベントで認証しますか？</h1>
          <div className="event-preview">
            <span>イベント</span>
            <strong>{authPayload.eventName}</strong>
            <small>{authPayload.eventId}</small>
          </div>
          {error && <div className="error">{error}</div>}
          <button className="primary" onClick={() => void authenticateEvent()}>
            このイベントで認証
          </button>
          <button className="secondary" onClick={() => setScreen("auth")}>
            別のQRを読み取る
          </button>
        </div>
      </main>
    );
  }

  if (screen === "preparing") {
    return (
      <main className="auth-shell">
        <div className="auth-card">
          <div className="spinner" />
          <small className="eyebrow">EVENT DATA</small>
          <h1>{localEvent?.event.eventName ?? authPayload?.eventName}</h1>
          <p>
            {localEvent
              ? "イベント認証情報を端末に保存しました。チケットデータの取得機能を接続します。"
              : "イベント情報を準備しています。"}
          </p>
          <div className="status-row"><span>イベント認証</span><b>✓ 保存済み</b></div>
          <div className="status-row"><span>チケットデータ</span><b>準備待ち</b></div>
          {error && <div className="error">{error}</div>}
        </div>
      </main>
    );
  }

  const entry = mode === "entry";
  return (
    <main className="reception-shell">
      <button className="mode" onClick={() => setMode(entry ? "exit" : "entry")}>
        <b>{entry ? "入口受付" : "出口受付"}</b>
        <small>切り替え</small>
      </button>
      <section>
        <div className="camera">
          <div className="frame" />
          <p>QRコードを枠内に合わせてください</p>
        </div>
        <div className="panel">
          <small className="eyebrow">{localEvent?.event.eventName}</small>
          <h1>{entry ? "入場受付" : "出口受付"}</h1>
          <p>受付準備完了。QRコードを読み取れます。</p>
          <button onClick={startReception}>受付を開始する</button>
        </div>
      </section>
    </main>
  );
}

function getTerminalId(): string {
  const key = "qr-ticket-terminal-id";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = `T-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
  localStorage.setItem(key, id);
  return id;
}