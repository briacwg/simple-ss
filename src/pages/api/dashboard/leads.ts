/**
 * GET /api/dashboard/leads?phone=+15551234567&limit=50&offset=0
 *
 * Returns individual lead events for the authenticated business, newest first.
 * Used by the dashboard's lead history and missed-call recovery sections.
 */

import type { APIRoute } from 'astro';
import { normalizePhone } from '../../../lib';
import { getSupabase } from '../../../lib/supabase';
import { getBusinessSession } from '../../../lib/session';
import { json, err } from '../../../lib/api-helpers';

export const prerender = false;

export const GET: APIRoute = async ({ url, request }) => {
  const jwtSecret = import.meta.env.BUSINESS_JWT_SECRET || import.meta.env.DISPATCH_JOB_SECRET;
  if (jwtSecret) {
    const session = await getBusinessSession(request);
    if (!session) return err('unauthorized', 401);
  }

  const rawPhone = url.searchParams.get('phone');
  if (!rawPhone) return err('phone query param required', 400);
  const phone = normalizePhone(rawPhone);
  if (!phone) return err('invalid phone number', 400);

  const limit  = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')  ?? 50)));
  const offset = Math.max(0, Number(url.searchParams.get('offset') ?? 0));

  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  const { data, error } = await sb
    .from('lead_events')
    .select('id, event_type, service_label, consumer_phone, meta, created_at')
    .eq('business_phone', phone)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) return err('failed to load leads', 500);

  return json({ leads: data ?? [], total: (data ?? []).length, offset });
};
