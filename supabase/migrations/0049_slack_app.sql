-- ============================================================
-- KANBO — the Kanbo Slack app (2026-10-20): /kanbo, "Create a Kanbo task"
-- on any message, link previews (unfurls) and a Home tab. Additive: nothing
-- existing changes shape or behaviour for the app, the API or webhooks.
--
--   1. slack_teams: the Slack workspaces the app has been used in, and the
--      Kanbo workspace each one adds tasks to (default_workspace_id). No
--      client reads the table: members see slack_app_status(ws). Choosing
--      it takes both sides' say-so (slack_app_set_default(team, ws)): an
--      owner or admin OF THE SLACK WORKSPACE (Slack says so, and has said so
--      in the last 24 hours: slack_admin_state) who is also an owner or
--      admin of the Kanbo workspace. Anyone can make a Kanbo workspace of
--      their own, so Kanbo rights alone never decide where a Slack
--      workspace's tasks go; a Slack owner/admin can always point it
--      somewhere else, so nobody can squat it. Clearing it (back to
--      Personal lists): that Slack owner/admin, or an owner/admin of the
--      Kanbo workspace it points at.
--   2. slack_user_links: "this Slack person is this Kanbo person". A Slack
--      user id means nothing to Kanbo until its owner links it: the
--      slack-app function only ever acts for a linked person, and always AS
--      them (RLS). Your own rows: read and delete (Unlink) only; links are
--      only ever made by claim_slack_link(). One Kanbo person may link
--      several Slack accounts (several Slack workspaces). slack_admin: Slack
--      says this person is an owner or admin of that Slack workspace, as of
--      slack_admin_checked_at (users.info when the link was offered; again
--      whenever they use /kanbo or open the Home tab; and Slack's own
--      user_change event the moment Slack demotes or deactivates them). A
--      flag Slack hasn't confirmed for 24 hours decides nothing: someone
--      Slack has since demoted can't use an old "yes" (they're told to open
--      the Home tab or run /kanbo, so Kanbo asks Slack again).
--   3. slack_link_requests (service only): the one-time "Link your Kanbo
--      account" link /kanbo shows an unlinked person, stored as the SHA-256
--      of a 256-bit random token the slack-app function made. 15 minutes,
--      single use. claim_slack_link(token) — signed in, approved, not
--      suspended — makes the link; slack_link_preview(token) says whose
--      Slack account it is first (the /link/slack page). When the Slack
--      account's email isn't the Kanbo account's, claiming needs an explicit
--      "yes, this is me" (p_accept_mismatch), so a link someone else sends
--      you can't quietly tie their Slack account to your Kanbo account.
--   4. tasks.slack_permalink: the Slack message a task was made from (the
--      "From Slack" chip in the task, slackPermalink in the API and in
--      webhook payloads). Nullable; only a Slack message link is accepted.
--      Not one of the columns whose change is a task.updated webhook.
--
-- Needs 0043. Works with or without 0044–0048 (references none of their
-- objects). Idempotent: safe to run more than once (re-running keeps every
-- team, link and permalink). Owners of this file: docs/integrations/slack-app.md.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.workspace_integrations') is null
     or (to_regclass('public.schema_migrations') is not null
         and not exists (select 1 from public.schema_migrations where version = '0043')) then
    raise exception '0049 needs 0043 first: run 0043_integrations_push_forms_plans.sql, then this file';
  end if;
end $pre$;

-- ---------- 1. slack_teams (no client access) ----------
create table if not exists public.slack_teams (
  team_id              text primary key,
  team_name            text,
  default_workspace_id uuid references public.workspaces (id) on delete set null,
  -- who last chose the Kanbo workspace, and when
  connected_by         uuid references auth.users (id) on delete set null,
  default_set_at       timestamptz,
  -- when this Slack workspace first used Kanbo
  connected_at         timestamptz not null default now()
);
alter table public.slack_teams drop constraint if exists slack_teams_shape;
alter table public.slack_teams add constraint slack_teams_shape check (
  team_id ~ '^[A-Z0-9]{2,32}$' and (team_name is null or length(team_name) <= 200));
create index if not exists slack_teams_default_ws_idx on public.slack_teams (default_workspace_id) where default_workspace_id is not null;
alter table public.slack_teams enable row level security;
revoke all on public.slack_teams from anon, authenticated;
do $st$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'slack_teams' loop
    execute format('drop policy %I on public.slack_teams', pol.policyname);
  end loop;
end $st$;

-- ---------- 2. slack_user_links (own rows: read + delete) ----------
create table if not exists public.slack_user_links (
  team_id         text not null references public.slack_teams (team_id) on delete cascade,
  slack_user_id   text not null,
  user_id         uuid not null references auth.users (id) on delete cascade,
  slack_user_name text,
  linked_at       timestamptz not null default now(),
  primary key (team_id, slack_user_id)
);
alter table public.slack_user_links drop constraint if exists slack_user_links_shape;
alter table public.slack_user_links add constraint slack_user_links_shape check (
  slack_user_id ~ '^[A-Z0-9]{2,32}$' and (slack_user_name is null or length(slack_user_name) <= 200));
-- Slack says they're an owner or admin of that Slack workspace (users.info is_owner / is_admin)…
alter table public.slack_user_links add column if not exists slack_admin boolean not null default false;
-- …as of when Slack last said so (null: never confirmed, which counts as out of date)
alter table public.slack_user_links add column if not exists slack_admin_checked_at timestamptz;
create index if not exists slack_user_links_user_idx on public.slack_user_links (user_id);
alter table public.slack_user_links enable row level security;
revoke all on public.slack_user_links from anon, authenticated;
grant select, delete on public.slack_user_links to authenticated;
drop policy if exists "slack links: read own" on public.slack_user_links;
drop policy if exists "slack links: unlink own" on public.slack_user_links;
create policy "slack links: read own" on public.slack_user_links
  for select to authenticated using (user_id = auth.uid());
create policy "slack links: unlink own" on public.slack_user_links
  for delete to authenticated using (user_id = auth.uid());

-- ---------- 3. slack_link_requests (service only) ----------
create table if not exists public.slack_link_requests (
  token_hash      text primary key,
  team_id         text not null,
  team_name       text,
  slack_user_id   text not null,
  slack_user_name text,
  -- the Slack profile's email (users:read.email), when Slack gave one
  slack_email     text,
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '15 minutes'),
  used_at         timestamptz,
  used_by         uuid references auth.users (id) on delete set null
);
alter table public.slack_link_requests drop constraint if exists slack_link_requests_shape;
alter table public.slack_link_requests add constraint slack_link_requests_shape check (
  token_hash ~ '^[0-9a-f]{64}$'
  and team_id ~ '^[A-Z0-9]{2,32}$' and slack_user_id ~ '^[A-Z0-9]{2,32}$'
  and (team_name is null or length(team_name) <= 200)
  and (slack_user_name is null or length(slack_user_name) <= 200)
  and (slack_email is null or length(slack_email) <= 320)
  and expires_at <= created_at + interval '15 minutes');
-- users.info said they're an owner or admin of the Slack workspace (copied to the link)
alter table public.slack_link_requests add column if not exists slack_admin boolean not null default false;
create index if not exists slack_link_requests_user_idx on public.slack_link_requests (team_id, slack_user_id);
create index if not exists slack_link_requests_expiry_idx on public.slack_link_requests (expires_at);
alter table public.slack_link_requests enable row level security;
revoke all on public.slack_link_requests from anon, authenticated;
do $lr$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'slack_link_requests' loop
    execute format('drop policy %I on public.slack_link_requests', pol.policyname);
  end loop;
end $lr$;

-- ---------- 4. tasks.slack_permalink ----------
alter table public.tasks add column if not exists slack_permalink text;
alter table public.tasks drop constraint if exists tasks_slack_permalink_shape;
-- NOT VALID then VALIDATE: the check doesn't hold a write lock on tasks while it reads them
alter table public.tasks add constraint tasks_slack_permalink_shape check (
  slack_permalink is null or (
    length(slack_permalink) <= 500
    and slack_permalink ~ '^https://[A-Za-z0-9-]+(\.enterprise)?\.slack\.com/archives/[A-Z0-9]+/p[0-9]+(\?[A-Za-z0-9=&._%-]*)?$')) not valid;
alter table public.tasks validate constraint tasks_slack_permalink_shape;

-- ---------- 5. functions ----------
-- the token as stored: SHA-256, hex
create or replace function public.slack_link_token_hash(p_token text)
returns text language sql immutable set search_path = pg_catalog as $$
  select encode(sha256(convert_to(coalesce(p_token, ''), 'UTF8')), 'hex');
$$;
revoke execute on function public.slack_link_token_hash(text) from public, anon, authenticated;

-- Is this Kanbo person an owner or admin of this Slack workspace, as Slack
-- says? 'current': one of their links there says so, confirmed by Slack in
-- the last 24 hours. 'stale': it said so, but not in the last 24 hours (Slack
-- may have demoted or deactivated them since: it decides nothing until Kanbo
-- asks again). 'none': no. Only for the functions below (no client calls it).
create or replace function public.slack_admin_state(p_team text, p_user uuid)
returns text language sql stable set search_path = public as $$
  select case
    when bool_or(l.slack_admin and l.slack_admin_checked_at > now() - interval '24 hours') then 'current'
    when bool_or(l.slack_admin) then 'stale'
    else 'none' end
    from public.slack_user_links l where l.team_id = p_team and l.user_id = p_user;
$$;
revoke execute on function public.slack_admin_state(text, uuid) from public, anon, authenticated;

-- What the Slack app looks like from a Kanbo workspace (null for anyone who
-- isn't in it; p_ws null = just your own links). Never another person's links.
--   teams: the Slack workspaces you've linked an account in, and any whose
--          Kanbo workspace is this one: team_id, team_name, connected_at,
--          is_default_here, default_workspace_id / _name (only when you're in
--          that workspace; default_elsewhere says it points somewhere else),
--          linked (you have an account linked there), slack_admin (…as a
--          Slack owner/admin, confirmed by Slack in the last 24 hours),
--          slack_admin_stale (…Slack said so, but not in the last 24 hours:
--          open the Home tab or run /kanbo so Kanbo asks again),
--          can_set_default (you may point it at THIS workspace), can_clear
--          (you may set it back to Personal lists)
--   links: your own linked Slack accounts
create or replace function public.slack_app_status(p_ws uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  me   uuid := auth.uid();
  role text := 'none';
begin
  if me is null or not public.can_act() then return null; end if;
  if p_ws is not null then
    if not public.is_member(p_ws) then return null; end if;
    role := public.ws_role(p_ws);
  end if;
  return jsonb_build_object(
    'workspace_id', p_ws,
    'can_manage', role in ('owner', 'admin'),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object(
          'team_id', t.team_id,
          'team_name', t.team_name,
          'connected_at', t.connected_at,
          'default_set_at', case when t.default_workspace_id is not null and public.is_member(t.default_workspace_id) then t.default_set_at end,
          'is_default_here', coalesce(p_ws is not null and t.default_workspace_id = p_ws, false),
          'default_workspace_id', case when t.default_workspace_id is not null and public.is_member(t.default_workspace_id) then t.default_workspace_id end,
          'default_workspace_name', case when t.default_workspace_id is not null and public.is_member(t.default_workspace_id)
                                         then (select w.name from public.workspaces w where w.id = t.default_workspace_id) end,
          'default_elsewhere', t.default_workspace_id is not null and t.default_workspace_id is distinct from p_ws,
          'linked', exists (select 1 from public.slack_user_links l where l.team_id = t.team_id and l.user_id = me),
          'slack_admin', public.slack_admin_state(t.team_id, me) = 'current',
          'slack_admin_stale', public.slack_admin_state(t.team_id, me) = 'stale',
          'can_set_default', role in ('owner', 'admin') and public.slack_admin_state(t.team_id, me) = 'current',
          'can_clear', t.default_workspace_id is not null
                       and exists (select 1 from public.slack_user_links l where l.team_id = t.team_id and l.user_id = me)
                       and (public.slack_admin_state(t.team_id, me) = 'current'
                            or public.ws_role(t.default_workspace_id) in ('owner', 'admin')))
        order by lower(coalesce(t.team_name, t.team_id)), t.team_id)
        from public.slack_teams t
       where exists (select 1 from public.slack_user_links l where l.team_id = t.team_id and l.user_id = me)
          or (p_ws is not null and t.default_workspace_id = p_ws)), '[]'::jsonb),
    'links', coalesce((
      select jsonb_agg(jsonb_build_object(
          'team_id', l.team_id,
          'team_name', t.team_name,
          'slack_user_id', l.slack_user_id,
          'slack_user_name', l.slack_user_name,
          'linked_at', l.linked_at)
        order by lower(coalesce(t.team_name, l.team_id)), l.linked_at)
        from public.slack_user_links l left join public.slack_teams t on t.team_id = l.team_id
       where l.user_id = me), '[]'::jsonb));
end; $$;

-- Point a Slack workspace's /kanbo at a Kanbo workspace (p_ws null = at none).
-- You must have linked your own Slack account in that Slack workspace.
--   choosing p_ws: Slack says you're an owner or admin of the Slack workspace
--     (and has said so in the last 24 hours: slack_admin_state 'current'),
--     and you're an owner or admin of p_ws. Whatever it pointed at before:
--     the Slack workspace's own owners and admins decide where its tasks go
--     (anyone can make a Kanbo workspace and be its owner, so that alone
--     never wins, and nobody can hold a Slack workspace by getting there first).
--   clearing it: a Slack owner/admin there (as above), or an owner/admin of
--     the Kanbo workspace it points at now (a Kanbo workspace can always stop
--     taking tasks from a Slack workspace).
-- Errors: 'not allowed'; 'slack admin check needed' when only an out-of-date
-- Slack "owner or admin" stands in the way (open the Kanbo Home tab in Slack
-- or run /kanbo, so Kanbo asks Slack again, then try again).
create or replace function public.slack_app_set_default(p_team text, p_ws uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me    uuid := auth.uid();
  cur   uuid;
  admin text;
begin
  if me is null or not public.can_act() or p_team is null then raise exception 'not allowed'; end if;
  if not exists (select 1 from public.slack_user_links l where l.team_id = p_team and l.user_id = me) then
    raise exception 'not allowed';   -- no Slack account of yours is linked there
  end if;
  select default_workspace_id into cur from public.slack_teams where team_id = p_team for update;
  if not found then raise exception 'not allowed'; end if;
  -- read after the row lock: a demotion (user_change) that landed meanwhile counts
  admin := public.slack_admin_state(p_team, me);
  if p_ws is not null then
    if public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not allowed'; end if;
    if admin = 'stale' then raise exception 'slack admin check needed'; end if;
    if admin <> 'current' then raise exception 'not allowed'; end if;
  elsif admin <> 'current' and (cur is null or public.ws_role(cur) not in ('owner', 'admin')) then
    if admin = 'stale' then raise exception 'slack admin check needed'; end if;
    raise exception 'not allowed';
  end if;
  update public.slack_teams
     set default_workspace_id = p_ws, connected_by = me, default_set_at = now()
   where team_id = p_team;
  return public.slack_app_status(coalesce(p_ws, cur));
end; $$;

-- Whose Slack account a link is for, before you claim it (the /link/slack
-- page). null when there's no such link; {status: 'used' | 'expired'} once it
-- can't be claimed; otherwise its Slack workspace and person, and whether the
-- Slack account's email is your Kanbo email.
create or replace function public.slack_link_preview(p_token text)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  me uuid := auth.uid();
  r  public.slack_link_requests;
  my_email text;
begin
  if me is null or not public.can_act() then raise exception 'not allowed'; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then return null; end if;
  select * into r from public.slack_link_requests where token_hash = public.slack_link_token_hash(p_token);
  if not found then return null; end if;
  if r.used_at is not null then return jsonb_build_object('status', 'used'); end if;
  if r.expires_at <= now() then return jsonb_build_object('status', 'expired'); end if;
  select lower(btrim(u.email)) into my_email from auth.users u where u.id = me;
  return jsonb_build_object(
    'status', 'ok',
    'team_id', r.team_id,
    'team_name', coalesce((select t.team_name from public.slack_teams t where t.team_id = r.team_id), r.team_name),
    'slack_user_id', r.slack_user_id,
    'slack_user_name', r.slack_user_name,
    'expires_at', r.expires_at,
    'has_email', r.slack_email is not null,
    'email_matches', r.slack_email is not null and lower(btrim(r.slack_email)) = my_email,
    'already_linked', exists (select 1 from public.slack_user_links l
                               where l.team_id = r.team_id and l.slack_user_id = r.slack_user_id and l.user_id = me));
end; $$;

-- Claim a link: signed in, approved and not suspended; the link unused and
-- under 15 minutes old. Single use. Links this Slack account to you (moving
-- it from anyone it was linked to before: the token proves the Slack side).
-- Errors: 'not allowed' | 'invalid link' | 'link already used' |
--         'link expired' | 'email mismatch' (claim again with p_accept_mismatch)
create or replace function public.claim_slack_link(p_token text, p_accept_mismatch boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  h  text;
  r  public.slack_link_requests;
  my_email text;
  at timestamptz := now();
begin
  if me is null or not public.can_act() then raise exception 'not allowed'; end if;
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{32,128}$' then raise exception 'invalid link'; end if;
  h := public.slack_link_token_hash(p_token);
  select * into r from public.slack_link_requests where token_hash = h for update;
  if not found then raise exception 'invalid link'; end if;
  if r.used_at is not null then raise exception 'link already used'; end if;
  if r.expires_at <= at then raise exception 'link expired'; end if;
  select lower(btrim(u.email)) into my_email from auth.users u where u.id = me;
  -- no email from Slack, or a different one: only with an explicit "this is me"
  if not coalesce(p_accept_mismatch, false)
     and (r.slack_email is null or lower(btrim(r.slack_email)) is distinct from my_email) then
    raise exception 'email mismatch';
  end if;
  update public.slack_link_requests set used_at = at, used_by = me where token_hash = h;
  insert into public.slack_teams as t (team_id, team_name) values (r.team_id, r.team_name)
  on conflict (team_id) do update set team_name = coalesce(excluded.team_name, t.team_name);
  -- Slack's answer is as of when the link was offered (users.info, then): that's its age
  insert into public.slack_user_links as l (team_id, slack_user_id, user_id, slack_user_name, linked_at, slack_admin, slack_admin_checked_at)
  values (r.team_id, r.slack_user_id, me, r.slack_user_name, at, r.slack_admin, r.created_at)
  on conflict (team_id, slack_user_id) do update
     set user_id = excluded.user_id, slack_user_name = excluded.slack_user_name, linked_at = excluded.linked_at,
         slack_admin = excluded.slack_admin, slack_admin_checked_at = excluded.slack_admin_checked_at;
  return jsonb_build_object(
    'team_id', r.team_id,
    'team_name', (select t.team_name from public.slack_teams t where t.team_id = r.team_id),
    'slack_user_id', r.slack_user_id,
    'slack_user_name', r.slack_user_name,
    'linked_at', at);
end; $$;

revoke execute on function public.slack_app_status(uuid) from public, anon;
revoke execute on function public.slack_app_set_default(text, uuid) from public, anon;
revoke execute on function public.slack_link_preview(text) from public, anon;
revoke execute on function public.claim_slack_link(text, boolean) from public, anon;
grant execute on function public.slack_app_status(uuid) to authenticated;
grant execute on function public.slack_app_set_default(text, uuid) to authenticated;
grant execute on function public.slack_link_preview(text) to authenticated;
grant execute on function public.claim_slack_link(text, boolean) to authenticated;

-- the slack-app function connects as the database owner (SUPABASE_DB_URL);
-- service_role too, for anything that reads these through the REST API
do $svc$
begin
  grant select, insert, update, delete on public.slack_teams, public.slack_user_links, public.slack_link_requests to service_role;
  grant execute on function public.slack_link_token_hash(text) to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- done: record it ----------
do $rec$
begin
  if to_regclass('public.schema_migrations') is not null then
    insert into public.schema_migrations (version) values ('0049') on conflict (version) do nothing;
  end if;
end $rec$;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   (to_regclass('public.schema_migrations') is null
--    or exists (select 1 from public.schema_migrations where version = '0049'))            as recorded,
--   (select relrowsecurity from pg_class where oid = 'public.slack_teams'::regclass)
--   and not has_table_privilege('authenticated', 'public.slack_teams', 'select')           as teams_server_only,
--   (select relrowsecurity from pg_class where oid = 'public.slack_link_requests'::regclass)
--   and not has_table_privilege('authenticated', 'public.slack_link_requests', 'select')   as link_requests_server_only,
--   (select relrowsecurity from pg_class where oid = 'public.slack_user_links'::regclass)
--   and not has_table_privilege('authenticated', 'public.slack_user_links', 'insert')
--   and not has_table_privilege('authenticated', 'public.slack_user_links', 'update')      as links_own_read_delete,
--   (select count(*) from information_schema.columns where table_schema = 'public'
--     and table_name = 'slack_user_links' and column_name in ('slack_admin', 'slack_admin_checked_at')) = 2
--                                                                                          as links_slack_admin,
--   not has_function_privilege('authenticated', 'public.slack_admin_state(text, uuid)', 'execute')
--                                                                                          as admin_state_server_only,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'tasks' and column_name = 'slack_permalink')                as task_permalink,
--   (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--     and proname in ('slack_app_status','slack_app_set_default','slack_link_preview','claim_slack_link')) = 4
--                                                                                          as slack_app_functions;
-- ============================================================
