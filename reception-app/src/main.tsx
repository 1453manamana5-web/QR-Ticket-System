import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { ensureFirebaseAuth } from "./firebaseClient";

async function startApp() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Reactの表示領域が見つかりません。");
  try {
    await ensureFirebaseAuth();
    if ("serviceWorker" in navigator) {
      window.addEventListener("load", () => {
        void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
          .catch(error => console.warn("受付アプリのオフライン起動を準備できませんでした", error));
      }, { once: true });
    }
    createRoot(root).render(<StrictMode><App /></StrictMode>);
  } catch (error) {
    console.error("Firebase認証を開始できませんでした。", error);
    root.textContent = "サーバーへの接続を開始できませんでした。通信環境を確認して再読み込みしてください。";
  }
}
void startApp();
