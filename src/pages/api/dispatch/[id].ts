/**
 * GET /api/dispatch/[id]
 *
 * Consumer-facing dispatch status endpoint — polled by the UI after a lead is
 * submitted via POST /api/dispatch to track acceptance in near-real-time.
 *
 * Security model
 * ──────────────
 * The dispatch ID itself is an opaque bearer token: `dp_{ms}_{12-char-uuid-hex}`.
 * Guessing one requires ~62^12 ≈ 3.2 × 10^21 attempts — effectively unguessable.
 * No additional auth header is required for consumer-side polling.
 *
 * Privacy
 * ───────
 * Business phone numbers, consumer phone numbers, call session PINs, and the
 * full business queue are NEVER returned.  Only the fields the UI needs to
 * render progress feedback are exposed.
 *
 * Caching
 * ───────
 * Responses are not cached (Cache-Control: no-store) because status changes
 * happen on the order of seconds and stale data degrades the consumer UX.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../../lib';
import { json, err } from '../../../lib/api-helpers';
import type { DispatchRecord } from '../dispatch';

export const prerender = false;

// Validate that the id param looks like a real dispatch ID before hitting Redis.
const DISPATCH_ID_RE = /^dp_\d{13,16}_[a-f0-9]{8,16}$/;

export const GET: APIRoute = async ({ params }) => {
  const { id } = params;
  if (!id || !DISPATCH_ID_RE.test(id)) return err('invalid dispatch ID', 400);

  const r = redis();
  if (!r) return err('service unavailable', 503);

  const raw = await r.get<string>(`ss:dispatch:${id}`).catch(() => null);
  if (!raw) return err('not found', 404);

  let record: DispatchRecord;
  try {
    record = (typeof raw === 'string' ? JSON.parse(raw) : raw) as DispatchRecord;
  } catch {
    return err('invalid record', 500);
  }

  // Surface the name of the accepting business — avoids exposing the phone number
  const acceptedByName = record.acceptedBy
    ? (record.businessQueue.find(b => b.phone === record.acceptedBy)?.name ?? null)
    : null;

  const statusRes = new Response(
    JSON.stringify({
      dispatchId:     record.dispatchId,
      status:         record.status,            // 'pending' | 'sms_sent' | 'accepted' | 'declined_all' | 'review_sent'
      supplyLevel:    record.supplyLevel,
      notified:       record.businessQueue.filter(b => b.notifiedAt !== null).length,
      acceptedByName,                            // null until a pro accepts
      createdAt:      record.createdAt,
      windowSeconds:  record.windowSeconds,
    }),
    {
      status:  200,
      headers: {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
    },
  );

  return statusRes;
};
