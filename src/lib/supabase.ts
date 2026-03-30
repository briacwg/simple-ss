/**
 * Supabase client and typed table interfaces for simple-ss.
 *
 * Uses the service-role key for all server-side operations (API routes run
 * in a trusted server context and never execute in the browser).  RLS is
 * enforced at the database level for multi-tenant tables; the service role
 * bypasses RLS only where explicitly needed (e.g. dispatch training events
 * which have no user context).
 *
 * Table definitions mirror the main ServiceSurfer platform schema exactly
 * so that data written here is immediately visible in the business portal.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// ── Type definitions ──────────────────────────────────────────────────────────

export interface DispatchTrainingEvent {
  id?: string;
  dispatch_id: string;
  business_phone: string;
  service_label: string | null;
  location_cell: string | null;
  supply_level: 'high' | 'normal' | 'low';
  window_seconds: number;
  outcome: 'accepted' | 'declined' | 'timeout';
  response_ms: number | null;
  queue_position: number;
  created_at?: string;
}

export interface LeadEvent {
  id?: string;
  dispatch_id: string | null;
  business_phone: string | null;
  event_type:
    | 'search_match' | 'call_initiated' | 'call_connected' | 'call_failed'
    | 'video_started' | 'website_click' | 'dispatch_sent' | 'dispatch_accepted'
    | 'dispatch_declined' | 'dispatch_timeout' | 'review_sent' | 'review_received'
    | 'claim_initiated' | 'claim_verified';
  service_label: string | null;
  location_cell: string | null;
  consumer_phone: string | null;
  meta: Record<string, unknown> | null;
  created_at?: string;
}

export interface UserPasskey {
  id?: string;
  user_id: string;
  credential_id: string;
  public_key: string;
  counter: number;
  transports: string[];
  device_type: string | null;
  backed_up: boolean | null;
  friendly_name: string | null;
  last_used_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface PasskeyChallenge {
  id?: string;
  user_id: string;
  purpose: 'register' | 'authenticate';
  challenge: string;
  expires_at: string;
  used_at: string | null;
  created_at?: string;
}

export interface BusinessWorkspaceSettings {
  id?: string;
  business_phone: string;
  plan_slug: string;
  tone: 'friendly' | 'premium' | 'direct';
  answer_length: 'short' | 'balanced' | 'detailed';
  banned_claims: string[];
  required_phrases: string[];
  collect_lead_details: boolean;
  escalate_to_call: boolean;
  escalate_to_video: boolean;
  knowledge_urls: string[];
  starter_questions: string[];
  notes: string | null;
  /** Whether the business is currently accepting new leads (default true). */
  available: boolean;
  /** Average job value in USD — used for estimated earnings display (0 = not set). */
  avg_job_value: number;
  created_at?: string;
  updated_at?: string;
}

export interface BusinessDashboardMetrics {
  business_phone: string;
  leads_30d: number;
  calls_30d: number;
  dispatches_30d: number;
  accepted_30d: number;
  declined_30d: number;
  timeout_30d: number;
  avg_response_ms: number | null;
  top_service_labels: string[];
  updated_at: string;
}

// ── Database type map ─────────────────────────────────────────────────────────
//
// @supabase/supabase-js ≥ 2.x requires the full public-schema shape — Tables,
// Views, Functions, Enums, and CompositeTypes must all be present.  Without the
// extra keys, the client resolves every Insert/Update type as `never`.

// PostgREST v12 table entry shape (Supabase JS ≥ 2.x requirement)
interface TableDef<TRow, TInsert, TUpdate> {
  Row:           TRow;
  Insert:        TInsert;
  Update:        TUpdate;
  Relationships: never[];
}

export interface Database {
  public: {
    Tables: {
      dispatch_training_events: TableDef<
        DispatchTrainingEvent & { id: string; created_at: string },
        Omit<DispatchTrainingEvent, 'id' | 'created_at'>,
        Partial<Omit<DispatchTrainingEvent, 'id' | 'created_at'>>
      >;
      lead_events: TableDef<
        LeadEvent & { id: string; created_at: string },
        Omit<LeadEvent, 'id' | 'created_at'>,
        Partial<Omit<LeadEvent, 'id' | 'created_at'>>
      >;
      user_passkeys: TableDef<
        UserPasskey & { id: string; created_at: string; updated_at: string },
        Omit<UserPasskey, 'id' | 'created_at' | 'updated_at'>,
        Partial<Omit<UserPasskey, 'id' | 'created_at' | 'updated_at'>>
      >;
      passkey_challenges: TableDef<
        PasskeyChallenge & { id: string; created_at: string },
        Omit<PasskeyChallenge, 'id' | 'created_at'>,
        Partial<Omit<PasskeyChallenge, 'id' | 'created_at'>>
      >;
      business_workspace_settings: TableDef<
        BusinessWorkspaceSettings & { id: string; created_at: string; updated_at: string },
        Omit<BusinessWorkspaceSettings, 'id' | 'created_at' | 'updated_at'>,
        Partial<Omit<BusinessWorkspaceSettings, 'id' | 'created_at' | 'updated_at'>>
      >;
      business_dashboard_metrics: TableDef<
        BusinessDashboardMetrics,
        BusinessDashboardMetrics,
        Partial<BusinessDashboardMetrics>
      >;
      search_result_cache: TableDef<
        {
          cache_key: string; query: string; location_cell: string;
          lat: number; lng: number; result: Record<string, unknown>;
          hit_count: number; last_hit_at: string;
          refresh_after: string; expires_at: string; created_at: string;
        },
        {
          cache_key: string; query: string; location_cell: string;
          lat: number; lng: number; result: Record<string, unknown>;
          hit_count?: number; last_hit_at?: string;
          refresh_after: string; expires_at: string; created_at?: string;
        },
        Partial<{
          query: string; result: Record<string, unknown>;
          hit_count: number; last_hit_at: string;
          refresh_after: string; expires_at: string;
        }>
      >;
    };
    Views:          { [_ in never]?: { Row: Record<string, unknown> } };
    Functions:      { [_ in never]?: { Args: Record<string, unknown>; Returns: unknown } };
    Enums:          { [_ in never]?: string };
    CompositeTypes: { [_ in never]?: { [key: string]: unknown } };
  };
}

// ── Client factory ────────────────────────────────────────────────────────────

let _client: SupabaseClient<Database> | null = null;

/**
 * Returns a lazy-initialized Supabase service-role client.
 * Returns null gracefully when SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY
 * are not configured (e.g. local dev without Supabase).
 */
export function getSupabase(): SupabaseClient<Database> | null {
  if (_client) return _client;
  const url  = import.meta.env.SUPABASE_URL;
  const key  = import.meta.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  _client = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _client;
}

// ── Training event helpers ────────────────────────────────────────────────────

/**
 * Encodes a lat/lng pair as a 0.1° grid cell string for aggregation.
 * e.g. lat=41.8781, lng=-87.6298  →  "418:-876"
 */
export function toLocationCell(lat: number, lng: number): string {
  return `${Math.round(lat * 10)}:${Math.round(lng * 10)}`;
}

/**
 * Logs a dispatch outcome to dispatch_training_events.
 * Non-fatal: failures are swallowed so they never interrupt the dispatch flow.
 */
export async function logTrainingEvent(event: DispatchTrainingEvent): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  // `as never` bypasses PostgREST-v12 Insert type inference until the generated
  // Database type is refreshed from the Supabase project schema.
  const { error } = await sb.from('dispatch_training_events').insert(event as never);
  if (error) console.error('[supabase] logTrainingEvent error', error.message);
}

/**
 * Logs a lead event for dashboard analytics.
 * Non-fatal: failures are swallowed.
 */
export async function logLeadEvent(event: LeadEvent): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  const { error } = await sb.from('lead_events').insert(event as never);
  if (error) console.error('[supabase] logLeadEvent error', error.message);
}
