# Terminal handoff backend (phase 1)

This package contains authenticated callable functions for the server-side part of terminal handoff:

- `requestTerminalHandoff`: creates a five-minute pending request and applies a per-user cooldown.
- `listTerminalHandoffRequests`: only the authenticated owner of the target terminal can list pending requests.
- `decideTerminalHandoff`: only that owner can approve/reject a pending, unexpired request.
- `completeTerminalHandoff`: the requesting Firebase Auth UID can consume its approval once; the server creates the installation record.

## Important: not enabled for production yet

The web apps have not yet been integrated with Firebase Authentication or these callables. Do not deploy or expose the handoff UI until all prerequisites below are complete.

1. Set up Firebase Authentication for both apps and persist a stable authenticated UID per browser installation.
2. Populate `terminalOwners/{terminalId}` using a trusted, administrator-controlled migration. Each document must contain `ownerUid` and `enabled: true`. Never let a web client write this collection.
3. Add and test Firestore Security Rules that prevent clients from writing `terminalOwners`, `terminalHandoffRequests`, `terminalHandoffRateLimits`, `terminalInstallations`, and terminal approval/ownership fields. Keep rules compatible with existing event/ticket/reception workflows.
4. Integrate the callable functions into the reception and management apps. The reception app must verify the server-created installation record before granting reception access; a response from the client UI alone is not proof of approval.
5. Add expiry cleanup and a management-side revoke flow for `terminalInstallations`.
6. Run Emulator Suite tests for unauthenticated calls, wrong-owner approval, request replay, expiry, rate limiting, and direct Firestore writes before deploying.

The public terminal ID is an identifier only, not a secret or a login credential. A terminal ID by itself must never grant access.
