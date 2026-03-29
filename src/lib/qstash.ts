/**
 * QStash publishing and signature-verification utilities.
 *
 * Centralises all Upstash QStash I/O so that dispatch.ts, internal jobs, and
 * future callers never inline raw fetch calls or duplicate HMAC verification.
 *
 * Publishing model
 * ─────────────────
 * Every call to `publishJob()` POSTs to the QStash v2 publish endpoint.
 * The `delay` option uses the `Upstash-Delay` header (supports "30s", "5m", "24h" etc.).
 * The `deduplicationId` option prevents double-scheduling on retries.
 *
 * Verification model
 * ──────────────────
 * QStash signs every delivery with HMAC-SHA256 over the raw request body, using
 * the current signing key.  When signing keys are rotated, QStash continues
 * delivering with the old key until the new one takes over.  `verifySignature()`
 * accepts both QSTASH_CURRENT_SIGNING_KEY and QSTASH_NEXT_SIGNING_KEY so key
 * rotation is transparent.
 *
 * Local dev
 * ─────────
 * When neither signing key is set (local dev / test), `verifySignature()` returns
 * `true` unconditionally so the webhook can be exercised without a live QStash account.
 */

export interface PublishOptions {
  /** Destination URL (absolute). */
  url: string;
  /** JSON-serialisable payload. */
  body: unknown;
  /** QStash delay string: "30s", "5m", "24h", etc. Omit for immediate delivery. */
  delay?: string;
  /** Extra headers forwarded to the destination by QStash. */
  forwardHeaders?: Record<string, string>;
  /**
   * Deduplication ID — QStash silently drops a second publish with the same ID
   * within the dedup window (~5 minutes).  Use to prevent double-scheduling on
   * handler retries.
   */
  deduplicationId?: string;
}

export interface PublishResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Publishes a job to QStash.
 *
 * Returns `{ ok: false }` (never throws) when QStash credentials are absent or
 * the publish call fails — callers treat async jobs as best-effort.
 */
export async function publishJob(opts: PublishOptions): Promise<PublishResult> {
  const token   = import.meta.env.QSTASH_TOKEN;
  if (!token) return { ok: false, error: 'QSTASH_TOKEN not configured' };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization:  `Bearer ${token}`,
  };

  if (opts.delay)           headers['Upstash-Delay']            = opts.delay;
  if (opts.deduplicationId) headers['Upstash-Deduplication-Id'] = opts.deduplicationId;

  for (const [k, v] of Object.entries(opts.forwardHeaders ?? {})) {
    // QStash forwards headers prefixed with "Upstash-Forward-"
    headers[`Upstash-Forward-${k}`] = v;
  }

  try {
    const res = await fetch(
      `https://qstash.upstash.io/v2/publish/${encodeURIComponent(opts.url)}`,
      { method: 'POST', headers, body: JSON.stringify(opts.body) },
    );
    const data = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) return { ok: false, error: String(data.error ?? res.status) };
    return { ok: true, messageId: data.messageId as string | undefined };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

/**
 * Schedules a dispatch-timeout job via QStash.
 *
 * @param dispatchId   The dispatch record ID.
 * @param businessPhone  E.164 business phone to check on timeout.
 * @param windowSeconds  Window duration; job fires after this many seconds.
 * @param siteUrl        Canonical site URL (e.g. "https://simple.servicesurfer.app").
 * @param authSecret     Bearer token forwarded to /api/internal/dispatch-timeout.
 */
export async function scheduleDispatchTimeout(
  dispatchId: string,
  businessPhone: string,
  windowSeconds: number,
  siteUrl: string,
  authSecret: string,
): Promise<PublishResult> {
  return publishJob({
    url:               `${siteUrl}/api/internal/dispatch-timeout`,
    body:              { dispatchId, businessPhone },
    delay:             `${windowSeconds}s`,
    deduplicationId:   `timeout:${dispatchId}:${businessPhone}`,
    forwardHeaders:    { Authorization: `Bearer ${authSecret}` },
  });
}

/**
 * Schedules the 24-hour review follow-up SMS job via QStash.
 *
 * @param dispatchId  The dispatch record ID.
 * @param siteUrl     Canonical site URL.
 */
export async function scheduleReviewFollowup(
  dispatchId: string,
  siteUrl: string,
): Promise<PublishResult> {
  return publishJob({
    url:             `${siteUrl}/api/jobs/review-followup`,
    body:            { dispatchId },
    delay:           '24h',
    deduplicationId: `review:${dispatchId}`,
  });
}

/**
 * Verifies an inbound QStash webhook signature.
 *
 * QStash signs using HMAC-SHA256 over the raw request body.  The signature is
 * sent in the `Upstash-Signature` header as a base64url-encoded string.
 *
 * Returns `true` unconditionally when no signing keys are configured (local dev).
 */
export async function verifyQStashSignature(request: Request): Promise<boolean> {
  const currentKey = import.meta.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextKey    = import.meta.env.QSTASH_NEXT_SIGNING_KEY;

  // Local dev: no keys configured → trust all (never in production)
  if (!currentKey && !nextKey) return true;

  const signature = request.headers.get('Upstash-Signature');
  if (!signature) return false;

  const body = await request.text();
  for (const key of ([currentKey, nextKey] as (string | undefined)[]).filter(Boolean) as string[]) {
    if (await _hmacMatches(key, body, signature)) return true;
  }
  return false;
}

async function _hmacMatches(secret: string, body: string, sig: string): Promise<boolean> {
  try {
    const key      = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
    const b64      = btoa(String.fromCharCode(...new Uint8Array(expected)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return b64 === sig;
  } catch {
    return false;
  }
}
