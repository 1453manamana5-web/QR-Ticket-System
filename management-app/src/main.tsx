import ReactDOM from "react-dom/client";
import AppRoot from "./App";
import "./styles.css";
import "./legacy-ticket-design-overrides.css";
import { ensureFirebaseAuth } from "./firebaseClient";
import OfflineReserveRoot from './ReservePrinting';

const installAutomaticAppUpdate = () => {
  if (!("serviceWorker" in navigator)) return;
  const register=() => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`,{scope:import.meta.env.BASE_URL}).catch((error) => {
      console.warn("アプリの更新確認に失敗しました。", error);
    });
  };
  if(document.readyState==='complete')register();else window.addEventListener('load',register,{once:true});
};

function describeFirebaseStartupError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    return [code, error.message].filter(Boolean).join(": ");
  }
  return String(error);
}

async function startApp() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Reactの表示領域が見つかりません。");
  installAutomaticAppUpdate();
  const reserveEventId=new URLSearchParams(window.location.search).get('reserve-print');
  if(reserveEventId){ReactDOM.createRoot(rootElement).render(<OfflineReserveRoot eventId={reserveEventId}/>);return;}
  try {
    await ensureFirebaseAuth();
    ReactDOM.createRoot(rootElement).render(<AppRoot />);
  } catch (error) {
    console.error("Firebase認証を開始できませんでした。", error);
    rootElement.textContent = "Firebase接続エラー: " + describeFirebaseStartupError(error) +
      "。GitHub ActionsのFirebase設定値とFirebase Authenticationの匿名認証設定を確認してください。";
  }
}
void startApp();
