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
  -- Hour of day (0-23) for time-of-day analysis
  hour_of_day      smallint    generated always as (extract(hour from created_at)::smallint) stored,
  -- Day of week (0=Sun … 6=Sat)
  day_of_week      smallint    generated always as (extract(dow from created_at)::smallint) stored,
  created_at       timestamptz not null default now()
);

create index if not exists idx_dte_dispatch_id   on public.dispatch_training_events(dispatch_id);
create index if not exists idx_dte_business       on public.dispatch_training_events(business_phone, created_at desc);
create index if not exists idx_dte_service_label  on public.dispatch_training_events(service_label, location_cell);
create index if not exists idx_dte_outcome        on public.dispatch_training_events(outcome, supply_level);

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

create index if not exists idx_le_business_type  on public.lead_events(business_phone, event_type, created_at desc);
create index if not exists idx_le_dispatch        on public.lead_events(dispatch_id);
create index if not exists idx_le_created         on public.lead_events(created_at desc);

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
create policy if not exists user_passkeys_select_own on public.user_passkeys for select using (auth.uid() = user_id);
create policy if not exists user_passkeys_insert_own on public.user_passkeys for insert with check (auth.uid() = user_id);
create policy if not exists user_passkeys_update_own on public.user_passkeys for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy if not exists user_passkeys_delete_own on public.user_passkeys for delete using (auth.uid() = user_id);

create policy if not exists passkey_challenges_select_own on public.passkey_challenges for select using (auth.uid() = user_id);
create policy if not exists passkey_challenges_insert_own on public.passkey_challenges for insert with check (auth.uid() = user_id);
create policy if not exists passkey_challenges_delete_own on public.passkey_challenges for delete using (auth.uid() = user_id);

create policy if not exists passkey_auth_events_select_own on public.passkey_auth_events for select using (auth.uid() = user_id);
create policy if not exists passkey_auth_events_insert_own on public.passkey_auth_events for insert with check (auth.uid() = user_id);

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
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

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
