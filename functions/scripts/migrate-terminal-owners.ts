import { applicationDefault, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Trusted, create-only migration. Run only from an administrator workstation
 * with Application Default Credentials for the intended Firebase project.
 *
 * TERMINAL_OWNER_MIGRATION_JSON must be a JSON array:
 * [{"terminalId":"...","ownerUid":"..."}]
 *
 * The UID must be copied from the signed-in management app installation that
 * is intended to remain the owner. Never accept this mapping from an untrusted
 * browser or allow the browser to write terminalOwners directly.
 */
async function main() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  const raw = process.env.TERMINAL_OWNER_MIGRATION_JSON;
  if (!projectId) throw new Error("Set GCLOUD_PROJECT to the exact Firebase project ID.");
  if (!raw) throw new Error("Set TERMINAL_OWNER_MIGRATION_JSON to the reviewed mapping array.");

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Migration input must be a non-empty JSON array.");
  }

  const entries = parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Entry ${index} is invalid.`);
    const value = item as Record<string, unknown>;
    if (typeof value.terminalId !== "string" || value.terminalId.trim().length < 8 ||
        typeof value.ownerUid !== "string" || value.ownerUid.trim().length < 8) {
      throw new Error(`Entry ${index} must contain terminalId and ownerUid strings.`);
    }
    return { terminalId: value.terminalId.trim(), ownerUid: value.ownerUid.trim() };
  });

  const ids = entries.map(entry => entry.terminalId);
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate terminalId entries are not allowed.");

  initializeApp({ credential: applicationDefault(), projectId });
  const db = getFirestore();
  const results: string[] = [];

  for (const entry of entries) {
    const terminalRef = db.doc(`terminals/${entry.terminalId}`);
    const ownerRef = db.doc(`terminalOwners/${entry.terminalId}`);
    const installationRef = db.doc(`terminalInstallations/${entry.ownerUid}`);

    await db.runTransaction(async transaction => {
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
        throw new Error(`Owner mapping for ${entry.terminalId} already exists; refusing to overwrite it.`);
      }
      if (installation.exists) {
        const installed = installation.data()!;
        if (installed.authUid !== entry.ownerUid ||
            installed.terminalId !== entry.terminalId ||
            installed.approved !== true) {
          throw new Error(
            `Installation mapping for UID ${entry.ownerUid} already exists with a different or unapproved terminal; refusing to overwrite it.`,
          );
        }
      }
      transaction.create(ownerRef, {
        terminalId: entry.terminalId,
        ownerUid: entry.ownerUid,
        enabled: true,
        migratedAt: new Date().toISOString(),
        migrationSource: "trusted-one-time-cli",
      });
      if (!installation.exists) {
        // The same trusted mapping is required by Firestore Rules to permit
        // approved management clients to write event/ticket/settings data.
        transaction.create(installationRef, {
          terminalId: entry.terminalId,
          authUid: entry.ownerUid,
          approved: true,
          registrationApprovedAt: new Date().toISOString(),
          createdByTrustedMigration: true,
        });
      }
    });
    results.push(`Created owner mapping for terminal ${entry.terminalId}.`);
  }

  for (const result of results) process.stdout.write(result + "\n");
  process.stdout.write("Migration completed. Review the output and test the owner flow before enabling production use.\n");
}

main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
  process.exitCode = 1;
});
