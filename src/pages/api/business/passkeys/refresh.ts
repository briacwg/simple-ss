/**
 * POST /api/business/passkeys/refresh
 *
 * Extends a valid business session token by issuing a fresh 24-hour token.
 *
 * Accepts the current token via `Authorization: Bearer <token>`.  The old
 * token must be valid and non-expired; no re-authentication is required.
 * This allows clients to silently refresh sessions before expiry without
 * asking the user to re-authenticate with their passkey.
 *
 * Security considerations:
 *   - Refresh is only allowed within the token's validity window, so a
 *     stolen token cannot be refreshed indefinitely after expiry.
 *   - The old token remains technically valid until its original exp — there
 *     is no server-side revocation of old tokens.  For revocation, issue a
 *     short TTL and rely on the refresh endpoint.
 *   - Response always uses the same HMAC key as the original mint, so a
 *     key rotation (BUSINESS_JWT_SECRET change) immediately invalidates all
 *     existing tokens and their refresh attempts.
 *
 * Request headers:  Authorization: Bearer <session-token>
 * Response:         { token: string, userId: string, expiresAt: number }
 */

import type { APIRoute } from 'astro';
import { getBusinessSession, mintSessionToken } from '../../../../lib/session';
import { json, err } from '../../../../lib/api-helpers';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const session = await getBusinessSession(request);
  if (!session) {
    return err('invalid or expired session token', 401);
  }

  // Issue a fresh 24-hour token for the same userId
  const token     = await mintSessionToken(session.userId);
  const expiresAt = Math.floor(Date.now() / 1000) + 86_400;

  return json({ token, userId: session.userId, expiresAt });
};

