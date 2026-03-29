# ServiceSurfer Simple — Consumer Frontend

> Instant local-service matching: describe a problem, get a ranked list of available pros, and connect in one tap.

`simple-ss` is the lightweight, serverless consumer frontend for the ServiceSurfer platform. It handles **Flow 1** (consumer search → AI match → call bridge) and **Flow 2** (video consult), and feeds lead data into the wider dispatch pipeline.

---

## Architecture Overview

```
Browser
  │  describe problem + geolocation
  ▼
POST /api/match
  ├─ smartMatch()   →  Groq LLM   →  service category + queries (Redis 7d cache)
  └─ searchPlaces() →  Google Places API  →  ranked businesses (Redis 4h cache)
  │
  ▼  ranked Business[] (up to 6)
Browser (results cards)
  │  user taps "Call"
  ▼
POST /api/call                          POST /api/dispatch
  ├─ resolveCallRef() — HMAC verify       ├─ store DispatchRecord in Redis
  ├─ createCallSession() — PIN + token    ├─ Twilio SMS → business
  └─ returns telHref: tel:BRIDGE,PIN      └─ QStash → review follow-up (24 h)
  │
  ▼  user taps tel: link
Twilio PSTN Bridge  ←→  /api/voice
  ├─ ?t=TOKEN  →  outbound bridge to business
  └─ Digits=PIN → inbound PIN lookup → bridge
```

```
Browser
  │  user taps "Video"
  ▼
POST /api/video  →  video.servicesurfer.app  →  returns sessionUrl
```

```
Business owner
  │  claims listing
  ▼
POST /api/claim
  ├─ store PendingClaim in Redis (15 min TTL)
  └─ Twilio SMS → 6-digit verification code

QStash (24h after lead)
  ▼
POST /api/jobs/review-followup
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
| Async jobs | [QStash](https://upstash.com/docs/qstash) (review follow-up) |
| Geolocation | Browser API → ip-api.com / ipapi.co fallback |
| Auth (tokens) | HMAC-SHA256 via Web Crypto API |

---

## Flows

### Flow 1 — Consumer Search → Call Bridge

1. User types a problem description (e.g. *"my sink is leaking"*).
2. Browser geolocates the user (GPS preferred, IP fallback).
3. `POST /api/match` runs smart-match and Google Places in parallel, returning up to 6 ranked businesses.
4. User taps **Call** on a card → `POST /api/call` resolves the HMAC-signed `callRef`, creates a 6-digit PIN session (15-minute TTL), and returns a `tel:BRIDGE,PIN` href.
5. User's phone dialer opens and auto-dials the bridge number with the PIN.
6. Twilio calls `GET|POST /api/voice?t=TOKEN` (outbound) or collects the PIN via DTMF (inbound) and bridges to the business.
7. `POST /api/dispatch` stores the lead and sends an SMS alert to the business.
8. After 24 hours, QStash triggers `POST /api/jobs/review-followup` to request a consumer review.

### Flow 2 — Video Consult

1. User taps **Video** on any business card.
2. `POST /api/video` proxies to the video microservice, which returns a `sessionUrl`.
3. Browser navigates to the session URL for a live video consultation.

### Flow 3 — Business Claiming

1. Business owner finds their listing and taps **Claim**.
2. `POST /api/claim` stores a pending claim in Redis and sends a 6-digit verification code via Twilio SMS to the business phone number.
3. Owner submits the code; the claim is verified and forwarded to the main platform.

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
  "label": "HVAC technicians"
}
```

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
Record a lead dispatch and notify the business by SMS.

**Request body**
```json
{
  "callRef": "<hmac-signed-token>",
  "businessName": "ABC HVAC",
  "problem": "AC stopped working",
  "location": "Chicago, IL",
  "consumerPhone": "+13125550100"
}
```

**Response**
```json
{ "dispatchId": "dp_1711234567890_abc123" }
```

---

### `POST /api/jobs/review-followup`
QStash webhook — sent automatically 24 hours after a dispatch. Sends a review-request SMS to the consumer.

**Headers:** `Upstash-Signature` (verified server-side)

**Request body**
```json
{ "dispatchId": "dp_1711234567890_abc123" }
```

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
- Twilio account with a purchased phone number
- Google Cloud project with Places API (New) + Geocoding API enabled
- Groq API key

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
Method: HTTP POST (or GET — both are handled).

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
| `VIDEO_APP_URL` | | Base URL of the video microservice (default: `https://video.servicesurfer.app`) |
| `QSTASH_URL` | | Upstash QStash endpoint URL (required for dispatch review follow-up) |
| `QSTASH_TOKEN` | | Upstash QStash auth token |
| `QSTASH_CURRENT_SIGNING_KEY` | | QStash webhook signature verification key |
| `QSTASH_NEXT_SIGNING_KEY` | | QStash webhook signature verification key (rotation) |
| `PUBLIC_SITE_URL` | | Canonical site URL used in SMS links |

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
| Pending claim | `ss:claim:{id}` | 15 minutes |

Redis keys are **intentionally compatible** with the main ServiceSurfer platform so sessions and smart-match results are shared across both apps.

---

## Security Notes

- **Phone numbers are never exposed client-side.** All business phones are wrapped in HMAC-SHA256 signed tokens (`callRef`). The signature is verified server-side before any session is created.
- **TwiML output is XSS-safe.** All dynamic strings are XML-escaped before being embedded in TwiML responses.
- **Call sessions expire in 15 minutes** and PINs are 6 random digits with collision detection.
- **QStash webhooks are signature-verified** before processing any job payload.
- **Business claiming codes expire in 15 minutes** and are single-use.
