/**
 * POST /api/internal/refresh-search-cache
 *
 * Background job that refreshes stale search result cache entries.
 *
 * Two call modes:
 *   1. Targeted refresh — body: { cacheKey, query, lat, lng }
 *      Re-fetches a single specific entry (triggered by stale-while-revalidate
 *      in /api/match when a Supabase hit is older than REFRESH_AFTER_DAYS).
 *
 *   2. Sweep mode — body: {} or body: { sweep: true }
 *      Scans Supabase for up to 20 stale-but-not-expired entries and refreshes
 *      them. Safe to call from a cron job (e.g. every 6 hours via QStash).
 *
 * Both modes require X-Internal-Secret header in production.
 */

import type { APIRoute } from 'astro';
import { smartMatch, searchPlaces, redis, type Business } from '../../../lib';
import { inferServiceIntentHint, inferDiagnosisHint } from '../../../lib/intent';
import { scoreLeadUrgency } from '../../../lib/lead-score';
import { getCachedSummary } from '../../../lib/website-summary';
import { json, err } from '../../../lib/api-helpers';
import { writeSearchCache, getStaleEntries, type CachedSearchResult } from '../../../lib/search-cache';

export const prerender = false;

const CACHE_TTL = 60 * 60 * 24;

export const POST: APIRoute = async ({ request }) => {
  // Auth check
  const secret = import.meta.env.SS_INTERNAL_SECRET;
  if (secret) {
    const header = request.headers.get('x-internal-secret');
    if (header !== secret) return err('forbidden', 403);
  }

  const body = await request.json().catch(() => ({})) as Record<string, unknown>;

  // ── Mode 1: targeted single-key refresh ───────────────────────────────────
  if (body.cacheKey && body.query != null && body.lat != null && body.lng != null) {
    const result = await fetchFresh(String(body.query), Number(body.lat), Number(body.lng));
    if (!result) return json({ ok: false, reason: 'no results' });

    const locationCell = `${Math.round(Number(body.lat) * 10)}:${Math.round(Number(body.lng) * 10)}`;
    const ck = String(body.cacheKey);

    await writeSearchCache(ck, String(body.query), locationCell, Number(body.lat), Number(body.lng), result);

    const r = redis();
    if (r) await r.set(ck, result, { ex: CACHE_TTL }).catch(() => null);

    return json({ ok: true, mode: 'targeted', key: ck });
  }

  // ── Mode 2: sweep — refresh hottest stale entries ─────────────────────────
  const stale = await getStaleEntries(20);
  if (!stale.length) return json({ ok: true, mode: 'sweep', refreshed: 0 });

  let refreshed = 0;
  const r = redis();

  for (const row of stale) {
    const result = await fetchFresh(row.query, row.lat, row.lng);
    if (!result) continue;

    await writeSearchCache(row.cache_key, row.query, row.location_cell, row.lat, row.lng, result);
    if (r) await r.set(row.cache_key, result, { ex: CACHE_TTL }).catch(() => null);
    refreshed++;
  }

  return json({ ok: true, mode: 'sweep', refreshed, total: stale.length });
};

// ── Fetch fresh result from Google + Cerebras ─────────────────────────────────

async function fetchFresh(query: string, lat: number, lng: number): Promise<CachedSearchResult | null> {
  try {
    const intentHint         = inferServiceIntentHint(query);
    const layer1Query        = intentHint?.query ?? null;
    const initialPlacesQuery = layer1Query ?? query;

    const [match, initialResults] = await Promise.all([
      smartMatch(query),
      searchPlaces(initialPlacesQuery, lat, lng),
    ]);

    const aiQueryDiffers = match.aiQuery.toLowerCase() !== initialPlacesQuery.toLowerCase();
    const businesses     = aiQueryDiffers
      ? await searchPlaces(match.aiQuery, lat, lng)
      : initialResults;

    const rawBusinesses = businesses.length ? businesses : initialResults;
    if (!rawBusinesses.length) return null;

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

    const top3 = rawBusinesses.slice(0, 3);
    const cachedSummaries = await Promise.all(
      top3.map((b: Business) =>
        b.placeId && b.website ? getCachedSummary(b.placeId, b.website) : Promise.resolve(null),
      ),
    );

    const enrichedBusinesses = rawBusinesses.map((b: Business, i: number) =>
      i < 3 && cachedSummaries[i] ? { ...b, cachedSummary: cachedSummaries[i] } : b,
    );

    return {
      businesses:   enrichedBusinesses,
      label,
      intentQuery:  layer1Query,
      aiSummary:    match.aiSummary,
      diagnosisHint,
      urgencyTier:  urgency.tier,
      urgencyScore: urgency.score,
    };
  } catch {
    return null;
  }
}
