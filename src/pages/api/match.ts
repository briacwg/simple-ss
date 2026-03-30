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
import { smartMatch, searchPlaces, redis, type Business } from '../../lib';
import { inferServiceIntentHint, inferDiagnosisHint } from '../../lib/intent';
import { scoreLeadUrgency } from '../../lib/lead-score';
import { getCachedSummary } from '../../lib/website-summary';
import { json, err } from '../../lib/api-helpers';
import { upsertIntent, querySimilarBusinesses } from '../../lib/vector';
import { readSearchCache, writeSearchCache, type CachedSearchResult } from '../../lib/search-cache';

export const prerender = false;

// L1 Redis TTL: 24 h (previously 4 h — safe to extend since Places data changes slowly)
const CACHE_TTL = 60 * 60 * 24;

/**
 * Cache key for combined match results.
 * Uses a 0.1° location grid (≈ 7 mi) to maximise hit rate across nearby searches.
 */
function cacheKey(query: string, lat: number, lng: number): string {
  return `ss:match:v1:${query.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120)}:${Math.round(lat * 10)}:${Math.round(lng * 10)}`;
}

export const POST: APIRoute = async ({ request, url: reqUrl }) => {
  const body = await request.json().catch(() => null);
  if (!body?.query || body?.lat == null || body?.lng == null) return err('missing query/lat/lng', 400);

  const query = String(body.query).trim();
  const lat   = Number(body.lat);
  const lng   = Number(body.lng);

  const r            = redis();
  const ck           = cacheKey(query, lat, lng);
  const locationCell = `${Math.round(lat * 10)}:${Math.round(lng * 10)}`;

  // ── L1: Redis (24 h) ──────────────────────────────────────────────────────
  if (r) {
    const cached = await r.get<CachedSearchResult>(ck).catch(() => null);
    if (cached) {
      const reranked = await vectorRerank(cached.businesses as Business[], query);
      return json({ ...cached, businesses: reranked, _cache: 'redis' });
    }
  }

  // ── L2: Supabase (30 d, stale-while-revalidate at 7 d) ───────────────────
  const sbCached = await readSearchCache(ck);
  if (sbCached) {
    // Warm Redis from Supabase so the next hit is instant
    if (r) r.set(ck, sbCached.result, { ex: CACHE_TTL }).catch(() => null);

    // If stale, kick off a background refresh (fire-and-forget)
    if (sbCached.stale) {
      const origin = reqUrl.origin;
      fetch(`${origin}/api/internal/refresh-search-cache`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': import.meta.env.SS_INTERNAL_SECRET || '' },
        body: JSON.stringify({ cacheKey: ck, query, lat, lng }),
      }).catch(() => null);
    }

    const reranked = await vectorRerank(sbCached.result.businesses as Business[], query);
    return json({ ...sbCached.result, businesses: reranked, _cache: sbCached.stale ? 'supabase-stale' : 'supabase' });
  }

  // ── L3: Google Places + Cerebras ─────────────────────────────────────────

  // Layer 1: deterministic intent (<1ms, synchronous)
  const intentHint      = inferServiceIntentHint(query);
  const layer1Query     = intentHint?.query ?? null;
  const initialPlacesQuery = layer1Query ?? query;

  // Cerebras LLM + initial Places search in parallel
  const [match, initialResults] = await Promise.all([
    smartMatch(query),
    searchPlaces(initialPlacesQuery, lat, lng),
  ]);

  const aiQuery        = match.aiQuery;
  const aiQueryDiffers = aiQuery.toLowerCase() !== initialPlacesQuery.toLowerCase();
  const businesses     = aiQueryDiffers
    ? await searchPlaces(aiQuery, lat, lng)
    : initialResults;

  const label =
    match.serviceLabelPlural ??
    match.serviceLabel ??
    intentHint?.pluralLabel ??
    null;

  const resolvedServiceQuery = (match.serviceLabel ?? layer1Query) || null;
  const diagnosisHint = resolvedServiceQuery
    ? inferDiagnosisHint(query, resolvedServiceQuery)
    : null;

  const urgency = scoreLeadUrgency(query);
  const rawBusinesses = businesses.length ? businesses : initialResults;

  // Attach pre-cached website summaries to top 3
  const top3 = rawBusinesses.slice(0, 3);
  const cachedSummaries = await Promise.all(
    top3.map((b: Business) =>
      b.placeId && b.website
        ? getCachedSummary(b.placeId, b.website)
        : Promise.resolve(null),
    ),
  );
  const enrichedBusinesses = rawBusinesses.map((b: Business, i: number) =>
    i < 3 && cachedSummaries[i]
      ? { ...b, cachedSummary: cachedSummaries[i] }
      : b,
  );

  const result: CachedSearchResult = {
    businesses:  enrichedBusinesses,
    label,
    intentQuery:  layer1Query,
    aiSummary:    match.aiSummary,
    diagnosisHint,
    urgencyTier:  urgency.tier,
    urgencyScore: urgency.score,
  };

  // ── Persist to L1 + L2 ───────────────────────────────────────────────────
  if (result.businesses.length) {
    if (r) r.set(ck, result, { ex: CACHE_TTL }).catch(() => null);
    writeSearchCache(ck, query, locationCell, lat, lng, result).catch(() => null);
  }

  // ── Vector intent embedding ───────────────────────────────────────────────
  if (result.businesses.length) {
    const bucket   = Math.floor(Date.now() / 300_000);
    const searchId = `search:${locationCell}:${query.slice(0, 30).replace(/\W/g, '_')}:${bucket}`;
    upsertIntent({
      id:           searchId,
      query,
      summary:      match.aiSummary ?? undefined,
      serviceLabel: match.serviceLabel ?? label,
      locationCell,
      createdAt:    new Date().toISOString(),
    });
  }

  // Apply vector re-ranking on fresh results too (businesses may already be in DB)
  const reranked = await vectorRerank(enrichedBusinesses, query);
  return json({ ...result, businesses: reranked, _cache: 'miss' });
};

// ── Vector re-ranking ─────────────────────────────────────────────────────────
//
// Queries the "businesses" namespace for historical acceptance rates and boosts
// businesses that have a track record of accepting leads in this service category.
// Falls back to original order on any error or when the vector DB is not configured.

async function vectorRerank(businesses: Business[], serviceQuery: string): Promise<Business[]> {
  if (!businesses.length) return businesses;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const similar = await querySimilarBusinesses(serviceQuery, 30).finally(() => clearTimeout(timer));
    if (!similar.length) return businesses;

    // Build phone → acceptance rate map from vector results (IDs are phone numbers)
    const acceptanceMap = new Map<string, number>();
    for (const s of similar) {
      const rate = Number(s.metadata?.acceptanceRate ?? 0);
      if (rate > 0) acceptanceMap.set(String(s.id), rate);
    }
    if (!acceptanceMap.size) return businesses;

    // Score: position score × (1 + acceptance boost up to 50%)
    const n = businesses.length;
    const scored = businesses.map((b, i) => {
      const acceptance = acceptanceMap.get(b.phoneNumber || '') ?? 0;
      const posScore   = (n - i) / n;
      return { b, score: posScore * (1 + acceptance * 0.5) };
    });
    scored.sort((a, c) => c.score - a.score);
    return scored.map(s => s.b);
  } catch {
    return businesses;
  }
}

