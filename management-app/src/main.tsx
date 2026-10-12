import ReactDOM from "react-dom/client";

import AppRoot from "./App";
import { ensureInstallationAuth } from "./firebaseClient";
import "./styles.css";
import "./legacy-ticket-design-overrides.css";

const installAutomaticAppUpdate = () => {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  const hadController =
    navigator.serviceWorker.controller !== null;
  let reloading = false;

  navigator.serviceWorker.addEventListener(
    "controllerchange",
    () => {
      if (!hadController || reloading) {
        return;
      }

      reloading = true;
      window.location.reload();
    }
  );

  window.addEventListener(
    "load",
    () => {
      void navigator.serviceWorker.ready
        .then((registration) =>
          registration.update()
        )
        .catch((error) => {
          console.warn(
            "アプリの更新確認に失敗しました。",
            error
          );
        });
    },
    {
      once: true,
    }
  );
};

installAutomaticAppUpdate();
const rootElement =
  document.getElementById("root");

if (rootElement === null) {
  throw new Error(
    "Reactの表示領域が見つかりません。"
  );
}

const root = ReactDOM.createRoot(rootElement);
root.render(<div style={{ padding: 24, fontFamily: "sans-serif" }}>Firebase認証を確認しています…</div>);
void ensureInstallationAuth().then(() => {
  root.render(<AppRoot />);
}).catch((error) => {
  console.error("Firebase認証の初期化に失敗しました", error);
  root.render(<div style={{ padding: 24, fontFamily: "sans-serif" }}>
    <h2>Firebase認証を開始できません</h2>
    <p>Firebase Authentication で匿名ログインを有効にし、接続設定を確認してください。</p>
  </div>);
});
