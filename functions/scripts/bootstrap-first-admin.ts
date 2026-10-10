import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * One-time, trusted first-admin bootstrap.
 * Run only from a trusted workstation with ADC for the intended Firebase project.
 * Refuses to overwrite either the terminal document or owner mapping.
 */
async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const terminalId = process.env.BOOTSTRAP_TERMINAL_ID?.trim();
  const ownerUid = process.env.BOOTSTRAP_OWNER_UID?.trim();
  const terminalName = (process.env.BOOTSTRAP_TERMINAL_NAME || "管理端末").trim().slice(0, 80);

  if (!projectId) throw new Error("Set GCLOUD_PROJECT to the exact Firebase project ID.");
  if (!terminalId || !/^T-[A-Za-z0-9-]{8,40}$/.test(terminalId)) {
    throw new Error("BOOTSTRAP_TERMINAL_ID must be a valid T- terminal ID.");
  }
  if (!ownerUid || ownerUid.length < 8 || ownerUid.length > 128) {
    throw new Error("BOOTSTRAP_OWNER_UID must be the UID of the intended management app installation.");
  }

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const terminalRef = db.doc("terminals/" + terminalId);
  const ownerRef = db.doc("terminalOwners/" + terminalId);

  await db.runTransaction(async tx => {
    const [terminal, owner] = await Promise.all([tx.get(terminalRef), tx.get(ownerRef)]);
    if (terminal.exists) throw new Error("Terminal already exists; refusing to overwrite it.");
    if (owner.exists) throw new Error("Owner mapping already exists; refusing to overwrite it.");
    tx.create(terminalRef, {
      terminalId,
      name: terminalName || "管理端末",
      type: "Web / iPad",
      role: "management",
      mode: "停止",
      desiredMode: "停止",
      status: "online",
      approved: true,
      managementApproved: true,
      receptionApproved: false,
      admin: true,
      subAdmin: false,
      lastSeen: new Date().toISOString(),
      networkMbps: null,
      battery: null,
      createdByTrustedBootstrap: true,
      createdAt: new Date().toISOString(),
    });
    tx.create(ownerRef, {
      terminalId,
      ownerUid,
      enabled: true,
      migratedAt: new Date().toISOString(),
      migrationSource: "trusted-first-admin-bootstrap",
    });
    // Firestore Rules use this trusted installation mapping to authorize
    // management data writes from the first admin's authenticated browser.
    tx.create(db.doc("terminalInstallations/" + ownerUid), {
      terminalId,
      authUid: ownerUid,
      approved: true,
      registrationApprovedAt: new Date().toISOString(),
      createdByTrustedBootstrap: true,
    });
  });

  process.stdout.write("First admin terminal and trusted owner mapping created. Keep this output in your admin audit log.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
