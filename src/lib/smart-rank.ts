/**
 * Training-data-driven business ranking.
 *
 * Closes the full AI feedback loop: every dispatch outcome, consumer review,
 * and response-time measurement is fed back here to improve queue ordering
 * for future similar leads.
 *
 * Ranking algorithm (v3)
 * ──────────────────────
 * Five signals are blended for each candidate:
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
 * 3. Temporal (hour-of-day) multiplier  [0.90 → 1.10]
 *    Compares a business's acceptance rate in the current 3-hour window vs its
 *    overall rate.  A business that historically ignores leads at 2 AM but
 *    reliably accepts them at 9 AM gets a temporal boost during business hours.
 *    Requires ≥ 3 events in the current bucket before applying; neutral otherwise.
 *
 *      bucketRate       = accepted / total  for UTC hour bucket ⌊h/3⌋
 *      temporalAdj      = (bucketRate − 0.5) × 0.20   ∈ [−0.10, +0.10]
 *      temporalMultiplier = 1.0 + temporalAdj
 *
 * 4. Response-time multiplier  [0.95 → 1.05]
 *    Businesses that historically reply quickly get a mild boost — they're more
 *    likely to respond before the 5-minute dispatch window expires.
 *    Normalised to a 60-second scale; faster → closer to 1.05.
 *
 *      speedNorm        = 1 − clamp(avgResponseMs / 60000, 0, 1)
 *      responseMultiplier = 0.95 + speedNorm × 0.10
 *
 * 5. Google Places rank signal  [0.0 → 0.3 contribution]
 *    Preserves the Places ranking as a tie-breaker when training data is sparse.
 *
 *      final = acceptMultiplier × reviewMultiplier
 *              × temporalMultiplier × responseMultiplier
 *              × (0.7 + 0.3 / (googleRank + 1))
 *
 * Performance
 * ───────────
 * Training and review queries are issued in parallel (Promise.all); the combined
 * result is cached in Redis for 10 minutes per (service_label, location_cell) pair
 * BUT only 3 minutes for the temporal signal (bucket resets every 3 hours).
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

interface ResponseStats {
  totalMs: number;
  count:   number;
}

// Row shapes for untyped Supabase tables
interface TrainingRow {
  business_phone: string;
  outcome:        string;
  service_label:  string | null;
  location_cell:  string | null;
  response_ms:    number | null;
  created_at:     string;
}
interface ReviewRow {
  business_phone: string;
  meta:           { rating?: number } | null;
}

// ── Temporal helpers ──────────────────────────────────────────────────────────

/** Returns the 3-hour bucket index (0–7) for a given UTC date. */
function hourBucket(date: Date): number {
  return Math.floor(date.getUTCHours() / 3);
}

/** Cache key includes the current 3-hour window so stale temporal data expires. */
const cacheKey = (phones: string[], label: string | null, cell: string | null) => {
  const bucket = hourBucket(new Date());
  return `ss:smart-rank:v3:b${bucket}:${label ?? '_'}:${cell ?? '_'}:${phones.slice().sort().join(',')}`;
};

// ── Cache TTL — 3 min so temporal signal stays fresh within the hour bucket ──
const CACHE_TTL = 60 * 3;

// ── Core ranking ──────────────────────────────────────────────────────────────

/**
 * Returns the candidate list re-ordered by the composite score:
 * acceptance rate × review quality × temporal fit × response speed × places rank.
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
        const missing  = candidates.filter(b => !order.includes(b.phone));
        return [...ranked, ...missing];
      } catch { /* ignore malformed cache */ }
    }
  }

  const sb = getSupabase();
  if (!sb) return candidates;

  // Fetch training events and review scores in parallel with a 1.5 s deadline each.
  const trainingPromise = Promise.race([
    Promise.resolve(
      sb
        .from('dispatch_training_events')
        .select('business_phone, outcome, service_label, location_cell, response_ms, created_at')
        .in('business_phone', phones)
        .limit(500),
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
  ]).catch(() => ({ data: null as null, error: new Error('timeout') }));

  const reviewPromise = Promise.race([
    Promise.resolve(
      sb
        .from('lead_events')
        .select('business_phone, meta')
        .in('business_phone', phones)
        .eq('event_type', 'review_received')
        .limit(200),
    ),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
  ]).catch(() => ({ data: null as null, error: null }));

  const [trainingResult, reviewResult] = await Promise.all([trainingPromise, reviewPromise]);

  if (trainingResult.error || !trainingResult.data) return candidates;
  const data       = trainingResult.data as unknown as TrainingRow[];
  const reviewData = (reviewResult.data ?? []) as unknown as ReviewRow[];

  // ── Aggregate stats ─────────────────────────────────────────────────────────

  const specificStats  = new Map<string, AcceptanceStats>();
  const generalStats   = new Map<string, AcceptanceStats>();
  const temporalStats  = new Map<string, AcceptanceStats>(); // key: `phone:bucket`
  const responseStats  = new Map<string, ResponseStats>();

  const incr = (map: Map<string, AcceptanceStats>, key: string, isAccepted: boolean) => {
    const prev = map.get(key) ?? { total: 0, accepted: 0 };
    map.set(key, { total: prev.total + 1, accepted: prev.accepted + (isAccepted ? 1 : 0) });
  };

  const currentBucket = hourBucket(new Date());

  for (const row of data) {
    const isAccepted = row.outcome === 'accepted';

    // 1 + 2: specific / general acceptance
    incr(generalStats, row.business_phone, isAccepted);
    if (row.service_label === serviceLabel && row.location_cell === locationCell) {
      incr(specificStats, row.business_phone, isAccepted);
    }

    // 3: temporal bucket — track this phone's acceptance in the matching hour window
    if (row.created_at) {
      const eventBucket = hourBucket(new Date(row.created_at));
      if (eventBucket === currentBucket) {
        incr(temporalStats, row.business_phone, isAccepted);
      }
    }

    // 4: response-time stats (accepted only — declined/timeout have skewed times)
    if (isAccepted && typeof row.response_ms === 'number' && row.response_ms > 0) {
      const prev = responseStats.get(row.business_phone) ?? { totalMs: 0, count: 0 };
      responseStats.set(row.business_phone, {
        totalMs: prev.totalMs + row.response_ms,
        count:   prev.count + 1,
      });
    }
  }

  // Aggregate consumer review scores
  const reviewStats = new Map<string, ReviewStats>();
  for (const row of reviewData) {
    const rating = row.meta?.rating;
    if (typeof rating === 'number' && rating >= 1 && rating <= 5) {
      const prev = reviewStats.get(row.business_phone) ?? { total: 0, ratingSum: 0 };
      reviewStats.set(row.business_phone, {
        total:     prev.total + 1,
        ratingSum: prev.ratingSum + rating,
      });
    }
  }

  // ── Compute composite score ─────────────────────────────────────────────────

  const scored = candidates.map((b, googleRank) => {
    const specific = specificStats.get(b.phone);
    const general  = generalStats.get(b.phone);

    // 1. Acceptance-rate multiplier [0.6, 1.4]
    let blendedRate: number;
    if (!specific && !general) {
      blendedRate = 0.5; // neutral for new businesses
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
    const acceptMultiplier = 0.6 + blendedRate * 0.8;

    // 2. Review quality multiplier [0.85, 1.15] — requires ≥ 3 reviews
    const reviews = reviewStats.get(b.phone);
    const reviewMultiplier = reviews && reviews.total >= 3
      ? 0.85 + ((reviews.ratingSum / reviews.total - 1) / 4) * 0.30
      : 1.0;

    // 3. Temporal (hour-of-day) multiplier [0.90, 1.10] — requires ≥ 3 events in bucket
    const temporal = temporalStats.get(b.phone);
    const temporalMultiplier = temporal && temporal.total >= 3
      ? 1.0 + (temporal.accepted / temporal.total - 0.5) * 0.20
      : 1.0;

    // 4. Response-time multiplier [0.95, 1.05] — faster responders get mild boost
    const resp    = responseStats.get(b.phone);
    const avgMs   = resp && resp.count > 0 ? resp.totalMs / resp.count : null;
    const speedNorm = avgMs !== null ? Math.max(0, 1 - avgMs / 60_000) : 0.5;
    const responseMultiplier = 0.95 + speedNorm * 0.10;

    // 5. Google Places rank signal — tie-breaker when training data is sparse
    const placesSignal = 1 / (googleRank + 1);

    const score = acceptMultiplier
      * reviewMultiplier
      * temporalMultiplier
      * responseMultiplier
      * (0.7 + 0.3 * placesSignal);

    return { business: b, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const ranked = scored.map(s => s.business);

  // Cache the ranked phone order (short TTL because temporal bucket changes every 3 h)
  if (r) {
    await r.set(key, JSON.stringify(ranked.map(b => b.phone)), { ex: CACHE_TTL }).catch(() => null);
  }

  return ranked;
}
