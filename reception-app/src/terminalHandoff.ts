import { getApp, getApps, initializeApp } from "firebase/app";
import { getFunctions, httpsCallable } from "firebase/functions";
import { ensureInstallationAuth } from "./firebaseClient";

function functionsClient() {
  const app = getApps().length > 0 ? getApp() : initializeApp({
    apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
    authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
    projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
    storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: import.meta.env.VITE_FIREBASE_APP_ID,
  });
  return getFunctions(app);
}

export type HandoffRequestResult = { requestId: string; expiresInSeconds: number };

/** Starts a server-verified request. The entered terminal ID grants no access by itself. */
export async function requestTerminalHandoff(terminalId: string): Promise<HandoffRequestResult> {
  const id = terminalId.trim();
  if (id.length < 8 || id.length > 160) throw new Error("端末IDを確認してください。");
  await ensureInstallationAuth();
  const callable = httpsCallable<{ terminalId: string }, HandoffRequestResult>(
    functionsClient(),
    "requestTerminalHandoff",
  );
  const result = await callable({ terminalId: id });
  return result.data;
}

/** Completes only a request approved by the trusted owner and bound to this installation's auth UID. */
export async function completeTerminalHandoff(requestId: string): Promise<{ terminalId: string; approved: true }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<{ requestId: string }, { terminalId: string; approved: true }>(
    functionsClient(),
    "completeTerminalHandoff",
  );
  const result = await callable({ requestId });
  return result.data;
}
