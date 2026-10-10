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

The tool refuses missing/unapproved management terminals, duplicate IDs, and any owner mapping that already exists. In the same transaction it also creates the trusted `terminalInstallations/{ownerUid}` mapping needed by the current management-only Firestore Rules. If that UID already has an installation mapping, the tool proceeds only when it already points to this exact terminal and is approved; mismatched or unapproved mappings are never overwritten. Run one reviewed mapping at a time and keep the CLI output for audit. If an owner mapping already exists, stop and investigate instead of deleting or replacing it.

This utility only seeds the trusted owner map; it does not deploy Functions or make the overall handoff feature production-ready. Do not enable live handoffs until Firestore rules are explicitly reviewed and tested, callable Functions are deployed, and reception access is changed to require the server-created installation record.

## Existing Firestore rules discovered during implementation

The currently reported live rules use a single catch-all match:

```
match /{document=**} {
  allow read, write: if request.time < timestamp.date(2026, 11, 4);
}
```

This means clients can currently read and write every Firestore path until the expiry date, including `terminalOwners`, `terminalInstallations`, handoff request documents, and terminal approval fields. Adding a second restrictive `match` block would **not** fix this: Firestore combines matching `allow` expressions with logical OR, so the catch-all grant would still permit access.

Do not deploy the handoff flow while this catch-all rule remains. A safe migration must replace the catch-all with path-specific rules and update all existing terminal writers so they no longer write approval/ownership fields from client code. The broad rule must not simply be deleted before those paths are mapped and emulator-tested, because that would break existing event, ticket, analysis, settings, member, device, and reception synchronization.

The latest client review also found that the reception registration snapshot listener previously bypassed the server installation-status check used by the initial read. The listener now performs the same check when the local handoff marker is present, to avoid inconsistent UI behavior. This marker is client-controlled and is **not** an authorization boundary; only server-side rules and trusted callable functions can enforce ownership.



## Trusted first-admin bootstrap

For a brand-new Firebase project with no existing approved management terminal, use the one-time bootstrap utility from a trusted administrator workstation. Do not add a browser-side "first admin wins" exception to Firestore Rules.

1. Open the management app in the exact browser/Home Screen installation that will be the permanent first admin. Trigger the app's Firebase installation-auth initialization and copy the displayed authenticated UID. Do not share or commit the UID publicly.
2. Authenticate Google Application Default Credentials for the intended Firebase project.
3. Build the migration scripts and set the exact project, terminal ID generated for that installation, UID, and an optional terminal name:

```sh
gcloud auth application-default login
npm --prefix functions install
npm --prefix functions run build:migration
GCLOUD_PROJECT="YOUR_FIREBASE_PROJECT_ID" \
BOOTSTRAP_TERMINAL_ID="T-REPLACE_WITH_REAL_ID" \
BOOTSTRAP_OWNER_UID="REPLACE_WITH_AUTH_UID" \
BOOTSTRAP_TERMINAL_NAME="管理端末" \
node functions/lib-migration/scripts/bootstrap-first-admin.js
```

The command creates both `terminals/{terminalId}` and `terminalOwners/{terminalId}` in one transaction, only when neither document exists. It refuses to overwrite existing documents. If either document already exists, stop and review the current state; do not delete or recreate it just to bypass the guard.

This bootstrap utility is a trusted server-side administrative operation. It has not been run against production data from this repository session.

## Compatibility audit (2026-10-10, rechecked)

The latest source review confirms these client paths now use trusted callable Functions rather than writing protected terminal or reception fields directly:

- New terminal applications use `registerTerminalApplication`; the browser cannot set approval flags.
- Approval uses `approveTerminalRegistration`, which creates the trusted owner mapping and server-issued installation mapping for the approved UID.
- Reception heartbeat uses `updateTerminalHeartbeat`; the callable verifies the authenticated UID against a trusted owner or installation mapping.
- Management heartbeat uses the same callable path.
- Reception records use `recordReception`, which validates the installation, terminal role/approval, event, ticket, and ticket-state transition before writing with the Admin SDK.
- Own-terminal reception release, manager revoke, and managed-terminal deletion use server callables with server-side ownership/role checks.

The latest CI runs for commits `0ecd50b6`, `2d0086ee`, `2a70c565`, and `5fd7b275` completed successfully. This confirms the configured automated rules tests, typechecks, and builds; it does not prove that production Firebase has been migrated or deployed.

Remaining deployment blockers:

1. **Existing terminal migration:** older terminals may not have `terminalOwners/{terminalId}` or `terminalInstallations/{uid}`. Those mappings must be created using the reviewed trusted migration process. Do not delete or overwrite existing mappings to force migration.
2. **First administrator:** the trusted bootstrap script is for a genuinely new project only and refuses to overwrite existing documents. For an existing project, inspect the existing terminal/owner records and use a reviewed migration instead.
3. **Production rules and Functions:** this branch's rules and callable Functions have not been deployed from this work session. The reported live catch-all rule must be replaced, not supplemented with restrictive matches, because Firestore combines matching allows with OR.
4. **Read permissions:** current proposed rules permit any authenticated client, including anonymous Auth users, to read event, ticket, analysis, member, settings, device, and terminal data. Writes are more restricted, but read access still needs a deliberate privacy review before production.
5. **Legacy helper review:** `saveTerminal` and `deleteTerminal` remain in the management data module as legacy helpers. The reviewed App.tsx flow does not import them, but confirm there are no other callers before deploying rules that deny direct terminal writes.
6. **End-to-end verification:** CI does not exercise a real Firebase project. After a reviewed migration in a non-production test project, verify management approval, reception approval, heartbeat updates, ticket entry/exit/re-entry, and revocation against deployed callable Functions and Firestore Rules.

Do not deploy the rules or Functions until the existing terminal mappings and live Firebase configuration have been reviewed.