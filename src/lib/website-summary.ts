/**
 * Layer 3 — Website Summarizer
 *
 * Fetches a business's website, strips HTML to plain text, and uses Cerebras
 * to generate a 2–3 sentence summary of the services they offer.
 *
 * The summary enriches business cards in the consumer UI, giving users a
 * quick sense of specialisms (e.g. "Specialises in emergency HVAC repairs and
 * residential installations. Serving the greater Chicago area since 1998.")
 * without requiring the consumer to visit the business's website.
 *
 * Caching:
 *   Summaries are cached in Redis for 30 days keyed by (placeId + URL hash).
 *   A short-lived in-memory map prevents duplicate concurrent fetch+summarize
 *   operations for the same URL during a single cold-start window.
 *
 * Mirrors the architecture of the main app's website-summary.ts, adapted to
 * use the Web Crypto API (no Node.js crypto module dependency) and the shared
 * redis() helper from lib.ts.
 */

import { redis } from '../lib';

// ── Configuration ─────────────────────────────────────────────────────────────

const CACHE_TTL_SECONDS  = 60 * 60 * 24 * 30; // 30 days — business websites are stable
const FETCH_TIMEOUT_MS   = 3500;               // abort HTML fetch after 3.5s
const MAX_TEXT_CHARS     = 4000;               // feed only the first 4k chars to Cerebras

/** In-memory promise cache to prevent duplicate concurrent summarize calls. */
const inflight = new Map<string, Promise<string | null>>();

// ── Cache key ─────────────────────────────────────────────────────────────────

/**
 * Builds a Redis cache key using a short hash of the source URL so that
 * updating the website URL invalidates the old summary.
 */
async function buildCacheKey(placeId: string, websiteUrl: string): Promise<string> {
  const encoded = new TextEncoder().encode(websiteUrl.toLowerCase().trim());
  const hashBuf = await crypto.subtle.digest('SHA-1', encoded);
  const hex     = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
  return `sr:place:v1:${placeId}:website_summary:${hex}`;
}

// ── HTML → text ───────────────────────────────────────────────────────────────

/**
 * Strips all HTML tags and common entities from a raw HTML string, returning
 * plain text suitable for feeding to an LLM.
 */
function extractTextFromHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_CHARS);
}

// ── Cerebras summarize ────────────────────────────────────────────────────────

async function summarizeWithCerebras(
  businessName: string,
  plainText: string,
): Promise<string | null> {
  const key   = import.meta.env.CEREBRAS_API_KEY;
  const model = import.meta.env.CEREBRAS_MODEL || 'gpt-oss-120b';
  if (!key || !plainText) return null;

  const controller = new AbortController();
  const tid        = setTimeout(() => controller.abort(), 5000);

  const prompt = `Summarize what services "${businessName}" offers based on the following text from their website. Write 2–3 sentences. Focus on their specialisms, service areas, and any notable differentiators (e.g. emergency service, years in business, certifications). Be factual and concise. Do not invent information not present in the text.

Website text:
${plainText}`;

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        max_tokens:  150,
        messages:    [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data    = await res.json();
    const content = String(data.choices?.[0]?.message?.content || '').trim();
    return content.slice(0, 300) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(tid);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export interface WebsiteSummaryInput {
  /** Google Places place ID — used as the primary cache key segment. */
  placeId: string;
  /** Business display name, used in the Cerebras prompt. */
  businessName: string;
  /** URL of the business website to fetch and summarise. */
  websiteUrl: string;
}

/**
 * Returns the cached summary for a business without triggering a live fetch.
 * Used by /api/match to include pre-cached summaries in the initial response
 * so cards render immediately without a separate /api/summarize round-trip.
 */
export async function getCachedSummary(placeId: string, websiteUrl: string): Promise<string | null> {
  if (!websiteUrl || !placeId) return null;
  const url = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
  try { new URL(url); } catch { return null; }
  const r = redis();
  if (!r) return null;
  const cacheKey = await buildCacheKey(placeId, url);
  return r.get<string>(cacheKey).catch(() => null);
}

/**
 * Returns a 2–3 sentence summary of a business's website.
 *
 * Resolution order:
 *   1. Redis cache (30-day TTL) — instant
 *   2. In-memory inflight map — prevents duplicate concurrent fetches
 *   3. Live fetch + Cerebras summarize (up to ~7s total)
 *
 * Returns null on any failure (network error, Cerebras unavailable, etc.)
 * so callers can safely skip the summary without breaking the main flow.
 */
export async function getWebsiteSummary(input: WebsiteSummaryInput): Promise<string | null> {
  const { placeId, businessName, websiteUrl } = input;
  if (!websiteUrl || !placeId) return null;

  // Normalise URL
  const url = /^https?:\/\//i.test(websiteUrl) ? websiteUrl : `https://${websiteUrl}`;
  try { new URL(url); } catch { return null; }

  const cacheKey = await buildCacheKey(placeId, url);

  // 1. Redis cache
  const r = redis();
  if (r) {
    const cached = await r.get<string>(cacheKey).catch(() => null);
    if (cached) return cached;
  }

  // 2. Deduplicate concurrent requests for the same URL
  if (inflight.has(cacheKey)) return inflight.get(cacheKey)!;

  const promise = (async (): Promise<string | null> => {
    try {
      // Fetch the website HTML
      const controller = new AbortController();
      const tid        = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let html = '';
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ServiceSurfer/1.0)' },
          signal:  controller.signal,
        });
        if (res.ok) html = await res.text();
      } finally {
        clearTimeout(tid);
      }
      if (!html) return null;

      const text    = extractTextFromHtml(html);
      if (!text)    return null;

      const summary = await summarizeWithCerebras(businessName, text);
      if (!summary) return null;

      // Cache the result
      if (r) await r.set(cacheKey, summary, { ex: CACHE_TTL_SECONDS }).catch(() => null);
      return summary;
    } finally {
      inflight.delete(cacheKey);
    }
  })();

  inflight.set(cacheKey, promise);
  return promise;
}
