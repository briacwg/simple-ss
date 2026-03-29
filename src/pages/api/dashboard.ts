/**
 * GET /api/dashboard?phone=+15551234567
 *
 * Business performance dashboard — returns 30-day rolling metrics for a
 * verified business phone.
 *
 * Resolution order:
 *   1. business_dashboard_metrics cache (updated_at < 1 hour stale → instant)
 *   2. Live query of lead_events + dispatch_training_events (~200ms)
 *
 * Returned metrics:
 *   leads_30d         — total dispatch_sent events (new leads received)
 *   calls_30d         — total call_initiated events
 *   dispatches_30d    — total leads dispatched via SMS
 *   accepted_30d      — leads accepted
 *   declined_30d      — leads declined
 *   timeout_30d       — leads that timed out
 *   acceptance_rate   — accepted / (accepted + declined + timeout)
 *   avg_response_ms   — average time from SMS to YES reply
 *   top_service_labels — top 5 service categories by lead volume
 */

import type { APIRoute } from 'astro';
import { normalizePhone } from '../../lib';
import { getSupabase } from '../../lib/supabase';
import { getBusinessSession } from '../../lib/session';

export const prerender = false;

const CACHE_STALE_MS = 60 * 60 * 1000; // 1 hour

export const GET: APIRoute = async ({ url, request }) => {
  // Require a valid business session token when BUSINESS_JWT_SECRET is configured.
  // Falls through in local dev (no secret set) to allow unauthenticated access.
  const jwtSecret = import.meta.env.BUSINESS_JWT_SECRET || import.meta.env.DISPATCH_JOB_SECRET;
  if (jwtSecret) {
    const session = await getBusinessSession(request);
    if (!session) return err('unauthorized — valid business session required', 401);
  }

  const rawPhone = url.searchParams.get('phone');
  if (!rawPhone) return err('phone query param required', 400);

  const phone = normalizePhone(rawPhone);
  if (!phone) return err('invalid phone number', 400);

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // 1. Check metrics cache
  const { data: cached } = await sb
    .from('business_dashboard_metrics')
    .select('*')
    .eq('business_phone', phone)
    .single()
    .catch(() => ({ data: null }));

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < CACHE_STALE_MS) {
      return json({ ...cached, acceptance_rate: computeRate(cached), cached: true });
    }
  }

  // 2. Compute fresh metrics from lead_events
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [eventsResult, trainingResult] = await Promise.all([
    sb
      .from('lead_events')
      .select('event_type, service_label, created_at')
      .eq('business_phone', phone)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(1000),
    sb
      .from('dispatch_training_events')
      .select('outcome, response_ms, service_label')
      .eq('business_phone', phone)
      .gte('created_at', since)
      .limit(1000),
  ]);

  const events   = eventsResult.data   ?? [];
  const training = trainingResult.data ?? [];

  // Aggregate event counts
  const counts: Record<string, number> = {};
  const labelCounts: Record<string, number> = {};
  for (const e of events) {
    counts[e.event_type] = (counts[e.event_type] ?? 0) + 1;
    if (e.service_label) {
      labelCounts[e.service_label] = (labelCounts[e.service_label] ?? 0) + 1;
    }
  }

  // Average response time from accepted training events
  const acceptedMs = training
    .filter(t => t.outcome === 'accepted' && t.response_ms != null)
    .map(t => t.response_ms as number);
  const avgResponseMs = acceptedMs.length
    ? Math.round(acceptedMs.reduce((a, b) => a + b, 0) / acceptedMs.length)
    : null;

  // Top 5 service labels by volume
  const topServiceLabels = Object.entries(labelCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([label]) => label);

  const metrics = {
    business_phone:     phone,
    leads_30d:          counts['dispatch_sent']    ?? 0,
    calls_30d:          counts['call_initiated']   ?? 0,
    dispatches_30d:     counts['dispatch_sent']    ?? 0,
    accepted_30d:       counts['dispatch_accepted'] ?? 0,
    declined_30d:       counts['dispatch_declined'] ?? 0,
    timeout_30d:        counts['dispatch_timeout']  ?? 0,
    avg_response_ms:    avgResponseMs,
    top_service_labels: topServiceLabels,
    updated_at:         new Date().toISOString(),
  };

  // Upsert the cache
  await sb
    .from('business_dashboard_metrics')
    .upsert(metrics, { onConflict: 'business_phone' })
    .catch(() => null);

  return json({ ...metrics, acceptance_rate: computeRate(metrics), cached: false });
};

function computeRate(m: { accepted_30d: number; declined_30d: number; timeout_30d: number }): number | null {
  const total = m.accepted_30d + m.declined_30d + m.timeout_30d;
  if (total === 0) return null;
  return Math.round((m.accepted_30d / total) * 1000) / 10; // percentage, 1 decimal place
}

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
