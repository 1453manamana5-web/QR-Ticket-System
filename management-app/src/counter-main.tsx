import React, {Component, type ReactNode} from "react";
import { createRoot } from "react-dom/client";
import { blockEmbeddedApp } from "../../shared/src/browserSecurity";
import { CounterManagerApp } from "./CounterManagerApp";
import "./counter-management.css";

class ScreenBoundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed:false};
  static getDerivedStateFromError() {return {failed:true};}
  render() {
    return this.state.failed
      ? <main className="cm-gate"><h1>管理画面を表示できませんでした</h1><p>画面を読み込み直すと、改めて権限と通信状況を確認します。</p><button onClick={() => location.reload()}>再読み込み</button></main>
      : this.props.children;
  }
}
const host = document.getElementById("counter-root");
if (host && !blockEmbeddedApp(host,window)) {
  try { createRoot(host).render(<ScreenBoundary><CounterManagerApp /></ScreenBoundary>); }
  catch {host.textContent = "管理画面を起動できませんでした。ブラウザを再読み込みしてください。";}
}
