import { applicationDefault, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";

/**
 * One-time trusted CLI bootstrap for the first management administrator.
 * Never expose this as a callable or browser endpoint.
 *
 * Required: GCLOUD_PROJECT, BOOTSTRAP_ADMIN_TERMINAL_ID, BOOTSTRAP_ADMIN_UID
 * Optional: BOOTSTRAP_ADMIN_NAME (default: "管理者端末")
 * Apply only with: BOOTSTRAP_ADMIN_APPLY=true
 * Default is a read-only validation. Use only after the terminal collections
 * have been reset and the UID has been independently verified in Firebase Auth.
 */
async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const terminalId = process.env.BOOTSTRAP_ADMIN_TERMINAL_ID?.trim();
  const uid = process.env.BOOTSTRAP_ADMIN_UID?.trim();
  const name = (process.env.BOOTSTRAP_ADMIN_NAME || "管理者端末").trim();
  const apply = process.env.BOOTSTRAP_ADMIN_APPLY === "true";

  if (!projectId) throw new Error("Set GCLOUD_PROJECT to the exact Firebase project ID.");
  if (!terminalId || !/^T-[A-Za-z0-9-]{8,40}$/.test(terminalId)) {
    throw new Error("BOOTSTRAP_ADMIN_TERMINAL_ID must be a valid T- terminal ID.");
  }
  if (!uid || uid.length < 8 || uid.length > 128 || uid.includes("/")) {
    throw new Error("BOOTSTRAP_ADMIN_UID must be a verified Firebase Auth UID.");
  }
  if (!name || name.length > 80) throw new Error("BOOTSTRAP_ADMIN_NAME must be 1-80 characters.");

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);
  const installationRef = db.doc("terminalInstallations/" + uid);
  const [terminal, owner, installation, ownerMappings] = await Promise.all([
    terminalRef.get(),
    ownerRef.get(),
    installationRef.get(),
    db.collection("terminalOwners").where("ownerUid", "==", uid).get(),
  ]);

  if (ownerMappings.docs.some(doc => doc.id !== terminalId)) {
    throw new Error("This UID is already mapped to a different terminal; refusing bootstrap.");
  }
  if (terminal.exists || owner.exists || installation.exists) {
    const terminalMatches = terminal.exists &&
      terminal.get("admin") === true &&
      terminal.get("approved") === true &&
      terminal.get("managementApproved") === true &&
      (terminal.get("role") === "management" || terminal.get("role") === "both");
    const ownerMatches = owner.exists &&
      owner.get("terminalId") === terminalId &&
      owner.get("ownerUid") === uid &&
      owner.get("enabled") === true;
    const installationMatches = installation.exists &&
      installation.get("terminalId") === terminalId &&
      installation.get("authUid") === uid &&
      installation.get("approved") === true;
    if (terminalMatches && ownerMatches && installationMatches) {
      process.stdout.write("Admin bootstrap already matches; no changes needed.\n");
      return;
    }
    throw new Error("Conflicting terminal/owner/installation data exists; refusing to overwrite it. Reset or investigate first.");
  }

  process.stdout.write(`${apply ? "APPLY" : "DRY RUN"}: project=${projectId}, terminalId=${terminalId}, verifiedUid=${uid}, role=management, admin=true\n`);
  if (!apply) {
    process.stdout.write("No writes performed. Independently verify the project ID and Firebase Auth UID, then set BOOTSTRAP_ADMIN_APPLY=true to create the first administrator.\n");
    return;
  }

  const now = new Date().toISOString();
  const batch = db.batch();
  batch.create(terminalRef, {
    terminalId,
    name,
    type: "Web / PC",
    role: "management",
    approved: true,
    admin: true,
    managementApproved: true,
    receptionApproved: false,
    status: "offline",
    desiredMode: "停止",
    createdAt: now,
    updatedAt: now,
    bootstrapSource: "trusted-one-time-cli",
  });
  batch.create(ownerRef, {
    terminalId,
    ownerUid: uid,
    enabled: true,
    createdAt: FieldValue.serverTimestamp(),
    bootstrapSource: "trusted-one-time-cli",
  });
  batch.create(installationRef, {
    terminalId,
    authUid: uid,
    approved: true,
    registrationApprovedAt: now,
    createdByTrustedBootstrap: true,
  });
  await batch.commit();
  process.stdout.write("First administrator created. Verify sign-in and management access before registering other terminals.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
