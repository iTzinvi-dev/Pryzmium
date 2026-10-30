# Security Policy & Architecture Guardrails (`SECURITY.md`)

## 1. Executive Summary

Vektor Agent Workspace is architected under a **Zero-Trust, Least-Privilege, Human-in-the-Loop** security model. Every external API response, email body, calendar description, document paragraph, and webpage excerpt is treated as untrusted data, and every state-mutating tool call is cryptographically gated on the server before execution.

---

## 2. Authentication, Registration & Session Security

1. **Dual Authentication Support**:
   - **Google OAuth 2.0 (`signInWithPopup`)**: Decouples basic identity sign-in (`email`, `profile`) from sensitive Google Workspace OAuth scopes (`gmail.readonly`, `gmail.compose`, `calendar.events`, `drive.readonly`, `documents`, `tasks`) so users can sign in reliably and grant Workspace permissions on demand.
   - **Email & Password Authentication**: Supports native Firebase Email/Password authentication with an automatic server-side `scrypt` (`N=16384, r=8, p=1`, 64-byte key + 16-byte random salt) + HMAC-SHA256 session fallback so user registration and login succeed reliably even if the Firebase Console password provider has not yet been toggled.
2. **Server-Side Token Verification (`src/lib/security/auth-verify.ts`)**:
   - All mutating API routes (`/api/chat`, `/api/actions/confirm`, `/api/connections/encrypt-token`, `/api/workspace/*`) require a valid `X-Firebase-Id-Token` header.
   - The server verifies token expiration (`exp`), audience/issuer project binding, and strict UID ownership (`sub === uid`) to prevent horizontal privilege escalation and UID spoofing.
3. **Cookie & Session Policy**:
   - Session cookies set by the server use `HttpOnly; SameSite=Strict; Path=/` attributes.
   - Zero third-party advertising, behavioral tracking, or cross-site analytics cookies are used.

---

## 3. Token Encryption Vault (`AES-256-GCM`)

- OAuth refresh tokens and sensitive connector credentials are encrypted on the server (`src/lib/security/crypto.ts`) using **AES-256-GCM** with a unique 96-bit random IV (`crypto.randomBytes(12)`) and 128-bit authentication tag per encryption operation.
- In Firestore (`firestore.rules`), `/users/{userId}/connections/{providerId}` enforces `allow read, write: if false;` for all browser clients.

---

## 4. Prompt Injection & Untrusted Data Isolation

1. **Untrusted Data Envelope**:
   - Every tool output returned to the LLM is wrapped inside `<untrusted_tool_data tool="...">...</untrusted_tool_data>`.
   - System instructions strictly mandate that content inside `<untrusted_tool_data>` is passive data and must never be interpreted as instructions or role overrides.
2. **HTML & Script Stripping**:
   - Email bodies, Google Docs paragraphs, and fetched web pages are stripped of `<script>`, `<style>`, and HTML tags and truncated to `2,200` characters before entering model context.
3. **Bulk Read Cap**:
   - `gmail_search` is capped at a maximum of `20` messages per call via Zod schema enforcement.
4. **Exfiltration Combo Warning**:
   - If the agent reads sensitive workspace data (`gmail_search`, `gmail_read_message`, `drive_search_files`, `docs_read_document`) and subsequently proposes an external write/destructive action in the same turn, the confirmation card displays a high-visibility exfiltration warning.

---

## 5. Server-Enforced Confirmation Gate (`pendingActions`)

- **Risk Classification**:
  - `read`: Executes automatically within the bounded 8-step loop (`gmail_search`, `calendar_list_events`, `google_search_grounding`, `google_maps_grounding`, `notes_list`, etc.).
  - `write`: Pauses the agent loop and creates a `pendingAction` (`gmail_create_draft`, `calendar_create_event`, `docs_create_document`, `tasks_create_item`, `notes_create`).
  - `destructive`: Pauses the agent loop with a critical warning (`gmail_send_email`, `notes_delete`).
- **Cryptographic Integrity**:
  - The server canonicalizes the proposed tool arguments, computes a **SHA-256 `argsHash`**, and signs `uid:actionId:toolName:argsHash:expiresAtMs` using **HMAC-SHA256** (`serverSignature`).
  - Every confirmation card expires after **10 minutes (`600,000 ms`)** and is strictly **single-use** (enforced via server nonce tracking and Firestore terminal state locking).

---

## 6. SSRF & Network Egress Protection

- The `web_fetch_summary` tool enforces:
  - Protocol must be `https:` on standard port `443`.
  - Blocks `localhost`, `.local`, `.internal`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254` (cloud metadata), `metadata.google.internal`, and `[::1]`.
  - Disables HTTP redirects (`redirect: 'error'`) and enforces an 8-second `AbortController` timeout.

---

## 7. Rolling 24-Hour Rate Limits & Cost Protection

- **Burst Protection**: Maximum `12 requests / minute` per user.
- **Rolling 24-Hour Provider Pools**:
  - **Gama Gateway Pool**: `25 requests / 24h` pool.
  - **Delta Gateway Pool**: `15 requests / 24h` pool.
  - **Beta Gateway Pool**: `10 requests / 24h` pool.
  - **Alpha Gateway Pool**: `6 requests / 24h` pool.
- **Global Kill Switch**: Setting `AI_GLOBAL_KILL_SWITCH=true` immediately halts all model invocations across the server.
