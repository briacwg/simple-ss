import type { APIRoute } from 'astro';
import { resolveCallRef, createCallSession, bridgeNumber } from '../../lib';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  const { callRef, businessName } = await request.json().catch(() => ({}));
  if (!callRef) return json({ error: 'callRef required' }, 400);

  const phone = await resolveCallRef(callRef);
  if (!phone) return json({ error: 'invalid callRef' }, 400);

  const session = await createCallSession(phone, businessName || 'Business');
  if (!session) return json({ error: 'call unavailable — check Redis config' }, 503);

  const dial = bridgeNumber().replace(/[^\d+]/g, '');
  return json({ telHref: `tel:${dial},${session.pin}` });
};

const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'Content-Type': 'application/json' } });
