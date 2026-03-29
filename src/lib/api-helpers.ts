/**
 * Shared JSON response helpers — used by every API handler.
 *
 * Eliminates the per-file boilerplate that previously duplicated identical
 * `json` / `err` factory functions across all 23 route modules.
 */

/** Serialize `data` as a JSON `Response` with optional `status` (default 200). */
export const json = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/** `{ error: message }` JSON response with the given HTTP status code. */
export const err = (message: string, status: number): Response =>
  json({ error: message }, status);
