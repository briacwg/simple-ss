/**
 * POST /api/stripe/checkout
 *
 * Creates a Stripe Checkout Session for a business to upgrade their plan.
 *
 * The session is created in "subscription" mode.  On success, Stripe redirects
 * to /business/dashboard?checkout=success; on cancel to /business/dashboard.
 *
 * Plan → price ID mapping is maintained in PLAN_PRICE_IDS below.
 * The actual price IDs must be created in your Stripe dashboard and set via
 * env vars (STRIPE_PRICE_STARTER, STRIPE_PRICE_PRO, STRIPE_PRICE_ELITE).
 *
 * Session includes the business_phone in metadata so the webhook can identify
 * which workspace_settings row to update after payment.
 *
 * Auth: requires a valid business session token (Authorization: Bearer <token>).
 */

import type { APIRoute } from 'astro';
import { getBusinessSession } from '../../../lib/session';
import { getSupabase } from '../../../lib/supabase';
import { json, err } from '../../../lib/api-helpers';

export const prerender = false;

/** Supported upgrade targets. */
const VALID_PLANS = ['starter', 'pro', 'elite'] as const;
type PlanSlug = (typeof VALID_PLANS)[number];

/** Env-var name for each plan's Stripe price ID. */
const PRICE_ENV: Record<PlanSlug, string> = {
  starter: 'STRIPE_PRICE_STARTER',
  pro:     'STRIPE_PRICE_PRO',
  elite:   'STRIPE_PRICE_ELITE',
};

export const POST: APIRoute = async ({ request }) => {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const session = await getBusinessSession(request);
  if (!session) return err('unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body) return err('invalid JSON body', 400);

  const plan = String(body.plan ?? '').toLowerCase() as PlanSlug;
  if (!(VALID_PLANS as readonly string[]).includes(plan)) {
    return err(`plan must be one of: ${VALID_PLANS.join(', ')}`, 400);
  }

  const stripeKey = import.meta.env.STRIPE_SECRET_KEY;
  if (!stripeKey) return err('billing not configured', 503);

  const priceId = (import.meta.env as Record<string, string | undefined>)[PRICE_ENV[plan]];
  if (!priceId) return err(`price ID for plan "${plan}" not configured`, 503);

  // ── Look up business phone from workspace settings ───────────────────────
  const sb = getSupabase();
  let businessPhone: string | null = null;
  if (sb) {
    const { data } = await sb
      .from('business_workspace_settings')
      .select('business_phone')
      .limit(1)
      .single()
      .catch(() => ({ data: null }));
    businessPhone = data?.business_phone ?? null;
  }

  const siteUrl = import.meta.env.PUBLIC_SITE_URL || 'https://simple.servicesurfer.app';

  // ── Create Stripe Checkout Session ───────────────────────────────────────
  const params = new URLSearchParams({
    mode:                         'subscription',
    'line_items[0][price]':       priceId,
    'line_items[0][quantity]':    '1',
    success_url:                  `${siteUrl}/business/dashboard?checkout=success&plan=${plan}`,
    cancel_url:                   `${siteUrl}/business/dashboard`,
    'subscription_data[metadata][plan_slug]':       plan,
    'subscription_data[metadata][user_id]':         session.userId,
    ...(businessPhone
      ? { 'subscription_data[metadata][business_phone]': businessPhone }
      : {}),
  });

  const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${stripeKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  const data = await res.json() as Record<string, unknown>;
  if (!res.ok) return err(String(data.error ?? 'stripe error'), 502);

  return json({ url: data.url, sessionId: data.id });
};

