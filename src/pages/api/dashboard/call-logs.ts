/**
 * GET /api/dashboard/call-logs?phone=+15551234567&limit=50
 *
 * Pulls Twilio call records for a given business phone — both legs:
 *   - Inbound calls TO that number
 *   - Outbound calls FROM that number
 *
 * Returns them merged and sorted newest-first so you can trace exactly what
 * happened for any business: who called, when, duration, status.
 *
 * Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN env vars.
 */

import type { APIRoute } from 'astro';
import { normalizePhone } from '../../../lib';
import { getBusinessSession } from '../../../lib/session';
import { json, err } from '../../../lib/api-helpers';

export const prerender = false;

interface TwilioCall {
  sid:          string;
  from:         string;
  to:           string;
  status:       string;       // queued | ringing | in-progress | completed | busy | failed | no-answer | canceled
  direction:    string;       // inbound | outbound-api | outbound-dial
  duration:     string;       // seconds as string
  start_time:   string;       // RFC2822
  end_time:     string;
  price:        string | null;
  price_unit:   string | null;
}

interface TwilioListResponse {
  calls: TwilioCall[];
}

async function fetchCalls(sid: string, token: string, params: Record<string, string>): Promise<TwilioCall[]> {
  const qs = new URLSearchParams(params).toString();
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json?${qs}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`,
    },
  });
  if (!res.ok) return [];
  const data = await res.json() as TwilioListResponse;
  return data.calls ?? [];
}

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

  const limit = Math.min(Number(url.searchParams.get('limit') || '50'), 100);

  const accountSid = import.meta.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken  = import.meta.env.TWILIO_AUTH_TOKEN?.trim();
  if (!accountSid || !authToken) return err('Twilio credentials not configured', 503);

  const pageSize = String(Math.min(limit, 100));

  // Fetch calls where this business was the recipient (inbound) AND caller (outbound)
  const [inbound, outbound] = await Promise.all([
    fetchCalls(accountSid, authToken, { To: phone,   PageSize: pageSize }),
    fetchCalls(accountSid, authToken, { From: phone, PageSize: pageSize }),
  ]);

  // Merge, deduplicate by SID, sort newest first
  const seen = new Set<string>();
  const merged: TwilioCall[] = [];
  for (const call of [...inbound, ...outbound]) {
    if (!seen.has(call.sid)) {
      seen.add(call.sid);
      merged.push(call);
    }
  }

  merged.sort((a, b) => new Date(b.start_time).getTime() - new Date(a.start_time).getTime());

  const calls = merged.slice(0, limit).map(c => ({
    sid:       c.sid,
    from:      c.from,
    to:        c.to,
    status:    c.status,
    direction: c.direction,
    duration:  Number(c.duration || 0),  // seconds
    startTime: c.start_time,
    endTime:   c.end_time,
    price:     c.price ? `${c.price} ${c.price_unit ?? 'USD'}` : null,
  }));

  return json({ phone, calls, total: calls.length });
};
