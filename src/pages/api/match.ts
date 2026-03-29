/**
 * POST /api/match
 *
 * Core matching endpoint: given a free-text service description and a lat/lng,
 * returns up to 6 ranked local businesses.
 *
 * Strategy:
 *   1. Check a combined Redis cache (4h TTL) keyed by query + 0.1° location cell.
 *   2. On cache miss, run smartMatch (Groq LLM) and a raw Google Places search
 *      in parallel.
 *   3. If the AI reinterprets the query (e.g. "leaky faucet" → "plumber faucet
 *      repair"), run a second Places search with the AI query and prefer those
 *      results — falling back to the raw results if the AI search is empty.
 *   4. Cache the combined result for future requests in the same area.
 */

import type { APIRoute } from 'astro';
import { smartMatch, searchPlaces, redis } from '../../lib';

export const prerender = false;

// 4-hour TTL — long enough to be useful, short enough to reflect business hours changes
const CACHE_TTL = 60 * 60 * 4;

/**
 * Builds a Redis cache key for a combined match result.
 * Uses a coarser location grid (0.1° ≈ 7 mi) than the Places cache (0.01°)
 * to maximise hit rate across nearby searches.
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
    const cached = await r.get<{ businesses: unknown[]; label: string | null }>(ck).catch(() => null);
    if (cached) return json(cached);
  }

  // Slow path: run AI match and raw Places search concurrently to minimise latency
  const [match, rawResults] = await Promise.all([
    smartMatch(query),
    searchPlaces(query, lat, lng),
  ]);

  // Prefer the AI-rewritten query if it differs from the raw input
  const aiQueryDiffers = match.aiQuery.toLowerCase() !== query.toLowerCase();
  const businesses = aiQueryDiffers
    ? await searchPlaces(match.aiQuery, lat, lng)
    : rawResults;

  const result = {
    businesses: businesses.length ? businesses : rawResults,
    label: match.serviceLabelPlural || match.serviceLabel || null,
  };

  // Cache the combined result only when we have at least one business to return
  if (r && result.businesses.length) {
    await r.set(ck, result, { ex: CACHE_TTL }).catch(() => null);
  }

  return json(result);
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
