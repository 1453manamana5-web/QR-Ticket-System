# Secure terminal handoff

## Goal

Allow a browser/PWA installation to request the use of an already registered terminal identity when Safari and the iOS Home Screen web app have separate storage, without allowing a terminal ID alone to impersonate that terminal.

## Required flow

1. The new browser context enters the public terminal ID.
2. It creates a pending handoff request; it receives no reception privileges and must not overwrite the terminal record.
3. The existing registered context displays the request and explicitly approves or rejects it.
4. Approval is bound to the specific pending request, expires, and can be consumed once.
5. The new context receives a separate installation credential after approval. A public terminal ID is an identifier, not a credential.
6. The server validates the approval and binds the new installation to the terminal. Clients must not be able to set their own approved status or approve their own request.
7. The existing context can revoke the new installation. Audit timestamps and request state are retained.

## Security blocker in the current repository

Both apps currently use the Firebase Web SDK directly and do not initialize Firebase Authentication. Terminal approval is represented by fields in the `terminals/{terminalId}` document. The repository has no checked-in Firestore Security Rules or Cloud Functions deployment configuration. The management client checks its own terminal record before approving, but a client-side check is not an authorization boundary.

Therefore, adding only a request document or an approval button would not securely implement this feature. Before enabling the flow, add server-enforced authorization (Firebase Authentication plus restrictive Firestore Rules and/or trusted Cloud Functions), migrate existing management terminals to an authenticated owner identity, and verify that clients cannot write approval fields directly.

## Acceptance tests

- Entering a terminal ID alone never grants reception access.
- A request appears only for the matching registered terminal.
- Rejecting or letting a request expire leaves both registrations unchanged.
- Approval is one-time and cannot be replayed.
- A different client cannot directly set `approved`, `managementApproved`, or `receptionApproved`.
- A new installation cannot modify the original installation's credentials.
- Existing event/ticket/reception synchronization continues to work.
- Safari and the Home Screen app on the same iPad can complete the explicit approval flow.
