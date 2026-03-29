# ServiceSurfer Simple — Consumer Frontend

> Instant local-service matching: describe a problem, get a ranked list of available pros, and connect in one tap.

`simple-ss` is the lightweight, serverless consumer frontend for the ServiceSurfer platform. It handles **Flow 1** (consumer search → AI match → call bridge), **Flow 2** (video consult), and the full **supply-adaptive dispatch loop** — including YES/NO pro reply handling, queue auto-advancement, and consumer notification.

---

## Architecture Overview

```
Browser /                           Browser /business
  │  describe problem + geolocation   │  passkey sign-in / register
  ▼                                   ▼
POST /api/match                     POST /api/business/passkeys/authenticate/*
  ├─ smartMatch()  → Cerebras LLM     POST /api/business/passkeys/register/*
  └─ searchPlaces()→ Google Places      └─ returns 24h HMAC session token
  │                                   ▼
  ▼  ranked Business[] (up to 6)    Browser /business/dashboard
Browser (results cards)               ├─ GET /api/dashboard     → 30d metrics
  │  urgencyTier / diagnosisHint      ├─ GET /api/workspace-settings → form
  │  aiSummary / Layer 3 summaries    └─ GET /api/business/passkeys/list
  │  user taps "Call" or "Send request"
  ▼
POST /api/call                          POST /api/dispatch (supply-adaptive)
  ├─ resolveCallRef() — HMAC verify       ├─ reRankByAcceptance() — training data
  ├─ createCallSession() — PIN + token    ├─ scoreLeadUrgency() — urgency prefix
  └─ returns telHref: tel:BRIDGE,PIN      ├─ notify 1–3 businesses simultaneously
  │                                       ├─ QStash 5-min timeout per business
  ▼  user taps tel: link                  └─ QStash review follow-up (24 h)
Twilio PSTN Bridge  ←→  /api/voice
  ├─ ?t=TOKEN  →  outbound bridge to business
  └─ Digits=PIN → inbound PIN lookup → bridge
```

```
Business replies YES/NO via SMS
  ▼
POST /api/webhooks/sms-inbound (Twilio webhook)
  ├─ HMAC-SHA1 signature verification
  ├─ YES → accept lead, SMS consumer bridge+PIN, create call session
  ├─ NO  → decline, advance dispatch queue to next business
  └─ STOP → opt-out business from future SMS outreach

QStash (5 min after business notified)
  ▼
POST /api/internal/dispatch-timeout
  ├─ check if business responded
  └─ if no response → auto-advance dispatch queue
```

```
Browser
  │  user taps "Video"
  ▼
POST /api/video  →  video.servicesurfer.app  →  returns sessionUrl
```

```
Business owner
  │  claims listing / asks AI a question
  ▼
POST /api/claim                          POST /api/workspace
  ├─ store PendingClaim in Redis           ├─ rate limit: 20 req/hr per phone
  └─ Twilio SMS → 6-digit OTP             ├─ Cerebras LLM → personalised advice
                                           └─ returns { answer, tips[] }

QStash (24h after lead)
  ▼
POST /api/jobs/review-followup
  ├─ QStash HMAC signature verification
  ├─ load DispatchRecord from Redis
  └─ Twilio SMS → consumer review request
```

---

## Technology Stack

| Layer | Choice |
|---|---|
| Framework | [Astro 5](https://astro.build) — SSR on Vercel |
| Cache / Sessions | [Upstash Redis](https://upstash.com) |
| AI matching | [Cerebras](https://cerebras.ai) (`gpt-oss-120b`) |
| Business search | Google Places API (New) |
| Call bridge | [Twilio](https://twilio.com) PSTN + TwiML |
| Video consult | `video.servicesurfer.app` microservice |
| Async jobs | [QStash](https://upstash.com/docs/qstash) (dispatch timeouts + review follow-up) |
| Geolocation | Browser API → ip-api.com / ipapi.co fallback |
| Auth (tokens) | HMAC-SHA256 (call refs) + HMAC-SHA1 (Twilio webhook sig) via Web Crypto API |
| Auth (passkeys) | [WebAuthn](https://webauthn.io) via `@simplewebauthn/server` — passkey registration + authentication |
| Database | [Supabase](https://supabase.com) — dispatch training events, lead analytics, passkeys, workspace settings |
| Billing | [Stripe](https://stripe.com) — subscription checkout, webhook plan sync |
| Deployment | [Vercel](https://vercel.com) — `vercel.json` with per-function timeouts, security headers, `/health` rewrite |

---

## Flows

### Flow 1 — Consumer Search → Call Bridge

1. User types a problem description (e.g. *"my sink is leaking"*).
2. Browser geolocates the user (GPS preferred, IP fallback).
3. `POST /api/match` runs smart-match (Cerebras) and Google Places in parallel, returning up to 6 ranked businesses.
4. User taps **Call** on a card → `POST /api/call` resolves the HMAC-signed `callRef`, creates a 6-digit PIN session (15-minute TTL), and returns a `tel:BRIDGE,PIN` href.
5. User's phone dialer opens and auto-dials the bridge number with the PIN.
6. Twilio calls `GET|POST /api/voice?t=TOKEN` (outbound) or collects the PIN via DTMF (inbound) and bridges to the business.

### Flow 2 — Supply-Adaptive Dispatch Loop

1. `POST /api/dispatch` receives the consumer request + ranked business list.
2. **Supply level** is computed from the number of available businesses:
   - `high` (≥4): notify top 1 only — quality over quantity
   - `normal` (2–3): notify top 2 simultaneously
   - `low` (0–1): notify all available — widest net
3. Each notified business receives an SMS: *"New lead … Reply YES to accept or NO to pass."*
4. A 5-minute QStash timeout is scheduled per business (`/api/internal/dispatch-timeout`).
5. When a business replies:
   - **YES** → `/api/webhooks/sms-inbound` locks the lead, creates a call session, SMS consumer the bridge + PIN.
   - **NO** → advances the queue to the next business.
   - **STOP** → opts the business out of future outreach.
6. If no business responds within 5 minutes, the timeout auto-advances the queue.
7. If the queue is exhausted, the consumer receives an SMS to retry.
8. 24 hours after dispatch, QStash fires `/api/jobs/review-followup` to request a consumer review.

### Flow 3 — Video Consult

1. User taps **Video** on any business card.
2. `POST /api/video` proxies to the video microservice, which returns a `sessionUrl`.
3. Browser navigates to the session URL for a live video consultation.

### Flow 4 — Business Claiming

1. Business owner finds their listing and taps **Claim**.
2. `POST /api/claim` stores a pending claim in Redis and sends a 6-digit verification code via Twilio SMS.
3. Owner submits the code; the claim is verified and forwarded to the main platform.

### Flow 5 — AI Workspace

1. Business owner submits a question (e.g. *"How should I price a water heater replacement?"*).
2. `POST /api/workspace` loads stored settings from Supabase (tone, answerLength, bannedClaims, requiredPhrases).
3. Passes the question + business context to Cerebras with a tone-adaptive system prompt.
4. Post-processes the response: detects banned claims, checks for required phrases, applies plan-based feature gating.
5. Falls back to curated keyword-matched advice if Cerebras is unavailable.

### Flow 6 — WebAuthn Passkey Authentication

1. Business owner initiates registration: `POST /api/business/passkeys/register/start` returns WebAuthn options + stores a challenge in Supabase (5-minute TTL).
2. Browser calls `@simplewebauthn/browser startRegistration()` — the authenticator signs the challenge.
3. `POST /api/business/passkeys/register/finish` verifies the response, persists the credential (`user_passkeys`), marks challenge as used.
4. On subsequent logins: `POST /api/business/passkeys/authenticate/start` → `finish` → returns a signed 24-hour session token (HMAC-SHA256).

### Flow 7 — Business Dashboard

1. Authenticated business phone calls `GET /api/dashboard?phone=+1…`.
2. Returns pre-aggregated 30-day metrics from the `business_dashboard_metrics` cache (refreshed hourly).
3. On cache miss / stale: live-queries `lead_events` + `dispatch_training_events` from Supabase, upserts fresh metrics.
4. Metrics include: leads received, calls, dispatches, acceptance rate, avg response time, top service categories.

### Flow 8 — Consumer Dispatch Request (UI)

1. Consumer views ranked business cards on `/` after a search.
2. The **Send request** button on each card calls `POST /api/dispatch`, passing the primary business `callRef`, all other businesses as `additionalBusinesses`, lat/lng, and service label.
3. Consumer phone is prompted once and cached in `sessionStorage` for subsequent requests.
4. On success (`dispatchId` returned) the button transitions to a "Request sent!" confirmed state.
5. Cards show urgency styling (`.scard--urgent`, `.scard--critical`) based on `urgencyTier` from the match response.
6. An `aiSummary` bar replaces the plain category heading when Cerebras inference is available.
7. A `diagnosisHint` callout (red / amber / blue) surfaces the likely issue cause below the results.
8. Layer 3 async: each card with a website fires `POST /api/summarize` after render — "Loading business info…" placeholders are replaced with the AI summary on resolve.

### Flow 10 — Stripe Subscription Upgrade

1. Authenticated business owner triggers an upgrade from `/business/dashboard` → `POST /api/stripe/checkout?plan=pro`.
2. Server creates a Stripe Checkout Session (subscription mode) with `business_phone` and `plan_slug` in subscription metadata.
3. Stripe redirects to `/business/dashboard?checkout=success` on completion.
4. `POST /api/stripe/webhook` receives `checkout.session.completed` → upserts `plan_slug` in `business_workspace_settings`.
5. Subsequent `customer.subscription.updated` / `customer.subscription.deleted` events keep the plan in sync.
6. Webhook signature is verified via HMAC-SHA256 against `STRIPE_WEBHOOK_SECRET` (Stripe timestamp-prefixed payload).

### Flow 9 — Business Portal

1. Business owner navigates to `/business` — a passkey sign-in / register page.
2. **Sign in**: triggers a discoverable credential WebAuthn assertion (no username needed), verifies via `/api/business/passkeys/authenticate/finish`, stores the 24h session token in `sessionStorage`.
3. **Register**: existing session required; generates registration options, creates credential, verifies via `/api/business/passkeys/register/finish`.
4. On success, owner is redirected to `/business/dashboard`, which:
   - Silently refreshes the session token via `/api/business/passkeys/refresh`.
   - Loads 30-day metrics from `/api/dashboard` and renders them in a color-coded metric grid with acceptance-rate bar and top-service-category pills.
   - Pre-fills the AI Workspace settings form (tone, answer length, banned claims, required phrases, knowledge URLs, starter questions, escalation toggles) from `/api/workspace-settings`.
   - Lists registered passkeys with friendly names, creation/last-used dates, and per-credential revoke buttons (lock-out guard: last passkey cannot be removed).
5. All dashboard API calls include `Authorization: Bearer <token>` for session verification.

---

## API Reference

### `POST /api/match`
Find businesses matching a service request.

**Request body**
```json
{ "query": "my AC stopped working", "lat": 41.878, "lng": -87.629 }
```

**Response**
```json
{
  "businesses": [
    {
      "placeId": "ChIJ...",
      "name": "ABC HVAC",
      "address": "123 Main St, Chicago, IL",
      "rating": 4.8,
      "reviewCount": 212,
      "phone": null,
      "callRef": "<hmac-signed-token>",
      "website": "https://abchvac.com",
      "openNow": true,
      "distance": "1.4 mi"
    }
  ],
  "label": "HVAC technicians",
  "intentQuery": "HVAC technician",
  "aiSummary": "Needs HVAC repair for a broken AC unit.",
  "diagnosisHint": {
    "diagnosisLabel": "Cooling system failure detected",
    "likelyCauses": "Likely: refrigerant, compressor, or capacitor"
  },
  "urgencyTier": "high",
  "urgencyScore": 75
}
```

| Response field | Source | Description |
|---|---|---|
| `businesses` | Google Places + HMAC signing | Ranked business list |
| `label` | Cerebras → Layer 1 fallback | Human-readable category heading |
| `intentQuery` | Layer 1 deterministic | Canonical category (e.g. `"plumber"`) |
| `aiSummary` | Cerebras | One-sentence description of the consumer's need |
| `diagnosisHint` | Layer 1 `inferDiagnosisHint()` | Issue label + likely cause for UI callout |
| `urgencyTier` | `scoreLeadUrgency()` | `critical` / `high` / `medium` / `low` |
| `urgencyScore` | `scoreLeadUrgency()` | 0–100 numeric urgency score |

---

### `POST /api/call`
Create a call session for a business.

**Request body**
```json
{ "callRef": "<hmac-signed-token>", "businessName": "ABC HVAC" }
```

**Response**
```json
{ "telHref": "tel:+14014165855,483920" }
```

---

### `GET|POST /api/voice`
Twilio voice webhook — handles both outbound click-to-call and inbound PIN-based routing. Configure your Twilio number's **Voice URL** to point here.

| Scenario | Trigger | Behaviour |
|---|---|---|
| Outbound | `?t=TOKEN` query param | Bridge directly to business |
| PIN submitted | `Digits=NNNNNN` form field | Look up session by PIN, bridge |
| Inbound default | (no token, no digits) | Gather 6-digit PIN; fall back to AI voice agent |

---

### `POST /api/dispatch`
Supply-adaptive lead dispatch — notifies 1–3 businesses based on local supply level.

**Request body**
```json
{
  "callRef": "<hmac-signed-token>",
  "businessName": "ABC HVAC",
  "problem": "AC stopped working",
  "location": "Chicago, IL",
  "consumerPhone": "+13125550100",
  "additionalBusinesses": [
    { "callRef": "<hmac-signed-token>", "name": "Cool Air LLC" },
    { "callRef": "<hmac-signed-token>", "name": "City HVAC Pro" }
  ]
}
```

**Response**
```json
{ "dispatchId": "dp_1711234567890_abc123", "supplyLevel": "normal", "notified": 2 }
```

---

### `POST /api/webhooks/sms-inbound`
Twilio inbound SMS webhook — processes business YES/NO replies in the dispatch loop. Configure your Twilio number's **"A message comes in"** webhook URL to point here.

| Reply | Tokens | Behaviour |
|---|---|---|
| Accept | `YES Y ACCEPT 1` | Lock lead, SMS consumer bridge+PIN, create call session |
| Decline | `NO N PASS SKIP` | Advance dispatch queue to next business |
| Opt-out | `STOP UNSUBSCRIBE` | Record opt-out in Redis, reply confirmation |
| Help | `HELP INFO` | Reply with usage instructions |

**Headers:** `X-Twilio-Signature` (HMAC-SHA1 verified server-side)

---

### `POST /api/internal/dispatch-timeout`
QStash webhook — fires 5 minutes after a business is notified. Auto-advances the dispatch queue if the business has not replied.

**Headers:** `Authorization: Bearer {DISPATCH_JOB_SECRET}`

**Request body**
```json
{ "dispatchId": "dp_1711234567890_abc123", "businessPhone": "+13125550100" }
```

---

### `POST /api/jobs/review-followup`
QStash webhook — sent automatically 24 hours after a dispatch. Sends a review-request SMS to the consumer.

**Headers:** `Upstash-Signature` (HMAC-SHA256 verified server-side, with key rotation)

**Request body**
```json
{ "dispatchId": "dp_1711234567890_abc123" }
```

---

### `POST /api/workspace`
AI Workspace — Cerebras-powered business coaching with tone config, compliance checking, and plan gating.

**Request body**
```json
{
  "businessName": "ABC HVAC",
  "serviceLabel": "HVAC technician",
  "question": "How should I price a water heater replacement?",
  "leadContext": "Customer's water heater stopped working, needs same-day service",
  "businessPhone": "+13125550100",
  "tone": "direct",
  "answerLength": "balanced",
  "bannedClaims": ["cheapest", "guaranteed lowest price"],
  "requiredPhrases": ["licensed and insured"],
  "planSlug": "pro"
}
```

**Response**
```json
{
  "answer": "Price at $900–$1,400 depending on unit and install complexity. Licensed and insured pros command 15% premium.",
  "tips": ["Quote parts and labour separately", "Include haul-away to differentiate", "Offer 1-year warranty"],
  "provider": "cerebras",
  "latencyMs": 312,
  "flaggedClaims": [],
  "missingPhrases": [],
  "planSlug": "pro"
}
```

**Plan gating:** `free` plan receives `short` answers + 2 tips only; `starter`/`pro`/`elite` receive full features.

---

### `GET /api/workspace-settings?phone=+1…` / `PUT /api/workspace-settings`
Read and update per-business AI Workspace configuration stored in Supabase.

**PUT body**
```json
{
  "businessPhone": "+13125550100",
  "tone": "premium",
  "answerLength": "detailed",
  "bannedClaims": ["cheapest in town"],
  "requiredPhrases": ["licensed and insured", "free estimate"],
  "escalateToCall": true,
  "escalateToVideo": false,
  "planSlug": "pro"
}
```

---

### `GET /api/dashboard?phone=+1…`
Business performance dashboard — 30-day rolling metrics.

**Response**
```json
{
  "business_phone": "+13125550100",
  "leads_30d": 42,
  "calls_30d": 18,
  "dispatches_30d": 42,
  "accepted_30d": 31,
  "declined_30d": 7,
  "timeout_30d": 4,
  "acceptance_rate": 73.8,
  "avg_response_ms": 22400,
  "top_service_labels": ["HVAC technician", "furnace repair"],
  "updated_at": "2026-03-29T12:00:00Z",
  "cached": true
}
```

---

### `POST /api/business/passkeys/register/start`
Step 1 of passkey registration — returns `PublicKeyCredentialCreationOptionsJSON`.

**Request body:** `{ "userId": "uuid", "userName": "jane@example.com", "displayName": "Jane Smith" }`

---

### `POST /api/business/passkeys/register/finish`
Step 2 — verifies registration response, persists credential.

**Request body:** `{ "userId": "uuid", "response": <RegistrationResponseJSON> }`
**Response:** `{ "verified": true, "credentialId": "abc..." }`

---

### `POST /api/business/passkeys/authenticate/start`
Step 1 of passkey authentication — returns `PublicKeyCredentialRequestOptionsJSON`.

**Request body:** `{ "userId": "uuid" }` (omit `userId` for discoverable/passkey-first flow)

---

### `POST /api/business/passkeys/authenticate/finish`
Step 2 — verifies assertion, bumps counter, returns signed session token.

**Request body:** `{ "userId": "uuid", "response": <AuthenticationResponseJSON> }`
**Response:** `{ "verified": true, "token": "<hmac-signed-session-token>", "userId": "uuid" }`

---

### `POST /api/business/passkeys/refresh`
Silently extends a valid session without re-authentication.

**Headers:** `Authorization: Bearer <session-token>`
**Response:** `{ "token": "<new-token>", "userId": "uuid", "expiresAt": 1740000000 }`

---

### `GET /api/business/passkeys/list`
Lists all registered passkeys for the authenticated user.

**Headers:** `Authorization: Bearer <session-token>`
**Response:** `{ "passkeys": [{ "credentialId", "friendlyName", "deviceType", "backedUp", "lastUsedAt", "createdAt" }] }`

---

### `DELETE /api/business/passkeys/revoke`
Revokes a specific passkey. Rejects with `409` if it would remove the last credential.

**Headers:** `Authorization: Bearer <session-token>`
**Request body:** `{ "credentialId": "abc..." }`
**Response:** `{ "revoked": true, "credentialId": "abc..." }`

---

### `POST /api/stripe/checkout`
Create a Stripe Checkout Session for a plan upgrade.

**Headers:** `Authorization: Bearer <session-token>`

**Request body**
```json
{ "plan": "pro" }
```

**Response**
```json
{ "url": "https://checkout.stripe.com/c/pay/...", "sessionId": "cs_live_..." }
```

Supported plans: `starter`, `pro`, `elite`. Redirects to `/business/dashboard?checkout=success` on completion.

---

### `POST /api/stripe/webhook`
Stripe webhook — processes subscription lifecycle events to keep `plan_slug` in sync.

**Headers:** `Stripe-Signature` (HMAC-SHA256 verified against `STRIPE_WEBHOOK_SECRET`)

Handled events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`.

Configure your Stripe dashboard webhook endpoint to point to `https://your-domain/api/stripe/webhook`.

---

### `POST /api/claim`
Initiate a business ownership claim.

**Request body**
```json
{ "placeId": "ChIJ...", "businessName": "ABC HVAC", "ownerPhone": "+13125550199", "ownerName": "Jane Smith" }
```

**Response**
```json
{ "claimId": "cl_1711234567890_xyz789" }
```

---

### `GET /api/get-location`
Geolocate the requesting IP or reverse-geocode coordinates.

| Params | Behaviour |
|---|---|
| `?lat=X&lon=Y` | Reverse geocode via Google Geocoding API → zip + city |
| (none) | IP geolocation via ip-api.com / ipapi.co race |

---

### `POST /api/video`
Start a video consultation session.

**Request body**
```json
{ "problem": "AC stopped working", "location": "Chicago, IL", "businessName": "ABC HVAC" }
```

**Response**
```json
{ "sessionUrl": "https://video.servicesurfer.app/session/abc123" }
```

---

### `GET /api/status`
Health check — verifies Redis connectivity and required env vars.

**Response (healthy)**
```json
{ "ok": true, "redis": true, "checks": { "GROQ_API_KEY": true, "GOOGLE_PLACES_API_KEY": true, "TWILIO_ACCOUNT_SID": true } }
```

---

## Setup

### Prerequisites
- Node.js ≥ 18
- Vercel account (or any Node-compatible host with SSR support)
- Upstash Redis database
- Upstash QStash account (for dispatch timeouts + review follow-up)
- Twilio account with a purchased phone number
- Google Cloud project with Places API (New) + Geocoding API enabled
- Cerebras API key

### 1. Clone & install

```bash
git clone <repo-url>
cd simple-ss
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in all values (see table below).

### 3. Configure Twilio

Set your Twilio number's **Voice URL** to:
```
https://your-domain/api/voice
```

Set your Twilio number's **"A message comes in" (SMS) URL** to:
```
https://your-domain/api/webhooks/sms-inbound
```

Method: HTTP POST for both.

### 3a. Configure QStash

When publishing dispatch-timeout jobs, include the authorization header:
```
Authorization: Bearer {DISPATCH_JOB_SECRET}
```
The dispatch endpoint sets this automatically via the `DISPATCH_JOB_SECRET` env var.

### 4. Run locally

```bash
npm run dev
```

### 5. Deploy

```bash
vercel deploy
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `CALL_REF_SECRET` | ✅ | HMAC-SHA256 secret for signing phone tokens. Must match the main app. |
| `UPSTASH_REDIS_REST_URL` | ✅ | Upstash Redis REST endpoint URL |
| `UPSTASH_REDIS_REST_TOKEN` | ✅ | Upstash Redis REST auth token |
| `GOOGLE_PLACES_API_KEY` | ✅ | Google Cloud API key (Places API New + Geocoding API) |
| `CEREBRAS_API_KEY` | ✅ | Cerebras API key for smart-match LLM |
| `CEREBRAS_MODEL` | | Cerebras model ID (default: `gpt-oss-120b`) |
| `TWILIO_ACCOUNT_SID` | ✅ | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | ✅ | Twilio auth token |
| `TWILIO_FROM_NUMBER` | ✅ | Twilio sender phone number (E.164) |
| `PUBLIC_SERVICE_SURFER_CALL_NUMBER` | ✅ | Bridge phone number shown to consumers |
| `DISPATCH_JOB_SECRET` | ✅ | Bearer token for `/api/internal/dispatch-timeout` authorization |
| `VIDEO_APP_URL` | | Base URL of the video microservice (default: `https://video.servicesurfer.app`) |
| `QSTASH_URL` | | Upstash QStash endpoint URL (required for dispatch timeouts + review follow-up) |
| `QSTASH_TOKEN` | | Upstash QStash auth token |
| `QSTASH_CURRENT_SIGNING_KEY` | | QStash webhook signature verification key |
| `QSTASH_NEXT_SIGNING_KEY` | | QStash webhook signature verification key (rotation) |
| `SUPABASE_URL` | | Supabase project URL (required for analytics, passkeys, dashboard, workspace settings) |
| `SUPABASE_SERVICE_ROLE_KEY` | | Supabase service-role key |
| `WEBAUTHN_RP_ID` | | WebAuthn relying party domain (e.g. `simple.servicesurfer.app`) |
| `WEBAUTHN_RP_NAME` | | WebAuthn relying party display name |
| `BUSINESS_JWT_SECRET` | | Secret for signing business session tokens post-passkey auth (falls back to `DISPATCH_JOB_SECRET`) |
| `PUBLIC_SITE_URL` | | Canonical site URL — must match `WEBAUTHN_RP_ID` origin for passkeys |
| `STRIPE_SECRET_KEY` | | Stripe secret key for creating Checkout Sessions |
| `STRIPE_WEBHOOK_SECRET` | | Stripe webhook signing secret (from dashboard) — used by `/api/stripe/webhook` |
| `STRIPE_PRICE_STARTER` | | Stripe Price ID for the Starter plan |
| `STRIPE_PRICE_PRO` | | Stripe Price ID for the Pro plan |
| `STRIPE_PRICE_ELITE` | | Stripe Price ID for the Elite plan |

---

## Caching Strategy

| Data | Cache key | TTL |
|---|---|---|
| Smart-match result | `sr:smart-match:v4:{query}[:{budget}][:{urgency}]` | 7 days |
| Google Places search | `ss:simple:v1:{query}:{lat100}:{lng100}` | 4 hours |
| Combined match result | `ss:match:v1:{query}:{lat10}:{lng10}` | 4 hours |
| Call session (by token) | `ss:public-call:token:{token}` | 15 minutes |
| Call session (by PIN) | `ss:public-call:pin:{pin}` | 15 minutes |
| Dispatch record | `ss:dispatch:{id}` | 48 hours |
| Business phone → dispatch ID | `ss:dispatch:by-phone:{phone}` | 30 minutes |
| Pending claim | `ss:claim:{id}` | 15 minutes |
| Claim dedup lock | `ss:claim:lock:{placeId}:{phone}` | 15 minutes |
| SMS opt-out | `ss:sms:optout:{phone}` | permanent |
| AI Workspace rate limit | `ss:workspace:rl:{phone}` | 1 hour (sliding window) |
| Smart-rank acceptance rates | `ss:smart-rank:v1:{label}:{cell}:{phones}` | 10 minutes |
| Website summary | `sr:place:v1:{placeId}:website_summary:{hex12}` | 30 days |
| Summarize rate limit | `ss:summarize:rl:{ip}` | 60 seconds (sliding window) |

Redis keys are **intentionally compatible** with the main ServiceSurfer platform so sessions and smart-match results are shared across both apps.

---

## Security Notes

- **Phone numbers are never exposed client-side.** All business phones are wrapped in HMAC-SHA256 signed tokens (`callRef`). The signature is verified server-side before any session is created.
- **TwiML output is XSS-safe.** All dynamic strings are XML-escaped before being embedded in TwiML responses.
- **Inbound Twilio SMS webhooks are HMAC-SHA1 verified** against `X-Twilio-Signature` using the Twilio auth token before any dispatch logic runs.
- **Internal QStash jobs require a bearer token** (`DISPATCH_JOB_SECRET`) to prevent unauthorized queue manipulation.
- **Call sessions expire in 15 minutes** and PINs are 6 random digits with collision detection.
- **QStash review webhooks are HMAC-SHA256 verified** with current + next key rotation support.
- **Business claiming codes expire in 15 minutes** with a per-(placeId+phone) dedup lock preventing replay.
- **AI Workspace is rate-limited** at 20 requests/hour per business phone using a Redis sorted-set sliding window.
- **Passkey challenges expire in 5 minutes** and are single-use (marked `used_at` on successful verification) to prevent replay attacks.
- **Session tokens are HMAC-SHA256 signed** (payload: `userId.exp`) with `BUSINESS_JWT_SECRET` and carry a 24-hour expiry.
- **Credential counters are bumped** on every authentication to detect cloned authenticators.
- **Supabase service-role key is server-only** — never exposed to the browser. RLS is enabled on all passkey and settings tables.
- **Dispatch training events log every outcome** (accepted / declined / timeout) with supply level, queue position, and response time for AI model training.
- **Stripe webhook payloads are HMAC-SHA256 verified** against the timestamp-prefixed body (Stripe's `t=<ts>.body` signing scheme) before any plan_slug mutation occurs.
- **QStash publish/verify logic is centralised in `lib/qstash.ts`** — `scheduleDispatchTimeout()` and `scheduleReviewFollowup()` use deduplication IDs to prevent double-scheduling on handler retries.
