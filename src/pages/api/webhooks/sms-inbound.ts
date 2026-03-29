/**
 * POST /api/webhooks/sms-inbound
 *
 * Twilio inbound SMS webhook — handles business YES/NO replies in the dispatch loop.
 *
 * Configure your Twilio number's "A message comes in" webhook URL to point here.
 *
 * Reply handling:
 *   YES / Y / ACCEPT / 1  → Accept the lead: lock it for this business, SMS consumer
 *   NO / N / PASS / SKIP  → Decline: advance dispatch queue to the next business
 *   STOP / UNSUBSCRIBE    → Opt the business out of future SMS outreach
 *   HELP / INFO           → Send a brief help message back
 *   (anything else)       → Ignored silently
 *
 * All requests are signature-verified against X-Twilio-Signature using HMAC-SHA1
 * and the Twilio auth token before any logic runs.
 */

import type { APIRoute } from 'astro';
import { redis, normalizePhone, createCallSession, bridgeNumber } from '../../../lib';
import { DK, BPDK, DISPATCH_TTL, type DispatchRecord, type QueuedBusiness } from '../dispatch';

export const prerender = false;

// Canonical affirmative and negative reply tokens
const YES_TOKENS = new Set(['yes', 'y', 'accept', '1', 'ok', 'sure', 'yep', 'yeah']);
const NO_TOKENS  = new Set(['no', 'n', 'pass', 'skip', 'decline', 'nope', '2']);
const OPT_OUT    = new Set(['stop', 'unsubscribe', 'cancel', 'quit', 'end']);

export const POST: APIRoute = async ({ request }) => {
  // Verify the request actually came from Twilio before processing
  const isValid = await verifyTwilioSignature(request.clone());
  if (!isValid) return twiml(''); // silently reject — don't leak info

  const form  = await request.formData().catch(() => new FormData());
  const from  = normalizePhone(String(form.get('From') || ''));
  const body  = String(form.get('Body') || '').trim();
  const token = body.toLowerCase().replace(/[^a-z0-9]/g, '');

  if (!from || !body) return twiml('');

  // Handle opt-out before anything else
  if (OPT_OUT.has(token)) {
    await recordOptOut(from);
    return twiml('<Message>You have been unsubscribed from ServiceSurfer lead alerts. Reply START to re-subscribe.</Message>');
  }

  // Handle help request
  if (token === 'help' || token === 'info') {
    return twiml('<Message>ServiceSurfer connects homeowners with local pros. Reply YES to accept a lead or NO to pass. Text STOP to unsubscribe.</Message>');
  }

  const r = redis();
  if (!r) return twiml('');

  // Look up the active dispatch for this business phone
  const dispatchId = await r.get<string>(BPDK(from)).catch(() => null);
  if (!dispatchId) return twiml(''); // no active dispatch — ignore

  const raw = await r.get<string | DispatchRecord>(DK(String(dispatchId))).catch(() => null);
  if (!raw) return twiml('');
  const record: DispatchRecord = typeof raw === 'string' ? JSON.parse(raw) : raw;

  // Don't process replies for already-resolved dispatches
  if (record.status === 'accepted' || record.status === 'declined_all') return twiml('');

  // Find this business's entry in the queue
  const queueIdx = record.businessQueue.findIndex(b => b.phone === from);
  if (queueIdx === -1) return twiml('');

  if (YES_TOKENS.has(token)) {
    await handleAccept(r, record, queueIdx, from);
    const bizName = record.businessQueue[queueIdx]?.name ?? record.businessName;
    return twiml(`<Message>Great! The consumer has been notified to call you. Good luck with this lead, ${bizName.split(' ')[0]}!</Message>`);
  }

  if (NO_TOKENS.has(token)) {
    await handleDecline(r, record, queueIdx, from);
    return twiml('<Message>Got it — we\'ll try another pro. Thank you!</Message>');
  }

  // Unrecognised reply — prompt for a valid response
  return twiml('<Message>Reply YES to accept this lead or NO to pass it.</Message>');
};

// ── Accept flow ───────────────────────────────────────────────────────────────

/**
 * Handles a YES reply: marks the lead as accepted, creates a call session,
 * and notifies the consumer via SMS with the bridge number + PIN.
 */
async function handleAccept(
  r: NonNullable<ReturnType<typeof redis>>,
  record: DispatchRecord,
  queueIdx: number,
  businessPhone: string,
): Promise<void> {
  const now = Date.now();
  const updatedQueue = record.businessQueue.map((b, i) =>
    i === queueIdx ? { ...b, response: 'accepted' as const } : b,
  );

  const updated: DispatchRecord = {
    ...record,
    businessPhone,
    businessName: record.businessQueue[queueIdx]?.name ?? record.businessName,
    businessQueue: updatedQueue,
    currentQueueIndex: queueIdx,
    acceptedAt: now,
    acceptedBy: businessPhone,
    status: 'accepted',
  };
  await r.set(DK(record.dispatchId), JSON.stringify(updated), { ex: DISPATCH_TTL }).catch(() => null);
  // Remove the phone index so no more replies are routed here
  await r.del(BPDK(businessPhone)).catch(() => null);

  // Notify the consumer so they can call the accepted business
  if (record.consumerPhone) {
    await notifyConsumerAccepted(
      record.consumerPhone,
      updated.businessName,
      updated.businessPhone,
      record.problem,
    );
  }
}

/**
 * Handles a NO reply: marks the business's queue entry as declined and
 * advances the dispatch to the next available business.
 */
async function handleDecline(
  r: NonNullable<ReturnType<typeof redis>>,
  record: DispatchRecord,
  queueIdx: number,
  businessPhone: string,
): Promise<void> {
  const updatedQueue: QueuedBusiness[] = record.businessQueue.map((b, i) =>
    i === queueIdx ? { ...b, response: 'declined' as const } : b,
  );

  // Remove phone index for declined business
  await r.del(BPDK(businessPhone)).catch(() => null);

  const updated: DispatchRecord = { ...record, businessQueue: updatedQueue };

  // Advance to the next pending business in the queue
  await advanceQueue(r, updated, queueIdx);
}

// ── Queue advancement ─────────────────────────────────────────────────────────

/**
 * Finds the next un-contacted business in the queue and dispatches to them.
 * If the queue is exhausted, marks the dispatch as declined_all and optionally
 * notifies the consumer to broaden their search.
 */
export async function advanceQueue(
  r: NonNullable<ReturnType<typeof redis>>,
  record: DispatchRecord,
  fromIndex: number,
): Promise<void> {
  // Find the next business that hasn't been contacted or rejected yet
  const nextIdx = record.businessQueue.findIndex(
    (b, i) => i > fromIndex && b.response === null && b.notifiedAt === null,
  );

  if (nextIdx === -1) {
    // Queue exhausted — no more businesses to try
    const exhausted: DispatchRecord = { ...record, status: 'declined_all' };
    await r.set(DK(record.dispatchId), JSON.stringify(exhausted), { ex: DISPATCH_TTL }).catch(() => null);

    if (record.consumerPhone) {
      await notifyConsumerSearching(record.consumerPhone);
    }
    return;
  }

  const next = record.businessQueue[nextIdx]!;
  const now  = Date.now();

  const updatedQueue: QueuedBusiness[] = record.businessQueue.map((b, i) =>
    i === nextIdx ? { ...b, notifiedAt: now, response: 'pending' as const } : b,
  );

  const updated: DispatchRecord = {
    ...record,
    businessPhone:     next.phone,
    businessName:      next.name,
    businessQueue:     updatedQueue,
    currentQueueIndex: nextIdx,
    smsSentAt:         now,
    status:            'sms_sent',
  };

  await r.set(DK(record.dispatchId), JSON.stringify(updated), { ex: DISPATCH_TTL }).catch(() => null);

  // Notify the next business
  const smsSent = await sendLeadSms(next.phone, next.name, record.problem, record.location).catch(() => false);
  if (smsSent) {
    await r.set(BPDK(next.phone), record.dispatchId, { ex: 60 * 30 }).catch(() => null);
  }
}

// ── Twilio signature verification ─────────────────────────────────────────────

/**
 * Verifies the X-Twilio-Signature header using HMAC-SHA1 and the Twilio auth token.
 * Returns true in local dev when TWILIO_AUTH_TOKEN is not set.
 *
 * Algorithm (per Twilio docs):
 *   1. Start with the full request URL.
 *   2. Sort POST params by name; append each key+value pair with no separator.
 *   3. HMAC-SHA1 sign the resulting string with the auth token.
 *   4. Base64-encode the hash and compare to X-Twilio-Signature.
 */
async function verifyTwilioSignature(request: Request): Promise<boolean> {
  const authToken = import.meta.env.TWILIO_AUTH_TOKEN;
  if (!authToken) return true; // local dev — skip verification

  const signature = request.headers.get('X-Twilio-Signature');
  if (!signature) return false;

  const url    = request.url;
  const form   = await request.formData().catch(() => new FormData());
  const params: Record<string, string> = {};
  for (const [k, v] of form.entries()) params[k] = String(v);

  // Build the string-to-sign: URL + sorted params (key immediately followed by value)
  const sortedKeys = Object.keys(params).sort();
  let toSign = url;
  for (const k of sortedKeys) toSign += k + params[k];

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const sig     = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(toSign));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return expected === signature;
}

// ── Opt-out management ────────────────────────────────────────────────────────

/** Records a business SMS opt-out in Redis. TTL-less key — persists until re-subscribe. */
async function recordOptOut(phone: string): Promise<void> {
  const r = redis();
  if (r) await r.set(`ss:sms:optout:${phone}`, '1').catch(() => null);
}

// ── SMS helpers ───────────────────────────────────────────────────────────────

async function sendLeadSms(
  to: string,
  businessName: string,
  problem: string,
  location: string,
): Promise<boolean> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return false;

  const lines = [
    `ServiceSurfer: New lead for ${businessName}!`,
    problem  ? `Problem: ${problem}`   : null,
    location ? `Location: ${location}` : null,
    'Reply YES to accept or NO to pass.',
  ].filter(Boolean);

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Basic ${btoa(`${sid}:${token}`)}`,
      },
      body: new URLSearchParams({ To: to, From: from, Body: lines.join('\n') }).toString(),
    },
  );
  return res.ok;
}

/**
 * Notifies the consumer that a business accepted their lead.
 * Creates a fresh call session so they get a new PIN to dial the bridge.
 */
async function notifyConsumerAccepted(
  consumerPhone: string,
  businessName: string,
  businessPhone: string,
  problem: string,
): Promise<void> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return;

  // Create a call session so the consumer can dial with a fresh PIN
  const session = await createCallSession(businessPhone, businessName);
  const bridge  = bridgeNumber().replace(/[^\d+]/g, '');

  const body = session
    ? [
        `ServiceSurfer: ${businessName} is ready to help with: ${problem || 'your request'}!`,
        `Call ${bridge} and enter PIN: ${session.pin}`,
        '(PIN valid for 15 minutes)',
      ].join('\n')
    : `ServiceSurfer: ${businessName} accepted your request for: ${problem || 'your service'}! They will call you shortly.`;

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Basic ${btoa(`${sid}:${token}`)}`,
      },
      body: new URLSearchParams({ To: consumerPhone, From: from, Body: body }).toString(),
    },
  );
}

/** Notifies the consumer that all pros were tried and suggests retrying. */
async function notifyConsumerSearching(consumerPhone: string): Promise<void> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from  = import.meta.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return;

  const site = import.meta.env.PUBLIC_SITE_URL || 'https://servicesurfer.app';
  const body = [
    'ServiceSurfer: All nearby pros are currently busy.',
    `Try again shortly or search for more options: ${site}`,
  ].join(' ');

  await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
    {
      method:  'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:  `Basic ${btoa(`${sid}:${token}`)}`,
      },
      body: new URLSearchParams({ To: consumerPhone, From: from, Body: body }).toString(),
    },
  );
}

// ── TwiML helper ──────────────────────────────────────────────────────────────

function twiml(inner: string) {
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`,
    { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } },
  );
}
