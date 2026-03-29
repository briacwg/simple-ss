/**
 * Shared API helpers — used by every API handler.
 *
 * Eliminates per-file boilerplate across all route modules:
 *   - JSON / error response factories
 *   - Client IP extraction from forwarded headers
 *   - Fetch with automatic abort on timeout
 *   - Redis sliding-window rate limiting
 */

import { redis } from '../lib';

/** Serialize `data` as a JSON `Response` with optional `status` (default 200). */
export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** `{ error: message }` JSON response with the given HTTP status code. */
export const err = (message: string, status: number): Response =>
  json({ error: message }, status);

/**
 * Extracts the real client IP from standard forwarded headers.
 * Falls back to `'unknown'` when no header is present.
 */
export const getClientIp = (request: Request): string =>
  request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  ?? request.headers.get('x-real-ip')
  ?? 'unknown';

/**
 * Fetches a URL and aborts after `ms` milliseconds (default 1200).
 * Clears the timer on resolve so it doesn't leak.
 */
export const fetchWithTimeout = (url: string, ms = 1200, init?: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
};

/**
 * Redis sliding-window rate limiter.
 *
 * @param key       Redis key that isolates this limiter (e.g. `ss:rl:dispatch:${ip}`).
 * @param limit     Maximum number of requests allowed in the window.
 * @param windowSec Window duration in seconds.
 * @returns `true` when the request is within quota, `false` when the limit is exceeded.
 *          Returns `true` (allow) when Redis is unavailable so the app stays functional.
 */
export async function checkRateLimit(key: string, limit: number, windowSec: number): Promise<boolean> {
  const r = redis();
  if (!r) return true;

  const now  = Date.now();
  const pipe = r.pipeline();
  pipe.zremrangebyscore(key, 0, now - windowSec * 1000);
  pipe.zcard(key);
  pipe.zadd(key, { score: now, member: String(now) });
  pipe.expire(key, windowSec);
  const results = await pipe.exec<[number, number, number, number]>().catch(() => null);
  if (!results) return true;
  return (results[1] as number) < limit;
}
