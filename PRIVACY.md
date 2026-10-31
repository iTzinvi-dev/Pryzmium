# Privacy Policy, Terms of Service & Cookie Policy (`PRIVACY.md`)

**Effective Date:** October 27, 2026

## 1. Mandatory User Consent & Age Eligibility (COPPA / GDPR-K)

Before creating an account, signing in, or executing any AI agent workflow in Pryzmium, users must explicitly confirm that they are at least **13 years of age** (and at least **18 years of age** or acting with verifiable parent/legal guardian consent) and accept this Privacy Policy, Terms of Service, Safety Guardrails, and Essential Cookie Policy. Pryzmium does not knowingly collect or process personal information from children under 13; any account identified as belonging to a child under 13 is immediately purged.

---

## 2. Data Minimization & Workspace Privacy

1. **No Permanent Storage of Raw Emails or Documents**:
   - When you authorize Google Workspace connectors (`Gmail`, `Calendar`, `Drive`, `Docs`, `Tasks`), Vektor Agent fetches only the minimum fields required to answer your prompt.
   - Raw email bodies and document contents are sanitized and truncated to a maximum of `2,200` characters in transient server memory and are **never** permanently stored in Firestore.
2. **Metadata-Only Audit Logs**:
   - Your `/users/{uid}/auditLog` collection stores only tool names, risk levels (`read`, `write`, `destructive`), execution duration in milliseconds, and non-PII status summaries.
3. **Minimum OAuth Scopes**:
   - We request only narrow, task-specific Google OAuth scopes:
     - `gmail.readonly` and `gmail.compose`
     - `calendar.events`
     - `drive.readonly`
     - `documents`
     - `tasks`

---

## 3. Cookie & Local Storage Policy

1. **Strictly Necessary Session Storage Only**:
   - We use strictly necessary authentication state (`IndexedDB` / `localStorage` for Firebase Auth and encrypted session tokens, plus `HttpOnly; SameSite=Strict` server session cookies where applicable) and theme/consent preferences (`vektor_legal_accepted_v2`, `data-theme`).
2. **Zero Tracking or Advertising Cookies**:
   - Vektor Agent Workspace does **not** use third-party tracking cookies, cross-site pixels, behavioral profiling, or ad-network scripts.

---

## 4. User Control, Revocation & Right to Erasure ("Delete My Data")

1. **Instant OAuth Revocation**:
   - You can disconnect Google Workspace at any time from the **Connections** tab, which immediately revokes the OAuth token via `https://oauth2.googleapis.com/revoke` and clears in-memory credentials.
2. **One-Click Complete Data Purge**:
   - In the **Governance** tab, clicking **Delete My Data** permanently deletes all of your chat sessions, messages, pending confirmation cards, and audit logs from Firestore and revokes active OAuth tokens.
