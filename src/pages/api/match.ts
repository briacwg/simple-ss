import type { APIRoute } from 'astro';
import { smartMatch, searchPlaces, redis } from '../../lib';

export const prerender = false;

// Cache combined match results for 4 hours — keyed by query + location cell (0.1° ≈ 7mi)
const CACHE_TTL = 60 * 60 * 4;
function cacheKey(query: string, lat: number, lng: number) {
  return `ss:match:v1:${query.toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120)}:${Math.round(lat * 10)}:${Math.round(lng * 10)}`;
}

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.query || body?.lat == null || body?.lng == null) return err('missing query/lat/lng', 400);

  const query = String(body.query).trim();
  const lat = Number(body.lat);
  const lng = Number(body.lng);

  // Try combined cache first
  const r = redis();
  const ck = cacheKey(query, lat, lng);
  if (r) {
    const cached = await r.get<{ businesses: unknown[]; label: string | null }>(ck).catch(() => null);
    if (cached) return json(cached);
  }

  // Run smart match and raw search in parallel
  const [match, rawResults] = await Promise.all([
    smartMatch(query),
    searchPlaces(query, lat, lng),
  ]);

  const aiQueryDiffers = match.aiQuery.toLowerCase() !== query.toLowerCase();
  const businesses = aiQueryDiffers
    ? await searchPlaces(match.aiQuery, lat, lng)
    : rawResults;

  const result = {
    businesses: businesses.length ? businesses : rawResults,
    label: match.serviceLabelPlural || match.serviceLabel || null,
  };

  // Cache combined result
  if (r && result.businesses.length) {
    await r.set(ck, result, { ex: CACHE_TTL }).catch(() => null);
  }

  return json(result);
};

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
