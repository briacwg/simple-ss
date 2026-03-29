/**
 * GET /api/internal/training-export
 *
 * Exports dispatch_training_events as a JSONL fine-tuning dataset in
 * OpenAI chat-completion format (system / user / assistant message triples).
 *
 * Each row becomes one training example:
 *   system  — persona + rule set for the dispatch-scoring model
 *   user    — the ranked-dispatch context (service, location, queue, supply)
 *   assistant — the target label: "ACCEPT", "DECLINE", or "TIMEOUT"
 *
 * Query parameters
 * ────────────────
 *   phone   (required) — business phone to export training data for
 *   limit   (optional, default 500, max 2000) — max rows to export
 *   outcome (optional) — filter to accepted | declined | timeout
 *   format  (optional) — "jsonl" (default) | "json" (array)
 *
 * Auth: requires DISPATCH_JOB_SECRET (same secret used by QStash jobs).
 *
 * Response (JSONL, Content-Type: application/x-ndjson):
 *   {"messages":[{"role":"system","content":"..."},{"role":"user","content":"..."},{"role":"assistant","content":"ACCEPT"}]}
 *   {"messages":[...]}
 *
 * The output is ready to upload directly to OpenAI fine-tuning jobs or
 * any JSONL-compatible fine-tuning pipeline.
 *
 * Pipeline overview
 * ─────────────────
 *   1. Export this endpoint → save as .jsonl
 *   2. Upload to OpenAI: `openai api fine_tuning.jobs.create -t <file>`
 *   3. Deploy the fine-tuned model ID as FINETUNE_DISPATCH_MODEL env var
 *   4. smart-rank.ts reads FINETUNE_DISPATCH_MODEL and calls the model
 *      for re-ranking when it is set (future integration point)
 */

import type { APIRoute } from 'astro';
import { normalizePhone } from '../../../lib';
import { getSupabase } from '../../../lib/supabase';
import { err } from '../../../lib/api-helpers';

export const prerender = false;

const SYSTEM_PROMPT =
  'You are a dispatch-acceptance scoring model for a home-services marketplace. ' +
  'Given a dispatch context (service type, location, queue position, supply level), ' +
  'predict whether the business will ACCEPT, DECLINE, or TIMEOUT (no response within window).';

/** Build the user-turn content from a training row. */
function buildUserTurn(row: TrainingRow, urgencyTier: string | null): string {
  const parts: string[] = [];
  if (row.service_label)  parts.push(`Service: ${row.service_label}`);
  if (row.location_cell)  parts.push(`Location cell: ${row.location_cell}`);
  if (row.supply_level)   parts.push(`Supply level: ${row.supply_level}`);
  if (urgencyTier)        parts.push(`Urgency: ${urgencyTier}`);
  parts.push(`Queue position: ${row.queue_position}`);
  if (row.window_seconds) parts.push(`Response window: ${row.window_seconds}s`);
  return parts.join('\n');
}

/** Normalise outcome to the assistant turn label. */
function outcomeLabel(outcome: string): string {
  if (outcome === 'accepted') return 'ACCEPT';
  if (outcome === 'declined') return 'DECLINE';
  return 'TIMEOUT';
}

interface TrainingRow {
  id:             string;
  dispatch_id:    string;
  service_label:  string | null;
  location_cell:  string | null;
  supply_level:   string;
  window_seconds: number;
  outcome:        string;
  response_ms:    number | null;
  queue_position: number;
  created_at:     string;
}

interface DispatchSentEvent {
  dispatch_id: string;
  meta:        { urgencyTier?: string; urgencyScore?: number } | null;
}

export const GET: APIRoute = async ({ url, request }) => {
  // ── Auth — require DISPATCH_JOB_SECRET ─────────────────────────────────────
  const secret = import.meta.env.DISPATCH_JOB_SECRET;
  if (secret) {
    const authHeader = request.headers.get('Authorization') ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (token !== secret) {
      return err('unauthorized', 401);
    }
  }

  // ── Parse params ──────────────────────────────────────────────────────────
  const rawPhone = url.searchParams.get('phone');
  if (!rawPhone) return err('phone query param required', 400);

  const phone = normalizePhone(rawPhone);
  if (!phone) return err('invalid phone number', 400);

  const rawLimit  = parseInt(url.searchParams.get('limit')  ?? '500', 10);
  const limit     = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 2000) : 500;
  const outcome   = url.searchParams.get('outcome')?.toLowerCase() ?? null;
  const format    = url.searchParams.get('format') ?? 'jsonl';

  const validOutcomes = ['accepted', 'declined', 'timeout'];
  if (outcome && !validOutcomes.includes(outcome)) {
    return err('outcome must be accepted | declined | timeout', 400);
  }

  // ── Query Supabase ─────────────────────────────────────────────────────────
  const sb = getSupabase();
  if (!sb) return err('database unavailable', 503);

  let query = sb
    .from('dispatch_training_events')
    .select('id, dispatch_id, service_label, location_cell, supply_level, window_seconds, outcome, response_ms, queue_position, created_at')
    .eq('business_phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (outcome) {
    query = query.eq('outcome', outcome);
  }

  const { data, error } = await query
    .then(r => r, () => ({ data: null, error: new Error('query failed') })) as {
      data: TrainingRow[] | null;
      error: Error | { message: string } | null;
    };

  if (error || !data) {
    return err('failed to load training events', 500);
  }

  // ── Fetch urgency tiers from lead_events (dispatch_sent) ──────────────────
  // Urgency is stored in the meta field of the dispatch_sent event so we can
  // enrich the training examples with urgency context without schema changes.
  const dispatchIds = [...new Set(data.map(r => r.dispatch_id))];
  const urgencyMap = new Map<string, string>();

  if (dispatchIds.length > 0) {
    const { data: urgencyRows } = await sb
      .from('lead_events')
      .select('dispatch_id, meta')
      .in('dispatch_id', dispatchIds)
      .eq('event_type', 'dispatch_sent')
      .limit(dispatchIds.length * 3)
      .then(r => r, () => ({ data: null })) as { data: DispatchSentEvent[] | null };

    for (const ev of urgencyRows ?? []) {
      if (ev.meta?.urgencyTier && !urgencyMap.has(ev.dispatch_id)) {
        urgencyMap.set(ev.dispatch_id, ev.meta.urgencyTier);
      }
    }
  }

  // ── Build JSONL examples ───────────────────────────────────────────────────
  const examples = data.map(row => ({
    messages: [
      { role: 'system',    content: SYSTEM_PROMPT },
      { role: 'user',      content: buildUserTurn(row, urgencyMap.get(row.dispatch_id) ?? null) },
      { role: 'assistant', content: outcomeLabel(row.outcome) },
    ],
  }));

  if (format === 'json') {
    return new Response(JSON.stringify({ examples, total: examples.length, phone }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Training-Count': String(examples.length),
      },
    });
  }

  // Default: JSONL (newline-delimited JSON, one example per line)
  const filename = `training-${phone.replace(/\+/g, '')}-${Date.now()}.jsonl`;
  const body     = examples.map(e => JSON.stringify(e)).join('\n');

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type':        'application/x-ndjson',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'X-Training-Count':    String(examples.length),
    },
  });
};
