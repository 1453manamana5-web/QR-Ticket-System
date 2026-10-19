import {StrictMode} from "react"; import {createRoot} from "react-dom/client"; import App from "./App"; import "./styles.css";

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL })
      .catch(error => console.warn("受付アプリのオフライン起動を準備できませんでした", error));
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);