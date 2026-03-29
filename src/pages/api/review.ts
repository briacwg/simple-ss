/**
 * POST /api/review
 *
 * Consumer review submission — stores a star rating and optional comment for a
 * completed dispatch.  Linked from the review-request SMS sent 24 hours after
 * a business accepts a lead.
 *
 * Validation
 * ──────────
 * - dispatchId must resolve to an existing, accepted DispatchRecord in Redis.
 * - rating must be an integer in [1, 5].
 * - comment is optional (≤1000 characters).
 * - One review per dispatch: returns 409 if already reviewed.
 *
 * Persistence
 * ───────────
 * Reviews are stored in two places:
 *   1. The DispatchRecord in Redis (review embedded for quick lookup, 48h TTL).
 *   2. The `lead_events` table in Supabase (event_type = 'review_received') for
 *      long-term analytics and business dashboard aggregation.
 *
 * Rate limiting
 * ─────────────
 * One review per dispatch ID.  The Redis DispatchRecord already acts as a
 * natural dedup store — no additional rate-limit key is needed.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../lib';
import type { DispatchRecord } from './dispatch';
import { logLeadEvent } from '../../lib/supabase';
import { json, err } from '../../lib/api-helpers';

export const prerender = false;

const DK           = (id: string) => `ss:dispatch:${id}`;
const DISPATCH_TTL = 60 * 60 * 48;

/** Review embedded into a DispatchRecord. */
export interface DispatchReview {
  rating:    number;       // 1–5
  comment:   string | null;
  createdAt: number;       // Unix ms
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.dispatchId) return err('dispatchId required', 400);

  const dispatchId = String(body.dispatchId).slice(0, 64);
  const rating     = Number(body.rating);
  const comment    = body.comment ? String(body.comment).slice(0, 1000).trim() : null;

  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return err('rating must be an integer between 1 and 5', 400);
  }

  const r = redis();
  if (!r) return err('service unavailable', 503);

  // Load dispatch record
  const raw = await r.get<string | DispatchRecord>(DK(dispatchId)).catch(() => null);
  if (!raw) return err('dispatch not found or expired', 404);

  const record: DispatchRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Idempotency guard
  if ((record as DispatchRecord & { review?: DispatchReview }).review) {
    return err('review already submitted for this dispatch', 409);
  }

  // Dispatch must be in an accepted state to receive a review
  if (record.status !== 'accepted' && record.status !== 'review_sent') {
    return err('review can only be submitted for accepted dispatches', 422);
  }

  const review: DispatchReview = { rating, comment, createdAt: Date.now() };
  const updated = { ...record, review, status: 'review_received' as const };

  // Use the actual remaining TTL from Redis rather than a derived expiresAt field.
  // Falls back to the full 48h window when the TTL call fails or the key has no expiry.
  const ttlSeconds = await r.ttl(DK(dispatchId)).catch(() => -1);
  const ex = ttlSeconds > 60 ? ttlSeconds : DISPATCH_TTL;

  await r
    .set(DK(dispatchId), JSON.stringify(updated), { ex })
    .catch(() => null);

  // Log to Supabase for dashboard aggregation
  await logLeadEvent({
    dispatch_id:    dispatchId,
    business_phone: record.businessPhone,
    event_type:     'review_received',
    meta:           { rating, comment, businessName: record.businessName },
  }).catch(() => null);

  return json({ ok: true, rating, dispatchId });
};

