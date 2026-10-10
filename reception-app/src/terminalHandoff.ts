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


/** Reads the server-owned installation record; a terminal ID alone is not approval. */
export async function getTerminalInstallationStatus(): Promise<{ approved: boolean; terminalId: string | null }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<void, { approved: boolean; terminalId: string | null }>(
    functionsClient(),
    "getTerminalInstallationStatus",
  );
  const result = await callable();
  return result.data;
}


/** Releases reception permission only for the current authenticated installation. */
export async function releaseOwnReceptionRegistration(
  terminalId: string,
): Promise<{ terminalId: string; receptionApproved: false; released: boolean }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { terminalId: string },
    { terminalId: string; receptionApproved: false; released: boolean }
  >(functionsClient(), "releaseOwnReceptionRegistration");
  const result = await callable({ terminalId });
  return result.data;
}

/** Submits an unapproved terminal application through the trusted server. */
export async function registerTerminalApplication(
  terminalId: string,
  name: string,
  type: "Web / iPad" | "Web / PC",
  role: "management" | "reception" | "both",
): Promise<{ terminalId: string; approved: false; status: "pending" }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { terminalId: string; name: string; type: "Web / iPad" | "Web / PC"; role: "management" | "reception" | "both" },
    { terminalId: string; approved: false; status: "pending" }
  >(functionsClient(), "registerTerminalApplication");
  const result = await callable({ terminalId, name, type, role });
  return result.data;
}


export async function updateTerminalHeartbeat(
  terminalId: string,
  mode: "入口受付" | "出口受付" | "停止",
  syncPendingCount?: number,
  networkMbps?: number | null,
): Promise<{ terminalId: string; status: "online" }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { terminalId: string; mode: "入口受付" | "出口受付" | "停止"; syncPendingCount?: number; networkMbps?: number | null },
    { terminalId: string; status: "online" }
  >(functionsClient(), "updateTerminalHeartbeat");
  const result = await callable({ terminalId, mode, syncPendingCount, networkMbps: networkMbps ?? undefined });
  return result.data;
}
