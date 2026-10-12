import {StrictMode} from "react";
import {createRoot} from "react-dom/client";
import App from "./App";
import {ensureInstallationAuth} from "./firebaseClient";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Reactの表示領域が見つかりません。");
const root = createRoot(rootElement);
root.render(<div className="reception-registration-page" style={{padding:24}}>Firebase認証を確認しています…</div>);
void ensureInstallationAuth().then(() => {
  root.render(<StrictMode><App/></StrictMode>);
}).catch((error) => {
  console.error("Firebase認証の初期化に失敗しました", error);
  root.render(<div className="reception-registration-page" style={{padding:24}}>
    <h2>Firebase認証を開始できません</h2>
    <p>Firebase Authentication で匿名ログインを有効にし、接続設定を確認してください。</p>
  </div>);
});
