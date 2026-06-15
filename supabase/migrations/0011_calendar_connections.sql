-- ============================================================
-- KORA — external calendar connections (Google / Microsoft)
--   calendar_connections: per-user OAuth tokens. RLS is ENABLED with NO
--     policies on purpose — the anon/authenticated client can never read
--     these rows, so access/refresh tokens never leave the server. Only the
--     `calendar` Edge Function (service-role) reads/writes them. The client
--     learns which calendars are connected via that function (action=list).
--   oauth_states: short-lived CSRF nonce for the OAuth handshake.
-- ============================================================

create table if not exists public.calendar_connections (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  provider      text not null check (provider in ('google','microsoft')),
  account_email text not null default '',
  access_token  text not null,
  refresh_token text,
  expires_at    timestamptz,
  scope         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (user_id, provider)
);
alter table public.calendar_connections enable row level security;
-- intentionally NO policies: service-role only.

create table if not exists public.oauth_states (
  state      text primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  provider   text not null,
  created_at timestamptz not null default now()
);
alter table public.oauth_states enable row level security;
-- intentionally NO policies: service-role only.
