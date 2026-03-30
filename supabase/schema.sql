-- ServiceSurfer Simple-SS — Database Schema
-- Apply with: supabase db push  (or paste into Supabase SQL editor)
-- ─────────────────────────────────────────────────────────────────────────────

-- Ensure pgcrypto is available for gen_random_uuid()
create extension if not exists pgcrypto;

-- Helper trigger function: keep updated_at current automatically
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ── Dispatch Training Events ──────────────────────────────────────────────────
--
-- Records the outcome of every business SMS dispatch for AI training.
-- Feed these rows into the smart-match model to improve:
--   - Which businesses accept leads in which categories
--   - Response-time distributions by supply level and time-of-day
--   - Queue-position acceptance rates (do #2 picks accept as often as #1?)

create table if not exists public.dispatch_training_events (
  id               uuid        primary key default gen_random_uuid(),
  dispatch_id      text        not null,
  business_phone   text        not null,
  service_label    text,
  -- Location encoded as a grid cell (lat/lng rounded to 0.1°)
  location_cell    text,
  supply_level     text        check (supply_level in ('high', 'normal', 'low')),
  -- Window that was given to this business in seconds (20 / 45 / 90)
  window_seconds   integer,
  -- Business reply outcome
  outcome          text        not null check (outcome in ('accepted', 'declined', 'timeout')),
  -- Time from SMS sent to reply (null for timeout)
  response_ms      integer,
  -- 0-indexed position in the dispatch queue
  queue_position   integer     not null default 0,
  -- Hour of day (0-23) and day of week (0=Sun) — set by application on insert for time analysis
  hour_of_day      smallint,
  day_of_week      smallint,
  created_at       timestamptz not null default now()
);

-- Ensure columns exist when re-applying to a database created from an older schema.
alter table if exists public.dispatch_training_events
  add column if not exists business_phone   text,
  add column if not exists hour_of_day      smallint,
  add column if not exists day_of_week      smallint;

create index if not exists idx_dte_dispatch_id   on public.dispatch_training_events(dispatch_id);
create index if not exists idx_dte_business       on public.dispatch_training_events(business_phone, created_at desc);
create index if not exists idx_dte_service_label  on public.dispatch_training_events(service_label, location_cell);
create index if not exists idx_dte_outcome        on public.dispatch_training_events(outcome, supply_level);

-- RLS: service-role writes; business owners read their own rows via JWT claim.
-- No anonymous access — training data is internal.
alter table public.dispatch_training_events enable row level security;
drop policy if exists dte_select_own on public.dispatch_training_events;
create policy dte_select_own
  on public.dispatch_training_events for select
  using (business_phone = (current_setting('request.jwt.claims', true)::jsonb ->> 'business_phone'));

-- ── Lead Events ───────────────────────────────────────────────────────────────
--
-- Tracks consumer touchpoints: searches, calls, video sessions, website clicks.
-- Used for dashboard analytics and per-business lead attribution.

create table if not exists public.lead_events (
  id             uuid        primary key default gen_random_uuid(),
  dispatch_id    text,
  business_phone text,
  event_type     text        not null check (event_type in (
    'search_match', 'call_initiated', 'call_connected', 'call_failed',
    'video_started', 'website_click', 'dispatch_sent', 'dispatch_accepted',
    'dispatch_declined', 'dispatch_timeout', 'review_sent', 'review_received',
    'claim_initiated', 'claim_verified'
  )),
  service_label  text,
  location_cell  text,
  consumer_phone text,
  meta           jsonb,
  created_at     timestamptz not null default now()
);

alter table if exists public.lead_events
  add column if not exists business_phone text,
  add column if not exists dispatch_id    text,
  add column if not exists service_label  text,
  add column if not exists location_cell  text,
  add column if not exists consumer_phone text,
  add column if not exists meta           jsonb;

create index if not exists idx_le_business_type  on public.lead_events(business_phone, event_type, created_at desc);
create index if not exists idx_le_dispatch        on public.lead_events(dispatch_id);
create index if not exists idx_le_created         on public.lead_events(created_at desc);

-- RLS: service-role writes; businesses read their own events.
alter table public.lead_events enable row level security;
drop policy if exists le_select_own on public.lead_events;
create policy le_select_own
  on public.lead_events for select
  using (business_phone = (current_setting('request.jwt.claims', true)::jsonb ->> 'business_phone'));

-- ── WebAuthn Passkeys ─────────────────────────────────────────────────────────
--
-- Stores registered passkey credentials for business owners.
-- Matches the schema used by the main ServiceSurfer platform for cross-app
-- compatibility (same table names, column types, and RLS policies).

create table if not exists public.user_passkeys (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  credential_id  text        not null unique,
  public_key     text        not null,
  counter        bigint      not null default 0,
  transports     text[]      not null default '{}'::text[],
  device_type    text,
  backed_up      boolean,
  friendly_name  text,
  last_used_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (user_id, credential_id)
);

create table if not exists public.passkey_challenges (
  id          uuid        primary key default gen_random_uuid(),
  user_id     uuid        not null references auth.users(id) on delete cascade,
  purpose     text        not null check (purpose in ('register', 'authenticate')),
  challenge   text        not null,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

create table if not exists public.passkey_auth_events (
  id             uuid        primary key default gen_random_uuid(),
  user_id        uuid        not null references auth.users(id) on delete cascade,
  credential_id  text        not null,
  verified_at    timestamptz not null default now(),
  created_at     timestamptz not null default now()
);

create index if not exists idx_user_passkeys_user           on public.user_passkeys(user_id);
create index if not exists idx_passkey_challenges_user      on public.passkey_challenges(user_id, purpose, created_at desc);
create index if not exists idx_passkey_challenges_expiry    on public.passkey_challenges(expires_at);
create index if not exists idx_passkey_auth_events_user     on public.passkey_auth_events(user_id, verified_at desc);

drop trigger if exists set_user_passkeys_updated_at on public.user_passkeys;
create trigger set_user_passkeys_updated_at
before update on public.user_passkeys
for each row execute procedure public.set_updated_at();

alter table public.user_passkeys        enable row level security;
alter table public.passkey_challenges   enable row level security;
alter table public.passkey_auth_events  enable row level security;

-- Users manage their own passkeys
drop policy if exists user_passkeys_select_own on public.user_passkeys;
create policy user_passkeys_select_own on public.user_passkeys for select using (auth.uid() = user_id);
drop policy if exists user_passkeys_insert_own on public.user_passkeys;
create policy user_passkeys_insert_own on public.user_passkeys for insert with check (auth.uid() = user_id);
drop policy if exists user_passkeys_update_own on public.user_passkeys;
create policy user_passkeys_update_own on public.user_passkeys for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists user_passkeys_delete_own on public.user_passkeys;
create policy user_passkeys_delete_own on public.user_passkeys for delete using (auth.uid() = user_id);

drop policy if exists passkey_challenges_select_own on public.passkey_challenges;
create policy passkey_challenges_select_own on public.passkey_challenges for select using (auth.uid() = user_id);
drop policy if exists passkey_challenges_insert_own on public.passkey_challenges;
create policy passkey_challenges_insert_own on public.passkey_challenges for insert with check (auth.uid() = user_id);
drop policy if exists passkey_challenges_delete_own on public.passkey_challenges;
create policy passkey_challenges_delete_own on public.passkey_challenges for delete using (auth.uid() = user_id);

drop policy if exists passkey_auth_events_select_own on public.passkey_auth_events;
create policy passkey_auth_events_select_own on public.passkey_auth_events for select using (auth.uid() = user_id);
drop policy if exists passkey_auth_events_insert_own on public.passkey_auth_events;
create policy passkey_auth_events_insert_own on public.passkey_auth_events for insert with check (auth.uid() = user_id);

-- ── Business Workspace Settings ───────────────────────────────────────────────
--
-- Stores per-business AI Workspace configuration: tone, answer length,
-- banned claims, required phrases, and knowledge URLs.

create table if not exists public.business_workspace_settings (
  id                  uuid        primary key default gen_random_uuid(),
  business_phone      text        not null unique,
  plan_slug           text        not null default 'free',
  tone                text        not null default 'friendly' check (tone in ('friendly', 'premium', 'direct')),
  answer_length       text        not null default 'balanced' check (answer_length in ('short', 'balanced', 'detailed')),
  banned_claims       text[]      not null default '{}'::text[],
  required_phrases    text[]      not null default '{}'::text[],
  collect_lead_details  boolean   not null default false,
  escalate_to_call    boolean     not null default true,
  escalate_to_video   boolean     not null default false,
  knowledge_urls      text[]      not null default '{}'::text[],
  starter_questions   text[]      not null default '{}'::text[],
  notes               text,
  available           boolean     not null default true,
  avg_job_value       integer     not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

alter table if exists public.business_workspace_settings
  add column if not exists business_phone      text,
  add column if not exists plan_slug           text        not null default 'free',
  add column if not exists tone                text        not null default 'friendly',
  add column if not exists answer_length       text        not null default 'balanced',
  add column if not exists banned_claims       text[]      not null default '{}'::text[],
  add column if not exists required_phrases    text[]      not null default '{}'::text[],
  add column if not exists collect_lead_details boolean    not null default false,
  add column if not exists escalate_to_call    boolean     not null default true,
  add column if not exists escalate_to_video   boolean     not null default false,
  add column if not exists knowledge_urls      text[]      not null default '{}'::text[],
  add column if not exists starter_questions   text[]      not null default '{}'::text[],
  add column if not exists notes               text,
  add column if not exists available           boolean     not null default true,
  add column if not exists avg_job_value       integer     not null default 0;

create index if not exists idx_bws_phone on public.business_workspace_settings(business_phone);

drop trigger if exists set_bws_updated_at on public.business_workspace_settings;
create trigger set_bws_updated_at
before update on public.business_workspace_settings
for each row execute procedure public.set_updated_at();

-- ── Business Dashboard Metrics (materialized cache) ───────────────────────────
--
-- Pre-aggregated 30-day rolling metrics for the business dashboard.
-- Refreshed whenever a new lead_event or dispatch_training_event is logged.

create table if not exists public.business_dashboard_metrics (
  business_phone      text        primary key,
  leads_30d           integer     not null default 0,
  calls_30d           integer     not null default 0,
  dispatches_30d      integer     not null default 0,
  accepted_30d        integer     not null default 0,
  declined_30d        integer     not null default 0,
  timeout_30d         integer     not null default 0,
  -- acceptance_rate = accepted_30d / nullif(dispatches_30d, 0)
  avg_response_ms     integer,
  top_service_labels  text[]      not null default '{}'::text[],
  updated_at          timestamptz not null default now()
);

alter table if exists public.business_dashboard_metrics
  add column if not exists leads_30d          integer not null default 0,
  add column if not exists calls_30d          integer not null default 0,
  add column if not exists dispatches_30d     integer not null default 0,
  add column if not exists accepted_30d       integer not null default 0,
  add column if not exists declined_30d       integer not null default 0,
  add column if not exists timeout_30d        integer not null default 0,
  add column if not exists avg_response_ms    integer,
  add column if not exists top_service_labels text[]  not null default '{}'::text[],
  add column if not exists updated_at         timestamptz not null default now();

-- RLS: businesses read only their own metrics row; service-role upserts freely.
alter table public.business_dashboard_metrics enable row level security;
drop policy if exists bdm_select_own on public.business_dashboard_metrics;
create policy bdm_select_own
  on public.business_dashboard_metrics for select
  using (business_phone = (current_setting('request.jwt.claims', true)::jsonb ->> 'business_phone'));

-- ── Utility: refresh dashboard metrics for a business ────────────────────────
--
-- Called via Supabase RPC from the dashboard endpoint when cached metrics
-- are stale.  Aggregates from lead_events + dispatch_training_events over
-- the last 30 days in a single server-side function call.

create or replace function public.refresh_dashboard_metrics(p_phone text)
returns void language plpgsql security definer as $$
declare
  v_since timestamptz := now() - interval '30 days';
  v_leads_30d       integer;
  v_calls_30d       integer;
  v_dispatches_30d  integer;
  v_accepted_30d    integer;
  v_declined_30d    integer;
  v_timeout_30d     integer;
  v_avg_response_ms integer;
  v_top_labels      text[];
begin
  select
    count(*) filter (where event_type = 'dispatch_sent'),
    count(*) filter (where event_type = 'call_initiated'),
    count(*) filter (where event_type = 'dispatch_sent'),
    count(*) filter (where event_type = 'dispatch_accepted'),
    count(*) filter (where event_type = 'dispatch_declined'),
    count(*) filter (where event_type = 'dispatch_timeout')
  into v_leads_30d, v_calls_30d, v_dispatches_30d, v_accepted_30d, v_declined_30d, v_timeout_30d
  from public.lead_events
  where business_phone = p_phone and created_at >= v_since;

  select round(avg(response_ms))
  into v_avg_response_ms
  from public.dispatch_training_events
  where business_phone = p_phone and outcome = 'accepted' and created_at >= v_since;

  select array_agg(service_label order by cnt desc)
  into v_top_labels
  from (
    select service_label, count(*) as cnt
    from public.lead_events
    where business_phone = p_phone and service_label is not null and created_at >= v_since
    group by service_label
    limit 5
  ) sub;

  insert into public.business_dashboard_metrics
    (business_phone, leads_30d, calls_30d, dispatches_30d, accepted_30d, declined_30d,
     timeout_30d, avg_response_ms, top_service_labels, updated_at)
  values
    (p_phone, coalesce(v_leads_30d,0), coalesce(v_calls_30d,0), coalesce(v_dispatches_30d,0),
     coalesce(v_accepted_30d,0), coalesce(v_declined_30d,0), coalesce(v_timeout_30d,0),
     v_avg_response_ms, coalesce(v_top_labels, '{}'), now())
  on conflict (business_phone) do update set
    leads_30d          = excluded.leads_30d,
    calls_30d          = excluded.calls_30d,
    dispatches_30d     = excluded.dispatches_30d,
    accepted_30d       = excluded.accepted_30d,
    declined_30d       = excluded.declined_30d,
    timeout_30d        = excluded.timeout_30d,
    avg_response_ms    = excluded.avg_response_ms,
    top_service_labels = excluded.top_service_labels,
    updated_at         = now();
end;
$$;


-- ── Search Result Cache ───────────────────────────────────────────────────────
--
-- L2 cache for Google Places + Cerebras search results.
-- Reduces Places API calls by serving cached results for up to 30 days.
-- Entries are refreshed transparently via stale-while-revalidate (7-day threshold).

create table if not exists public.search_result_cache (
  cache_key     text        primary key,
  query         text        not null,
  location_cell text        not null,
  lat           float8      not null,
  lng           float8      not null,
  result        jsonb       not null,
  hit_count     integer     not null default 1,
  last_hit_at   timestamptz not null default now(),
  refresh_after timestamptz not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);

create index if not exists idx_src_expires      on public.search_result_cache(expires_at);
create index if not exists idx_src_location     on public.search_result_cache(location_cell);
create index if not exists idx_src_refresh      on public.search_result_cache(refresh_after) where refresh_after < now();
create index if not exists idx_src_hot_stale    on public.search_result_cache(hit_count desc) where refresh_after < now() and expires_at > now();

-- Increment hit count atomically (used by search-cache.ts on every cache hit)
create or replace function public.increment_search_cache_hits(p_key text)
returns void language sql as $$
  update public.search_result_cache
  set hit_count   = hit_count + 1,
      last_hit_at = now()
  where cache_key = p_key;
$$;

-- RLS: this table is internal-only — no public access
alter table public.search_result_cache enable row level security;

drop policy if exists "service_role_only" on public.search_result_cache;
create policy "service_role_only" on public.search_result_cache
  using (auth.role() = 'service_role');

-- ── Migration: add available + avg_job_value to business_workspace_settings ───
-- (Run this if the columns don't exist yet — safe to run multiple times)
alter table public.business_workspace_settings
  add column if not exists available      boolean not null default true,
  add column if not exists avg_job_value  integer not null default 0;
