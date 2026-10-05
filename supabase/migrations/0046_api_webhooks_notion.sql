-- ============================================================
-- KANBO — public API keys, signed webhooks and Notion (2026-10-05).
-- Additive: nothing existing changes shape or behaviour for the app.
--
--   1. tasks.updated_at: stamped by the server on every real change (a no-op
--      update keeps it; clients can't set it). The API's updated_since filter
--      and the Notion sync read it. Existing tasks read as the time this file
--      first ran (adding the column rewrites nothing and fires no triggers).
--   2. API keys (api_keys): the key is generated HERE, returned once by
--      create_api_key() and stored only as its SHA-256. kanbo_sk_… = read &
--      write, kanbo_pk_… = read-only (both are secrets). A personal key acts
--      as its creator everywhere they can act; a workspace key (owners/admins
--      only) acts as its creator but only inside its workspace, and stops
--      working if the creator stops being an owner/admin there. Clients read
--      their own rows (never key_hash); verify_api_key() is service-only.
--      Suspended / unapproved people's keys stop working at once.
--   3. API key scope (restrictive RLS "api key scope"): the api function sets
--      kanbo.api_workspace for a workspace key's transaction, and every team
--      content table then refuses rows from any other workspace (and personal
--      rows). Unset (the app, realtime, every other function) it allows
--      everything, so the app is unaffected. It can only ever narrow access.
--   4. Rate limits + idempotency for the API: api_rate_hit() on 0042's
--      rate_limits; api_idempotency stores Idempotency-Key replays for 24h.
--   5. Webhooks: webhooks (signing secret service-only), webhook_outbox
--      (AFTER triggers on tasks, comments, projects, workspace_members — they
--      cost one indexed EXISTS when nobody listens), webhook_deliveries
--      (retries 1m, 5m, 30m, 2h, 6h; off after 20 failures in a row with an
--      Inbox notice to the creator; claims share sending slots fairly per
--      endpoint, person and workspace). Management only through definer
--      functions: workspace writers, or the person for personal webhooks;
--      the URL in full only for those who manage it (masked for the rest);
--      "send again" 10 a minute per endpoint, never for test pings.
--   6. Notion: workspace_integrations.notion_token (service-only, like the
--      Slack URL), notion_status / notion_connect / notion_disconnect (owners
--      and admins manage; members see status), notion_syncs, notion_links,
--      notion_page_cache (members read; writes via functions / service role).
--
-- Needs 0042 (works with or without 0043; creates workspace_integrations if
-- it's missing, with 0043's shape). Idempotent: safe to run more than once
-- (re-running keeps every key, webhook, delivery, token, sync and link).
-- If 0041 or 0042 is ever run again (they drop and recreate every policy on
-- the content tables), run this file again straight afterwards so the
-- "api key scope" policies come back.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0046 needs 0042 first: run 0042_rollout_hardening.sql, then this file';
  end if;
end $pre$;

-- pgcrypto's gen_random_bytes (on Supabase it is already in "extensions");
-- without it, kanbo_random_token() falls back to gen_random_uuid() bytes
do $ext$
begin
  create extension if not exists pgcrypto with schema extensions;
exception when others then
  raise notice 'pgcrypto unavailable (%): tokens use gen_random_uuid() instead', sqlerrm;
end $ext$;

-- n random bytes as base64url without padding (32 bytes -> 43 characters)
create or replace function public.kanbo_random_token(p_bytes integer default 32)
returns text language plpgsql volatile set search_path = pg_catalog, extensions, public as $$
declare b bytea;
begin
  begin
    b := gen_random_bytes(p_bytes);
  exception when undefined_function then
    b := ''::bytea;
    while length(b) < p_bytes loop
      b := b || decode(replace(gen_random_uuid()::text, '-', ''), 'hex');
    end loop;
    b := substring(b from 1 for p_bytes);
  end;
  return translate(encode(b, 'base64'), E'+/=\n', '-_');
end; $$;
revoke execute on function public.kanbo_random_token(integer) from public, anon, authenticated;

-- the stored form of an API key: hex SHA-256 of the whole key
create or replace function public.api_key_digest(p_key text)
returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(coalesce(p_key, ''), 'UTF8')), 'hex');
$$;
revoke execute on function public.api_key_digest(text) from public, anon, authenticated;

-- may this person act at all? (can_act() for someone other than the caller;
-- same rule as tasks_visible_to: suspended or not-yet-approved = no)
create or replace function public.user_can_act(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_user is not null
     and exists (select 1 from auth.users u where u.id = p_user)
     and not exists (select 1 from public.profiles p
                      where p.id = p_user and (coalesce(p.suspended, false) or not coalesce(p.approved, true)));
$$;
revoke execute on function public.user_can_act(uuid) from public, anon, authenticated;

-- ws_role() for someone other than the caller ('none' when they can't act)
create or replace function public.user_ws_role(p_user uuid, p_ws uuid)
returns text language sql security definer stable set search_path = public as $$
  select case when not public.user_can_act(p_user) or p_ws is null then 'none' else coalesce(
    (select m.role from public.workspace_members m
      where m.workspace_id = p_ws and m.user_id = p_user and m.status = 'active' limit 1),
    (select 'owner' from public.workspaces w where w.id = p_ws and w.owner_id = p_user),
    'none') end;
$$;
revoke execute on function public.user_ws_role(uuid, uuid) from public, anon, authenticated;

-- a person's display name (profile name, else email, else 'Someone')
create or replace function public.kanbo_person_name(p_user uuid)
returns text language sql security definer stable set search_path = public as $$
  select coalesce((select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email)
                     from auth.users u left join public.profiles p on p.id = u.id where u.id = p_user), 'Someone');
$$;
revoke execute on function public.kanbo_person_name(uuid) from public, anon, authenticated;

-- ---------- 1. tasks.updated_at ----------
alter table public.tasks add column if not exists updated_at timestamptz not null default now();
create index if not exists tasks_updated_at_idx on public.tasks (updated_at, id);

create or replace function public.tasks_touch_updated_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;            -- nobody sets it by hand
    if new is distinct from old then new.updated_at := now(); end if;
  end if;
  return new;
end; $$;
revoke execute on function public.tasks_touch_updated_at() from public, anon, authenticated;
drop trigger if exists trg_tasks_touch_updated_at on public.tasks;
create trigger trg_tasks_touch_updated_at before insert or update on public.tasks
  for each row execute function public.tasks_touch_updated_at();

-- ---------- 2. API keys ----------
create table if not exists public.api_keys (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  name         text not null,
  prefix       text not null,
  key_hash     text not null,
  access       text not null default 'read',
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz,
  revoked_at   timestamptz
);
create unique index if not exists api_keys_key_hash_key on public.api_keys (key_hash);
create index if not exists api_keys_user_idx on public.api_keys (user_id);
create index if not exists api_keys_workspace_idx on public.api_keys (workspace_id) where workspace_id is not null;
alter table public.api_keys drop constraint if exists api_keys_shape;
alter table public.api_keys add constraint api_keys_shape check (
  access in ('read', 'write')
  and length(btrim(name)) between 1 and 80
  and prefix ~ '^kanbo_(sk|pk)_[A-Za-z0-9_-]{4}$'
  and key_hash ~ '^[0-9a-f]{64}$');

-- clients: read their own rows, every column except key_hash; no writes
alter table public.api_keys enable row level security;
revoke all on public.api_keys from anon, authenticated;
grant select (id, user_id, workspace_id, name, prefix, access, created_at, last_used_at, expires_at, revoked_at)
  on public.api_keys to authenticated;
do $ak$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'api_keys' loop
    execute format('drop policy %I on public.api_keys', pol.policyname);
  end loop;
end $ak$;
create policy "api keys: own rows, read only" on public.api_keys
  for select to authenticated using (user_id = auth.uid());

create or replace function public.api_key_json(k public.api_keys)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', k.id, 'name', k.name, 'prefix', k.prefix, 'access', k.access,
    'workspace_id', k.workspace_id,
    'workspace_name', (select w.name from public.workspaces w where w.id = k.workspace_id),
    'user_id', k.user_id,
    'created_by_name', public.kanbo_person_name(k.user_id),
    'created_at', k.created_at, 'last_used_at', k.last_used_at,
    'expires_at', k.expires_at, 'revoked_at', k.revoked_at,
    'status', case when k.revoked_at is not null then 'revoked'
                   when k.expires_at is not null and k.expires_at <= now() then 'expired'
                   else 'active' end,
    'can_revoke', k.revoked_at is null and auth.uid() is not null
                  and (k.user_id = auth.uid()
                       or (k.workspace_id is not null and public.ws_role(k.workspace_id) in ('owner', 'admin'))));
$$;
revoke execute on function public.api_key_json(public.api_keys) from public, anon, authenticated;

-- Make a key. Returns the key's row as JSON plus "key": the full key, which
-- is never stored and can't be shown again. p_workspace null = personal key.
create or replace function public.create_api_key(p_name text, p_workspace uuid default null,
                                                 p_access text default 'read', p_expires_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  nm    text := btrim(coalesce(p_name, ''));
  acc   text := lower(btrim(coalesce(p_access, 'read')));
  plain text;
  rec   public.api_keys;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if length(nm) < 1 or length(nm) > 80 then raise exception 'invalid name'; end if;
  if acc not in ('read', 'write') then raise exception 'invalid access'; end if;
  if p_expires_at is not null and (p_expires_at < now() + interval '1 hour' or p_expires_at > now() + interval '5 years') then
    raise exception 'invalid expiry';
  end if;
  if p_workspace is not null and public.ws_role(p_workspace) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  perform pg_advisory_xact_lock(hashtext('kanbo:api_keys:' || me::text));
  if (select count(*) from public.api_keys a
       where a.user_id = me and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())) >= 25 then
    raise exception 'too many keys';
  end if;
  if p_workspace is not null and (select count(*) from public.api_keys a
       where a.workspace_id = p_workspace and a.revoked_at is null and (a.expires_at is null or a.expires_at > now())) >= 50 then
    raise exception 'too many keys';
  end if;
  plain := case acc when 'write' then 'kanbo_sk_' else 'kanbo_pk_' end || public.kanbo_random_token(32);
  insert into public.api_keys (user_id, workspace_id, name, prefix, key_hash, access, expires_at)
  values (me, p_workspace, nm, left(plain, 13), public.api_key_digest(plain), acc, p_expires_at)
  returning * into rec;
  return public.api_key_json(rec) || jsonb_build_object('key', plain);
end; $$;

-- Your keys (personal and the workspace keys you made), newest first; with
-- p_workspace, every key in that workspace (owners/admins only). Revoked
-- keys stay listed for 30 days.
create or replace function public.list_api_keys(p_workspace uuid default null)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_workspace is not null and public.ws_role(p_workspace) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  return coalesce((
    select jsonb_agg(public.api_key_json(k) order by k.created_at desc, k.id)
      from public.api_keys k
     where (case when p_workspace is null then k.user_id = me else k.workspace_id = p_workspace end)
       and (k.revoked_at is null or k.revoked_at > now() - interval '30 days')), '[]'::jsonb);
end; $$;

-- Revoke: your own key, or any key of a workspace you own/administer.
create or replace function public.revoke_api_key(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k public.api_keys;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into k from public.api_keys where id = p_id for update;
  if k.id is null or not (k.user_id = auth.uid()
                          or (k.workspace_id is not null and public.ws_role(k.workspace_id) in ('owner', 'admin'))) then
    raise exception 'key not found';              -- same answer whether it's gone or not yours
  end if;
  update public.api_keys set revoked_at = coalesce(revoked_at, now()) where id = p_id returning * into k;
  return public.api_key_json(k);
end; $$;

-- SERVICE ROLE ONLY (the api edge function): who is this key? No row when
-- the key is malformed, unknown, revoked, expired, its kind doesn't match its
-- access, its owner can't act (suspended / not approved), or it's a workspace
-- key whose creator is no longer an owner/admin there. Stamps last_used_at
-- (at most once a minute).
create or replace function public.verify_api_key(p_key text)
returns table (key_id uuid, user_id uuid, workspace_id uuid, access text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare k public.api_keys; want text;
begin
  if p_key is null or p_key !~ '^kanbo_(sk|pk)_[A-Za-z0-9_-]{43}$' then return; end if;
  select a.* into k from public.api_keys a where a.key_hash = public.api_key_digest(p_key);
  if k.id is null or k.revoked_at is not null or (k.expires_at is not null and k.expires_at <= now()) then return; end if;
  want := case k.access when 'write' then 'kanbo_sk_' else 'kanbo_pk_' end;
  if left(p_key, 9) <> want then return; end if;
  if not public.user_can_act(k.user_id) then return; end if;
  if k.workspace_id is not null and public.user_ws_role(k.user_id, k.workspace_id) not in ('owner', 'admin') then return; end if;
  if k.last_used_at is null or k.last_used_at < now() - interval '1 minute' then
    update public.api_keys a set last_used_at = now() where a.id = k.id;
  end if;
  key_id := k.id; user_id := k.user_id; workspace_id := k.workspace_id; access := k.access;
  return next;
end; $$;

revoke execute on function public.create_api_key(text, uuid, text, timestamptz) from public, anon;
revoke execute on function public.list_api_keys(uuid) from public, anon;
revoke execute on function public.revoke_api_key(uuid) from public, anon;
grant execute on function public.create_api_key(text, uuid, text, timestamptz) to authenticated;
grant execute on function public.list_api_keys(uuid) to authenticated;
grant execute on function public.revoke_api_key(uuid) to authenticated;
revoke execute on function public.verify_api_key(text) from public, anon, authenticated;

-- ---------- 3. API key scope: a workspace key sees only its workspace ----------
-- true unless the transaction set kanbo.api_workspace (the api function does,
-- for workspace keys); then only that workspace's rows. Never widens access.
create or replace function public.api_scope_ok(p_ws uuid)
returns boolean language sql stable set search_path = public as $$
  select case when coalesce(current_setting('kanbo.api_workspace', true), '') = '' then true
              else p_ws is not null and p_ws = nullif(current_setting('kanbo.api_workspace', true), '')::uuid end;
$$;
-- the same through a row's task (comments, dependencies, checklist items, history)
create or replace function public.api_scope_ok_task(p_task uuid)
returns boolean language sql stable set search_path = public as $$
  select case when coalesce(current_setting('kanbo.api_workspace', true), '') = '' then true
              else exists (select 1 from public.tasks t
                            where t.id = p_task and t.workspace_id = nullif(current_setting('kanbo.api_workspace', true), '')::uuid) end;
$$;
grant execute on function public.api_scope_ok(uuid) to public;
grant execute on function public.api_scope_ok_task(uuid) to public;

do $scope$
declare t text;
begin
  foreach t in array array['tasks','projects','sections','tags','custom_field_defs','goals','portfolios',
                           'status_updates','automation_rules','forms','workspace_members'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "api key scope" on public.%I', t);
      execute format('create policy "api key scope" on public.%I as restrictive for all using (public.api_scope_ok(workspace_id)) with check (public.api_scope_ok(workspace_id))', t);
    end if;
  end loop;
  foreach t in array array['comments','task_dependencies','subtasks','task_events'] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists "api key scope" on public.%I', t);
      execute format('create policy "api key scope" on public.%I as restrictive for all using (public.api_scope_ok_task(task_id)) with check (public.api_scope_ok_task(task_id))', t);
    end if;
  end loop;
  drop policy if exists "api key scope" on public.workspaces;
  create policy "api key scope" on public.workspaces as restrictive for all
    using (public.api_scope_ok(id)) with check (public.api_scope_ok(id));
end $scope$;

-- ---------- 4. API rate limits + idempotency (service role only) ----------
-- One hit on a fixed window (0042's rate_limits; use keys 'kanbo:api:<key id>').
create or replace function public.api_rate_hit(p_key text, p_window_sec integer default 60, p_max integer default 120)
returns table (allowed boolean, remaining integer, retry_after integer)
language plpgsql security definer set search_path = public as $$
declare
  win interval := make_interval(secs => greatest(1, coalesce(p_window_sec, 60)));
  mx  integer := greatest(1, coalesce(p_max, 120));
  r   record;
begin
  if coalesce(p_key, '') = '' or length(p_key) > 200 then raise exception 'invalid key'; end if;
  insert into public.rate_limits as rl (key, last_at, count) values (p_key, now(), 1)
  on conflict (key) do update set
    last_at = case when rl.last_at <= now() - win then now() else rl.last_at end,
    count   = case when rl.last_at <= now() - win then 1 else rl.count + 1 end
  returning rl.last_at, rl.count into r;
  allowed := r.count <= mx;
  remaining := greatest(0, mx - r.count);
  retry_after := case when r.count <= mx then 0
                      else greatest(1, ceil(extract(epoch from (r.last_at + win - now())))::integer) end;
  return next;
end; $$;
revoke execute on function public.api_rate_hit(text, integer, integer) from public, anon, authenticated;

create table if not exists public.api_idempotency (
  key_id       uuid not null references public.api_keys (id) on delete cascade,
  idem_key     text not null,
  request_hash text,
  status       integer not null default 0,     -- 0 = still running
  response     jsonb,
  created_at   timestamptz not null default now(),
  primary key (key_id, idem_key)
);
create index if not exists api_idempotency_created_idx on public.api_idempotency (created_at);
alter table public.api_idempotency drop constraint if exists api_idempotency_shape;
alter table public.api_idempotency add constraint api_idempotency_shape check (
  length(idem_key) between 1 and 255 and status between 0 and 599
  and (request_hash is null or length(request_hash) <= 128));
alter table public.api_idempotency enable row level security;
revoke all on public.api_idempotency from anon, authenticated;

-- Start a POST with an Idempotency-Key. Returns {state}:
--   'new'         go ahead (a placeholder now holds the key)
--   'replay'      done before with the same request: {status, response}
--   'mismatch'    the key was used for a different request (answer 422)
--   'in_progress' the first request is still running (answer 409)
-- Older than 24h counts as never seen; a placeholder older than 2 minutes
-- (a crashed request) is taken over.
create or replace function public.api_idempotency_begin(p_key_id uuid, p_idem_key text, p_request_hash text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.api_idempotency;
begin
  if p_key_id is null or coalesce(length(p_idem_key), 0) not between 1 and 255 then raise exception 'invalid idempotency key'; end if;
  delete from public.api_idempotency i
   where i.key_id = p_key_id and i.idem_key = p_idem_key
     and (i.created_at < now() - interval '24 hours' or (i.status = 0 and i.created_at < now() - interval '2 minutes'));
  insert into public.api_idempotency (key_id, idem_key, request_hash)
  values (p_key_id, p_idem_key, p_request_hash)
  on conflict (key_id, idem_key) do nothing
  returning * into r;
  if r.key_id is not null then return jsonb_build_object('state', 'new'); end if;
  select * into r from public.api_idempotency i where i.key_id = p_key_id and i.idem_key = p_idem_key;
  if r.request_hash is distinct from p_request_hash then return jsonb_build_object('state', 'mismatch'); end if;
  if r.status = 0 then return jsonb_build_object('state', 'in_progress'); end if;
  return jsonb_build_object('state', 'replay', 'status', r.status, 'response', r.response);
end; $$;

-- Finish it: keep the answer for replays (a 5xx forgets the key, so the
-- caller may simply retry).
create or replace function public.api_idempotency_finish(p_key_id uuid, p_idem_key text, p_status integer, p_response jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if coalesce(p_status, 500) >= 500 then
    delete from public.api_idempotency where key_id = p_key_id and idem_key = p_idem_key;
  else
    update public.api_idempotency set status = p_status, response = p_response
     where key_id = p_key_id and idem_key = p_idem_key;
  end if;
end; $$;
revoke execute on function public.api_idempotency_begin(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.api_idempotency_finish(uuid, text, integer, jsonb) from public, anon, authenticated;

-- ---------- 5. webhooks ----------
-- an https URL with a hostname (no IP literals, no user:password@, no
-- internal names). The dispatcher re-checks after DNS (no private, loopback
-- or link-local addresses; no redirects).
create or replace function public.webhook_url_ok(p_url text)
returns boolean language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; host text;
begin
  if p_url is null or length(p_url) > 2000 or p_url ~ '[\s\\<>"]' then return false; end if;
  m := regexp_match(p_url, '^https://([^/?#]+)([/?][^#]*)?$');
  if m is null or m[1] ~ '@' then return false; end if;
  host := lower(regexp_replace(m[1], ':[0-9]{1,5}$', ''));
  if host !~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$' then return false; end if;
  if host ~ '^[0-9.]+$' or host ~ '^0x' then return false; end if;
  if host ~ '(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|invalid|example|onion|arpa)$' then
    return false;
  end if;
  return true;
end; $$;
grant execute on function public.webhook_url_ok(text) to public;

-- the events a webhook can subscribe to ('ping' is only ever a test)
create or replace function public.webhook_event_names()
returns text[] language sql immutable as $$
  select array['task.created','task.updated','task.completed','task.deleted',
               'comment.created','project.created','project.updated','member.joined']::text[];
$$;
grant execute on function public.webhook_event_names() to public;

create table if not exists public.webhooks (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid references public.workspaces (id) on delete cascade,   -- null = personal
  created_by       uuid not null references auth.users (id) on delete cascade, -- personal: the owner
  url              text not null,
  description      text,
  events           text[] not null,
  secret           text not null,
  active           boolean not null default true,
  failure_count    integer not null default 0,
  last_status      integer,
  last_error       text,
  last_delivery_at timestamptz,
  disabled_at      timestamptz,
  disabled_reason  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists webhooks_active_ws_idx on public.webhooks (workspace_id) where active;
create index if not exists webhooks_active_personal_idx on public.webhooks (created_by) where active and workspace_id is null;
alter table public.webhooks drop constraint if exists webhooks_shape;
alter table public.webhooks add constraint webhooks_shape check (
  public.webhook_url_ok(url)
  and cardinality(events) between 1 and 8 and events <@ public.webhook_event_names()
  and secret ~ '^whsec_[A-Za-z0-9_-]{43}$'
  and (description is null or length(description) <= 200)
  and (last_error is null or length(last_error) <= 500)
  and (disabled_reason is null or length(disabled_reason) <= 200)
  and failure_count >= 0);
alter table public.webhooks enable row level security;
revoke all on public.webhooks from anon, authenticated;

create table if not exists public.webhook_outbox (
  id           bigint generated by default as identity primary key,
  workspace_id uuid,                -- team rows (no FK: a workspace being deleted still cascades cleanly)
  user_id      uuid,                -- personal rows: whose
  webhook_id   uuid references public.webhooks (id) on delete cascade,   -- only for test pings
  event        text not null,
  resource_id  text,
  payload      jsonb not null,      -- raw rows; serialised to the API shape when delivered
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index if not exists webhook_outbox_pending_idx on public.webhook_outbox (id) where processed_at is null;
create index if not exists webhook_outbox_created_idx on public.webhook_outbox (created_at);
alter table public.webhook_outbox enable row level security;
revoke all on public.webhook_outbox from anon, authenticated;

create table if not exists public.webhook_deliveries (
  id              uuid primary key default gen_random_uuid(),
  webhook_id      uuid not null references public.webhooks (id) on delete cascade,
  outbox_id       bigint not null references public.webhook_outbox (id) on delete cascade,
  event           text not null,
  state           text not null default 'pending',   -- pending | delivered | failed (gave up)
  attempt         integer not null default 0,         -- attempts made (claiming counts one)
  status_code     integer,
  error           text,
  duration_ms     integer,
  next_attempt_at timestamptz default now(),
  lease_until     timestamptz,
  delivered_at    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (webhook_id, outbox_id)
);
create index if not exists webhook_deliveries_due_idx on public.webhook_deliveries (next_attempt_at) where state = 'pending';
create index if not exists webhook_deliveries_hook_idx on public.webhook_deliveries (webhook_id, created_at desc);
-- fair claims: each endpoint's oldest due deliveries, and what's being sent right now
create index if not exists webhook_deliveries_hook_due_idx on public.webhook_deliveries (webhook_id, next_attempt_at, id) where state = 'pending';
create index if not exists webhook_deliveries_leased_idx on public.webhook_deliveries (lease_until) where state = 'pending' and lease_until is not null;
alter table public.webhook_deliveries drop constraint if exists webhook_deliveries_shape;
alter table public.webhook_deliveries add constraint webhook_deliveries_shape check (
  state in ('pending', 'delivered', 'failed') and attempt >= 0
  and (error is null or length(error) <= 500));
alter table public.webhook_deliveries enable row level security;
revoke all on public.webhook_deliveries from anon, authenticated;

-- one row: when the dispatcher was last poked (keeps pokes to one per few seconds)
create table if not exists public.webhook_dispatch_state (
  id           integer primary key default 1 check (id = 1),
  last_poke_at timestamptz not null default 'epoch'
);
insert into public.webhook_dispatch_state (id) values (1) on conflict (id) do nothing;
alter table public.webhook_dispatch_state enable row level security;
revoke all on public.webhook_dispatch_state from anon, authenticated;

do $wh$
declare t text; pol record;
begin
  foreach t in array array['webhooks','webhook_outbox','webhook_deliveries','webhook_dispatch_state','api_idempotency'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $wh$;

-- who may see / change a webhook
create or replace function public.webhook_can_see(w public.webhooks)
returns boolean language sql security definer stable set search_path = public as $$
  select auth.uid() is not null and (
    (w.workspace_id is null and w.created_by = auth.uid() and public.can_act())
    or (w.workspace_id is not null and public.can_write(w.workspace_id)));
$$;
create or replace function public.webhook_can_manage(w public.webhooks)
returns boolean language sql security definer stable set search_path = public as $$
  select auth.uid() is not null and (
    (w.workspace_id is null and w.created_by = auth.uid() and public.can_act())
    or (w.workspace_id is not null and (
          (w.created_by = auth.uid() and public.can_write(w.workspace_id))
          or public.ws_role(w.workspace_id) in ('owner', 'admin'))));
$$;
revoke execute on function public.webhook_can_see(public.webhooks) from public, anon, authenticated;
revoke execute on function public.webhook_can_manage(public.webhooks) from public, anon, authenticated;

-- An endpoint's address for people who can't manage it: scheme + host, then
-- "…" and the path's last 4 characters (https://hooks.zapier.com/…x2kd).
-- Catch-hook URLs (Zapier, Make…) are often the only credential the receiver
-- checks, so the full address is for the people who manage the endpoint,
-- like the Slack incoming-webhook URL in 0043. Same rule as maskWebhookUrl().
create or replace function public.webhook_url_masked(p_url text)
returns text language plpgsql immutable set search_path = pg_catalog as $$
declare m text[]; rest text;
begin
  m := regexp_match(coalesce(p_url, ''), '^https://([^/?#]+)([/?][^#]*)?$');
  if m is null then return 'https://…'; end if;
  rest := rtrim(coalesce(m[2], ''), '/');
  if rest = '' then return 'https://' || m[1] || '/'; end if;           -- nothing past the host to hide
  if length(rest) <= 8 then return 'https://' || m[1] || '/…'; end if;  -- too short to show any of it
  return 'https://' || m[1] || '/…' || right(rest, 4);
end; $$;
revoke execute on function public.webhook_url_masked(text) from public, anon, authenticated;

-- a webhook as JSON (never the secret; the full URL only for people who can manage it)
create or replace function public.webhook_json(w public.webhooks)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', w.id, 'workspace_id', w.workspace_id,
    'url', case when c.manage then w.url else public.webhook_url_masked(w.url) end,
    'description', w.description,
    'events', to_jsonb(w.events), 'active', w.active,
    'created_by', w.created_by, 'created_by_name', public.kanbo_person_name(w.created_by),
    'failure_count', w.failure_count, 'last_status', w.last_status, 'last_error', w.last_error,
    'last_delivery_at', w.last_delivery_at, 'disabled_at', w.disabled_at, 'disabled_reason', w.disabled_reason,
    'created_at', w.created_at, 'updated_at', w.updated_at,
    'can_manage', c.manage)
    from (select coalesce(public.webhook_can_manage(w), false) as manage) c;
$$;
revoke execute on function public.webhook_json(public.webhooks) from public, anon, authenticated;

-- the requested events, checked: known names only, each once, sorted
create or replace function public.webhook_events_checked(p_events text[])
returns text[] language plpgsql immutable set search_path = public as $$
declare clean text[];
begin
  select coalesce(array_agg(distinct e order by e), '{}') into clean
    from unnest(coalesce(p_events, '{}')) e where e is not null;
  if cardinality(clean) = 0 or not clean <@ public.webhook_event_names() then
    raise exception 'invalid events';
  end if;
  return clean;
end; $$;
revoke execute on function public.webhook_events_checked(text[]) from public, anon, authenticated;

-- Add an endpoint: workspace writers (never guests) for a team workspace,
-- anyone for their own personal tasks. Returns the webhook plus "secret"
-- (whsec_…), shown once; rotate_webhook_secret() replaces it.
create or replace function public.create_webhook(p_workspace uuid, p_url text, p_events text[], p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  u    text := btrim(coalesce(p_url, ''));
  evs  text[];
  d    text := nullif(btrim(coalesce(p_description, '')), '');
  sec  text := 'whsec_' || public.kanbo_random_token(32);
  rec  public.webhooks;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_workspace is not null and not public.can_write(p_workspace) then raise exception 'not allowed'; end if;
  if not public.webhook_url_ok(u) then raise exception 'invalid url'; end if;
  evs := public.webhook_events_checked(p_events);
  if d is not null and length(d) > 200 then raise exception 'invalid description'; end if;
  perform pg_advisory_xact_lock(hashtext('kanbo:webhooks:' || coalesce(p_workspace, me)::text));
  if p_workspace is not null and (select count(*) from public.webhooks w where w.workspace_id = p_workspace) >= 20 then
    raise exception 'too many webhooks';
  end if;
  if p_workspace is null and (select count(*) from public.webhooks w where w.workspace_id is null and w.created_by = me) >= 10 then
    raise exception 'too many webhooks';
  end if;
  insert into public.webhooks (workspace_id, created_by, url, description, events, secret)
  values (p_workspace, me, u, d, evs, sec)
  returning * into rec;
  return public.webhook_json(rec) || jsonb_build_object('secret', sec);
end; $$;

-- p_workspace null: your personal webhooks; else the workspace's (writers).
create or replace function public.list_webhooks(p_workspace uuid default null)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_workspace is not null and not public.can_write(p_workspace) then raise exception 'not allowed'; end if;
  return coalesce((
    select jsonb_agg(public.webhook_json(w) order by w.created_at, w.id)
      from public.webhooks w
     where (case when p_workspace is null then w.workspace_id is null and w.created_by = me
                 else w.workspace_id = p_workspace end)), '[]'::jsonb);
end; $$;

-- Change URL / events / description / on-off (null = leave as is; an empty
-- description clears it). Switching back on clears the failure count.
-- Switching off gives up on anything still waiting to be delivered.
create or replace function public.update_webhook(p_id uuid, p_url text default null, p_events text[] default null,
                                                 p_active boolean default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.webhooks; u text := btrim(coalesce(p_url, '')); evs text[]; d text;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
  if p_url is not null and not public.webhook_url_ok(u) then raise exception 'invalid url'; end if;
  if p_events is not null then evs := public.webhook_events_checked(p_events); end if;
  if p_description is not null then
    d := nullif(btrim(p_description), '');
    if d is not null and length(d) > 200 then raise exception 'invalid description'; end if;
  end if;
  update public.webhooks set
    url             = case when p_url is not null then u else url end,
    events          = coalesce(evs, events),
    description     = case when p_description is not null then d else description end,
    active          = coalesce(p_active, active),
    failure_count   = case when p_active is true and not active then 0 else failure_count end,
    disabled_at     = case when p_active is true then null when p_active is false and active then now() else disabled_at end,
    disabled_reason = case when p_active is true then null when p_active is false and active then 'Switched off by hand' else disabled_reason end,
    updated_at      = now()
   where id = p_id
  returning * into w;
  if p_active is false then
    update public.webhook_deliveries set state = 'failed', error = coalesce(error, 'Endpoint switched off'),
           next_attempt_at = null, lease_until = null, updated_at = now()
     where webhook_id = p_id and state = 'pending';
  end if;
  return public.webhook_json(w);
end; $$;

create or replace function public.delete_webhook(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare w public.webhooks;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
  delete from public.webhooks where id = p_id;
  return true;
end; $$;

-- A new signing secret (the old one stops verifying at once). Returns {id, secret}.
create or replace function public.rotate_webhook_secret(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.webhooks; sec text := 'whsec_' || public.kanbo_random_token(32);
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
  update public.webhooks set secret = sec, updated_at = now() where id = p_id;
  return jsonb_build_object('id', p_id, 'secret', sec);
end; $$;

-- Queue a "ping" to this endpoint only (works while it's switched off, so it
-- can be checked first). At most 5 a minute per endpoint. Returns {outbox_id}.
create or replace function public.send_test_webhook(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.webhooks; oid bigint;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
  if (select count(*) from public.webhook_outbox o
       where o.webhook_id = p_id and o.event = 'ping' and o.created_at > now() - interval '1 minute') >= 5 then
    raise exception 'too many tests';
  end if;
  insert into public.webhook_outbox (workspace_id, user_id, webhook_id, event, resource_id, payload)
  values (w.workspace_id, case when w.workspace_id is null then w.created_by end, w.id, 'ping', w.id::text,
          jsonb_build_object('webhook', jsonb_build_object('id', w.id, 'url', w.url, 'events', to_jsonb(w.events)),
                             'sent_by', auth.uid()))
  returning id into oid;
  perform public.webhook_poke();
  return jsonb_build_object('outbox_id', oid);
end; $$;

-- An endpoint's recent deliveries, newest first (anyone who can see it).
create or replace function public.list_webhook_deliveries(p_id uuid, p_limit integer default 25)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare w public.webhooks;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id;
  if w.id is null or not public.webhook_can_see(w) then raise exception 'webhook not found'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', d.id, 'webhook_id', d.webhook_id, 'outbox_id', d.outbox_id, 'event', d.event,
             'state', d.state, 'attempt', d.attempt, 'status_code', d.status_code, 'error', d.error,
             'duration_ms', d.duration_ms, 'next_attempt_at', d.next_attempt_at,
             'delivered_at', d.delivered_at, 'created_at', d.created_at, 'updated_at', d.updated_at)
           order by d.created_at desc, d.id)
      from (select * from public.webhook_deliveries x where x.webhook_id = p_id
             order by x.created_at desc, x.id limit greatest(1, least(coalesce(p_limit, 25), 100))) d), '[]'::jsonb);
end; $$;

-- Send one delivery again now (a failed one, or a pending one without waiting).
-- Not a test ping (that's send_test_webhook, 5 a minute), and at most 10 a
-- minute per endpoint — the app and the API share the count — so "send
-- again" can't be used to hammer an address. A redelivered event that fails
-- counts towards switching the endpoint off like any other.
create or replace function public.redeliver_webhook_delivery(p_delivery uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.webhook_deliveries; w public.webhooks; rl record;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into d from public.webhook_deliveries where id = p_delivery for update;
  select * into w from public.webhooks where id = d.webhook_id;
  if d.id is null or w.id is null or not public.webhook_can_manage(w) then raise exception 'delivery not found'; end if;
  if d.state = 'delivered' then raise exception 'already delivered'; end if;
  if d.event = 'ping' then raise exception 'test events can''t be sent again'; end if;
  select * into rl from public.api_rate_hit('kanbo:api:redeliver:' || w.id::text, 60, 10);
  if not rl.allowed then raise exception 'too many redeliveries (retry after % s)', rl.retry_after; end if;
  update public.webhook_deliveries set state = 'pending', attempt = 0, next_attempt_at = now(), lease_until = null,
         error = null, updated_at = now()
   where id = p_delivery;
  perform public.webhook_poke();
  return jsonb_build_object('id', p_delivery, 'state', 'pending');
end; $$;

revoke execute on function public.create_webhook(uuid, text, text[], text) from public, anon;
revoke execute on function public.list_webhooks(uuid) from public, anon;
revoke execute on function public.update_webhook(uuid, text, text[], boolean, text) from public, anon;
revoke execute on function public.delete_webhook(uuid) from public, anon;
revoke execute on function public.rotate_webhook_secret(uuid) from public, anon;
revoke execute on function public.send_test_webhook(uuid) from public, anon;
revoke execute on function public.list_webhook_deliveries(uuid, integer) from public, anon;
revoke execute on function public.redeliver_webhook_delivery(uuid) from public, anon;
grant execute on function public.create_webhook(uuid, text, text[], text) to authenticated;
grant execute on function public.list_webhooks(uuid) to authenticated;
grant execute on function public.update_webhook(uuid, text, text[], boolean, text) to authenticated;
grant execute on function public.delete_webhook(uuid) to authenticated;
grant execute on function public.rotate_webhook_secret(uuid) to authenticated;
grant execute on function public.send_test_webhook(uuid) to authenticated;
grant execute on function public.list_webhook_deliveries(uuid, integer) to authenticated;
grant execute on function public.redeliver_webhook_delivery(uuid) to authenticated;

-- Wake the webhook-dispatch function after this transaction commits (pg_net
-- sends after commit; a rolled-back transaction sends nothing). Best effort:
-- needs pg_net and two Vault secrets, kanbo_functions_url
-- (https://<ref>.supabase.co/functions/v1) and kanbo_cron_secret; without
-- them the every-minute cron job delivers instead. At most one poke per
-- transaction and one per 3 seconds overall (a busy row is skipped, never waited on).
create or replace function public.webhook_poke() returns void
language plpgsql security definer set search_path = public as $$
declare base text; secret text;
begin
  if coalesce(current_setting('kanbo.webhook_poked', true), '') = 'on' then return; end if;
  perform set_config('kanbo.webhook_poked', 'on', true);
  if to_regclass('vault.decrypted_secrets') is null
     or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    return;
  end if;
  perform 1 from public.webhook_dispatch_state
   where id = 1 and last_poke_at < now() - interval '3 seconds' for update skip locked;
  if not found then return; end if;
  execute $q$select (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_functions_url' limit 1),
                    (select decrypted_secret from vault.decrypted_secrets where name = 'kanbo_cron_secret' limit 1)$q$
    into base, secret;
  if coalesce(base, '') !~ '^https://' or coalesce(secret, '') = '' then return; end if;
  update public.webhook_dispatch_state set last_poke_at = now() where id = 1;
  execute 'select net.http_post(url := $1, body := $2, headers := $3, timeout_milliseconds := 5000)'
    using rtrim(base, '/') || '/webhook-dispatch', '{"source":"poke"}'::jsonb,
          jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', secret);
exception when others then
  raise warning 'webhook poke skipped: %', sqlerrm;
end; $$;
revoke execute on function public.webhook_poke() from public, anon, authenticated;

-- Is a webhook listening for this event here? Team rows: the workspace's
-- webhooks. Personal rows: the owner's personal webhooks.
create or replace function public.webhook_listening(p_ws uuid, p_user uuid, p_event text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.webhooks w
     where w.active and p_event = any (w.events)
       and ((p_ws is not null and w.workspace_id = p_ws)
         or (p_ws is null and p_user is not null and w.workspace_id is null and w.created_by = p_user)));
$$;
revoke execute on function public.webhook_listening(uuid, uuid, text) from public, anon, authenticated;

create or replace function public.webhook_enqueue(p_ws uuid, p_user uuid, p_event text, p_resource text, p_payload jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.webhook_listening(p_ws, p_user, p_event) then return; end if;
  insert into public.webhook_outbox (workspace_id, user_id, event, resource_id, payload)
  values (p_ws, case when p_ws is null then p_user end, p_event, p_resource, p_payload);
  perform public.webhook_poke();
end; $$;
revoke execute on function public.webhook_enqueue(uuid, uuid, text, text, jsonb) from public, anon, authenticated;

-- tasks: task.created / task.updated {changes} / task.completed / task.deleted
-- (archived, deleted, or moved to another workspace). Only the fields the
-- API shows count as changes (ranking, plans, followers… don't).
-- The outbox stores raw rows; the dispatcher serialises them (serialise.ts).
create or replace function public.webhook_capture_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cols constant text[] := array['title','description','status','priority','project_id','section_id','assignee_id',
    'due_date','due_time','start_date','completed_at','tags','effort_hours','logged_hours','parent_id',
    'is_milestone','recurrence','workspace_id','archived_at'];
  o jsonb; n jsonb; changed text[];
begin
  if not exists (select 1 from public.webhooks w where w.active) then return null; end if;   -- nobody listens anywhere
  begin
    if tg_op = 'INSERT' then
      perform public.webhook_enqueue(new.workspace_id, new.user_id, 'task.created', new.id::text,
                                     jsonb_build_object('task', to_jsonb(new)));
    elsif tg_op = 'DELETE' then
      perform public.webhook_enqueue(old.workspace_id, old.user_id, 'task.deleted', old.id::text,
                                     jsonb_build_object('task', to_jsonb(old), 'deletion', 'deleted'));
    else
      o := to_jsonb(old); n := to_jsonb(new);
      select coalesce(array_agg(c order by c), '{}') into changed from unnest(cols) c where o -> c is distinct from n -> c;
      if cardinality(changed) = 0 then return null; end if;
      if old.workspace_id is distinct from new.workspace_id then
        perform public.webhook_enqueue(old.workspace_id, old.user_id, 'task.deleted', old.id::text,
                                       jsonb_build_object('task', o, 'deletion', 'moved'));
        perform public.webhook_enqueue(new.workspace_id, new.user_id, 'task.created', new.id::text,
                                       jsonb_build_object('task', n));
      elsif old.archived_at is null and new.archived_at is not null then
        perform public.webhook_enqueue(new.workspace_id, new.user_id, 'task.deleted', new.id::text,
                                       jsonb_build_object('task', n, 'deletion', 'archived'));
      else
        perform public.webhook_enqueue(new.workspace_id, new.user_id, 'task.updated', new.id::text,
                                       jsonb_build_object('task', n, 'changes', to_jsonb(changed)));
        if new.status = 'done' and old.status is distinct from 'done' then
          perform public.webhook_enqueue(new.workspace_id, new.user_id, 'task.completed', new.id::text,
                                         jsonb_build_object('task', n));
        end if;
      end if;
    end if;
  exception when others then
    raise warning 'webhook capture skipped (tasks): %', sqlerrm;   -- never block the write
  end;
  return null;
end; $$;

create or replace function public.webhook_capture_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not exists (select 1 from public.webhooks w where w.active) then return null; end if;
  begin
    select id, user_id, workspace_id, title, project_id into t from public.tasks where id = new.task_id;
    if t.id is null then return null; end if;
    perform public.webhook_enqueue(t.workspace_id, t.user_id, 'comment.created', new.id::text,
      jsonb_build_object('comment', to_jsonb(new),
                         'task', jsonb_build_object('id', t.id, 'title', t.title, 'project_id', t.project_id,
                                                    'workspace_id', t.workspace_id)));
  exception when others then
    raise warning 'webhook capture skipped (comments): %', sqlerrm;
  end;
  return null;
end; $$;

create or replace function public.webhook_capture_project() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  cols constant text[] := array['name','emoji','color','description','status','owner_id','contributor_ids','archived_at','workspace_id'];
  o jsonb; n jsonb; changed text[];
begin
  if not exists (select 1 from public.webhooks w where w.active) then return null; end if;
  begin
    if tg_op = 'INSERT' then
      perform public.webhook_enqueue(new.workspace_id, new.user_id, 'project.created', new.id::text,
                                     jsonb_build_object('project', to_jsonb(new)));
    else
      o := to_jsonb(old); n := to_jsonb(new);
      select coalesce(array_agg(c order by c), '{}') into changed from unnest(cols) c where o -> c is distinct from n -> c;
      if cardinality(changed) = 0 then return null; end if;
      perform public.webhook_enqueue(new.workspace_id, new.user_id, 'project.updated', new.id::text,
                                     jsonb_build_object('project', n, 'changes', to_jsonb(changed)));
    end if;
  exception when others then
    raise warning 'webhook capture skipped (projects): %', sqlerrm;
  end;
  return null;
end; $$;

-- member.joined: an active member with an account (a claimed invite, or added directly)
create or replace function public.webhook_capture_member() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.webhooks w where w.active) then return null; end if;
  begin
    if new.status = 'active' and new.user_id is not null
       and (tg_op = 'INSERT' or old.status is distinct from 'active' or old.user_id is null) then
      perform public.webhook_enqueue(new.workspace_id, null, 'member.joined', new.id::text,
                                     jsonb_build_object('member', to_jsonb(new)));
    end if;
  exception when others then
    raise warning 'webhook capture skipped (workspace_members): %', sqlerrm;
  end;
  return null;
end; $$;

revoke execute on function public.webhook_capture_task() from public, anon, authenticated;
revoke execute on function public.webhook_capture_comment() from public, anon, authenticated;
revoke execute on function public.webhook_capture_project() from public, anon, authenticated;
revoke execute on function public.webhook_capture_member() from public, anon, authenticated;

drop trigger if exists trg_webhook_task on public.tasks;
create trigger trg_webhook_task after insert or update or delete on public.tasks
  for each row execute function public.webhook_capture_task();
drop trigger if exists trg_webhook_comment on public.comments;
create trigger trg_webhook_comment after insert on public.comments
  for each row execute function public.webhook_capture_comment();
drop trigger if exists trg_webhook_project on public.projects;
create trigger trg_webhook_project after insert or update on public.projects
  for each row execute function public.webhook_capture_project();
drop trigger if exists trg_webhook_member on public.workspace_members;
create trigger trg_webhook_member after insert or update of status, user_id on public.workspace_members
  for each row execute function public.webhook_capture_member();

-- SERVICE ROLE ONLY (webhook-dispatch). 1) Fan new outbox rows out to the
-- webhooks listening at the time (a ping goes to its own endpoint only) and
-- mark them processed. Returns how many deliveries were queued.
create or replace function public.webhook_claim_outbox(p_limit integer default 500)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with claimed as (
    select o.id, o.workspace_id, o.user_id, o.webhook_id, o.event, o.created_at
      from public.webhook_outbox o
     where o.processed_at is null
     order by o.id
     limit greatest(1, least(coalesce(p_limit, 500), 5000))
     for update skip locked
  ), fan as (
    insert into public.webhook_deliveries (webhook_id, outbox_id, event, next_attempt_at)
    select w.id, c.id, c.event, now()
      from claimed c
      join public.webhooks w on (
           (c.webhook_id is not null and w.id = c.webhook_id)
        or (c.webhook_id is null and w.active and c.event = any (w.events) and w.created_at <= c.created_at
            and ((c.workspace_id is not null and w.workspace_id = c.workspace_id)
              or (c.workspace_id is null and w.workspace_id is null and w.created_by = c.user_id))))
    on conflict (webhook_id, outbox_id) do nothing
    returning 1
  ), done as (
    update public.webhook_outbox o set processed_at = now() from claimed c where o.id = c.id returning 1
  )
  select count(*) into n from fan;
  return n;
end; $$;

-- 2) Take up to p_limit due deliveries (each gets a lease, so two
-- dispatchers never send the same one; the attempt counter goes up now).
-- Returns everything needed to sign and send — including the secret.
-- Fair shares, across every dispatcher at once (a lease = being sent now):
-- at most 2 deliveries in flight per endpoint, 4 per person who added
-- endpoints and 4 per workspace; among what's left, whoever has least in
-- flight goes first, then the oldest. So one tenant with slow or busy
-- endpoints, however much it queues, can't hold every sending slot.
-- Claims take a lock in turn so those counts are exact.
create or replace function public.webhook_claim_deliveries(p_limit integer default 25, p_lease_seconds integer default 90)
returns table (delivery_id uuid, attempt integer, event text, outbox_id bigint, workspace_id uuid,
               occurred_at timestamptz, payload jsonb, webhook_id uuid, url text, secret text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
begin
  perform pg_advisory_xact_lock(hashtext('kanbo:webhook-claim'));
  return query
  with busy as (            -- being sent right now, per endpoint
    select d.webhook_id, count(*)::integer as n
      from public.webhook_deliveries d
     where d.state = 'pending' and d.lease_until is not null and d.lease_until >= now()
     group by d.webhook_id
  ), hooks as (
    select w.id, w.active, w.created_by, w.workspace_id, coalesce(b.n, 0) as hook_busy,
           sum(coalesce(b.n, 0)) over (partition by w.created_by)::integer as creator_busy,
           sum(coalesce(b.n, 0)) over (partition by w.workspace_id)::integer as ws_busy
      from public.webhooks w
      left join busy b on b.webhook_id = w.id
  ), cand as (              -- each endpoint's two oldest due deliveries
    select x.id, x.next_attempt_at, h.created_by, h.workspace_id, h.hook_busy, h.creator_busy, h.ws_busy,
           row_number() over (partition by h.id order by x.next_attempt_at, x.id) as rn
      from hooks h
      cross join lateral (
        select d.id, d.next_attempt_at from public.webhook_deliveries d
         where d.webhook_id = h.id and d.state = 'pending' and d.next_attempt_at <= now()
           and (d.lease_until is null or d.lease_until < now())
           and (h.active or d.event = 'ping')
         order by d.next_attempt_at, d.id
         limit 2
      ) x
     where h.hook_busy < 2
  ), ranked as (
    select c.id, c.next_attempt_at, c.rn + c.hook_busy as hook_load,
           c.creator_busy + row_number() over (partition by c.created_by order by c.rn, c.next_attempt_at, c.id) as creator_load,
           case when c.workspace_id is null then 0
                else c.ws_busy + row_number() over (partition by c.workspace_id order by c.rn, c.next_attempt_at, c.id) end as ws_load
      from cand c
  ), picked as (
    select r.id from ranked r
     where r.hook_load <= 2 and r.creator_load <= 4 and r.ws_load <= 4
     order by greatest(r.creator_load, r.ws_load), r.next_attempt_at, r.id
     limit greatest(1, least(coalesce(p_limit, 25), 200))
  ), due as (
    select d.id from public.webhook_deliveries d
     where d.id in (select p.id from picked p) and d.state = 'pending'
       and (d.lease_until is null or d.lease_until < now())
     for update of d skip locked
  ), upd as (
    update public.webhook_deliveries d
       set attempt = d.attempt + 1,
           lease_until = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_seconds, 90), 600))),
           updated_at = now()
      from due where d.id = due.id
    returning d.id, d.attempt, d.event, d.outbox_id, d.webhook_id
  )
  select u.id, u.attempt, u.event, u.outbox_id, o.workspace_id, o.created_at, o.payload, w.id, w.url, w.secret
    from upd u
    join public.webhook_outbox o on o.id = u.outbox_id
    join public.webhooks w on w.id = u.webhook_id;
end; $$;

-- 3) Record how a delivery went. 2xx = delivered (the endpoint's failure
-- count resets). Otherwise retry after 1m, 5m, 30m, 2h, 6h, then give up
-- (a ping is never retried). 20 failed attempts in a row switch the
-- endpoint off, give up on its queue and tell its creator in their Inbox.
-- Returns {state, next_attempt_at, disabled}.
create or replace function public.webhook_record_result(p_delivery uuid, p_status_code integer,
                                                        p_error text default null, p_duration_ms integer default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d       public.webhook_deliveries;
  w       public.webhooks;
  ok      boolean := coalesce(p_status_code, 0) between 200 and 299;
  backoff constant interval[] := array['1 minute','5 minutes','30 minutes','2 hours','6 hours']::interval[];
  err     text := case when ok then null else left(nullif(btrim(coalesce(p_error, '')), ''), 500) end;
  nxt     timestamptz;
  st      text;
  off     boolean := false;
  host    text;
begin
  select * into d from public.webhook_deliveries where id = p_delivery for update;
  if d.id is null then return null; end if;
  if d.state <> 'pending' then return jsonb_build_object('state', d.state, 'next_attempt_at', null, 'disabled', false); end if;
  if ok then
    st := 'delivered';
  elsif d.event = 'ping' or d.attempt > array_length(backoff, 1) then
    st := 'failed';
  else
    st := 'pending';
    nxt := now() + backoff[greatest(d.attempt, 1)];
  end if;
  update public.webhook_deliveries
     set state = st, status_code = p_status_code, error = err, duration_ms = p_duration_ms,
         next_attempt_at = nxt, lease_until = null, delivered_at = case when ok then now() end, updated_at = now()
   where id = d.id;
  update public.webhooks x
     set failure_count = case when ok then 0 when d.event = 'ping' then x.failure_count else x.failure_count + 1 end,
         last_status = p_status_code, last_error = err, last_delivery_at = now(), updated_at = now()
   where x.id = d.webhook_id
  returning * into w;
  if not ok and w.active and w.failure_count >= 20 then
    update public.webhooks set active = false, disabled_at = now(),
           disabled_reason = 'Switched off after 20 failed deliveries in a row', updated_at = now()
     where id = w.id;
    update public.webhook_deliveries set state = 'failed', error = coalesce(error, 'Endpoint switched off'),
           next_attempt_at = null, lease_until = null, updated_at = now()
     where webhook_id = w.id and state = 'pending';
    nxt := null; st := case when st = 'pending' then 'failed' else st end;
    host := substring(w.url from '^https://([^/:?#]+)');
    insert into public.activity (user_id, task_id, task_title, kind, detail)
    values (w.created_by, null, 'Webhook to ' || coalesce(host, 'your endpoint') || ' switched off', 'integration',
            'Kanbo couldn''t deliver to ' || coalesce(host, 'your endpoint')
            || ' 20 times in a row, so it stopped sending. Fix the endpoint, then switch it back on in Settings › Developers › Webhooks.');
    off := true;
  end if;
  return jsonb_build_object('state', st, 'next_attempt_at', nxt, 'disabled', off);
end; $$;

-- Daily tidy-up (pg_cron can call it directly; see docs/api/webhooks.md):
-- idempotency answers after 24h, outbox rows (and their deliveries) after
-- 14 days, the API's rate-limit rows after a day.
create or replace function public.api_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a integer; b integer; c integer;
begin
  delete from public.api_idempotency where created_at < now() - interval '24 hours';
  get diagnostics a = row_count;
  delete from public.webhook_outbox where created_at < now() - interval '14 days';
  get diagnostics b = row_count;
  delete from public.rate_limits where key like 'kanbo:api:%' and last_at < now() - interval '1 day';
  get diagnostics c = row_count;
  return jsonb_build_object('idempotency', a, 'outbox', b, 'rate_limits', c);
end; $$;

revoke execute on function public.webhook_claim_outbox(integer) from public, anon, authenticated;
revoke execute on function public.webhook_claim_deliveries(integer, integer) from public, anon, authenticated;
revoke execute on function public.webhook_record_result(uuid, integer, text, integer) from public, anon, authenticated;
revoke execute on function public.api_housekeeping() from public, anon, authenticated;

-- ---------- 6. Notion ----------
-- the integration's token lives beside the Slack URL: service role only
create table if not exists public.workspace_integrations (
  workspace_id        uuid primary key references public.workspaces (id) on delete cascade,
  slack_webhook_url   text,
  slack_autopost      boolean not null default false,
  slack_autopost_time text,
  slack_channel_label text,
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now()
);
alter table public.workspace_integrations add column if not exists notion_token text;
alter table public.workspace_integrations add column if not exists notion_workspace_name text;
alter table public.workspace_integrations add column if not exists notion_bot_id text;
alter table public.workspace_integrations add column if not exists notion_connected_by uuid references auth.users (id) on delete set null;
alter table public.workspace_integrations add column if not exists notion_connected_at timestamptz;
alter table public.workspace_integrations drop constraint if exists workspace_integrations_notion;
alter table public.workspace_integrations add constraint workspace_integrations_notion check (
  (notion_token is null or notion_token ~ '^(secret_|ntn_)[A-Za-z0-9]{20,180}$')
  and (notion_workspace_name is null or length(notion_workspace_name) <= 200)
  and (notion_bot_id is null or length(notion_bot_id) <= 100));
alter table public.workspace_integrations enable row level security;
revoke all on public.workspace_integrations from anon, authenticated;
do $wi$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'workspace_integrations' loop
    execute format('drop policy %I on public.workspace_integrations', pol.policyname);
  end loop;
end $wi$;

-- a Notion id (page or database) from any of its spellings: 32 hex digits,
-- dashed or not → the dashed lower-case form; null when it isn't one
create or replace function public.notion_norm_id(p text)
returns text language sql immutable as $$
  select case when x ~ '^[0-9a-f]{32}$'
              then substr(x, 1, 8) || '-' || substr(x, 9, 4) || '-' || substr(x, 13, 4) || '-' || substr(x, 17, 4) || '-' || substr(x, 21, 12) end
    from (select lower(replace(btrim(coalesce(p, '')), '-', '')) as x) s;
$$;
grant execute on function public.notion_norm_id(text) to public;

create table if not exists public.notion_syncs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  database_id     text not null,
  database_title  text,
  mapping         jsonb not null default '{}'::jsonb,
  direction       text not null default 'two_way',
  enabled         boolean not null default true,
  last_cursor     text,
  last_run_at     timestamptz,
  last_success_at timestamptz,
  last_error      text,
  last_error_at   timestamptz,
  stats           jsonb not null default '{}'::jsonb,
  created_by      uuid references auth.users (id) on delete set null,   -- the sync acts as this person
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (workspace_id, database_id)
);
create index if not exists notion_syncs_project_idx on public.notion_syncs (project_id);
alter table public.notion_syncs drop constraint if exists notion_syncs_shape;
alter table public.notion_syncs add constraint notion_syncs_shape check (
  direction in ('two_way', 'from_notion')
  and database_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (database_title is null or length(database_title) <= 300)
  and jsonb_typeof(mapping) = 'object' and pg_column_size(mapping) <= 16384
  and jsonb_typeof(stats) = 'object' and pg_column_size(stats) <= 4096
  and (last_cursor is null or length(last_cursor) <= 200)
  and (last_error is null or length(last_error) <= 1000));

create table if not exists public.notion_links (
  id                 uuid primary key default gen_random_uuid(),
  workspace_id       uuid not null references public.workspaces (id) on delete cascade,
  task_id            uuid not null references public.tasks (id) on delete cascade,
  notion_page_id     text not null,
  notion_database_id text,
  sync_id            uuid references public.notion_syncs (id) on delete set null,
  kind               text not null default 'reference',   -- 'synced' (made by an import / sync) | 'reference' (a link someone added)
  last_synced_at     timestamptz,     -- the task's updated_at when the sync last wrote or read it
  notion_last_edited timestamptz,     -- the page's last_edited_time when the sync last wrote or read it
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  unique (task_id, notion_page_id)
);
create unique index if not exists notion_links_sync_page_key on public.notion_links (sync_id, notion_page_id) where sync_id is not null;
create unique index if not exists notion_links_one_synced_per_task on public.notion_links (task_id) where kind = 'synced';
create index if not exists notion_links_page_idx on public.notion_links (workspace_id, notion_page_id);
alter table public.notion_links drop constraint if exists notion_links_shape;
alter table public.notion_links add constraint notion_links_shape check (
  kind in ('synced', 'reference')
  and notion_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (notion_database_id is null or notion_database_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'));

-- a link always belongs to its task's workspace (team tasks only)
create or replace function public.notion_links_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  select t.workspace_id into ws from public.tasks t where t.id = new.task_id;
  if ws is null then raise exception 'notion links need a team task'; end if;
  new.workspace_id := ws;
  return new;
end; $$;
revoke execute on function public.notion_links_guard() from public, anon, authenticated;
drop trigger if exists trg_notion_links_guard on public.notion_links;
create trigger trg_notion_links_guard before insert or update of task_id, workspace_id on public.notion_links
  for each row execute function public.notion_links_guard();

create table if not exists public.notion_page_cache (
  workspace_id     uuid not null references public.workspaces (id) on delete cascade,
  notion_page_id   text not null,
  title            text,
  icon             text,            -- an emoji, or an https image URL
  url              text,
  last_edited_time timestamptz,
  archived         boolean not null default false,
  fetched_at       timestamptz not null default now(),
  primary key (workspace_id, notion_page_id)
);
alter table public.notion_page_cache drop constraint if exists notion_page_cache_shape;
alter table public.notion_page_cache add constraint notion_page_cache_shape check (
  notion_page_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  and (title is null or length(title) <= 500)
  and (icon is null or length(icon) <= 1000)
  and (url is null or (length(url) <= 1000 and url ~ '^https://')));

-- members of the workspace read; nobody writes from the app (the notion
-- function and the definer functions below do)
do $nt$
declare t text; pol record;
begin
  foreach t in array array['notion_syncs','notion_links','notion_page_cache'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('create policy "notion: members read" on public.%I for select to authenticated using (public.is_member(workspace_id))', t);
  end loop;
end $nt$;

-- what members may know (never the token; owners/admins also see its last 4)
create or replace function public.notion_status(p_ws uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when p_ws is null or not public.is_member(p_ws) then null else jsonb_build_object(
    'connected',         i.notion_token is not null,
    'workspace_name',    i.notion_workspace_name,
    'bot_id',            i.notion_bot_id,
    'token_hint',        case when i.notion_token is not null and public.ws_role(p_ws) in ('owner', 'admin')
                              then '…' || right(i.notion_token, 4) end,
    'connected_at',      i.notion_connected_at,
    'connected_by_name', case when i.notion_connected_by is not null then public.kanbo_person_name(i.notion_connected_by) end,
    'can_manage',        public.ws_role(p_ws) in ('owner', 'admin'),
    'can_link',          public.can_write(p_ws),
    'sync_count',        (select count(*) from public.notion_syncs s where s.workspace_id = p_ws)) end
  from (select 1) as one
  left join public.workspace_integrations i on i.workspace_id = p_ws;
$$;

create or replace function public.notion_connect(p_ws uuid, p_token text, p_workspace_name text default null, p_bot_id text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare tok text := btrim(coalesce(p_token, ''));
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  if tok !~ '^(secret_|ntn_)[A-Za-z0-9]{20,180}$' then raise exception 'invalid token'; end if;
  insert into public.workspace_integrations as i (workspace_id, notion_token, notion_workspace_name, notion_bot_id,
                                                   notion_connected_by, notion_connected_at, updated_by, updated_at)
  values (p_ws, tok, nullif(left(btrim(coalesce(p_workspace_name, '')), 200), ''), nullif(left(btrim(coalesce(p_bot_id, '')), 100), ''),
          auth.uid(), now(), auth.uid(), now())
  on conflict (workspace_id) do update
     set notion_token = excluded.notion_token,
         notion_workspace_name = excluded.notion_workspace_name,
         notion_bot_id = excluded.notion_bot_id,
         notion_connected_by = excluded.notion_connected_by,
         notion_connected_at = excluded.notion_connected_at,
         updated_by = excluded.updated_by, updated_at = now();
  return public.notion_status(p_ws);
end; $$;

-- forget the token; every sync of this workspace switches off (links stay)
create or replace function public.notion_disconnect(p_ws uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  update public.workspace_integrations
     set notion_token = null, notion_workspace_name = null, notion_bot_id = null,
         notion_connected_by = null, notion_connected_at = null, updated_by = auth.uid(), updated_at = now()
   where workspace_id = p_ws;
  update public.notion_syncs set enabled = false, updated_at = now() where workspace_id = p_ws and enabled;
  return public.notion_status(p_ws);
end; $$;

create or replace function public.notion_sync_json(s public.notion_syncs)
returns jsonb language sql security definer stable set search_path = public as $$
  select to_jsonb(s) || jsonb_build_object('created_by_name',
    case when s.created_by is not null then public.kanbo_person_name(s.created_by) end);
$$;
revoke execute on function public.notion_sync_json(public.notion_syncs) from public, anon, authenticated;

-- Create or change the sync for a Notion database (owners/admins; Notion
-- must be connected; the project must be in the workspace). Saving makes
-- the caller the person the sync acts as, and clears its last error.
create or replace function public.notion_save_sync(p_ws uuid, p_project uuid, p_database_id text, p_database_title text,
                                                   p_mapping jsonb, p_direction text default 'two_way', p_enabled boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare db text := public.notion_norm_id(p_database_id); dir text := coalesce(p_direction, 'two_way'); s public.notion_syncs;
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.workspace_integrations i where i.workspace_id = p_ws and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  if db is null then raise exception 'invalid database'; end if;
  if dir not in ('two_way', 'from_notion') then raise exception 'invalid direction'; end if;
  if p_mapping is null or jsonb_typeof(p_mapping) <> 'object' or pg_column_size(p_mapping) > 16384
     or coalesce(p_mapping ->> 'title', '') = '' then
    raise exception 'invalid mapping';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project and p.workspace_id = p_ws) then
    raise exception 'invalid project';
  end if;
  insert into public.notion_syncs (workspace_id, project_id, database_id, database_title, mapping, direction, enabled, created_by)
  values (p_ws, p_project, db, nullif(left(btrim(coalesce(p_database_title, '')), 300), ''), p_mapping, dir, coalesce(p_enabled, true), auth.uid())
  on conflict (workspace_id, database_id) do update
     set project_id = excluded.project_id, database_title = excluded.database_title, mapping = excluded.mapping,
         direction = excluded.direction, enabled = excluded.enabled, created_by = excluded.created_by,
         last_error = null, last_error_at = null, updated_at = now()
  returning * into s;
  return public.notion_sync_json(s);
end; $$;

create or replace function public.notion_set_sync_enabled(p_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  if coalesce(p_enabled, false) and not exists (select 1 from public.workspace_integrations i
                                                 where i.workspace_id = s.workspace_id and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  update public.notion_syncs set enabled = coalesce(p_enabled, false), updated_at = now() where id = p_id returning * into s;
  return public.notion_sync_json(s);
end; $$;

-- remove a sync: its tasks stay, and keep their page as a plain link
create or replace function public.notion_delete_sync(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  update public.notion_links set kind = 'reference', sync_id = null where sync_id = p_id;
  delete from public.notion_syncs where id = p_id;
  return true;
end; $$;

create or replace function public.notion_link_json(l public.notion_links)
returns jsonb language sql security definer stable set search_path = public as $$
  select to_jsonb(l) || jsonb_build_object('page', (
    select jsonb_build_object('title', c.title, 'icon', c.icon, 'url', c.url, 'last_edited_time', c.last_edited_time,
                              'archived', c.archived, 'fetched_at', c.fetched_at)
      from public.notion_page_cache c where c.workspace_id = l.workspace_id and c.notion_page_id = l.notion_page_id));
$$;
revoke execute on function public.notion_link_json(public.notion_links) from public, anon, authenticated;

-- Link a Notion page to a team task (people who can edit the task; Notion
-- connected; at most 20 links a task). The notion function fetches the
-- page's title and icon into notion_page_cache. Linking twice is a no-op.
create or replace function public.notion_link_page(p_task uuid, p_page_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid text := public.notion_norm_id(p_page_id); ws uuid; l public.notion_links;
begin
  if auth.uid() is null or not public.can_edit_task(p_task) then raise exception 'task not found'; end if;
  select t.workspace_id into ws from public.tasks t where t.id = p_task;
  if ws is null then raise exception 'notion links need a team task'; end if;
  if not exists (select 1 from public.workspace_integrations i where i.workspace_id = ws and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  if pid is null then raise exception 'invalid page'; end if;
  select * into l from public.notion_links where task_id = p_task and notion_page_id = pid;
  if l.id is null then
    if (select count(*) from public.notion_links x where x.task_id = p_task) >= 20 then raise exception 'too many links'; end if;
    insert into public.notion_links (workspace_id, task_id, notion_page_id, kind, created_by)
    values (ws, p_task, pid, 'reference', auth.uid())
    returning * into l;
  end if;
  return public.notion_link_json(l);
end; $$;

-- Unlink: people who can edit the task remove a plain link; a synced link
-- (it drives the sync) needs an owner/admin.
create or replace function public.notion_unlink_page(p_link uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare l public.notion_links;
begin
  select * into l from public.notion_links where id = p_link for update;
  if l.id is null or auth.uid() is null or not public.can_edit_task(l.task_id)
     or (l.kind = 'synced' and public.ws_role(l.workspace_id) not in ('owner', 'admin')) then
    raise exception 'link not found';
  end if;
  delete from public.notion_links where id = p_link;
  return true;
end; $$;

revoke execute on function public.notion_status(uuid) from public, anon;
revoke execute on function public.notion_connect(uuid, text, text, text) from public, anon;
revoke execute on function public.notion_disconnect(uuid) from public, anon;
revoke execute on function public.notion_save_sync(uuid, uuid, text, text, jsonb, text, boolean) from public, anon;
revoke execute on function public.notion_set_sync_enabled(uuid, boolean) from public, anon;
revoke execute on function public.notion_delete_sync(uuid) from public, anon;
revoke execute on function public.notion_link_page(uuid, text) from public, anon;
revoke execute on function public.notion_unlink_page(uuid) from public, anon;
grant execute on function public.notion_status(uuid) to authenticated;
grant execute on function public.notion_connect(uuid, text, text, text) to authenticated;
grant execute on function public.notion_disconnect(uuid) to authenticated;
grant execute on function public.notion_save_sync(uuid, uuid, text, text, jsonb, text, boolean) to authenticated;
grant execute on function public.notion_set_sync_enabled(uuid, boolean) to authenticated;
grant execute on function public.notion_delete_sync(uuid) to authenticated;
grant execute on function public.notion_link_page(uuid, text) to authenticated;
grant execute on function public.notion_unlink_page(uuid) to authenticated;

-- ---------- 7. service-role grants (edge functions) ----------
do $svc$
begin
  grant execute on function public.verify_api_key(text) to service_role;
  grant execute on function public.api_rate_hit(text, integer, integer) to service_role;
  grant execute on function public.api_idempotency_begin(uuid, text, text) to service_role;
  grant execute on function public.api_idempotency_finish(uuid, text, integer, jsonb) to service_role;
  grant execute on function public.webhook_claim_outbox(integer) to service_role;
  grant execute on function public.webhook_claim_deliveries(integer, integer) to service_role;
  grant execute on function public.webhook_record_result(uuid, integer, text, integer) to service_role;
  grant execute on function public.api_housekeeping() to service_role;
  grant execute on function public.user_can_act(uuid) to service_role;
  grant execute on function public.user_ws_role(uuid, uuid) to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- 8. realtime: syncs and links stream to members ----------
do $rt$
declare t text;
begin
  foreach t in array array['notion_syncs', 'notion_links'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when object_not_in_prerequisite_state then null;
      when undefined_object then null;
    end;
  end loop;
end $rt$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0046') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0046')                       as recorded,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'tasks' and column_name = 'updated_at')
--   and exists (select 1 from pg_trigger where tgname = 'trg_tasks_touch_updated_at')               as tasks_updated_at,
--   not has_column_privilege('authenticated', 'public.api_keys', 'key_hash', 'select')
--   and has_column_privilege('authenticated', 'public.api_keys', 'prefix', 'select')
--   and not has_table_privilege('authenticated', 'public.api_keys', 'insert')                     as key_hashes_hidden,
--   not has_function_privilege('authenticated', 'public.verify_api_key(text)', 'execute')          as verify_service_only,
--   (select count(*) from pg_policies where schemaname = 'public' and policyname = 'api key scope'
--     and permissive = 'RESTRICTIVE') >= 10                                                        as api_key_scope,
--   not has_table_privilege('authenticated', 'public.webhooks', 'select')
--   and not has_table_privilege('authenticated', 'public.webhook_outbox', 'select')
--   and not has_table_privilege('authenticated', 'public.webhook_deliveries', 'select')            as webhooks_server_only,
--   (select count(*) from pg_trigger where tgname in ('trg_webhook_task','trg_webhook_comment',
--     'trg_webhook_project','trg_webhook_member')) = 4                                            as webhook_triggers,
--   not has_function_privilege('authenticated', 'public.webhook_url_masked(text)', 'execute')     as webhook_urls_masked,
--   not has_table_privilege('authenticated', 'public.workspace_integrations', 'select')            as notion_token_server_only,
--   (select relrowsecurity from pg_class where oid = 'public.notion_links'::regclass)
--   and (select relrowsecurity from pg_class where oid = 'public.notion_syncs'::regclass)
--   and (select relrowsecurity from pg_class where oid = 'public.notion_page_cache'::regclass)    as notion_rls;
-- ============================================================
