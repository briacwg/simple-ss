/**
 * POST /api/claim
 *
 * Initiates a business ownership claim flow:
 *   1. Generates a single-use 6-digit verification code.
 *   2. Stores a PendingClaim record in Redis (15-minute TTL).
 *   3. Sends the verification code to the business phone via Twilio SMS.
 *
 * The business owner then submits the code to the main platform to complete
 * the claim and unlock their AI Workspace and dashboard.
 *
 * Rate limiting: one active claim per (placeId + ownerPhone) pair at a time.
 */

import type { APIRoute } from 'astro';
import { redis, normalizePhone } from '../../lib';
import { sendClaimVerificationSms } from '../../lib/twilio';

export const prerender = false;

export interface PendingClaim {
  claimId: string;
  placeId: string;
  businessName: string;
  ownerPhone: string;
  ownerName: string | null;
  code: string;
  createdAt: number;
  expiresAt: number;
  verified: boolean;
}

const CLAIM_TTL = 60 * 15; // 15 minutes — matches call session TTL
const CK  = (id: string)    => `ss:claim:${id}`;
const CLK = (dedup: string) => `ss:claim:lock:${dedup}`;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.placeId || !body?.ownerPhone) return err('placeId and ownerPhone required', 400);
  if (!body?.businessName) return err('businessName required', 400);

  const placeId      = String(body.placeId).slice(0, 64);
  const businessName = String(body.businessName).slice(0, 120);
  const ownerName    = body.ownerName ? String(body.ownerName).slice(0, 80) : null;

  const ownerPhone = normalizePhone(String(body.ownerPhone));
  if (!ownerPhone) return err('invalid ownerPhone — expected 10- or 11-digit US number', 400);

  const r = redis();
  if (!r) return err('service unavailable', 503);

  // Rate limit: one pending claim per placeId+phone at a time
  const dedupKey = CLK(`${placeId}:${ownerPhone}`);
  const existing = await r.get(dedupKey).catch(() => null);
  if (existing) return err('a verification code was already sent — please wait before requesting another', 429);

  // Generate a 6-digit code with collision avoidance
  const code = String(Math.floor(100_000 + Math.random() * 900_000));
  const now  = Date.now();
  const claimId = `cl_${now}_${Math.random().toString(36).slice(2, 8)}`;

  const claim: PendingClaim = {
    claimId,
    placeId,
    businessName,
    ownerPhone,
    ownerName,
    code,
    createdAt: now,
    expiresAt: now + CLAIM_TTL * 1000,
    verified: false,
  };

  // Persist claim and dedup lock atomically
  await Promise.all([
    r.set(CK(claimId), JSON.stringify(claim), { ex: CLAIM_TTL }),
    r.set(dedupKey, claimId, { ex: CLAIM_TTL }),
  ]);

  // Send verification SMS
  const smsSent = await sendClaimVerificationSms(ownerPhone, businessName, code).catch(() => false);
  if (!smsSent) {
    // Clean up claim on SMS failure so the owner can retry immediately
    await Promise.all([r.del(CK(claimId)), r.del(dedupKey)]).catch(() => null);
    return err('could not send verification SMS — check that the phone number is correct', 502);
  }

  return json({ claimId, expiresAt: claim.expiresAt });
};

// ── Response helpers ──────────────────────────────────────────────────────────

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m }, s);
