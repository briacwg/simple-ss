import { Redis } from '@upstash/redis';

// ── Redis ─────────────────────────────────────────────────────────────────────
let _r: Redis | null = null;
export const redis = () => {
  if (!_r) {
    const url = import.meta.env.UPSTASH_REDIS_REST_URL;
    const token = import.meta.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) _r = new Redis({ url, token });
  }
  return _r;
};

// ── Call Reference (HMAC-signed phone token) ──────────────────────────────────
// Identical format to main app — shares CALL_REF_SECRET
function getSecret() {
  return import.meta.env.CALL_REF_SECRET || 'ss-call-ref-dev-secret-change-in-production';
}
async function hmacKey(s: string) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(s), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}
const b64u = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const fromb64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')), c => c.charCodeAt(0));

export async function makeCallRef(phone: string) {
  const phoneB64 = b64u(new TextEncoder().encode(phone));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(getSecret()), new TextEncoder().encode(phoneB64));
  return `${phoneB64}.${b64u(sig)}`;
}

export async function resolveCallRef(ref: string): Promise<string | null> {
  const sep = ref.indexOf('.');
  if (sep < 1) return null;
  const phoneB64 = ref.slice(0, sep), sigB64 = ref.slice(sep + 1);
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(getSecret()), fromb64u(sigB64), new TextEncoder().encode(phoneB64));
    return ok ? new TextDecoder().decode(fromb64u(phoneB64)) : null;
  } catch { return null; }
}

// ── Public Call Sessions ───────────────────────────────────────────────────────
// Same Redis key format as main app — sessions are interoperable
const TTL = 900;
const TK = (t: string) => `ss:public-call:token:${t}`;
const PK = (p: string) => `ss:public-call:pin:${p}`;

export function normalizePhone(v: string): string | null {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length === 10) return `+1${d}`;
  if (d.length === 11 && d[0] === '1') return `+${d}`;
  if (String(v).startsWith('+') && d.length >= 10) return `+${d}`;
  return null;
}

export interface CallSession {
  token: string; pin: string; businessPhone: string; businessName: string;
  createdAt: number; expiresAt: number;
}

export async function createCallSession(businessPhone: string, businessName: string): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const phone = normalizePhone(businessPhone); if (!phone) return null;
  const token = crypto.randomUUID().replace(/-/g, '');
  let pin = '';
  for (let i = 0; i < 12; i++) {
    const p = String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
    if (await r.get(PK(p))) continue;
    await r.set(PK(p), token, { ex: TTL }); pin = p; break;
  }
  if (!pin) return null;
  const now = Date.now();
  const session: CallSession = { token, pin, businessPhone: phone, businessName: String(businessName || 'Business').slice(0, 120), createdAt: now, expiresAt: now + TTL * 1000 };
  await r.set(TK(token), JSON.stringify(session), { ex: TTL });
  return session;
}

export async function getCallSession(token: string): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const raw = await r.get(TK(token)); if (!raw) return null;
  try {
    const s: CallSession = typeof raw === 'string' ? JSON.parse(raw) : raw as CallSession;
    return Date.now() > s.expiresAt ? null : s;
  } catch { return null; }
}

export async function getCallSessionByPin(pin: string): Promise<CallSession | null> {
  const r = redis(); if (!r) return null;
  const token = await r.get<string>(PK(pin)); if (!token) return null;
  return getCallSession(String(token));
}

export function bridgeNumber() {
  return normalizePhone(import.meta.env.PUBLIC_SERVICE_SURFER_CALL_NUMBER || '') || '+14013862975';
}

// ── Smart Match (Groq) ────────────────────────────────────────────────────────
// Exact same system prompt + cache keys as main app — shares Redis smart match cache
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

function normQ(s: string) { return s.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120); }

export async function smartMatch(description: string, budget = '', urgency = '') {
  const n = normQ(description);
  const bp = budget && budget !== 'Not sure' ? `:b:${budget.toLowerCase().replace(/\s+/g,'')}` : '';
  const up = urgency ? `:u:${urgency.toLowerCase().replace(/\s+/g,'')}` : '';
  const ck = `sr:smart-match:v4:${n}${bp}${up}`;
  const fb = { aiQuery: description.split(/\s+/).slice(0,4).join(' '), aiQueries: [description], aiSummary: null as string|null, serviceLabel: null as string|null, serviceLabelPlural: null as string|null };

  const r = redis();
  if (r) {
    const c = await r.get(ck).catch(() => null);
    if (c) {
      const result = (typeof c === 'string' ? JSON.parse(c) : c) as typeof fb;
      if (!Array.isArray(result.aiQueries)) result.aiQueries = [result.aiQuery].filter(Boolean);
      if (!('serviceLabel' in result)) result.serviceLabel = null;
      if (!('serviceLabelPlural' in result)) result.serviceLabelPlural = null;
      return result;
    }
  }

  const key = import.meta.env.GROQ_API_KEY; if (!key) return fb;
  try {
    const parts = [`Problem: ${description}`];
    if (budget && budget !== 'Not sure') parts.push(`Budget: ${budget}`);
    if (urgency) parts.push(`Urgency: ${urgency}`);

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: import.meta.env.GROQ_MODEL || 'llama-3.1-8b-instant', temperature: 0.1, max_tokens: 200, response_format: { type: 'json_object' }, messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: parts.join('\n') }] }),
    });
    const parsed = JSON.parse((await res.json()).choices?.[0]?.message?.content || '{}');
    const qs: string[] = Array.isArray(parsed.queries) ? parsed.queries.filter(Boolean).map((q: string) => q.slice(0,120)) : [];
    const out = { aiQuery: qs[0] || fb.aiQuery, aiQueries: qs.length ? qs : [fb.aiQuery], aiSummary: parsed.summary?.slice(0,180) || null, serviceLabel: parsed.label?.slice(0,80) || null, serviceLabelPlural: parsed.labelPlural?.slice(0,80) || null };
    if (r) await r.set(ck, JSON.stringify(out), { ex: 60*60*24*7 }).catch(() => null);
    return out;
  } catch { return fb; }
}

// ── Google Places ─────────────────────────────────────────────────────────────
export interface Business {
  placeId: string; name: string; address: string;
  rating: number | null; reviewCount: number;
  phone: string | null; callRef: string | null;
  website: string | null; openNow: boolean | null; distance: string | null;
}

function haversine(la1: number, lo1: number, la2: number, lo2: number) {
  const R = 3958.8, d = (x: number) => x * Math.PI / 180;
  const a = Math.sin(d(la2-la1)/2)**2 + Math.cos(d(la1))*Math.cos(d(la2))*Math.sin(d(lo2-lo1)/2)**2;
  return (R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(1);
}

export async function searchPlaces(query: string, lat: number, lng: number): Promise<Business[]> {
  const key = import.meta.env.GOOGLE_PLACES_API_KEY; if (!key) return [];
  const r = redis();
  const ck = `ss:simple:v1:${normQ(query)}:${Math.round(lat*100)}:${Math.round(lng*100)}`;

  if (r) {
    const c = await r.get<Business[]>(ck).catch(() => null);
    if (c) return c;
  }

  const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.websiteUri,places.currentOpeningHours,places.location,places.businessStatus' },
    body: JSON.stringify({ textQuery: query, locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 40000 } }, maxResultCount: 8, openNow: true }),
  }).catch(() => null);

  if (!res?.ok) return [];
  const data = await res.json();

  const results: Business[] = await Promise.all(
    ((data.places || []) as any[]).filter((p: any) => p.businessStatus === 'OPERATIONAL').slice(0, 6)
      .map(async (p: any) => {
        const phone = p.nationalPhoneNumber || null;
        return { placeId: p.id, name: p.displayName?.text || '', address: p.formattedAddress || '', rating: p.rating ?? null, reviewCount: p.userRatingCount ?? 0, phone, callRef: phone ? await makeCallRef(phone) : null, website: p.websiteUri || null, openNow: p.currentOpeningHours?.openNow ?? null, distance: p.location ? haversine(lat, lng, p.location.latitude, p.location.longitude) + ' mi' : null };
      })
  );

  if (r && results.length) await r.set(ck, results, { ex: 60*60*4 }).catch(() => null);
  return results;
}
