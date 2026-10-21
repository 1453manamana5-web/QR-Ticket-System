# Terminal authorization and handoff backend

This package provides authenticated callable Functions and trusted migration utilities for terminal approval and reception writes.

## Server-side operations

- `registerTerminalApplication`: creates a pending terminal application without accepting client-supplied approval flags.
- `approveTerminalRegistration`: checks the caller's trusted management-owner mapping, approves the requested role, and writes server-owned owner/installation mappings.
- `requestTerminalHandoff`, `listTerminalHandoffRequests`, `decideTerminalHandoff`, and `completeTerminalHandoff`: implement expiring, one-time handoff requests with owner checks and rate limiting.
- `getTerminalInstallationStatus`: verifies the server-issued installation mapping and the terminal's current reception approval.
- `updateTerminalHeartbeat`: validates the authenticated installation before updating operational status fields.
- `recordReception`: validates the server-issued installation binding, enabled trusted owner mapping, current reception approval, event/ticket identity, ticket validity, and entry/exit/re-entry state before atomically saving a reception record and ticket status. A handed-off installation may have a different Auth UID from the original owner, but only if the server has explicitly bound that UID to the same terminal.
- `revokeTerminalReception`, `releaseOwnReceptionRegistration`, and `deleteManagedTerminal`: perform protected registration changes on the server.
- `scripts/bootstrap-first-admin.ts`: one-time bootstrap for a genuinely new project; refuses to overwrite existing records.
- `scripts/migrate-terminal-owners.ts`: trusted migration for existing approved management terminals, with dry-run and conflict checks.

## Validation

GitHub Actions runs Firestore Rules tests, web app typechecks/builds, and Functions typecheck/build. A successful CI run verifies those automated checks only; it does not test against the user's live Firebase project or deploy any rules/Functions.

## Existing terminal migration

Only run migration from a trusted administrator workstation with Application Default Credentials for the exact intended Firebase project. Verify each terminal ID and owner UID independently. Never place service-account credentials or owner mappings in browser code, repository files, or chat.

Build the migration utility:

```sh
npm --prefix functions install
npm --prefix functions run build:migration
```

First run a no-write validation:

```sh
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" MIGRATION_DRY_RUN=true TERMINAL_OWNER_MIGRATION_JSON='[{"terminalId":"T-REPLACE","ownerUid":"UID-REPLACE"}]' node functions/lib-migration/scripts/migrate-terminal-owners.js
```

Review the project ID, terminal ID, UID, and output. Only after independent verification, run without `MIGRATION_DRY_RUN=true` to create missing mappings. The script refuses unapproved management terminals, duplicate terminal IDs/UIDs, and conflicting or disabled mappings. Matching mappings are treated as already complete and are not overwritten.

## Production blocker

Do not deploy or merge this branch as production-ready until the existing Firebase project and its live rules have been reviewed, the migration has been tested in a non-production Firebase project, and end-to-end checks have verified management approval, reception approval, heartbeat updates, entry/exit/re-entry, revocation, and reception writes from a handed-off installation whose Auth UID differs from the original owner. Current CI is not a substitute for those checks. Keep the pull request in draft and do not deploy rules or Functions from this workflow.


## Terminal registration reset (guarded, default dry run)

This utility resets old and new terminal-registration records while preserving one independently verified primary administrator terminal. It deliberately does not target events, tickets, published event bundles, reception records, analysis, members, or event settings.

Do not run an apply reset until the strict Firestore Rules and callable Functions have been deployed and verified, a backup is available, and the preserved primary admin has a valid owner mapping and installation mapping. The script requires both the terminal ID and the owner UID to preserve for an apply run.

Build the migration utilities:

```sh
npm --prefix functions install
npm --prefix functions run build:migration
```

Preview the reset (no writes):

```sh
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \
RESET_KEEP_TERMINAL_ID="T-REPLACE" \
RESET_KEEP_OWNER_UID="UID-REPLACE" \
npm --prefix functions run reset:terminals
```

The default is read-only. Review every collection count and confirm the project ID. Only after backup, rules/Functions verification, and independent verification of the preserved administrator should the reset be applied:

```sh
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \
RESET_APPLY=true \
RESET_KEEP_TERMINAL_ID="T-REPLACE" \
RESET_KEEP_OWNER_UID="UID-REPLACE" \
npm --prefix functions run reset:terminals
```

The apply mode refuses to run unless the preserved terminal is approved, has the primary `admin: true` role, and its `terminalOwners` and `terminalInstallations` mappings agree. It removes other terminal records, old app device settings, registration applications, handoff requests, and rate limits. Keep the terminal ID and UID private; never commit real values or credentials to Git.
