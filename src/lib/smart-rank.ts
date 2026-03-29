/**
 * Training-data-driven business ranking.
 *
 * Closes the full AI feedback loop: every dispatch outcome AND every consumer
 * review is fed back here to improve the queue ordering for future similar leads.
 *
 * Ranking algorithm
 * ─────────────────
 * Three signals are blended for each candidate:
 *
 * 1. Acceptance-rate multiplier  [0.6 → 1.4]
 *    Two acceptance-rate signals — one specific (same service + location cell) and
 *    one general (any lead for this business) — are precision-weighted:
 *
 *      specificRate  = accepted / total  for phone + service_label + location_cell
 *      generalRate   = accepted / total  for phone (all labels / locations)
 *      blendedRate   = (specificRate × specificWeight + generalRate × generalWeight)
 *                       / (specificWeight + generalWeight)
 *
 *      specificWeight = min(specificTotal, 20)   — up to 20× for local signal
 *      generalWeight  = min(generalTotal,  10)   — capped to avoid over-fitting
 *
 *      acceptMultiplier = 0.6 + blendedRate × 0.8   (neutral at 0.5 rate → 1.0)
 *
 * 2. Consumer review quality multiplier  [0.85 → 1.15]
 *    Average star rating from `lead_events` (event_type = 'review_received').
 *    Only applied when the business has ≥ 3 reviews; neutral (1.0) otherwise.
 *
 *      reviewNorm       = (avgRating − 1) / 4     (0.0 for 1★, 1.0 for 5★)
 *      reviewMultiplier = 0.85 + reviewNorm × 0.30
 *
 * 3. Google Places rank signal  [0.0 → 0.3 contribution]
 *    Preserves the Places ranking as a tie-breaker when training data is sparse.
 *
 *      final = acceptMultiplier × reviewMultiplier × (0.7 + 0.3 / (googleRank + 1))
 *
 * Performance
 * ───────────
 * Training and review queries are issued in parallel (Promise.all); the combined
 * result is cached in Redis for 10 minutes per (service_label, location_cell) pair.
 *
 * Fallback
 * ────────
 * If Supabase is unavailable or either query times out, the original Google Places
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

interface ReviewStats {
  total:     number;
  ratingSum: number;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const CACHE_TTL = 60 * 10; // 10 minutes
// v2: cache key bumped when review-score signal was added to the ranking formula
const cacheKey = (phones: string[], label: string | null, cell: string | null) =>
  `ss:smart-rank:v2:${label ?? '_'}:${cell ?? '_'}:${phones.slice().sort().join(',')}`;

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

  // Fetch training events and review scores in parallel — both use the same
  // candidate phone set; a shared 1.5 s deadline prevents dispatch from stalling.
  const deadline = <T>(p: Promise<T>) =>
    Promise.race([p, new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 1500))]);

  const [trainingResult, reviewResult] = await Promise.all([
    deadline(
      sb
        .from('dispatch_training_events')
        .select('business_phone, outcome, service_label, location_cell')
        .in('business_phone', phones)
        .limit(500),
    ).catch(() => ({ data: null, error: new Error('timeout') as Error })),
    deadline(
      sb
        .from('lead_events')
        .select('business_phone, meta')
        .in('business_phone', phones)
        .eq('event_type', 'review_received')
        .limit(200),
    ).catch(() => ({ data: null, error: null })),
  ]);

  if (trainingResult.error || !trainingResult.data) return candidates;
  const data = trainingResult.data;

  // Aggregate specific (label+cell) and general acceptance stats per phone
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

  // Aggregate consumer review scores per phone (from lead_events review_received events)
  const reviewStats = new Map<string, ReviewStats>();
  for (const row of reviewResult.data ?? []) {
    const rating = (row.meta as { rating?: number } | null)?.rating;
    if (typeof rating === 'number' && rating >= 1 && rating <= 5) {
      const prev = reviewStats.get(row.business_phone) ?? { total: 0, ratingSum: 0 };
      reviewStats.set(row.business_phone, {
        total:     prev.total + 1,
        ratingSum: prev.ratingSum + rating,
      });
    }
  }

  // Compute composite score for each candidate
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

    // Acceptance multiplier ∈ [0.6, 1.4]; neutral at blendedRate = 0.5 → 1.0
    const acceptMultiplier = 0.6 + blendedRate * 0.8;

    // Review quality multiplier ∈ [0.85, 1.15].
    // Requires ≥ 3 reviews before applying non-neutral weight so that a single
    // outlier review cannot dominate the ranking.
    const reviews = reviewStats.get(b.phone);
    const reviewMultiplier = reviews && reviews.total >= 3
      ? 0.85 + ((reviews.ratingSum / reviews.total - 1) / 4) * 0.30
      : 1.0;

    // Google Places rank contributes 30% so high-rated Places businesses retain
    // an advantage when training data is sparse.
    const placesSignal = 1 / (googleRank + 1);
    const score        = acceptMultiplier * reviewMultiplier * (0.7 + 0.3 * placesSignal);

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
