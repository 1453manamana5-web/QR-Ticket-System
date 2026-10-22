import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore, type QueryDocumentSnapshot } from "firebase-admin/firestore";

/**
 * One-time full application data reset (terminal registrations + event/business data).
 *
 * Default mode is read-only. Apply only after strict rules/Functions are deployed,
 * verified, and a backup has been taken and reviewed.
 * For full reset including every administrator, additionally set
 * RESET_ALLOW_NO_ADMIN=true. Immediately bootstrap a new administrator with
 * the trusted bootstrap-admin.ts CLI before allowing normal operation.
 *
 * This script deletes events and nested tickets/reception records/analysis/members/settings,
 * event bundles, reception errors, and terminal-registration collections.
 *
 * Required:
 *   GCLOUD_PROJECT=<exact Firebase project ID>
 * Dry run: set GCLOUD_PROJECT and optionally RESET_KEEP_TERMINAL_ID/RESET_KEEP_OWNER_UID.
 * Preserve one admin: RESET_APPLY=true plus both RESET_KEEP_* variables.
 * Remove every admin too: RESET_APPLY=true RESET_ALLOW_NO_ADMIN=true, with no RESET_KEEP_* variables.
 *
 * Full-reset mode intentionally leaves zero authorized terminals. Only use the
 * trusted CLI bootstrap to create the first administrator after the reset.
 * A dry run is the default; no writes occur otherwise.
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
  if (Boolean(keepTerminalId) !== Boolean(keepOwnerUid)) {
    throw new Error("Set both RESET_KEEP_TERMINAL_ID and RESET_KEEP_OWNER_UID together, or omit both for a non-destructive preview.");
  }
  const allowNoAdmin = process.env.RESET_ALLOW_NO_ADMIN === "true";
  if (apply && !keepTerminalId && !keepOwnerUid && !allowNoAdmin) {
    throw new Error("Full reset requires explicit RESET_ALLOW_NO_ADMIN=true; otherwise provide both RESET_KEEP_* variables.");
  }
  if (apply && allowNoAdmin && (keepTerminalId || keepOwnerUid)) {
    throw new Error("Do not combine RESET_ALLOW_NO_ADMIN=true with RESET_KEEP_* variables.");
  }

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();

  // Validate the preservation target in both dry-run and apply mode. This avoids
  // presenting a preview as safe when the supposed recovery admin is not valid.
  if (keepTerminalId && keepOwnerUid) {
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
    { collection: "terminalApplications" },
    { collection: "terminalHandoffRequests" },
    { collection: "terminalHandoffRateLimits" },
    // Full reset includes all event documents and nested subcollections.
    { collection: "events" },
    { collection: "eventBundles" },
    { collection: "receptionErrors" },
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
          // Recursive deletion also removes nested event subcollections.
          await Promise.all(
            removals.slice(offset, offset + PAGE_SIZE).map(document => db.recursiveDelete(document.ref)),
          );
        }
      }
      cursor = page.docs[page.docs.length - 1];
      if (page.size < PAGE_SIZE) break;
    }
    totalEligible += eligible;
    process.stdout.write(
      `${apply ? "RESET" : "DRY RUN"}: ${target.collection}: scanned=${scanned}, ${apply ? "deleted" : "wouldDelete"}=${eligible}${target.keepId ? `, preservedId=${target.keepId}` : ""}\n`,
    );
  }

  process.stdout.write(
    apply
      ? `Full application reset completed for project ${projectId}. Preserved primary admin ${keepTerminalId}; deleted ${totalEligible} targeted parent documents and their nested data. Verify bootstrap and all flows before returning the system to use.\n`
      : `Dry run completed for project ${projectId}; no Firestore documents were changed. Candidate parent documents: ${totalEligible}; recursive deletion will also remove nested subcollections. For full reset, verify backup and deployed rules/Functions, then explicitly set RESET_APPLY=true and RESET_ALLOW_NO_ADMIN=true. Bootstrap a new admin immediately afterward.\n`,
  );
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
