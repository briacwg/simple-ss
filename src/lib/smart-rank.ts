/**
 * Training-data-driven business ranking.
 *
 * Closes the AI feedback loop: every dispatch outcome (accepted / declined /
 * timeout) written to `dispatch_training_events` is fed back here to improve
 * the queue ordering for future similar leads.
 *
 * Ranking algorithm
 * ─────────────────
 * Each candidate business starts with a base score of 1.0.  Two acceptance-rate
 * signals are combined — one specific (same service + location) and one general
 * (any lead for this business) — and blended with a precision-weighted mix:
 *
 *   specificRate  = accepted / total  for this phone + service_label + location_cell
 *   generalRate   = accepted / total  for this phone (all labels / locations)
 *   blendedRate   = (specificRate * specificWeight + generalRate * generalWeight)
 *                    / (specificWeight + generalWeight)
 *
 * specificWeight = min(specificTotal, 20)   — up to 20x weight for local signal
 * generalWeight  = min(generalTotal, 10)    — capped at 10x to avoid over-fitting
 *
 * scoreMultiplier = 0.6 + blendedRate * 0.8   (range 0.6 → 1.4)
 *
 * A business with no historical data keeps a neutral multiplier of 1.0 so that
 * new businesses aren't penalised.  A business with a 75% acceptance rate for
 * the same service in the same cell gets ~1.2× boost; one with 20% gets ~0.76×.
 *
 * Businesses are sorted by (scoreMultiplier × 1 / (googleRank + 1)) descending,
 * so the Google Places ranking is used as a tie-breaker and initial signal.
 *
 * Performance
 * ───────────
 * A single Supabase query with an IN filter fetches all relevant training rows
 * for the candidate set.  Results are cached in Redis for 10 minutes per
 * (service_label, location_cell) pair to avoid repeated DB hits on high-traffic
 * search queries.
 *
 * Fallback
 * ────────
 * If Supabase is unavailable or the query times out, the original Google Places
 * order is returned unchanged so dispatch is never blocked.
 */

import { redis } from '../lib';
import { getSupabase } from './supabase';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RankablesBusiness {
  phone: string;
  name:  string;
}

interface AcceptanceStats {
  total:    number;
  accepted: number;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL = 60 * 10; // 10 minutes
const cacheKey = (phones: string[], label: string | null, cell: string | null) =>
  `ss:smart-rank:v1:${label ?? '_'}:${cell ?? '_'}:${phones.slice().sort().join(',')}`;

// ── Core ranking ──────────────────────────────────────────────────────────────

/**
 * Returns the candidate list re-ordered by historical acceptance rate for
 * this (service_label, location_cell) combination.
 *
 * Falls back to the original order on any error.
 *
 * @param candidates  Ordered list of businesses (Google Places rank, best-first).
 * @param serviceLabel  Service category label from the smart-match result.
 * @param locationCell  0.1° grid cell string, e.g. "418:-876".
 * @returns Re-ordered candidate list with best-predicted acceptors first.
 */
export async function reRankByAcceptance(
  candidates:    RankablesBusiness[],
  serviceLabel:  string | null,
  locationCell:  string | null,
): Promise<RankablesBusiness[]> {
  if (candidates.length <= 1) return candidates;

  const phones = candidates.map(b => b.phone);

  // Check Redis cache first
  const r   = redis();
  const key = cacheKey(phones, serviceLabel, locationCell);
  if (r) {
    const cached = await r.get<string>(key).catch(() => null);
    if (cached) {
      try {
        const order: string[] = JSON.parse(cached);
        const phoneMap = new Map(candidates.map(b => [b.phone, b]));
        const ranked   = order.map(p => phoneMap.get(p)).filter((b): b is RankablesBusiness => !!b);
        // Include any candidates not in the cached order (e.g. newly added phones)
        const missing  = candidates.filter(b => !order.includes(b.phone));
        return [...ranked, ...missing];
      } catch { /* ignore malformed cache */ }
    }
  }

  const sb = getSupabase();
  if (!sb) return candidates;

  // Fetch training data for all candidate phones in a single query
  const { data, error } = await Promise.race([
    sb
      .from('dispatch_training_events')
      .select('business_phone, outcome, service_label, location_cell')
      .in('business_phone', phones)
      .limit(500),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
  ]).catch(() => ({ data: null, error: new Error('timeout') }));

  if (error || !data) return candidates;

  // Aggregate specific (label+cell) and general stats per phone
  const specificStats = new Map<string, AcceptanceStats>();
  const generalStats  = new Map<string, AcceptanceStats>();

  const incr = (map: Map<string, AcceptanceStats>, phone: string, isAccepted: boolean) => {
    const prev = map.get(phone) ?? { total: 0, accepted: 0 };
    map.set(phone, {
      total:    prev.total + 1,
      accepted: prev.accepted + (isAccepted ? 1 : 0),
    });
  };

  for (const row of data) {
    const isAccepted = row.outcome === 'accepted';
    incr(generalStats, row.business_phone, isAccepted);
    if (row.service_label === serviceLabel && row.location_cell === locationCell) {
      incr(specificStats, row.business_phone, isAccepted);
    }
  }

  // Compute score multiplier for each candidate
  const scored = candidates.map((b, googleRank) => {
    const specific = specificStats.get(b.phone);
    const general  = generalStats.get(b.phone);

    let blendedRate: number;

    if (!specific && !general) {
      // No history → neutral score (don't penalise new businesses)
      blendedRate = 0.5;
    } else {
      const specificRate   = specific ? specific.accepted / specific.total : 0.5;
      const specificWeight = specific ? Math.min(specific.total, 20) : 0;
      const generalRate    = general  ? general.accepted  / general.total  : 0.5;
      const generalWeight  = general  ? Math.min(general.total,  10) : 0;
      const totalWeight    = specificWeight + generalWeight;

      blendedRate = totalWeight > 0
        ? (specificRate * specificWeight + generalRate * generalWeight) / totalWeight
        : 0.5;
    }

    // multiplier ∈ [0.6, 1.4]; neutral (0.5 rate) → 1.0
    const multiplier = 0.6 + blendedRate * 0.8;

    // Combine with inverse Google rank so high-rated Places businesses retain
    // an advantage when training data is sparse.
    const placesSignal = 1 / (googleRank + 1);
    const score        = multiplier * (0.7 + 0.3 * placesSignal); // 70% acceptance, 30% Places

    return { business: b, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.map(s => s.business);

  // Cache the phone order for 10 minutes
  if (r) {
    await r.set(key, JSON.stringify(ranked.map(b => b.phone)), { ex: CACHE_TTL }).catch(() => null);
  }

  return ranked;
}
