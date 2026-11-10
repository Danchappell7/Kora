-- ============================================================
-- KANBO — rolling Kanbo out to a business, and seeing how it's taking
-- (2026-11-10).
--
--   1. workspace_members.joined_at: when someone joined (an invite
--      claimed, or added as active). Set by a trigger, never by a client;
--      rows from before this file stay empty ("joined a while ago"). The
--      app's "Welcome to <workspace>" card on Today is for people who
--      joined in the last few weeks.
--   2. workspaces.rollout (jsonb; null = nothing planned yet): the
--      rollout checklist,
--        {"champion": "<user id>", "pilot": ["<user id>", …≤ 20],
--         "go_live": "YYYY-MM-DD"}   (each optional)
--      Owners and admins set it through set_workspace_rollout(ws, rollout);
--      the champion and the pilot group are the workspace's active
--      owners, admins and members (never a guest, never an outsider).
--   3. workspace_activity(ws): the Workspace health card's "active in the
--      last 7 days". For the workspace's owners and admins only. DAY-LEVEL
--      ONLY: for each active member, how many of the last 7 days they were
--      active and the last day they were (within 30 days), and how many
--      people were active on each of the last 7 days. Never a time of day.
--      Active means: opened Kanbo that day (public.sessions, 0016: the day
--      a session started and the day it was last seen), or worked in this
--      workspace (changed a task, commented on one, posted an update).
--      Days run in Europe/London.
--   4. Provisioning a business (platform admins only, is_admin()):
--      admin_provision_business(name, owner email, domain, pack) creates
--      the workspace (the admin owns it while they set it up), invites the
--      owner (as an admin until they join), pre-approves the company
--      domain (never a public mail domain; anyone already waiting from it
--      is let in, unless an admin revoked them) and records a handover.
--      When the invited owner joins (claim_invites), the trigger hands the
--      workspace to them: they become its owner, the admin who set it up
--      stays as an admin, and what the admin set up there (project owners,
--      open tasks assigned to them, goals and portfolios they own) becomes
--      theirs.
--      workspace_handovers has no client access at all.
--   5. admin_workspace_adoption(): per workspace, for platform admins:
--      people, invited, weekly active, tasks done in the last 7 days, the
--      last day anyone worked there, and a pending handover.
--
-- Needs 0041 (ws_role, can_act, approved_domains), 0042 (schema_migrations,
-- is_admin with suspension, access_revoked, claim_invites), 0016 (sessions),
-- 0032 (admin_audit) and 0038 (task_events). Works with or without
-- 0043–0057; goals change hands only once 0052's goals.owner_id is in.
-- Idempotent: safe to run more than once (re-running keeps every join
-- date, rollout plan and handover). 0041 drops the policies of the content
-- tables when it's run again: none here are on them (workspace_handovers
-- is its own table, with none), so nothing to restore. 0042 replaces
-- claim_invites: the handover is a trigger on workspace_members, so it
-- keeps working whichever claim_invites is in.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or to_regprocedure('public.is_admin()') is null or to_regprocedure('public.access_revoked(uuid)') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0058 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regclass('public.sessions') is null then raise exception '0058 needs public.sessions (0016)'; end if;
  if to_regclass('public.admin_audit') is null then raise exception '0058 needs public.admin_audit (0032)'; end if;
  if to_regclass('public.task_events') is null then raise exception '0058 needs public.task_events (0038)'; end if;
  if to_regclass('public.approved_domains') is null then raise exception '0058 needs public.approved_domains (0041)'; end if;
end $pre$;

-- ---------- 1. when someone joined ----------
alter table public.workspace_members add column if not exists joined_at timestamptz;

-- joined_at is the server's: set when a row becomes active, kept as it is otherwise
create or replace function public.member_joined_at() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.joined_at := case when new.status = 'active' then now() end;
  elsif new.status = 'active' and old.status is distinct from 'active' then
    new.joined_at := now();
  elsif new.status is distinct from 'active' then
    new.joined_at := null;
  else
    new.joined_at := old.joined_at;
  end if;
  return new;
end; $$;
revoke execute on function public.member_joined_at() from public, anon, authenticated;
drop trigger if exists trg_member_joined_at on public.workspace_members;
create trigger trg_member_joined_at before insert or update on public.workspace_members
  for each row execute function public.member_joined_at();

-- ---------- 2. the rollout checklist ----------
-- A rollout plan as stored: null, or the object above with nothing else in it.
create or replace function public.rollout_ok(r jsonb)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select r is null or (
    jsonb_typeof(r) = 'object'
    and pg_column_size(r) <= 2048
    and (r - 'champion' - 'pilot' - 'go_live') = '{}'::jsonb
    and (not (r ? 'champion') or jsonb_typeof(r -> 'champion') = 'null'
         or (jsonb_typeof(r -> 'champion') = 'string'
             and (r ->> 'champion') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'))
    and (not (r ? 'pilot') or (
         jsonb_typeof(r -> 'pilot') = 'array' and jsonb_array_length(r -> 'pilot') <= 20
         and not exists (select 1 from jsonb_array_elements(r -> 'pilot') e
                          where jsonb_typeof(e) <> 'string'
                             or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')))
    and (not (r ? 'go_live') or jsonb_typeof(r -> 'go_live') = 'null'
         or (jsonb_typeof(r -> 'go_live') = 'string' and (r ->> 'go_live') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
  );
$$;

alter table public.workspaces add column if not exists rollout jsonb;
alter table public.workspaces drop constraint if exists workspaces_rollout_ok;
alter table public.workspaces add constraint workspaces_rollout_ok check (public.rollout_ok(rollout));

-- The workspace's rollout plan: its owners and admins (null: start again). The champion and
-- the pilot group are people who can work here (active owners, admins and members).
create or replace function public.set_workspace_rollout(p_ws uuid, p_rollout jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb := case when p_rollout is null or jsonb_typeof(p_rollout) = 'null' then null else p_rollout end;
  ids uuid[];
begin
  if auth.uid() is null or public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if not public.rollout_ok(r) then raise exception 'invalid rollout plan'; end if;
  if r is not null then
    if jsonb_typeof(r -> 'champion') = 'string' and not exists (
         select 1 from public.workspace_members m
          where m.workspace_id = p_ws and m.user_id = (r ->> 'champion')::uuid
            and m.status = 'active' and m.role in ('owner', 'admin', 'member')) then
      raise exception 'the champion has to be a member of this workspace';
    end if;
    if r ? 'pilot' then
      select coalesce(array_agg(distinct (e #>> '{}')::uuid), '{}') into ids from jsonb_array_elements(r -> 'pilot') e;
      if exists (select 1 from unnest(ids) as i
                  where not exists (select 1 from public.workspace_members m
                                     where m.workspace_id = p_ws and m.user_id = i
                                       and m.status = 'active' and m.role in ('owner', 'admin', 'member'))) then
        raise exception 'everyone in the pilot group has to be a member of this workspace';
      end if;
      r := jsonb_set(r, '{pilot}', coalesce((select jsonb_agg(i::text order by i) from unnest(ids) as i), '[]'::jsonb));
    end if;
  end if;
  update public.workspaces set rollout = r where id = p_ws;
  return r;
end; $$;
revoke execute on function public.set_workspace_rollout(uuid, jsonb) from public, anon;
grant execute on function public.set_workspace_rollout(uuid, jsonb) to authenticated;

-- ---------- 3. active in the last 7 days, by day ----------
create or replace function public.workspace_activity(p_ws uuid)
returns json language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Europe/London')::date;
  week_from date := today - 6;
  month_from date := today - 29;
  floor_ts timestamptz := (today - 30)::timestamp at time zone 'Europe/London';
begin
  if auth.uid() is null or public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  return (
    with people as (
      select distinct m.user_id from public.workspace_members m
       where m.workspace_id = p_ws and m.status = 'active' and m.user_id is not null
    ),
    seen as (
      -- opened Kanbo (the day a session started, and the day it was last seen)
      select s.user_id, (s.started_at at time zone 'Europe/London')::date as day
        from public.sessions s where s.user_id in (select user_id from people) and s.started_at >= floor_ts
      union
      select s.user_id, (s.last_seen_at at time zone 'Europe/London')::date
        from public.sessions s where s.user_id in (select user_id from people) and s.last_seen_at >= floor_ts
      union
      -- worked here: changed a task, commented on one, posted an update
      select e.actor_id, (e.created_at at time zone 'Europe/London')::date
        from public.task_events e join public.tasks t on t.id = e.task_id
       where t.workspace_id = p_ws and e.created_at >= floor_ts and e.actor_id in (select user_id from people)
      union
      select c.user_id, (c.created_at at time zone 'Europe/London')::date
        from public.comments c join public.tasks t on t.id = c.task_id
       where t.workspace_id = p_ws and c.created_at >= floor_ts and c.user_id in (select user_id from people)
      union
      select u.user_id, (u.created_at at time zone 'Europe/London')::date
        from public.status_updates u
       where u.workspace_id = p_ws and u.created_at >= floor_ts and u.user_id in (select user_id from people)
    ),
    days as (select x.user_id, x.day from seen x where x.day between month_from and today)
    select json_build_object(
      'today', today,
      'members', coalesce((
        select json_agg(json_build_object(
                 'user_id', p.user_id,
                 'days', (select count(*) from days d where d.user_id = p.user_id and d.day >= week_from),
                 'last_day', (select max(d.day) from days d where d.user_id = p.user_id))
               order by p.user_id)
          from people p), '[]'::json),
      'days', (
        select json_agg(json_build_object('day', g.day, 'people', (select count(distinct d.user_id) from days d where d.day = g.day)) order by g.day)
          from (select (week_from + i) as day from generate_series(0, 6) as i) g)
    )
  );
end; $$;
revoke execute on function public.workspace_activity(uuid) from public, anon;
grant execute on function public.workspace_activity(uuid) to authenticated;

-- ---------- 4. provisioning a business, and handing it over ----------
create table if not exists public.workspace_handovers (
  workspace_id   uuid primary key references public.workspaces (id) on delete cascade,
  email          text not null,
  pack           text,
  provisioned_by uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  done_at        timestamptz,
  new_owner      uuid references auth.users (id) on delete set null
);
alter table public.workspace_handovers drop constraint if exists workspace_handovers_shape;
alter table public.workspace_handovers add constraint workspace_handovers_shape check (
  email = lower(btrim(email)) and char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  and (pack is null or pack ~ '^[a-z0-9-]{1,40}$'));
alter table public.workspace_handovers enable row level security;
do $handovers$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'workspace_handovers' loop
    execute format('drop policy %I on public.workspace_handovers', pol.policyname);
  end loop;
end $handovers$;
-- no policies: nobody reads or writes it through the API (the functions below do)
revoke all on public.workspace_handovers from public, anon, authenticated;
grant select, insert, update, delete on public.workspace_handovers to service_role;

-- Mail domains anyone can sign up with: pre-approving one would let anyone in.
create or replace function public.public_mail_domain(d text)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select lower(coalesce(d, '')) = any (array['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
    'live.co.uk', 'msn.com', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com',
    'gmx.com', 'mail.com', 'yandex.com', 'zoho.com', 'btinternet.com', 'sky.com']);
$$;

create or replace function public.admin_provision_business(p_name text, p_owner_email text, p_domain text default null, p_pack text default null)
returns json language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_email text;
  my_name text;
  nm text := btrim(coalesce(p_name, ''));
  e text := lower(btrim(coalesce(p_owner_email, '')));
  d text := nullif(lower(btrim(coalesce(p_domain, ''))), '');
  pk text := nullif(btrim(coalesce(p_pack, '')), '');
  ws uuid;
  inv uuid;
  added boolean := false;
  let_in integer := 0;
begin
  -- platform admins only (is_admin: the flag or the founding address, never a suspended account)
  if me is null or not public.can_act() or not public.is_admin() then raise exception 'not authorized'; end if;
  if char_length(nm) < 1 or char_length(nm) > 80 then raise exception 'name the business (up to 80 characters)'; end if;
  if char_length(e) > 254 or e !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'invalid email'; end if;
  select lower(btrim(u.email)) into my_email from auth.users u where u.id = me;
  if e = my_email then raise exception 'the owner has to be someone else: you stay on as an admin'; end if;
  if d is not null then
    if char_length(d) > 253 or d !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then raise exception 'invalid domain'; end if;
    if public.public_mail_domain(d) then raise exception 'a public email domain would let anyone in'; end if;
  end if;
  if pk is not null and pk !~ '^[a-z0-9-]{1,40}$' then raise exception 'invalid pack'; end if;
  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), my_email, '')
    into my_name from public.profiles p where p.id = me;

  insert into public.workspaces (name, owner_id) values (nm, me) returning id into ws;
  insert into public.workspace_members (workspace_id, user_id, email, name, role, status)
    values (ws, me, coalesce(my_email, ''), coalesce(my_name, my_email, ''), 'owner', 'active');
  -- the owner-to-be: an admin until they join, then the owner (the trigger below)
  insert into public.workspace_members (workspace_id, email, name, role, status)
    values (ws, e, '', 'admin', 'invited') returning id into inv;
  insert into public.workspace_handovers (workspace_id, email, pack, provisioned_by) values (ws, e, pk, me);

  if d is not null then
    insert into public.approved_domains (domain, added_by) values (d, me) on conflict (domain) do nothing;
    added := found;
    -- anyone from the domain already waiting gets in (never someone an admin revoked, never a suspended account)
    update public.profiles p set approved = true
      from auth.users u
     where u.id = p.id and not p.approved and not p.suspended
       and split_part(lower(btrim(u.email)), '@', 2) = d
       and not public.access_revoked(p.id);
    get diagnostics let_in = row_count;
  end if;

  insert into public.admin_audit (actor_id, actor_email, action, target, detail)
  values (me, my_email, 'provision_business', nm,
          'Owner ' || e || coalesce(', domain ' || d, '') || coalesce(', pack ' || pk, ''));
  return json_build_object('workspace_id', ws, 'member_id', inv, 'domain', d, 'domain_added', added, 'approved', let_in);
end; $$;
revoke execute on function public.admin_provision_business(text, text, text, text) from public, anon;
grant execute on function public.admin_provision_business(text, text, text, text) to authenticated;

-- The handover: the invited owner-to-be joins, and the workspace is theirs.
create or replace function public.member_handover() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  h public.workspace_handovers;
  current_owner uuid;
begin
  if new.status <> 'active' or old.status = 'active' or new.user_id is null then return null; end if;
  select * into h from public.workspace_handovers
   where workspace_id = new.workspace_id and done_at is null and email = lower(btrim(new.email))
   for update;
  if h.workspace_id is null then return null; end if;
  update public.workspace_handovers set done_at = now(), new_owner = new.user_id where workspace_id = h.workspace_id;
  -- already handed over by hand (or the admin who set it up has gone): nothing more to do
  select w.owner_id into current_owner from public.workspaces w where w.id = new.workspace_id;
  if h.provisioned_by is null or current_owner is distinct from h.provisioned_by then return null; end if;

  update public.workspace_members set role = 'admin'
   where workspace_id = new.workspace_id and role = 'owner' and id <> new.id;
  update public.workspace_members set role = 'owner' where id = new.id;
  update public.workspaces set owner_id = new.user_id where id = new.workspace_id;
  -- what was set up for them is theirs
  update public.projects set owner_id = new.user_id
   where workspace_id = new.workspace_id and owner_id = h.provisioned_by;
  update public.tasks set assignee_id = new.user_id::text
   where workspace_id = new.workspace_id and assignee_id = h.provisioned_by::text and status <> 'done';
  -- (goals' and portfolios' owners: once 0052's and 0054's columns are in)
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'goals' and column_name = 'owner_id') then
    execute 'update public.goals set owner_id = $1 where workspace_id = $2 and owner_id = $3'
      using new.user_id, new.workspace_id, h.provisioned_by;
  end if;
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'portfolios' and column_name = 'owner_id') then
    execute 'update public.portfolios set owner_id = $1 where workspace_id = $2 and owner_id = $3'
      using new.user_id, new.workspace_id, h.provisioned_by;
  end if;
  return null;
end; $$;
revoke execute on function public.member_handover() from public, anon, authenticated;
drop trigger if exists trg_member_handover on public.workspace_members;
create trigger trg_member_handover after update of status on public.workspace_members
  for each row execute function public.member_handover();

-- ---------- 5. adoption per workspace (the platform console) ----------
create or replace function public.admin_workspace_adoption()
returns json language plpgsql stable security definer set search_path = public as $$
declare
  today date := (now() at time zone 'Europe/London')::date;
  week_ts timestamptz := (today - 6)::timestamp at time zone 'Europe/London';
begin
  if auth.uid() is null or not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select json_agg(row_to_json(x) order by x.created_at desc) from (
      select w.id, w.name, w.created_at,
        (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.status = 'active') as members,
        (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.status = 'invited') as invited,
        (select count(distinct m.user_id) from public.workspace_members m
          where m.workspace_id = w.id and m.status = 'active' and m.user_id is not null
            and (exists (select 1 from public.sessions s where s.user_id = m.user_id and (s.started_at >= week_ts or s.last_seen_at >= week_ts))
                 or exists (select 1 from public.task_events e join public.tasks t on t.id = e.task_id
                             where t.workspace_id = w.id and e.actor_id = m.user_id and e.created_at >= week_ts))) as weekly_active,
        (select count(*) from public.tasks t where t.workspace_id = w.id and t.status = 'done' and t.completed_at >= today - 6) as done_week,
        (select (max(e.created_at) at time zone 'Europe/London')::date
           from public.task_events e join public.tasks t on t.id = e.task_id where t.workspace_id = w.id) as last_day,
        h.email as handover_email, h.done_at as handover_done_at, h.pack
        from public.workspaces w
        left join public.workspace_handovers h on h.workspace_id = w.id
    ) x
  ), '[]'::json);
end; $$;
revoke execute on function public.admin_workspace_adoption() from public, anon;
grant execute on function public.admin_workspace_adoption() to authenticated;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0058') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0058')                             as recorded,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'workspace_members' and column_name = 'joined_at')                       as joined_at,
--   exists (select 1 from pg_trigger where tgname = 'trg_member_joined_at')                              as joined_trigger,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'workspaces' and column_name = 'rollout')                                 as rollout_column,
--   has_function_privilege('authenticated', 'public.set_workspace_rollout(uuid,jsonb)', 'execute')
--     and not has_function_privilege('anon', 'public.set_workspace_rollout(uuid,jsonb)', 'execute')    as rollout_signed_in_only,
--   has_function_privilege('authenticated', 'public.workspace_activity(uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.workspace_activity(uuid)', 'execute')             as activity_signed_in_only,
--   (select relrowsecurity from pg_class where oid = 'public.workspace_handovers'::regclass)            as handovers_rls,
--   not has_table_privilege('authenticated', 'public.workspace_handovers', 'select')
--     and not has_table_privilege('authenticated', 'public.workspace_handovers', 'insert')             as handovers_no_client_access,
--   has_function_privilege('authenticated', 'public.admin_provision_business(text,text,text,text)', 'execute')
--     and not has_function_privilege('anon', 'public.admin_provision_business(text,text,text,text)', 'execute') as provision_signed_in_only,
--   exists (select 1 from pg_trigger where tgname = 'trg_member_handover')                               as handover_trigger,
--   has_function_privilege('authenticated', 'public.admin_workspace_adoption()', 'execute')
--     and not has_function_privilege('anon', 'public.admin_workspace_adoption()', 'execute')          as adoption_signed_in_only;
-- ============================================================
