/**
 * lib.ts — shared utilities for the ServiceSurfer consumer frontend.
 *
 * All Redis key formats and HMAC secrets are intentionally compatible with the
 * main ServiceSurfer platform so that call sessions, smart-match cache entries,
 * and business search results are shared between both apps.
 */

import { Redis } from '@upstash/redis';

// ── Redis ─────────────────────────────────────────────────────────────────────

let _r: Redis | null = null;

/**
 * Returns a lazy-initialized Upstash Redis client, or null if the required
 * env vars (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) are absent.
 * Safe to call on every request — the client is only created once.
 */
export const redis = () => {
  if (!_r) {
    const url   = import.meta.env.UPSTASH_REDIS_REST_URL;
    const token = import.meta.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) _r = new Redis({ url, token });
  }
  return _r;
};

// ── Call Reference (HMAC-signed phone token) ──────────────────────────────────
//
// A callRef encodes a business phone number as a URL-safe base64 payload plus
// an HMAC-SHA256 signature, so phone numbers are never stored or transmitted in
// plaintext on the client side.  The format is:  `{phoneB64u}.{sigB64u}`
//
// CALL_REF_SECRET is shared with the main app — tokens are fully interoperable.

function getSecret() {
  return import.meta.env.CALL_REF_SECRET || 'ss-call-ref-dev-secret-change-in-production';
}

async function hmacKey(s: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(s),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** Encodes an ArrayBuffer or Uint8Array as URL-safe base64 (no padding). */
const b64u = (buf: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...(buf instanceof Uint8Array ? buf : new Uint8Array(buf))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Decodes a URL-safe base64 string to a Uint8Array. */
const fromb64u = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

/**
 * Creates an HMAC-signed call reference token for a business phone number.
 * The phone is base64url-encoded and signed with CALL_REF_SECRET so it can
 * be safely passed to the client without exposing the raw number.
 *
 * @param phone Raw phone number in any format (normalised internally before signing)
 * @returns `{phoneB64u}.{sigB64u}` token string
 */
export async function makeCallRef(phone: string): Promise<string> {
  const phoneB64 = b64u(new TextEncoder().encode(phone));
  const sig      = await crypto.subtle.sign('HMAC', await hmacKey(getSecret()), new TextEncoder().encode(phoneB64));
  return `${phoneB64}.${b64u(sig)}`;
}

/**
 * Verifies a call reference token and returns the embedded phone number.
 * Returns null if the token is malformed or the HMAC signature is invalid.
 *
 * @param ref Token produced by {@link makeCallRef}
 * @returns Decoded phone number string, or null on verification failure
 */
export async function resolveCallRef(ref: string): Promise<string | null> {
  const sep = ref.indexOf('.');
  if (sep < 1) return null;
  const phoneB64 = ref.slice(0, sep), sigB64 = ref.slice(sep + 1);
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(getSecret()),
      fromb64u(sigB64),
      new TextEncoder().encode(phoneB64),
    );
    return ok ? new TextDecoder().decode(fromb64u(phoneB64)) : null;
  } catch { return null; }
}

// ── Public Call Sessions ───────────────────────────────────────────────────────
//
// A call session ties a short-lived PIN to a business phone number so that a
// consumer can call the Twilio bridge and be connected without the server needing
// to store state beyond 15 minutes.
//
// Redis key format (same as main app):
//   ss:public-call:token:{token}  →  JSON(CallSession)  TTL 900s
//   ss:public-call:pin:{pin}      →  token              TTL 900s

const TTL = 900; // 15 minutes
const TK  = (t: string) => `ss:public-call:token:${t}`;
const PK  = (p: string) => `ss:public-call:pin:${p}`;

/**
 * Normalises a US phone number string to E.164 format (+1XXXXXXXXXX).
 * Accepts 10-digit, 11-digit (1XXXXXXXXXX), and already-normalised (+1...) inputs.
 *
 * @returns Normalised E.164 string, or null if the input is not a valid US number
 */
export function normalizePhone(v: string): string | null {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (String(v).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}

/** Shape of a call session stored in Redis. */
export interface CallSession {
  /** Opaque session token (URL-safe UUID without hyphens). */
  token: string;
  /** 6-digit DTMF PIN for inbound calls. */
  pin: string;
  /** E.164 business phone number. */
  businessPhone: string;
  /** Display name for TTS greeting ("Connecting you to X now"). */
  businessName: string;
  /** Unix timestamp (ms) when the session was created. */
  createdAt: number;
  /** Unix timestamp (ms) after which the session is invalid. */
  expiresAt: number;
}

/**
 * Creates a new call session for a business phone number and persists it in Redis.
 *
 * Generates a collision-avoiding 6-digit PIN by checking up to 12 candidates
 * against active PIN keys in Redis before giving up.
 *
 * @returns The created {@link CallSession}, or null if Redis is unavailable or PIN
 *          exhaustion occurs (extremely unlikely — retry if null).
 */
export async function createCallSession(
  businessPhone: string,
  businessName: string,
): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const phone = normalizePhone(businessPhone); if (!phone) return null;

  const token = crypto.randomUUID().replace(/-/g, '');
  let pin = '';

  // Try up to 12 random PINs — collision probability is negligible in practice
  for (let i = 0; i < 12; i++) {
    const p = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    if (await r.get(PK(p))) continue;
    await r.set(PK(p), token, { ex: TTL });
    pin = p;
    break;
  }
  if (!pin) return null;

  const now = Date.now();
  const session: CallSession = {
    token,
    pin,
    businessPhone: phone,
    businessName: String(businessName || 'Business').slice(0, 120),
    createdAt: now,
    expiresAt: now + TTL * 1000,
  };
  await r.set(TK(token), JSON.stringify(session), { ex: TTL });
  return session;
}

/**
 * Retrieves a call session by its token, returning null if not found or expired.
 */
export async function getCallSession(token: string): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const raw = await r.get(TK(token)); if (!raw) return null;
  try {
    const s: CallSession = typeof raw === 'string' ? JSON.parse(raw) : raw as CallSession;
    return Date.now() > s.expiresAt ? null : s;
  } catch { return null; }
}

/**
 * Looks up a call session by its 6-digit PIN.
 * Used by the Twilio voice webhook to bridge inbound DTMF callers.
 */
export async function getCallSessionByPin(pin: string): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const token = await r.get<string>(PK(pin)); if (!token) return null;
  return getCallSession(String(token));
}

/**
 * Returns the Twilio bridge phone number from config, normalised to E.164.
 * Falls back to a hardcoded default if the env var is missing.
 */
export function bridgeNumber(): string {
  return normalizePhone(import.meta.env.PUBLIC_SERVICE_SURFER_CALL_NUMBER || '') || '+14013862975';
}

// ── Smart Match (Cerebras) ────────────────────────────────────────────────────
//
// Uses a Cerebras LLM (gpt-oss-120b by default) to parse a free-text service
// description into structured search queries and a human-readable label.
// Results are cached in Redis for 7 days — the cache key format is shared with
// the main app so the two apps warm each other's caches.

const PROMPT = `You extract home/property service search queries. Respond ONLY with JSON.

If the input is NOT a real home or property service request (nonsense, off-topic, test input), return:
{"queries":[],"summary":null,"label":null,"labelPlural":null}

Otherwise return:
{"queries":["specific","broader","broadest"],"summary":"one sentence max 15 words","label":"singular pro name","labelPlural":"plural pro name"}

Key mappings (always use these):
- Yard/lawn/garden cleanup, overgrown, trimming → "landscaping" (NOT "yard cleaning" or "cleaning")
- Rug/carpet dirty, stained, needs cleaning → "rug cleaning" or "carpet cleaning"
- Mold/black spots/mildew → "mold remediation"
- Bouncy/sagging floor → "foundation repair"
- Standing water/flood → "water damage restoration"
- Ceiling stain after rain → "roof repair"; near pipes → "plumber"
- Moving to new home/apartment, packing, relocation → "moving company" (NOT "moving" or "im moving")
- Add "emergency" prefix if urgency is Emergency/Within 24h/Today

Examples:
{"input":"sink won't stop dripping","out":{"queries":["plumber faucet repair","plumber","plumbing"],"summary":"Needs a plumber for a dripping sink.","label":"plumber","labelPlural":"plumbers"}}
{"input":"yard cleanup","out":{"queries":["landscaping yard cleanup","lawn care","landscaping"],"summary":"Needs a landscaper for yard cleanup.","label":"landscaper","labelPlural":"landscapers"}}
{"input":"my AC stopped working","out":{"queries":["HVAC repair air conditioning","AC repair","HVAC technician"],"summary":"Needs HVAC repair for a broken AC.","label":"HVAC technician","labelPlural":"HVAC technicians"}}
{"input":"roof is leaking after rain","out":{"queries":["roof repair leak","roofing contractor","roof leak repair"],"summary":"Needs a roofer for a rain leak.","label":"roofer","labelPlural":"roofers"}}
{"input":"is ur mom","out":{"queries":[],"summary":null,"label":null,"labelPlural":null}}`;

/** Normalises a query string for use as a cache key component. */
function normQ(s: string) { return s.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120); }

/**
 * Parses a free-text service description with the Cerebras LLM and returns
 * structured search queries and a human-readable service label.
 *
 * Results are cached in Redis for 7 days. If the LLM is unavailable the
 * function returns a best-effort fallback (first 4 words of the description).
 *
 * Cache key: `sr:smart-match:v4:{normalisedQuery}[:{budget}][:{urgency}]`
 *
 * @param description Consumer's problem description (e.g. "my sink is leaking")
 * @param budget      Optional budget range string (e.g. "Under $500")
 * @param urgency     Optional urgency string (e.g. "Within 24 hours")
 */
export async function smartMatch(description: string, budget = '', urgency = '') {
  const n  = normQ(description);
  const bp = budget && budget !== 'Not sure' ? `:b:${budget.toLowerCase().replace(/\s+/g, '')}` : '';
  const up = urgency ? `:u:${urgency.toLowerCase().replace(/\s+/g, '')}` : '';
  const ck = `sr:smart-match:v4:${n}${bp}${up}`;

  // Fallback result used when LLM is unavailable or returns an empty response
  const fb = {
    aiQuery: description.split(/\s+/).slice(0, 4).join(' '),
    aiQueries: [description],
    aiSummary: null as string | null,
    serviceLabel: null as string | null,
    serviceLabelPlural: null as string | null,
  };

  const r = redis();
  if (r) {
    const c = await r.get(ck).catch(() => null);
    if (c) {
      const result = (typeof c === 'string' ? JSON.parse(c) : c) as typeof fb;
      // Backfill fields added in later cache versions
      const r2 = result as Record<string, unknown>;
      if (!Array.isArray(result.aiQueries))     result.aiQueries = [result.aiQuery].filter(Boolean);
      if (!('serviceLabel' in r2))              result.serviceLabel = null;
      if (!('serviceLabelPlural' in r2))        result.serviceLabelPlural = null;
      return result;
    }
  }

  const key = import.meta.env.CEREBRAS_API_KEY; if (!key) return fb;
  try {
    const parts = [`Problem: ${description}`];
    if (budget && budget !== 'Not sure') parts.push(`Budget: ${budget}`);
    if (urgency) parts.push(`Urgency: ${urgency}`);

    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: import.meta.env.CEREBRAS_MODEL || 'gpt-oss-120b',
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: parts.join('\n') }],
      }),
    });

    const parsed = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
    const qs: string[] = Array.isArray(parsed.queries)
      ? parsed.queries.filter(Boolean).map((q: string) => q.slice(0, 120))
      : [];

    const out = {
      aiQuery: qs[0] || fb.aiQuery,
      aiQueries: qs.length ? qs : [fb.aiQuery],
      aiSummary: parsed.summary?.slice(0, 180) || null,
      serviceLabel: parsed.label?.slice(0, 80) || null,
      serviceLabelPlural: parsed.labelPlural?.slice(0, 80) || null,
    };
    if (r) await r.set(ck, JSON.stringify(out), { ex: 60 * 60 * 24 * 7 }).catch(() => null);
    return out;
  } catch { return fb; }
}

// ── Google Places ─────────────────────────────────────────────────────────────

/** A business listing returned by the Places search. */
export interface Business {
  /** Google Places place ID. */
  placeId: string;
  /** Business display name. */
  name: string;
  /** Formatted street address. */
  address: string;
  /** Average star rating (1–5), or null if unavailable. */
  rating: number | null;
  /** Total number of Google reviews. */
  reviewCount: number;
  /** Raw phone number from Google Places, or null. */
  phone: string | null;
  /**
   * HMAC-signed call reference token.  Use this instead of `phone` to
   * initiate calls — the raw number is never exposed client-side.
   */
  callRef: string | null;
  /** Business website URL, or null. */
  website: string | null;
  /** Whether the business is currently open, or null if unknown. */
  openNow: boolean | null;
  /** Straight-line distance from the search origin (e.g. "1.4 mi"), or null. */
  distance: string | null;
}

/**
 * Calculates the straight-line distance between two lat/lng points using the
 * Haversine formula and returns it as a miles string.
 */
function haversine(la1: number, lo1: number, la2: number, lo2: number): string {
  const R = 3958.8, d = (x: number) => x * Math.PI / 180;
  const a = Math.sin(d(la2 - la1) / 2) ** 2 + Math.cos(d(la1)) * Math.cos(d(la2)) * Math.sin(d(lo2 - lo1) / 2) ** 2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))).toFixed(1);
}

/**
 * Searches Google Places for businesses matching `query` near `lat`/`lng`.
 *
 * Results are cached in Redis for 4 hours, keyed by the normalised query and a
 * 0.1° location cell (≈ 7 miles) to balance freshness with cache hit rate.
 *
 * Returns up to 6 OPERATIONAL businesses, each with an HMAC-signed `callRef`.
 *
 * Cache key: `ss:simple:v1:{normQ}:{lat×100}:{lng×100}`
 *
 * @param query Freetext search query (e.g. "HVAC repair air conditioning")
 * @param lat   Search origin latitude
 * @param lng   Search origin longitude
 */
export async function searchPlaces(query: string, lat: number, lng: number): Promise<Business[]> {
  const key = import.meta.env.GOOGLE_PLACES_API_KEY; if (!key) return [];
  const r   = redis();
  const ck  = `ss:simple:v1:${normQ(query)}:${Math.round(lat * 100)}:${Math.round(lng * 100)}`;

  if (r) {
    const c = await r.get<Business[]>(ck).catch(() => null);
    if (c) return c;
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      // Request only the fields we use — minimises billing cost
      'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.websiteUri,places.currentOpeningHours,places.location,places.businessStatus',
    },
    body: JSON.stringify({
      textQuery: query,
      // 40 km radius bias; openNow ensures we only show available businesses
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 40000 } },
      maxResultCount: 8,
      openNow: true,
    }),
  }).catch(() => null);

  if (!res?.ok) return [];
  const data = await res.json();

  const results: Business[] = await Promise.all(
    ((data.places || []) as any[])
      .filter((p: any) => p.businessStatus === 'OPERATIONAL')
      .slice(0, 6)
      .map(async (p: any) => {
        const phone = p.nationalPhoneNumber || null;
        return {
          placeId:     p.id,
          name:        p.displayName?.text || '',
          address:     p.formattedAddress || '',
          rating:      p.rating ?? null,
          reviewCount: p.userRatingCount ?? 0,
          phone,
          // Sign the phone number so it's safe to embed in client HTML
          callRef:     phone ? await makeCallRef(phone) : null,
          website:     p.websiteUri || null,
          openNow:     p.currentOpeningHours?.openNow ?? null,
          distance:    p.location ? haversine(lat, lng, p.location.latitude, p.location.longitude) + ' mi' : null,
        };
      }),
  );

  if (r && results.length) await r.set(ck, results, { ex: 60 * 60 * 4 }).catch(() => null);
  return results;
}
