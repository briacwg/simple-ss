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
import { getSupabase, type BusinessDashboardMetrics } from '../../lib/supabase';
import { getBusinessSession } from '../../lib/session';
import { json, err } from '../../lib/api-helpers';
import { upsertBusinessProfile } from '../../lib/vector';

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
  const cacheResult = await sb
    .from('business_dashboard_metrics')
    .select('*')
    .eq('business_phone', phone)
    .single()
    .then(r => r, () => ({ data: null, error: null }));
  const cached = (cacheResult.data ?? null) as BusinessDashboardMetrics | null;

  if (cached) {
    const age = Date.now() - new Date(cached.updated_at).getTime();
    if (age < CACHE_STALE_MS) {
      const rate = computeRate(cached);
      return json({ ...cached, acceptance_rate: rate, performance_score: computeScore(cached, rate), cached: true });
    }
  }

  // 2. Compute fresh metrics via the Supabase stored function (single round-trip).
  // Falls back to JavaScript aggregation if the RPC is unavailable.
  const rpcResult = await Promise.resolve(
    (sb as unknown as { rpc: (fn: string, args?: Record<string, unknown>) => PromiseLike<{ error: unknown }> })
      .rpc('refresh_dashboard_metrics', { p_phone: phone })
  ).then(r => r, () => null);

  if (rpcResult && !rpcResult.error) {
    // RPC upserted the metrics row — re-fetch and return.
    const freshResult = await sb
      .from('business_dashboard_metrics')
      .select('*')
      .eq('business_phone', phone)
      .single()
      .then(r => r, () => ({ data: null, error: null }));
    const fresh = (freshResult.data ?? null) as BusinessDashboardMetrics | null;
    if (fresh) {
      const rate  = computeRate(fresh);
      const score = computeScore(fresh, rate);
      pushBusinessProfile(phone, fresh, rate, score);
      return json({ ...fresh, acceptance_rate: rate, performance_score: score, cached: false });
    }
  }

  // Fallback: JS aggregation from lead_events + dispatch_training_events
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

  type EventRow    = { event_type: string; service_label: string | null; created_at: string };
  type TrainingRow = { outcome: string; response_ms: number | null; service_label: string | null };

  const events   = (eventsResult.data   ?? []) as unknown as EventRow[];
  const training = (trainingResult.data ?? []) as unknown as TrainingRow[];

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
    leads_30d:          counts['dispatch_sent']     ?? 0,
    calls_30d:          counts['call_initiated']    ?? 0,
    dispatches_30d:     counts['dispatch_sent']     ?? 0,
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
    .upsert(metrics as never, { onConflict: 'business_phone' })
    .then(() => null, () => null);

  const rate  = computeRate(metrics);
  const score = computeScore(metrics, rate);

  // Keep business vector profile in sync (non-blocking)
  pushBusinessProfile(phone, metrics, rate, score);

  return json({ ...metrics, acceptance_rate: rate, performance_score: score, cached: false });
};

function computeRate(m: { accepted_30d: number; declined_30d: number; timeout_30d: number }): number | null {
  const total = m.accepted_30d + m.declined_30d + m.timeout_30d;
  if (total === 0) return null;
  return Math.round((m.accepted_30d / total) * 1000) / 10; // percentage, 1 decimal place
}

/** Pushes a business performance profile to Upstash Vector (non-blocking). */
function pushBusinessProfile(
  phone: string,
  m: BusinessDashboardMetrics,
  acceptanceRate: number | null,
  performanceScore: number | null,
): void {
  upsertBusinessProfile({
    phone,
    name:             phone, // name not available here — will be enriched if profile already exists
    acceptanceRate:   acceptanceRate != null ? acceptanceRate / 100 : 0,
    avgResponseMs:    m.avg_response_ms,
    topServices:      m.top_service_labels ?? [],
    performanceScore: performanceScore,
    updatedAt:        new Date().toISOString(),
  });
}

/**
 * Composite 0–100 performance score.
 *   85% weighted from acceptance rate
 *   15% speed bonus: <30s → 15pts, <60s → 10pts, <2min → 5pts
 * Returns null when fewer than 3 data points exist.
 */
function computeScore(
  m: { accepted_30d: number; declined_30d: number; timeout_30d: number; avg_response_ms: number | null },
  acceptanceRate: number | null,
): number | null {
  const total = m.accepted_30d + m.declined_30d + m.timeout_30d;
  if (total < 3 || acceptanceRate == null) return null;
  let speedBonus = 0;
  if (m.avg_response_ms != null) {
    if (m.avg_response_ms < 30_000)  speedBonus = 15;
    else if (m.avg_response_ms < 60_000)  speedBonus = 10;
    else if (m.avg_response_ms < 120_000) speedBonus = 5;
  }
  return Math.min(100, Math.round(acceptanceRate * 0.85 + speedBonus));
}

