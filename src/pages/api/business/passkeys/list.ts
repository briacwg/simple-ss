/**
 * GET /api/business/passkeys/list
 *
 * Returns all registered passkeys for the authenticated business owner.
 *
 * Used by the business settings UI to show which devices have passkeys
 * registered (device type, friendly name, last used date) so the owner can
 * review and revoke individual credentials.
 *
 * Authorization: Bearer <session-token>
 *
 * Response:
 * ```json
 * {
 *   "passkeys": [
 *     {
 *       "credentialId": "abc...",
 *       "friendlyName": "MacBook Touch ID",
 *       "deviceType": "platform",
 *       "backedUp": true,
 *       "transports": ["internal"],
 *       "lastUsedAt": "2026-03-29T12:00:00Z",
 *       "createdAt": "2026-01-15T09:30:00Z"
 *     }
 *   ]
 * }
 * ```
 */

import type { APIRoute } from 'astro';
import { getBusinessSession } from '../../../../lib/session';
import { getSupabase } from '../../../../lib/supabase';
import { json, err } from '../../../../lib/api-helpers';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const session = await getBusinessSession(request);
  if (!session) return err('unauthorized', 401);

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  type PasskeyRow = {
    credential_id: string; friendly_name: string | null; device_type: string | null;
    backed_up: boolean | null; transports: string[]; last_used_at: string | null; created_at: string;
  };
  const { data, error } = await sb
    .from('user_passkeys')
    .select('credential_id, friendly_name, device_type, backed_up, transports, last_used_at, created_at')
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })
    .then(r => r, () => ({ data: null, error: new Error('query failed') })) as { data: PasskeyRow[] | null; error: Error | null };

  if (error) return err('failed to load passkeys', 500);

  const passkeys = (data ?? []).map(k => ({
    credentialId: k.credential_id,
    friendlyName: k.friendly_name,
    deviceType:   k.device_type,
    backedUp:     k.backed_up,
    transports:   k.transports,
    lastUsedAt:   k.last_used_at,
    createdAt:    k.created_at,
  }));

  return json({ passkeys });
};

