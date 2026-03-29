/**
 * DELETE /api/business/passkeys/revoke
 *
 * Removes a specific passkey credential from the authenticated user's account.
 *
 * Business owners should be able to revoke passkeys they no longer recognise
 * (e.g. a lost device) or that belong to a decommissioned authenticator.
 *
 * Safety guards:
 *   - Ownership check: only the credential's owner can revoke it (the row
 *     filter includes user_id = session.userId).
 *   - Last passkey guard: if revoking would leave the user with no passkeys,
 *     the request is rejected with 409 Conflict.  This prevents lock-out
 *     (the user must register a new passkey before revoking the last one).
 *
 * Authorization:   Bearer <session-token>
 * Request body:    { "credentialId": "abc..." }
 * Response (200):  { "revoked": true, "credentialId": "abc..." }
 * Response (409):  { "error": "cannot revoke last passkey", "revoked": false }
 */

import type { APIRoute } from 'astro';
import { getBusinessSession } from '../../../../lib/session';
import { getSupabase } from '../../../../lib/supabase';

export const prerender = false;

export const DELETE: APIRoute = async ({ request }) => {
  const session = await getBusinessSession(request);
  if (!session) return err('unauthorized', 401);

  const body = await request.json().catch(() => null);
  if (!body?.credentialId) return err('credentialId required', 400);
  const credentialId = String(body.credentialId).slice(0, 512);

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  // Check how many passkeys the user currently has
  const { count, error: countError } = await sb
    .from('user_passkeys')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', session.userId);

  if (countError) return err('failed to check passkey count', 500);

  if ((count ?? 0) <= 1) {
    return new Response(
      JSON.stringify({ error: 'cannot revoke last passkey — register a new device first', revoked: false }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Delete the credential — user_id filter prevents cross-user revocation
  const { error: deleteError } = await sb
    .from('user_passkeys')
    .delete()
    .eq('credential_id', credentialId)
    .eq('user_id', session.userId);

  if (deleteError) return err('failed to revoke passkey', 500);

  return json({ revoked: true, credentialId });
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
const err = (m: string, s: number) => json({ error: m, revoked: false }, s);
