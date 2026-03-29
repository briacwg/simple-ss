/**
 * GET/PUT /api/workspace-settings
 *
 * CRUD for per-business AI Workspace configuration stored in Supabase.
 *
 * GET ?phone=+15551234567
 *   Returns the current settings for that business phone.
 *   Creates default settings if none exist.
 *
 * PUT { businessPhone, tone?, answerLength?, bannedClaims?, requiredPhrases?,
 *        collectLeadDetails?, escalateToCall?, escalateToVideo?, knowledgeUrls?,
 *        starterQuestions?, notes? }
 *   Upserts the settings row.
 *
 * Note: In production these endpoints should be protected by the business
 * session auth (passkey JWT). In this implementation they accept the business
 * phone directly — add session middleware before exposing publicly.
 */

import type { APIRoute } from 'astro';
import { normalizePhone, redis } from '../../lib';
import { getSupabase, type BusinessWorkspaceSettings } from '../../lib/supabase';
import { getBusinessSession } from '../../lib/session';
import { json, err } from '../../lib/api-helpers';

// Keep in sync with workspace.ts SETTINGS_CACHE_KEY
const SETTINGS_CACHE_KEY = (phone: string) => `ss:workspace:settings:v1:${phone}`;

export const prerender = false;

// ── Session guard ─────────────────────────────────────────────────────────────

/** Returns 401 when JWT auth is configured and the request has no valid session. */
async function requireSession(request: Request): Promise<Response | null> {
  const jwtSecret = import.meta.env.BUSINESS_JWT_SECRET || import.meta.env.DISPATCH_JOB_SECRET;
  if (!jwtSecret) return null; // local dev — skip auth
  const session = await getBusinessSession(request);
  if (!session) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  return null;
}

// ── GET — fetch settings ──────────────────────────────────────────────────────

export const GET: APIRoute = async ({ url, request }) => {
  const authErr = await requireSession(request);
  if (authErr) return authErr;
  const rawPhone = url.searchParams.get('phone');
  if (!rawPhone) return err('phone query param required', 400);

  const phone = normalizePhone(rawPhone);
  if (!phone) return err('invalid phone number', 400);

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Try to fetch existing settings
  const { data, error } = await sb
    .from('business_workspace_settings')
    .select('*')
    .eq('business_phone', phone)
    .single();

  if (data) return json(data);

  // No row yet — insert defaults and return
  if (error?.code === 'PGRST116') {
    const defaults: BusinessWorkspaceSettings = {
      business_phone:       phone,
      plan_slug:            'free',
      tone:                 'friendly',
      answer_length:        'balanced',
      banned_claims:        [],
      required_phrases:     [],
      collect_lead_details: false,
      escalate_to_call:     true,
      escalate_to_video:    false,
      knowledge_urls:       [],
      starter_questions:    [],
      notes:                null,
    };
    const { data: inserted, error: insertError } = await sb
      .from('business_workspace_settings')
      .insert(defaults as never)
      .select()
      .single();
    if (insertError) return err('failed to create settings', 500);
    return json(inserted);
  }

  return err('failed to load settings', 500);
};

// ── PUT — upsert settings ─────────────────────────────────────────────────────

export const PUT: APIRoute = async ({ request }) => {
  const authErr = await requireSession(request);
  if (authErr) return authErr;
  const body = await request.json().catch(() => null);
  if (!body?.businessPhone) return err('businessPhone required', 400);

  const phone = normalizePhone(String(body.businessPhone));
  if (!phone) return err('invalid phone number', 400);

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Build the update patch — only include fields that were supplied
  const patch: Partial<BusinessWorkspaceSettings> = { business_phone: phone };

  if (body.tone !== undefined) {
    const allowed = ['friendly', 'premium', 'direct'];
    if (!allowed.includes(body.tone)) return err('tone must be friendly | premium | direct', 400);
    patch.tone = body.tone;
  }
  if (body.answerLength !== undefined) {
    const allowed = ['short', 'balanced', 'detailed'];
    if (!allowed.includes(body.answerLength)) return err('answerLength must be short | balanced | detailed', 400);
    patch.answer_length = body.answerLength;
  }
  if (body.bannedClaims !== undefined) {
    if (!Array.isArray(body.bannedClaims)) return err('bannedClaims must be an array', 400);
    patch.banned_claims = body.bannedClaims.slice(0, 50).map((c: unknown) => String(c).slice(0, 120));
  }
  if (body.requiredPhrases !== undefined) {
    if (!Array.isArray(body.requiredPhrases)) return err('requiredPhrases must be an array', 400);
    patch.required_phrases = body.requiredPhrases.slice(0, 20).map((p: unknown) => String(p).slice(0, 120));
  }
  if (body.collectLeadDetails !== undefined) patch.collect_lead_details = Boolean(body.collectLeadDetails);
  if (body.escalateToCall    !== undefined) patch.escalate_to_call      = Boolean(body.escalateToCall);
  if (body.escalateToVideo   !== undefined) patch.escalate_to_video     = Boolean(body.escalateToVideo);
  if (body.knowledgeUrls !== undefined) {
    if (!Array.isArray(body.knowledgeUrls)) return err('knowledgeUrls must be an array', 400);
    patch.knowledge_urls = body.knowledgeUrls.slice(0, 10).map((u: unknown) => String(u).slice(0, 512));
  }
  if (body.starterQuestions !== undefined) {
    if (!Array.isArray(body.starterQuestions)) return err('starterQuestions must be an array', 400);
    patch.starter_questions = body.starterQuestions.slice(0, 10).map((q: unknown) => String(q).slice(0, 200));
  }
  if (body.notes !== undefined) patch.notes = body.notes ? String(body.notes).slice(0, 2000) : null;
  if (body.planSlug !== undefined) {
    const allowed = ['free', 'starter', 'pro', 'elite'];
    if (!allowed.includes(body.planSlug)) return err('planSlug must be free | starter | pro | elite', 400);
    patch.plan_slug = body.planSlug;
  }

  const { data, error } = await sb
    .from('business_workspace_settings')
    .upsert(patch as never, { onConflict: 'business_phone' })
    .select()
    .single();

  if (error) return err('failed to save settings', 500);

  // Invalidate the workspace settings cache so the next AI request picks up
  // the new settings without waiting for the 5-minute TTL to expire.
  const r = redis();
  if (r) await r.del(SETTINGS_CACHE_KEY(phone)).catch(() => null);

  return json(data);
};

// ── Response helpers ──────────────────────────────────────────────────────────

