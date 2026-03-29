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
import { getWebsiteSummary } from '../../lib/website-summary';
import { json, err, getClientIp, checkRateLimit } from '../../lib/api-helpers';

export const prerender = false;

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.placeId || !body?.websiteUrl) return err('placeId and websiteUrl required', 400);

  const placeId      = String(body.placeId).slice(0, 64);
  const websiteUrl   = String(body.websiteUrl).slice(0, 512);
  const businessName = String(body.businessName || 'Business').slice(0, 120);

  // 10 req/min per IP — protects the Cerebras + HTML fetch pipeline
  const ip      = getClientIp(request);
  const allowed = await checkRateLimit(`ss:summarize:rl:${ip}`, 10, 60);
  if (!allowed) return err('rate limit exceeded', 429);

  const summary = await getWebsiteSummary({ placeId, businessName, websiteUrl });

  return json({ summary });
};
