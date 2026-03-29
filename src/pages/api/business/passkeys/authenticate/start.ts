/**
 * POST /api/business/passkeys/authenticate/start
 *
 * Step 1 of WebAuthn passkey authentication.
 *
 * Generates authentication options and stores the challenge in Supabase.
 * Supports both:
 *   - Targeted auth: userId supplied → allowCredentials populated with their keys
 *   - Discoverable (resident key) auth: no userId → empty allowCredentials
 *
 * Request body: { userId?: string }
 * Response:     PublicKeyCredentialRequestOptionsJSON
 */

import type { APIRoute } from 'astro';
import { generateAuthenticationOptions } from '@simplewebauthn/server';
import type { AuthenticatorTransportFuture } from '@simplewebauthn/types';
import { getSupabase } from '../../../../../lib/supabase';
import { json, err } from '../../../../../lib/api-helpers';

export const prerender = false;

const RP_ID = () => import.meta.env.WEBAUTHN_RP_ID || 'localhost';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const userId: string | null = body.userId ? String(body.userId).slice(0, 64) : null;

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Build allowCredentials for targeted (non-discoverable) flow
  let allowCredentials: Array<{ id: string; transports?: AuthenticatorTransportFuture[] }> = [];

  if (userId) {
    const { data: keys } = await sb
      .from('user_passkeys')
      .select('credential_id, transports')
      .eq('user_id', userId)
      .catch(() => ({ data: null }));

    allowCredentials = (keys ?? []).map(k => ({
      id:         k.credential_id,
      transports: (k.transports ?? []) as AuthenticatorTransportFuture[],
    }));

    if (allowCredentials.length === 0) {
      return err('no passkeys registered for this user', 404);
    }
  }

  const options = await generateAuthenticationOptions({
    rpID:              RP_ID(),
    allowCredentials,
    userVerification:  'preferred',
    timeout:           300_000,
  });

  // Persist challenge (userId may be null for discoverable flow)
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  if (userId) {
    await sb.from('passkey_challenges').insert({
      user_id:    userId,
      purpose:    'authenticate',
      challenge:  options.challenge,
      expires_at: expiresAt,
      used_at:    null,
    }).catch(() => null);
  }

  // For discoverable flow, embed the challenge in the response for the finish step
  return json({ ...options, _challenge: options.challenge });
};

