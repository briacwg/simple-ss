/**
 * POST /api/workspace
 *
 * AI Workspace for service professionals — powered by Cerebras.
 *
 * Provides business owners with on-demand AI insights about their leads,
 * pricing, response strategies, and service quality improvement.
 *
 * Features:
 *   - Tone config: friendly / premium / direct — shapes the AI voice
 *   - Answer length: short / balanced / detailed — controls response depth
 *   - Banned claims: post-processed to flag any disallowed claims in the answer
 *   - Required phrases: checked against response and surfaced as reminders
 *   - Plan gating: 'free' plan limited to basic advice + 2 tips; paid plans get
 *     full features including leadContext enrichment and detailed answers
 *
 * Rate-limited per business phone to 20 requests per hour via Redis sliding window.
 */

import type { APIRoute } from 'astro';
import { redis, normalizePhone } from '../../lib';
import { getSupabase } from '../../lib/supabase';
import { json, err } from '../../lib/api-helpers';

export const prerender = false;

// ── Types ─────────────────────────────────────────────────────────────────────

export type WorkspaceTone         = 'friendly' | 'premium' | 'direct';
export type WorkspaceAnswerLength = 'short' | 'balanced' | 'detailed';
export type WorkspacePlanSlug     = 'free' | 'starter' | 'pro' | 'elite';

export interface WorkspaceRequest {
  /** Business display name. */
  businessName: string;
  /** Service category (e.g. "HVAC technician"). */
  serviceLabel: string;
  /** Optional verified business phone — used for rate limiting and settings lookup. */
  businessPhone?: string;
  /** The question or task (max 500 chars). */
  question: string;
  /** Recent consumer problem description — enriches the AI context (paid plans only). */
  leadContext?: string;
  /** Override tone for this request; falls back to stored settings or 'friendly'. */
  tone?: WorkspaceTone;
  /** Override answer length; falls back to stored settings or 'balanced'. */
  answerLength?: WorkspaceAnswerLength;
  /** Words / phrases the AI must not use in its response. */
  bannedClaims?: string[];
  /** Words / phrases the response should ideally include. */
  requiredPhrases?: string[];
  /** Plan slug — gates features like leadContext and detailed answers. */
  planSlug?: WorkspacePlanSlug;
}

export interface WorkspaceResponse {
  answer: string;
  tips: string[];
  provider: 'cerebras' | 'fallback';
  latencyMs: number;
  /** Banned claims detected in the AI answer (should be reviewed). */
  flaggedClaims: string[];
  /** Required phrases absent from the answer (should be added manually). */
  missingPhrases: string[];
  /** Feature access level returned for the client to gate UI features. */
  planSlug: WorkspacePlanSlug;
}

// ── Plan feature gating ───────────────────────────────────────────────────────

const PLAN_ORDER: WorkspacePlanSlug[] = ['free', 'starter', 'pro', 'elite'];

function planAtLeast(plan: WorkspacePlanSlug, min: WorkspacePlanSlug): boolean {
  return PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(min);
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

const RATE_LIMIT     = 20;
const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RL_KEY = (phone: string) => `ss:workspace:rl:${phone}`;

async function isAllowed(phone: string): Promise<boolean> {
  const r = redis();
  if (!r) return true;

  const key         = RL_KEY(phone);
  const now         = Date.now();
  const windowStart = now - RATE_WINDOW_MS;

  const pipe = r.pipeline();
  pipe.zremrangebyscore(key, 0, windowStart);
  pipe.zcard(key);
  pipe.zadd(key, { score: now, member: String(now) });
  pipe.expire(key, 3600);
  const results = await pipe.exec<[number, number, number, number]>().catch(() => null);
  if (!results) return true;

  return (results[1] as number) < RATE_LIMIT;
}

// ── Tone-aware system prompts ─────────────────────────────────────────────────

const TONE_INSTRUCTIONS: Record<WorkspaceTone, string> = {
  friendly: 'Be warm, encouraging, and approachable. Use conversational language.',
  premium:  'Be polished, authoritative, and professional. Use refined, elevated language.',
  direct:   'Be terse and data-driven. Skip pleasantries — lead with the answer.',
};

const LENGTH_INSTRUCTIONS: Record<WorkspaceAnswerLength, string> = {
  short:    'Keep your answer to 1–2 sentences maximum.',
  balanced: 'Keep your answer to 2–3 sentences.',
  detailed: 'Provide a thorough answer of 3–5 sentences with supporting detail.',
};

function buildSystemPrompt(tone: WorkspaceTone, length: WorkspaceAnswerLength): string {
  return `You are an AI business coach for home service professionals on ServiceSurfer.
${TONE_INSTRUCTIONS[tone]} ${LENGTH_INSTRUCTIONS[length]}
Help pros win more leads, price jobs competitively, and deliver excellent customer experiences.

Response format (JSON only — no markdown):
{
  "answer": "${length === 'short' ? '1–2 sentence' : length === 'detailed' ? '3–5 sentence' : '2–3 sentence'} response",
  "tips": ["actionable tip 1", "actionable tip 2", "actionable tip 3"]
}

Keep each tip under 15 words. Make every tip immediately actionable. Return valid JSON only.`;
}

// ── Cerebras AI call ──────────────────────────────────────────────────────────

async function callCerebras(
  businessName: string,
  serviceLabel: string,
  question: string,
  leadContext: string | undefined,
  tone: WorkspaceTone,
  length: WorkspaceAnswerLength,
  tipCount: number,
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

  const maxTokens = length === 'short' ? 150 : length === 'detailed' ? 450 : 300;

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature:     tone === 'direct' ? 0.2 : 0.4,
        max_tokens:      maxTokens,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: buildSystemPrompt(tone, length) },
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
    const tips   = Array.isArray(parsed.tips)
      ? parsed.tips.slice(0, tipCount).map((t: unknown) => String(t).slice(0, 120))
      : [];
    return {
      answer: String(parsed.answer || '').slice(0, 600),
      tips,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ── Compliance checks ─────────────────────────────────────────────────────────

/** Returns any banned claims present in the answer (case-insensitive substring match). */
function detectBannedClaims(answer: string, bannedClaims: string[]): string[] {
  const lower = answer.toLowerCase();
  return bannedClaims.filter(claim => lower.includes(claim.toLowerCase()));
}

/** Returns required phrases absent from the answer (case-insensitive). */
function detectMissingPhrases(answer: string, requiredPhrases: string[]): string[] {
  const lower = answer.toLowerCase();
  return requiredPhrases.filter(phrase => !lower.includes(phrase.toLowerCase()));
}

// ── Settings lookup ───────────────────────────────────────────────────────────

interface CachedSettings {
  tone: WorkspaceTone;
  answerLength: WorkspaceAnswerLength;
  bannedClaims: string[];
  requiredPhrases: string[];
  planSlug: WorkspacePlanSlug;
}

async function loadSettings(phone: string): Promise<CachedSettings | null> {
  const sb = getSupabase();
  if (!sb) return null;
  type SettingsRow = { tone: string; answer_length: string; banned_claims: string[]; required_phrases: string[]; plan_slug: string };
  const { data } = await sb
    .from('business_workspace_settings')
    .select('tone, answer_length, banned_claims, required_phrases, plan_slug')
    .eq('business_phone', phone)
    .single()
    .then(r => r, () => ({ data: null })) as { data: SettingsRow | null };
  if (!data) return null;
  return {
    tone:            (data.tone as WorkspaceTone) || 'friendly',
    answerLength:    (data.answer_length as WorkspaceAnswerLength) || 'balanced',
    bannedClaims:    data.banned_claims || [],
    requiredPhrases: data.required_phrases || [],
    planSlug:        (data.plan_slug as WorkspacePlanSlug) || 'free',
  };
}

// ── Fallback responses ────────────────────────────────────────────────────────

const FALLBACKS: Array<{ keywords: string[]; answer: string; tips: string[] }> = [
  {
    keywords: ['price', 'charge', 'cost', 'quote'],
    answer:   'Price jobs based on local market rates, your overhead, and the complexity of the work.',
    tips:     ['Research 3 competitor quotes before pricing', 'Itemise labour and materials separately', 'Offer a free estimate to reduce friction'],
  },
  {
    keywords: ['respond', 'reply', 'fast', 'speed', 'time'],
    answer:   'Pros who respond within 5 minutes are 9× more likely to win the lead than those who wait 30 minutes.',
    tips:     ['Enable SMS notifications for new leads', 'Prepare a canned intro message to send immediately', 'Block time each morning to reply to overnight requests'],
  },
  {
    keywords: ['review', 'rating', 'feedback'],
    answer:   'Ask every satisfied customer for a review immediately after job completion — recency and volume both matter.',
    tips:     ['Text a review link within 1 hour of finishing', 'Respond to every negative review professionally', 'Display top reviews on your website'],
  },
];

function getFallback(question: string, tipCount: number): { answer: string; tips: string[] } {
  const q = question.toLowerCase();
  for (const f of FALLBACKS) {
    if (f.keywords.some(k => q.includes(k))) {
      return { answer: f.answer, tips: f.tips.slice(0, tipCount) };
    }
  }
  return {
    answer: 'Focus on fast response times, clear communication, and asking every satisfied customer for a review.',
    tips:   ['Respond to leads within 5 minutes', 'Follow up after every job', 'Keep your profile up to date'].slice(0, tipCount),
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
  const phone        = body.businessPhone ? normalizePhone(String(body.businessPhone)) : null;

  // Rate limit by business phone when available
  if (phone) {
    const allowed = await isAllowed(phone);
    if (!allowed) return err('rate limit exceeded — 20 requests per hour', 429);
  }

  // Load stored settings from Supabase (request params override stored values)
  const stored = phone ? await loadSettings(phone).catch(() => null) : null;

  const planSlug: WorkspacePlanSlug = (body.planSlug as WorkspacePlanSlug)
    ?? stored?.planSlug
    ?? 'free';

  const tone: WorkspaceTone = (body.tone as WorkspaceTone)
    ?? stored?.tone
    ?? 'friendly';

  const answerLength: WorkspaceAnswerLength = (body.answerLength as WorkspaceAnswerLength)
    ?? stored?.answerLength
    ?? 'balanced';

  const bannedClaims: string[]    = body.bannedClaims    ?? stored?.bannedClaims    ?? [];
  const requiredPhrases: string[] = body.requiredPhrases ?? stored?.requiredPhrases ?? [];

  // Plan gating: free plan gets basic advice only (no leadContext, 2 tips max, short answers)
  const isPaid       = planAtLeast(planSlug, 'starter');
  const leadContext  = isPaid && body.leadContext ? String(body.leadContext).slice(0, 200) : undefined;
  const tipCount     = isPaid ? 3 : 2;
  const effectiveLen = isPaid ? answerLength : 'short';

  const start = Date.now();
  const ai    = await callCerebras(businessName, serviceLabel, question, leadContext, tone, effectiveLen, tipCount);
  const fb    = getFallback(question, tipCount);

  const answer = ai?.answer ?? fb.answer;
  const tips   = ai?.tips   ?? fb.tips;

  // Compliance post-processing
  const flaggedClaims   = detectBannedClaims(answer, bannedClaims);
  const missingPhrases  = detectMissingPhrases(answer, requiredPhrases);

  const response: WorkspaceResponse = {
    answer,
    tips,
    provider:       ai ? 'cerebras' : 'fallback',
    latencyMs:      Date.now() - start,
    flaggedClaims,
    missingPhrases,
    planSlug,
  };

  return json(response);
};

// ── Response helpers ──────────────────────────────────────────────────────────

