/**
 * POST /api/workspace
 *
 * AI Workspace for service professionals — powered by Cerebras.
 *
 * Provides business owners with on-demand AI insights about their leads,
 * pricing, response strategies, and service quality improvement.  Think of
 * it as a pocket business coach that understands the home-services market.
 *
 * The endpoint is intentionally stateless: all context is supplied per-request
 * so it can be called from any surface (web, SMS, voice) without session state.
 *
 * Rate-limited per business phone to 20 requests per hour via Redis sliding window.
 */

import type { APIRoute } from 'astro';
import { redis, normalizePhone } from '../../lib';

export const prerender = false;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkspaceRequest {
  /** Business name (used to personalise the response). */
  businessName: string;
  /** Service category the business operates in (e.g. "HVAC technician"). */
  serviceLabel: string;
  /** Optional: verified business phone for rate limiting and personalisation. */
  businessPhone?: string;
  /** The question or task to answer (max 500 chars). */
  question: string;
  /** Optional: recent consumer problem description for context. */
  leadContext?: string;
}

export interface WorkspaceResponse {
  answer: string;
  tips: string[];
  provider: 'cerebras' | 'fallback';
  latencyMs: number;
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_LIMIT     = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RL_KEY = (phone: string) => `ss:workspace:rl:${phone}`;

/**
 * Sliding-window rate limiter — returns true if the request is allowed.
 * Uses a Redis sorted set keyed by phone number, with Unix timestamps as scores.
 */
async function isAllowed(phone: string): Promise<boolean> {
  const r = redis();
  if (!r) return true; // no Redis → allow (fail open for availability)

  const key = RL_KEY(phone);
  const now  = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  // Remove expired entries, count remaining, conditionally add new entry
  const pipe = r.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);
  pipe.zcard(key);
  pipe.zadd(key, { score: now, member: String(now) });
  pipe.expire(key, 3600);
  const results = await pipe.exec<[number, number, number, number]>().catch(() => null);
  if (!results) return true;

  const countAfterPrune = results[1] as number;
  return countAfterPrune < RATE_LIMIT;
}

// ── Cerebras AI call ──────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert AI business coach for home service professionals on ServiceSurfer.
You help pros win more leads, improve their response times, price jobs competitively, and deliver
excellent customer experiences. Be concise, practical, and positive.

Response format (JSON only):
{
  "answer": "2–3 sentence direct response to the question",
  "tips": ["actionable tip 1", "actionable tip 2", "actionable tip 3"]
}

Keep tips brief (under 15 words each) and immediately actionable.`;

async function callCerebras(
  businessName: string,
  serviceLabel: string,
  question: string,
  leadContext: string | undefined,
): Promise<{ answer: string; tips: string[] } | null> {
  const key   = import.meta.env.CEREBRAS_API_KEY;
  const model = import.meta.env.CEREBRAS_MODEL || 'gpt-oss-120b';
  if (!key) return null;

  const contextParts = [
    `Business: ${businessName}`,
    `Service type: ${serviceLabel}`,
    leadContext ? `Lead context: ${leadContext}` : null,
    `Question: ${question}`,
  ].filter(Boolean);

  const controller = new AbortController();
  const timeoutId  = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature:     0.4,
        max_tokens:      300,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: contextParts.join('\n') },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data    = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const tips   = Array.isArray(parsed.tips) ? parsed.tips.slice(0, 3).map((t: unknown) => String(t).slice(0, 120)) : [];
    return {
      answer: String(parsed.answer || '').slice(0, 400),
      tips,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Fallback responses ────────────────────────────────────────────────────────

/** Generic advice keyed by lower-cased question keywords when Cerebras is unavailable. */
const FALLBACKS: Array<{ keywords: string[]; answer: string; tips: string[] }> = [
  {
    keywords: ['price', 'charge', 'cost', 'quote'],
    answer:   'Price jobs based on local market rates, your overhead, and the complexity of the work.',
    tips:     ['Research 3 competitor quotes before pricing', 'Itemise labour and materials separately', 'Offer a free estimate to reduce friction'],
  },
  {
    keywords: ['respond', 'reply', 'fast', 'speed', 'time'],
    answer:   'Pros who respond within 5 minutes are 9× more likely to win the lead than those who wait 30 minutes.',
    tips:     ['Enable SMS notifications for new leads', 'Prepare a canned intro message to send immediately', 'Block time each morning to review and reply to overnight requests'],
  },
  {
    keywords: ['review', 'rating', 'feedback'],
    answer:   'Ask every satisfied customer for a review immediately after job completion — recency and volume both matter.',
    tips:     ['Text a review link within 1 hour of finishing the job', 'Respond to every negative review professionally', 'Display your best reviews on your website and truck'],
  },
];

function getFallback(question: string): { answer: string; tips: string[] } {
  const q = question.toLowerCase();
  for (const f of FALLBACKS) {
    if (f.keywords.some(k => q.includes(k))) return { answer: f.answer, tips: f.tips };
  }
  return {
    answer: 'Focus on fast response times, clear communication, and asking every satisfied customer for a review.',
    tips:   ['Respond to leads within 5 minutes', 'Send a follow-up text after every completed job', 'Keep your profile photo and service list up to date'],
  };
}

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const body: Partial<WorkspaceRequest> = await request.json().catch(() => ({}));

  if (!body.businessName || !body.serviceLabel || !body.question) {
    return err('businessName, serviceLabel, and question are required', 400);
  }

  const businessName = String(body.businessName).slice(0, 120);
  const serviceLabel = String(body.serviceLabel).slice(0, 80);
  const question     = String(body.question).slice(0, 500);
  const leadContext  = body.leadContext ? String(body.leadContext).slice(0, 200) : undefined;
  const phone        = body.businessPhone ? normalizePhone(String(body.businessPhone)) : null;

  // Rate limit by business phone when available
  if (phone) {
    const allowed = await isAllowed(phone);
    if (!allowed) return err('rate limit exceeded — 20 requests per hour', 429);
  }

  const start = Date.now();
  const ai    = await callCerebras(businessName, serviceLabel, question, leadContext);

  const response: WorkspaceResponse = {
    answer:    ai?.answer  ?? getFallback(question).answer,
    tips:      ai?.tips    ?? getFallback(question).tips,
    provider:  ai ? 'cerebras' : 'fallback',
    latencyMs: Date.now() - start,
  };

  return json(response);
};

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
