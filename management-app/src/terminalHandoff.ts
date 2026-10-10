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

export type PendingHandoffRequest = {
  requestId: string;
  createdAt: number | null;
  expiresAt: number;
};

export async function listTerminalHandoffRequests(terminalId: string): Promise<PendingHandoffRequest[]> {
  await ensureInstallationAuth();
  const callable = httpsCallable<{ terminalId: string }, { requests: PendingHandoffRequest[] }>(
    functionsClient(),
    "listTerminalHandoffRequests",
  );
  const result = await callable({ terminalId });
  return result.data.requests;
}

export async function decideTerminalHandoff(
  requestId: string,
  decision: "approve" | "reject",
): Promise<{ status: "approved" | "rejected" }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { requestId: string; decision: "approve" | "reject" },
    { status: "approved" | "rejected" }
  >(functionsClient(), "decideTerminalHandoff");
  const result = await callable({ requestId, decision });
  return result.data;
}
