/**
 * GET /api/status
 *
 * Health check endpoint — verifies service connectivity and required
 * environment variable configuration without exposing secret values.
 *
 * Used by Vercel health checks, uptime monitors, and the deploy pipeline
 * to confirm that all integrations are wired up before routing traffic.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../lib';
import { getSupabase } from '../../lib/supabase';

export const prerender = false;

/** Env vars that must be present for the app to function correctly. */
const REQUIRED_VARS = [
  'CALL_REF_SECRET',
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'GOOGLE_PLACES_API_KEY',
  'CEREBRAS_API_KEY',
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
  'PUBLIC_SERVICE_SURFER_CALL_NUMBER',
] as const;

/** Env vars that enable optional features (missing = degraded, not broken). */
const OPTIONAL_VARS = [
  'QSTASH_URL',
  'QSTASH_TOKEN',
  'VIDEO_APP_URL',
  'PUBLIC_SITE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'WEBAUTHN_RP_ID',
  'BUSINESS_JWT_SECRET',
] as const;

export const GET: APIRoute = async () => {
  // Check Redis connectivity with a lightweight PING
  let redisOk = false;
  try {
    const r = redis();
    if (r) {
      const pong = await Promise.race<unknown>([
        r.ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]);
      redisOk = pong === 'PONG';
    }
  } catch { /* redis unavailable */ }

  // Check Supabase connectivity (optional — won't affect overall ok status)
  let supabaseOk = false;
  try {
    const sb = getSupabase();
    if (sb) {
      const { error } = await sb.from('lead_events').select('id').limit(1);
      supabaseOk = !error;
    }
  } catch { /* supabase unavailable */ }

  // Verify required env vars are non-empty (values are never returned)
  const checks: Record<string, boolean> = {};
  for (const v of REQUIRED_VARS) {
    checks[v] = Boolean((import.meta.env as Record<string, string | undefined>)[v]);
  }

  // Report optional feature flags
  const optional: Record<string, boolean> = {};
  for (const v of OPTIONAL_VARS) {
    optional[v] = Boolean((import.meta.env as Record<string, string | undefined>)[v]);
  }

  const allRequired = Object.values(checks).every(Boolean);
  const ok = redisOk && allRequired;

  return new Response(
    JSON.stringify({ ok, redis: redisOk, supabase: supabaseOk, checks, optional }),
    {
      status: ok ? 200 : 503,
      headers: { 'Content-Type': 'application/json' },
    },
  );
};
