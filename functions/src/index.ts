import { initializeApp } from "firebase-admin/app";
import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";

initializeApp();
const db = getFirestore();

const REQUEST_TTL_MS = 5 * 60 * 1000;
const REQUEST_COOLDOWN_MS = 15 * 1000;

function requireUid(request: { auth?: { uid: string } | null }): string {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "ログイン状態を確認してください。");
  }
  return uid;
}

function readId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length < 8 || value.length > 160) {
    throw new HttpsError("invalid-argument", field + "が正しくありません。");
  }
  return value.trim();
}

/**
 * Phase-one server API for handoff. This deliberately requires terminal.ownerUid,
 * which must be populated through a trusted migration/registration flow before
 * this feature can be enabled. A public terminalId is never accepted as proof
 * of ownership.
 */
export const requestTerminalHandoff = onCall(async (call) => {
  const requesterUid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");

  const terminalRef = db.doc(`terminals/${terminalId}`);
  const requestRef = db.collection("terminalHandoffRequests").doc();
  const rateLimitRef = db.doc(`terminalHandoffRateLimits/${requesterUid}`);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const [terminalSnap, rateLimitSnap] = await Promise.all([
      tx.get(terminalRef),
      tx.get(rateLimitRef),
    ]);

    if (!terminalSnap.exists || terminalSnap.get("approved") !== true) {
      // Avoid confirming whether an arbitrary ID exists or is registered.
      throw new HttpsError("not-found", "引き継ぎ対象を確認できません。");
    }

    const lastRequestedAt = rateLimitSnap.get("lastRequestedAt") as Timestamp | undefined;
    if (lastRequestedAt && now - lastRequestedAt.toMillis() < REQUEST_COOLDOWN_MS) {
      throw new HttpsError("resource-exhausted", "少し待ってから再度申請してください。");
    }

    tx.set(requestRef, {
      terminalId,
      requesterUid,
      status: "pending",
      createdAt: FieldValue.serverTimestamp(),
      expiresAt: Timestamp.fromMillis(now + REQUEST_TTL_MS),
    });
    tx.set(rateLimitRef, {
      lastRequestedAt: Timestamp.fromMillis(now),
    }, { merge: true });
  });

  return { requestId: requestRef.id, expiresInSeconds: REQUEST_TTL_MS / 1000 };
});

/** Only the authenticated owner of the registered terminal can list its requests. */
export const listTerminalHandoffRequests = onCall(async (call) => {
  const ownerUid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");
  const terminalSnap = await db.doc(`terminals/${terminalId}`).get();

  if (
    !terminalSnap.exists ||
    terminalSnap.get("ownerUid") !== ownerUid ||
    terminalSnap.get("approved") !== true
  ) {
    throw new HttpsError("permission-denied", "この端末の申請を確認する権限がありません。");
  }

  const now = Timestamp.now();
  const snapshot = await db.collection("terminalHandoffRequests")
    .where("terminalId", "==", terminalId)
    .where("status", "==", "pending")
    .where("expiresAt", ">", now)
    .get();

  return {
    requests: snapshot.docs.map((doc) => ({
      requestId: doc.id,
      createdAt: doc.get("createdAt")?.toMillis?.() ?? null,
      expiresAt: doc.get("expiresAt").toMillis(),
    })),
  };
});

/** Approval/rejection is bound to a pending request and checked on the server. */
export const decideTerminalHandoff = onCall(async (call) => {
  const ownerUid = requireUid(call);
  const requestId = readId(call.data?.requestId, "申請ID");
  const decision = call.data?.decision;
  if (decision !== "approve" && decision !== "reject") {
    throw new HttpsError("invalid-argument", "承認または拒否を指定してください。");
  }

  const requestRef = db.doc(`terminalHandoffRequests/${requestId}`);
  await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (!requestSnap.exists) {
      throw new HttpsError("not-found", "申請が見つからないか、有効期限が切れています。");
    }

    const terminalId = requestSnap.get("terminalId") as string;
    const terminalRef = db.doc(`terminals/${terminalId}`);
    const terminalSnap = await tx.get(terminalRef);

    if (
      !terminalSnap.exists ||
      terminalSnap.get("ownerUid") !== ownerUid ||
      terminalSnap.get("approved") !== true
    ) {
      throw new HttpsError("permission-denied", "この申請を処理する権限がありません。");
    }

    if (
      requestSnap.get("status") !== "pending" ||
      !(requestSnap.get("expiresAt") as Timestamp).toMillis ||
      (requestSnap.get("expiresAt") as Timestamp).toMillis() <= Date.now()
    ) {
      throw new HttpsError("failed-precondition", "申請は処理済みか、有効期限が切れています。");
    }

    tx.update(requestRef, {
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: FieldValue.serverTimestamp(),
      decidedByUid: ownerUid,
    });
  });

  return { status: decision === "approve" ? "approved" : "rejected" };
});

/**
 * The requesting Firebase UID can consume an approval once. The resulting
 * installation record is written by Admin SDK, never by the browser.
 * Reception clients must still be updated to require this record before use.
 */
export const completeTerminalHandoff = onCall(async (call) => {
  const requesterUid = requireUid(call);
  const requestId = readId(call.data?.requestId, "申請ID");
  const requestRef = db.doc(`terminalHandoffRequests/${requestId}`);
  const installationRef = db.doc(`terminalInstallations/${requesterUid}`);

  const terminalId = await db.runTransaction(async (tx) => {
    const requestSnap = await tx.get(requestRef);
    if (
      !requestSnap.exists ||
      requestSnap.get("requesterUid") !== requesterUid ||
      requestSnap.get("status") !== "approved" ||
      (requestSnap.get("expiresAt") as Timestamp).toMillis() <= Date.now()
    ) {
      throw new HttpsError("permission-denied", "有効な承認済み申請がありません。");
    }

    const id = requestSnap.get("terminalId") as string;
    const installationSnap = await tx.get(installationRef);
    if (installationSnap.exists && installationSnap.get("terminalId") !== id) {
      throw new HttpsError("failed-precondition", "この環境は別の端末に登録済みです。");
    }

    tx.set(installationRef, {
      terminalId: id,
      authUid: requesterUid,
      approved: true,
      handoffRequestId: requestId,
      createdAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    tx.update(requestRef, {
      status: "consumed",
      consumedAt: FieldValue.serverTimestamp(),
    });
    return id;
  });

  return { terminalId, approved: true };
});
