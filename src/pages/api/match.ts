/**
 * POST /api/match
 *
 * Three-layer matching pipeline:
 *
 *   Layer 1 — Deterministic intent engine (this file, <1ms, no I/O)
 *     inferServiceIntentHint() instantly maps common terms to canonical queries.
 *     Covers ~80% of searches with zero latency cost.
 *
 *   Layer 2 — Cerebras LLM (smartMatch, ~200–400ms)
 *     Handles nuanced / ambiguous descriptions, adds urgency/budget context,
 *     provides a human-readable service label for the UI heading.
 *
 *   Layer 3 — Website summarizer (separate /api/summarize endpoint)
 *     Client calls /api/summarize per-business after results arrive to enrich
 *     cards with a concise description of the business's specialisms.
 *
 * Execution strategy:
 *   1. Layer 1 intent fires synchronously — best initial query known immediately.
 *   2. Layer 2 (Cerebras) + initial Places search run in parallel.
 *   3. If the AI rewrites the query, a second Places search runs for that query.
 *   4. Results merged: AI results preferred; Layer 1 label used as fallback.
 */

import type { APIRoute } from 'astro';
import { smartMatch, searchPlaces, redis } from '../../lib';
import { inferServiceIntentHint, inferDiagnosisHint } from '../../lib/intent';
import { scoreLeadUrgency } from '../../lib/lead-score';
import { getCachedSummary } from '../../lib/website-summary';
import { json, err } from '../../lib/api-helpers';

export const prerender = false;

// 4-hour TTL — balances freshness with Places API cost
const CACHE_TTL = 60 * 60 * 4;

/**
 * Cache key for combined match results.
 * Uses a 0.1° location grid (≈ 7 mi) to maximise hit rate across nearby searches.
 */
function cacheKey(query: string, lat: number, lng: number): string {
  return `ss:match:v1:${query.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120)}:${Math.round(lat * 10)}:${Math.round(lng * 10)}`;
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.query || body?.lat == null || body?.lng == null) return err('missing query/lat/lng', 400);

  const query = String(body.query).trim();
  const lat   = Number(body.lat);
  const lng   = Number(body.lng);

  // Fast path: return cached combined result if available
  const r  = redis();
  const ck = cacheKey(query, lat, lng);
  if (r) {
    const cached = await r.get<{ businesses: unknown[]; label: string | null; intentQuery: string | null }>(ck).catch(() => null);
    if (cached) return json(cached);
  }

  // ── Layer 1: deterministic intent (<1ms, synchronous) ────────────────────
  // Instantly resolves common service queries before any network call fires.
  const intentHint = inferServiceIntentHint(query);
  const layer1Query = intentHint?.query ?? null;

  // Use the Layer 1 query as the initial Places search seed if available;
  // this gives us relevant results even before Cerebras responds.
  const initialPlacesQuery = layer1Query ?? query;

  // ── Layer 2: Cerebras LLM + initial Places search (parallel) ─────────────
  const [match, initialResults] = await Promise.all([
    smartMatch(query),
    searchPlaces(initialPlacesQuery, lat, lng),
  ]);

  // Prefer the AI-rewritten query only when it differs meaningfully from what
  // we already searched — avoids a redundant Places API call.
  const aiQuery        = match.aiQuery;
  const aiQueryDiffers = aiQuery.toLowerCase() !== initialPlacesQuery.toLowerCase();
  const businesses     = aiQueryDiffers
    ? await searchPlaces(aiQuery, lat, lng)
    : initialResults;

  // Merge labels: AI label preferred, Layer 1 fallback, then null
  const label =
    match.serviceLabelPlural ??
    match.serviceLabel ??
    intentHint?.pluralLabel ??
    null;

  // Layer 1: diagnosis hint — "Water leak detected / Likely: pipe or fitting failure"
  // Uses the resolved service query (AI-preferred, Layer 1 fallback) for best accuracy.
  const resolvedServiceQuery = (match.serviceLabel ?? layer1Query) || null;
  const diagnosisHint = resolvedServiceQuery
    ? inferDiagnosisHint(query, resolvedServiceQuery)
    : null;

  // Lead urgency scoring — used by the consumer UI to surface "URGENT" callouts
  const urgency = scoreLeadUrgency(query);

  const rawBusinesses = businesses.length ? businesses : initialResults;

  // Attach any pre-cached website summaries to the top 3 results so the
  // client can render "Why this business" instantly without a separate fetch.
  const top3 = rawBusinesses.slice(0, 3);
  const cachedSummaries = await Promise.all(
    top3.map((b: Record<string, unknown>) =>
      b.placeId && b.website
        ? getCachedSummary(String(b.placeId), String(b.website))
        : Promise.resolve(null),
    ),
  );
  const enrichedBusinesses = rawBusinesses.map((b: Record<string, unknown>, i: number) =>
    i < 3 && cachedSummaries[i]
      ? { ...b, cachedSummary: cachedSummaries[i] }
      : b,
  );

  const result = {
    businesses:  enrichedBusinesses,
    label,
    intentQuery:   layer1Query,     // Layer 1 canonical query (e.g. "plumber")
    aiSummary:     match.aiSummary, // Cerebras one-sentence description of the need
    diagnosisHint,                  // consumer-facing issue label + likely cause
    urgencyTier:   urgency.tier,    // 'critical' | 'high' | 'medium' | 'low'
    urgencyScore:  urgency.score,   // 0–100
  };

  // Cache the combined result (including pre-fetched summaries) for 4 hours
  if (r && result.businesses.length) {
    await r.set(ck, result, { ex: CACHE_TTL }).catch(() => null);
  }

  return json(result);
};

