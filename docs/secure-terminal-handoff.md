# Secure terminal handoff

## Goal

Allow Safari and the iOS Home Screen web app to request the use of an existing terminal identity without allowing a public terminal ID alone to impersonate that terminal.

## Server-side phase 1 added on `secure-terminal-handoff`

The `functions/` package now defines authenticated callable endpoints:

- `requestTerminalHandoff`: creates a five-minute pending request and enforces a short per-user cooldown.
- `listTerminalHandoffRequests`: lists pending requests only after verifying the caller against a trusted terminal-owner mapping.
- `decideTerminalHandoff`: binds approval/rejection to a pending, unexpired request and checks the caller's ownership server-side.
- `completeTerminalHandoff`: allows the requesting Firebase Auth UID to consume an approval once and creates the installation record using the Admin SDK.

Ownership is intentionally stored separately in `terminalOwners/{terminalId}`. That collection must be populated through a trusted admin migration and must never be writable by client apps.

## Not yet production-ready

This is a backend foundation, not a complete live feature. The UI now has a first integration with Firebase Authentication and the callable endpoints. However, existing terminals have not been migrated to trusted owner mappings, the reception app still needs to enforce `terminalInstallations/{uid}` before granting access, and Firebase deployment/configuration and emulator tests remain outstanding. Do not deploy or enable this flow until all of the following are completed:

1. Set up Firebase Authentication in both apps and persist an authenticated UID per browser installation.
2. Populate `terminalOwners/{terminalId}` through a trusted administrator-controlled migration. Each document must contain `ownerUid` and `enabled: true`.
3. Add and emulator-test Firestore Security Rules preventing clients from writing owner mappings, handoff requests, rate-limit records, installation records, and terminal approval/ownership fields. Preserve the current event/ticket/reception data paths.
4. Integrate the callables into the reception and management UI. Reception must verify the server-created installation record before granting access.
5. Add an authenticated revoke flow for transferred installations.
6. Run Emulator Suite tests for unauthenticated calls, wrong-owner approval, request replay, expiry, rate limiting, and direct Firestore writes.

## Acceptance tests

- Entering a terminal ID alone never grants reception access.
- A request appears only for the matching registered terminal.
- Only the trusted owner can approve or reject.
- Rejecting or expiring a request leaves existing registration unchanged.
- Approval is one-time and cannot be replayed.
- A client cannot directly set `approved`, `managementApproved`, `receptionApproved`, or owner mappings.
- A new installation cannot modify the original installation's credentials.
- Existing event/ticket/reception synchronization continues to work.
- Safari and the Home Screen app on the same iPad can complete the explicit approval flow.


## Trusted owner migration (manual, create-only)

1. Open the already-approved management terminal in the exact browser/Home Screen installation that should retain ownership.
2. In **端末管理 → 端末引き継ぎ申請**, click **申請を確認** once. This also initializes its anonymous Firebase Auth identity and shows **この管理アプリの認証ID**. Copy that UID. Do not use a UID from a different browser storage context.
3. From a trusted administrator workstation, authenticate Application Default Credentials for the intended Firebase project. Never put service-account credentials or owner mappings in the browser app or commit them to Git.
4. Build and run the create-only migration utility with a reviewed mapping. Example (replace values with the real project ID, terminal ID, and copied UID):

```sh
gcloud auth application-default login
npm --prefix functions install
npm --prefix functions run build:migration
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" TERMINAL_OWNER_MIGRATION_JSON='[{"terminalId":"T-REPLACE","ownerUid":"UID-REPLACE"}]' node functions/lib-migration/scripts/migrate-terminal-owners.js
```

The tool refuses missing/unapproved management terminals, duplicate IDs, and any owner mapping that already exists. It does not overwrite mappings. Run one reviewed mapping at a time and keep the CLI output for audit. If an owner mapping already exists, stop and investigate instead of deleting or replacing it.

This utility only seeds the trusted owner map; it does not deploy Functions or make the overall handoff feature production-ready. Do not enable live handoffs until Firestore rules are explicitly reviewed and tested, callable Functions are deployed, and reception access is changed to require the server-created installation record.
