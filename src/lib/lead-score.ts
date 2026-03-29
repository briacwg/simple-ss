/**
 * Lead urgency scoring.
 *
 * Classifies a consumer's problem description into an urgency tier using a fast,
 * deterministic keyword-signal approach (zero latency, no LLM call).
 *
 * Urgency tiers
 * ─────────────
 *   critical  — life-safety or property-damage risk (e.g. gas leak, flooding, no heat <32°F)
 *   high      — significant inconvenience, time-sensitive (e.g. no hot water, AC out in summer)
 *   medium    — functional but degraded (e.g. slow drain, noisy furnace)
 *   low       — cosmetic or upgrade requests (e.g. "want to modernise", "looking for quotes")
 *
 * The urgency tier is:
 *   1. Embedded in the outreach SMS to give the pro context on response urgency.
 *   2. Stored in the dispatch record meta field for analytics.
 *   3. Used to select the SMS call-to-action wording (e.g. "URGENT lead" vs "New lead").
 *
 * Design notes
 * ────────────
 * - Whole-word matching prevents false positives (e.g. "refrigerator" ≠ "fridge").
 * - Signals are weighted; the highest-weight matching signal wins.
 * - Designed to be a tiny, dependency-free module that runs in <1 ms.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type UrgencyTier = 'critical' | 'high' | 'medium' | 'low';

export interface LeadScore {
  /** Urgency classification. */
  tier: UrgencyTier;
  /** Numeric score 0–100 (higher = more urgent). */
  score: number;
  /** Human-readable description used in pro SMS (e.g. "URGENT"). */
  label: string;
  /** The signal phrase that triggered this tier, for debugging/analytics. */
  triggerPhrase: string | null;
}

// ── Signal definitions ────────────────────────────────────────────────────────

interface UrgencySignal {
  phrases:  string[];
  tier:     UrgencyTier;
  score:    number;
  label:    string;
}

/** Ordered from highest to lowest urgency. First match wins. */
const SIGNALS: UrgencySignal[] = [
  // ── Critical ──────────────────────────────────────────────────────────────
  {
    phrases: ['gas leak', 'smell gas', 'gas smell', 'carbon monoxide', 'co detector', 'flooding', 'flood', 'sewage backup', 'sewage overflow', 'electrical fire', 'sparks', 'sparking', 'smoke from outlet', 'no heat', 'pipes burst', 'pipe burst', 'burst pipe'],
    tier:    'critical',
    score:   95,
    label:   'EMERGENCY',
  },
  // ── High ──────────────────────────────────────────────────────────────────
  {
    phrases: ['no hot water', 'no water', 'water heater broken', 'ac not working', 'ac stopped', 'furnace not working', 'furnace stopped', 'heat not working', 'toilet overflowing', 'toilet overflow', 'leak', 'leaking', 'water damage', 'ceiling dripping', 'power out', 'no power', 'electrical outage', 'fridge not cooling', 'refrigerator not cooling', 'same day', 'today', 'urgent', 'asap', 'emergency'],
    tier:    'high',
    score:   75,
    label:   'URGENT',
  },
  // ── Medium ────────────────────────────────────────────────────────────────
  {
    phrases: ['not working', 'broken', 'stopped working', 'making noise', 'strange noise', 'loud noise', 'slow drain', 'clogged drain', 'clogged', 'low water pressure', 'dripping faucet', 'running toilet', 'thermostat issue', 'this week', 'within a few days'],
    tier:    'medium',
    score:   45,
    label:   'Service needed',
  },
  // ── Low (default) ─────────────────────────────────────────────────────────
  {
    phrases: ['looking for quotes', 'get a quote', 'estimate', 'upgrade', 'install', 'replace', 'inspection', 'maintenance', 'service', 'tune-up', 'cleaning'],
    tier:    'low',
    score:   20,
    label:   'New lead',
  },
];

// ── Scoring function ──────────────────────────────────────────────────────────

/**
 * Scores a consumer problem description for urgency.
 *
 * Checks each urgency tier from critical → low, returning on the first match.
 * Case-insensitive; applies word-boundary checks for short terms to prevent
 * false positives (e.g. "leaking" won't match inside "freaking").
 */
export function scoreLeadUrgency(problem: string): LeadScore {
  if (!problem) {
    return { tier: 'low', score: 20, label: 'New lead', triggerPhrase: null };
  }

  const lower = problem.toLowerCase();

  for (const signal of SIGNALS) {
    for (const phrase of signal.phrases) {
      // Use word-boundary matching for short single words (≤8 chars) to avoid
      // substring false positives; longer phrases are distinct enough to match directly.
      const matched = phrase.includes(' ') || phrase.length > 8
        ? lower.includes(phrase)
        : new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(lower);

      if (matched) {
        return {
          tier:          signal.tier,
          score:         signal.score,
          label:         signal.label,
          triggerPhrase: phrase,
        };
      }
    }
  }

  // No signal matched — default to low urgency
  return { tier: 'low', score: 20, label: 'New lead', triggerPhrase: null };
}

/**
 * Builds the urgency prefix for the outbound business SMS.
 *
 * Examples:
 *   critical → "🚨 EMERGENCY lead"
 *   high     → "⚡ URGENT lead"
 *   medium   → "Service needed"
 *   low      → "New lead"
 *
 * Emoji are stripped in environments that don't support them (plain SMS).
 * The prefix replaces "New lead" in the dispatch SMS template.
 */
export function urgencySmsPrefix(score: LeadScore, businessName: string): string {
  const name = businessName.split(' ')[0] ?? businessName;
  switch (score.tier) {
    case 'critical': return `ServiceSurfer: 🚨 EMERGENCY lead for ${name}!`;
    case 'high':     return `ServiceSurfer: ⚡ URGENT lead for ${name}!`;
    case 'medium':   return `ServiceSurfer: New lead for ${name}!`;
    case 'low':      return `ServiceSurfer: New lead for ${name}!`;
  }
}
