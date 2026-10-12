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


/** Requests a role approval from the trusted server; the client never writes approval flags. */
export async function approveTerminalRegistration(
  managerTerminalId: string,
  targetTerminalId: string,
): Promise<{ terminalId: string; approved: true; role: "management" | "reception" | "both" }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { managerTerminalId: string; targetTerminalId: string },
    { terminalId: string; approved: true; role: "management" | "reception" | "both" }
  >(functionsClient(), "approveTerminalRegistration");
  const result = await callable({ managerTerminalId, targetTerminalId });
  return result.data;
}


export async function revokeTerminalReception(
  managerTerminalId: string,
  targetTerminalId: string,
): Promise<{ terminalId: string; receptionApproved: false }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { managerTerminalId: string; targetTerminalId: string },
    { terminalId: string; receptionApproved: false }
  >(functionsClient(), "revokeTerminalReception");
  const result = await callable({ managerTerminalId, targetTerminalId });
  return result.data;
}

export async function deleteManagedTerminalOnServer(
  managerTerminalId: string,
  targetTerminalId: string,
): Promise<{ terminalId: string; deleted: boolean }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { managerTerminalId: string; targetTerminalId: string },
    { terminalId: string; deleted: boolean }
  >(functionsClient(), "deleteManagedTerminal");
  const result = await callable({ managerTerminalId, targetTerminalId });
  return result.data;
}


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


export async function setTerminalSubAdmin(
  managerTerminalId: string,
  targetTerminalId: string,
  enabled: boolean,
): Promise<{ terminalId: string; subAdmin: boolean }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { managerTerminalId: string; targetTerminalId: string; enabled: boolean },
    { terminalId: string; subAdmin: boolean }
  >(functionsClient(), "setTerminalSubAdmin");
  const result = await callable({ managerTerminalId, targetTerminalId, enabled });
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


export async function updateManagedTerminalName(
  terminalId: string,
  name: string,
): Promise<{ terminalId: string; name: string }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { terminalId: string; name: string },
    { terminalId: string; name: string }
  >(functionsClient(), "updateManagedTerminalName");
  const result = await callable({ terminalId, name });
  return result.data;
}

export async function setManagedTerminalMode(
  managerTerminalId: string,
  targetTerminalId: string,
  mode: "入口受付" | "出口受付" | "停止",
): Promise<{ terminalId: string; mode: "入口受付" | "出口受付" | "停止"; updatedAt: string }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { managerTerminalId: string; targetTerminalId: string; mode: "入口受付" | "出口受付" | "停止" },
    { terminalId: string; mode: "入口受付" | "出口受付" | "停止"; updatedAt: string }
  >(functionsClient(), "setManagedTerminalMode");
  const result = await callable({ managerTerminalId, targetTerminalId, mode });
  return result.data;
}

export async function deleteManagedEvent(eventId: string): Promise<{ eventId: string; deleted: boolean }> {
  await ensureInstallationAuth();
  const callable = httpsCallable<
    { eventId: string },
    { eventId: string; deleted: boolean }
  >(functionsClient(), "deleteManagedEvent");
  const result = await callable({ eventId });
  return result.data;
}

