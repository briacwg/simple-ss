/**
 * Layer 1 — Deterministic Service Intent Engine
 *
 * Zero-latency, zero-cost intent classification that runs before any LLM call.
 * Matches a consumer's free-text description against a curated rule set to
 * instantly produce a structured search query and service label.
 *
 * Architecture:
 *   Layer 1 (this file):  deterministic, <1ms, no I/O — covers ~80% of queries
 *   Layer 2 (smartMatch): Cerebras LLM, ~200–400ms — handles edge cases / nuance
 *   Layer 3 (summarize):  Cerebras website fetch + summarize — enriches results
 *
 * Rule set is intentionally kept in sync with the main ServiceSurfer platform
 * (servicesurfer/src/lib/server/service-intent.ts) so that intent classifications
 * are consistent across all surfaces.
 */

export interface ServiceIntentHint {
  /** Google Places search query (e.g. "plumber", "HVAC repair"). */
  query: string;
  /** Singular label for the service professional (e.g. "plumber"). */
  singularLabel: string;
  /** Plural label (e.g. "plumbers"). Used in UI headings. */
  pluralLabel: string;
  /** Grammatical article for the singular label ("a" or "an"). */
  article: 'a' | 'an';
}

export interface DiagnosisHint {
  /** Short label shown to the consumer (e.g. "Water leak detected"). */
  diagnosisLabel: string;
  /** Likely root cause explanation (e.g. "Likely: pipe or fitting failure"). */
  likelyCauses: string;
}

interface DiagnosisSubRule {
  terms: readonly string[];
  diagnosisLabel: string;
  likelyCauses: string;
}

interface ServiceIntentRule extends ServiceIntentHint {
  terms: readonly string[];
  diagnosisDefault: DiagnosisHint;
  diagnosisGroups?: readonly DiagnosisSubRule[];
}

// ── Rule set ──────────────────────────────────────────────────────────────────
// Each rule maps a set of trigger terms to a canonical service query + label.
// Terms are matched with whole-word, phrase-prefix, and token-prefix strategies
// (in descending weight order) so partial/mid-sentence mentions still resolve.

const SERVICE_INTENT_RULES: readonly ServiceIntentRule[] = [
  {
    query: 'plumber',
    singularLabel: 'plumber',
    pluralLabel: 'plumbers',
    article: 'a',
    terms: [
      'plumber', 'plumbing', 'sink', 'faucet', 'toilet', 'drain', 'sewer',
      'pipe', 'leak', 'leaking', 'water heater', 'garbage disposal', 'shower', 'bathtub',
    ],
    diagnosisDefault: { diagnosisLabel: 'Plumbing issue detected', likelyCauses: 'Likely: pipes, faucets, or fixtures' },
    diagnosisGroups: [
      {
        terms: ['hot water', 'water heater', 'not hot', 'no hot', 'cold water', 'cold shower', 'warm water', 'lukewarm'],
        diagnosisLabel: 'Heating issue detected',
        likelyCauses: 'Likely: water heater or supply line',
      },
      {
        terms: ['leak', 'leaking', 'burst', 'flooding', 'flood', 'drip', 'dripping', 'water damage'],
        diagnosisLabel: 'Water leak detected',
        likelyCauses: 'Likely: pipe or fitting failure',
      },
      {
        terms: ['toilet', 'flush', 'overflowing', 'overflow', "won't flush"],
        diagnosisLabel: 'Toilet issue detected',
        likelyCauses: 'Likely: toilet mechanism or supply line',
      },
      {
        terms: ['drain', 'clog', 'clogged', 'backed up', 'slow drain'],
        diagnosisLabel: 'Drain blockage detected',
        likelyCauses: 'Likely: clog or drain line',
      },
    ],
  },
  {
    query: 'HVAC repair',
    singularLabel: 'HVAC pro',
    pluralLabel: 'HVAC pros',
    article: 'an',
    terms: [
      'hvac', 'air conditioning', 'ac', 'cooling', 'heater', 'heating',
      'furnace', 'heat pump', 'thermostat', 'vents', 'duct', 'ductless',
    ],
    diagnosisDefault: { diagnosisLabel: 'HVAC issue detected', likelyCauses: 'Likely: AC or heating system' },
    diagnosisGroups: [
      {
        terms: ['ac', 'air conditioning', 'cooling', 'not cooling', 'no cool', 'too hot', 'hot inside', 'warm inside'],
        diagnosisLabel: 'Cooling failure detected',
        likelyCauses: 'Likely: AC unit or refrigerant',
      },
      {
        terms: ['furnace', 'not heating', 'no heat', 'cold inside', 'heat pump', "won't heat"],
        diagnosisLabel: 'Heating failure detected',
        likelyCauses: 'Likely: furnace or heat pump',
      },
    ],
  },
  {
    query: 'electrician',
    singularLabel: 'electrician',
    pluralLabel: 'electricians',
    article: 'an',
    terms: [
      'electrician', 'electrical', 'outlet', 'breaker', 'panel', 'wiring',
      'light', 'lights', 'lighting', 'light bulb', 'lightbulb', 'bulb',
      'fixture', 'light fixture', 'ceiling fan', 'fan wiring', 'flickering',
      'switch', 'generator',
    ],
    diagnosisDefault: { diagnosisLabel: 'Electrical issue detected', likelyCauses: 'Likely: wiring or panel' },
    diagnosisGroups: [
      {
        terms: ['flickering', 'flicker', 'lights out', 'no power', 'power out', 'outage', 'no electricity'],
        diagnosisLabel: 'Power issue detected',
        likelyCauses: 'Likely: wiring or circuit breaker',
      },
      {
        terms: ['breaker', 'panel', 'tripped', 'keeps tripping', 'circuit'],
        diagnosisLabel: 'Circuit issue detected',
        likelyCauses: 'Likely: breaker panel or overload',
      },
      {
        terms: ['outlet', 'socket', 'plug', 'not working', 'dead outlet'],
        diagnosisLabel: 'Power issue detected',
        likelyCauses: 'Likely: outlet or wiring fault',
      },
    ],
  },
  {
    query: 'roof repair',
    singularLabel: 'roofer',
    pluralLabel: 'roofers',
    article: 'a',
    terms: [
      'roofer', 'roof', 'roofing', 'roof leak', 'shingle', 'gutter',
      'gutters', 'flashing', 'ceiling stain', 'storm damage',
    ],
    diagnosisDefault: { diagnosisLabel: 'Roof issue detected', likelyCauses: 'Likely: shingles or flashing' },
    diagnosisGroups: [
      {
        terms: ['leak', 'leaking', 'drip', 'water stain', 'ceiling stain', 'wet ceiling'],
        diagnosisLabel: 'Roof leak detected',
        likelyCauses: 'Likely: shingles or flashing failure',
      },
      {
        terms: ['storm', 'wind', 'hail', 'damage', 'tree fell', 'branch', 'fallen tree'],
        diagnosisLabel: 'Storm damage detected',
        likelyCauses: 'Likely: shingles or structural damage',
      },
    ],
  },
  {
    query: 'house cleaning',
    singularLabel: 'house cleaner',
    pluralLabel: 'house cleaners',
    article: 'a',
    terms: ['cleaner', 'cleaning', 'deep clean', 'maid', 'housekeeping', 'janitorial'],
    diagnosisDefault: { diagnosisLabel: 'Cleaning need detected', likelyCauses: 'Likely: deep clean or recurring service' },
  },
  {
    query: 'window repair',
    singularLabel: 'window repair pro',
    pluralLabel: 'window repair pros',
    article: 'a',
    terms: ['window repair', 'window', 'windows', 'window pane', 'window glass', 'glass repair', 'glazier'],
    diagnosisDefault: { diagnosisLabel: 'Window issue detected', likelyCauses: 'Likely: glass, frame, or seal' },
    diagnosisGroups: [
      {
        terms: ['broken window', 'cracked window', 'shattered', 'window glass', 'window pane'],
        diagnosisLabel: 'Window damage detected',
        likelyCauses: 'Likely: broken glass or damaged pane',
      },
      {
        terms: ['stuck window', 'wont open', "won't open", 'wont close', "won't close", 'drafty window', 'draft'],
        diagnosisLabel: 'Window operation issue detected',
        likelyCauses: 'Likely: frame, track, or seal problem',
      },
    ],
  },
  {
    query: 'handyman',
    singularLabel: 'handyman',
    pluralLabel: 'handymen',
    article: 'a',
    terms: ['handyman', 'odd job', 'hole in wall', 'drywall', 'door', 'hinge', 'trim', 'caulk', 'caulking'],
    diagnosisDefault: { diagnosisLabel: 'Home repair detected', likelyCauses: 'Likely: minor repair or fixture' },
  },
  {
    query: 'appliance repair',
    singularLabel: 'appliance repair tech',
    pluralLabel: 'appliance repair techs',
    article: 'an',
    terms: [
      'appliance', 'washer', 'washing machine', 'dryer', 'dishwasher',
      'fridge', 'refrigerator', 'oven', 'stove', 'microwave',
    ],
    diagnosisDefault: { diagnosisLabel: 'Appliance issue detected', likelyCauses: 'Likely: motor or electronic controls' },
    diagnosisGroups: [
      {
        terms: ['washer', 'washing machine', 'dryer'],
        diagnosisLabel: 'Laundry appliance issue detected',
        likelyCauses: 'Likely: motor, belt, or drum',
      },
      {
        terms: ['fridge', 'refrigerator', 'freezer', 'not cooling', 'not cold'],
        diagnosisLabel: 'Cooling appliance issue detected',
        likelyCauses: 'Likely: compressor or thermostat',
      },
      {
        terms: ['oven', 'stove', 'range', 'not heating', "won't heat", 'burner'],
        diagnosisLabel: 'Cooking appliance issue detected',
        likelyCauses: 'Likely: heating element or igniter',
      },
    ],
  },
  {
    query: 'garage door repair',
    singularLabel: 'garage door pro',
    pluralLabel: 'garage door pros',
    article: 'a',
    terms: ['garage door', 'garage opener', 'garage'],
    diagnosisDefault: { diagnosisLabel: 'Garage door issue detected', likelyCauses: 'Likely: opener, spring, or track' },
  },
  {
    query: 'cabinet repair',
    singularLabel: 'cabinet repair pro',
    pluralLabel: 'cabinet repair pros',
    article: 'a',
    terms: ['cabinet', 'cabinets', 'cupboard', 'cupboards', 'drawer', 'drawers', 'hinge', 'hinges', 'vanity', 'shelving', 'shelf'],
    diagnosisDefault: { diagnosisLabel: 'Cabinet issue detected', likelyCauses: 'Likely: hinge, drawer, or hardware' },
  },
  {
    query: 'fence repair',
    singularLabel: 'fence repair pro',
    pluralLabel: 'fence repair pros',
    article: 'a',
    terms: ['fence', 'fences', 'fence repair', 'gate', 'gates', 'fence post', 'picket fence', 'chain link', 'vinyl fence', 'wood fence'],
    diagnosisDefault: { diagnosisLabel: 'Fence issue detected', likelyCauses: 'Likely: post, panel, or gate' },
  },
  {
    query: 'pest control',
    singularLabel: 'pest control pro',
    pluralLabel: 'pest control pros',
    article: 'a',
    terms: ['pest', 'exterminator', 'ants', 'termites', 'rodents', 'mice', 'rats', 'roaches', 'bed bugs', 'wasps', 'bees'],
    diagnosisDefault: { diagnosisLabel: 'Pest infestation detected', likelyCauses: 'Likely: infestation or colony' },
    diagnosisGroups: [
      {
        terms: ['termites', 'termite'],
        diagnosisLabel: 'Termite damage risk detected',
        likelyCauses: 'Likely: active termite colony',
      },
      {
        terms: ['bed bugs', 'bed bug'],
        diagnosisLabel: 'Bed bug infestation detected',
        likelyCauses: 'Likely: infestation in bedding or walls',
      },
    ],
  },
  {
    query: 'landscaping',
    singularLabel: 'landscaper',
    pluralLabel: 'landscapers',
    article: 'a',
    terms: [
      'landscaping', 'landscaper', 'lawn', 'grass', 'grass cut', 'grass cutting',
      'cut grass', 'lawn mowing', 'mow', 'mowing', 'lawn care', 'yard', 'tree',
      'hedge', 'hedges', 'bush', 'bushes', 'shrub', 'shrubs', 'trim', 'trimming',
      'prune', 'pruning', 'hedge trimming', 'bush trimming', 'stump', 'irrigation', 'mulch',
    ],
    diagnosisDefault: { diagnosisLabel: 'Yard maintenance needed', likelyCauses: 'Likely: lawn care or landscaping' },
    diagnosisGroups: [
      {
        terms: ['tree', 'stump', 'branch', 'fallen tree', 'tree removal'],
        diagnosisLabel: 'Tree issue detected',
        likelyCauses: 'Likely: trimming, removal, or stump',
      },
    ],
  },
  {
    query: 'locksmith',
    singularLabel: 'locksmith',
    pluralLabel: 'locksmiths',
    article: 'a',
    terms: ['locksmith', 'locked out', 'lockout', 'rekey', 'deadbolt', 'key'],
    diagnosisDefault: { diagnosisLabel: 'Access issue detected', likelyCauses: 'Likely: lock mechanism or key' },
  },
  {
    query: 'auto repair',
    singularLabel: 'mechanic',
    pluralLabel: 'mechanics',
    article: 'a',
    terms: ['mechanic', 'auto repair', 'car repair', 'car', 'brake', 'transmission', 'battery', 'check engine', 'tire'],
    diagnosisDefault: { diagnosisLabel: 'Vehicle issue detected', likelyCauses: 'Likely: engine or mechanical component' },
    diagnosisGroups: [
      {
        terms: ['check engine', 'engine light', 'engine', "won't start", 'stalling'],
        diagnosisLabel: 'Engine issue detected',
        likelyCauses: 'Likely: sensor, ignition, or engine component',
      },
      {
        terms: ['brake', 'brakes', 'squeaking', 'grinding'],
        diagnosisLabel: 'Brake issue detected',
        likelyCauses: 'Likely: pads, rotors, or calipers',
      },
      {
        terms: ['battery', 'dead battery', "won't start", 'no power'],
        diagnosisLabel: 'Starting issue detected',
        likelyCauses: 'Likely: battery or alternator',
      },
    ],
  },
  {
    query: 'mold remediation',
    singularLabel: 'mold remediation pro',
    pluralLabel: 'mold remediation pros',
    article: 'a',
    terms: ['mold', 'mould', 'mildew', 'black mold', 'black spots', 'musty smell', 'musty odor', 'musty', 'mold removal', 'mold remediation'],
    diagnosisDefault: { diagnosisLabel: 'Mold or moisture issue detected', likelyCauses: 'Likely: mold growth from moisture or leak' },
  },
  {
    query: 'water damage restoration',
    singularLabel: 'water damage pro',
    pluralLabel: 'water damage pros',
    article: 'a',
    terms: [
      'water damage', 'flood damage', 'flooded basement', 'flooded floor', 'basement flooded',
      'standing water', 'soaked floor', 'soaked walls', 'damp walls', 'damp ceiling', 'wet walls', 'water restoration',
    ],
    diagnosisDefault: { diagnosisLabel: 'Water damage detected', likelyCauses: 'Likely: flooding, leak, or moisture intrusion' },
  },
  {
    query: 'tow truck',
    singularLabel: 'tow truck',
    pluralLabel: 'tow trucks',
    article: 'a',
    terms: ['tow truck', 'towing', 'roadside', 'jump start', 'flat tire'],
    diagnosisDefault: { diagnosisLabel: 'Roadside emergency detected', likelyCauses: 'Likely: breakdown or flat tire' },
  },
];

// ── Text normalisation ────────────────────────────────────────────────────────

function normalizeIntentText(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeIntentRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Match strategies (descending weight) ──────────────────────────────────────

/**
 * Whole-word match: the term appears as a complete word (or phrase) in the text.
 * Handles multi-word terms by allowing flexible whitespace between tokens.
 */
function hasWholeIntentTerm(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedText || !normalizedTerm) return false;
  const pattern = new RegExp(
    `(?:^|\\s)${escapeIntentRegex(normalizedTerm).replace(/\\ /g, '\\s+')}(?:\\s|$)`,
    'i',
  );
  return pattern.test(normalizedText);
}

/**
 * Token prefix match: at least one token in the text is a prefix of a term token.
 * Catches truncated words like "plumb" matching "plumbing".
 */
function hasIntentPrefixMatch(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedText || !normalizedTerm) return false;
  const tokens = normalizedText.split(/\s+/).filter(t => t.length >= 3);
  if (!tokens.length) return false;
  return normalizedTerm
    .split(/\s+/)
    .some(termToken => tokens.some(token => termToken.length > token.length && termToken.startsWith(token)));
}

/**
 * Phrase-prefix match: a contiguous slice of text tokens starts the term phrase,
 * with the last token allowed to be a prefix of the corresponding term token.
 * Handles mid-input states like "air cond" matching "air conditioning".
 */
function hasIntentPhrasePrefixMatch(normalizedText: string, normalizedTerm: string): boolean {
  if (!normalizedText || !normalizedTerm) return false;
  const textTokens = normalizedText.split(/\s+/).filter(Boolean);
  const termTokens = normalizedTerm.split(/\s+/).filter(Boolean);
  if (textTokens.length < 2 || termTokens.length < 2) return false;

  for (let start = 0; start < textTokens.length; start++) {
    const maxLen = Math.min(termTokens.length, textTokens.length - start);
    for (let len = maxLen; len >= 2; len--) {
      const slice = textTokens.slice(start, start + len);
      let matched = true;
      let exact = 0;
      for (let i = 0; i < slice.length; i++) {
        const qt = slice[i]!;
        const tt = termTokens[i];
        if (!tt) { matched = false; break; }
        if (qt === tt) { exact++; continue; }
        const isLast = i === slice.length - 1;
        if (isLast && qt.length >= 2 && tt.length > qt.length && tt.startsWith(qt)) continue;
        matched = false; break;
      }
      if (matched && exact > 0) return true;
    }
  }
  return false;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Layer 1 deterministic service intent classifier.
 *
 * Scores all rules against the input using three match strategies and returns
 * the top-scoring rule's intent hint.  Runs synchronously in <1ms with no I/O.
 *
 * Returns null when no rule reaches a positive score (e.g. nonsense input).
 *
 * @param input Raw consumer description (e.g. "my AC won't cool anymore")
 */
export function inferServiceIntentHint(input: string): ServiceIntentHint | null {
  const normalized = normalizeIntentText(input);
  if (!normalized) return null;

  let topRule: ServiceIntentRule | null = null;
  let topScore = 0;

  for (const rule of SERVICE_INTENT_RULES) {
    let score = 0;
    for (const term of rule.terms) {
      const nt = normalizeIntentText(term);
      if (!nt) continue;
      const isPhrase = nt.includes(' ');
      if (hasWholeIntentTerm(normalized, nt)) {
        score += isPhrase ? 2 : 1;
      } else if (hasIntentPhrasePrefixMatch(normalized, nt)) {
        score += isPhrase ? 3 : 1.2;
      } else if (hasIntentPrefixMatch(normalized, nt)) {
        score += isPhrase ? 1.15 : 0.75;
      }
    }
    if (score > topScore) { topScore = score; topRule = rule; }
  }

  if (!topRule || topScore <= 0) return null;
  return { query: topRule.query, singularLabel: topRule.singularLabel, pluralLabel: topRule.pluralLabel, article: topRule.article };
}

/**
 * Returns a refined diagnosis label and likely-cause string for a specific
 * service query + description pair.  Used to populate the "issue detected"
 * callout in the consumer UI.
 *
 * @param description Consumer's raw problem description
 * @param serviceQuery Canonical query string from {@link inferServiceIntentHint}
 */
export function inferDiagnosisHint(description: string, serviceQuery: string): DiagnosisHint | null {
  const normalized = normalizeIntentText(description);
  if (!normalized) return null;

  const rule = SERVICE_INTENT_RULES.find(
    r => normalizeIntentText(r.query) === normalizeIntentText(serviceQuery),
  );
  if (!rule) return null;

  if (rule.diagnosisGroups) {
    for (const group of rule.diagnosisGroups) {
      for (const term of group.terms) {
        if (hasWholeIntentTerm(normalized, normalizeIntentText(term))) {
          return { diagnosisLabel: group.diagnosisLabel, likelyCauses: group.likelyCauses };
        }
      }
    }
  }
  return rule.diagnosisDefault;
}

/**
 * Returns the best deterministic search query for a description, or falls back
 * to the first 5 words.  Safe to call when a full {@link inferServiceIntentHint}
 * result is not needed.
 */
export function fallbackSearchQuery(description: string): string {
  const hint = inferServiceIntentHint(description);
  return hint?.query ?? String(description || '').trim().split(/\s+/).slice(0, 5).join(' ');
}
