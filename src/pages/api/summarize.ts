/**
 * POST /api/summarize
 *
 * Layer 3 — Website summarizer endpoint.
 *
 * Called by the client after `/api/match` returns results, once per business
 * that has a website URL.  Returns a 2–3 sentence summary of the business's
 * services, specialisms, and service area — fetched from their website and
 * distilled by Cerebras.
 *
 * Design choices:
 *   - Separate from /api/match so the initial result load is never blocked by
 *     website fetching (which can take up to ~7s on slow sites).
 *   - Client calls these in parallel after the match response arrives, enriching
 *     cards as summaries resolve.
 *   - 30-day Redis cache means most summaries load in <50ms on repeat visits.
 *   - Returns null gracefully when fetch or Cerebras fails — no error UI needed.
 *
 * Rate limiting: 10 requests per minute per IP via Redis sliding window to
 * prevent abuse of the Cerebras + HTML fetch pipeline.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../lib';
import { getWebsiteSummary } from '../../lib/website-summary';
import { json, err } from '../../lib/api-helpers';

export const prerender = false;

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_LIMIT      = 10;
const RATE_WINDOW_SEC = 60;
const RL_KEY = (ip: string) => `ss:summarize:rl:${ip}`;

async function isAllowed(ip: string): Promise<boolean> {
  const r = redis();
  if (!r) return true;

  const key  = RL_KEY(ip);
  const now  = Date.now();
  const pipe = r.pipeline();
  pipe.zremrangebyscore(key, 0, now - RATE_WINDOW_SEC * 1000);
  pipe.zcard(key);
  pipe.zadd(key, { score: now, member: String(now) });
  pipe.expire(key, RATE_WINDOW_SEC);
  const results = await pipe.exec<[number, number, number, number]>().catch(() => null);
  if (!results) return true;
  return (results[1] as number) < RATE_LIMIT;
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.placeId || !body?.websiteUrl) return err('placeId and websiteUrl required', 400);

  const placeId      = String(body.placeId).slice(0, 64);
  const websiteUrl   = String(body.websiteUrl).slice(0, 512);
  const businessName = String(body.businessName || 'Business').slice(0, 120);

  // Simple IP-based rate limit to protect Cerebras + fetch pipeline
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')
    || 'unknown';

  const allowed = await isAllowed(ip);
  if (!allowed) return err('rate limit exceeded', 429);

  const summary = await getWebsiteSummary({ placeId, businessName, websiteUrl });

  return json({ summary });
};
