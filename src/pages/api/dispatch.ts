/**
 * POST /api/dispatch
 *
 * Records a lead dispatch after a consumer matches with a business, then:
 *   1. Stores a DispatchRecord in Redis (48h TTL) for audit and follow-up.
 *   2. Sends an SMS alert to the matched business via Twilio.
 *   3. Schedules a review follow-up job via QStash (fires 24h later).
 *
 * This endpoint is called client-side immediately after the user taps "Call",
 * in parallel with the tel: link being opened — so it must be fast and
 * non-blocking (failures should not interrupt the call flow).
 */

import type { APIRoute } from 'astro';
import { resolveCallRef, redis } from '../../lib';

export const prerender = false;

export interface DispatchRecord {
  dispatchId: string;
  businessPhone: string;
  businessName: string;
  consumerPhone: string | null;
  problem: string;
  location: string;
  createdAt: number;
  smsSentAt: number | null;
  reviewSentAt: number | null;
  status: 'pending' | 'sms_sent' | 'review_sent';
}

/** Redis key for a dispatch record. */
const DK = (id: string) => `ss:dispatch:${id}`;
const DISPATCH_TTL = 60 * 60 * 48; // 48 hours

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.callRef) return err('callRef required', 400);

  // Resolve HMAC-signed call reference → raw business phone
  const businessPhone = await resolveCallRef(String(body.callRef));
  if (!businessPhone) return err('invalid callRef', 400);

  const businessName = String(body.businessName || 'Business').slice(0, 120);
  const problem      = String(body.problem || '').slice(0, 200);
  const location     = String(body.location || '').slice(0, 120);
  const consumerPhone = body.consumerPhone
    ? String(body.consumerPhone).replace(/[^\d+]/g, '').slice(0, 16) || null
    : null;

  const dispatchId = `dp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  const record: DispatchRecord = {
    dispatchId,
    businessPhone,
    businessName,
    consumerPhone,
    problem,
    location,
    createdAt: now,
    smsSentAt: null,
    reviewSentAt: null,
    status: 'pending',
  };

  // Persist dispatch record — failures are non-fatal
  const r = redis();
  if (r) {
    await r.set(DK(dispatchId), JSON.stringify(record), { ex: DISPATCH_TTL }).catch(() => null);
  }

  // Send business SMS alert (fire-and-forget — don't block response)
  const smsSent = await sendBusinessSms(businessPhone, businessName, problem, location).catch(() => false);
  if (smsSent && r) {
    await r.set(
      DK(dispatchId),
      JSON.stringify({ ...record, smsSentAt: Date.now(), status: 'sms_sent' as const }),
      { ex: DISPATCH_TTL },
    ).catch(() => null);
  }

  // Schedule QStash review follow-up 24h from now
  await scheduleReviewFollowup(dispatchId).catch(() => null);

  return json({ dispatchId });
};

// ── Twilio SMS helper ─────────────────────────────────────────────────────────

async function sendBusinessSms(
  to: string,
  businessName: string,
  problem: string,
  location: string,
): Promise<boolean> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return false;

  const bridge = import.meta.env.PUBLIC_SERVICE_SURFER_CALL_NUMBER || '';
  const body = [
    `ServiceSurfer: New lead for ${businessName}!`,
    problem ? `Problem: ${problem}` : null,
    location ? `Location: ${location}` : null,
    bridge ? `Consumer is ready — they'll call ${bridge} to connect.` : null,
  ].filter(Boolean).join('\n');

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    },
  );
  return res.ok;
}

// ── QStash scheduling helper ──────────────────────────────────────────────────

async function scheduleReviewFollowup(dispatchId: string): Promise<void> {
  const qstashUrl   = import.meta.env.QSTASH_URL;
  const qstashToken = import.meta.env.QSTASH_TOKEN;
  const siteUrl     = import.meta.env.PUBLIC_SITE_URL;
  if (!qstashUrl || !qstashToken || !siteUrl) return;

  const callbackUrl = `${siteUrl}/api/jobs/review-followup`;
  const delaySeconds = 60 * 60 * 24; // 24 hours

  await fetch(`${qstashUrl}/v2/publish/${encodeURIComponent(callbackUrl)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${qstashToken}`,
      'Content-Type': 'application/json',
      'Upstash-Delay': `${delaySeconds}s`,
    },
    body: JSON.stringify({ dispatchId }),
  });
}

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
