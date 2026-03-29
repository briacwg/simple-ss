/**
 * Twilio SMS client.
 *
 * Centralises all outbound Twilio Messages API calls so that every file that
 * needs to send an SMS imports a single typed helper instead of re-implementing
 * the same `fetch` + URL-encoded body pattern.
 *
 * Usage
 * ─────
 * ```ts
 * import { sendSms } from '../../lib/twilio';
 *
 * const ok = await sendSms('+13125550100', 'Hello from ServiceSurfer!');
 * ```
 *
 * Error handling
 * ──────────────
 * `sendSms` never throws — it catches all network / API errors and returns
 * `false`.  Callers decide how to handle delivery failures.
 *
 * Configuration
 * ─────────────
 * Reads TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER from
 * `import.meta.env`.  Returns `false` (silently) when any of these is absent
 * so that local dev without Twilio credentials degrades gracefully.
 */

export interface SmsResult {
  ok: boolean;
  /** Twilio message SID on success. */
  sid?: string;
  /** Human-readable error description on failure. */
  error?: string;
}

/**
 * Sends an outbound SMS via the Twilio Messages API.
 *
 * @param to    E.164 recipient phone number.
 * @param body  Message text (≤1600 characters; longer messages are split by Twilio).
 * @param from  Sender number; defaults to `TWILIO_FROM_NUMBER` env var.
 * @returns     `{ ok: true, sid }` on success or `{ ok: false, error }` on failure.
 */
export async function sendSms(
  to: string,
  body: string,
  from?: string,
): Promise<SmsResult> {
  const sid   = import.meta.env.TWILIO_ACCOUNT_SID;
  const token = import.meta.env.TWILIO_AUTH_TOKEN;
  const from_ = from ?? import.meta.env.TWILIO_FROM_NUMBER;

  if (!sid || !token || !from_) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }

  try {
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method:  'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:  `Basic ${btoa(`${sid}:${token}`)}`,
        },
        body: new URLSearchParams({ To: to, From: from_, Body: body }).toString(),
      },
    );
    const data = await res.json() as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: String(data.message ?? data.code ?? res.status) };
    return { ok: true, sid: data.sid as string };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ── Pre-built message composers ───────────────────────────────────────────────
//
// These functions compose domain-specific SMS bodies and call sendSms().
// Adding a new message type here keeps dispatch.ts / webhooks clean.

/**
 * Sends a lead-dispatch SMS to a business.
 *
 * @param to           Business E.164 phone.
 * @param businessName Business display name.
 * @param problem      Consumer's problem description.
 * @param location     Consumer's location text.
 * @param header       Optional urgency prefix (e.g. "🚨 EMERGENCY — ").
 */
export async function sendLeadSms(
  to: string,
  businessName: string,
  problem: string,
  location: string,
  header = '',
): Promise<boolean> {
  const lines = [
    `${header}ServiceSurfer: New lead for ${businessName}!`,
    problem  ? `Problem: ${problem}`   : null,
    location ? `Location: ${location}` : null,
    'Reply YES to accept or NO to pass.',
  ].filter(Boolean) as string[];

  const result = await sendSms(to, lines.join('\n'));
  return result.ok;
}

/**
 * Sends a verification OTP SMS to a business owner initiating a claim.
 *
 * @param to           Owner's E.164 phone.
 * @param businessName Name of the business being claimed.
 * @param code         6-digit verification code.
 */
export async function sendClaimVerificationSms(
  to: string,
  businessName: string,
  code: string,
): Promise<boolean> {
  const body = [
    `ServiceSurfer: ${code} is your verification code for claiming ${businessName}.`,
    'This code expires in 15 minutes. Do not share it.',
  ].join(' ');
  return (await sendSms(to, body)).ok;
}

/**
 * Notifies a consumer that a business accepted their lead.
 *
 * @param to           Consumer's E.164 phone.
 * @param businessName Accepting business name.
 * @param bridge       Bridge phone number (formatted for display).
 * @param pin          6-digit session PIN.
 * @param problem      Original problem description.
 */
export async function sendConsumerAcceptedSms(
  to: string,
  businessName: string,
  bridge: string,
  pin: string,
  problem: string,
): Promise<boolean> {
  const body = [
    `ServiceSurfer: ${businessName} is ready to help with: ${problem || 'your request'}!`,
    `Call ${bridge} and enter PIN: ${pin}`,
    '(PIN valid for 15 minutes)',
  ].join('\n');
  return (await sendSms(to, body)).ok;
}

/**
 * Notifies a consumer that all nearby pros are currently unavailable.
 *
 * @param to      Consumer's E.164 phone.
 * @param siteUrl Public site URL for the retry link.
 */
export async function sendConsumerSearchingSms(
  to: string,
  siteUrl: string,
): Promise<boolean> {
  const body = [
    'ServiceSurfer: All nearby pros are currently busy.',
    `Try again shortly or search for more options: ${siteUrl}`,
  ].join(' ');
  return (await sendSms(to, body)).ok;
}

/**
 * Sends a review-request SMS to a consumer 24 hours after dispatch.
 *
 * @param to           Consumer's E.164 phone.
 * @param businessName Business that accepted the lead.
 * @param reviewUrl    Full review submission URL.
 */
export async function sendReviewRequestSms(
  to: string,
  businessName: string,
  reviewUrl: string,
): Promise<boolean> {
  const body = [
    `ServiceSurfer: How was your experience with ${businessName}?`,
    `Leave a quick review and help others find great pros: ${reviewUrl}`,
  ].join('\n');
  return (await sendSms(to, body)).ok;
}
