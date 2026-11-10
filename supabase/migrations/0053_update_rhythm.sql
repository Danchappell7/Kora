-- ============================================================
-- KANBO — project updates that arrive on schedule, and say how things
-- really are (2026-11-10).
--
--   1. workspaces.update_rhythm (jsonb; null = weekly on Friday): the
--      team's update day,
--        {"cadence": "weekly" | "fortnightly" | "monthly" | "never",
--         "weekday": 1..7 (ISO, Mon = 1),
--         "anchor": "YYYY-MM-DD" (fortnightly: the due day it counts from)}
--      Monthly is the last <weekday> of the month. Owners and admins set
--      it through set_update_rhythm(ws, rhythm) (the workspace's owner
--      could already write the row; the shape check holds every write).
--   2. projects.update_rhythm: a project's own update day, "never"
--      included; null follows its workspace. The project's writers set
--      it, as its other details (0041 "edit: personal or writer").
--      On the day, daily-reminders' digest run (every 15 minutes, no new
--      schedule) reminds the project's OWNER, at most on the day and the
--      next two working days, through notify_queue (their digest and
--      quiet hours apply); archived and on-hold projects are skipped.
--      The app shows "Update missing" after that.
--   3. status_updates.recovery_plan (≤ 2000 characters) and target_date:
--      an At risk or Off track update's plan to recover and new target
--      date. "on_hold" is an update status of its own (status has no
--      check: nothing to change).
--   4. update_asks + ask_for_update(project): "Ask for an update". Only
--      the workspace's owners and admins, about a live project someone
--      else owns who's still in the workspace; one ask per project in 20
--      hours and 30 a day per asker. Read by the asker and the owner only;
--      nobody writes the table but the function. Kept 30 days. The app
--      then asks notify ({kind: "update_ask"}) to tell the owner.
--   5. notify_queue's kind check gains 'update' (the reminders and the
--      asks; prefs "update_email" / "update_push", default on).
--
-- Needs 0041 (ws_role, can_act) and 0042 (schema_migrations). Works with or
-- without 0043–0052: without 0048 there's no queue to widen (that step is
-- skipped; run this file again after 0048 to add it). Idempotent: safe to
-- run more than once (re-running keeps every update day, plan and ask).
-- 0041 drops the policies of the content tables when it's run again: none
-- here are on them (update_asks is its own table), so nothing to restore.
-- 0048 lists 'update' in its own copy of the queue's check, so running it
-- again keeps these notices valid.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0053 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regclass('public.status_updates') is null or to_regclass('public.projects') is null or to_regclass('public.workspaces') is null then
    raise exception '0053 needs status_updates (0020), projects and workspaces';
  end if;
end $pre$;

-- ---------- 1–2. update days ----------
-- A rhythm as stored: null (follow / the default) or the object above, nothing else in it.
create or replace function public.update_rhythm_ok(r jsonb)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select r is null or (
    jsonb_typeof(r) = 'object'
    and pg_column_size(r) <= 256
    and coalesce(r ->> 'cadence', '') in ('weekly', 'fortnightly', 'monthly', 'never')
    and jsonb_typeof(r -> 'weekday') = 'number' and (r ->> 'weekday') ~ '^[1-7]$'
    and (not (r ? 'anchor') or (jsonb_typeof(r -> 'anchor') = 'string' and (r ->> 'anchor') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
    and (r - 'cadence' - 'weekday' - 'anchor') = '{}'::jsonb
  );
$$;

alter table public.workspaces add column if not exists update_rhythm jsonb;
alter table public.workspaces drop constraint if exists workspaces_update_rhythm_ok;
alter table public.workspaces add constraint workspaces_update_rhythm_ok check (public.update_rhythm_ok(update_rhythm));

alter table public.projects add column if not exists update_rhythm jsonb;
alter table public.projects drop constraint if exists projects_update_rhythm_ok;
alter table public.projects add constraint projects_update_rhythm_ok check (public.update_rhythm_ok(update_rhythm));

-- The team's update day: its owners and admins (null: back to weekly on Friday).
create or replace function public.set_update_rhythm(p_ws uuid, p_rhythm jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r jsonb := case when p_rhythm is null or jsonb_typeof(p_rhythm) = 'null' then null else p_rhythm end;
begin
  if public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if not public.update_rhythm_ok(r) then raise exception 'invalid update day'; end if;
  update public.workspaces set update_rhythm = r where id = p_ws;
  return r;
end; $$;
revoke execute on function public.set_update_rhythm(uuid, jsonb) from public, anon;
grant execute on function public.set_update_rhythm(uuid, jsonb) to authenticated;

-- ---------- 3. honest status: a plan to recover and a new date ----------
alter table public.status_updates add column if not exists recovery_plan text;
alter table public.status_updates add column if not exists target_date date;
alter table public.status_updates drop constraint if exists status_updates_recovery_shape;
alter table public.status_updates add constraint status_updates_recovery_shape
  check (recovery_plan is null or char_length(recovery_plan) <= 2000);

-- ---------- 4. Ask for an update ----------
create table if not exists public.update_asks (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  asked_by     uuid not null references auth.users (id) on delete cascade,
  owner_id     uuid not null references auth.users (id) on delete cascade,
  created_at   timestamptz not null default now()
);
create index if not exists update_asks_project_idx on public.update_asks (project_id, created_at desc);
create index if not exists update_asks_owner_idx on public.update_asks (owner_id, created_at desc);
create index if not exists update_asks_asker_idx on public.update_asks (asked_by, created_at desc);
alter table public.update_asks enable row level security;
do $asks$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'update_asks' loop
    execute format('drop policy %I on public.update_asks', pol.policyname);
  end loop;
end $asks$;
-- the two people in it read it (a suspended account reads nothing); nobody writes it but ask_for_update
create policy "asks: the asker and the owner read" on public.update_asks
  for select using (public.can_act() and (asked_by = auth.uid() or owner_id = auth.uid()));
revoke all on public.update_asks from public, anon, authenticated;
grant select on public.update_asks to authenticated;
grant select, insert, update, delete on public.update_asks to service_role;

-- Ask a project's owner for its update. The caller leads the project's workspace (owner or
-- admin); the project is live, owned by someone else who's still in the workspace; it hasn't
-- been asked about in the last 20 hours; the caller has asked fewer than 30 times today.
create or replace function public.ask_for_update(p_project uuid)
returns public.update_asks language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  p record;
  r public.update_asks;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select id, workspace_id, owner_id, archived_at into p from public.projects where id = p_project;
  if not found or p.workspace_id is null then raise exception 'project not found'; end if;
  if public.ws_role(p.workspace_id) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p.archived_at is not null then raise exception 'not allowed: the project is archived'; end if;
  if p.owner_id is null then raise exception 'not allowed: no owner'; end if;
  if p.owner_id = me then raise exception 'not allowed: your own project'; end if;
  if not exists (select 1 from public.workspace_members m
                  where m.workspace_id = p.workspace_id and m.user_id = p.owner_id and m.status = 'active')
     and not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id) then
    raise exception 'not allowed: the owner has left';
  end if;
  -- two leads asking at once make one ask
  perform pg_advisory_xact_lock(hashtext('kanbo.update_ask:' || p_project::text));
  if exists (select 1 from public.update_asks a where a.project_id = p_project and a.created_at > now() - interval '20 hours') then
    raise exception 'already asked recently';
  end if;
  if (select count(*) from public.update_asks a where a.asked_by = me and a.created_at > now() - interval '24 hours') >= 30 then
    raise exception 'too many asks today';
  end if;
  delete from public.update_asks where created_at < now() - interval '30 days';
  insert into public.update_asks (project_id, workspace_id, asked_by, owner_id)
    values (p_project, p.workspace_id, me, p.owner_id) returning * into r;
  return r;
end; $$;
revoke execute on function public.ask_for_update(uuid) from public, anon;
grant execute on function public.ask_for_update(uuid) to authenticated;

-- ---------- 5. the notify queue takes 'update' ----------
do $queue$
begin
  if to_regclass('public.notify_queue') is null then return; end if;   -- before 0048: nothing to widen
  alter table public.notify_queue drop constraint if exists notify_queue_shape;
  alter table public.notify_queue add constraint notify_queue_shape check (
    channel in ('push', 'email')
    and kind in ('assigned', 'mention', 'comment', 'approval', 'kudos', 'due', 'digest', 'update')
    and char_length(event_key) between 1 and 200 and char_length(bundle_key) between 1 and 200
    and char_length(actor_name) <= 200 and char_length(title) <= 500
    and jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
    and (last_error is null or char_length(last_error) <= 500));
end $queue$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0053') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0053')                            as recorded,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'workspaces' and column_name = 'update_rhythm')                          as workspace_day,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'projects' and column_name = 'update_rhythm')                            as project_day,
--   (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'status_updates'
--     and column_name in ('recovery_plan', 'target_date')) = 2                                            as plan_columns,
--   (select relrowsecurity from pg_class where oid = 'public.update_asks'::regclass)                     as asks_rls,
--   not has_table_privilege('authenticated', 'public.update_asks', 'insert')                             as asks_no_client_writes,
--   has_function_privilege('authenticated', 'public.ask_for_update(uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.ask_for_update(uuid)', 'execute')                   as ask_signed_in_only,
--   has_function_privilege('authenticated', 'public.set_update_rhythm(uuid,jsonb)', 'execute')
--     and not has_function_privilege('anon', 'public.set_update_rhythm(uuid,jsonb)', 'execute')          as rhythm_signed_in_only,
--   (to_regclass('public.notify_queue') is null
--     or pg_get_constraintdef((select oid from pg_constraint where conname = 'notify_queue_shape')) like '%update%') as queue_takes_update;
-- ============================================================
