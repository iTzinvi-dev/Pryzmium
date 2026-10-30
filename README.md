<div align="center">
  <img src="public/icon.svg" alt="Pryzmium Logo" width="84" height="84" />

  # Pryzmium

  **Autonomous Multi-Model AI Agent Workspace with Human-in-the-Loop Governance**

  [![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
  [![React](https://img.shields.io/badge/React-19-149ECA?style=flat-square&logo=react&logoColor=white)](https://react.dev/)
  [![Express](https://img.shields.io/badge/Express-Server_Gateway-231F1D?style=flat-square&logo=express&logoColor=white)](https://expressjs.com/)
  [![Firebase](https://img.shields.io/badge/Firebase-Auth_%26_Firestore-D97757?style=flat-square&logo=firebase&logoColor=white)](https://firebase.google.com/)
  [![PWA](https://img.shields.io/badge/PWA-Ready-B84B30?style=flat-square)](public/manifest.json)
</div>

---

## Overview

**Pryzmium** is a full-stack autonomous AI workspace engineered for high-reliability reasoning, real-world tool execution, and strict security governance. Rather than locking workflows into a single LLM vendor or exposing raw credentials to the browser, Pryzmium routes tasks across **8 specialized AI inference gateways** and pairs tool execution with **cryptographic token storage**, **per-provider rate caps**, and **human-in-the-loop confirmation gates**.

---

## What Pryzmium Does (Core Capabilities)

### 1. Multi-Gateway Model Routing & Automated Failover
- **Unified Model Registry**: Seamlessly switch between flagship reasoning, coding, vision, and low-latency models across **Alpha**, **Beta**, **Gama**, and **Delta** inference gateways.
- **Live Provider Telemetry**: Real-time active/downtime status indicators inside the workspace model selector and modal.
- **Deterministic Failover**: Automatically reroutes requests to a high-availability fallback model when an upstream gateway returns `429`, `502`, `503`, or `504`.

### 2. Real-World Tool Execution & Workspace Connectors
Pryzmium executes live actions across external APIs and Google Workspace on your behalf:
- **Google Docs (`google_docs_create`)**: Creates structured documents directly in the user's Google Drive and returns verifiable document links.
- **Gmail (`gmail_send_draft`)**: Composes and dispatches emails or saves drafts via the Gmail REST API.
- **Google Calendar (`calendar_schedule`)**: Schedules events with ISO-8601 start/end times and attendee lists.
- **Google Tasks (`google_tasks_add`)**: Appends actionable task items to the user's primary task list.
- **Live Web Search (`web_search`)**: Queries live web indexes for up-to-date facts and citations.
- **Geospatial & Places (`maps_places`)**: Searches real-world locations, ratings, and addresses.
- **Persistent Workspace Memory (`memory_save`)**: Commits structured notes and research artifacts directly to the user's Firestore workspace.

### 3. Human-in-the-Loop Action Governance
- **Confirmation Gates**: High-impact external actions (such as sending emails or mutating calendar schedules) pause execution and render an interactive confirmation card (`ConfirmActionCard`) displaying the exact JSON payload before execution.
- **Verifiable Audit Trail**: Every tool invocation, parameter payload, latency measurement, and execution outcome (`success`, `blocked`, or `error`) is recorded in the user's private Audit Log.

### 4. Enterprise-Grade Quota & Rate-Cap Management
- **Per-Provider 24h Rate Caps**: Enforces fair-use daily limits per upstream provider (resetting automatically at `00:00 UTC`).
- **Visual Quota Telemetry**: Interactive progress bars in the Profile & Governance view with automated **90% threshold warnings** (`Near limit` / `Limit reached`) before a workflow is interrupted.
- **Sliding-Window Protection**: Server-side IP + UID rate limiting (`20 requests / 60s` burst window and daily caps) with structured `Retry-After` headers.

---

## What Pryzmium Does NOT Do (Explicit Boundaries)

To keep the workspace trustworthy, predictable, and compliant, Pryzmium enforces strict operational boundaries:

| Boundary | How Pryzmium Enforces It |
| :--- | :--- |
| **No Client-Side API Key Exposure** | All LLM gateway keys (`ALPHA_API_KEY`, `BETA_API_KEY`, `GAMA_API_KEY`, `DELTA_API_KEY`) live exclusively on the Express backend (`server.ts`). The browser never sees or stores provider secrets. |
| **No Unconsented External Mutations** | Sensitive write tools (`gmail_send_draft`, `calendar_schedule`) cannot execute silently when confirmation mode is enabled; the user must explicitly approve or reject the action. |
| **No Plaintext OAuth Token Storage** | Google OAuth access tokens are encrypted with **AES-256-GCM** (`src/lib/security/crypto.ts`) when stored in server memory and stripped before any client profile response. |
| **No Public API Abuse** | Unauthenticated requests to `/api/chat`, `/api/tools/*`, `/api/audit-logs`, and `/api/user/*` are rejected (`401 AUTH_REQUIRED`). Every protected endpoint verifies either an `HttpOnly` HMAC-SHA256 session cookie or a Firebase ID token. |
| **No SSRF or Internal Network Probing** | The server-side fetch guard (`safeExternalFetch`) blocks `localhost`, `127.0.0.1`, `169.254.169.254` (cloud metadata), private RFC1918 ranges, and non-HTTPS schemes. |
| **No Silent Tracking Before Consent** | First-time users must explicitly review and accept the mandatory Privacy, Cookie, and Workspace User Agreement gate before any session or workspace action is initialized. |
| **No Data Monetization** | Conversations, notes, and audit logs are never sold, shared with advertisers, or used to train third-party models. Users can wipe all records immediately via **Revoke & Delete My Data**. |

---

## System Architecture

```text
┌─────────────────────────────────────────────────────────────────────────┐
│                           Pryzmium Client (React 19)                    │
│  ┌──────────────────┐  ┌───────────────────┐  ┌──────────────────────┐  │
│  │  Agent Loop UI   │  │ Slide-Out Drawer  │  │  Governance, Audit   │  │
│  │  & Tool Cards    │  │  Navigation Menu  │  │  & Settings Modals   │  │
│  └────────┬─────────┘  └─────────┬─────────┘  └──────────┬───────────┘  │
└───────────┼──────────────────────┼───────────────────────┼──────────────┘
            │ Bearer ID Token /    │                       │
            │ HttpOnly Session     ▼                       ▼
┌───────────┴─────────────────────────────────────────────────────────────┐
│                       Pryzmium Security Gateway (Express)               │
│  • Firebase JWT & HMAC-SHA256 Cookie Verification                       │
│  • Per-IP / Per-UID Sliding Window & 24h Provider Rate Limiter          │
│  • AES-256-GCM OAuth Token Vault & SSRF Fetch Guard                     │
└───────────┬──────────────────────────────────────────────┬──────────────┘
            │                                              │
            ▼                                              ▼
┌──────────────────────────────────────┐    ┌─────────────────────────────┐
│      Multi-Gateway Inference         │    │   External Tool Endpoints   │
│  • Alpha Gateway   • Gama Gateway    │    │  • Google Docs / Gmail API  │
│  • Beta Gateway    • Delta Gateway   │    │  • Calendar / Tasks API     │
│                                      │    │  • Web Search & Places API  │
└──────────────────────────────────────┘    └─────────────────────────────┘
```

---

## Repository Structure

```text
.
├── public/
│   ├── favicon.svg                  # Adaptive light/dark vector favicon
│   ├── icon.svg                     # 512x512 PWA vector application icon
│   └── manifest.json                # Progressive Web App manifest
├── src/
│   ├── components/
│   │   ├── AuditLogView.tsx         # Verifiable tool execution history
│   │   ├── ChatErrorBanner.tsx      # Structured error recovery UI
│   │   ├── ConfirmActionCard.tsx    # Human-in-the-loop approval prompt
│   │   ├── ConnectionsView.tsx      # Google Workspace OAuth & tool status
│   │   ├── GovernanceView.tsx       # Profile, 24h rate caps, and data wipe
│   │   ├── LegalSecurityModal.tsx   # First-time compliance & policy modal
│   │   ├── ModelSelectorModal.tsx   # Multi-provider catalog & status dots
│   │   └── PryzmiumLogo.tsx         # Two-tone typographic brand wordmark
│   ├── lib/
│   │   ├── agent/loop.ts            # Multi-step tool-calling agent loop
│   │   ├── firebase/client.ts       # Firebase Auth, Firestore & Google OAuth
│   │   ├── models/registry.ts       # Multi-gateway model definitions
│   │   ├── network/chat-client.ts   # Resilient fetch client with timeout/abort
│   │   ├── security/
│   │   │   ├── auth-verify.ts       # Server-side Firebase JWT verifier
│   │   │   ├── crypto.ts            # AES-256-GCM encryption & CSRF utilities
│   │   │   ├── errors.ts            # Standardized error taxonomy (AppError)
│   │   │   └── ratelimit.ts         # Burst & 24h sliding-window rate limiter
│   │   └── tools/index.ts           # Tool schemas & client execution bridge
│   ├── types/agent.ts               # Core TypeScript interfaces
│   ├── App.tsx                      # Main workspace controller & layout
│   ├── index.css                    # Warm editorial & dark theme tokens
│   └── main.tsx                     # Application entry point
├── firestore.rules                  # Strict owner-only Firestore security rules
├── server.ts                        # Express backend proxy & security gateway
└── package.json
```

---

## Getting Started

### 1. Prerequisites
- **Node.js** `>= 20.x` (or **Bun** `>= 1.1`)
- A **Firebase project** with Authentication (Google + Email/Password) and Firestore enabled

### 2. Install Dependencies
```bash
npm install
```

### 3. Configure Environment Variables
Copy `.env.example` to `.env` and populate your private credentials:

```bash
cp .env.example .env
```

| Variable | Purpose |
| :--- | :--- |
| `FIREBASE_PROJECT_ID` | Server-side Firebase project identifier |
| `FIRESTORE_DATABASE_ID` | Server-side Firestore database identifier |
| `TOKEN_ENCRYPTION_KEY` | 64-character hex secret used for AES-256-GCM token encryption and HMAC signing |
| `ALPHA_API_KEY` | Upstream inference key for Alpha gateway pool |
| `BETA_API_KEY` | Upstream inference key for Beta gateway pool |
| `GAMA_API_KEY` | Upstream inference key for Gama gateway pool |
| `DELTA_API_KEY` | Upstream inference key for Delta gateway pool |
| `AI_GLOBAL_KILL_SWITCH` | Emergency switch (`true`/`false`) to halt all model invocations |

### 4. Start the Development Server
```bash
npm run dev
```
The full-stack Express + Vite server will start on `http://localhost:3000`.

### 5. Production Build & Verification
```bash
npm run lint
npm run build
npm start
```

---

## Security & Privacy Summary

- **Session Lifetime**: `HttpOnly`, `SameSite=None`, `Secure` session cookies expire after **7 days** or immediately on sign-out.
- **Usage Counter Reset**: Per-provider rate counters reset automatically every 24 hours at **00:00 UTC**.
- **Data Retention**: Active chats, workspace notes, and audit logs are retained for up to **90 days** of inactivity, or deleted **immediately (0 days)** when the user triggers **Clear All Conversations** or **Revoke & Delete My Data**.
