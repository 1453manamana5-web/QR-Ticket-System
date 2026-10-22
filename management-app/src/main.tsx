import ReactDOM from "react-dom/client";
import AppRoot from "./App";
import "./styles.css";
import "./legacy-ticket-design-overrides.css";
import { ensureFirebaseAuth } from "./firebaseClient";

const installAutomaticAppUpdate = () => {
  if (!("serviceWorker" in navigator)) return;
  const hadController = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloading) return;
    reloading = true;
    window.location.reload();
  });
  window.addEventListener("load", () => {
    void navigator.serviceWorker.ready.then((registration) => registration.update()).catch((error) => {
      console.warn("アプリの更新確認に失敗しました。", error);
    });
  }, { once: true });
};

async function startApp() {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Reactの表示領域が見つかりません。");
  try {
    await ensureFirebaseAuth();
    installAutomaticAppUpdate();
    ReactDOM.createRoot(rootElement).render(<AppRoot />);
  } catch (error) {
    console.error("Firebase認証を開始できませんでした。", error);
    rootElement.textContent = "サーバーへの接続を開始できませんでした。通信環境を確認して再読み込みしてください。";
  }
}
void startApp();
