import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

/**
 * One-time terminal-registration reset.
 *
 * Default mode is read-only. Apply only after:
 *  - the strict Firestore rules and callable Functions are deployed and verified;
 *  - the intended primary admin terminal has a valid server-owned owner mapping
 *    and installation mapping;
 *  - a backup has been taken and reviewed.
 *
 * This script never deletes events, tickets, event bundles, reception records,
 * analysis, members, settings, or published event data.
 *
 * Required:
 *   GCLOUD_PROJECT=<exact Firebase project ID>
 * Optional dry run:
 *   RESET_KEEP_TERMINAL_ID=T-... RESET_KEEP_OWNER_UID=... (for preview)
 * Apply:
 *   RESET_APPLY=true RESET_KEEP_TERMINAL_ID=T-... RESET_KEEP_OWNER_UID=...
 *
 * The primary administrator terminal and its owner/installation mappings are
 * preserved. All other old/new terminal registration records and device-setting
 * documents are removed. A dry run is the default; no writes occur otherwise.
 */
const PAGE_SIZE = 300;
const TERMINAL_ID_PATTERN = /^T-[A-Za-z0-9-]{8,40}$/;

type Target = {
  collection: string;
  keepId?: string;
};

async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const apply = process.env.RESET_APPLY === "true";
  const keepTerminalId = process.env.RESET_KEEP_TERMINAL_ID?.trim();
  const keepOwnerUid = process.env.RESET_KEEP_OWNER_UID?.trim();

  if (!projectId) throw new Error("Set GCLOUD_PROJECT to the exact Firebase project ID.");
  if (keepTerminalId && !TERMINAL_ID_PATTERN.test(keepTerminalId)) {
    throw new Error("RESET_KEEP_TERMINAL_ID must be a valid T- terminal ID.");
  }
  if (keepOwnerUid && (keepOwnerUid.length < 8 || keepOwnerUid.length > 128)) {
    throw new Error("RESET_KEEP_OWNER_UID must be a valid Firebase Auth UID.");
  }
  if (apply && (!keepTerminalId || !keepOwnerUid)) {
    throw new Error("Apply requires both RESET_KEEP_TERMINAL_ID and RESET_KEEP_OWNER_UID to preserve the recovery admin.");
  }

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();

  if (apply) {
    const [terminal, owner, installation] = await Promise.all([
      db.doc("terminals/" + keepTerminalId).get(),
      db.doc("terminalOwners/" + keepTerminalId).get(),
      db.doc("terminalInstallations/" + keepOwnerUid).get(),
    ]);
    if (!terminal.exists || !owner.exists || !installation.exists) {
      throw new Error("Recovery admin terminal, owner, or installation mapping is missing; refusing reset.");
    }
    const terminalData = terminal.data()!;
    if (terminalData.approved !== true ||
        terminalData.managementApproved !== true ||
        (terminalData.role !== "management" && terminalData.role !== "both") ||
        terminalData.admin !== true ||
        owner.get("terminalId") !== keepTerminalId ||
        owner.get("ownerUid") !== keepOwnerUid ||
        owner.get("enabled") !== true ||
        installation.get("terminalId") !== keepTerminalId ||
        installation.get("authUid") !== keepOwnerUid ||
        installation.get("approved") !== true) {
      throw new Error("Recovery admin mappings do not match an approved primary management terminal; refusing reset.");
    }
  }

  const targets: Target[] = [
    { collection: "terminals", keepId: keepTerminalId },
    { collection: "terminalOwners", keepId: keepTerminalId },
    { collection: "terminalInstallations", keepId: keepOwnerUid },
    { collection: "devices", keepId: keepTerminalId },
    // Requests and rate limits are intentionally cleared, including those for
    // the preserved admin UID, so no old approval can survive the reset.
    { collection: "terminalApplications" },
    { collection: "terminalHandoffRequests" },
    { collection: "terminalHandoffRateLimits" },
  ];

  let totalEligible = 0;
  for (const target of targets) {
    const collectionRef = db.collection(target.collection);
    let cursor: QueryDocumentSnapshot | undefined;
    let scanned = 0;
    let eligible = 0;
    while (true) {
      let query = collectionRef.orderBy("__name__").limit(PAGE_SIZE);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      if (page.empty) break;
      scanned += page.size;
      const removals = page.docs.filter(document => document.id !== target.keepId);
      eligible += removals.length;

      if (apply) {
        for (let offset = 0; offset < removals.length; offset += PAGE_SIZE) {
          const batch = db.batch();
          removals.slice(offset, offset + PAGE_SIZE).forEach(document => batch.delete(document.ref));
          await batch.commit();
        }
      }
      cursor = page.docs[page.docs.length - 1];
      if (page.size < PAGE_SIZE) break;
    }
    totalEligible += eligible;
    process.stdout.write(
      `${apply ? "RESET" : "DRY RUN"}: ${target.collection}: scanned=${scanned}, ${apply ? "deleted" : "wouldDelete"}=${eligible}${target.keepId ? `, preservedId=${target.keepId}` : ""}\\n`,
    );
  }

  process.stdout.write(
    apply
      ? `Terminal reset completed for project ${projectId}. Preserved primary admin ${keepTerminalId}; removed ${totalEligible} other terminal-related documents. Event/ticket data were not targeted. Verify registration and handoff flows before returning the system to use.\\n`
      : `Dry run completed for project ${projectId}; no Firestore documents were changed. Candidate deletions: ${totalEligible}. Set RESET_APPLY=true only after backup, rule/Functions verification, and independent confirmation of the preserved primary admin.\\n`,
  );
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\\n");
  process.exitCode = 1;
});
