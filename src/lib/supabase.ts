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

export interface Database {
  public: {
    Tables: {
      dispatch_training_events: {
        Row:    DispatchTrainingEvent & { id: string; created_at: string };
        Insert: DispatchTrainingEvent;
        Update: Partial<DispatchTrainingEvent>;
      };
      lead_events: {
        Row:    LeadEvent & { id: string; created_at: string };
        Insert: LeadEvent;
        Update: Partial<LeadEvent>;
      };
      user_passkeys: {
        Row:    UserPasskey & { id: string; created_at: string; updated_at: string };
        Insert: UserPasskey;
        Update: Partial<UserPasskey>;
      };
      passkey_challenges: {
        Row:    PasskeyChallenge & { id: string; created_at: string };
        Insert: PasskeyChallenge;
        Update: Partial<PasskeyChallenge>;
      };
      business_workspace_settings: {
        Row:    BusinessWorkspaceSettings & { id: string; created_at: string; updated_at: string };
        Insert: BusinessWorkspaceSettings;
        Update: Partial<BusinessWorkspaceSettings>;
      };
      business_dashboard_metrics: {
        Row:    BusinessDashboardMetrics;
        Insert: BusinessDashboardMetrics;
        Update: Partial<BusinessDashboardMetrics>;
      };
    };
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
  await sb.from('dispatch_training_events').insert(event).then(({ error }) => {
    if (error) console.error('[supabase] logTrainingEvent error', error.message);
  });
}

/**
 * Logs a lead event for dashboard analytics.
 * Non-fatal: failures are swallowed.
 */
export async function logLeadEvent(event: LeadEvent): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;
  await sb.from('lead_events').insert(event).then(({ error }) => {
    if (error) console.error('[supabase] logLeadEvent error', error.message);
  });
}
