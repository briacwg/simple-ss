/**
 * POST /api/stripe/webhook
 *
 * Stripe webhook handler — processes subscription lifecycle events to keep
 * business plan_slug in sync with Stripe subscription status.
 *
 * Handled events
 * ──────────────
 *   checkout.session.completed    → upgrade plan_slug after successful checkout
 *   customer.subscription.updated → handle plan changes, reactivations
 *   customer.subscription.deleted → downgrade to 'free' on cancellation
 *
 * Security
 * ────────
 * Every inbound request is verified against `Stripe-Signature` using
 * STRIPE_WEBHOOK_SECRET (the signing secret from your Stripe dashboard webhook
 * settings).  Requests with an invalid or missing signature are rejected 400.
 *
 * Idempotency
 * ───────────
 * Stripe may deliver the same event more than once.  The handler is idempotent:
 * upsert operations on business_workspace_settings are safe to replay.
 *
 * Setup
 * ─────
 * 1. In the Stripe dashboard, add a webhook endpoint pointing to
 *    https://your-domain/api/stripe/webhook.
 * 2. Subscribe to: checkout.session.completed, customer.subscription.updated,
 *    customer.subscription.deleted.
 * 3. Copy the signing secret to STRIPE_WEBHOOK_SECRET in your env.
 */

import type { APIRoute } from 'astro';
import { getSupabase } from '../../../lib/supabase';
import { json, err } from '../../../lib/api-helpers';

export const prerender = false;

/** Stripe subscription status → ServiceSurfer plan slug. */
const STATUS_TO_PLAN: Record<string, string> = {
  active:   'active',   // resolved to plan slug via metadata below
  trialing: 'active',
  past_due: 'active',   // still active, just payment issue
  canceled:  'free',
  unpaid:    'free',
  incomplete_expired: 'free',
};

/** Metadata key carrying the plan slug (set by /api/stripe/checkout). */
const PLAN_SLUG_KEY = 'plan_slug';
const PHONE_KEY     = 'business_phone';

export const POST: APIRoute = async ({ request }) => {
  const webhookSecret = import.meta.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) return err('webhook not configured', 503);

  const rawBody  = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') ?? '';

  // ── Verify Stripe signature ───────────────────────────────────────────────
  const signatureValid = await verifyStripeSignature(rawBody, sigHeader, webhookSecret);
  if (!signatureValid) return err('invalid stripe signature', 400);

  // ── Parse event ──────────────────────────────────────────────────────────
  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return err('invalid JSON', 400);
  }

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // ── Route event ──────────────────────────────────────────────────────────
  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as StripeCheckoutSession;
      if (session.mode !== 'subscription') break;

      const meta  = session.subscription_data?.metadata ?? {};
      const phone = meta[PHONE_KEY];
      const plan  = meta[PLAN_SLUG_KEY];

      if (phone && plan) {
        await upsertPlanSlug(sb, phone, plan);
      }
      break;
    }

    case 'customer.subscription.updated': {
      const sub   = event.data.object as StripeSubscription;
      const meta  = sub.metadata ?? {};
      const phone = meta[PHONE_KEY];
      if (!phone) break;

      const statusPlan = STATUS_TO_PLAN[sub.status] ?? 'free';
      const planSlug   = statusPlan === 'active'
        ? (meta[PLAN_SLUG_KEY] ?? 'starter')  // preserve plan from metadata
        : statusPlan;

      await upsertPlanSlug(sb, phone, planSlug);
      break;
    }

    case 'customer.subscription.deleted': {
      const sub   = event.data.object as StripeSubscription;
      const phone = sub.metadata?.[PHONE_KEY];
      if (phone) await upsertPlanSlug(sb, phone, 'free');
      break;
    }

    default:
      // Unhandled events acknowledged but not processed
      break;
  }

  return json({ received: true });
};

// ── Database helper ───────────────────────────────────────────────────────────

async function upsertPlanSlug(
  sb: NonNullable<ReturnType<typeof getSupabase>>,
  businessPhone: string,
  planSlug: string,
): Promise<void> {
  await sb
    .from('business_workspace_settings')
    .upsert({ business_phone: businessPhone, plan_slug: planSlug }, { onConflict: 'business_phone' })
    .catch(() => null);
}

// ── Stripe HMAC-SHA256 signature verification ─────────────────────────────────
//
// Stripe signs webhooks as:
//   Stripe-Signature: t=<timestamp>,v1=<sig1>[,v1=<sig2>...]
//
// The signed payload is: `${timestamp}.${rawBody}`.
// We verify against each v1 signature in the header.

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  try {
    const parts = Object.fromEntries(
      sigHeader.split(',').map(p => {
        const [k, ...v] = p.split('=');
        return [k.trim(), v.join('=')];
      }),
    );
    const timestamp = parts['t'];
    const signatures = sigHeader
      .split(',')
      .filter(p => p.trim().startsWith('v1='))
      .map(p => p.trim().slice(3));

    if (!timestamp || !signatures.length) return false;

    const signedPayload = `${timestamp}.${rawBody}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = await crypto.subtle.sign(
      'HMAC', key, new TextEncoder().encode(signedPayload),
    );
    const expectedHex = Array.from(new Uint8Array(expected))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    return signatures.some(s => s === expectedHex);
  } catch {
    return false;
  }
}

// ── Minimal Stripe event types ────────────────────────────────────────────────

interface StripeEvent {
  type: string;
  data: { object: Record<string, unknown> };
}

interface StripeCheckoutSession {
  mode: string;
  subscription_data?: { metadata?: Record<string, string> };
}

interface StripeSubscription {
  status: string;
  metadata?: Record<string, string>;
}

// ── Response helpers ──────────────────────────────────────────────────────────

