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

This is a backend foundation, not a complete live feature. The web apps have not yet been integrated with Firebase Authentication or the callable endpoints, and the receiving app does not yet check `terminalInstallations/{uid}` before enabling reception. Existing terminals also have not been migrated to trusted owner mappings. Do not deploy or enable this flow until all of the following are completed:

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
