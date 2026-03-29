/**
 * POST /api/claim/verify
 *
 * Step 2 of the business ownership claim flow.
 *
 * Accepts the claimId issued by POST /api/claim and the 6-digit verification
 * code the business owner received via SMS.  On success, marks the claim as
 * verified in Redis so the main ServiceSurfer platform can confirm it.
 *
 * Verification rules
 * ──────────────────
 * - The claim record must exist and not be expired (15-minute TTL).
 * - The supplied code must match the stored code exactly.
 * - Claims can only be verified once (re-submission returns 409).
 *
 * After verification, callers should redirect the business owner to the
 * AI Workspace or dashboard onboarding flow.
 */

import type { APIRoute } from 'astro';
import { redis } from '../../../lib';
import type { PendingClaim } from '../claim';

export const prerender = false;

const CK = (id: string) => `ss:claim:${id}`;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.claimId || !body?.code) return err('claimId and code required', 400);

  const claimId = String(body.claimId).slice(0, 64);
  const code    = String(body.code).replace(/\D/g, '').slice(0, 6);

  if (code.length !== 6) return err('code must be 6 digits', 400);

  const r = redis();
  if (!r) return err('service unavailable', 503);

  // Fetch pending claim
  const raw = await r.get<string | PendingClaim>(CK(claimId)).catch(() => null);
  if (!raw) return err('claim not found or expired', 404);

  const claim: PendingClaim = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Already verified?
  if (claim.verified) return err('claim already verified', 409);

  // Code mismatch — constant-time comparison to avoid timing oracle
  if (!timingSafeEqual(code, claim.code)) return err('invalid verification code', 400);

  // Expiry double-check (Redis TTL handles it, but belt-and-suspenders)
  if (Date.now() > claim.expiresAt) return err('verification code expired — request a new one', 410);

  // Mark verified
  const verified: PendingClaim = { ...claim, verified: true };
  const remaining = Math.ceil((claim.expiresAt - Date.now()) / 1000);
  await r.set(CK(claimId), JSON.stringify(verified), { ex: Math.max(remaining, 1) }).catch(() => null);

  return json({
    verified:     true,
    claimId:      claim.claimId,
    businessName: claim.businessName,
    placeId:      claim.placeId,
    ownerPhone:   claim.ownerPhone,
  });
};

/**
 * Constant-time string equality to prevent timing attacks on the OTP.
 * Both strings are padded to the same length before comparison.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
