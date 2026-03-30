/**
 * Upstash Vector client and intent-embedding helpers.
 *
 * Used to store and query:
 *   - Consumer intent embeddings (what users are searching for)
 *   - Business performance profiles (acceptance rate, response time, top services)
 *   - Call outcome embeddings (for future smart-ranking improvements)
 *
 * Index naming convention:
 *   Namespace "intents"    — consumer search queries
 *   Namespace "businesses" — business performance profiles
 *   Namespace "outcomes"   — call/dispatch outcomes
 *
 * Upstash Vector uses its built-in embedding model (text embedding-3-small via BAAI/bge)
 * so we only need to send raw text — no separate embedding API key required.
 *
 * Environment variables required:
 *   UPSTASH_VECTOR_REST_URL
 *   UPSTASH_VECTOR_REST_TOKEN
 */

import { Index } from '@upstash/vector';

// ── Client factory ────────────────────────────────────────────────────────────

let _index: Index | null = null;

/**
 * Returns a lazy-initialized Upstash Vector index, or null if env vars are missing.
 */
export function getVectorIndex(): Index | null {
  if (_index) return _index;
  const url   = process.env.UPSTASH_VECTOR_REST_URL   || (typeof import.meta !== 'undefined' ? import.meta.env?.UPSTASH_VECTOR_REST_URL   : '');
  const token = process.env.UPSTASH_VECTOR_REST_TOKEN || (typeof import.meta !== 'undefined' ? import.meta.env?.UPSTASH_VECTOR_REST_TOKEN : '');
  if (!url || !token) return null;
  _index = new Index({ url, token });
  return _index;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IntentRecord {
  /** Unique ID: dispatch_id or search_id */
  id: string;
  /** Raw search query / problem description from consumer */
  query: string;
  /** One-line AI summary (e.g. "Customer needs urgent HVAC repair") */
  summary?: string;
  /** Normalized service label extracted (e.g. "plumber") */
  serviceLabel: string | null;
  /** Location grid cell */
  locationCell: string | null;
  /** Dispatch outcome if known */
  outcome?: 'accepted' | 'declined' | 'timeout' | 'no_match';
  /** Business phone that handled this */
  businessPhone?: string;
  /** ISO timestamp */
  createdAt: string;
}

export interface BusinessProfile {
  /** Business phone (E.164) — also the vector ID */
  phone: string;
  /** Display name */
  name: string;
  /** 30-day acceptance rate (0-1) */
  acceptanceRate: number;
  /** Average response time in ms */
  avgResponseMs: number | null;
  /** Top service labels */
  topServices: string[];
  /** Performance score (0-100) */
  performanceScore: number | null;
  /** ISO timestamp of last update */
  updatedAt: string;
}

// ── Intent upsert ─────────────────────────────────────────────────────────────

/**
 * Upserts a consumer intent vector.
 * Text used for embedding: "<serviceLabel> <query>"
 * Non-fatal — errors are swallowed so dispatch is never blocked.
 */
export async function upsertIntent(record: IntentRecord): Promise<void> {
  const idx = getVectorIndex();
  if (!idx) return;

  // Use AI summary as the embedding text when available — it's more semantically rich
  const text = (record.summary || [record.serviceLabel, record.query].filter(Boolean).join(' ')).slice(0, 500);

  await idx.upsert(
    {
      id:   record.id,
      data: text,
      metadata: {
        serviceLabel:  record.serviceLabel ?? '',
        locationCell:  record.locationCell ?? '',
        outcome:       record.outcome ?? '',
        businessPhone: record.businessPhone ?? '',
        summary:       record.summary ?? '',
        query:         record.query.slice(0, 300),
        createdAt:     record.createdAt,
      },
    },
    { namespace: 'intents' },
  ).catch(e => console.error('[vector] upsertIntent failed:', e?.message));
}

/**
 * Upserts a business performance profile.
 * Text for embedding: "<name> <topServices joined>"
 * Non-fatal.
 */
export async function upsertBusinessProfile(profile: BusinessProfile): Promise<void> {
  const idx = getVectorIndex();
  if (!idx) return;

  const text = [profile.name, ...profile.topServices].join(' ').slice(0, 500);

  await idx.upsert(
    {
      id:   profile.phone,
      data: text,
      metadata: {
        name:             profile.name,
        acceptanceRate:   profile.acceptanceRate,
        avgResponseMs:    profile.avgResponseMs ?? 0,
        performanceScore: profile.performanceScore ?? 0,
        topServices:      profile.topServices.join(','),
        updatedAt:        profile.updatedAt,
      },
    },
    { namespace: 'businesses' },
  ).catch(e => console.error('[vector] upsertBusinessProfile failed:', e?.message));
}

// ── AI summary ───────────────────────────────────────────────────────────────

/**
 * Generates a one-line AI summary of a consumer problem for cheap, reusable storage.
 * e.g. "AC not working" → "Customer needs urgent HVAC repair — AC not cooling"
 * Non-fatal — falls back to the raw text if Cerebras is unavailable.
 */
export async function generateIntentSummary(problemText: string, serviceLabel: string | null): Promise<string> {
  const key = process.env.CEREBRAS_API_KEY || (typeof import.meta !== 'undefined' ? import.meta.env?.CEREBRAS_API_KEY : '');
  if (!key || !problemText) return [serviceLabel, problemText].filter(Boolean).join(': ').slice(0, 200);

  try {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.CEREBRAS_MODEL || 'gpt-oss-120b',
        max_tokens: 60,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: 'Summarize the home-service customer request in one short sentence (max 20 words). Be specific and factual. No punctuation at the end.',
          },
          { role: 'user', content: problemText },
        ],
      }),
    });
    if (!res.ok) throw new Error(`Cerebras ${res.status}`);
    const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const summary = data.choices?.[0]?.message?.content?.trim();
    return summary || problemText.slice(0, 200);
  } catch {
    return [serviceLabel, problemText].filter(Boolean).join(': ').slice(0, 200);
  }
}

// ── Similarity queries ────────────────────────────────────────────────────────

/**
 * Finds the top-K most similar past intents for a given query.
 * Useful for: "what service types are similar to this query?"
 */
export async function querySimilarIntents(
  query: string,
  topK = 5,
  filter?: string,
): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> {
  const idx = getVectorIndex();
  if (!idx) return [];
  try {
    const results = await idx.query(
      { data: query, topK, includeMetadata: true, filter },
      { namespace: 'intents' },
    );
    return results.map(r => ({
      id:       String(r.id),
      score:    r.score,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  } catch (e) {
    console.error('[vector] querySimilarIntents failed:', (e as Error)?.message);
    return [];
  }
}

/**
 * Finds businesses with profiles most similar to the given service description.
 */
export async function querySimilarBusinesses(
  serviceDescription: string,
  topK = 10,
): Promise<Array<{ id: string; score: number; metadata: Record<string, unknown> }>> {
  const idx = getVectorIndex();
  if (!idx) return [];
  try {
    const results = await idx.query(
      { data: serviceDescription, topK, includeMetadata: true },
      { namespace: 'businesses' },
    );
    return results.map(r => ({
      id:       String(r.id),
      score:    r.score,
      metadata: (r.metadata ?? {}) as Record<string, unknown>,
    }));
  } catch (e) {
    console.error('[vector] querySimilarBusinesses failed:', (e as Error)?.message);
    return [];
  }
}
