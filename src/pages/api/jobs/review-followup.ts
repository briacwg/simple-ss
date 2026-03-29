/**
 * POST /api/jobs/review-followup
 *
 * QStash webhook — fired automatically 24 hours after a lead dispatch.
 * Verifies the QStash request signature, loads the DispatchRecord from Redis,
 * and sends a review-request SMS to the consumer (if a phone number is on file).
 *
 * Configure via Upstash QStash — the dispatch endpoint publishes to this URL
 * with a 24h delay using QSTASH_URL + QSTASH_TOKEN.
 *
 * Signature verification uses QSTASH_CURRENT_SIGNING_KEY and
 * QSTASH_NEXT_SIGNING_KEY (key rotation is handled automatically).
 */

import type { APIRoute } from 'astro';
import { redis } from '../../../lib';
import type { DispatchRecord } from '../dispatch';
import { verifyQStashSignature } from '../../../lib/qstash';

export const prerender = false;

/** Redis key for a dispatch record — must match dispatch.ts. */
const DK = (id: string) => `ss:dispatch:${id}`;
const DISPATCH_TTL = 60 * 60 * 48;

export const POST: APIRoute = async ({ request }) => {
  // Verify QStash signature before trusting the payload
  const signatureValid = await verifyQStashSignature(request.clone());
  if (!signatureValid) return err('unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body?.dispatchId) return err('dispatchId required', 400);

  const dispatchId = String(body.dispatchId).slice(0, 64);

  const r = redis();
  if (!r) return err('redis unavailable', 503);

  // Load existing dispatch record
  const raw = await r.get<string | DispatchRecord>(DK(dispatchId)).catch(() => null);
  if (!raw) return err('dispatch not found', 404);

  const record: DispatchRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Skip if already sent or no consumer phone on record
  if (record.reviewSentAt) return json({ ok: true, skipped: 'already_sent' });
  if (!record.consumerPhone) return json({ ok: true, skipped: 'no_consumer_phone' });

  const smsSent = await sendReviewSms(
    record.consumerPhone,
    record.businessName,
    record.dispatchId,
  ).catch(() => false);

  if (smsSent) {
    const updated: DispatchRecord = { ...record, reviewSentAt: Date.now(), status: 'review_sent' };
    await r.set(DK(dispatchId), JSON.stringify(updated), { ex: DISPATCH_TTL }).catch(() => null);
  }

  return json({ ok: true, smsSent });
};

// ── QStash signature verification ────────────────────────────────────────────

// ── Twilio SMS helper ─────────────────────────────────────────────────────────

async function sendReviewSms(
  to: string,
  businessName: string,
  dispatchId: string,
): Promise<boolean> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  const site  = import.meta.env.PUBLIC_SITE_URL || 'https://servicesurfer.app';
  if (!sid || !token || !from) return false;

  const reviewLink = `${site}/review?d=${encodeURIComponent(dispatchId)}`;
  const body = [
    `ServiceSurfer: How was your experience with ${businessName}?`,
    `Leave a quick review and help others find great pros: ${reviewLink}`,
  ].join('\n');

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

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
