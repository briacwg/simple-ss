/**
 * Training-data-driven business ranking.
 *
 * Closes the full AI feedback loop: every dispatch outcome, consumer review,
 * and response-time measurement is fed back here to improve queue ordering
 * for future similar leads.
 *
 * Ranking algorithm (v5)
 * ──────────────────────
 * Five signals are blended for each candidate:
 *
 * 1. Acceptance-rate multiplier  [0.6 → 1.4]
 *    Two acceptance-rate signals — one specific (same service + location cell) and
 *    one general (any lead for this business) — are precision-weighted using the
 *    Wilson score lower confidence bound (z = 1.96, 95% CI).  The Wilson bound
 *    is conservative for small sample sizes (e.g. 1/1 → ~0.21, not 1.0) and
 *    converges to the observed rate as n grows, preventing overconfidence on sparse data.
 *
 *      specificRate  = wilsonLower(accepted, total)  for phone + service_label + location_cell
 *      generalRate   = wilsonLower(accepted, total)  for phone (all labels / locations)
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
 *    Compares a business's Wilson-score acceptance rate in the current 3-hour
 *    window.  A business that historically ignores leads at 2 AM but reliably
 *    accepts them at 9 AM gets a temporal boost during business hours.
 *    Requires ≥ 3 events in the current bucket before applying; neutral otherwise.
 *
 *      bucketRate       = wilsonLower(accepted, total)  for UTC hour bucket ⌊h/3⌋
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
 * 6. Urgency-tier acceptance multiplier  [0.90 → 1.10]
 *    When the current lead has a known urgency tier (critical/high/medium/low),
 *    computes this business's Wilson-score acceptance rate restricted to leads
 *    of the same urgency tier.  Businesses that historically respond well to
 *    URGENT or EMERGENCY leads are boosted when today's lead is urgent; those
 *    that only accept low-urgency leads are modestly penalised.
 *    Requires ≥ 3 same-urgency events; neutral (1.0) otherwise.
 *
 *      urgencyRate      = wilsonLower(accepted, total)  for this urgency tier
 *      urgencyAdj       = (urgencyRate − 0.5) × 0.20   ∈ [−0.10, +0.10]
 *      urgencyMultiplier = 1.0 + urgencyAdj
 *
 *      final = acceptMultiplier × reviewMultiplier
 *              × temporalMultiplier × responseMultiplier
 *              × urgencyMultiplier
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
  dispatch_id:   string;
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
interface UrgencyEventRow {
  dispatch_id: string;
  meta:        { urgencyTier?: string } | null;
}

// ── Wilson score lower confidence bound ──────────────────────────────────────

/**
 * Wilson score lower confidence bound for a proportion.
 *
 * Returns a conservative estimate of the true acceptance rate that accounts for
 * sample size.  Preferable to a simple ratio because:
 *   - 1/1   → ~0.21 (not 1.0 — one data point shouldn't dominate)
 *   - 10/10 → ~0.72 (still conservative with small-but-clean data)
 *   - 80/100 → ~0.71 (converges toward the observed rate as n grows)
 *   - 0/10  → ~0.00 (rightly pessimistic about consistent non-responders)
 *
 * @param successes  Number of accepted outcomes.
 * @param total      Total dispatches observed.
 * @param z          z-score for the desired confidence level (1.96 = 95% CI).
 */
function wilsonLower(successes: number, total: number, z = 1.96): number {
  if (total === 0) return 0.5; // neutral — no data
  const p  = successes / total;
  const z2 = z * z;
  const n  = total;
  return (
    (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) /
    (1 + z2 / n)
  );
}

// ── Temporal helpers ──────────────────────────────────────────────────────────

/** Returns the 3-hour bucket index (0–7) for a given UTC date. */
function hourBucket(date: Date): number {
  return Math.floor(date.getUTCHours() / 3);
}

/** Cache key includes the current 3-hour window so stale temporal data expires. */
const cacheKey = (phones: string[], label: string | null, cell: string | null, urgency: string | null) => {
  const bucket = hourBucket(new Date());
  return `ss:smart-rank:v5:b${bucket}:${urgency ?? '_'}:${label ?? '_'}:${cell ?? '_'}:${phones.slice().sort().join(',')}`;
};

// ── Cache TTL — 3 min so temporal signal stays fresh within the hour bucket ──
const CACHE_TTL = 60 * 3;

// ── Core ranking ──────────────────────────────────────────────────────────────

/**
 * Returns the candidate list re-ordered by the composite score:
 * acceptance rate × review quality × temporal fit × response speed ×
 * urgency-tier fit × places rank.
 *
 * Falls back to the original order on any error.
 *
 * @param candidates    Ordered list of businesses (Google Places rank, best-first).
 * @param serviceLabel  Service category label from the smart-match result.
 * @param locationCell  0.1° grid cell string, e.g. "418:-876".
 * @param urgencyTier   Current lead's urgency tier: 'critical'|'high'|'medium'|'low'|null.
 *                      When provided, adds a 6th signal based on per-tier acceptance history.
 * @returns Re-ordered candidate list with best-predicted acceptors first.
 */
export async function reRankByAcceptance(
  candidates:    RankablesBusiness[],
  serviceLabel:  string | null,
  locationCell:  string | null,
  urgencyTier:   string | null = null,
): Promise<RankablesBusiness[]> {
  if (candidates.length <= 1) return candidates;

  const phones = candidates.map(b => b.phone);

  // Check Redis cache first
  const r   = redis();
  const key = cacheKey(phones, serviceLabel, locationCell, urgencyTier);
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

  // Fetch training events, review scores, and urgency events in parallel.
  // Each query has a 1.5 s deadline; the whole Promise.all resolves in max ~1.5 s.
  const trainingPromise = Promise.race([
    Promise.resolve(
      sb
        .from('dispatch_training_events')
        .select('dispatch_id, business_phone, outcome, service_label, location_cell, response_ms, created_at')
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

  // 3rd parallel query: urgency-tier acceptance data.
  // Fetches dispatch_sent lead events for these business phones to map
  // dispatch_id → urgency tier.  Only fired when urgencyTier is non-null so
  // the extra round-trip is skipped for callers that don't supply urgency context.
  const urgencyPromise: Promise<{ data: UrgencyEventRow[] | null }> = urgencyTier
    ? Promise.race([
        Promise.resolve(
          sb
            .from('lead_events')
            .select('dispatch_id, meta')
            .in('business_phone', phones)
            .eq('event_type', 'dispatch_sent')
            .limit(500),
        ),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
      ]).catch(() => ({ data: null as null }))
    : Promise.resolve({ data: null as null });

  const [trainingResult, reviewResult, urgencyResult] = await Promise.all([
    trainingPromise, reviewPromise, urgencyPromise,
  ]);

  if (trainingResult.error || !trainingResult.data) return candidates;
  const data         = trainingResult.data as unknown as TrainingRow[];
  const reviewData   = (reviewResult.data ?? []) as unknown as ReviewRow[];
  const urgencyData  = (urgencyResult.data ?? []) as unknown as UrgencyEventRow[];

  // ── Build dispatch_id → urgency tier map ─────────────────────────────────────
  // Maps each dispatch to its urgency tier so we can filter training rows
  // by urgency tier when computing signal 6.
  const dispatchUrgencyMap = new Map<string, string>();
  for (const ev of urgencyData) {
    const tier = ev.meta?.urgencyTier;
    if (tier && ev.dispatch_id && !dispatchUrgencyMap.has(ev.dispatch_id)) {
      dispatchUrgencyMap.set(ev.dispatch_id, tier);
    }
  }

  // ── Aggregate stats ─────────────────────────────────────────────────────────

  const specificStats  = new Map<string, AcceptanceStats>();
  const generalStats   = new Map<string, AcceptanceStats>();
  const temporalStats  = new Map<string, AcceptanceStats>();
  const responseStats  = new Map<string, ResponseStats>();
  const urgencyStats   = new Map<string, AcceptanceStats>(); // signal 6: per urgency-tier

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

    // 6: urgency-tier acceptance — only accumulate when tier matches the current lead
    if (urgencyTier && row.dispatch_id) {
      const tier = dispatchUrgencyMap.get(row.dispatch_id);
      if (tier === urgencyTier) {
        incr(urgencyStats, row.business_phone, isAccepted);
      }
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
    //    Uses Wilson score lower bounds so sparse data (e.g. 1/1) does not
    //    crowd out businesses with proven track records (e.g. 18/20).
    let blendedRate: number;
    if (!specific && !general) {
      blendedRate = 0.5; // neutral for new businesses
    } else {
      const specificRate   = specific ? wilsonLower(specific.accepted, specific.total) : 0.5;
      const specificWeight = specific ? Math.min(specific.total, 20) : 0;
      const generalRate    = general  ? wilsonLower(general.accepted,  general.total)  : 0.5;
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
    //    Uses Wilson lower bound to avoid over-boosting businesses with 3/3 in this bucket.
    const temporal = temporalStats.get(b.phone);
    const temporalMultiplier = temporal && temporal.total >= 3
      ? 1.0 + (wilsonLower(temporal.accepted, temporal.total) - 0.5) * 0.20
      : 1.0;

    // 4. Response-time multiplier [0.95, 1.05] — faster responders get mild boost
    const resp    = responseStats.get(b.phone);
    const avgMs   = resp && resp.count > 0 ? resp.totalMs / resp.count : null;
    const speedNorm = avgMs !== null ? Math.max(0, 1 - avgMs / 60_000) : 0.5;
    const responseMultiplier = 0.95 + speedNorm * 0.10;

    // 5. Google Places rank signal — tie-breaker when training data is sparse
    const placesSignal = 1 / (googleRank + 1);

    // 6. Urgency-tier acceptance multiplier [0.90, 1.10] — requires ≥ 3 same-urgency events
    //    Boosts businesses that reliably respond to leads of this urgency level.
    const urgencyStat = urgencyTier ? urgencyStats.get(b.phone) : undefined;
    const urgencyMultiplier = urgencyStat && urgencyStat.total >= 3
      ? 1.0 + (wilsonLower(urgencyStat.accepted, urgencyStat.total) - 0.5) * 0.20
      : 1.0;

    const score = acceptMultiplier
      * reviewMultiplier
      * temporalMultiplier
      * responseMultiplier
      * urgencyMultiplier
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
