/**
 * POST /api/business/passkeys/register/finish
 *
 * Step 2 of WebAuthn passkey registration.
 *
 * Verifies the authenticator's registration response against the stored
 * challenge, then persists the new credential in user_passkeys.
 *
 * Request body: { userId: string, response: RegistrationResponseJSON }
 * Response:     { verified: true, credentialId: string }
 *               | { verified: false, error: string }
 *
 * On success the passkey_challenges row is marked used_at to prevent replay.
 * The credential's public key is stored as base64url; the counter starts at 0
 * and is bumped on each authentication.
 */

import type { APIRoute } from 'astro';
import { verifyRegistrationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON } from '@simplewebauthn/types';
import { getSupabase } from '../../../../../lib/supabase';

export const prerender = false;

const RP_ID     = () => import.meta.env.WEBAUTHN_RP_ID   || 'localhost';
const ORIGIN    = () => import.meta.env.PUBLIC_SITE_URL  || `https://${RP_ID()}`;

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => null);
  if (!body?.userId || !body?.response) {
    return err('userId and response required', 400);
  }

  const userId: string               = String(body.userId).slice(0, 64);
  const regResponse: RegistrationResponseJSON = body.response;

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Fetch the most recent unused, unexpired 'register' challenge for this user
  const { data: challengeRow } = await sb
    .from('passkey_challenges')
    .select('id, challenge, expires_at, used_at')
    .eq('user_id', userId)
    .eq('purpose', 'register')
    .is('used_at', null)
    .gte('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1)
    .single()
    .catch(() => ({ data: null }));

  if (!challengeRow) return err('no valid challenge found — please restart registration', 400);

  // Verify the registration response
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response:                regResponse,
      expectedChallenge:       challengeRow.challenge,
      expectedOrigin:          ORIGIN(),
      expectedRPID:            RP_ID(),
      requireUserVerification: false,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'verification failed';
    return err(msg, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return err('registration verification failed', 400);
  }

  const { credential } = verification.registrationInfo;

  // Mark the challenge as used to prevent replay
  await sb
    .from('passkey_challenges')
    .update({ used_at: new Date().toISOString() })
    .eq('id', challengeRow.id)
    .catch(() => null);

  // Encode the public key as base64url for storage
  const pubKeyB64 = Buffer.from(credential.publicKey).toString('base64url');

  // Persist the new credential
  const { error: insertError } = await sb.from('user_passkeys').insert({
    user_id:       userId,
    credential_id: credential.id,
    public_key:    pubKeyB64,
    counter:       credential.counter,
    transports:    (regResponse.response.transports ?? []) as string[],
    device_type:   credential.deviceType ?? null,
    backed_up:     credential.backedUp   ?? null,
    friendly_name: body.friendlyName ? String(body.friendlyName).slice(0, 80) : null,
    last_used_at:  null,
  });

  if (insertError) {
    // Unique constraint violation means this credential is already registered
    if (insertError.code === '23505') return err('credential already registered', 409);
    console.error('[passkeys/register/finish] insert error:', insertError.message);
    return err('failed to save credential', 500);
  }

  return json({ verified: true, credentialId: credential.id });
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m, verified: false }, s);
