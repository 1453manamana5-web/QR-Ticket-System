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
  if (typeof value !== "string" || value.trim().length < 8 ||
      value.length > 160 || value.includes("/")) {
    // IDs are used as single Firestore document-path segments. Reject slashes
    // rather than allowing caller input to alter the path structure.
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
    const terminalRef = db.doc("terminals/" + id);
    const ownerRef = db.doc("terminalOwners/" + id);
    const [installationSnap, terminalSnap, ownerSnap] = await Promise.all([
      tx.get(installationRef),
      tx.get(terminalRef),
      tx.get(ownerRef),
    ]);
    const terminalRole = terminalSnap.get("role");
    const terminalAllowsReception = terminalSnap.exists &&
      (terminalRole === "reception" || terminalRole === "both") &&
      (terminalSnap.get("receptionApproved") === true ||
        (terminalSnap.get("receptionApproved") === undefined && terminalSnap.get("approved") === true));
    if (!terminalSnap.exists || terminalSnap.get("approved") !== true ||
        !terminalAllowsReception || !ownerSnap.exists || ownerSnap.get("enabled") !== true) {
      throw new HttpsError("failed-precondition", "端末の受付承認が無効になったため、引き継ぎを完了できません。");
    }
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
  const terminalRole = terminal.get("role");
  if (!owner.exists || owner.get("enabled") !== true || !terminal.exists ||
      (terminalRole !== "reception" && terminalRole !== "both") ||
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
    // A disabled owner mapping still records prior ownership. Ordinary approval
    // must not transfer ownership; use the explicit handoff/recovery process.
    if (ownerSnap.exists && ownerSnap.get("ownerUid") !== targetUid) {
      throw new HttpsError("already-exists", "この端末IDは別の所有者に登録されています。所有権の引き継ぎ手続きが必要です。");
    }
    if (installationSnap.exists &&
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
    // Record a trusted installation for every approved role. Firestore rules
    // use this server-issued mapping to distinguish management clients from
    // reception-only clients.
    tx.set(installationRef, {
      terminalId: targetTerminalId,
      authUid: targetUid,
      approved: true,
      registrationApprovedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
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
    mode: "停止",
    desiredMode: "停止",
    desiredModeUpdatedAt: new Date().toISOString(),
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

  // A handed-off installation may release only its own installation grant.
  // Updating the shared terminal document here would revoke reception for every
  // installation and could also downgrade the original terminal's role.
  if (!ownsTerminal && hasInstallationGrant) {
    await installationRef.update({
      approved: false,
      releasedAt: FieldValue.serverTimestamp(),
    });
    return { terminalId, receptionApproved: false, released: true };
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
      const sameTrustedOwner = ownerSnap.exists &&
        ownerSnap.get("enabled") === true && ownerSnap.get("ownerUid") === uid;
      if (requestedRole === "reception" && sameTrustedOwner) {
        // Reapplying for reception always requires approval. Preserve an existing
        // management grant, but never carry forward reception approval.
        const managementApproved = current.managementApproved === true;
        tx.set(terminalRef, {
          name: name || (typeof current.name === "string" ? current.name : "受付端末"),
          type,
          role: managementApproved ? "both" : "reception",
          receptionApproved: false,
          approved: managementApproved,
          managementApproved,
          requestedRole: "reception",
          requestedByUid: uid,
          requestedAt: FieldValue.serverTimestamp(),
          status: managementApproved
            ? (current.status === "online" ? "online" : "offline")
            : "pending",
          updatedAt: new Date().toISOString(),
        }, { merge: true });
        return;
      }
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


/** Change sub-administrator status only from the trusted primary admin terminal. */
export const setTerminalSubAdmin = onCall(async (call) => {
  const uid = requireUid(call);
  const managerTerminalId = readId(call.data?.managerTerminalId, "管理端末ID");
  const targetTerminalId = readId(call.data?.targetTerminalId, "対象端末ID");
  const enabled = call.data?.enabled;
  if (typeof enabled !== "boolean") {
    throw new HttpsError("invalid-argument", "副管理者の設定値が正しくありません。");
  }
  if (managerTerminalId === targetTerminalId) {
    throw new HttpsError("failed-precondition", "自分自身を副管理者に設定できません。");
  }

  const [managerSnap, ownerSnap, targetSnap] = await Promise.all([
    db.doc("terminals/" + managerTerminalId).get(),
    db.doc("terminalOwners/" + managerTerminalId).get(),
    db.doc("terminals/" + targetTerminalId).get(),
  ]);
  if (!managerSnap.exists || !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true || ownerSnap.get("ownerUid") !== uid ||
      managerSnap.get("admin") !== true || managerSnap.get("managementApproved") !== true) {
    throw new HttpsError("permission-denied", "登録済みの管理者端末から実行してください。");
  }
  if (!targetSnap.exists) throw new HttpsError("not-found", "対象端末が見つかりません。");
  if (targetSnap.get("admin") === true) {
    throw new HttpsError("failed-precondition", "管理者端末の権限は変更できません。");
  }
  if (targetSnap.get("managementApproved") !== true ||
      (targetSnap.get("role") !== "management" && targetSnap.get("role") !== "both")) {
    throw new HttpsError("failed-precondition", "承認済みの管理端末のみ副管理者に設定できます。");
  }

  await db.doc("terminals/" + targetTerminalId).update({
    subAdmin: enabled,
    subAdminUpdatedAt: FieldValue.serverTimestamp(),
    subAdminUpdatedByUid: uid,
  });
  return { terminalId: targetTerminalId, subAdmin: enabled };
});


/** Atomically record a reception after verifying the server-issued installation and current terminal approval. */
export const recordReception = onCall(async (call) => {
  const uid = requireUid(call);
  const input = call.data?.record;
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpsError("invalid-argument", "受付記録が正しくありません。");
  }

  const recordId = readId(input.recordId, "受付記録ID");
  const eventId = readId(input.eventId, "イベントID");
  const ticketId = typeof input.ticketId === "string" && input.ticketId.trim().length > 0 &&
    input.ticketId.length <= 160 && !input.ticketId.includes("/") ? input.ticketId.trim() : "";
  const terminalId = readId(input.terminalId, "端末ID");
  const type = input.type;
  const timestamp = input.timestamp;
  if (!ticketId || (type !== "entry" && type !== "exit" && type !== "reentry") ||
      typeof timestamp !== "string" || !Number.isFinite(Date.parse(timestamp))) {
    throw new HttpsError("invalid-argument", "受付記録の内容が正しくありません。");
  }

  const installationRef = db.doc("terminalInstallations/" + uid);
  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);
  const eventRef = db.doc("events/" + eventId);
  const ticketRef = db.doc("events/" + eventId + "/tickets/" + ticketId);
  const recordRef = db.doc("events/" + eventId + "/receptionRecords/" + recordId);

  await db.runTransaction(async (tx) => {
    const [installationSnap, terminalSnap, ownerSnap, eventSnap, ticketSnap, recordSnap] = await Promise.all([
      tx.get(installationRef), tx.get(terminalRef), tx.get(ownerRef), tx.get(eventRef),
      tx.get(ticketRef), tx.get(recordRef),
    ]);

    const installationMatches = installationSnap.exists &&
      installationSnap.get("authUid") === uid &&
      installationSnap.get("approved") === true &&
      installationSnap.get("terminalId") === terminalId;
    // A handoff installation has its own Auth UID, so it need not equal the
    // original ownerUid. The server-issued installation must bind this UID to
    // this terminal, while the trusted owner mapping must remain enabled.
    const ownerEnabled = ownerSnap.exists && ownerSnap.get("enabled") === true;
    const terminalAllowsReception = terminalSnap.exists &&
      terminalSnap.get("approved") === true &&
      (terminalSnap.get("receptionApproved") === true ||
        (terminalSnap.get("receptionApproved") === undefined && terminalSnap.get("approved") === true)) &&
      (terminalSnap.get("role") === "reception" || terminalSnap.get("role") === "both");
    if (!installationMatches || !ownerEnabled || !terminalAllowsReception) {
      throw new HttpsError("permission-denied", "この端末は受付記録を保存する権限がありません。");
    }
    if (!eventSnap.exists || !ticketSnap.exists ||
        ticketSnap.get("eventId") !== eventId || ticketSnap.get("ticketId") !== ticketId) {
      throw new HttpsError("not-found", "イベントまたはチケットが見つかりません。");
    }

    // Retries of the same offline queue item are idempotent.
    if (recordSnap.exists) {
      const sameRecord = recordSnap.get("eventId") === eventId &&
        recordSnap.get("ticketId") === ticketId &&
        recordSnap.get("terminalId") === terminalId &&
        recordSnap.get("type") === type &&
        recordSnap.get("timestamp") === timestamp;
      if (!sameRecord) throw new HttpsError("already-exists", "受付記録IDが重複しています。");
      return;
    }

    const ticket = ticketSnap.data() ?? {};
    if (ticket.valid !== true) {
      throw new HttpsError("failed-precondition", "このチケットは無効です。");
    }
    const currentStatus = ticket.currentStatus;
    const allowed =
      (type === "entry" && currentStatus === "unused") ||
      (type === "reentry" && currentStatus === "exited") ||
      (type === "exit" && currentStatus === "inside");
    if (!allowed) {
      throw new HttpsError("failed-precondition", "チケットの現在状態と受付内容が一致しません。最新データを確認してください。");
    }

    const nextStatus = type === "exit" ? "exited" : "inside";
    tx.update(ticketRef, { currentStatus: nextStatus, updatedAt: timestamp });
    tx.create(recordRef, { recordId, eventId, ticketId, terminalId, type, timestamp });
  });

  return { saved: true, recordId };
});

/** Update operational heartbeat fields without exposing terminal authorization fields. */
export const updateTerminalHeartbeat = onCall(async (call) => {
  const uid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");
  const mode = call.data?.mode;
  const syncPendingCount = call.data?.syncPendingCount;
  const networkMbps = call.data?.networkMbps;
  if (mode !== "入口受付" && mode !== "出口受付" && mode !== "停止") {
    throw new HttpsError("invalid-argument", "受付モードが正しくありません。");
  }
  if (syncPendingCount !== undefined &&
      (!Number.isInteger(syncPendingCount) || syncPendingCount < 0 || syncPendingCount > 100000)) {
    throw new HttpsError("invalid-argument", "未同期件数が正しくありません。");
  }
  if (networkMbps !== undefined &&
      (typeof networkMbps !== "number" || !Number.isFinite(networkMbps) || networkMbps < 0 || networkMbps > 10000)) {
    throw new HttpsError("invalid-argument", "通信速度の値が正しくありません。");
  }

  const terminalRef = db.doc("terminals/" + terminalId);
  const [terminalSnap, ownerSnap, installationSnap] = await Promise.all([
    terminalRef.get(),
    db.doc("terminalOwners/" + terminalId).get(),
    db.doc("terminalInstallations/" + uid).get(),
  ]);
  const ownerMatches = ownerSnap.exists && ownerSnap.get("enabled") === true &&
    ownerSnap.get("ownerUid") === uid;
  const installationMatches = installationSnap.exists &&
    installationSnap.get("terminalId") === terminalId &&
    installationSnap.get("authUid") === uid &&
    installationSnap.get("approved") === true;
  if (!terminalSnap.exists || (!ownerMatches && !installationMatches)) {
    throw new HttpsError("permission-denied", "この端末を更新する権限がありません。");
  }

  const existing = terminalSnap.data() ?? {};
  const patch: Record<string, unknown> = {
    status: "online",
    lastSeen: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (ownerMatches && existing.managementApproved === true) {
    patch.mode = mode;
  }
  if (typeof syncPendingCount === "number") patch.syncPendingCount = syncPendingCount;
  if (typeof networkMbps === "number") patch.networkMbps = networkMbps;
  await terminalRef.update(patch);
  return { terminalId, status: "online" };
});


/** Change only the authenticated owner's own management-terminal display name. */
export const updateManagedTerminalName = onCall(async (call) => {
  const uid = requireUid(call);
  const terminalId = readId(call.data?.terminalId, "端末ID");
  const name = typeof call.data?.name === "string" ? call.data.name.trim() : "";
  if (!name || name.length > 80) {
    throw new HttpsError("invalid-argument", "端末名は1〜80文字で入力してください。");
  }
  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);
  const [terminalSnap, ownerSnap] = await Promise.all([terminalRef.get(), ownerRef.get()]);
  if (!terminalSnap.exists || !ownerSnap.exists ||
      ownerSnap.get("enabled") !== true || ownerSnap.get("ownerUid") !== uid ||
      terminalSnap.get("managementApproved") !== true) {
    throw new HttpsError("permission-denied", "この管理端末の名前を変更する権限がありません。");
  }
  await terminalRef.update({ name, updatedAt: new Date().toISOString() });
  return { terminalId, name };
});

/** Send a remote reception-mode command without rewriting terminal approval fields. */
export const setManagedTerminalMode = onCall(async (call) => {
  const uid = requireUid(call);
  const managerTerminalId = readId(call.data?.managerTerminalId, "管理端末ID");
  const targetTerminalId = readId(call.data?.targetTerminalId, "対象端末ID");
  const mode = call.data?.mode;
  if (mode !== "入口受付" && mode !== "出口受付" && mode !== "停止") {
    throw new HttpsError("invalid-argument", "受付モードが正しくありません。");
  }
  if (managerTerminalId === targetTerminalId) {
    throw new HttpsError("failed-precondition", "自分自身へのリモート操作はできません。");
  }
  const [managerSnap, managerOwnerSnap, targetSnap] = await Promise.all([
    db.doc("terminals/" + managerTerminalId).get(),
    db.doc("terminalOwners/" + managerTerminalId).get(),
    db.doc("terminals/" + targetTerminalId).get(),
  ]);
  if (!managerSnap.exists || !managerOwnerSnap.exists ||
      managerOwnerSnap.get("enabled") !== true || managerOwnerSnap.get("ownerUid") !== uid ||
      managerSnap.get("managementApproved") !== true ||
      (managerSnap.get("admin") !== true && managerSnap.get("subAdmin") !== true)) {
    throw new HttpsError("permission-denied", "登録済みの管理者端末から実行してください。");
  }
  if (!targetSnap.exists || targetSnap.get("receptionApproved") !== true ||
      targetSnap.get("approved") !== true || targetSnap.get("admin") === true) {
    throw new HttpsError("failed-precondition", "対象は承認済みの受付端末ではありません。");
  }
  const updatedAt = new Date().toISOString();
  await db.doc("terminals/" + targetTerminalId).update({
    desiredMode: mode,
    desiredModeUpdatedAt: updatedAt,
    updatedAt,
  });
  return { terminalId: targetTerminalId, mode, updatedAt };
});

/** Delete an event and all nested operational records using trusted server credentials. */
export const deleteManagedEvent = onCall(async (call) => {
  const uid = requireUid(call);
  const rawEventId = call.data?.eventId;
  if (typeof rawEventId !== "string" || !rawEventId.trim() ||
      rawEventId.length > 160 || rawEventId.includes("/")) {
    throw new HttpsError("invalid-argument", "イベントIDが正しくありません。");
  }
  const eventId = rawEventId.trim();
  const installationSnap = await db.doc("terminalInstallations/" + uid).get();
  if (!installationSnap.exists || installationSnap.get("authUid") !== uid ||
      installationSnap.get("approved") !== true) {
    throw new HttpsError("permission-denied", "承認済みの管理端末から実行してください。");
  }
  const terminalId = installationSnap.get("terminalId");
  if (typeof terminalId !== "string" || !terminalId || terminalId.includes("/")) {
    throw new HttpsError("permission-denied", "管理端末の登録情報が正しくありません。");
  }
  const terminalSnap = await db.doc("terminals/" + terminalId).get();
  if (!terminalSnap.exists || terminalSnap.get("approved") !== true ||
      terminalSnap.get("managementApproved") !== true ||
      (terminalSnap.get("role") !== "management" && terminalSnap.get("role") !== "both")) {
    throw new HttpsError("permission-denied", "イベント削除の権限がありません。");
  }
  const eventRef = db.doc("events/" + eventId);
  const eventSnap = await eventRef.get();
  if (!eventSnap.exists) {
    return { eventId, deleted: false };
  }
  await db.recursiveDelete(eventRef);
  return { eventId, deleted: true };
});

