import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Trusted migration for existing approved management and reception terminals.
 *
 * Include every existing terminal that must remain authorized after the rules switch,
 * including reception-only terminals. Use only independently verified owner UIDs.
 *
 * Required environment:
 *   GCLOUD_PROJECT=<exact Firebase project ID>
 *   TERMINAL_OWNER_MIGRATION_JSON=[{"terminalId":"T-...","ownerUid":"..."}]
 * Safety:
 *   The default is a dry run. No writes occur unless MIGRATION_APPLY=true.
 * Optional:
 *   MIGRATION_DRY_RUN=true   explicitly keeps the run read-only, even if MIGRATION_APPLY=true.
 *
 * The owner UID must be independently verified as the Firebase Auth UID of the
 * terminal's original registered installation. Do not trust requestedByUid or
 * other Firestore fields alone: the live database rules may have allowed clients
 * to edit them. Never accept this mapping from a browser or user-supplied form.
 */
async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const raw = process.env.TERMINAL_OWNER_MIGRATION_JSON;
  // Fail closed: a missing or misspelled apply flag must never write to Firestore.
  const applyRequested = process.env.MIGRATION_APPLY === "true";
  const dryRun = !applyRequested || process.env.MIGRATION_DRY_RUN === "true";

  if (!projectId) throw new Error("Set GCLOUD_PROJECT to the exact Firebase project ID.");
  if (!raw) throw new Error("Set TERMINAL_OWNER_MIGRATION_JSON to the reviewed mapping array.");

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Migration input must be a non-empty JSON array.");
  }

  const entries = parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Entry ${index} is invalid.`);
    const value = item as Record<string, unknown>;
    if (typeof value.terminalId !== "string" ||
        !/^T-[A-Za-z0-9-]{8,40}$/.test(value.terminalId.trim()) ||
        typeof value.ownerUid !== "string" ||
        value.ownerUid.trim().length < 8 || value.ownerUid.trim().length > 128) {
      throw new Error(`Entry ${index} must contain a valid terminalId and ownerUid.`);
    }
    return { terminalId: value.terminalId.trim(), ownerUid: value.ownerUid.trim() };
  });

  const ids = entries.map(entry => entry.terminalId);
  const uids = entries.map(entry => entry.ownerUid);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate terminalId entries are not allowed.");
  if (new Set(uids).size !== uids.length) throw new Error("Duplicate ownerUid entries are not allowed.");

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const results: string[] = [];

  for (const entry of entries) {
    const terminalRef = db.doc(`terminals/${entry.terminalId}`);
    const ownerRef = db.doc(`terminalOwners/${entry.terminalId}`);
    const installationRef = db.doc(`terminalInstallations/${entry.ownerUid}`);

    const action = await db.runTransaction(async transaction => {
      const [terminal, owner, installation, ownerUidMappings] = await Promise.all([
        transaction.get(terminalRef),
        transaction.get(ownerRef),
        transaction.get(installationRef),
        transaction.get(db.collection("terminalOwners").where("ownerUid", "==", entry.ownerUid)),
      ]);
      if (!terminal.exists) throw new Error(`Terminal ${entry.terminalId} does not exist.`);
      const data = terminal.data()!;
      // Match the Firestore Rules predicate exactly: migration must not
      // grant a trusted installation to a terminal that the rules would reject.
      const role = data.role;
      const approvedRole =
        data.approved === true &&
        ((role === "management" || role === "both") && data.managementApproved === true ||
         (role === "reception" || role === "both") &&
           (data.receptionApproved === true ||
            (data.receptionApproved === undefined && data.approved === true)));
      if (!approvedRole) {
        throw new Error(
          `Terminal ${entry.terminalId} is not an approved terminal with a supported role.`,
        );
      }

      if (owner.exists) {
        const existingOwner = owner.data()!;
        if (existingOwner.terminalId !== entry.terminalId ||
            existingOwner.ownerUid !== entry.ownerUid || existingOwner.enabled !== true) {
          throw new Error(`Owner mapping for ${entry.terminalId} conflicts with the requested owner; refusing to overwrite it.`);
        }
      }

      const conflictingOwnerMapping = ownerUidMappings.docs.find(mapping => mapping.id !== entry.terminalId);
      if (conflictingOwnerMapping) {
        throw new Error(
          `Owner UID ${entry.ownerUid} is already mapped to terminal ${conflictingOwnerMapping.id}; refusing to reuse one UID across terminals.`,
        );
      }

      if (installation.exists) {
        const installed = installation.data()!;
        if (installed.authUid !== entry.ownerUid ||
            installed.terminalId !== entry.terminalId ||
            installed.approved !== true) {
          throw new Error(
            `Installation mapping for UID ${entry.ownerUid} conflicts with the requested terminal or is unapproved; refusing to overwrite it.`,
          );
        }
      }

      const createOwner = !owner.exists;
      const createInstallation = !installation.exists;
      if (dryRun) {
        return { createOwner, createInstallation, alreadyComplete: !createOwner && !createInstallation };
      }

      if (createOwner) {
        transaction.create(ownerRef, {
          terminalId: entry.terminalId,
          ownerUid: entry.ownerUid,
          enabled: true,
          migratedAt: new Date().toISOString(),
          migrationSource: "trusted-one-time-cli",
        });
      }
      if (createInstallation) {
        // Firestore Rules require this trusted mapping for management writes.
        transaction.create(installationRef, {
          terminalId: entry.terminalId,
          authUid: entry.ownerUid,
          approved: true,
          registrationApprovedAt: new Date().toISOString(),
          createdByTrustedMigration: true,
        });
      }
      return { createOwner, createInstallation, alreadyComplete: !createOwner && !createInstallation };
    });

    const prefix = dryRun ? "DRY RUN" : "OK";
    if (action.alreadyComplete) {
      results.push(`${prefix}: ${entry.terminalId} mappings already match; no changes needed.`);
    } else {
      const changes = [
        ...(action.createOwner ? ["owner mapping"] : []),
        ...(action.createInstallation ? ["installation mapping"] : []),
      ].join(" and ");
      results.push(`${prefix}: ${entry.terminalId} would create / created ${changes}.`);
    }
  }

  for (const result of results) process.stdout.write(result + "\n");
  process.stdout.write(dryRun
    ? "Dry run completed. No Firestore documents were changed. Review the project ID and UID mappings; set MIGRATION_APPLY=true only for an explicitly approved write run.\n"
    : "Migration completed. Review the audit output and test in a non-production environment before enabling production rules.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
