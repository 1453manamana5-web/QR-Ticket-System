import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { ensureFirebaseAuth } from "./firebaseClient";

function describeFirebaseStartupError(error: unknown): string {
  if (error instanceof Error) {
    const code = "code" in error && typeof error.code === "string" ? error.code : "";
    return [code, error.message].filter(Boolean).join(": ");
  }
  return String(error);
}

async function startApp() {
  const root = document.getElementById("root");
  if (!root) throw new Error("Reactの表示領域が見つかりません。");
  try {
    await ensureFirebaseAuth();
    if ("serviceWorker" in navigator) {
      const registerOfflineShell = () => {
        void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
          .catch(error => console.warn("受付アプリのオフライン起動を準備できませんでした", error));
      };
      if(document.readyState === "complete") registerOfflineShell();
      else window.addEventListener("load", registerOfflineShell, {once: true});
    }
    createRoot(root).render(<StrictMode><App /></StrictMode>);
  } catch (error) {
    console.error("Firebase認証を開始できませんでした。", error);
    root.textContent = "Firebase接続エラー: " + describeFirebaseStartupError(error) +
      "。GitHub ActionsのFirebase設定値とFirebase Authenticationの匿名認証設定を確認してください。";
  }
}
void startApp();
