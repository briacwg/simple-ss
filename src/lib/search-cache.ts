/**
 * Supabase-backed search result cache.
 *
 * Three-layer caching strategy for /api/match:
 *   L1 — Redis     (24 h, in-memory, ~1ms)
 *   L2 — Supabase  (30 d, stale-while-revalidate at 7 d, ~30ms)
 *   L3 — Google Places + Cerebras  (live, ~600ms)
 *
 * Stale-while-revalidate:
 *   If a Supabase row is older than REFRESH_AFTER_DAYS, we return it
 *   immediately AND fire a background request to the refresh endpoint
 *   so the next caller gets a fresh result.
 */

import { getSupabase } from './supabase';

// Freshness thresholds
export const REFRESH_AFTER_DAYS = 7;   // return stale + queue refresh
export const EXPIRES_AFTER_DAYS = 30;  // hard expiry — row is deleted on miss

export interface CachedSearchResult {
  businesses:  unknown[];
  label:       string | null;
  intentQuery: string | null;
  aiSummary?:  string | null;
  diagnosisHint?: unknown | null;
  urgencyTier?:   string | null;
  urgencyScore?:  number | null;
  [key: string]:  unknown;
}

export interface SearchCacheRow {
  cache_key:     string;
  query:         string;
  location_cell: string;
  lat:           number;
  lng:           number;
  result:        CachedSearchResult;
  hit_count:     number;
  last_hit_at:   string;
  refresh_after: string;
  expires_at:    string;
  created_at:    string;
}

// ── Read ──────────────────────────────────────────────────────────────────────

/**
 * Reads a cached search result from Supabase.
 * Returns null on miss, hard expiry, or DB unavailability.
 * Also returns whether the row is stale (caller should trigger a refresh).
 */
export async function readSearchCache(
  cacheKey: string,
): Promise<{ result: CachedSearchResult; stale: boolean; row: SearchCacheRow } | null> {
  const sb = getSupabase();
  if (!sb) return null;

  const { data, error } = await (sb as unknown as {
    from(t: string): {
      select(s: string): {
        eq(k: string, v: string): {
          single(): Promise<{ data: SearchCacheRow | null; error: unknown }>;
        };
      };
    };
  })
    .from('search_result_cache')
    .select('*')
    .eq('cache_key', cacheKey)
    .single();

  if (error || !data) return null;

  const now = Date.now();

  // Hard expiry — delete and treat as miss
  if (now > new Date(data.expires_at).getTime()) {
    deleteSearchCache(cacheKey).catch(() => null);
    return null;
  }

  const stale = now > new Date(data.refresh_after).getTime();

  // Bump hit count + last_hit_at (non-blocking, best-effort)
  bumpHitCount(sb, cacheKey).catch(() => null);

  return { result: data.result, stale, row: data };
}

// ── Write ─────────────────────────────────────────────────────────────────────

/**
 * Upserts a search result into the Supabase cache.
 * Non-fatal — failures are swallowed so the response is never blocked.
 */
export async function writeSearchCache(
  cacheKey: string,
  query: string,
  locationCell: string,
  lat: number,
  lng: number,
  result: CachedSearchResult,
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  const now           = new Date();
  const refreshAfter  = new Date(now.getTime() + REFRESH_AFTER_DAYS * 86_400_000);
  const expiresAt     = new Date(now.getTime() + EXPIRES_AFTER_DAYS * 86_400_000);

  await (sb as unknown as {
    from(t: string): {
      upsert(row: object, opts: object): Promise<{ error: unknown }>;
    };
  })
    .from('search_result_cache')
    .upsert(
      {
        cache_key:     cacheKey,
        query,
        location_cell: locationCell,
        lat,
        lng,
        result:        result as never,
        hit_count:     1,
        last_hit_at:   now.toISOString(),
        refresh_after: refreshAfter.toISOString(),
        expires_at:    expiresAt.toISOString(),
        created_at:    now.toISOString(),
      },
      { onConflict: 'cache_key' },
    )
    .then(() => null, () => null);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function bumpHitCount(sb: ReturnType<typeof getSupabase>, cacheKey: string): Promise<void> {
  if (!sb) return;
  // Use rpc or raw SQL isn't available in supabase-js easily; just do a select + update
  await (sb as unknown as {
    rpc(fn: string, args: Record<string, unknown>): Promise<{ error: unknown }>;
  })
    .rpc('increment_search_cache_hits', { p_key: cacheKey })
    .catch(() => null);
}

async function deleteSearchCache(cacheKey: string): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await (sb as unknown as {
    from(t: string): {
      delete(): { eq(k: string, v: string): Promise<unknown> };
    };
  })
    .from('search_result_cache')
    .delete()
    .eq('cache_key', cacheKey);
}

// ── Stale entry sweep ─────────────────────────────────────────────────────────

/**
 * Returns up to `limit` cache rows that are stale (past refresh_after) but
 * not yet hard-expired. Used by the background refresh job.
 */
export async function getStaleEntries(limit = 20): Promise<SearchCacheRow[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const now = new Date().toISOString();

  const { data } = await (sb as unknown as {
    from(t: string): {
      select(s: string): {
        lt(k: string, v: string): {
          gt(k: string, v: string): {
            order(k: string, opts: object): {
              limit(n: number): Promise<{ data: SearchCacheRow[] | null }>;
            };
          };
        };
      };
    };
  })
    .from('search_result_cache')
    .select('cache_key, query, location_cell, lat, lng, refresh_after, expires_at, hit_count, last_hit_at, result, created_at')
    .lt('refresh_after', now)
    .gt('expires_at', now)
    .order('hit_count', { ascending: false })   // refresh hottest entries first
    .limit(limit)
    .catch(() => ({ data: null }));

  return data ?? [];
}
