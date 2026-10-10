import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Trusted migration for existing approved management terminals.
 *
 * Required environment:
 *   GCLOUD_PROJECT=<exact Firebase project ID>
 *   TERMINAL_OWNER_MIGRATION_JSON=[{"terminalId":"T-...","ownerUid":"..."}]
 * Optional:
 *   MIGRATION_DRY_RUN=true   validates mappings and prints the changes without writing.
 *
 * The owner UID must be independently verified from the intended management
 * installation. Never accept this mapping from a browser or user-supplied form.
 */
async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const raw = process.env.TERMINAL_OWNER_MIGRATION_JSON;
  const dryRun = process.env.MIGRATION_DRY_RUN === "true";

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
      const [terminal, owner, installation] = await Promise.all([
        transaction.get(terminalRef),
        transaction.get(ownerRef),
        transaction.get(installationRef),
      ]);
      if (!terminal.exists) throw new Error(`Terminal ${entry.terminalId} does not exist.`);
      const data = terminal.data()!;
      const approvedManagement = data.managementApproved === true || data.admin === true ||
        (data.approved === true && (data.role === "management" || data.role === "both"));
      if (!approvedManagement) {
        throw new Error(`Terminal ${entry.terminalId} is not an approved management terminal.`);
      }

      if (owner.exists) {
        const existingOwner = owner.data()!;
        if (existingOwner.terminalId !== entry.terminalId ||
            existingOwner.ownerUid !== entry.ownerUid || existingOwner.enabled !== true) {
          throw new Error(`Owner mapping for ${entry.terminalId} conflicts with the requested owner; refusing to overwrite it.`);
        }
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
    ? "Dry run completed. No Firestore documents were changed. Review the project ID and UID mappings before a write run.\n"
    : "Migration completed. Review the audit output and test in a non-production environment before enabling production rules.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
