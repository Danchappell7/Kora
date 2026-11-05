-- ============================================================
-- KANBO — connect your AI: OAuth 2.1 for the MCP server (2026-11-04).
-- Additive: nothing the app or the API does today changes.
--
--   The mcp edge function (https://www.kanbo.co.uk/mcp) accepts a Kanbo API
--   key or an access token issued here. A token acts as the person who pressed
--   Allow, through the same db.withUser transaction as the REST API: RLS, the
--   "api key scope" policies for a one-workspace grant, READ ONLY for a
--   read-only grant. It can never do more than that person can.
--
--   mcp_oauth_clients         apps. Dynamic Client Registration rows
--                             (client_id kmcp_client_…) and Client ID Metadata
--                             Documents (client_id is the https URL). Names are
--                             what the app says it's called: untrusted text.
--   mcp_oauth_codes           single use, 5 minutes, PKCE S256, one exact
--                             redirect_uri. Only the SHA-256 is stored. A code
--                             used twice revokes the grant it made.
--   mcp_oauth_grants          one per Allow: who, which app, read or write, all
--                             workspaces or one. Its id stands in for an API
--                             key's id (rate limits, idempotency).
--   mcp_oauth_access_tokens   1 hour. Only the SHA-256.
--   mcp_oauth_refresh_tokens  rotated on every use, kept as hashes so a replay
--                             can be recognised: the token before the current
--                             one is honoured for 10 seconds (a lost answer),
--                             anything else revokes the grant.
--
--   service role only (the mcp edge function): mcp_oauth_register_client,
--     mcp_oauth_upsert_cimd_client, mcp_oauth_client_check,
--     mcp_oauth_exchange_code, mcp_oauth_refresh, mcp_oauth_revoke_token,
--     mcp_verify_token, mcp_oauth_sweep.
--   signed-in people (the consent page, Settings): mcp_oauth_approve,
--     mcp_oauth_list_grants, mcp_oauth_revoke_grant.
--
--   Suspended, unapproved or deleted people fail closed on every call: the
--   checks are in mcp_verify_token and mcp_oauth_refresh, not just at consent.
--   Deleting an account or closing a workspace removes its grants (cascade).
--
--   api_idempotency.key_id no longer has a foreign key to api_keys, because a
--   grant's id goes there too. Triggers keep its clean-up.
--
-- Needs 0046. Must not depend on 0047, 0048 or 0049. Idempotent: safe to run
-- more than once (re-running keeps every client, grant and token).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0046') then
    raise exception '0050 needs 0046 first: run 0046_api_webhooks_notion.sql, then this file';
  end if;
end $pre$;

-- ---------- 1. the fixed values (mirrored in _shared/mcp/metadata.ts; a test keeps them equal) ----------
create or replace function public.mcp_oauth_resource() returns text
language sql immutable set search_path = pg_catalog as $$ select 'https://www.kanbo.co.uk/mcp'::text $$;
revoke execute on function public.mcp_oauth_resource() from public, anon, authenticated;

-- May this be a redirect address at all? https, loopback http, or the one
-- private-use callback a real client needs. Never javascript:, data:, file:,
-- vbscript:, a fragment, userinfo or white space. (oauthCore.ts has the same
-- rule for friendlier errors; the PGlite suite checks they agree. This one decides.)
create or replace function public.mcp_oauth_redirect_allowed(p_uri text) returns boolean
language sql immutable set search_path = pg_catalog as $$
  select coalesce(
    length(p_uri) between 1 and 2048
    and p_uri !~ '[[:cntrl:]]'
    and (p_uri = 'cursor://anysphere.cursor-mcp/oauth/callback'
         or p_uri ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]#\\]*)?(\?[^[:space:]#\\]*)?$'
         or p_uri ~ '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/[^[:space:]#\\]*)?(\?[^[:space:]#\\]*)?$'),
    false);
$$;
revoke execute on function public.mcp_oauth_redirect_allowed(text) from public, anon, authenticated;

-- A loopback address with its port taken out (http://localhost:53682/cb -> http://localhost/cb).
create or replace function public.mcp_oauth_redirect_portless(p_uri text) returns text
language sql immutable set search_path = pg_catalog as $$
  select regexp_replace(p_uri, '^(https?://(localhost|127\.0\.0\.1|\[::1\]))(:[0-9]{1,5})?', '\1');
$$;
revoke execute on function public.mcp_oauth_redirect_portless(text) from public, anon, authenticated;

-- Does this address match one the app registered? Exact, except that the port is
-- ignored on loopback addresses (native apps pick a free port each time).
create or replace function public.mcp_oauth_redirect_matches(p_registered text[], p_uri text) returns boolean
language sql immutable set search_path = pg_catalog, public as $$
  select coalesce(public.mcp_oauth_redirect_allowed(p_uri)
    and (p_uri = any (p_registered)
         or (p_uri ~ '^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/|\?|$)'
             and exists (select 1 from unnest(p_registered) r
                          where r ~ '^https?://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?(/|\?|$)'
                            and public.mcp_oauth_redirect_portless(r) = public.mcp_oauth_redirect_portless(p_uri)))),
    false);
$$;
revoke execute on function public.mcp_oauth_redirect_matches(text[], text) from public, anon, authenticated;

-- ---------- 2. tables ----------
create table if not exists public.mcp_oauth_clients (
  client_id    text primary key,
  kind         text not null,
  client_name  text not null default 'Unnamed app',
  client_uri   text,
  redirect_uris text[] not null,
  created_at   timestamptz not null default now(),
  fetched_at   timestamptz
);
alter table public.mcp_oauth_clients drop constraint if exists mcp_oauth_clients_shape;
alter table public.mcp_oauth_clients add constraint mcp_oauth_clients_shape check (
  kind in ('dcr', 'cimd')
  and length(client_id) between 1 and 512
  and length(client_name) between 1 and 200
  and (client_uri is null or length(client_uri) <= 2048)
  and coalesce(array_length(redirect_uris, 1), 0) between 1 and 20);

create table if not exists public.mcp_oauth_grants (
  id           uuid primary key default gen_random_uuid(),
  client_id    text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  access       text not null,
  scope        text not null,
  resource     text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  refresh_expires_at timestamptz not null default (now() + interval '90 days'),
  prev_refresh_hash  text,
  revoked_at   timestamptz,
  revoked_reason text
);
create index if not exists mcp_oauth_grants_user_idx on public.mcp_oauth_grants (user_id, created_at desc);
create index if not exists mcp_oauth_grants_client_idx on public.mcp_oauth_grants (client_id);
create index if not exists mcp_oauth_grants_workspace_idx on public.mcp_oauth_grants (workspace_id) where workspace_id is not null;
alter table public.mcp_oauth_grants drop constraint if exists mcp_oauth_grants_shape;
alter table public.mcp_oauth_grants add constraint mcp_oauth_grants_shape check (
  access in ('read', 'write') and length(scope) <= 200 and length(resource) <= 512
  and (prev_refresh_hash is null or prev_refresh_hash ~ '^[0-9a-f]{64}$'));

create table if not exists public.mcp_oauth_codes (
  code_hash    text primary key,
  client_id    text not null references public.mcp_oauth_clients (client_id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  resource     text not null,
  access       text not null,
  scope        text not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  used_at      timestamptz,
  grant_id     uuid references public.mcp_oauth_grants (id) on delete set null
);
create index if not exists mcp_oauth_codes_expires_idx on public.mcp_oauth_codes (expires_at);
alter table public.mcp_oauth_codes drop constraint if exists mcp_oauth_codes_shape;
alter table public.mcp_oauth_codes add constraint mcp_oauth_codes_shape check (
  code_hash ~ '^[0-9a-f]{64}$' and code_challenge ~ '^[A-Za-z0-9_-]{43}$'
  and access in ('read', 'write') and length(redirect_uri) <= 2048);

create table if not exists public.mcp_oauth_access_tokens (
  token_hash text primary key,
  grant_id   uuid not null references public.mcp_oauth_grants (id) on delete cascade,
  expires_at timestamptz not null
);
create index if not exists mcp_oauth_access_tokens_grant_idx on public.mcp_oauth_access_tokens (grant_id);
create index if not exists mcp_oauth_access_tokens_expires_idx on public.mcp_oauth_access_tokens (expires_at);

create table if not exists public.mcp_oauth_refresh_tokens (
  token_hash text primary key,
  grant_id   uuid not null references public.mcp_oauth_grants (id) on delete cascade,
  issued_at  timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists mcp_oauth_refresh_tokens_grant_idx on public.mcp_oauth_refresh_tokens (grant_id, issued_at desc);

-- nobody reaches these directly: the edge function's connection and the functions below only
do $rls$
declare t text;
begin
  foreach t in array array['mcp_oauth_clients', 'mcp_oauth_grants', 'mcp_oauth_codes', 'mcp_oauth_access_tokens', 'mcp_oauth_refresh_tokens'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $rls$;

-- ---------- 3. idempotency keys belong to a key or a grant ----------
do $fk$
declare c record;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.api_idempotency'::regclass and contype = 'f' loop
    execute format('alter table public.api_idempotency drop constraint %I', c.conname);
  end loop;
end $fk$;

create or replace function public.mcp_idempotency_forget() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.api_idempotency i where i.key_id = old.id;
  return old;
end; $$;
revoke execute on function public.mcp_idempotency_forget() from public, anon, authenticated;
drop trigger if exists trg_api_key_idempotency on public.api_keys;
create trigger trg_api_key_idempotency after delete on public.api_keys
  for each row execute function public.mcp_idempotency_forget();
drop trigger if exists trg_mcp_grant_idempotency on public.mcp_oauth_grants;
create trigger trg_mcp_grant_idempotency after delete on public.mcp_oauth_grants
  for each row execute function public.mcp_idempotency_forget();

-- 0046's function, plus: a grant's own user may mark its placeholders too
create or replace function public.api_idempotency_commit(p_key_id uuid, p_idem_key text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  update public.api_idempotency i set committed_at = coalesce(i.committed_at, now())
   where i.key_id = p_key_id and i.idem_key = p_idem_key and i.status = 0
     and (exists (select 1 from public.api_keys k where k.id = p_key_id and k.user_id = auth.uid())
          or exists (select 1 from public.mcp_oauth_grants g where g.id = p_key_id and g.user_id = auth.uid()));
end; $$;
revoke execute on function public.api_idempotency_commit(uuid, text) from public, anon;
grant execute on function public.api_idempotency_commit(uuid, text) to authenticated;

-- ---------- 4. tidying up, a little at a time (called from register and approve; no cron job needed) ----------
create or replace function public.mcp_oauth_sweep() returns void
language plpgsql security definer set search_path = public as $$
begin
  -- this server's own rate-limit rows: nothing else clears the kanbo:mcp: prefix
  delete from public.rate_limits l where l.ctid in (
    select x.ctid from public.rate_limits x where x.key like 'kanbo:mcp:%' and x.last_at < now() - interval '1 day' limit 500);
  delete from public.mcp_oauth_codes c where c.ctid in (
    select x.ctid from public.mcp_oauth_codes x where x.expires_at < now() - interval '1 day' limit 500);
  delete from public.mcp_oauth_access_tokens a where a.ctid in (
    select x.ctid from public.mcp_oauth_access_tokens x where x.expires_at < now() - interval '1 hour' limit 500);
  delete from public.mcp_oauth_grants g where g.id in (
    select x.id from public.mcp_oauth_grants x
     where (x.revoked_at is not null and x.revoked_at < now() - interval '30 days')
        or x.refresh_expires_at < now() - interval '30 days' limit 200);
  -- an app with no connection left: registered apps after a day (anyone can add one,
  -- without signing in, so these go quickly), documents after a week
  delete from public.mcp_oauth_clients c where c.client_id in (
    select x.client_id from public.mcp_oauth_clients x
     where x.created_at < now() - case x.kind when 'dcr' then interval '1 day' else interval '7 days' end
       and not exists (select 1 from public.mcp_oauth_grants g where g.client_id = x.client_id)
       and not exists (select 1 from public.mcp_oauth_codes k where k.client_id = x.client_id and k.expires_at > now())
     limit 200);
end; $$;
revoke execute on function public.mcp_oauth_sweep() from public, anon, authenticated;

-- ---------- 5. service role: apps ----------
create or replace function public.mcp_oauth_register_client(p_name text, p_client_uri text, p_redirect_uris text[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  cid text := 'kmcp_client_' || public.kanbo_random_token(18);
  u text;
  nm text := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), 120);
begin
  -- what a stranger may store without signing in is small (oauthCore.ts says the same, in friendlier words)
  if coalesce(array_length(p_redirect_uris, 1), 0) not between 1 and 8 then return jsonb_build_object('error', 'invalid_redirect_uri'); end if;
  foreach u in array p_redirect_uris loop
    if length(u) > 512 or not public.mcp_oauth_redirect_allowed(u) then return jsonb_build_object('error', 'invalid_redirect_uri'); end if;
  end loop;
  perform public.mcp_oauth_sweep();
  insert into public.mcp_oauth_clients (client_id, kind, client_name, client_uri, redirect_uris)
  values (cid, 'dcr', coalesce(nullif(nm, ''), 'Unnamed app'), left(p_client_uri, 512), p_redirect_uris);
  return jsonb_build_object('client_id', cid, 'client_id_issued_at', extract(epoch from now())::bigint,
    'client_name', coalesce(nullif(nm, ''), 'Unnamed app'), 'redirect_uris', to_jsonb(p_redirect_uris));
end; $$;
revoke execute on function public.mcp_oauth_register_client(text, text, text[]) from public, anon, authenticated;

-- What a Client ID Metadata Document says, after the edge function fetched and checked it.
create or replace function public.mcp_oauth_upsert_cimd_client(p_client_id text, p_name text, p_client_uri text, p_redirect_uris text[])
returns void language plpgsql security definer set search_path = public as $$
declare
  u text;
  nm text := left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]]+', ' ', 'g')), 120);
begin
  if p_client_id !~ '^https://' or length(p_client_id) > 512 then raise exception 'invalid client'; end if;
  if coalesce(array_length(p_redirect_uris, 1), 0) not between 1 and 20 then raise exception 'invalid client'; end if;
  foreach u in array p_redirect_uris loop
    if not public.mcp_oauth_redirect_allowed(u) then raise exception 'invalid client'; end if;
  end loop;
  insert into public.mcp_oauth_clients as c (client_id, kind, client_name, client_uri, redirect_uris, fetched_at)
  values (p_client_id, 'cimd', coalesce(nullif(nm, ''), 'Unnamed app'), left(p_client_uri, 2048), p_redirect_uris, now())
  on conflict (client_id) do update set client_name = excluded.client_name, client_uri = excluded.client_uri,
    redirect_uris = excluded.redirect_uris, fetched_at = now()
   where c.kind = 'cimd';
end; $$;
revoke execute on function public.mcp_oauth_upsert_cimd_client(text, text, text, text[]) from public, anon, authenticated;

-- Is this app known, and is this one of its addresses? The consent page asks
-- through the edge function before showing anything: a bad answer never redirects.
create or replace function public.mcp_oauth_client_check(p_client_id text, p_redirect_uri text)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare c public.mcp_oauth_clients;
begin
  select * into c from public.mcp_oauth_clients x where x.client_id = p_client_id;
  if c.client_id is null then return jsonb_build_object('ok', false, 'reason', 'unknown_client'); end if;
  if not public.mcp_oauth_redirect_matches(c.redirect_uris, p_redirect_uri) then
    return jsonb_build_object('ok', false, 'reason', 'bad_redirect', 'kind', c.kind);
  end if;
  return jsonb_build_object('ok', true, 'kind', c.kind, 'client_name', c.client_name, 'client_uri', c.client_uri,
    'fetched_at', c.fetched_at);
end; $$;
revoke execute on function public.mcp_oauth_client_check(text, text) from public, anon, authenticated;

-- ---------- 6. tokens ----------
-- A new access + refresh pair for a grant (the caller holds the grant's row lock).
create or replace function public.mcp_oauth_mint(p_grant public.mcp_oauth_grants)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  at text := 'kmcp_at_' || public.kanbo_random_token(32);
  rt text := 'kmcp_rt_' || public.kanbo_random_token(32);
begin
  insert into public.mcp_oauth_access_tokens (token_hash, grant_id, expires_at)
  values (public.api_key_digest(at), p_grant.id, now() + interval '1 hour');
  insert into public.mcp_oauth_refresh_tokens (token_hash, grant_id) values (public.api_key_digest(rt), p_grant.id);
  update public.mcp_oauth_grants g set refresh_expires_at = now() + interval '90 days' where g.id = p_grant.id;
  delete from public.mcp_oauth_access_tokens a where a.grant_id = p_grant.id and a.expires_at < now();
  delete from public.mcp_oauth_refresh_tokens r where r.grant_id = p_grant.id and r.used_at < now() - interval '90 days';
  return jsonb_build_object('access_token', at, 'token_type', 'Bearer', 'expires_in', 3600,
    'refresh_token', rt, 'scope', p_grant.scope);
end; $$;
revoke execute on function public.mcp_oauth_mint(public.mcp_oauth_grants) from public, anon, authenticated;

create or replace function public.mcp_oauth_revoke(p_grant uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.mcp_oauth_grants g set revoked_at = coalesce(g.revoked_at, now()), revoked_reason = coalesce(g.revoked_reason, p_reason)
   where g.id = p_grant;
  delete from public.mcp_oauth_access_tokens a where a.grant_id = p_grant;
end; $$;
revoke execute on function public.mcp_oauth_revoke(uuid, text) from public, anon, authenticated;

-- May this grant's person still use it? (every token, every refresh)
create or replace function public.mcp_oauth_person_ok(p_user uuid, p_workspace uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.user_can_act(p_user)
     and (p_workspace is null or public.user_ws_role(p_user, p_workspace) <> 'none');
$$;
revoke execute on function public.mcp_oauth_person_ok(uuid, uuid) from public, anon, authenticated;

-- authorization_code. Answers JSON (never raises), so a burned code stays burned.
create or replace function public.mcp_oauth_exchange_code(p_code text, p_verifier text, p_client_id text, p_redirect_uri text, p_resource text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c public.mcp_oauth_codes;
  g public.mcp_oauth_grants;
  bad constant jsonb := jsonb_build_object('error', 'invalid_grant', 'error_description', 'This sign-in code isn''t valid any more. Start connecting again.');
begin
  if coalesce(p_code, '') !~ '^kmcp_ac_[A-Za-z0-9_-]{43}$' then return bad; end if;
  select * into c from public.mcp_oauth_codes x where x.code_hash = public.api_key_digest(p_code) for update;
  if c.code_hash is null then return bad; end if;
  if c.used_at is not null then
    -- a code used twice: whoever holds its tokens may not be who they say
    if c.grant_id is not null then perform public.mcp_oauth_revoke(c.grant_id, 'code_reuse'); end if;
    return bad;
  end if;
  -- spent from here on, whatever happens next
  update public.mcp_oauth_codes x set used_at = now() where x.code_hash = c.code_hash;
  if c.expires_at <= now() or c.client_id is distinct from p_client_id or c.redirect_uri is distinct from p_redirect_uri then return bad; end if;
  if coalesce(p_verifier, '') !~ '^[A-Za-z0-9._~-]{43,128}$' then return bad; end if;
  if translate(encode(sha256(convert_to(p_verifier, 'UTF8')), 'base64'), '+/=', '-_') <> c.code_challenge then return bad; end if;
  if p_resource is not null and p_resource <> c.resource then
    return jsonb_build_object('error', 'invalid_target', 'error_description', 'This server is ' || public.mcp_oauth_resource() || '.');
  end if;
  if not public.mcp_oauth_person_ok(c.user_id, c.workspace_id) then return bad; end if;
  insert into public.mcp_oauth_grants (client_id, user_id, workspace_id, access, scope, resource)
  values (c.client_id, c.user_id, c.workspace_id, c.access, c.scope, c.resource)
  returning * into g;
  update public.mcp_oauth_codes x set grant_id = g.id where x.code_hash = c.code_hash;
  return public.mcp_oauth_mint(g);
end; $$;
revoke execute on function public.mcp_oauth_exchange_code(text, text, text, text, text) from public, anon, authenticated;

-- refresh_token: rotates. The token just replaced is honoured for 10 seconds, once
-- the answer may have been lost; any other replay revokes the grant.
create or replace function public.mcp_oauth_refresh(p_token text, p_client_id text, p_resource text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  d text;
  r public.mcp_oauth_refresh_tokens;
  g public.mcp_oauth_grants;
  rate record;
  bad constant jsonb := jsonb_build_object('error', 'invalid_grant', 'error_description', 'This connection has ended. Connect the app to Kanbo again.');
begin
  if coalesce(p_token, '') !~ '^kmcp_rt_[A-Za-z0-9_-]{43}$' then return bad; end if;
  d := public.api_key_digest(p_token);
  select * into r from public.mcp_oauth_refresh_tokens x where x.token_hash = d;
  if r.token_hash is null then return bad; end if;
  select * into g from public.mcp_oauth_grants x where x.id = r.grant_id for update;
  select * into r from public.mcp_oauth_refresh_tokens x where x.token_hash = d;
  if g.id is null or g.client_id is distinct from p_client_id then return bad; end if;
  if g.revoked_at is not null then return bad; end if;
  if p_resource is not null and p_resource <> g.resource then
    return jsonb_build_object('error', 'invalid_target', 'error_description', 'This server is ' || public.mcp_oauth_resource() || '.');
  end if;
  if g.refresh_expires_at <= now() or g.resource is distinct from public.mcp_oauth_resource() then return bad; end if;
  if not public.mcp_oauth_person_ok(g.user_id, g.workspace_id) then return bad; end if;
  -- a limit only a real token can reach, so it costs nobody else anything. An hour apart is
  -- normal; this stops a connection growing the token tables in a loop. The token isn't spent.
  select * into rate from public.api_rate_hit('kanbo:mcp:refresh:' || g.id::text, 60, 30);
  if not rate.allowed then
    return jsonb_build_object('error', 'slow_down', 'retry_after', rate.retry_after);
  end if;
  if r.used_at is not null then
    if not (r.token_hash = g.prev_refresh_hash and r.used_at >= now() - interval '10 seconds') then
      perform public.mcp_oauth_revoke(g.id, 'refresh_reuse');
      return bad;
    end if;
    -- the answer to the first use never arrived: its replacement goes, and a new pair comes
    update public.mcp_oauth_refresh_tokens x set used_at = now() where x.grant_id = g.id and x.used_at is null;
  else
    update public.mcp_oauth_refresh_tokens x set used_at = now() where x.token_hash = d;
    update public.mcp_oauth_grants x set prev_refresh_hash = d where x.id = g.id;
  end if;
  return public.mcp_oauth_mint(g);
end; $$;
revoke execute on function public.mcp_oauth_refresh(text, text, text) from public, anon, authenticated;

-- The revocation endpoint: either kind of token ends the whole connection. Silent
-- about whether anything was there (RFC 7009).
create or replace function public.mcp_oauth_revoke_token(p_token text, p_client_id text)
returns void language plpgsql security definer set search_path = public as $$
declare gid uuid; d text;
begin
  if coalesce(p_token, '') !~ '^kmcp_(at|rt)_[A-Za-z0-9_-]{43}$' then return; end if;
  d := public.api_key_digest(p_token);
  select a.grant_id into gid from public.mcp_oauth_access_tokens a where a.token_hash = d;
  if gid is null then select r.grant_id into gid from public.mcp_oauth_refresh_tokens r where r.token_hash = d; end if;
  if gid is null then return; end if;
  if p_client_id is not null and not exists (select 1 from public.mcp_oauth_grants g where g.id = gid and g.client_id = p_client_id) then return; end if;
  perform public.mcp_oauth_revoke(gid, 'client_revoked');
end; $$;
revoke execute on function public.mcp_oauth_revoke_token(text, text) from public, anon, authenticated;

-- Every MCP call with an OAuth token: who is this, and may they still? No row when
-- the token is malformed, unknown or expired, the grant is revoked, the token was
-- issued for another audience, the person can't act (suspended, unapproved, deleted)
-- or has left the grant's workspace. Raises while the "api key scope" policies are
-- missing for a one-workspace grant, as verify_api_key does.
create or replace function public.mcp_verify_token(p_token text, p_resource text)
returns table (grant_id uuid, user_id uuid, workspace_id uuid, access text, client_id text, client_name text)
language plpgsql security definer set search_path = public as $$
#variable_conflict use_column
declare g public.mcp_oauth_grants; nm text;
begin
  if coalesce(p_token, '') !~ '^kmcp_at_[A-Za-z0-9_-]{43}$' then return; end if;
  select gr.* into g
    from public.mcp_oauth_access_tokens t join public.mcp_oauth_grants gr on gr.id = t.grant_id
   where t.token_hash = public.api_key_digest(p_token) and t.expires_at > now();
  if g.id is null or g.revoked_at is not null then return; end if;
  if g.resource is distinct from p_resource then return; end if;
  if not public.mcp_oauth_person_ok(g.user_id, g.workspace_id) then return; end if;
  if g.workspace_id is not null and not public.api_scope_intact() then
    raise exception 'api key scope incomplete: run 0046_api_webhooks_notion.sql again';
  end if;
  if g.last_used_at is null or g.last_used_at < now() - interval '1 minute' then
    update public.mcp_oauth_grants x set last_used_at = now() where x.id = g.id;
  end if;
  select c.client_name into nm from public.mcp_oauth_clients c where c.client_id = g.client_id;
  grant_id := g.id; user_id := g.user_id; workspace_id := g.workspace_id; access := g.access;
  client_id := g.client_id; client_name := nm;
  return next;
end; $$;
revoke execute on function public.mcp_verify_token(text, text) from public, anon, authenticated;

-- ---------- 7. signed-in people ----------
-- The consent page's Allow. Checks everything again here: the page is only a page.
-- Returns the one-time code; the page sends the browser back with it.
create or replace function public.mcp_oauth_approve(
  p_client_id text, p_redirect_uri text, p_code_challenge text, p_resource text, p_scope text, p_access text, p_workspace uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  c public.mcp_oauth_clients;
  rate record;
  acc text := lower(btrim(coalesce(p_access, '')));
  res text := coalesce(nullif(btrim(coalesce(p_resource, '')), ''), public.mcp_oauth_resource());
  want text[] := regexp_split_to_array(btrim(coalesce(p_scope, '')), '\s+');
  sc text;
  plain text := 'kmcp_ac_' || public.kanbo_random_token(32);
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into rate from public.api_rate_hit('kanbo:mcp:authorize:' || me::text, 60, 30);
  if not rate.allowed then raise exception 'rate limited'; end if;
  select * into c from public.mcp_oauth_clients x where x.client_id = p_client_id;
  if c.client_id is null then raise exception 'invalid client'; end if;
  if not public.mcp_oauth_redirect_matches(c.redirect_uris, p_redirect_uri) then raise exception 'invalid redirect'; end if;
  if coalesce(p_code_challenge, '') !~ '^[A-Za-z0-9_-]{43}$' then raise exception 'invalid challenge'; end if;
  if res <> public.mcp_oauth_resource() then raise exception 'invalid target'; end if;
  if acc not in ('read', 'write') then raise exception 'invalid access'; end if;
  -- an app that only asked to read can't be given more
  if acc = 'write' and btrim(coalesce(p_scope, '')) <> '' and not ('kanbo.write' = any (want)) then raise exception 'invalid access'; end if;
  if p_workspace is not null and public.ws_role(p_workspace) = 'none' then raise exception 'not allowed'; end if;
  sc := case acc when 'write' then 'kanbo.read kanbo.write' else 'kanbo.read' end
        || case when 'offline_access' = any (want) then ' offline_access' else '' end;
  perform public.mcp_oauth_sweep();
  -- a person's connections are bounded: the least recently used makes way
  perform public.mcp_oauth_revoke(x.id, 'too_many')
     from (select g.id from public.mcp_oauth_grants g
            where g.user_id = me and g.revoked_at is null
            order by coalesce(g.last_used_at, g.created_at) desc offset 49) x;
  insert into public.mcp_oauth_codes (code_hash, client_id, user_id, workspace_id, redirect_uri, code_challenge, resource, access, scope, expires_at)
  values (public.api_key_digest(plain), c.client_id, me, p_workspace, p_redirect_uri, p_code_challenge, res, acc, sc, now() + interval '5 minutes');
  return jsonb_build_object('code', plain, 'expires_in', 300);
end; $$;
revoke execute on function public.mcp_oauth_approve(text, text, text, text, text, text, uuid) from public, anon;
grant execute on function public.mcp_oauth_approve(text, text, text, text, text, text, uuid) to authenticated;

-- Settings › Developers › Connected AI apps: your live connections, newest first.
create or replace function public.mcp_oauth_list_grants()
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not authorized'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', g.id, 'client_name', c.client_name, 'client_kind', c.kind,
      'client_host', case when c.kind = 'cimd' then substring(c.client_id from '^https://([^/:?#]+)') end,
      'access', g.access, 'workspace_id', g.workspace_id, 'workspace_name', w.name,
      'created_at', g.created_at, 'last_used_at', g.last_used_at)
      order by g.created_at desc, g.id)
      from public.mcp_oauth_grants g
      join public.mcp_oauth_clients c on c.client_id = g.client_id
      left join public.workspaces w on w.id = g.workspace_id
     where g.user_id = me and g.revoked_at is null and g.refresh_expires_at > now()), '[]'::jsonb);
end; $$;
revoke execute on function public.mcp_oauth_list_grants() from public, anon;
grant execute on function public.mcp_oauth_list_grants() to authenticated;

-- Revoke: your own connection only. It stops working on its next call.
create or replace function public.mcp_oauth_revoke_grant(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.mcp_oauth_grants g where g.id = p_id and g.user_id = auth.uid()) then
    raise exception 'not found';                  -- same answer whether it's gone or not yours
  end if;
  perform public.mcp_oauth_revoke(p_id, 'person_revoked');
  return jsonb_build_object('id', p_id, 'revoked', true);
end; $$;
revoke execute on function public.mcp_oauth_revoke_grant(uuid) from public, anon;
grant execute on function public.mcp_oauth_revoke_grant(uuid) to authenticated;

-- ---------- 8. the service role's reach, where that role exists ----------
do $svc$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update, delete on public.mcp_oauth_clients, public.mcp_oauth_grants, public.mcp_oauth_codes,
      public.mcp_oauth_access_tokens, public.mcp_oauth_refresh_tokens to service_role;
    grant execute on function public.mcp_oauth_register_client(text, text, text[]) to service_role;
    grant execute on function public.mcp_oauth_upsert_cimd_client(text, text, text, text[]) to service_role;
    grant execute on function public.mcp_oauth_client_check(text, text) to service_role;
    grant execute on function public.mcp_oauth_exchange_code(text, text, text, text, text) to service_role;
    grant execute on function public.mcp_oauth_refresh(text, text, text) to service_role;
    grant execute on function public.mcp_oauth_revoke_token(text, text) to service_role;
    grant execute on function public.mcp_verify_token(text, text) to service_role;
    grant execute on function public.mcp_oauth_sweep() to service_role;
  end if;
end $svc$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0050') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0050')                          as recorded,
--   (select bool_and(relrowsecurity) from pg_class where oid in ('public.mcp_oauth_clients'::regclass,
--     'public.mcp_oauth_grants'::regclass, 'public.mcp_oauth_codes'::regclass,
--     'public.mcp_oauth_access_tokens'::regclass, 'public.mcp_oauth_refresh_tokens'::regclass))     as rls_on,
--   not has_table_privilege('authenticated', 'public.mcp_oauth_grants', 'select')
--   and not has_table_privilege('anon', 'public.mcp_oauth_access_tokens', 'select')                 as tokens_server_only,
--   not has_function_privilege('authenticated', 'public.mcp_verify_token(text, text)', 'execute')
--   and not has_function_privilege('authenticated', 'public.mcp_oauth_exchange_code(text, text, text, text, text)', 'execute') as server_functions_private,
--   has_function_privilege('authenticated', 'public.mcp_oauth_approve(text, text, text, text, text, text, uuid)', 'execute')
--   and not has_function_privilege('anon', 'public.mcp_oauth_approve(text, text, text, text, text, text, uuid)', 'execute')    as consent_signed_in_only;
-- ============================================================
