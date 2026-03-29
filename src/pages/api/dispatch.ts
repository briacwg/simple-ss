/**
 * POST /api/dispatch
 *
 * Supply-adaptive dispatch engine: records a lead and notifies matched businesses
 * via Twilio SMS, scaling the outreach width to local supply conditions.
 *
 * Supply-adaptive window logic:
 *   high supply  (≥4 businesses in area) → notify top 1 pro only
 *   normal supply (2–3 businesses)       → notify top 2 pros simultaneously
 *   low supply   (0–1 businesses)        → notify all available pros
 *
 * After notifying each batch, a 5-minute QStash timeout is queued per business.
 * If a business does not reply YES within that window, /api/internal/dispatch-timeout
 * auto-advances the queue to the next pro.
 *
 * The full dispatch queue is stored in Redis so that /api/webhooks/sms-inbound can
 * process YES/NO replies and advance through the queue.
 */

import type { APIRoute } from 'astro';
import { resolveCallRef, redis, normalizePhone } from '../../lib';
import { logLeadEvent } from '../../lib/supabase';
import { reRankByAcceptance } from '../../lib/smart-rank';
import { scoreLeadUrgency, urgencySmsPrefix } from '../../lib/lead-score';
import { scheduleDispatchTimeout as qScheduleTimeout, scheduleReviewFollowup as qScheduleReview } from '../../lib/qstash';

export const prerender = false;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A single business entry in the dispatch queue. */
export interface QueuedBusiness {
  /** E.164 business phone number. */
  phone: string;
  /** Display name used in SMS and TTS. */
  name: string;
  /** Unix timestamp (ms) when the outreach SMS was sent, or null if not yet sent. */
  notifiedAt: number | null;
  /** Business's reply status. */
  response: 'pending' | 'accepted' | 'declined' | 'timeout' | null;
}

/** Full state of a lead dispatch, persisted in Redis. */
export interface DispatchRecord {
  dispatchId: string;
  /** Phone of the currently active (most recently notified) business. */
  businessPhone: string;
  /** Name of the currently active business. */
  businessName: string;
  /** Ordered list of all businesses in this dispatch, current first. */
  businessQueue: QueuedBusiness[];
  /** Index into businessQueue of the currently active business. */
  currentQueueIndex: number;
  /** Supply level computed at dispatch time. */
  supplyLevel: 'high' | 'normal' | 'low';
  /** Response window per business in seconds (20 / 45 / 90). */
  windowSeconds: number;
  /** Consumer phone for review follow-up (may be null). */
  consumerPhone: string | null;
  problem: string;
  location: string;
  /** Service category label (e.g. "plumber") — used for training analytics. */
  serviceLabel: string | null;
  /** Location grid cell (e.g. "418:-876") — used for training analytics. */
  locationCell: string | null;
  createdAt: number;
  smsSentAt: number | null;
  acceptedAt: number | null;
  /** Phone of the business that accepted the lead. */
  acceptedBy: string | null;
  reviewSentAt: number | null;
  status: 'pending' | 'sms_sent' | 'accepted' | 'declined_all' | 'review_sent';
}

// ── Redis key helpers ─────────────────────────────────────────────────────────

export const DK   = (id: string)    => `ss:dispatch:${id}`;
export const BPDK = (phone: string) => `ss:dispatch:by-phone:${phone}`;

export const DISPATCH_TTL    = 60 * 60 * 48; // 48 hours
const        PHONE_INDEX_TTL = 60 * 30;       // 30 min — refreshed as queue advances

// ── Supply-adaptive window ────────────────────────────────────────────────────
//
// Response window and dispatch width scale inversely with local supply:
//   Low supply  (<5 pros)  → 90s window, notify up to 3 simultaneously
//   Normal supply (<20)    → 45s window, notify up to 2 simultaneously
//   High supply (≥20)      → 20s window, notify top 1 (fast market)
//
// This matches the main ServiceSurfer platform's getSupplyWindow() spec exactly.

type SupplyLevel = 'high' | 'normal' | 'low';

/** Classifies local supply level from the total number of available pros. */
function getSupplyLevel(count: number): SupplyLevel {
  if (count >= 20) return 'high';
  if (count >= 5)  return 'normal';
  return 'low';
}

/**
 * Returns the per-business response window in seconds.
 *
 * Mirrors the main app's tiered window spec:
 *   <5 pros  → 90s  (scarce market — give each pro time to respond)
 *   <20 pros → 45s  (moderate market)
 *   ≥20 pros → 20s  (dense market — consumers expect near-instant matching)
 */
export function getWindowSeconds(totalPros: number): number {
  if (totalPros < 5)  return 90;
  if (totalPros < 20) return 45;
  return 20;
}

/**
 * Returns how many businesses to contact simultaneously based on supply level.
 * High supply → 1 (quality); low supply → notify all available (breadth).
 */
function getDispatchWidth(level: SupplyLevel): number {
  if (level === 'high')   return 1;
  if (level === 'normal') return 2;
  return 3; // low supply — cast the widest net
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.callRef) return err('callRef required', 400);

  // Resolve the primary (top-ranked) business phone
  const primaryPhone = await resolveCallRef(String(body.callRef));
  if (!primaryPhone) return err('invalid callRef', 400);

  const primaryName = String(body.businessName || 'Business').slice(0, 120);
  const problem     = String(body.problem || '').slice(0, 200);
  const location    = String(body.location || '').slice(0, 120);
  const consumerPhone = body.consumerPhone
    ? normalizePhone(String(body.consumerPhone)) ?? null
    : null;

  // Build the full ranked queue from additionalBusinesses (fallback candidates)
  const additionalRaw: Array<{ callRef: string; name: string }> =
    Array.isArray(body.additionalBusinesses) ? body.additionalBusinesses.slice(0, 5) : [];

  const additionalResolved = await Promise.all(
    additionalRaw.map(async b => {
      const phone = await resolveCallRef(String(b.callRef || '')).catch(() => null);
      return phone ? { phone, name: String(b.name || 'Business').slice(0, 120) } : null;
    }),
  ).then(r => r.filter((b): b is { phone: string; name: string } => b !== null));

  // Full ranked queue: primary first, then fallback candidates
  const rawBusinesses = [
    { phone: primaryPhone, name: primaryName },
    ...additionalResolved,
  ];

  // Score lead urgency for enriched SMS messaging
  const urgency = scoreLeadUrgency(problem);

  // Re-rank by historical acceptance rates from training data (1s timeout)
  const serviceLabel = body.serviceLabel ? String(body.serviceLabel).slice(0, 80) : null;
  const locationCell = body.lat != null && body.lng != null
    ? `${Math.round(Number(body.lat) * 10)}:${Math.round(Number(body.lng) * 10)}`
    : null;

  const allBusinesses = await Promise.race([
    reRankByAcceptance(rawBusinesses, serviceLabel, locationCell),
    new Promise<typeof rawBusinesses>(resolve => setTimeout(() => resolve(rawBusinesses), 1000)),
  ]);

  const supplyLevel  = getSupplyLevel(allBusinesses.length);
  const dispatchWidth = getDispatchWidth(supplyLevel);

  // Build QueuedBusiness array — first `dispatchWidth` entries get notified immediately
  const businessQueue: QueuedBusiness[] = allBusinesses.map((b, i) => ({
    phone:       b.phone,
    name:        b.name,
    notifiedAt:  i < dispatchWidth ? Date.now() : null,
    response:    i < dispatchWidth ? 'pending' : null,
  }));

  const dispatchId = `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now        = Date.now();

  const windowSec = getWindowSeconds(allBusinesses.length);

  const record: DispatchRecord = {
    dispatchId,
    businessPhone:      primaryPhone,
    businessName:       primaryName,
    businessQueue,
    currentQueueIndex:  0,
    supplyLevel,
    windowSeconds:      windowSec,
    consumerPhone,
    problem,
    location,
    serviceLabel,
    locationCell,
    createdAt:    now,
    smsSentAt:    null,
    acceptedAt:   null,
    acceptedBy:   null,
    reviewSentAt: null,
    status:       'pending',
  };

  const r = redis();
  if (r) {
    await r.set(DK(dispatchId), JSON.stringify(record), { ex: DISPATCH_TTL }).catch(() => null);
  }

  // Notify the first `dispatchWidth` businesses simultaneously
  const notifySlice = businessQueue.slice(0, dispatchWidth);
  const smsSentResults = await Promise.all(
    notifySlice.map(b => sendLeadSms(b.phone, b.name, problem, location, urgency).catch(() => false)),
  );
  const anySent = smsSentResults.some(Boolean);

  if (anySent && r) {
    const updated: DispatchRecord = { ...record, smsSentAt: Date.now(), status: 'sms_sent' };
    await r.set(DK(dispatchId), JSON.stringify(updated), { ex: DISPATCH_TTL }).catch(() => null);

    // Index each notified business phone → dispatchId for SMS reply lookup
    await Promise.all(
      notifySlice.map((b, i) =>
        smsSentResults[i] && r
          ? r.set(BPDK(b.phone), dispatchId, { ex: PHONE_INDEX_TTL }).catch(() => null)
          : Promise.resolve(),
      ),
    );

    // Schedule a per-business timeout — window is 20/45/90s based on supply
    const windowSec = getWindowSeconds(allBusinesses.length);
    await Promise.all(
      notifySlice.map((b, i) =>
        smsSentResults[i]
          ? scheduleDispatchTimeout(dispatchId, b.phone, windowSec).catch(() => null)
          : Promise.resolve(),
      ),
    );
  }

  // Schedule review follow-up 24h from now (only when consumer phone is known)
  if (consumerPhone) {
    await scheduleReviewFollowup(dispatchId).catch(() => null);
  }

  // Log dispatch_sent lead events for each notified business (analytics + training)
  await Promise.all(
    notifySlice.map((b, i) =>
      smsSentResults[i]
        ? logLeadEvent({
            dispatch_id:    dispatchId,
            business_phone: b.phone,
            event_type:     'dispatch_sent',
            service_label:  serviceLabel,
            location_cell:  locationCell,
            consumer_phone: consumerPhone,
            meta:           { supplyLevel, queuePosition: i, windowSeconds: windowSec, urgencyTier: urgency.tier, urgencyScore: urgency.score },
          }).catch(() => null)
        : Promise.resolve(),
    ),
  );

  return json({ dispatchId, supplyLevel, notified: notifySlice.length, windowSeconds: windowSec, urgencyTier: urgency.tier });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sends an outreach SMS to a business announcing a new lead. */
async function sendLeadSms(
  to: string,
  businessName: string,
  problem: string,
  location: string,
  urgency?: import('../../lib/lead-score').LeadScore,
): Promise<boolean> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return false;

  const header = urgency
    ? urgencySmsPrefix(urgency, businessName)
    : `ServiceSurfer: New lead for ${businessName}!`;

  const lines = [
    header,
    problem  ? `Problem: ${problem}`   : null,
    location ? `Location: ${location}` : null,
    'Reply YES to accept this lead or NO to pass.',
  ].filter(Boolean);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Basic ${btoa(`${sid}:${token}`)}`,
      },
      body: new URLSearchParams({ To: to, From: from, Body: lines.join('\n') }).toString(),
    },
  );
  return res.ok;
}

/** Delegates to lib/qstash.ts — schedules per-business timeout via QStash. */
async function scheduleDispatchTimeout(
  dispatchId: string,
  businessPhone: string,
  windowSeconds: number,
): Promise<void> {
  const siteUrl   = import.meta.env.PUBLIC_SITE_URL;
  const jobSecret = import.meta.env.DISPATCH_JOB_SECRET ?? '';
  if (!siteUrl) return;
  await qScheduleTimeout(dispatchId, businessPhone, windowSeconds, siteUrl, jobSecret);
}

/** Delegates to lib/qstash.ts — schedules the 24h review follow-up. */
async function scheduleReviewFollowup(dispatchId: string): Promise<void> {
  const siteUrl = import.meta.env.PUBLIC_SITE_URL;
  if (!siteUrl) return;
  await qScheduleReview(dispatchId, siteUrl);
}

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
