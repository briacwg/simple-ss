/**
 * Business session token utilities.
 *
 * Verifies the HMAC-SHA256 signed tokens minted by
 * /api/business/passkeys/authenticate/finish after a successful passkey assertion.
 *
 * Token wire format (all components URL-safe base64, no padding):
 *   base64url(userId "." unixExpSeconds) "." base64url(HMAC-SHA256 signature)
 *
 * The payload being signed is the UTF-8 string `userId + "." + exp`.
 * This is identical to the minting logic in authenticate/finish.ts so that
 * both sides derive the same byte sequence before signing / verifying.
 *
 * Signing key priority: BUSINESS_JWT_SECRET → DISPATCH_JOB_SECRET → "dev-secret"
 *
 * Usage pattern in an API route:
 *   const session = await getBusinessSession(request);
 *   if (!session) return new Response('Unauthorized', { status: 401 });
 *   // session.userId is now trustworthy
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/** Decoded, verified business session — available after successful token verification. */
export interface BusinessSession {
  /** Supabase user UUID of the authenticated business owner. */
  userId: string;
  /** Token expiry as a Unix timestamp (seconds). Always in the future when returned. */
  exp: number;
}

// ── Core verification ─────────────────────────────────────────────────────────

/**
 * Verifies a business session token and returns the decoded session, or null
 * if the token is malformed, has an invalid signature, or has expired.
 *
 * Runs entirely in the Web Crypto API — no Node.js or external dependencies.
 */
export async function verifyBusinessSession(token: string): Promise<BusinessSession | null> {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payloadB64, sigB64] = parts as [string, string];

  // Decode the payload segment
  let payload: string;
  try {
    payload = atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/'));
  } catch {
    return null; // malformed base64
  }

  // Verify HMAC-SHA256 signature
  const secret = import.meta.env.BUSINESS_JWT_SECRET
    || import.meta.env.DISPATCH_JOB_SECRET
    || 'dev-secret';

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  ).catch(() => null);
  if (!key) return null;

  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(
      atob(sigB64.replace(/-/g, '+').replace(/_/g, '/')),
      c => c.charCodeAt(0),
    );
  } catch {
    return null;
  }

  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    sigBytes,
    new TextEncoder().encode(payload),
  ).catch(() => false);

  if (!valid) return null;

  // Parse userId.exp  — the userId itself may contain dots (e.g. email addresses),
  // so we split on the *last* dot to extract the numeric exp suffix.
  const lastDot = payload.lastIndexOf('.');
  if (lastDot === -1) return null;

  const userId = payload.slice(0, lastDot);
  const exp    = parseInt(payload.slice(lastDot + 1), 10);
  if (!userId || isNaN(exp)) return null;

  // Reject expired tokens
  if (Math.floor(Date.now() / 1000) > exp) return null;

  return { userId, exp };
}

/**
 * Extracts the bearer token from an Authorization header and verifies it.
 *
 * Returns the decoded BusinessSession on success, or null if:
 *   - The Authorization header is absent or not a Bearer token
 *   - The token signature is invalid
 *   - The token has expired
 */
export async function getBusinessSession(request: Request): Promise<BusinessSession | null> {
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return null;
  return verifyBusinessSession(auth.slice(7).trim());
}

/**
 * Generates a signed 24-hour session token for the given userId.
 * Mirrors the minting logic in authenticate/finish.ts.
 *
 * Exported here so it can be used in tests or refresh flows without
 * importing from the API route module.
 */
export async function mintSessionToken(userId: string): Promise<string> {
  const secret = import.meta.env.BUSINESS_JWT_SECRET
    || import.meta.env.DISPATCH_JOB_SECRET
    || 'dev-secret';
  const exp     = Math.floor(Date.now() / 1000) + 86_400; // 24h
  const payload = `${userId}.${exp}`;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig    = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payB64 = btoa(payload)
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  return `${payB64}.${sigB64}`;
}
