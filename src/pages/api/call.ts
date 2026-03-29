/**
 * POST /api/call
 *
 * Creates a secure call session for a matched business and returns a tel: href
 * the browser can open to start the call via the Twilio bridge.
 *
 * Flow:
 *   1. Client sends the HMAC-signed `callRef` (never the raw phone number).
 *   2. Server verifies the signature and resolves the business phone.
 *   3. A 6-digit PIN + opaque token are stored in Redis for 15 minutes.
 *   4. Returns `tel:BRIDGE_NUMBER,PIN` — the comma causes most dialers to
 *      automatically send the PIN as DTMF after the call connects.
 */

import type { APIRoute } from 'astro';
import { resolveCallRef, createCallSession, bridgeNumber } from '../../lib';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { callRef, businessName } = await request.json().catch(() => ({}));
  if (!callRef) return json({ error: 'callRef required' }, 400);

  // Verify HMAC signature and extract the raw phone number
  const phone = await resolveCallRef(callRef);
  if (!phone) return json({ error: 'invalid callRef' }, 400);

  // Allocate a PIN + session token — stored in Redis with a 15-min TTL
  const session = await createCallSession(phone, businessName || 'Business');
  if (!session) return json({ error: 'call unavailable — check Redis config' }, 503);

  // Strip non-dialable characters from the bridge number
  const dial = bridgeNumber().replace(/[^\d+]/g, '');
  return json({ telHref: `tel:${dial},${session.pin}` });
};

const json = (d: unknown, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
