/**
 * POST /api/business/passkeys/authenticate/finish
 *
 * Step 2 of WebAuthn passkey authentication.
 *
 * Verifies the authenticator's assertion, bumps the credential counter (replay
 * prevention), logs the auth event in passkey_auth_events, and returns a signed
 * session token the client uses for subsequent authenticated requests.
 *
 * Request body: {
 *   userId?:    string       — required for non-discoverable flow
 *   challenge?: string       — required for discoverable (passkey-first) flow
 *   response:   AuthenticationResponseJSON
 * }
 *
 * Response: { verified: true, token: string, userId: string }
 *           | { verified: false, error: string }
 *
 * Session token is an HMAC-SHA256 signed payload:
 *   base64url(userId + "." + exp) + "." + base64url(signature)
 * where exp is a Unix timestamp (seconds) 24 hours from now.
 * Signed with BUSINESS_JWT_SECRET (falls back to DISPATCH_JOB_SECRET).
 */

import type { APIRoute } from 'astro';
import { verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { AuthenticationResponseJSON } from '@simplewebauthn/types';
import { getSupabase } from '../../../../../lib/supabase';
import { mintSessionToken } from '../../../../../lib/session';
import { json } from '../../../../../lib/api-helpers';

export const prerender = false;

const RP_ID  = () => import.meta.env.WEBAUTHN_RP_ID  || 'localhost';
const ORIGIN = () => import.meta.env.PUBLIC_SITE_URL || `https://${RP_ID()}`;

// ── Endpoint ──────────────────────────────────────────────────────────────────

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.response) return err('response required', 400);

  const authResponse: AuthenticationResponseJSON = body.response;
  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Resolve userId: either supplied, or looked up from the credential ID (discoverable flow)
  let userId: string | null = body.userId ? String(body.userId).slice(0, 64) : null;

  if (!userId) {
    // Discoverable flow — look up userId from the credential ID in the response
    const credId = authResponse.id;
    const { data: keyRow } = await sb
      .from('user_passkeys')
      .select('user_id')
      .eq('credential_id', credId)
      .single()
      .catch(() => ({ data: null }));
    if (!keyRow) return err('credential not found', 400);
    userId = keyRow.user_id;
  }

  // Fetch the stored challenge
  const challenge = body.challenge
    ? String(body.challenge)
    : await (async () => {
        const { data } = await sb
          .from('passkey_challenges')
          .select('id, challenge')
          .eq('user_id', userId!)
          .eq('purpose', 'authenticate')
          .is('used_at', null)
          .gte('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false })
          .limit(1)
          .single()
          .catch(() => ({ data: null }));
        return data?.challenge ?? null;
      })();

  if (!challenge) return err('no valid challenge — please restart authentication', 400);

  // Fetch the credential record
  const { data: credRow } = await sb
    .from('user_passkeys')
    .select('credential_id, public_key, counter, transports')
    .eq('credential_id', authResponse.id)
    .eq('user_id', userId)
    .single()
    .catch(() => ({ data: null }));

  if (!credRow) return err('credential not found for this user', 400);

  // Decode stored public key (base64url → Uint8Array)
  const pubKeyBytes = Uint8Array.from(
    atob(credRow.public_key.replace(/-/g, '+').replace(/_/g, '/')),
    c => c.charCodeAt(0),
  );

  // Verify the assertion
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response:                authResponse,
      expectedChallenge:       challenge,
      expectedOrigin:          ORIGIN(),
      expectedRPID:            RP_ID(),
      requireUserVerification: false,
      credential: {
        id:         credRow.credential_id,
        publicKey:  pubKeyBytes,
        counter:    credRow.counter,
        transports: (credRow.transports ?? []) as import('@simplewebauthn/types').AuthenticatorTransportFuture[],
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'verification failed';
    return err(msg, 400);
  }

  if (!verification.verified) return err('authentication failed', 401);

  const { authenticationInfo } = verification;

  // Bump counter and update last_used_at
  await sb
    .from('user_passkeys')
    .update({ counter: authenticationInfo.newCounter, last_used_at: new Date().toISOString() })
    .eq('credential_id', credRow.credential_id)
    .catch(() => null);

  // Mark challenge as used
  if (!body.challenge) {
    await sb
      .from('passkey_challenges')
      .update({ used_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('purpose', 'authenticate')
      .is('used_at', null)
      .catch(() => null);
  }

  // Log the auth event
  await sb.from('passkey_auth_events').insert({
    user_id:       userId,
    credential_id: credRow.credential_id,
    verified_at:   new Date().toISOString(),
  }).catch(() => null);

  // Issue a signed session token (delegates to shared lib/session.ts)
  const token = await mintSessionToken(userId);

  return json({ verified: true, token, userId });
};

const err = (m: string, s: number) => json({ error: m, verified: false }, s);
