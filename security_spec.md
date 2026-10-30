# Security Specification — Vektor Agent Workspace

## 1. Data Invariants

1. **Master Gate & Relational Ownership**: Every subcollection under `/users/{userId}` (`chats`, `messages`, `pendingActions`, `auditLog`) requires that the parent `/users/{userId}` document exists (`exists(/databases/$(database)/documents/users/$(userId))`) and that `request.auth.uid == userId` with `(request.auth.token.email_verified == true || request.auth.token.firebase.sign_in_provider == 'password')`.
2. **Complete Client Isolation for Connections Vault**: `/users/{userId}/connections/{providerId}` is strictly denied (`allow read, write: if false;`) to all client requests.
3. **Strict Schema & Volumetric Bounds**: All string fields enforce explicit `.size()` bounds matching `firebase-blueprint.json`. Document IDs must match `^[a-zA-Z0-9_\-]+$` with length `<= 128`.
4. **Temporal Integrity**: All `createdAt` and `updatedAt` fields must equal `request.time`.
5. **Terminal State Locking on Pending Actions**: Once a `PendingAction` transitions from `'pending'` to a terminal state (`'executed'`, `'rejected'`, or `'expired'`), no further updates are permitted.
6. **Immutable Audit Logs**: `AuditLogEntry` documents cannot be updated after creation; they can only be created or deleted when the user purges their data.
7. **Server-Side Token & Nonce Verification**: Every `/api/*` mutation verifies `X-Firebase-Id-Token` (matching `uid`) and enforces single-use nonces, SHA-256 `argsHash`, HMAC signatures, SSRF blocklists, and rolling 24h per-model rate limits.

## 2. The "Dirty Dozen" Payloads

1. **Identity Spoofing on UserProfile**: Authenticated user `uid_A` attempts to create `/users/uid_A` with `{ uid: "uid_B" }`. -> `PERMISSION_DENIED`
2. **Unverified Spoofed OAuth Email Write**: OAuth user with `email_verified: false` attempts to create `/users/uid_A`. -> `PERMISSION_DENIED`
3. **Shadow Field Injection**: Client sends `{ ..., isAdmin: true }` to `/users/uid_A`. -> `PERMISSION_DENIED`
4. **Privilege Escalation on Plan**: User attempts to create `/users/uid_A` with `plan: "enterprise"`. -> `PERMISSION_DENIED`
5. **Connections Vault Read/Write**: Owner `uid_A` attempts `get` or `create` on `/users/uid_A/connections/gmail`. -> `PERMISSION_DENIED`
6. **Orphaned Chat Creation**: User `uid_A` attempts to create `/users/uid_A/chats/chat_1` before `/users/uid_A` exists. -> `PERMISSION_DENIED`
7. **Cross-User Chat Scraping (`list`)**: User `uid_B` queries `/users/uid_A/chats`. -> `PERMISSION_DENIED`
8. **Forged Client Timestamp**: Client sends a past or future timestamp instead of `request.time` for `createdAt`. -> `PERMISSION_DENIED`
9. **Denial-of-Wallet String Overflow**: Client sends a 25,000-character `content` string to `messages`. -> `PERMISSION_DENIED`
10. **Pending Action Terminal State Re-Opening**: User attempts to update a `PendingAction` whose `existing().status == 'executed'` back to `'pending'`. -> `PERMISSION_DENIED`
11. **Pending Action Hash Mutation**: User attempts to modify `argsHash` or `serverSignature` during an update on `pendingActions`. -> `PERMISSION_DENIED`
12. **Audit Log Tampering**: User attempts to `update` an existing `auditLog` entry to hide a tool execution. -> `PERMISSION_DENIED`
