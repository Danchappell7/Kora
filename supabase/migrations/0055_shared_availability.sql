-- ============================================================
-- KANBO — shared capacity, working hours, time off and bill rates
-- (2026-11-10).
--
-- Until now each browser kept its own: Workload's capacities
-- (localStorage "kanbo-capacity") and Time & billing's hourly rate
-- ("kanbo-bill-rate"), so two managers saw different "over capacity"
-- answers and different £ amounts, and nobody could see who was away.
--
--   1. member_availability: a person's week at one business, set once for
--      everyone: weekly capacity in hours (null = the 40h default),
--      working days (ISO, Mon = 1 … Sun = 7) and the working day's start
--      and end (minutes from midnight, in the person's own time). Read by
--      the workspace's owners, admins and members (never its guests) and
--      by the person. Written only through set_member_availability(): you
--      set yours, owners and admins set anyone's. Guests carry no team
--      capacity, so they have none.
--   2. time_off: a person's days away (from, to, optionally half a single
--      day: "am" or "pm"). It's the person's, not one business's: anyone
--      who works beside them (an owner, admin or member of a workspace they
--      belong to) reads it, so every business they're in sees "Off" without
--      it being entered twice. Guests and outsiders read nothing.
--      time_off_notes: the private reason. Only the person and the owners
--      and admins of a workspace they belong to read it; everyone else
--      sees just "Off". Both written only through save_time_off() and
--      delete_time_off(): by the person, or by an owner or admin of a
--      workspace they're in. At most 200 entries per person; entries that
--      ended more than 400 days ago are cleared as new ones are saved.
--   3. bill_rates: an hourly rate per project, and a workspace default (the
--      row with no project). Read and set (set_bill_rate()) by the
--      workspace's owners and admins only: members never see a rate, guests
--      nothing.
--   4. member_availability and time_off join the realtime publication (RLS
--      still decides who hears what); the reasons and the rates don't (the
--      app reads them again when time off changes).
--
-- Needs 0041 (ws_role, can_act) and 0042 (schema_migrations). Works with or
-- without 0043–0054. Idempotent: safe to run more than once (re-running
-- keeps every capacity, day off, reason and rate). The tables are new and
-- 0041 never drops their policies, so nothing to restore when it's re-run.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0055 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regclass('public.workspace_members') is null or to_regclass('public.workspaces') is null or to_regclass('public.projects') is null then
    raise exception '0055 needs workspaces, workspace_members (0007) and projects (0003)';
  end if;
end $pre$;

-- ---------- helpers: who works beside whom ----------
-- The caller and p_user are both in a workspace where the caller is an owner, admin or member
-- (an active membership each; a workspace's owner counts as in it).
create or replace function public.shares_team_with(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_user is not null and (
    exists (select 1 from public.workspace_members m
             where m.user_id = p_user and m.status = 'active'
               and public.ws_role(m.workspace_id) in ('owner', 'admin', 'member'))
    or exists (select 1 from public.workspaces w
                where w.owner_id = p_user and public.ws_role(w.id) in ('owner', 'admin', 'member')));
$$;

-- The caller is an owner or admin of a workspace p_user is in.
create or replace function public.leads_person(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_user is not null and (
    exists (select 1 from public.workspace_members m
             where m.user_id = p_user and m.status = 'active'
               and public.ws_role(m.workspace_id) in ('owner', 'admin'))
    or exists (select 1 from public.workspaces w
                where w.owner_id = p_user and public.ws_role(w.id) in ('owner', 'admin')));
$$;
revoke execute on function public.shares_team_with(uuid) from public, anon;
revoke execute on function public.leads_person(uuid) from public, anon;
grant execute on function public.shares_team_with(uuid) to authenticated;
grant execute on function public.leads_person(uuid) to authenticated;

-- Working days as stored: 1–7 days, each 1..7 (ISO), none twice.
create or replace function public.work_days_ok(d smallint[])
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select d is not null and cardinality(d) between 1 and 7
    and d <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]
    and cardinality(d) = (select count(distinct x) from unnest(d) as x);
$$;

-- ---------- 1. a person's week at a business ----------
create table if not exists public.member_availability (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  weekly_hours numeric(5,1),
  work_days    smallint[] not null default array[1, 2, 3, 4, 5]::smallint[],
  day_start    smallint not null default 480,
  day_end      smallint not null default 1080,
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table public.member_availability drop constraint if exists member_availability_shape;
alter table public.member_availability add constraint member_availability_shape check (
  (weekly_hours is null or (weekly_hours >= 1 and weekly_hours <= 168))
  and public.work_days_ok(work_days)
  and day_start between 0 and 1380 and day_end between 60 and 1440 and day_end - day_start >= 60);
create index if not exists member_availability_user_idx on public.member_availability (user_id);
alter table public.member_availability enable row level security;
do $hours$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'member_availability' loop
    execute format('drop policy %I on public.member_availability', pol.policyname);
  end loop;
end $hours$;
-- the team reads it (not its guests), and the person their own; nobody writes it but the function
create policy "hours: the team and the person read" on public.member_availability
  for select using (public.can_act() and (user_id = auth.uid() or public.ws_role(workspace_id) in ('owner', 'admin', 'member')));
revoke all on public.member_availability from public, anon, authenticated;
grant select on public.member_availability to authenticated;
grant select, insert, update, delete on public.member_availability to service_role;

-- Set a person's capacity, working days and hours at a business: your own (as an owner, admin or
-- member there), or anyone's as its owner or admin. The person must be an active owner, admin or
-- member of it (guests carry no team capacity). Nulls keep the defaults (40h, Mon–Fri, 08:00–18:00).
create or replace function public.set_member_availability(p_ws uuid, p_user uuid, p_weekly_hours numeric,
  p_work_days smallint[], p_day_start smallint, p_day_end smallint)
returns public.member_availability language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  caller text := public.ws_role(p_ws);
  r public.member_availability;
  hrs numeric := case when p_weekly_hours is null then null else round(p_weekly_hours, 1) end;
  days smallint[] := coalesce(p_work_days, array[1, 2, 3, 4, 5]::smallint[]);
  s smallint := coalesce(p_day_start, 480);
  e smallint := coalesce(p_day_end, 1080);
begin
  if me is null or caller not in ('owner', 'admin', 'member') then raise exception 'not authorized'; end if;
  if p_user is distinct from me and caller not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_ws and m.user_id = p_user
                  and m.status = 'active' and m.role in ('owner', 'admin', 'member'))
     and not exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_user) then
    raise exception 'not allowed: only the team''s owners, admins and members carry capacity';
  end if;
  if (hrs is not null and (hrs < 1 or hrs > 168)) or not public.work_days_ok(days)
     or s < 0 or s > 1380 or e < 60 or e > 1440 or e - s < 60 then
    raise exception 'invalid availability';
  end if;
  insert into public.member_availability as a (workspace_id, user_id, weekly_hours, work_days, day_start, day_end, updated_by, updated_at)
    values (p_ws, p_user, hrs, (select array_agg(x order by x) from unnest(days) as x), s, e, me, now())
  on conflict (workspace_id, user_id) do update
    set weekly_hours = excluded.weekly_hours, work_days = excluded.work_days, day_start = excluded.day_start,
        day_end = excluded.day_end, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning * into r;
  return r;
end; $$;
revoke execute on function public.set_member_availability(uuid, uuid, numeric, smallint[], smallint, smallint) from public, anon;
grant execute on function public.set_member_availability(uuid, uuid, numeric, smallint[], smallint, smallint) to authenticated;

-- ---------- 2. time off, and its private reason ----------
create table if not exists public.time_off (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  starts_on  date not null,
  ends_on    date not null,
  half_day   text,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.time_off drop constraint if exists time_off_shape;
alter table public.time_off add constraint time_off_shape check (
  ends_on >= starts_on and ends_on - starts_on <= 366
  and (half_day is null or (half_day in ('am', 'pm') and starts_on = ends_on)));
create index if not exists time_off_user_idx on public.time_off (user_id, ends_on);
alter table public.time_off enable row level security;

create table if not exists public.time_off_notes (
  time_off_id uuid primary key references public.time_off (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  reason      text not null
);
alter table public.time_off_notes drop constraint if exists time_off_notes_shape;
alter table public.time_off_notes add constraint time_off_notes_shape check (char_length(btrim(reason)) between 1 and 200);
create index if not exists time_off_notes_user_idx on public.time_off_notes (user_id);
alter table public.time_off_notes enable row level security;

do $off$
declare pol record;
begin
  for pol in select policyname, tablename from pg_policies where schemaname = 'public' and tablename in ('time_off', 'time_off_notes') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $off$;
-- "Off" is for the person and the people they work beside (owners, admins and members; never guests)
create policy "time off: the person and their team read" on public.time_off
  for select using (public.can_act() and (user_id = auth.uid() or public.shares_team_with(user_id)));
-- the reason is for the person and their owners and admins only
create policy "time off reasons: the person and their leads read" on public.time_off_notes
  for select using (public.can_act() and (user_id = auth.uid() or public.leads_person(user_id)));
revoke all on public.time_off, public.time_off_notes from public, anon, authenticated;
grant select on public.time_off, public.time_off_notes to authenticated;
grant select, insert, update, delete on public.time_off, public.time_off_notes to service_role;

-- Record (p_id null) or change a person's time off: yours, or that of someone in a workspace you
-- own or run. p_half ("am" / "pm") only on a single day. p_reason: private (blank = none).
-- Two entries can't cover the same day (the morning and the afternoon of one day can).
create or replace function public.save_time_off(p_id uuid, p_user uuid, p_starts date, p_ends date, p_half text, p_reason text)
returns public.time_off language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  r public.time_off;
  half text := nullif(btrim(coalesce(p_half, '')), '');
  why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_user is null or (p_user <> me and not public.leads_person(p_user)) then raise exception 'not authorized'; end if;
  if p_starts is null or p_ends is null or p_ends < p_starts or p_ends - p_starts > 366
     or (half is not null and (half not in ('am', 'pm') or p_starts <> p_ends))
     or p_starts < current_date - 400 or p_ends > current_date + 732
     or (why is not null and char_length(why) > 200) then
    raise exception 'invalid time off';
  end if;
  if p_id is not null and not exists (select 1 from public.time_off t where t.id = p_id and t.user_id = p_user) then
    raise exception 'not authorized';
  end if;
  -- one person's entries are saved one at a time
  perform pg_advisory_xact_lock(hashtext('kanbo.time_off:' || p_user::text));
  if exists (select 1 from public.time_off t
              where t.user_id = p_user and t.id is distinct from p_id
                and t.starts_on <= p_ends and t.ends_on >= p_starts
                and not (half is not null and t.half_day is not null and t.half_day <> half)) then
    raise exception 'already off then';
  end if;
  delete from public.time_off where user_id = p_user and ends_on < current_date - 400;
  if p_id is null and (select count(*) from public.time_off t where t.user_id = p_user) >= 200 then
    raise exception 'too much time off on record';
  end if;
  if p_id is null then
    insert into public.time_off (user_id, starts_on, ends_on, half_day, created_by)
      values (p_user, p_starts, p_ends, half, me) returning * into r;
  else
    update public.time_off set starts_on = p_starts, ends_on = p_ends, half_day = half, updated_at = now()
      where id = p_id returning * into r;
  end if;
  if why is null then
    delete from public.time_off_notes where time_off_id = r.id;
  else
    insert into public.time_off_notes (time_off_id, user_id, reason) values (r.id, p_user, why)
      on conflict (time_off_id) do update set reason = excluded.reason;
  end if;
  return r;
end; $$;
revoke execute on function public.save_time_off(uuid, uuid, date, date, text, text) from public, anon;
grant execute on function public.save_time_off(uuid, uuid, date, date, text, text) to authenticated;

-- Take time off back: the person's own, or as an owner or admin of a workspace they're in.
-- An entry the caller can't change gets the same answer as one that isn't there.
create or replace function public.delete_time_off(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare who uuid;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select user_id into who from public.time_off where id = p_id;
  if not found or (who <> auth.uid() and not public.leads_person(who)) then raise exception 'not authorized'; end if;
  delete from public.time_off where id = p_id;
end; $$;
revoke execute on function public.delete_time_off(uuid) from public, anon;
grant execute on function public.delete_time_off(uuid) to authenticated;

-- ---------- 3. bill rates ----------
create table if not exists public.bill_rates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  project_id   uuid references public.projects (id) on delete cascade,
  hourly_rate  numeric(10,2) not null,
  updated_by   uuid references auth.users (id) on delete set null,
  updated_at   timestamptz not null default now()
);
alter table public.bill_rates drop constraint if exists bill_rates_shape;
alter table public.bill_rates add constraint bill_rates_shape check (hourly_rate >= 0 and hourly_rate <= 100000);
create unique index if not exists bill_rates_default_uq on public.bill_rates (workspace_id) where project_id is null;
create unique index if not exists bill_rates_project_uq on public.bill_rates (project_id) where project_id is not null;
alter table public.bill_rates enable row level security;
do $rates$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'bill_rates' loop
    execute format('drop policy %I on public.bill_rates', pol.policyname);
  end loop;
end $rates$;
create policy "rates: owners and admins read" on public.bill_rates
  for select using (public.can_act() and public.ws_role(workspace_id) in ('owner', 'admin'));
revoke all on public.bill_rates from public, anon, authenticated;
grant select on public.bill_rates to authenticated;
grant select, insert, update, delete on public.bill_rates to service_role;

-- Set the workspace's default rate (p_project null) or a project's own (its project must be one of
-- the workspace's). A null rate clears it (a project then follows the default).
create or replace function public.set_bill_rate(p_ws uuid, p_project uuid, p_rate numeric)
returns public.bill_rates language plpgsql security definer set search_path = public as $$
declare r public.bill_rates;
begin
  if public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p_project is not null and not exists (select 1 from public.projects p where p.id = p_project and p.workspace_id = p_ws) then
    raise exception 'not authorized';
  end if;
  if p_rate is not null and (p_rate < 0 or p_rate > 100000) then raise exception 'invalid rate'; end if;
  perform pg_advisory_xact_lock(hashtext('kanbo.bill_rate:' || p_ws::text));
  if p_rate is null then
    delete from public.bill_rates where workspace_id = p_ws and project_id is not distinct from p_project;
    return null;
  end if;
  update public.bill_rates set hourly_rate = round(p_rate, 2), updated_by = auth.uid(), updated_at = now()
    where workspace_id = p_ws and project_id is not distinct from p_project returning * into r;
  if not found then
    insert into public.bill_rates (workspace_id, project_id, hourly_rate, updated_by)
      values (p_ws, p_project, round(p_rate, 2), auth.uid()) returning * into r;
  end if;
  return r;
end; $$;
revoke execute on function public.set_bill_rate(uuid, uuid, numeric) from public, anon;
grant execute on function public.set_bill_rate(uuid, uuid, numeric) to authenticated;

-- ---------- 4. realtime: capacities and days off stream (RLS decides who hears) ----------
do $rt$
declare t text;
begin
  foreach t in array array['member_availability', 'time_off'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;                  -- already streaming
      when object_not_in_prerequisite_state then null;  -- publication is FOR ALL TABLES
      when undefined_object then null;                  -- no realtime publication (local Postgres)
    end;
  end loop;
end $rt$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0055') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0055')                                  as recorded,
--   (select relrowsecurity from pg_class where oid = 'public.member_availability'::regclass)                  as hours_rls,
--   (select relrowsecurity from pg_class where oid = 'public.time_off'::regclass)                             as time_off_rls,
--   (select relrowsecurity from pg_class where oid = 'public.time_off_notes'::regclass)                       as reasons_rls,
--   (select relrowsecurity from pg_class where oid = 'public.bill_rates'::regclass)                           as rates_rls,
--   not has_table_privilege('authenticated', 'public.member_availability', 'insert')
--     and not has_table_privilege('authenticated', 'public.time_off', 'update')
--     and not has_table_privilege('authenticated', 'public.time_off_notes', 'insert')
--     and not has_table_privilege('authenticated', 'public.bill_rates', 'update')                             as no_client_writes,
--   not has_table_privilege('anon', 'public.time_off_notes', 'select')
--     and not has_table_privilege('anon', 'public.bill_rates', 'select')                                      as anon_reads_nothing,
--   has_function_privilege('authenticated', 'public.set_member_availability(uuid,uuid,numeric,smallint[],smallint,smallint)', 'execute')
--     and not has_function_privilege('anon', 'public.set_member_availability(uuid,uuid,numeric,smallint[],smallint,smallint)', 'execute') as hours_fn,
--   has_function_privilege('authenticated', 'public.save_time_off(uuid,uuid,date,date,text,text)', 'execute')
--     and not has_function_privilege('anon', 'public.save_time_off(uuid,uuid,date,date,text,text)', 'execute')                       as time_off_fn,
--   has_function_privilege('authenticated', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')
--     and not has_function_privilege('anon', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')                                    as rates_fn,
--   (not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
--     or (select puballtables from pg_publication where pubname = 'supabase_realtime')
--     or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--          and tablename in ('member_availability', 'time_off')) = 2)                                           as streams;
-- ============================================================
