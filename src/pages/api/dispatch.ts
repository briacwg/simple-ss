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
  /** Consumer phone for review follow-up (may be null). */
  consumerPhone: string | null;
  problem: string;
  location: string;
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

export const DISPATCH_TTL      = 60 * 60 * 48; // 48 hours
const        PHONE_INDEX_TTL   = 60 * 30;       // 30 min — refreshed as queue advances
const        TIMEOUT_DELAY_SEC = 60 * 5;        // 5 min per business response window

// ── Supply-adaptive window ────────────────────────────────────────────────────

type SupplyLevel = 'high' | 'normal' | 'low';

/** Classifies local supply based on the number of available businesses. */
function getSupplyLevel(count: number): SupplyLevel {
  if (count >= 4) return 'high';
  if (count >= 2) return 'normal';
  return 'low';
}

/**
 * Returns how many businesses to contact simultaneously for a given supply level.
 * High supply → 1 (quality over quantity); low supply → notify all available.
 */
function getDispatchWidth(level: SupplyLevel): number {
  if (level === 'high')   return 1;
  if (level === 'normal') return 2;
  return 3; // low — cast the widest net
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
  const allBusinesses = [
    { phone: primaryPhone, name: primaryName },
    ...additionalResolved,
  ];

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

  const record: DispatchRecord = {
    dispatchId,
    businessPhone:      primaryPhone,
    businessName:       primaryName,
    businessQueue,
    currentQueueIndex:  0,
    supplyLevel,
    consumerPhone,
    problem,
    location,
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
    notifySlice.map(b => sendLeadSms(b.phone, b.name, problem, location).catch(() => false)),
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

    // Schedule a per-business timeout via QStash (auto-advance if no reply in 5 min)
    await Promise.all(
      notifySlice.map((b, i) =>
        smsSentResults[i]
          ? scheduleDispatchTimeout(dispatchId, b.phone).catch(() => null)
          : Promise.resolve(),
      ),
    );
  }

  // Schedule review follow-up 24h from now (only when consumer phone is known)
  if (consumerPhone) {
    await scheduleReviewFollowup(dispatchId).catch(() => null);
  }

  return json({ dispatchId, supplyLevel, notified: notifySlice.length });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Sends an outreach SMS to a business announcing a new lead. */
async function sendLeadSms(
  to: string,
  businessName: string,
  problem: string,
  location: string,
): Promise<boolean> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return false;

  const lines = [
    `ServiceSurfer: New lead for ${businessName}!`,
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

/** Schedules a QStash timeout job to auto-advance the queue if a business doesn't respond. */
async function scheduleDispatchTimeout(dispatchId: string, businessPhone: string): Promise<void> {
  const qstashUrl   = import.meta.env.QSTASH_URL;
  const qstashToken = import.meta.env.QSTASH_TOKEN;
  const siteUrl     = import.meta.env.PUBLIC_SITE_URL;
  if (!qstashUrl || !qstashToken || !siteUrl) return;

  await fetch(`${qstashUrl}/v2/publish/${encodeURIComponent(`${siteUrl}/api/internal/dispatch-timeout`)}`, {
    method:  'POST',
    headers: {
      Authorization:    `Bearer ${qstashToken}`,
      'Content-Type':   'application/json',
      'Upstash-Delay':  `${TIMEOUT_DELAY_SEC}s`,
    },
    body: JSON.stringify({ dispatchId, businessPhone }),
  });
}

/** Schedules a QStash review follow-up job 24 hours from now. */
async function scheduleReviewFollowup(dispatchId: string): Promise<void> {
  const qstashUrl   = import.meta.env.QSTASH_URL;
  const qstashToken = import.meta.env.QSTASH_TOKEN;
  const siteUrl     = import.meta.env.PUBLIC_SITE_URL;
  if (!qstashUrl || !qstashToken || !siteUrl) return;

  await fetch(`${qstashUrl}/v2/publish/${encodeURIComponent(`${siteUrl}/api/jobs/review-followup`)}`, {
    method:  'POST',
    headers: {
      Authorization:   `Bearer ${qstashToken}`,
      'Content-Type':  'application/json',
      'Upstash-Delay': `${60 * 60 * 24}s`,
    },
    body: JSON.stringify({ dispatchId }),
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
