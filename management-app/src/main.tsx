import ReactDOM from "react-dom/client";

import AppRoot from "./App";
import "./index.css";
import "./moved-data-controls.css";
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
const installPrintSupport = () => {
  void import("./manualPrintSupport")
    .then(({ installManualPrintSupport }) => {
      installManualPrintSupport();
    })
    .catch((error) => {
      console.warn(
        "印刷サポートを読み込めませんでした。",
        error
      );
    });
};

window.setTimeout(
  installPrintSupport,
  1000
);

const rootElement =
  document.getElementById("root");

if (rootElement === null) {
  throw new Error(
    "Reactの表示領域が見つかりません。"
  );
}

ReactDOM.createRoot(rootElement).render(
  <AppRoot />
);
