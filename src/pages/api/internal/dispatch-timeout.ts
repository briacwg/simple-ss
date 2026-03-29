/**
 * POST /api/internal/dispatch-timeout
 *
 * QStash webhook — fires after the supply-adaptive response window (20/45/90 s)
 * expires for a notified business.  If the business has not replied YES, their
 * queue entry is marked as timed out and the dispatch advances to the next
 * business in the queue, which receives a fresh timeout of its own.
 *
 * This endpoint is internal-only: it is never called by the consumer frontend.
 * Requests are authorized with a DISPATCH_JOB_SECRET bearer token to prevent
 * unauthorized queue manipulation.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../../lib';
import { DK, BPDK, DISPATCH_TTL, type DispatchRecord } from '../dispatch';
import { advanceQueue } from '../webhooks/sms-inbound';
import { logTrainingEvent, logLeadEvent } from '../../../lib/supabase';
import { json, err } from '../../../lib/api-helpers';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  // Verify the caller is authorized (QStash sets this from the scheduled job)
  const jobSecret = import.meta.env.DISPATCH_JOB_SECRET;
  if (jobSecret) {
    const auth = request.headers.get('Authorization') || '';
    if (auth !== `Bearer ${jobSecret}`) return err('unauthorized', 401);
  }

  const body = await request.json().catch(() => null);
  if (!body?.dispatchId || !body?.businessPhone) return err('dispatchId and businessPhone required', 400);

  const dispatchId    = String(body.dispatchId).slice(0, 64);
  const businessPhone = String(body.businessPhone).slice(0, 20);

  const r = redis();
  if (!r) return err('redis unavailable', 503);

  const raw = await r.get<string | DispatchRecord>(DK(dispatchId)).catch(() => null);
  if (!raw) return json({ ok: true, skipped: 'dispatch_not_found' });

  const record: DispatchRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // If the lead was already accepted or exhausted, nothing to do
  if (record.status === 'accepted' || record.status === 'declined_all') {
    return json({ ok: true, skipped: `already_${record.status}` });
  }

  // Find the queue entry for this business
  const queueIdx = record.businessQueue.findIndex(b => b.phone === businessPhone);
  if (queueIdx === -1) return json({ ok: true, skipped: 'business_not_in_queue' });

  const entry = record.businessQueue[queueIdx]!;

  // Skip if the business already responded (beat the timeout)
  if (entry.response === 'accepted' || entry.response === 'declined') {
    return json({ ok: true, skipped: `already_${entry.response}` });
  }

  // Mark as timed out and advance the queue
  const updatedQueue = record.businessQueue.map((b, i) =>
    i === queueIdx ? { ...b, response: 'timeout' as const } : b,
  );
  const updated: DispatchRecord = { ...record, businessQueue: updatedQueue };

  // Remove the stale phone index
  await r.del(BPDK(businessPhone)).catch(() => null);
  await r.set(DK(dispatchId), JSON.stringify(updated), { ex: DISPATCH_TTL }).catch(() => null);

  // Log training event and lead event for timeout outcome
  const responseMs = entry.notifiedAt ? Date.now() - entry.notifiedAt : null;
  await Promise.all([
    logTrainingEvent({
      dispatch_id:    dispatchId,
      business_phone: businessPhone,
      service_label:  record.serviceLabel ?? null,
      location_cell:  record.locationCell ?? null,
      supply_level:   record.supplyLevel,
      window_seconds: record.windowSeconds,
      outcome:        'timeout',
      response_ms:    null,
      queue_position: queueIdx,
    }).catch(() => null),
    logLeadEvent({
      dispatch_id:    dispatchId,
      business_phone: businessPhone,
      event_type:     'dispatch_timeout',
      service_label:  record.serviceLabel ?? null,
      location_cell:  record.locationCell ?? null,
      consumer_phone: record.consumerPhone,
      meta:           { supplyLevel: record.supplyLevel, queuePosition: queueIdx, windowSeconds: record.windowSeconds, responseMs },
    }).catch(() => null),
  ]);

  // Advance to next business — this function handles queue exhaustion and consumer notification
  await advanceQueue(r, updated, queueIdx);

  return json({ ok: true, advanced: true });
};

