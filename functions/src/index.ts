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
 * Ownership is stored separately in terminalOwners/{terminalId}. That collection
 * must be writable only by trusted Admin SDK code; clients must never be able to
 * create or update ownership mappings. Existing terminals need a trusted
 * migration before this flow can be enabled.
 */
export const requestTerminalHandoff = onCall(async (call) => {
  const requesterUid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");

  const terminalRef = db.doc(`terminals/${terminalId}`);
  const requestRef = db.collection("terminalHandoffRequests").doc();
  const rateLimitRef = db.doc(`terminalHandoffRateLimits/${requesterUid}`);
  const now = Date.now();

  await db.runTransaction(async (tx) => {
    const ownerRef = db.doc(`terminalOwners/${terminalId}`);
    const [terminalSnap, ownerSnap, rateLimitSnap] = await Promise.all([
      tx.get(terminalRef),
      tx.get(ownerRef),
      tx.get(rateLimitRef),
    ]);

    if (
      !terminalSnap.exists ||
      terminalSnap.get("approved") !== true ||
      !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true
    ) {
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
  const [terminalSnap, ownerSnap] = await Promise.all([
    db.doc(`terminals/${terminalId}`).get(),
    db.doc(`terminalOwners/${terminalId}`).get(),
  ]);

  if (
    !terminalSnap.exists ||
    terminalSnap.get("approved") !== true ||
    !ownerSnap.exists ||
    ownerSnap.get("enabled") !== true ||
    ownerSnap.get("ownerUid") !== ownerUid
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
    const ownerRef = db.doc(`terminalOwners/${terminalId}`);
    const [terminalSnap, ownerSnap] = await Promise.all([
      tx.get(terminalRef),
      tx.get(ownerRef),
    ]);

    if (
      !terminalSnap.exists ||
      terminalSnap.get("approved") !== true ||
      !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true ||
      ownerSnap.get("ownerUid") !== ownerUid
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


/** Verify that this Firebase Auth installation has a server-issued handoff. */
export const getTerminalInstallationStatus = onCall(async (call) => {
  const uid = requireUid(call);
  const installation = await db.doc("terminalInstallations/" + uid).get();
  if (!installation.exists || installation.get("authUid") !== uid || installation.get("approved") !== true) {
    return { approved: false, terminalId: null };
  }

  const terminalId = installation.get("terminalId");
  if (typeof terminalId !== "string" || terminalId.length < 8 || terminalId.length > 160) {
    return { approved: false, terminalId: null };
  }

  const owner = await db.doc("terminalOwners/" + terminalId).get();
  const terminal = await db.doc("terminals/" + terminalId).get();
  if (!owner.exists || owner.get("enabled") !== true || !terminal.exists ||
      !(terminal.get("receptionApproved") === true || (terminal.get("receptionApproved") === undefined && terminal.get("approved") === true))) {
    return { approved: false, terminalId: null };
  }

  return { approved: true, terminalId };
});


/** Approve requested terminal roles only when called by a trusted registered manager. */
export const approveTerminalRegistration = onCall(async (call) => {
  const uid = requireUid(call);
  const managerTerminalId = readId(call.data?.managerTerminalId, "管理端末ID");
  const targetTerminalId = readId(call.data?.targetTerminalId, "対象端末ID");
  if (managerTerminalId === targetTerminalId) {
    throw new HttpsError("invalid-argument", "自分自身は承認できません。");
  }

  const [managerSnap, managerOwnerSnap, targetSnap] = await Promise.all([
    db.doc("terminals/" + managerTerminalId).get(),
    db.doc("terminalOwners/" + managerTerminalId).get(),
    db.doc("terminals/" + targetTerminalId).get(),
  ]);

  if (!managerSnap.exists || !managerOwnerSnap.exists ||
      managerOwnerSnap.get("enabled") !== true ||
      managerOwnerSnap.get("ownerUid") !== uid ||
      managerSnap.get("managementApproved") !== true ||
      (managerSnap.get("admin") !== true && managerSnap.get("subAdmin") !== true)) {
    throw new HttpsError("permission-denied", "登録済みの管理者端末から実行してください。");
  }
  if (!targetSnap.exists) {
    throw new HttpsError("not-found", "承認対象の端末が見つかりません。");
  }

  // The bootstrap administrator and any designated sub-administrator are protected
  // identities; they cannot be re-approved through the ordinary registration queue.
  if (targetSnap.get("admin") === true || targetSnap.get("subAdmin") === true) {
    throw new HttpsError("failed-precondition", "管理権限を持つ端末は通常の申請から変更できません。");
  }

  const role = targetSnap.get("role");
  if (role !== "management" && role !== "reception" && role !== "both") {
    throw new HttpsError("failed-precondition", "端末の申請内容を確認できません。");
  }

  const isAdmin = managerSnap.get("admin") === true;
  if (!isAdmin && (role === "management" || role === "both")) {
    throw new HttpsError("permission-denied", "副管理者は管理端末を承認できません。");
  }

  const targetUid = targetSnap.get("requestedByUid");
  if (typeof targetUid !== "string" || targetUid.length < 1) {
    throw new HttpsError("failed-precondition", "この申請は端末所有者を検証できません。安全な移行後に再申請してください。");
  }

  const targetRef = db.doc("terminals/" + targetTerminalId);
  const targetOwnerRef = db.doc("terminalOwners/" + targetTerminalId);
  const installationRef = db.doc("terminalInstallations/" + targetUid);
  await db.runTransaction(async (tx) => {
    const [freshTarget, ownerSnap, installationSnap] = await Promise.all([
      tx.get(targetRef), tx.get(targetOwnerRef), tx.get(installationRef),
    ]);
    if (!freshTarget.exists ||
        freshTarget.get("requestedByUid") !== targetUid ||
        freshTarget.get("admin") === true || freshTarget.get("subAdmin") === true) {
      throw new HttpsError("failed-precondition", "申請内容が変更されています。再読み込みしてください。");
    }
    if (ownerSnap.exists && ownerSnap.get("enabled") === true &&
        ownerSnap.get("ownerUid") !== targetUid) {
      throw new HttpsError("already-exists", "この端末IDは別の所有者に登録されています。");
    }
    if ((role === "reception" || role === "both") && installationSnap.exists &&
        installationSnap.get("terminalId") !== targetTerminalId) {
      throw new HttpsError("already-exists", "この端末環境は別の端末に登録済みです。");
    }

    const patch: Record<string, any> = {
      approved: true,
      status: "offline",
      approvalUpdatedAt: FieldValue.serverTimestamp(),
      approvalUpdatedByUid: uid,
    };
    if (role === "management" || role === "both") patch.managementApproved = true;
    if (role === "reception" || role === "both") patch.receptionApproved = true;
    tx.update(targetRef, patch);
    tx.set(targetOwnerRef, {
      terminalId: targetTerminalId,
      ownerUid: targetUid,
      enabled: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (role === "reception" || role === "both") {
      tx.set(installationRef, {
        terminalId: targetTerminalId,
        authUid: targetUid,
        approved: true,
        registrationApprovedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
  });
  return { terminalId: targetTerminalId, approved: true, role };
});


/** Revoke reception access without letting the browser edit approval flags directly. */
export const revokeTerminalReception = onCall(async (call) => {
  const uid = requireUid(call);
  const managerTerminalId = readId(call.data?.managerTerminalId, "管理端末ID");
  const targetTerminalId = readId(call.data?.targetTerminalId, "対象端末ID");

  const [managerSnap, ownerSnap, targetSnap] = await Promise.all([
    db.doc("terminals/" + managerTerminalId).get(),
    db.doc("terminalOwners/" + managerTerminalId).get(),
    db.doc("terminals/" + targetTerminalId).get(),
  ]);
  if (!managerSnap.exists || !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true || ownerSnap.get("ownerUid") !== uid ||
      managerSnap.get("managementApproved") !== true ||
      (managerSnap.get("admin") !== true && managerSnap.get("subAdmin") !== true)) {
    throw new HttpsError("permission-denied", "登録済みの管理者端末から実行してください。");
  }
  if (!targetSnap.exists) throw new HttpsError("not-found", "対象端末が見つかりません。");
  if (targetSnap.get("admin") === true || targetSnap.get("subAdmin") === true) {
    throw new HttpsError("permission-denied", "管理権限を持つ端末の受付権限は解除できません。");
  }

  const role = targetSnap.get("role");
  const patch: Record<string, unknown> = {
    receptionApproved: false,
    approved: targetSnap.get("managementApproved") === true,
    updatedAt: new Date().toISOString(),
    approvalUpdatedAt: FieldValue.serverTimestamp(),
    approvalUpdatedByUid: uid,
  };
  if (role === "both") patch.role = "management";
  else if (role === "reception") patch.role = "reception";
  await db.doc("terminals/" + targetTerminalId).update(patch);
  return { terminalId: targetTerminalId, receptionApproved: false };
});

/** Delete another terminal only through a trusted admin/sub-admin server check. */
export const deleteManagedTerminal = onCall(async (call) => {
  const uid = requireUid(call);
  const managerTerminalId = readId(call.data?.managerTerminalId, "管理端末ID");
  const targetTerminalId = readId(call.data?.targetTerminalId, "対象端末ID");
  if (managerTerminalId === targetTerminalId) {
    throw new HttpsError("failed-precondition", "現在使用中の管理端末は削除できません。");
  }

  const [managerSnap, ownerSnap, targetSnap] = await Promise.all([
    db.doc("terminals/" + managerTerminalId).get(),
    db.doc("terminalOwners/" + managerTerminalId).get(),
    db.doc("terminals/" + targetTerminalId).get(),
  ]);
  if (!managerSnap.exists || !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true || ownerSnap.get("ownerUid") !== uid ||
      managerSnap.get("managementApproved") !== true ||
      (managerSnap.get("admin") !== true && managerSnap.get("subAdmin") !== true)) {
    throw new HttpsError("permission-denied", "登録済みの管理者端末から実行してください。");
  }
  if (!targetSnap.exists) return { terminalId: targetTerminalId, deleted: false };
  // Administrator terminals are never deletable, including by another admin.
  if (targetSnap.get("admin") === true) {
    throw new HttpsError("permission-denied", "管理者端末は削除できません。");
  }

  const isAdmin = managerSnap.get("admin") === true;
  const targetRole = targetSnap.get("role");
  if (!isAdmin && (targetRole === "management" || targetRole === "both")) {
    throw new HttpsError("permission-denied", "副管理者は管理端末を削除できません。");
  }

  const batch = db.batch();
  batch.delete(db.doc("terminals/" + targetTerminalId));
  const targetOwnerRef = db.doc("terminalOwners/" + targetTerminalId);
  const targetOwner = await targetOwnerRef.get();
  if (targetOwner.exists) batch.delete(targetOwnerRef);
  await batch.commit();

  const pending = await db.collection("terminalHandoffRequests")
    .where("terminalId", "==", targetTerminalId).get();
  for (let i = 0; i < pending.docs.length; i += 400) {
    const cleanup = db.batch();
    pending.docs.slice(i, i + 400).forEach((doc) => cleanup.delete(doc.ref));
    await cleanup.commit();
  }

  const installations = await db.collection("terminalInstallations")
    .where("terminalId", "==", targetTerminalId).get();
  for (let i = 0; i < installations.docs.length; i += 400) {
    const cleanup = db.batch();
    installations.docs.slice(i, i + 400).forEach((doc) => cleanup.delete(doc.ref));
    await cleanup.commit();
  }
  return { terminalId: targetTerminalId, deleted: true };
});


/** Let an installation release only its own reception permission. */
export const releaseOwnReceptionRegistration = onCall(async (call) => {
  const uid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");
  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);
  const installationRef = db.doc("terminalInstallations/" + uid);
  const [terminalSnap, ownerSnap, installationSnap] = await Promise.all([
    terminalRef.get(),
    ownerRef.get(),
    installationRef.get(),
  ]);

  const ownsTerminal = ownerSnap.exists &&
    ownerSnap.get("enabled") === true &&
    ownerSnap.get("ownerUid") === uid;
  const hasInstallationGrant = installationSnap.exists &&
    installationSnap.get("authUid") === uid &&
    installationSnap.get("approved") === true &&
    installationSnap.get("terminalId") === terminalId;
  if (!ownsTerminal && !hasInstallationGrant) {
    throw new HttpsError("permission-denied", "この端末の受付権限を解除する権限がありません。");
  }
  if (!terminalSnap.exists) {
    return { terminalId, receptionApproved: false, released: false };
  }
  const role = terminalSnap.get("role");
  const managementApproved = terminalSnap.get("managementApproved") === true;
  const patch: Record<string, unknown> = {
    receptionApproved: false,
    approved: managementApproved,
    updatedAt: new Date().toISOString(),
    approvalUpdatedAt: FieldValue.serverTimestamp(),
    approvalUpdatedByUid: uid,
  };
  if (role === "both" && managementApproved) patch.role = "management";
  await terminalRef.update(patch);
  return { terminalId, receptionApproved: false, released: true };
});


/** Create a pending terminal application without allowing the browser to grant privileges. */
export const registerTerminalApplication = onCall(async (call) => {
  const uid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");
  const name = typeof call.data?.name === "string" ? call.data.name.trim().slice(0, 80) : "";
  const type = call.data?.type === "Web / PC" ? "Web / PC" : "Web / iPad";
  const requestedRole = call.data?.role;
  if (!/^T-[A-Za-z0-9-]{8,40}$/.test(terminalId)) {
    throw new HttpsError("invalid-argument", "端末IDが正しくありません。");
  }
  if (requestedRole !== "management" && requestedRole !== "reception" && requestedRole !== "both") {
    throw new HttpsError("invalid-argument", "申請する端末種別が正しくありません。");
  }

  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);
  await db.runTransaction(async (tx) => {
    const [terminalSnap, ownerSnap] = await Promise.all([tx.get(terminalRef), tx.get(ownerRef)]);
    if (ownerSnap.exists && ownerSnap.get("enabled") === true &&
        ownerSnap.get("ownerUid") !== uid) {
      throw new HttpsError("already-exists", "この端末IDは別の登録に使用されています。");
    }
    if (terminalSnap.exists) {
      const current = terminalSnap.data() ?? {};
      if (current.admin === true || current.subAdmin === true ||
          current.managementApproved === true || current.receptionApproved === true ||
          current.approved === true) {
        throw new HttpsError("already-exists", "登録済み端末は新規申請できません。管理端末から承認操作を行ってください。");
      }
      if (typeof current.requestedByUid === "string" && current.requestedByUid !== uid) {
        throw new HttpsError("already-exists", "この端末IDは別の申請で使用されています。");
      }
    }

    tx.set(terminalRef, {
      terminalId,
      name: name || "端末申請",
      type,
      role: requestedRole,
      mode: "停止",
      status: "pending",
      approved: false,
      managementApproved: false,
      receptionApproved: false,
      admin: false,
      subAdmin: false,
      requestedRole,
      requestedByUid: uid,
      requestedAt: FieldValue.serverTimestamp(),
      lastSeen: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, { merge: true });
  });

  return { terminalId, approved: false, status: "pending" };
});
