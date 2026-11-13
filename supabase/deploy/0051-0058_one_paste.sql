-- ============================================================
-- KANBO — database updates 0051 to 0058 in ONE paste.
-- Made by scripts/bundle-migrations.mjs from: 0051_guest_leadership_lock.sql, 0052_goals_v2.sql, 0053_update_rhythm.sql, 0054_update_conversation.sql, 0055_shared_availability.sql, 0056_meetings.sql, 0057_adoption_health.sql, 0058_project_access.sql.
-- Don't edit this file: change the migration files, then run
--   node scripts/bundle-migrations.mjs 0051 0058
--
-- Paste ALL of it into the Supabase SQL editor and press Run. It runs as one:
-- if anything stops it, nothing has changed. It's safe to run again.
-- The last result is ONE row: every column says true and "not true" says none.
-- ============================================================

-- >>>>>>>>>> 0051_guest_leadership_lock.sql >>>>>>>>>>
-- ============================================================
-- KANBO — guests can't read a team's goals or portfolios (2026-11-09).
-- A stop-gap ahead of private projects.
--
--   1. goals, portfolios: a team row is read by its workspace's owner,
--      admins and members only. A guest (a client, a freelancer) no longer
--      sees the group's targets or how its projects are grouped, through the
--      app, the REST API or realtime. A restrictive "guests: no team reports"
--      SELECT policy on each table, ANDed with 0041's "read: personal or
--      member": members and above read exactly what they did, personal rows
--      (workspace_id null) are untouched, and writes were already
--      members-only (0041 can_write). Status updates stay readable: a guest
--      keeps the updates on the projects they follow. 0041 drops every policy
--      on these tables when it's run again, so it calls guest_lock_restore()
--      to put this one back, as it does for 0046.
--   2. status_updates.author_id: who posted an update. user_id is the row's
--      keeper, and when the author deletes their account it passes to the
--      workspace's owner (0042 before_user_delete), so it can't say who wrote
--      it. author_id is set from the person posting (never from the request),
--      can't be changed afterwards, and is emptied when that account is
--      deleted: the app shows "Former member". Existing updates take user_id
--      once, on the first run.
--
--   Guests can STILL read every task, project, comment and doc in the
--   workspace until private projects ship (wave 4). The app's hiding of
--   Pulse, Workload and Insights for guests is an interface gate only.
--
-- Needs 0041 (ws_role) and 0042 (schema_migrations). Works with or without
-- 0043–0050. Idempotent: safe to run more than once (re-running keeps every
-- author, including an emptied one).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0051 needs 0041 and 0042 first: run them, then this file';
  end if;
end $pre$;

-- ---------- 1. goals and portfolios are for members ----------
-- (Re)creates the "guests: no team reports" policy on each table: run below,
-- and by 0041 when it's run again (it drops every policy on these tables).
-- Returns how many tables it covered (a missing table is skipped).
create or replace function public.guest_lock_restore()
returns integer language plpgsql set search_path = public as $$
declare t text; n integer := 0;
begin
  -- status updates are read by guests too (an early draft of this file locked them: undo that)
  if to_regclass('public.status_updates') is not null then
    drop policy if exists "guests: no team reports" on public.status_updates;
  end if;
  foreach t in array array['goals', 'portfolios'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "guests: no team reports" on public.%I', t);
    -- ws_role() is 'none' (never NULL) for outsiders, who 0041's read policy already
    -- turns away; here only a guest is refused, so members and above read as before
    execute format('create policy "guests: no team reports" on public.%I as restrictive for select using '
                   || '(workspace_id is null or public.ws_role(workspace_id) <> ''guest'')', t);
    n := n + 1;
  end loop;
  return n;
end; $$;
revoke execute on function public.guest_lock_restore() from public, anon, authenticated;

-- Is it on both tables (restrictive, for SELECT, row security on)?
create or replace function public.guest_lock_intact()
returns boolean language sql stable set search_path = pg_catalog, public as $$
  select coalesce(bool_and(c.relrowsecurity and exists (
           select 1 from pg_catalog.pg_policy p
            where p.polrelid = c.oid and p.polname = 'guests: no team reports' and not p.polpermissive and p.polcmd = 'r')), false)
    from unnest(array['goals', 'portfolios']) as t(name)
    join pg_catalog.pg_class c on c.oid = to_regclass('public.' || t.name);
$$;
revoke execute on function public.guest_lock_intact() from public, anon, authenticated;

do $lock$
begin
  perform public.guest_lock_restore();
end $lock$;

-- ---------- 2. who wrote each status update ----------
alter table public.status_updates add column if not exists author_id uuid;
do $fk$
begin
  alter table public.status_updates add constraint status_updates_author_id_fkey
    foreign key (author_id) references auth.users (id) on delete set null;
exception when duplicate_object then null;   -- already there
end $fk$;
create index if not exists status_updates_author_idx on public.status_updates (author_id);
-- (the trigger below would keep an empty author empty: it's put back after the fill)
drop trigger if exists trg_status_update_author on public.status_updates;

-- the updates posted before this: their keeper is the best we know. Once only, so a
-- re-run never refills an author whose account has since been deleted.
do $fill$
begin
  if not exists (select 1 from public.schema_migrations where version = '0051') then
    update public.status_updates set author_id = user_id where author_id is null;
  end if;
end $fill$;

-- The person posting is the author, whatever the request says; afterwards it never
-- changes, except to empty it once that account is deleted (the foreign key's SET NULL
-- runs after the auth.users row has gone). Nobody can blank it to disown an update.
-- Server-side writers (service role, SQL editor) may name an author, else the keeper.
create or replace function public.status_update_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(auth.role(), '') in ('authenticated', 'anon') then
      new.author_id := auth.uid();
    else
      new.author_id := coalesce(new.author_id, new.user_id);
    end if;
  elsif new.author_id is distinct from old.author_id
        and not (new.author_id is null and not exists (select 1 from auth.users u where u.id = old.author_id)) then
    new.author_id := old.author_id;
  end if;
  return new;
end; $$;
revoke execute on function public.status_update_author() from public, anon, authenticated;
create trigger trg_status_update_author before insert or update on public.status_updates
  for each row execute function public.status_update_author();

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0051') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0051')                          as recorded,
--   (select count(*) from pg_policies where schemaname = 'public' and policyname = 'guests: no team reports'
--     and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
--     and tablename in ('goals', 'portfolios')) = 2                                                 as guest_lock,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'status_updates' and column_name = 'author_id')                       as author_column,
--   exists (select 1 from pg_trigger where tgname = 'trg_status_update_author' and not tgisinternal)  as author_trigger,
--   not has_function_privilege('authenticated', 'public.guest_lock_restore()', 'execute')            as restore_private;
-- ============================================================
-- <<<<<<<<<< end of 0051_guest_leadership_lock.sql <<<<<<<<<<

-- >>>>>>>>>> 0052_goals_v2.sql >>>>>>>>>>
-- ============================================================
-- KANBO — Goals 2.0: owners, quarters, check-ins, links (2026-11-10).
-- Additive: the app reads goals with select('*'), so it keeps working
-- before and after this file; owners, quarters and check-ins switch on
-- once it's in.
--
--   1. goals gain: owner_id (filled from the creator), contributors, a
--      period (2027-Q1, 2027-H1, 2027-FY or custom start and end dates;
--      period_start / period_end are filled for the named ones), a start
--      value, a direction (higher or lower is better), confidence (1-5),
--      a kind (objective, key result or metric) beside the existing parent
--      goal, visibility (everyone or leadership only), archived_at, an icon
--      and a colour, a pace (linear, back-loaded or off) and a weight (how
--      much a sub-goal counts in its parent's roll-up).
--   2. THE RULES (one place: goal_visible, goal_editable, goal_may_place):
--        read    a team goal: the workspace's owner, admins and members (0041),
--                never guests (0051). A leadership-only goal: owners and
--                admins, the goal's owner and its contributors only; and the
--                goals under it (its key results, theirs and so on) with it,
--                for as long as it's leadership only: a member reads one of
--                those only if it's theirs (or they're on a goal above it
--                that they can read).
--        edit    a team goal, delete it, post a check-in or link work to it:
--                owners and admins, the goal's owner and its named
--                contributors (any member could, 0041:213-226).
--        hand over (owner, contributors, visibility): owners and admins and
--                the goal's owner.
--        create  a company goal (a team goal with no parent): owners and
--                admins. A key result under a goal: whoever may edit that goal.
--        delete  a team goal with key results under it (they'd go up to the top
--                level, as company goals): owners and admins.
--        personal goals stay their creator's alone.
--   3. goal_checkins: a value, confidence and a one-line note. The author is
--      the person posting (never the request), can't be changed and empties
--      when that account is deleted ("Former member"); nor can the value (a
--      check-in is a record: take it back and post another). The newest
--      check-in sets the goal's current value (and its confidence), one at a
--      time per goal; deleting the newest puts the one before back (the only
--      one: the value from before it, kept on the check-in as prev_value).
--   4. goal_links: one goal to many projects, tasks or (shared) saved views,
--      always in the goal's own workspace (a personal goal: your own personal
--      work). goals.project_id stays (the project its % comes from) and is
--      copied into goal_links once.
--   5. Search: search_all (0048) also finds goals, by name and description, for
--      whoever can read them (when 0048 is in).
--   Both tables stream live (realtime publication), keep guests out (the same
--   restrictive "guests: no team reports" policy as 0051's), stay inside a
--   team API key's workspace ("api key scope", when 0046 is in) and follow
--   the goal they belong to: what you can't read on the goal you can't read
--   here. 0041 drops every policy on goals when it's run again; it calls
--   goal_rules_restore() to put these back, as it does for 0046 and 0051.
--
-- Needs 0041 (ws_role, can_write), 0042 (schema_migrations) and 0051 (the
-- guest lock). Works with or without 0043-0050 (0046's API scope and 0048's
-- saved views are used when they're there). Idempotent: safe to run more than
-- once (re-running keeps every owner, check-in and link, emptied authors and
-- owners included).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_write(uuid)') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042')
     or not exists (select 1 from public.schema_migrations where version = '0051')
     or to_regclass('public.goals') is null then
    raise exception '0052 needs 0041, 0042 and 0051 first (and 0020/0024 for goals): run them, then this file';
  end if;
end $pre$;

-- ---------- 1. goals: the new columns ----------
alter table public.goals add column if not exists owner_id     uuid;
alter table public.goals add column if not exists contributors uuid[] not null default '{}';
alter table public.goals add column if not exists period       text;
alter table public.goals add column if not exists period_start date;
alter table public.goals add column if not exists period_end   date;
alter table public.goals add column if not exists start_value  numeric;
alter table public.goals add column if not exists direction    text not null default 'higher';
alter table public.goals add column if not exists confidence   smallint;
alter table public.goals add column if not exists kind         text not null default 'objective';
alter table public.goals add column if not exists visibility   text not null default 'everyone';
alter table public.goals add column if not exists archived_at  timestamptz;
alter table public.goals add column if not exists icon         text;
alter table public.goals add column if not exists color        text;
alter table public.goals add column if not exists pace         text not null default 'linear';
alter table public.goals add column if not exists weight       numeric;

do $cols$
begin
  alter table public.goals add constraint goals_owner_id_fkey
    foreign key (owner_id) references auth.users (id) on delete set null;
exception when duplicate_object then null; end $cols$;
do $checks$
declare c record;
begin
  for c in select * from (values
    ('goals_direction_check',  'direction in (''higher'', ''lower'')'),
    ('goals_kind_check',       'kind in (''objective'', ''key_result'', ''metric'')'),
    ('goals_visibility_check', 'visibility in (''everyone'', ''leadership'')'),
    ('goals_pace_check',       'pace in (''linear'', ''backloaded'', ''off'')'),
    ('goals_confidence_check', 'confidence is null or confidence between 1 and 5'),
    ('goals_weight_check',     'weight is null or (weight > 0 and weight <= 100)'),
    ('goals_period_check',     'period is null or period = ''custom'' or period ~ ''^[0-9]{4}-(Q[1-4]|H[12]|FY)$'''),
    ('goals_icon_check',       'icon is null or char_length(icon) <= 16'),
    ('goals_color_check',      'color is null or char_length(color) <= 64'),
    ('goals_contributors_check', 'cardinality(contributors) <= 50')
  ) as x(name, expr) loop
    begin
      execute format('alter table public.goals add constraint %I check (%s)', c.name, c.expr);
    exception when duplicate_object then null;
    end;
  end loop;
end $checks$;
create index if not exists goals_owner_idx on public.goals (owner_id);
create index if not exists goals_parent_idx on public.goals (parent_id);

-- A named period's first and last day: 2027-Q1, 2027-H2, 2027-FY (the calendar year).
-- (Mirrored in src/lib/goalPeriods.ts; null for anything else.)
create or replace function public.goal_period_bounds(p text, out period_start date, out period_end date)
language plpgsql immutable set search_path = pg_catalog as $$
declare y integer; part text;
begin
  if p is null or p !~ '^[0-9]{4}-(Q[1-4]|H[12]|FY)$' then return; end if;
  y := substr(p, 1, 4)::integer; part := substr(p, 6);
  if part = 'FY' then period_start := make_date(y, 1, 1); period_end := make_date(y, 12, 31);
  elsif part like 'H%' then
    period_start := make_date(y, case part when 'H1' then 1 else 7 end, 1);
    period_end := (period_start + interval '6 months' - interval '1 day')::date;
  else
    period_start := make_date(y, (substr(part, 2)::integer - 1) * 3 + 1, 1);
    period_end := (period_start + interval '3 months' - interval '1 day')::date;
  end if;
end; $$;
grant execute on function public.goal_period_bounds(text) to authenticated, service_role;

-- ---------- 2. THE RULES ----------
-- Who reads a goal (ANDed with 0041's "member" read and 0051's guest lock).
create or replace function public.goal_visible(p_ws uuid, p_visibility text, p_owner uuid, p_contributors uuid[])
returns boolean language sql stable set search_path = public as $$
  select p_ws is null or coalesce(p_visibility, 'everyone') <> 'leadership'
      or public.ws_role(p_ws) in ('owner', 'admin')
      or p_owner = auth.uid() or auth.uid() = any (coalesce(p_contributors, '{}'));
$$;
-- Who edits a goal, deletes it, checks in on it and links work to it.
create or replace function public.goal_editable(p_ws uuid, p_owner uuid, p_contributors uuid[], p_user uuid)
returns boolean language sql stable set search_path = public as $$
  select case when p_ws is null then p_user = auth.uid() and public.can_act()
    else public.can_write(p_ws) and (public.ws_role(p_ws) in ('owner', 'admin')
         or p_owner = auth.uid() or auth.uid() = any (coalesce(p_contributors, '{}'))) end;
$$;
-- Where a new goal may go: a company goal (a team goal with no parent) is for
-- owners and admins; a key result under a goal is for whoever may edit that goal.
-- (Reads the parent as the caller: a goal you can't see can't take one.)
create or replace function public.goal_may_place(p_ws uuid, p_parent uuid)
returns boolean language sql stable set search_path = public as $$
  select case when p_ws is null then true
    when p_parent is null then public.ws_role(p_ws) in ('owner', 'admin')
    else exists (select 1 from public.goals p
                  where p.id = p_parent and p.workspace_id = p_ws
                    and public.goal_editable(p.workspace_id, p.owner_id, p.contributors, p.user_id)) end;
$$;
-- Who reads a goal, given what's above it: goal_visible for the goal itself and for every
-- goal above it, so a leadership-only goal hides its key results (and theirs) too, without
-- anyone having to lock each one, and opening it up again shows them as they were. The
-- people of a goal always read it (its owner and contributors; on a goal above it, the
-- whole branch below), and owners and admins read every one. Reads the goals above past
-- row security (it's the rule that decides), and only within the workspace: for a guest
-- or an outsider it says no outright (0041 and 0051 keep them out of team goals anyway),
-- so asking it about any goal tells nobody more than reading the goal would.
create or replace function public.goal_readable(p_ws uuid, p_visibility text, p_owner uuid, p_contributors uuid[], p_parent uuid)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  my_role text;
  cur uuid := p_parent;
  g record;
  hops integer := 0;
begin
  if p_ws is null then return true; end if;   -- personal: its creator's alone (0041 decides)
  my_role := public.ws_role(p_ws);
  if my_role in ('owner', 'admin') then return true; end if;
  if my_role is distinct from 'member' then return false; end if;
  if p_owner = me or me = any (coalesce(p_contributors, '{}')) then return true; end if;
  if coalesce(p_visibility, 'everyone') = 'leadership' then return false; end if;
  while cur is not null and hops < 100 loop
    select x.visibility, x.owner_id, x.contributors, x.parent_id into g
      from public.goals x where x.id = cur and x.workspace_id = p_ws;
    if not found then return true; end if;
    if g.owner_id = me or me = any (coalesce(g.contributors, '{}')) then return true; end if;
    if g.visibility = 'leadership' then return false; end if;
    cur := g.parent_id; hops := hops + 1;
  end loop;
  return true;
end; $$;
grant execute on function public.goal_visible(uuid, text, uuid, uuid[]) to authenticated;
grant execute on function public.goal_readable(uuid, text, uuid, uuid[], uuid) to authenticated;
grant execute on function public.goal_editable(uuid, uuid, uuid[], uuid) to authenticated;
grant execute on function public.goal_may_place(uuid, uuid) to authenticated;

-- ---------- 3. goals: what a write may and may not do ----------
-- A signed-in person's write: the owner and contributors are active members (never
-- guests), only owners, admins and the goal's owner hand it over or change who can
-- see it, moving it to the top makes it a company goal (owners and admins), a parent
-- is in the same workspace and never below the goal itself. Server-side writers (the
-- SQL editor, the service role) are trusted. A named period fills its dates.
create or replace function public.goals_v2_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  signed_in boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
  bounds record;
  added uuid[];
  par record;
  hops integer := 0;
  cur uuid;
begin
  -- the period and its dates
  new.period := nullif(btrim(coalesce(new.period, '')), '');
  if new.period is null then
    new.period_start := null; new.period_end := null;
  elsif new.period = 'custom' then
    if new.period_start is null or new.period_end is null or new.period_end < new.period_start then
      raise exception 'a custom period needs a start date and an end date, in that order';
    end if;
  else
    select * into bounds from public.goal_period_bounds(new.period);
    if bounds.period_start is null then raise exception 'unknown period %', new.period; end if;
    new.period_start := bounds.period_start; new.period_end := bounds.period_end;
  end if;

  if tg_op = 'UPDATE' and signed_in then
    -- a goal stays in its workspace (its check-ins and links do too)
    new.workspace_id := old.workspace_id;
  end if;

  -- a personal goal is its creator's: no one else owns, helps or sees it
  if new.workspace_id is null then
    new.owner_id := new.user_id; new.contributors := '{}'; new.visibility := 'everyone';
  else
    if tg_op = 'INSERT' then
      new.owner_id := coalesce(new.owner_id, case when signed_in then me end, new.user_id);
    end if;
    -- contributors: once each, and not the owner
    select coalesce(array_agg(distinct c order by c), '{}') into new.contributors
      from unnest(coalesce(new.contributors, '{}')) as c where c is not null and c is distinct from new.owner_id;

    -- (someone who can't write here at all is refused by row security, as before)
    if signed_in and public.can_write(new.workspace_id) then
      -- handing over: owners, admins and the goal's owner. (An owner whose account has
      -- gone empties by itself: the foreign key's SET NULL, never refused.)
      if tg_op = 'UPDATE'
         and (new.owner_id is distinct from old.owner_id or new.contributors is distinct from old.contributors
              or new.visibility is distinct from old.visibility)
         and not (public.ws_role(new.workspace_id) in ('owner', 'admin') or old.owner_id = me)
         and not (new.owner_id is null and old.owner_id is not null
                  and not exists (select 1 from auth.users u where u.id = old.owner_id)
                  and new.contributors is not distinct from old.contributors and new.visibility is not distinct from old.visibility) then
        raise exception 'only the goal''s owner, or an owner or admin of this workspace, can change who owns it, who helps or who can see it';
      end if;
      -- the people named are members of this workspace (not guests)
      if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
         and not exists (select 1 from public.workspace_members m
                          where m.workspace_id = new.workspace_id and m.user_id = new.owner_id
                            and m.status = 'active' and m.role in ('owner', 'admin', 'member'))
         and not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.owner_id = new.owner_id) then
        raise exception 'a goal''s owner has to be a member of its workspace';
      end if;
      added := array(select unnest(new.contributors) except select unnest(case when tg_op = 'UPDATE' then old.contributors else '{}'::uuid[] end));
      if exists (select 1 from unnest(added) as a
                  where not exists (select 1 from public.workspace_members m
                                     where m.workspace_id = new.workspace_id and m.user_id = a
                                       and m.status = 'active' and m.role in ('owner', 'admin', 'member'))
                    and not exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.owner_id = a)) then
        raise exception 'everyone helping on a goal has to be a member of its workspace';
      end if;
      -- to the top level: a company goal, for owners and admins (a parent being
      -- deleted lets its sub-goals go up: the foreign key's SET NULL, never refused)
      if tg_op = 'UPDATE' and new.parent_id is null and old.parent_id is not null
         and public.ws_role(new.workspace_id) not in ('owner', 'admin')
         and exists (select 1 from public.goals g where g.id = old.parent_id) then
        raise exception 'only owners and admins set the workspace''s top-level goals';
      end if;
    end if;
  end if;

  -- a parent: in the same place, editable by whoever moves the goal under it, never the goal's own sub-goal
  if new.parent_id is not null and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id) then
    if new.parent_id = new.id then raise exception 'a goal can''t sit under itself'; end if;
    select g.workspace_id, g.user_id, g.owner_id, g.contributors into par from public.goals g where g.id = new.parent_id;
    if not found or par.workspace_id is distinct from new.workspace_id
       or (new.workspace_id is null and par.user_id is distinct from new.user_id) then
      raise exception 'a goal''s parent has to be in the same workspace';
    end if;
    if signed_in and tg_op = 'UPDATE' and not public.goal_editable(par.workspace_id, par.owner_id, par.contributors, par.user_id) then
      raise exception 'you can only put a goal under one you can edit';
    end if;
    cur := new.parent_id;
    while cur is not null and hops < 100 loop
      if cur = new.id then raise exception 'a goal can''t sit under one of its own sub-goals'; end if;
      select g.parent_id into cur from public.goals g where g.id = cur;
      hops := hops + 1;
    end loop;
  end if;

  -- the project its % comes from is its own workspace's (a personal goal: its creator's personal
  -- work), as its links are: never another business's project, chips and all
  if signed_in and new.project_id is not null and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and not exists (select 1 from public.projects p where p.id::text = new.project_id
                      and p.workspace_id is not distinct from new.workspace_id
                      and (new.workspace_id is not null or p.user_id = new.user_id)) then
    raise exception 'a goal can only read its progress from a project in its own workspace';
  end if;
  return new;
end; $$;
revoke execute on function public.goals_v2_guard() from public, anon, authenticated;
drop trigger if exists trg_goals_v2_guard on public.goals;
create trigger trg_goals_v2_guard before insert or update on public.goals
  for each row execute function public.goals_v2_guard();

-- Deleting a goal keeps its key results, as goals of their own (the foreign key's SET NULL),
-- so a team goal with any under it would hand them to the top level: company goals, which
-- are for owners and admins. They alone delete one; everyone else moves or deletes its key
-- results first. (Deleting a workspace or an account takes its goals as it always did: those
-- deletes arrive through a foreign key, a trigger deeper.)
create or replace function public.goals_delete_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.workspace_id is not null and coalesce(auth.role(), '') in ('authenticated', 'anon') and pg_trigger_depth() = 1
     and exists (select 1 from public.goals c where c.parent_id = old.id and c.id <> old.id)
     and coalesce(public.ws_role(old.workspace_id), '') not in ('owner', 'admin') then
    raise exception 'only owners and admins delete a goal with key results under it: move or delete them first';
  end if;
  return old;
end; $$;
revoke execute on function public.goals_delete_guard() from public, anon, authenticated;
drop trigger if exists trg_goals_delete_guard on public.goals;
create trigger trg_goals_delete_guard before delete on public.goals
  for each row execute function public.goals_delete_guard();

-- ---------- 4. check-ins ----------
create table if not exists public.goal_checkins (
  id           uuid primary key default gen_random_uuid(),
  goal_id      uuid not null references public.goals (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,   -- the goal's (set below, never from the request)
  author_id    uuid references auth.users (id) on delete set null,          -- the person posting; null once their account is gone
  value        numeric not null,
  confidence   smallint check (confidence is null or confidence between 1 and 5),
  note         text check (note is null or char_length(note) <= 500),
  created_at   timestamptz not null default now()
);
-- the goal's value just before it (the server's): taking back the only check-in puts it back
alter table public.goal_checkins add column if not exists prev_value numeric;
create index if not exists goal_checkins_goal_idx on public.goal_checkins (goal_id, created_at desc);
create index if not exists goal_checkins_ws_idx on public.goal_checkins (workspace_id);
create index if not exists goal_checkins_author_idx on public.goal_checkins (author_id);

-- The goal's workspace, the author (the person posting), the time and the value before it
-- are the server's. Afterwards none of them change, except the author emptying once that
-- account is deleted; nor does a signed-in person change the value (take it back, post another).
create or replace function public.goal_checkins_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare signed_in boolean := coalesce(auth.role(), '') in ('authenticated', 'anon'); g record;
begin
  if tg_op = 'INSERT' then
    select x.workspace_id, x.owner_id, x.user_id, x.contributors, x.current into g from public.goals x where x.id = new.goal_id;
    -- someone who may not check in on this goal is refused by row security (and learns nothing here)
    if not found or (signed_in and not public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id)) then
      if signed_in then return new; end if;
      raise exception 'no such goal';
    end if;
    new.workspace_id := g.workspace_id;
    new.note := nullif(btrim(coalesce(new.note, '')), '');
    if signed_in then
      new.author_id := auth.uid(); new.created_at := now(); new.prev_value := g.current;
    else
      new.author_id := coalesce(new.author_id, g.owner_id, g.user_id); new.prev_value := coalesce(new.prev_value, g.current);
    end if;
    return new;
  end if;
  new.goal_id := old.goal_id; new.workspace_id := old.workspace_id; new.prev_value := old.prev_value;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  if signed_in then new.created_at := old.created_at; new.value := old.value; end if;
  if new.author_id is distinct from old.author_id
     and not (new.author_id is null and not exists (select 1 from auth.users u where u.id = old.author_id)) then
    new.author_id := old.author_id;
  end if;
  return new;
end; $$;
revoke execute on function public.goal_checkins_guard() from public, anon, authenticated;
drop trigger if exists trg_goal_checkins_guard on public.goal_checkins;
create trigger trg_goal_checkins_guard before insert or update on public.goal_checkins
  for each row execute function public.goal_checkins_guard();

-- The newest check-in is the goal's current value (and confidence). Runs as the
-- person posting (they may edit the goal, or they couldn't have posted). One at a time
-- per goal (its row locked first), so two check-ins posted together can't leave the
-- older one's value behind.
create or replace function public.goal_checkins_apply() returns trigger
language plpgsql set search_path = public as $$
declare latest record; gid uuid := case when tg_op = 'DELETE' then old.goal_id else new.goal_id end;
begin
  perform 1 from public.goals g where g.id = gid for update;
  if tg_op <> 'DELETE' then
    -- a new one (or a server-side fix to one's value): the newest is the goal's value
    if not exists (select 1 from public.goal_checkins c
                    where c.goal_id = gid and c.id <> new.id
                      and (c.created_at > new.created_at or (c.created_at = new.created_at and c.id > new.id))) then
      update public.goals set current = new.value, confidence = coalesce(new.confidence, confidence) where id = gid;
    end if;
    return new;
  end if;
  -- the newest one taken back: the one before it is the value again (the only one: the value before it)
  if not exists (select 1 from public.goal_checkins c
                  where c.goal_id = gid
                    and (c.created_at > old.created_at or (c.created_at = old.created_at and c.id > old.id))) then
    select c.value, c.confidence into latest from public.goal_checkins c
     where c.goal_id = gid order by c.created_at desc, c.id desc limit 1;
    if found then
      update public.goals set current = latest.value, confidence = coalesce(latest.confidence, confidence) where id = gid;
    elsif old.prev_value is not null then
      update public.goals set current = old.prev_value where id = gid;
    end if;
  end if;
  return old;
end; $$;
revoke execute on function public.goal_checkins_apply() from public, anon, authenticated;
drop trigger if exists trg_goal_checkins_apply on public.goal_checkins;
create trigger trg_goal_checkins_apply after insert or delete or update of value on public.goal_checkins
  for each row execute function public.goal_checkins_apply();

-- ---------- 5. links: a goal to projects, tasks and saved views ----------
create table if not exists public.goal_links (
  id           uuid primary key default gen_random_uuid(),
  goal_id      uuid not null references public.goals (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,   -- the goal's (set below)
  kind         text not null check (kind in ('project', 'task', 'view')),
  target_id    text not null check (char_length(target_id) <= 64),
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (goal_id, kind, target_id)
);
create index if not exists goal_links_ws_idx on public.goal_links (workspace_id);
create index if not exists goal_links_target_idx on public.goal_links (kind, target_id);

-- A link stays in the goal's workspace: a team goal links that workspace's projects,
-- tasks and shared views; a personal goal its creator's personal ones. Never another
-- workspace's, whoever asks (server-side writers too).
create or replace function public.goal_links_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record; ok boolean := false;
begin
  if tg_op = 'UPDATE' then
    -- only its maker emptying (that account deleted) or a server-side tidy; what it links never changes
    if (new.goal_id, new.kind, new.target_id) is distinct from (old.goal_id, old.kind, old.target_id) then
      raise exception 'a goal link can''t be changed: remove it and add another';
    end if;
    new.workspace_id := old.workspace_id; new.created_at := old.created_at;
    return new;
  end if;
  select x.workspace_id, x.user_id, x.owner_id, x.contributors into g from public.goals x where x.id = new.goal_id;
  -- someone who may not edit this goal is refused by row security (and learns nothing here)
  if not found or (coalesce(auth.role(), '') in ('authenticated', 'anon')
                   and not public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id)) then
    if coalesce(auth.role(), '') in ('authenticated', 'anon') then return new; end if;
    raise exception 'no such goal';
  end if;
  new.workspace_id := g.workspace_id;
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    new.created_by := auth.uid(); new.created_at := now();
  end if;
  if new.kind = 'project' then
    ok := exists (select 1 from public.projects p where p.id::text = new.target_id
                    and p.workspace_id is not distinct from g.workspace_id
                    and (g.workspace_id is not null or p.user_id = g.user_id));
  elsif new.kind = 'task' then
    ok := exists (select 1 from public.tasks t where t.id::text = new.target_id
                    and t.workspace_id is not distinct from g.workspace_id
                    and (g.workspace_id is not null or t.user_id = g.user_id));
  elsif new.kind = 'view' and to_regclass('public.saved_views') is not null then
    execute 'select exists (select 1 from public.saved_views v where v.id::text = $1
               and ((v.workspace_id = $2 and v.shared) or ($2 is null and v.workspace_id is null and v.user_id = $3)))'
      into ok using new.target_id, g.workspace_id, g.user_id;
  end if;
  if not ok then raise exception 'a goal can only link to work in its own workspace'; end if;
  return new;
end; $$;
revoke execute on function public.goal_links_guard() from public, anon, authenticated;
drop trigger if exists trg_goal_links_guard on public.goal_links;
create trigger trg_goal_links_guard before insert or update on public.goal_links
  for each row execute function public.goal_links_guard();

-- ---------- 6. row security (and its restore hook for 0041) ----------
alter table public.goal_checkins enable row level security;
alter table public.goal_links enable row level security;
revoke all on public.goal_checkins, public.goal_links from anon;
revoke all on public.goal_checkins, public.goal_links from authenticated;
grant select, insert, update, delete on public.goal_checkins to authenticated;
grant select, insert, delete on public.goal_links to authenticated;
do $svc$ begin
  grant select, insert, update, delete on public.goal_checkins, public.goal_links to service_role;
exception when undefined_object then null; end $svc$;

-- (Re)creates every policy here: the rules on goals (restrictive, ANDed with 0041's
-- and 0051's), and all of goal_checkins' and goal_links'. Run below, and by 0041 when
-- it's run again (it drops every policy on goals). Returns how many it made.
create or replace function public.goal_rules_restore()
returns integer language plpgsql set search_path = public as $$
declare t text; pol record; n integer := 0;
  editable_goal text := 'exists (select 1 from public.goals g where g.id = goal_id
                          and public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id))';
begin
  -- goals: leadership-only reading, and who edits, deletes and creates
  drop policy if exists "goals: leadership only" on public.goals;
  drop policy if exists "goals: owners, admins, owner and contributors edit" on public.goals;
  drop policy if exists "goals: owners, admins, owner and contributors delete" on public.goals;
  drop policy if exists "goals: company goals are for owners and admins" on public.goals;
  create policy "goals: leadership only" on public.goals as restrictive for select
    using (public.goal_readable(workspace_id, visibility, owner_id, contributors, parent_id));
  create policy "goals: owners, admins, owner and contributors edit" on public.goals as restrictive for update
    using (public.goal_editable(workspace_id, owner_id, contributors, user_id)) with check (true);
  create policy "goals: owners, admins, owner and contributors delete" on public.goals as restrictive for delete
    using (public.goal_editable(workspace_id, owner_id, contributors, user_id));
  create policy "goals: company goals are for owners and admins" on public.goals as restrictive for insert
    with check (public.goal_may_place(workspace_id, parent_id));
  n := n + 4;

  foreach t in array array['goal_checkins', 'goal_links'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    -- read with the goal: its read rules (members, leadership only, guests) are this row's
    execute format('create policy "read: with its goal" on public.%I for select using (exists (select 1 from public.goals g where g.id = goal_id))', t);
    execute format('create policy "add: goal editors" on public.%I for insert with check (%s)', t, editable_goal);
    -- the same guest lock as 0051's on goals (belt and braces: the goal is already out of reach)
    execute format('create policy "guests: no team reports" on public.%I as restrictive for select using '
                   || '(workspace_id is null or public.ws_role(workspace_id) <> ''guest'')', t);
    n := n + 3;
    if to_regprocedure('public.api_scope_ok(uuid)') is not null then
      execute format('create policy "api key scope" on public.%I as restrictive for all using (public.api_scope_ok(workspace_id)) with check (public.api_scope_ok(workspace_id))', t);
      n := n + 1;
    end if;
  end loop;
  -- a check-in: its author fixes it while they may edit the goal; the author, an owner or
  -- an admin takes it back (a personal goal's creator, theirs)
  create policy "edit: the author" on public.goal_checkins for update
    using (author_id = auth.uid() and exists (select 1 from public.goals g where g.id = goal_id
             and public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id)))
    with check (author_id = auth.uid());
  create policy "delete: the author, an owner or an admin" on public.goal_checkins for delete
    using (exists (select 1 from public.goals g where g.id = goal_id and (
             (author_id = auth.uid() and public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id))
             or (g.workspace_id is not null and public.can_write(g.workspace_id) and public.ws_role(g.workspace_id) in ('owner', 'admin'))
             or (g.workspace_id is null and g.user_id = auth.uid() and public.can_act()))));
  -- a link: whoever may edit the goal takes it off (links aren't edited, only added and removed)
  create policy "remove: goal editors" on public.goal_links for delete using (exists (select 1 from public.goals g where g.id = goal_id
             and public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id)));
  return n + 3;
end; $$;
revoke execute on function public.goal_rules_restore() from public, anon, authenticated;

-- Is every rule in place (row security on, the restrictive ones restrictive)?
create or replace function public.goal_rules_intact()
returns boolean language sql stable set search_path = pg_catalog, public as $$
  select coalesce((select bool_and(c.relrowsecurity) from pg_catalog.pg_class c
                    where c.oid in (to_regclass('public.goals'), to_regclass('public.goal_checkins'), to_regclass('public.goal_links'))), false)
     and (select count(*) from pg_catalog.pg_policy p where p.polrelid = to_regclass('public.goals') and not p.polpermissive
            and p.polname in ('goals: leadership only', 'goals: owners, admins, owner and contributors edit',
                              'goals: owners, admins, owner and contributors delete', 'goals: company goals are for owners and admins')) = 4
     -- (the leadership rule looks up the tree: a leadership-only goal hides the goals under it)
     and exists (select 1 from pg_catalog.pg_policy p where p.polrelid = to_regclass('public.goals') and p.polname = 'goals: leadership only'
                  and pg_catalog.pg_get_expr(p.polqual, p.polrelid) ~ 'goal_readable')
     and (select count(*) from pg_catalog.pg_policy p where not p.polpermissive and p.polname = 'guests: no team reports'
            and p.polrelid in (to_regclass('public.goal_checkins'), to_regclass('public.goal_links'))) = 2
     and (select count(*) from pg_catalog.pg_policy p where p.polrelid = to_regclass('public.goal_checkins')
            and p.polname in ('read: with its goal', 'add: goal editors', 'edit: the author', 'delete: the author, an owner or an admin')) = 4
     and (select count(*) from pg_catalog.pg_policy p where p.polrelid = to_regclass('public.goal_links')
            and p.polname in ('read: with its goal', 'add: goal editors', 'remove: goal editors')) = 3
     and (to_regprocedure('public.api_scope_ok(uuid)') is null
          or (select count(*) from pg_catalog.pg_policy p where not p.polpermissive and p.polname = 'api key scope'
                and p.polrelid in (to_regclass('public.goal_checkins'), to_regclass('public.goal_links'))) = 2);
$$;
revoke execute on function public.goal_rules_intact() from public, anon, authenticated;

do $rules$
begin
  perform public.goal_rules_restore();
end $rules$;

-- ---------- 7. what was there before ----------
-- Once only (a re-run never refills an owner whose account has since gone): each goal's
-- owner is its creator, if they're still a member of its workspace; a goal whose life
-- (created to due) sits in one quarter takes that quarter; a linked project becomes a link.
do $fill$
begin
  if not exists (select 1 from public.schema_migrations where version = '0052') then
    update public.goals g set owner_id = g.user_id
     where g.owner_id is null and g.workspace_id is not null
       and (exists (select 1 from public.workspace_members m where m.workspace_id = g.workspace_id and m.user_id = g.user_id
                     and m.status = 'active' and m.role in ('owner', 'admin', 'member'))
            or exists (select 1 from public.workspaces w where w.id = g.workspace_id and w.owner_id = g.user_id));
    update public.goals g set owner_id = g.user_id where g.owner_id is null and g.workspace_id is null;
    update public.goals g set period = to_char(g.due, 'YYYY') || '-Q' || extract(quarter from g.due)::int
     where g.period is null and g.due is not null
       and date_trunc('quarter', g.created_at at time zone 'UTC') = date_trunc('quarter', g.due::timestamp);
    insert into public.goal_links (goal_id, kind, target_id, created_by, created_at)
    select g.id, 'project', g.project_id, g.user_id, g.created_at from public.goals g
     where g.project_id is not null
       and exists (select 1 from public.projects p where p.id::text = g.project_id
                    and p.workspace_id is not distinct from g.workspace_id
                    and (g.workspace_id is not null or p.user_id = g.user_id))
    on conflict (goal_id, kind, target_id) do nothing;
  end if;
end $fill$;

-- ---------- 8. live sync ----------
do $rt$
declare t text;
begin
  foreach t in array array['goal_checkins', 'goal_links'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;                  -- already streaming
      when object_not_in_prerequisite_state then null;  -- publication is FOR ALL TABLES
      when undefined_object then null;                  -- no realtime here
    end;
  end loop;
end $rt$;

-- ---------- 8b. goals in Search and ⌘K ----------
-- search_all (0048) gains goals, between projects and people: the same function, word for
-- word, with a goals branch (and 'goal' among the kinds). Still SECURITY INVOKER, so a goal
-- only comes back to someone who can read it (0041's members, 0051's guest lock, and the
-- leadership-only rule above). Only where 0048 is in (its kanbo_fts); without it there's
-- no search_all to extend. goal_search_restore() does it, here and from 0048's last
-- section: re-running 0048 puts its own search_all back, then calls this to put goals back.
create or replace function public.goal_search_restore()
returns boolean language plpgsql set search_path = public as $search$
begin
  if to_regprocedure('public.kanbo_fts(text, text)') is null then
    raise notice '0052: 0048 is not in, so goals join search when it is (run this file again then)';
    return false;
  end if;
  execute 'create index if not exists goals_fts_idx on public.goals using gin (public.kanbo_fts(name, description))';
  execute $fn52$
create or replace function public.search_all(q text, filters jsonb default '{}'::jsonb, lim integer default 20)
returns table (kind text, id uuid, title text, snippet text, rank real, task_id uuid, project_id text,
               workspace_id uuid, meta jsonb, updated_at timestamptz)
language plpgsql stable security invoker set search_path = public, pg_temp as $$
#variable_conflict use_column
declare
  me        uuid := auth.uid();
  f         jsonb := case when jsonb_typeof(filters) = 'object' then filters else '{}'::jsonb end;
  n         integer := least(greatest(coalesce(lim, 20), 1), 50);
  txt       text := left(btrim(coalesce(q, '')), 200);
  mk_on     constant text := chr(57344);   -- U+E000
  mk_off    constant text := chr(57345);   -- U+E001
  hl_opts   text;
  lexes     text[];
  w         text;
  part      tsquery;
  tsq_s     tsquery;
  tsq_e     tsquery;
  tsq       tsquery;
  like_q    text;
  kinds     text[] := array['task', 'comment', 'doc', 'project', 'goal', 'person'];
  scope_all boolean := true;
  scope_personal boolean := false;
  scope_ws  uuid;
  ws_ids    uuid[];
  f_project text;
  f_assignee text;
  f_statuses text[];
  f_exclude_done boolean := false;
  f_due_from date;
  f_due_to  date;
  f_author  uuid;
  f_archived boolean := false;
  task_filtered boolean;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  hl_opts := 'StartSel=' || mk_on || ', StopSel=' || mk_off || ', MaxWords=24, MinWords=8, ShortWord=2, MaxFragments=1';

  begin
    if f ? 'kinds' then
      if jsonb_typeof(f -> 'kinds') <> 'array' then raise exception 'kinds'; end if;
      select coalesce(array_agg(k), '{}') into kinds
        from jsonb_array_elements_text(f -> 'kinds') k
       where k in ('task', 'comment', 'doc', 'project', 'goal', 'person');
    end if;
    if f ? 'workspace_id' then
      if jsonb_typeof(f -> 'workspace_id') = 'null' or f ->> 'workspace_id' = 'personal' then
        scope_all := false; scope_personal := true;
      else
        scope_all := false; scope_ws := (f ->> 'workspace_id')::uuid;
      end if;
    end if;
    f_project := nullif(f ->> 'project_id', '');
    f_assignee := nullif(f ->> 'assignee_id', '');
    if f ? 'statuses' then
      if jsonb_typeof(f -> 'statuses') <> 'array' then raise exception 'statuses'; end if;
      select array_agg(s) into f_statuses from jsonb_array_elements_text(f -> 'statuses') s;
      f_statuses := coalesce(f_statuses, '{}');
    end if;
    f_exclude_done := coalesce((f ->> 'exclude_done')::boolean, false);
    f_due_from := nullif(f ->> 'due_from', '')::date;
    f_due_to := nullif(f ->> 'due_to', '')::date;
    f_author := nullif(f ->> 'author_id', '')::uuid;
    f_archived := coalesce((f ->> 'include_archived')::boolean, false);
  exception when others then
    raise exception 'invalid filters';
  end;
  task_filtered := f_project is not null or f_assignee is not null or f_statuses is not null or f_exclude_done
                   or f_due_from is not null or f_due_to is not null;

  -- the caller's workspaces (guests included, as the read policies have it)
  select coalesce(array_agg(distinct x.w), '{}') into ws_ids
    from (select m.workspace_id as w from public.workspace_members m where m.user_id = me and m.status = 'active'
          union
          select ws.id from public.workspaces ws where ws.owner_id = me) x;
  if scope_ws is not null and not (scope_ws = any (ws_ids)) then return; end if;

  -- the words: lexemes from the text-search parser itself (no tsquery syntax
  -- ever reaches to_tsquery), each as typed or as a prefix, all required
  if txt <> '' then
    select array_agg(l.lexeme order by l.positions[1], l.lexeme) into lexes
      from unnest(to_tsvector('simple', translate(txt, chr(92) || chr(39), '  '))) l;
    if lexes is not null then
      foreach w in array lexes[1:8] loop
        part := ('''' || replace(w, '''', '''''') || '''' || case when char_length(w) >= 2 then ':*' else '' end)::tsquery;
        tsq_s := case when tsq_s is null then part else tsq_s && part end;
      end loop;
      tsq_e := plainto_tsquery('english', txt);
      if tsq_e is not null and numnode(tsq_e) = 0 then tsq_e := null; end if;
      tsq := case when tsq_e is null then tsq_s else tsq_s || tsq_e end;
      like_q := replace(replace(replace(lower(txt), chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_');
    end if;
  end if;
  if tsq is null and not task_filtered then return; end if;

  -- tasks
  if 'task' = any (kinds) then
    return query
    with hits as (
      select t.id, t.title, t.description, t.status, t.priority, t.due_date, t.assignee_id, t.project_id,
             t.workspace_id, t.parent_id, t.archived_at, t.updated_at,
             ((case when tsq is null then 0 else ts_rank(public.kanbo_fts(t.title, t.description), tsq) end)
               * (case when like_q is not null and lower(t.title) like like_q || '%' then 2 else 1 end))::real as r
        from public.tasks t
       where ((scope_all and (t.workspace_id = any (ws_ids) or (t.workspace_id is null and t.user_id = me)))
           or (scope_personal and t.workspace_id is null and t.user_id = me)
           or (scope_ws is not null and t.workspace_id = scope_ws))
         and (tsq is null or public.kanbo_fts(t.title, t.description) @@ tsq)
         and (f_archived or t.archived_at is null)
         and (f_project is null or t.project_id = f_project)
         and (f_assignee is null or t.assignee_id = f_assignee or f_assignee = any (t.collaborators))
         and (f_statuses is null or t.status = any (f_statuses))
         and (not f_exclude_done or t.status <> 'done')
         and (f_due_from is null or t.due_date >= f_due_from)
         and (f_due_to is null or t.due_date <= f_due_to)
         and (f_archived or not exists (select 1 from public.projects p
                                         where p.id::text = t.project_id and p.archived_at is not null))
       order by r desc, (case when tsq is null then t.due_date end) asc nulls last, t.updated_at desc, t.id
       limit n)
    select 'task'::text, h.id, h.title,
           case when coalesce(h.description, '') = '' then null
                when tsq_s is null then left(h.description, 160)
                else ts_headline('simple', left(replace(replace(h.description, mk_on, ''), mk_off, ''), 5000), tsq_s, hl_opts) end,
           h.r, h.id, h.project_id, h.workspace_id,
           jsonb_build_object('status', h.status, 'priority', h.priority, 'due_date', h.due_date,
                              'assignee_id', h.assignee_id, 'parent_id', h.parent_id, 'archived', h.archived_at is not null),
           h.updated_at
      from hits h;
  end if;

  if tsq is null then return; end if;

  -- comments (on tasks you can see)
  if 'comment' = any (kinds) then
    return query
    with hits as (
      select c.id, c.task_id, c.body, c.user_id, c.author_name, c.created_at,
             t.title as task_title, t.project_id, t.workspace_id, t.status,
             ts_rank(public.kanbo_fts(''::text, c.body), tsq)::real as r
        from public.comments c
        join public.tasks t on t.id = c.task_id
       where public.kanbo_fts(''::text, c.body) @@ tsq
         and ((scope_all and (t.workspace_id = any (ws_ids) or (t.workspace_id is null and t.user_id = me)))
           or (scope_personal and t.workspace_id is null and t.user_id = me)
           or (scope_ws is not null and t.workspace_id = scope_ws))
         and (f_archived or t.archived_at is null)
         and (f_project is null or t.project_id = f_project)
         and (f_author is null or c.user_id = f_author)
         and (f_archived or not exists (select 1 from public.projects p
                                         where p.id::text = t.project_id and p.archived_at is not null))
       order by r desc, c.created_at desc, c.id
       limit n)
    select 'comment'::text, h.id, h.task_title,
           ts_headline('simple', left(replace(replace(h.body, mk_on, ''), mk_off, ''), 5000), tsq_s, hl_opts),
           h.r, h.task_id, h.project_id, h.workspace_id,
           jsonb_build_object('author_id', h.user_id, 'author_name', h.author_name, 'task_status', h.status),
           h.created_at
      from hits h;
  end if;

  -- docs (of projects you can see)
  if 'doc' = any (kinds) then
    return query
    with hits as (
      select d.id, d.title, d.plain_text, d.icon, d.project_id, d.workspace_id, d.updated_at, d.updated_by,
             d.archived_at, p.name as project_name,
             (ts_rank(public.kanbo_fts(d.title, d.plain_text), tsq)
               * (case when lower(d.title) like like_q || '%' then 2 else 1 end))::real as r
        from public.project_docs d
        join public.projects p on p.id = d.project_id
       where public.kanbo_fts(d.title, d.plain_text) @@ tsq
         and ((scope_all and (d.workspace_id = any (ws_ids) or (d.workspace_id is null and p.user_id = me)))
           or (scope_personal and d.workspace_id is null and p.user_id = me)
           or (scope_ws is not null and d.workspace_id = scope_ws))
         and (f_archived or (d.archived_at is null and p.archived_at is null))
         and (f_project is null or d.project_id::text = f_project)
       order by r desc, d.updated_at desc, d.id
       limit n)
    select 'doc'::text, h.id, h.title,
           case when h.plain_text = '' then null
                else ts_headline('simple', left(replace(replace(h.plain_text, mk_on, ''), mk_off, ''), 5000), tsq_s, hl_opts) end,
           h.r, null::uuid, h.project_id::text, h.workspace_id,
           jsonb_build_object('icon', h.icon, 'project_name', h.project_name, 'updated_by', h.updated_by,
                              'archived', h.archived_at is not null),
           h.updated_at
      from hits h;
  end if;

  -- projects
  if 'project' = any (kinds) then
    return query
    with hits as (
      select p.id, p.name, p.description, p.emoji, p.color, p.status, p.owner_id, p.archived_at, p.workspace_id, p.created_at,
             (ts_rank(public.kanbo_fts(p.name, p.description), tsq)
               * (case when lower(p.name) like like_q || '%' then 2 else 1 end))::real as r
        from public.projects p
       where public.kanbo_fts(p.name, p.description) @@ tsq
         and ((scope_all and (p.workspace_id = any (ws_ids) or (p.workspace_id is null and p.user_id = me)))
           or (scope_personal and p.workspace_id is null and p.user_id = me)
           or (scope_ws is not null and p.workspace_id = scope_ws))
         and (f_archived or p.archived_at is null)
         and (f_project is null or p.id::text = f_project)
       order by r desc, p.created_at desc, p.id
       limit n)
    select 'project'::text, h.id, h.name,
           case when coalesce(h.description, '') = '' then null
                else ts_headline('simple', left(replace(replace(h.description, mk_on, ''), mk_off, ''), 5000), tsq_s, hl_opts) end,
           h.r, null::uuid, h.id::text, h.workspace_id,
           jsonb_build_object('emoji', h.emoji, 'color', h.color, 'status', h.status, 'owner_id', h.owner_id,
                              'archived', h.archived_at is not null),
           h.created_at
      from hits h;
  end if;

  -- goals (0052): by name and description, the goals you can read (members' only, never a
  -- guest's; a leadership-only goal only for its own people: the goals' own policies). A
  -- project filter narrows the other kinds, so goals sit it out.
  if 'goal' = any (kinds) and f_project is null then
    return query
    with hits as (
      select g.id, g.name, g.description, g.status, g.owner_id, g.period, g.kind, g.icon, g.color,
             g.archived_at, g.workspace_id, g.project_id, g.created_at,
             (ts_rank(public.kanbo_fts(g.name, g.description), tsq)
               * (case when lower(g.name) like like_q || '%' then 2 else 1 end))::real as r
        from public.goals g
       where public.kanbo_fts(g.name, g.description) @@ tsq
         and ((scope_all and (g.workspace_id = any (ws_ids) or (g.workspace_id is null and g.user_id = me)))
           or (scope_personal and g.workspace_id is null and g.user_id = me)
           or (scope_ws is not null and g.workspace_id = scope_ws))
         and (f_archived or g.archived_at is null)
       order by r desc, g.created_at desc, g.id
       limit n)
    select 'goal'::text, h.id, h.name,
           case when coalesce(h.description, '') = '' then null
                else ts_headline('simple', left(replace(replace(h.description, mk_on, ''), mk_off, ''), 5000), tsq_s, hl_opts) end,
           h.r, null::uuid, h.project_id, h.workspace_id,
           jsonb_build_object('status', h.status, 'owner_id', h.owner_id, 'period', h.period, 'kind', h.kind,
                              'icon', h.icon, 'color', h.color, 'archived', h.archived_at is not null),
           h.created_at
      from hits h;
  end if;

  -- people (active members of your workspaces; none in Personal)
  if 'person' = any (kinds) and like_q is not null and not scope_personal then
    return query
    with ppl as (
      select distinct on (m.user_id) m.user_id, m.workspace_id, m.role, m.title, pr.avatar_url,
             coalesce(nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''),
                      nullif(btrim(m.name), ''), m.email) as nm,
             coalesce(nullif(pr.email, ''), m.email) as em
        from public.workspace_members m
        left join public.profiles pr on pr.id = m.user_id
       where m.status = 'active' and m.user_id is not null
         and ((scope_all and m.workspace_id = any (ws_ids)) or (scope_ws is not null and m.workspace_id = scope_ws))
       order by m.user_id, m.created_at)
    select 'person'::text, p.user_id, p.nm, p.em,
           (case when lower(p.nm) like like_q || '%' then 1.0 else 0.5 end)::real,
           null::uuid, null::text, p.workspace_id,
           jsonb_build_object('email', p.em, 'role', p.role, 'title', p.title, 'avatar_url', p.avatar_url),
           null::timestamptz
      from ppl p
     where lower(p.nm) like '%' || like_q || '%' or lower(p.em) like like_q || '%'
     order by 5 desc, p.nm, p.user_id
     limit n;
  end if;
end; $$;
$fn52$;
  execute 'revoke execute on function public.search_all(text, jsonb, integer) from public, anon';
  execute 'grant execute on function public.search_all(text, jsonb, integer) to authenticated';
  return true;
end $search$;
revoke execute on function public.goal_search_restore() from public, anon, authenticated;
do $search$
begin
  perform public.goal_search_restore();
end $search$;

-- ---------- 9. 0058's project access survives a re-run of this file ----------
-- goal_rules_restore() drops every policy on goal_links, 0058's "project access:
-- read" too (and a first run after 0058 makes goal_links without 0058's trigger).  When 0058 is in, put it back.
do $projectaccess$
begin
  if to_regprocedure('public.project_access_restore()') is not null then
    perform public.project_access_restore();
  end if;
end $projectaccess$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0052') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0052')                           as recorded,
--   (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'goals'
--     and column_name in ('owner_id', 'contributors', 'period', 'period_start', 'period_end', 'start_value', 'direction',
--                         'confidence', 'kind', 'visibility', 'archived_at', 'icon', 'color', 'pace', 'weight')) = 15  as goal_columns,
--   public.goal_rules_intact()                                                                         as rules_intact,
--   public.guest_lock_intact()                                                                         as guest_lock,
--   (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'
--     and tablename in ('goal_checkins', 'goal_links')) = 2                                            as live_sync,
--   not exists (select 1 from public.goals where workspace_id is not null and owner_id is null
--                and exists (select 1 from public.workspace_members m where m.workspace_id = goals.workspace_id
--                             and m.user_id = goals.user_id and m.status = 'active' and m.role <> 'guest')) as owners_filled,
--   not has_function_privilege('authenticated', 'public.goal_rules_restore()', 'execute')
--   and not has_function_privilege('authenticated', 'public.goals_v2_guard()', 'execute')
--   and not has_function_privilege('authenticated', 'public.goal_search_restore()', 'execute')
--   and not has_function_privilege('authenticated', 'public.goals_delete_guard()', 'execute')          as hooks_private,
--   exists (select 1 from pg_trigger where tgname = 'trg_goals_delete_guard')                          as key_results_kept,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--     and table_name = 'goal_checkins' and column_name = 'prev_value')
--   and exists (select 1 from pg_trigger t where t.tgname = 'trg_goal_checkins_apply'
--     and t.tgtype & 16 = 16)                                                                          as checkin_records,
--   to_regprocedure('public.kanbo_fts(text, text)') is null
--   or (pg_get_functiondef(to_regprocedure('public.search_all(text, jsonb, integer)')) like '%''goal''::text%'
--       and not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.search_all(text, jsonb, integer)'))
--       and to_regclass('public.goals_fts_idx') is not null)                                           as goals_in_search;
-- ============================================================
-- <<<<<<<<<< end of 0052_goals_v2.sql <<<<<<<<<<

-- >>>>>>>>>> 0053_update_rhythm.sql >>>>>>>>>>
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
--      else owns who's still in the workspace and isn't a guest there (a
--      guest can't post an update); one ask per project in 20
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
-- admin); the project is live, owned by someone else who's still in the workspace and can post
-- its updates (not a guest); it hasn't been asked about in the last 20 hours; the caller has
-- asked fewer than 30 times today. A project the caller doesn't lead, or that isn't there,
-- gets the same answer (nothing given away about which exist).
create or replace function public.ask_for_update(p_project uuid)
returns public.update_asks language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  p record;
  r public.update_asks;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select id, workspace_id, owner_id, archived_at into p from public.projects where id = p_project;
  if not found or p.workspace_id is null or coalesce(public.ws_role(p.workspace_id), 'none') not in ('owner', 'admin') then
    raise exception 'not authorized';
  end if;
  if p.archived_at is not null then raise exception 'not allowed: the project is archived'; end if;
  if p.owner_id is null then raise exception 'not allowed: no owner'; end if;
  if p.owner_id = me then raise exception 'not allowed: your own project'; end if;
  if not exists (select 1 from public.workspace_members m
                  where m.workspace_id = p.workspace_id and m.user_id = p.owner_id and m.status = 'active')
     and not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id) then
    raise exception 'not allowed: the owner has left';
  end if;
  -- a guest can't post an update, so there's nothing to ask them for
  if not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id)
     and not exists (select 1 from public.workspace_members m where m.workspace_id = p.workspace_id and m.user_id = p.owner_id
                      and m.status = 'active' and m.role in ('owner', 'admin', 'member')) then
    raise exception 'not allowed: the owner is a guest';
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

-- ---------- 6. 0058's project access survives a re-run of this file ----------
-- A first run after 0058 makes update_asks without 0058's trigger on it.  When 0058 is in, put it back.
do $projectaccess$
begin
  if to_regprocedure('public.project_access_restore()') is not null then
    perform public.project_access_restore();
  end if;
end $projectaccess$;

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
-- <<<<<<<<<< end of 0053_update_rhythm.sql <<<<<<<<<<

-- >>>>>>>>>> 0054_update_conversation.sql >>>>>>>>>>
-- ============================================================
-- KANBO — project updates people can reply to, and portfolio pages
-- (2026-11-10).
--
--   1. status_updates: authors edit their own (an "edited" mark:
--      edited_at), and only the author (or the workspace's owners and
--      admins, to moderate) deletes one. Until now any member could
--      change or delete anyone's (0041 "edit/delete: personal or
--      writer"). Restrictive policies, ANDed with 0041's, so nobody gains
--      anything: personal updates stay their creator's, guests still
--      can't write. A team update must be about a project in its own
--      workspace (so its notices and webhook never name another team's
--      project). Who, where and when an update was posted can't be
--      changed afterwards. 0041 drops every policy on status_updates when
--      it's run again, so it calls update_conversation_restore() to put
--      these back (as it does for 0046's and 0051's).
--   2. status_updates.sections (jsonb): optional Highlights / Risks /
--      Asks / Next, {"highlights": "…", "risks": "…", "asks": "…",
--      "next": "…"}, each ≤ 2000 characters, nothing else in it.
--      status_updates.ask_user_ids: the people an Ask names (≤ 20; only
--      people who can read the update are kept; never its author).
--   3. Posting tells people (Inbox kind 'update', task_id null,
--      meta { status_update_id, project_id, update_event, update_status, ask }):
--      the project's owner and contributors as FYI (pref 'update'), and
--      anyone an Ask names as "Needs your reply" (pref 'mention'). An edit
--      that names someone new tells them. A deleted update takes its
--      Inbox items with it. Push and email: the notify function
--      ({kind: "status_update"}), with each person's digest and quiet hours.
--   4. status_update_comments: replies on an update (task comments need a
--      task). Anyone who can read the update comments, guests too; you
--      edit your own (edited_at); you delete your own, owners and admins
--      delete any (moderation). The update's author hears about each one
--      (FYI), and anyone it @mentions ("Needs your reply"); a deleted
--      comment takes those Inbox items with it. 120 comments an hour each,
--      counted so that deleting them doesn't start the hour again.
--   5. status_update_reactions: one of six emoji per person per update;
--      you add and take back only your own.
--   6. status_update_views: "Seen by 6". mark_status_updates_seen(ids)
--      records the caller (never the author) on the updates they can read;
--      nothing else writes it.
--   7. Webhooks: 'status_update.posted' (team and personal endpoints).
--      The notify queue takes kind 'update' (as 0053 has it), so an Ask's
--      push and email wait for the end of quiet hours even where 0053
--      isn't in yet.
--   8. Portfolio pages (c-portfolio-workspace, phase one): portfolios gain
--      owner_id, description, target_date, follower_ids, color, emoji.
--      A new portfolio's owner is its creator until they hand it on.
--      A team portfolio's owner and followers are kept to the workspace's
--      owners, admins and members (guests can't read portfolios, 0051).
--      portfolio_updates: a portfolio-level update. Read like the
--      portfolio (members and above; personal: its creator); posted by
--      its writers, edited by its author, deleted by its author or the
--      workspace's owners and admins. The owner and followers hear (FYI).
--
-- Needs 0041 (ws_role, can_act, can_write), 0042 (schema_migrations,
-- is_task_audience), 0046 (webhooks, api_scope_ok, user_ws_role) and 0051
-- (status_updates.author_id). Works with or without 0047–0050 and 0053. Idempotent: safe to run more than once (re-running
-- keeps every update, section, comment, reaction, view and portfolio
-- detail). 0046, 0047 and 0048 recreate webhook_event_names(): run this
-- file again after any of them (0048 lists 'status_update.posted' itself).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or to_regprocedure('public.can_write(uuid)') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0054 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regprocedure('public.webhook_enqueue(uuid, uuid, text, text, jsonb)') is null
     or to_regprocedure('public.api_scope_ok(uuid)') is null or to_regprocedure('public.webhook_event_names()') is null then
    raise exception '0054 needs 0046 (webhooks, API key scope) first: run it, then this file';
  end if;
  if to_regclass('public.status_updates') is null or to_regclass('public.portfolios') is null or to_regclass('public.activity') is null
     or to_regprocedure('public.is_task_audience(uuid, uuid, uuid)') is null then
    raise exception '0054 needs status_updates and portfolios (0020), activity (0006) and is_task_audience (0042)';
  end if;
  if to_regprocedure('public.user_ws_role(uuid, uuid)') is null or to_regprocedure('public.kanbo_person_name(uuid)') is null then
    raise exception '0054 needs 0046 (user_ws_role, kanbo_person_name) first: run it, then this file';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'status_updates' and column_name = 'author_id') then
    raise exception '0054 needs 0051 (who wrote each status update) first: run it, then this file';
  end if;
end $pre$;

-- ---------- 1. helpers ----------
-- Highlights / Risks / Asks / Next as stored: null, or an object of those keys, each a string ≤ 2000.
create or replace function public.update_sections_ok(s jsonb)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select s is null or (
    jsonb_typeof(s) = 'object'
    and (s - 'highlights' - 'risks' - 'asks' - 'next') = '{}'::jsonb
    and not exists (select 1 from jsonb_each(s) e where jsonb_typeof(e.value) <> 'string' or char_length(e.value #>> '{}') > 2000)
  );
$$;

-- May the caller read this update? (0041's read rule: personal, its creator; team, its members, guests too.)
create or replace function public.can_see_status_update(p_update uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.status_updates s
     where s.id = p_update
       and public.api_scope_ok(s.workspace_id)
       and ((s.workspace_id is null and s.user_id = auth.uid() and public.can_act())
         or (s.workspace_id is not null and public.is_member(s.workspace_id))));
$$;
revoke execute on function public.can_see_status_update(uuid) from public, anon;
grant execute on function public.can_see_status_update(uuid) to authenticated;

-- Is a team update about a project in its own workspace? (personal ones are their creator's alone)
-- Only the workspace's own people get an answer: to anyone else it says no, so it never tells
-- an outsider which projects a workspace has.
create or replace function public.status_update_project_ok(p_project text, p_ws uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
begin
  if p_ws is null then return true; end if;
  if not public.is_member(p_ws) then return false; end if;
  if p_project is null or p_project !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return exists (select 1 from public.projects p where p.id = p_project::uuid and p.workspace_id = p_ws);
end; $$;
revoke execute on function public.status_update_project_ok(text, uuid) from public, anon;
grant execute on function public.status_update_project_ok(text, uuid) to authenticated;

-- ---------- 2. status updates: sections, asks, the edited mark ----------
alter table public.status_updates add column if not exists edited_at timestamptz;
alter table public.status_updates add column if not exists sections jsonb;
alter table public.status_updates add column if not exists ask_user_ids uuid[] not null default '{}';
alter table public.status_updates drop constraint if exists status_updates_sections_shape;
alter table public.status_updates add constraint status_updates_sections_shape
  check (public.update_sections_ok(sections) and cardinality(ask_user_ids) <= 20);

-- Where and when it was posted never change afterwards (from the app or the API; its author
-- is 0051's to keep), and when is the moment it's posted: a client can't date it ahead (an "On
-- track" that stays the latest forever, silencing "Update missing" and the reminders) or back.
-- Its call is one of the four. An edit of what it says is marked; the people an Ask names are
-- only ever people who can read it (never its author). Server-side writers keep theirs. (user_id,
-- the row's keeper, isn't locked: account deletion hands it to the workspace's owner, sometimes
-- from a signed-in admin's call, and the permissive policies already keep a personal row its owner's.)
create or replace function public.status_update_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  client boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
  -- (what the writer changed, before the Ask list is re-checked: someone named who has since left
  --  drops out of it, and that alone isn't an edit)
  asks_changed boolean := tg_op = 'UPDATE' and new.ask_user_ids is distinct from old.ask_user_ids;
begin
  if client and (tg_op = 'INSERT' or new.status is distinct from old.status)
     and new.status not in ('on_track', 'at_risk', 'off_track', 'on_hold') then
    raise exception 'invalid update status';
  end if;
  if tg_op = 'INSERT' and client then
    new.created_at := now();
  elsif tg_op = 'UPDATE' and client then
    new.project_id := old.project_id; new.workspace_id := old.workspace_id;
    new.created_at := old.created_at;
  end if;
  -- the named: distinct, someone who can read it, not the author, 20 at most
  select coalesce(array_agg(x order by x), '{}') into new.ask_user_ids
    from (select distinct x from unnest(coalesce(new.ask_user_ids, '{}')) x
           where x is not null and x is distinct from new.author_id
             and public.is_task_audience(new.workspace_id, new.user_id, x)
           limit 20) q;
  if new.workspace_id is null then new.ask_user_ids := '{}'; end if;   -- personal: nobody else to ask
  if tg_op = 'INSERT' then
    if client then new.edited_at := null; end if;
  elsif client then
    new.edited_at := case
      when asks_changed or (new.summary, new.status, new.sections, new.recovery_plan, new.target_date)
           is distinct from (old.summary, old.status, old.sections, old.recovery_plan, old.target_date)
      then now() else old.edited_at end;
  end if;
  return new;
end; $$;
revoke execute on function public.status_update_guard() from public, anon, authenticated;

-- (0053's recovery_plan / target_date are read above: before 0053, add them empty so the trigger compiles)
alter table public.status_updates add column if not exists recovery_plan text;
alter table public.status_updates add column if not exists target_date date;
drop trigger if exists trg_status_update_guard on public.status_updates;
create trigger trg_status_update_guard before insert or update on public.status_updates
  for each row execute function public.status_update_guard();

-- (Re)creates the authors-only rules on status_updates: run below, and by 0041 when it's run
-- again (it drops every policy on the table). Restrictive: ANDed with 0041's own policies.
create or replace function public.update_conversation_restore()
returns integer language plpgsql set search_path = public as $$
begin
  if to_regclass('public.status_updates') is null then return 0; end if;
  drop policy if exists "updates: about a project in this workspace" on public.status_updates;
  drop policy if exists "updates: authors edit their own" on public.status_updates;
  drop policy if exists "updates: authors or leads delete" on public.status_updates;
  create policy "updates: about a project in this workspace" on public.status_updates as restrictive for insert
    with check (workspace_id is null or public.status_update_project_ok(project_id, workspace_id));
  create policy "updates: authors edit their own" on public.status_updates as restrictive for update
    using (workspace_id is null or author_id = auth.uid())
    with check (workspace_id is null or author_id = auth.uid());
  create policy "updates: authors or leads delete" on public.status_updates as restrictive for delete
    using (workspace_id is null or author_id = auth.uid() or public.ws_role(workspace_id) in ('owner', 'admin'));
  return 3;
end; $$;
revoke execute on function public.update_conversation_restore() from public, anon, authenticated;

-- Are all three there (restrictive, row security on)?
create or replace function public.update_conversation_intact()
returns boolean language sql stable set search_path = pg_catalog, public as $$
  select coalesce((select c.relrowsecurity from pg_catalog.pg_class c where c.oid = to_regclass('public.status_updates')), false)
     and (select count(*) from pg_catalog.pg_policy p
           where p.polrelid = to_regclass('public.status_updates') and not p.polpermissive
             and p.polname in ('updates: about a project in this workspace', 'updates: authors edit their own', 'updates: authors or leads delete')) = 3;
$$;
revoke execute on function public.update_conversation_intact() from public, anon, authenticated;

do $restore$
begin
  perform public.update_conversation_restore();
end $restore$;

-- ---------- 3. comments on an update ----------
create table if not exists public.status_update_comments (
  id           uuid primary key default gen_random_uuid(),
  update_id    uuid not null references public.status_updates (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete set null,
  author_name  text not null default '',
  body         text not null,
  mentions     uuid[] not null default '{}',
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index if not exists status_update_comments_update_idx on public.status_update_comments (update_id, created_at);
create index if not exists status_update_comments_user_idx on public.status_update_comments (user_id, created_at desc);
alter table public.status_update_comments drop constraint if exists status_update_comments_shape;
alter table public.status_update_comments add constraint status_update_comments_shape check (
  char_length(btrim(body)) between 1 and 4000 and char_length(author_name) <= 200 and cardinality(mentions) <= 20);

-- The person writing is the author (their profile name), on the update's workspace; the
-- @mentioned are people who can read it. An edit changes the words only, and is marked.
create or replace function public.status_update_comment_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  client boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
  s record;
begin
  select x.workspace_id, x.user_id into s from public.status_updates x where x.id = new.update_id;
  if tg_op = 'INSERT' then
    if client then
      new.user_id := auth.uid();
      new.author_name := public.kanbo_person_name(auth.uid());
      new.created_at := now();
      new.edited_at := null;
      -- 120 an hour each: room for a lively thread, not for a flood. Counted twice over: what's there
      -- now, and (0046's rate_limits) every one posted this hour, so deleting them doesn't start the
      -- hour again (each one tells the update's author and up to 20 people)
      if (select count(*) from public.status_update_comments c where c.user_id = auth.uid() and c.created_at > now() - interval '1 hour') >= 120 then
        raise exception 'too many comments';
      end if;
      if to_regprocedure('public.api_rate_hit(text, integer, integer)') is not null then
        if not (select h.allowed from public.api_rate_hit('kanbo:update_comments:' || auth.uid()::text, 3600, 120) h) then
          raise exception 'too many comments';
        end if;
      end if;
    end if;
    new.workspace_id := s.workspace_id;
  else
    new.update_id := old.update_id; new.workspace_id := old.workspace_id;
    if client then
      -- (the writer empties once their account is deleted: the foreign key's SET NULL runs after the
      --  auth.users row has gone, even when a signed-in admin deleted it)
      if not (new.user_id is null and not exists (select 1 from auth.users u where u.id = old.user_id)) then new.user_id := old.user_id; end if;
      new.author_name := old.author_name; new.created_at := old.created_at;
      new.edited_at := case when new.body is distinct from old.body then now() else old.edited_at end;
    end if;
  end if;
  new.body := btrim(new.body);
  select coalesce(array_agg(x order by x), '{}') into new.mentions
    from (select distinct x from unnest(coalesce(new.mentions, '{}')) x
           where x is not null and x is distinct from new.user_id and public.is_task_audience(s.workspace_id, s.user_id, x)
           limit 20) q;
  return new;
end; $$;
revoke execute on function public.status_update_comment_guard() from public, anon, authenticated;
-- (kanbo_person_name is 0046's)
drop trigger if exists trg_status_update_comment_guard on public.status_update_comments;
create trigger trg_status_update_comment_guard before insert or update on public.status_update_comments
  for each row execute function public.status_update_comment_guard();

-- ---------- 4. reactions ----------
create table if not exists public.status_update_reactions (
  update_id  uuid not null references public.status_updates (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  emoji      text not null,
  created_at timestamptz not null default now(),
  primary key (update_id, user_id, emoji)
);
create index if not exists status_update_reactions_user_idx on public.status_update_reactions (user_id);
alter table public.status_update_reactions drop constraint if exists status_update_reactions_emoji;
alter table public.status_update_reactions add constraint status_update_reactions_emoji
  check (emoji in ('👍', '❤️', '🎉', '👀', '✅', '🚀'));

-- ---------- 5. seen by ----------
create table if not exists public.status_update_views (
  update_id uuid not null references public.status_updates (id) on delete cascade,
  user_id   uuid not null references auth.users (id) on delete cascade,
  seen_at   timestamptz not null default now(),
  primary key (update_id, user_id)
);
create index if not exists status_update_views_user_idx on public.status_update_views (user_id);

-- Mark the updates the caller has read (at most 200 at once): only those they can read,
-- never their own. Answers how many were new.
create or replace function public.mark_status_updates_seen(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); n integer;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  insert into public.status_update_views (update_id, user_id)
  select s.id, me from public.status_updates s
   where s.id = any ((select array_agg(x) from (select distinct x from unnest(coalesce(p_ids, '{}')) x limit 200) q)::uuid[])
     and s.author_id is distinct from me
     and public.can_see_status_update(s.id)
  on conflict (update_id, user_id) do nothing;
  get diagnostics n = row_count;
  return n;
end; $$;
revoke execute on function public.mark_status_updates_seen(uuid[]) from public, anon;
grant execute on function public.mark_status_updates_seen(uuid[]) to authenticated;

-- ---------- row security: comments, reactions, views ----------
do $rls$
declare t text; pol record;
begin
  foreach t in array array['status_update_comments', 'status_update_reactions', 'status_update_views'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to service_role', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $rls$;

grant select, insert, update, delete on public.status_update_comments to authenticated;
create policy "comments: read with the update" on public.status_update_comments for select to authenticated
  using (public.can_see_status_update(update_id));
-- guests too: they read and comment, never more
create policy "comments: whoever reads the update" on public.status_update_comments for insert to authenticated
  with check (user_id = auth.uid() and public.can_act() and public.can_see_status_update(update_id));
create policy "comments: your own words" on public.status_update_comments for update to authenticated
  using (user_id = auth.uid() and public.can_act() and public.can_see_status_update(update_id))
  with check (user_id = auth.uid() and public.can_act() and public.can_see_status_update(update_id));
create policy "comments: yours, or a lead's to remove" on public.status_update_comments for delete to authenticated
  using ((user_id = auth.uid() and public.can_act() and public.can_see_status_update(update_id))
      or (workspace_id is not null and public.ws_role(workspace_id) in ('owner', 'admin') and public.api_scope_ok(workspace_id)));

grant select, insert, delete on public.status_update_reactions to authenticated;
create policy "reactions: read with the update" on public.status_update_reactions for select to authenticated
  using (public.can_see_status_update(update_id));
create policy "reactions: your own" on public.status_update_reactions for insert to authenticated
  with check (user_id = auth.uid() and public.can_act() and public.can_see_status_update(update_id));
create policy "reactions: take back your own" on public.status_update_reactions for delete to authenticated
  using (user_id = auth.uid());

grant select on public.status_update_views to authenticated;
create policy "views: read with the update" on public.status_update_views for select to authenticated
  using (public.can_see_status_update(update_id));

-- ---------- 6. who hears about it ----------
-- (a deleted update or portfolio update takes its Inbox items with it: found by these, not by
--  reading the whole activity table once per deleted row)
create index if not exists activity_status_update_ref_idx on public.activity ((meta ->> 'status_update_id')) where kind = 'update';
create index if not exists activity_portfolio_update_ref_idx on public.activity ((meta ->> 'portfolio_update_id')) where kind = 'update';

-- One Inbox item (activity kind 'update'). Internal: the triggers below call it.
create or replace function public.update_notice(p_user uuid, p_title text, p_actor text, p_meta jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
  values (p_user, null, left(coalesce(nullif(btrim(p_title), ''), 'a project'), 200), 'update', left(coalesce(p_actor, 'Someone'), 200), p_meta);
$$;
revoke execute on function public.update_notice(uuid, text, text, jsonb) from public, anon, authenticated;

-- Posting: the owner and contributors (FYI), the people an Ask names ("Needs your reply"), and webhooks.
-- An edit that names someone new tells them. Deleting it takes its Inbox items with it.
create or replace function public.status_update_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  pid uuid; pname text; powner uuid; pcontrib uuid[]; pws uuid;
  who text;
  r uuid;
  asked uuid[];
  fresh uuid[];
begin
  if tg_op = 'DELETE' then
    delete from public.activity a where a.kind = 'update' and a.meta ->> 'status_update_id' = old.id::text;
    return null;
  end if;
  if new.workspace_id is not null and new.project_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select x.id, x.name, x.owner_id, x.contributor_ids, x.workspace_id into pid, pname, powner, pcontrib, pws
      from public.projects x where x.id = new.project_id::uuid and x.workspace_id = new.workspace_id;
  end if;
  who := public.kanbo_person_name(coalesce(new.author_id, new.user_id));
  asked := coalesce(new.ask_user_ids, '{}');
  if pid is not null then
    if tg_op = 'INSERT' then
      for r in select distinct x from unnest(array[powner] || coalesce(pcontrib, '{}') || asked) x
                where x is not null and x is distinct from new.author_id loop
        if not public.is_task_audience(new.workspace_id, null, r) then continue; end if;
        if not public.notif_on(r, case when r = any (asked) then 'mention' else 'update' end) then continue; end if;
        perform public.update_notice(r, pname, who, jsonb_build_object(
          'status_update_id', new.id, 'project_id', pid, 'update_event', 'posted', 'update_status', new.status, 'ask', r = any (asked)));
      end loop;
    elsif new.ask_user_ids is distinct from old.ask_user_ids then
      fresh := array(select x from unnest(asked) x where not (x = any (coalesce(old.ask_user_ids, '{}'))));
      foreach r in array fresh loop
        -- (once per person per update: taking someone off the Ask and back on doesn't tell them again)
        if exists (select 1 from public.activity a where a.kind = 'update' and a.meta ->> 'status_update_id' = new.id::text
                    and a.user_id = r and coalesce((a.meta ->> 'ask')::boolean, false)) then continue; end if;
        if r is distinct from new.author_id and public.is_task_audience(new.workspace_id, null, r) and public.notif_on(r, 'mention') then
          perform public.update_notice(r, pname, who, jsonb_build_object(
            'status_update_id', new.id, 'project_id', pid, 'update_event', 'asked', 'update_status', new.status, 'ask', true));
        end if;
      end loop;
    end if;
  end if;
  if tg_op = 'INSERT' then
    begin
      if exists (select 1 from public.webhooks w where w.active) then
        perform public.webhook_enqueue(new.workspace_id, new.user_id, 'status_update.posted', new.id::text,
          jsonb_build_object('status_update', to_jsonb(new), 'author_name', who,
                             'project', case when pid is null then null
                                             else jsonb_build_object('id', pid, 'name', pname, 'workspace_id', pws) end));
      end if;
    exception when others then
      raise warning 'webhook capture skipped (status update): %', sqlerrm;   -- never block the update
    end;
  end if;
  return null;
end; $$;
revoke execute on function public.status_update_after() from public, anon, authenticated;
drop trigger if exists trg_status_update_after on public.status_updates;
create trigger trg_status_update_after after insert or update or delete on public.status_updates
  for each row execute function public.status_update_after();

-- A comment: the update's author (FYI) and anyone it @mentions ("Needs your reply").
create or replace function public.status_update_comment_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  sid uuid; sauthor uuid; sws uuid; sproject text;
  pid uuid; pname text;
  r uuid;
begin
  select x.id, x.author_id, x.workspace_id, x.project_id into sid, sauthor, sws, sproject from public.status_updates x where x.id = new.update_id;
  if sid is null or sws is null then return null; end if;
  if sproject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    select x.id, x.name into pid, pname from public.projects x where x.id = sproject::uuid and x.workspace_id = sws;
  end if;
  if pid is null then return null; end if;
  for r in select distinct x from unnest(array[sauthor] || coalesce(new.mentions, '{}')) x
            where x is not null and x is distinct from new.user_id loop
    if not public.is_task_audience(sws, null, r) then continue; end if;
    if not public.notif_on(r, case when r = any (new.mentions) then 'mention' else 'update' end) then continue; end if;
    perform public.update_notice(r, pname, new.author_name, jsonb_build_object(
      'status_update_id', sid, 'project_id', pid, 'update_event', 'comment', 'comment_id', new.id,
      'ask', r = any (new.mentions)));
  end loop;
  return null;
end; $$;
revoke execute on function public.status_update_comment_after() from public, anon, authenticated;
drop trigger if exists trg_status_update_comment_after on public.status_update_comments;
create trigger trg_status_update_comment_after after insert on public.status_update_comments
  for each row execute function public.status_update_comment_after();

-- A deleted comment takes the Inbox items it made with it (its writer's own, or a lead removing it):
-- the update's author's and the @mentioned people's.
create or replace function public.status_update_comment_gone() returns trigger
language plpgsql security definer set search_path = public as $$
declare sauthor uuid;
begin
  select x.author_id into sauthor from public.status_updates x where x.id = old.update_id;
  delete from public.activity a
   where a.user_id = any (array[sauthor] || coalesce(old.mentions, '{}'))
     and a.kind = 'update' and a.meta ->> 'comment_id' = old.id::text;
  return null;
end; $$;
revoke execute on function public.status_update_comment_gone() from public, anon, authenticated;
drop trigger if exists trg_status_update_comment_gone on public.status_update_comments;
create trigger trg_status_update_comment_gone after delete on public.status_update_comments
  for each row execute function public.status_update_comment_gone();

-- ---------- 7. webhooks: status_update.posted ----------
-- Whatever this database already lists (0046's, 0047's or 0048's), plus the new event.
do $events$
declare names text[];
begin
  select array(select distinct x from unnest(public.webhook_event_names() || array['status_update.posted']) x order by 1) into names;
  execute format($f$create or replace function public.webhook_event_names()
    returns text[] language sql immutable as $b$ select %L::text[] $b$$f$, names);
  grant execute on function public.webhook_event_names() to public;
end $events$;

-- ---------- 8. portfolio pages ----------
alter table public.portfolios add column if not exists owner_id uuid references auth.users (id) on delete set null;
alter table public.portfolios add column if not exists description text;
alter table public.portfolios add column if not exists target_date date;
alter table public.portfolios add column if not exists follower_ids uuid[] not null default '{}';
alter table public.portfolios add column if not exists color text;
alter table public.portfolios add column if not exists emoji text;
alter table public.portfolios drop constraint if exists portfolios_details_shape;
alter table public.portfolios add constraint portfolios_details_shape check (
  (description is null or char_length(description) <= 4000) and cardinality(follower_ids) <= 100
  and (color is null or char_length(color) <= 64) and (emoji is null or char_length(emoji) <= 16));

-- A team portfolio's owner and followers are its workspace's owners, admins and members
-- (guests can't read it, 0051); a personal one's are its creator only.
create or replace function public.portfolio_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- a new portfolio is its creator's to run until they hand it on
  if tg_op = 'INSERT' and new.owner_id is null and new.user_id is not null
     and (new.workspace_id is null or coalesce(public.user_ws_role(new.user_id, new.workspace_id), 'none') in ('owner', 'admin', 'member')) then
    new.owner_id := new.user_id;
  end if;
  if new.workspace_id is null then
    if new.owner_id is not null and new.owner_id <> new.user_id then new.owner_id := new.user_id; end if;
    new.follower_ids := case when new.user_id = any (coalesce(new.follower_ids, '{}')) then array[new.user_id] else '{}' end;
    return new;
  end if;
  -- (checked when it's set: an owner who has since left doesn't stop the portfolio being renamed)
  if new.owner_id is not null and (tg_op = 'INSERT' or new.owner_id is distinct from old.owner_id)
     and coalesce(public.user_ws_role(new.owner_id, new.workspace_id), 'none') not in ('owner', 'admin', 'member') then
    raise exception 'invalid portfolio owner';
  end if;
  select coalesce(array_agg(x order by x), '{}') into new.follower_ids
    from (select distinct x from unnest(coalesce(new.follower_ids, '{}')) x
           where x is not null and coalesce(public.user_ws_role(x, new.workspace_id), 'none') in ('owner', 'admin', 'member')
           limit 100) q;
  return new;
end; $$;
revoke execute on function public.portfolio_guard() from public, anon, authenticated;

-- (user_ws_role is 0046's: a named person's role, 'none' for anyone else)
drop trigger if exists trg_portfolio_guard on public.portfolios;
create trigger trg_portfolio_guard before insert or update on public.portfolios
  for each row execute function public.portfolio_guard();

-- May the caller read / write this portfolio? (0041 + 0051: members and above, or its creator.)
create or replace function public.can_see_portfolio(p_portfolio uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.portfolios p
     where p.id = p_portfolio and public.api_scope_ok(p.workspace_id)
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.ws_role(p.workspace_id) in ('owner', 'admin', 'member'))));
$$;
create or replace function public.can_write_portfolio(p_portfolio uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.portfolios p
     where p.id = p_portfolio and public.api_scope_ok(p.workspace_id)
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.can_write(p.workspace_id))));
$$;
revoke execute on function public.can_see_portfolio(uuid) from public, anon;
revoke execute on function public.can_write_portfolio(uuid) from public, anon;
grant execute on function public.can_see_portfolio(uuid) to authenticated;
grant execute on function public.can_write_portfolio(uuid) to authenticated;

create table if not exists public.portfolio_updates (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references public.portfolios (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  author_id    uuid references auth.users (id) on delete set null,
  summary      text not null,
  status       text not null default 'on_track',
  sections     jsonb,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz
);
create index if not exists portfolio_updates_portfolio_idx on public.portfolio_updates (portfolio_id, created_at desc);
alter table public.portfolio_updates drop constraint if exists portfolio_updates_shape;
alter table public.portfolio_updates add constraint portfolio_updates_shape check (
  char_length(btrim(summary)) between 1 and 8000 and status in ('on_track', 'at_risk', 'off_track', 'on_hold')
  and public.update_sections_ok(sections));

-- The person posting is its author, in the portfolio's workspace; afterwards only what it says changes (marked).
create or replace function public.portfolio_update_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare client boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    new.workspace_id := (select p.workspace_id from public.portfolios p where p.id = new.portfolio_id);
    if client then new.author_id := auth.uid(); new.created_at := now(); new.edited_at := null; end if;
  else
    new.portfolio_id := old.portfolio_id; new.workspace_id := old.workspace_id;
    if client then
      -- (empties once the author's account is deleted, as above)
      if not (new.author_id is null and not exists (select 1 from auth.users u where u.id = old.author_id)) then new.author_id := old.author_id; end if;
      new.created_at := old.created_at;
      new.edited_at := case when (new.summary, new.status, new.sections) is distinct from (old.summary, old.status, old.sections)
                            then now() else old.edited_at end;
    end if;
  end if;
  return new;
end; $$;
revoke execute on function public.portfolio_update_guard() from public, anon, authenticated;
drop trigger if exists trg_portfolio_update_guard on public.portfolio_updates;
create trigger trg_portfolio_update_guard before insert or update on public.portfolio_updates
  for each row execute function public.portfolio_update_guard();

-- the owner and followers hear about a new one (FYI); a deleted one takes its Inbox items with it
create or replace function public.portfolio_update_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; r uuid; who text;
begin
  if tg_op = 'DELETE' then
    delete from public.activity a where a.kind = 'update' and a.meta ->> 'portfolio_update_id' = old.id::text;
    return null;
  end if;
  select x.id, x.name, x.owner_id, x.follower_ids, x.workspace_id into p from public.portfolios x where x.id = new.portfolio_id;
  if p.id is null or p.workspace_id is null then return null; end if;
  who := public.kanbo_person_name(new.author_id);
  for r in select distinct x from unnest(array[p.owner_id] || coalesce(p.follower_ids, '{}')) x
            where x is not null and x is distinct from new.author_id loop
    if coalesce(public.user_ws_role(r, p.workspace_id), 'none') not in ('owner', 'admin', 'member') or not public.notif_on(r, 'update') then continue; end if;
    perform public.update_notice(r, p.name, who, jsonb_build_object(
      'portfolio_id', p.id, 'portfolio_update_id', new.id, 'update_event', 'portfolio', 'update_status', new.status, 'ask', false));
  end loop;
  return null;
end; $$;
revoke execute on function public.portfolio_update_after() from public, anon, authenticated;
drop trigger if exists trg_portfolio_update_after on public.portfolio_updates;
create trigger trg_portfolio_update_after after insert or delete on public.portfolio_updates
  for each row execute function public.portfolio_update_after();

do $prls$
declare pol record;
begin
  alter table public.portfolio_updates enable row level security;
  revoke all on public.portfolio_updates from public, anon, authenticated;
  grant select, insert, update, delete on public.portfolio_updates to authenticated, service_role;
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'portfolio_updates' loop
    execute format('drop policy %I on public.portfolio_updates', pol.policyname);
  end loop;
end $prls$;
create policy "portfolio updates: read with the portfolio" on public.portfolio_updates for select to authenticated
  using (public.can_see_portfolio(portfolio_id));
create policy "portfolio updates: its writers post" on public.portfolio_updates for insert to authenticated
  with check (author_id = auth.uid() and public.can_write_portfolio(portfolio_id));
create policy "portfolio updates: authors edit their own" on public.portfolio_updates for update to authenticated
  using (author_id = auth.uid() and public.can_write_portfolio(portfolio_id))
  with check (author_id = auth.uid() and public.can_write_portfolio(portfolio_id));
create policy "portfolio updates: authors or leads delete" on public.portfolio_updates for delete to authenticated
  using ((author_id = auth.uid() and public.can_write_portfolio(portfolio_id))
      or (workspace_id is not null and public.ws_role(workspace_id) in ('owner', 'admin') and public.api_scope_ok(workspace_id)));

-- ---------- 9. the notify queue takes 'update' ----------
-- 0053 §5's widening, here too (word for word): the notify function's Ask notices are kind 'update',
-- and a notice the queue refuses goes out at once, quiet hours or not. Running 0053 as well changes nothing.
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

-- ---------- 10. 0058's project access survives a re-run of this file ----------
-- It puts back its own can_see_status_update and drops every policy on its
-- tables, 0058's "project access: replies" ones too.  When 0058 is in, put it back.
do $projectaccess$
begin
  if to_regprocedure('public.project_access_restore()') is not null then
    perform public.project_access_restore();
  end if;
end $projectaccess$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0054') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0054')                            as recorded,
--   (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'status_updates'
--     and column_name in ('edited_at', 'sections', 'ask_user_ids')) = 3                                    as update_columns,
--   (select count(*) from pg_policies where schemaname = 'public' and tablename = 'status_updates'
--     and permissive = 'RESTRICTIVE' and policyname like 'updates:%') = 3                                  as authors_only,
--   (select bool_and(relrowsecurity) from pg_class where oid in ('public.status_update_comments'::regclass,
--     'public.status_update_reactions'::regclass, 'public.status_update_views'::regclass,
--     'public.portfolio_updates'::regclass))                                                              as new_tables_rls,
--   not has_table_privilege('authenticated', 'public.status_update_views', 'insert')                     as views_through_function,
--   has_function_privilege('authenticated', 'public.mark_status_updates_seen(uuid[])', 'execute')
--     and not has_function_privilege('anon', 'public.mark_status_updates_seen(uuid[])', 'execute')       as seen_signed_in_only,
--   'status_update.posted' = any (public.webhook_event_names())                                          as webhook_event,
--   (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'portfolios'
--     and column_name in ('owner_id', 'description', 'target_date', 'follower_ids', 'color', 'emoji')) = 6  as portfolio_details,
--   exists (select 1 from pg_trigger where tgname = 'trg_status_update_after' and not tgisinternal)      as notices,
--   exists (select 1 from pg_trigger where tgname = 'trg_status_update_comment_gone' and not tgisinternal) as comment_notices_go,
--   (to_regclass('public.notify_queue') is null
--     or pg_get_constraintdef((select oid from pg_constraint where conname = 'notify_queue_shape')) like '%update%') as queue_takes_update;
-- ============================================================
-- <<<<<<<<<< end of 0054_update_conversation.sql <<<<<<<<<<

-- >>>>>>>>>> 0055_shared_availability.sql >>>>>>>>>>
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
--      day: "am" or "pm"), recorded at one business (workspace_id: the one
--      on screen when it was added). Entered once, seen everywhere it
--      should be: an entry the person records themselves is read by
--      everyone who works beside them (an owner, admin or member of a
--      business where the person is an owner, admin or member too); one an
--      owner or admin records for them stays with that business's team.
--      Guests and outsiders read nothing, and being someone's guest (or
--      having them as one) shares nothing.
--      time_off_notes: the private reason. Only the person and the owners
--      and admins of the business it was recorded at (where the person is
--      on the team) read it; everyone else sees just "Off". Both written
--      only through save_time_off() and delete_time_off(): by the person,
--      or by an owner or admin of the business it's recorded at. At most
--      200 entries per person from any one author; entries that ended more
--      than 400 days ago are cleared as new ones are saved.
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
-- (internal) p_user is on p_ws's team: an active owner, admin or member there (or its owner). A guest isn't.
create or replace function public.on_team_at(p_ws uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_ws is not null and p_user is not null and (
    exists (select 1 from public.workspace_members m
             where m.workspace_id = p_ws and m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin', 'member'))
    or exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_user));
$$;
revoke execute on function public.on_team_at(uuid, uuid) from public, anon, authenticated;

-- The caller and p_user are on the same team somewhere: a workspace where both are an owner, admin or
-- member (never a guest, on either side).
create or replace function public.shares_team_with(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_user is not null and exists (
    select 1 from (select m.workspace_id as ws from public.workspace_members m
                    where m.user_id = p_user and m.status = 'active' and m.role in ('owner', 'admin', 'member')
                   union
                   select w.id from public.workspaces w where w.owner_id = p_user) x
     where public.ws_role(x.ws) in ('owner', 'admin', 'member'));
$$;

-- At this business: the caller is on its team and so is p_user.
create or replace function public.team_at(p_ws uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_ws is not null and public.ws_role(p_ws) in ('owner', 'admin', 'member') and public.on_team_at(p_ws, p_user);
$$;

-- At this business: the caller is an owner or admin, and p_user is on its team.
create or replace function public.leads_at(p_ws uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_ws is not null and public.ws_role(p_ws) in ('owner', 'admin') and public.on_team_at(p_ws, p_user);
$$;
revoke execute on function public.shares_team_with(uuid) from public, anon;
revoke execute on function public.team_at(uuid, uuid) from public, anon;
revoke execute on function public.leads_at(uuid, uuid) from public, anon;
grant execute on function public.shares_team_with(uuid) to authenticated;
grant execute on function public.team_at(uuid, uuid) to authenticated;
grant execute on function public.leads_at(uuid, uuid) to authenticated;

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
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete set null,
  starts_on    date not null,
  ends_on      date not null,
  half_day     text,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
-- (a database that ran an earlier draft of this file has the table without the business it was recorded at)
alter table public.time_off add column if not exists workspace_id uuid references public.workspaces (id) on delete set null;
alter table public.time_off drop constraint if exists time_off_shape;
alter table public.time_off add constraint time_off_shape check (
  ends_on >= starts_on and ends_on - starts_on <= 366
  and (half_day is null or (half_day in ('am', 'pm') and starts_on = ends_on)));
create index if not exists time_off_user_idx on public.time_off (user_id, ends_on);
create index if not exists time_off_ws_idx on public.time_off (workspace_id) where workspace_id is not null;
alter table public.time_off enable row level security;

create table if not exists public.time_off_notes (
  time_off_id  uuid primary key references public.time_off (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete set null,
  reason       text not null
);
alter table public.time_off_notes add column if not exists workspace_id uuid references public.workspaces (id) on delete set null;
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
-- (an earlier draft's helper: a lead anywhere the person was, a guest included; its policies are gone above)
drop function if exists public.leads_person(uuid);
-- "Off" is for the person and the people they work beside (owners, admins and members; never guests): what
-- they record themselves, everywhere they're on the team; what a lead records for them, at that business
create policy "time off: the person and their team read" on public.time_off
  for select using (public.can_act() and (user_id = auth.uid()
    or (created_by = user_id and public.shares_team_with(user_id))
    or public.team_at(workspace_id, user_id)));
-- the reason is for the person, and the owners and admins of the business it was recorded at
create policy "time off reasons: the person and that business's leads read" on public.time_off_notes
  for select using (public.can_act() and (user_id = auth.uid() or public.leads_at(workspace_id, user_id)));
revoke all on public.time_off, public.time_off_notes from public, anon, authenticated;
grant select on public.time_off, public.time_off_notes to authenticated;
grant select, insert, update, delete on public.time_off, public.time_off_notes to service_role;

-- Record (p_id null) or change a person's time off at a business (p_ws: the one on screen). Yours (p_ws
-- null, or a business where you're on the team), or, as an owner or admin of p_ws, that of someone on its
-- team; a lead changes only what was recorded at their business. p_half ("am" / "pm") only on a single
-- day. p_reason: private (blank = none). Two entries the same people see can't cover the same day (the
-- morning and the afternoon of one day can).
drop function if exists public.save_time_off(uuid, uuid, date, date, text, text);
create or replace function public.save_time_off(p_id uuid, p_ws uuid, p_user uuid, p_starts date, p_ends date, p_half text, p_reason text)
returns public.time_off language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  cur public.time_off;
  r public.time_off;
  ws uuid := p_ws;
  half text := nullif(btrim(coalesce(p_half, '')), '');
  why text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  if me is null or not public.can_act() or p_user is null then raise exception 'not authorized'; end if;
  if p_user = me then
    if p_ws is not null and public.ws_role(p_ws) not in ('owner', 'admin', 'member') then raise exception 'not authorized'; end if;
  elsif not public.leads_at(p_ws, p_user) then
    raise exception 'not authorized';
  end if;
  if p_starts is null or p_ends is null or p_ends < p_starts or p_ends - p_starts > 366
     or (half is not null and (half not in ('am', 'pm') or p_starts <> p_ends))
     or p_starts < current_date - 400 or p_ends > current_date + 732
     or (why is not null and char_length(why) > 200) then
    raise exception 'invalid time off';
  end if;
  if p_id is not null then
    select * into cur from public.time_off t where t.id = p_id and t.user_id = p_user;
    -- (a lead's change is to what was recorded at their business; it stays recorded there)
    if not found or (p_user <> me and cur.workspace_id is distinct from p_ws) then raise exception 'not authorized'; end if;
    ws := cur.workspace_id;
  end if;
  -- one person's entries are saved one at a time
  perform pg_advisory_xact_lock(hashtext('kanbo.time_off:' || p_user::text));
  -- (an entry clashes with what's seen in the same places: the person's own, and this business's)
  if exists (select 1 from public.time_off t
              where t.user_id = p_user and t.id is distinct from p_id
                and (t.created_by = t.user_id or t.workspace_id is not distinct from ws)
                and t.starts_on <= p_ends and t.ends_on >= p_starts
                and not (half is not null and t.half_day is not null and t.half_day <> half)) then
    raise exception 'already off then';
  end if;
  delete from public.time_off where user_id = p_user and ends_on < current_date - 400;
  if p_id is null and (select count(*) from public.time_off t where t.user_id = p_user and t.created_by = me) >= 200 then
    raise exception 'too much time off on record';
  end if;
  if p_id is null then
    insert into public.time_off (user_id, workspace_id, starts_on, ends_on, half_day, created_by)
      values (p_user, ws, p_starts, p_ends, half, me) returning * into r;
  else
    update public.time_off set starts_on = p_starts, ends_on = p_ends, half_day = half, updated_at = now()
      where id = p_id returning * into r;
  end if;
  if why is null then
    delete from public.time_off_notes where time_off_id = r.id;
  else
    insert into public.time_off_notes (time_off_id, user_id, workspace_id, reason) values (r.id, p_user, r.workspace_id, why)
      on conflict (time_off_id) do update set reason = excluded.reason, workspace_id = excluded.workspace_id;
  end if;
  return r;
end; $$;
revoke execute on function public.save_time_off(uuid, uuid, uuid, date, date, text, text) from public, anon;
grant execute on function public.save_time_off(uuid, uuid, uuid, date, date, text, text) to authenticated;

-- Take time off back: the person's own, or as an owner or admin of the business it was recorded at.
-- An entry the caller can't change gets the same answer as one that isn't there.
create or replace function public.delete_time_off(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare t public.time_off;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into t from public.time_off where id = p_id;
  if not found or (t.user_id <> auth.uid() and not public.leads_at(t.workspace_id, t.user_id)) then raise exception 'not authorized'; end if;
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

-- ---------- 5. 0058's project access survives a re-run of this file ----------
-- Section 3 drops every policy on bill_rates, 0058's "project access: read" too.  When 0058 is in, put it back.
do $projectaccess$
begin
  if to_regprocedure('public.project_access_restore()') is not null then
    perform public.project_access_restore();
  end if;
end $projectaccess$;

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
--   has_function_privilege('authenticated', 'public.save_time_off(uuid,uuid,uuid,date,date,text,text)', 'execute')
--     and not has_function_privilege('anon', 'public.save_time_off(uuid,uuid,uuid,date,date,text,text)', 'execute')                       as time_off_fn,
--   not has_function_privilege('authenticated', 'public.on_team_at(uuid,uuid)', 'execute')
--     and to_regprocedure('public.leads_person(uuid)') is null                                                as helpers,
--   (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id'
--     and table_name in ('time_off', 'time_off_notes')) = 2                                                    as recorded_at,
--   has_function_privilege('authenticated', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')
--     and not has_function_privilege('anon', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')                                    as rates_fn,
--   (not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
--     or (select puballtables from pg_publication where pubname = 'supabase_realtime')
--     or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--          and tablename in ('member_availability', 'time_off')) = 2)                                           as streams;
-- ============================================================
-- <<<<<<<<<< end of 0055_shared_availability.sql <<<<<<<<<<

-- >>>>>>>>>> 0056_meetings.sql >>>>>>>>>>
-- ============================================================
-- KANBO — meetings: the agenda Kanbo builds, run live, with the
-- decisions and actions kept afterwards (2026-11-10).
--
-- Team › Pulse, a business on the Group page and the Group page itself
-- have "Run meeting": Kanbo builds the agenda (each person's done, today
-- and blocked, Radar's risks, goals behind pace, projects to look at and
-- last meeting's actions), one person presents and everyone watching
-- follows their place. Until now none of it was kept.
--
--   1. meetings: one meeting at a business (its host), a team meeting or a
--      leadership meeting. A leadership meeting can cover several
--      businesses (the Group page): workspace_ids lists every one, and only
--      someone who is an owner or admin of each of them reads it. A team
--      meeting is read by the host's owners, admins and members, never its
--      guests (they can't see who's off, or the team's load). The agenda is
--      Kanbo's snapshot of the week, made by whoever starts it from what
--      they see (which everyone who reads the meeting can see anyway);
--      `place` is the presenter's place in it, streamed so everyone
--      watching follows. The presenter hands over to someone in the room, or
--      anyone in it takes over. One live meeting of a kind over the same
--      businesses at a time, whichever of them hosts it (and the meeting
--      before is found the same way); one left running for 12 hours is
--      closed.
--   2. meeting_attendees: who was asked (the starter picks from those who
--      may read it) and who joined.
--   3. meeting_items: the notes, decisions and actions logged in it (on an
--      agenda item or at large); an action has an owner (an owner, admin or
--      member of the host), a due day, and the task made from it with
--      Extract tasks (a task of the host's). Read with the meeting, and
--      written by everyone who may read it, while it runs and for 7 days
--      after (actions made from the notes afterwards still count).
--   4. Ending it puts a recap in each attendee's Inbox (activity kind
--      'meeting', task_id null, meta { meeting_id, workspace_id, preset,
--      decisions, actions, doc_id, project_id }), unless they switched
--      update notices off. The daily digest carries it for people on one.
--      Deleting a meeting takes its recaps with it.
--   5. meetings, meeting_attendees and meeting_items join the realtime
--      publication (RLS decides who hears).
--   6. The room's presence channel ("kanbo:meeting:<id>": who's there, and
--      Hand over) is allowed for the people who may read the meeting
--      (0048's kanbo_realtime_allowed, with a meeting branch; nothing is
--      broadcast on it).
--
-- The notes doc is an ordinary project doc (0047) in a project of the
-- host's that the starter picks; the meeting only remembers which.
--
-- Needs 0041 (ws_role, can_act), 0042 (schema_migrations), 0046
-- (api_scope_ok, user_ws_role, kanbo_person_name) and 0047 (activity.meta).
-- Works with or without 0048–0055. Idempotent: safe to run more than once
-- (re-running keeps every meeting, attendee, note, decision and action).
-- The tables are new and 0041 never drops their policies, so nothing to
-- restore when it's run again.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0056 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regprocedure('public.api_scope_ok(uuid)') is null or to_regprocedure('public.user_ws_role(uuid, uuid)') is null
     or to_regprocedure('public.kanbo_person_name(uuid)') is null then
    raise exception '0056 needs 0046 (api_scope_ok, user_ws_role, kanbo_person_name) first: run it, then this file';
  end if;
  if to_regclass('public.activity') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'activity' and column_name = 'meta') then
    raise exception '0056 needs activity (0006) with its meta column (0047) first: run 0047, then this file';
  end if;
  if to_regclass('public.workspaces') is null or to_regclass('public.projects') is null or to_regclass('public.tasks') is null
     or to_regprocedure('public.notif_on(uuid, text)') is null then
    raise exception '0056 needs workspaces, projects, tasks and notif_on (0037)';
  end if;
end $pre$;

-- ---------- 1. helpers: who reads a meeting ----------
-- The caller is an owner or admin of every one of these businesses (1 to 12 of them).
create or replace function public.leads_all(p_wss uuid[])
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce(cardinality(p_wss), 0) between 1 and 12
    and not exists (select 1 from unnest(p_wss) x where public.ws_role(x) not in ('owner', 'admin'));
$$;

-- May the caller read (and so run) a meeting of this kind, hosted here, covering these?
-- Team: the host's owners, admins and members. Leadership: owners and admins of every business it covers.
create or replace function public.meeting_can_read(p_preset text, p_ws uuid, p_wss uuid[])
returns boolean language sql security definer stable set search_path = public as $$
  select auth.uid() is not null and p_ws is not null and public.can_act()
    and not exists (select 1 from unnest(coalesce(p_wss, array[p_ws])) x where not public.api_scope_ok(x))
    and case
      when p_preset = 'team' then public.ws_role(p_ws) in ('owner', 'admin', 'member')
      when p_preset = 'leadership' then p_ws = any (p_wss) and public.leads_all(p_wss)
      else false end;
$$;

-- The same question about someone else: may this person attend (or hear the recap)?
create or replace function public.meeting_user_ok(p_user uuid, p_preset text, p_ws uuid, p_wss uuid[])
returns boolean language sql security definer stable set search_path = public as $$
  select p_user is not null and p_ws is not null and case
    when p_preset = 'team' then public.user_ws_role(p_user, p_ws) in ('owner', 'admin', 'member')
    when p_preset = 'leadership' then coalesce(cardinality(p_wss), 0) between 1 and 12 and p_ws = any (p_wss)
      and not exists (select 1 from unnest(p_wss) x where public.user_ws_role(p_user, x) not in ('owner', 'admin'))
    else false end;
$$;
revoke execute on function public.leads_all(uuid[]) from public, anon;
revoke execute on function public.meeting_can_read(text, uuid, uuid[]) from public, anon;
revoke execute on function public.meeting_user_ok(uuid, text, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.leads_all(uuid[]) to authenticated;
grant execute on function public.meeting_can_read(text, uuid, uuid[]) to authenticated;

-- ---------- 2. meetings ----------
create table if not exists public.meetings (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null references public.workspaces (id) on delete cascade,
  workspace_ids  uuid[] not null,
  preset         text not null,
  title          text not null,
  status         text not null default 'live',
  agenda         jsonb not null default '[]'::jsonb,
  place          integer not null default 0,
  place_key      text,
  moved_at       timestamptz not null default now(),
  presenter_id   uuid references auth.users (id) on delete set null,
  started_by     uuid references auth.users (id) on delete set null,
  started_at     timestamptz not null default now(),
  ended_at       timestamptz,
  ended_by       uuid references auth.users (id) on delete set null,
  previous_id    uuid references public.meetings (id) on delete set null,
  doc_id         uuid,
  doc_project_id uuid references public.projects (id) on delete set null,
  updated_at     timestamptz not null default now()
);
alter table public.meetings drop constraint if exists meetings_shape;
alter table public.meetings add constraint meetings_shape check (
  preset in ('team', 'leadership') and status in ('live', 'ended')
  and char_length(btrim(title)) between 1 and 120
  and cardinality(workspace_ids) between 1 and 12 and workspace_id = any (workspace_ids)
  and (preset = 'leadership' or cardinality(workspace_ids) = 1)
  and jsonb_typeof(agenda) = 'array' and jsonb_array_length(agenda) <= 200 and octet_length(agenda::text) <= 262144
  and place >= 0 and (place_key is null or char_length(place_key) <= 200)
  and ((status = 'ended') = (ended_at is not null)));
create index if not exists meetings_ws_idx on public.meetings (workspace_id, preset, started_at desc);
create index if not exists meetings_live_idx on public.meetings (workspace_id) where status = 'live';
alter table public.meetings enable row level security;

-- ---------- 3. attendees and items ----------
create table if not exists public.meeting_attendees (
  meeting_id uuid not null references public.meetings (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  invited    boolean not null default true,
  joined_at  timestamptz,
  primary key (meeting_id, user_id)
);
create index if not exists meeting_attendees_user_idx on public.meeting_attendees (user_id);
alter table public.meeting_attendees enable row level security;

create table if not exists public.meeting_items (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  kind         text not null,
  body         text not null,
  agenda_key   text,
  owner_id     uuid references auth.users (id) on delete set null,
  due_on       date,
  task_id      uuid references public.tasks (id) on delete set null,
  created_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
alter table public.meeting_items drop constraint if exists meeting_items_shape;
alter table public.meeting_items add constraint meeting_items_shape check (
  kind in ('note', 'decision', 'action') and char_length(btrim(body)) between 1 and 1000
  and (agenda_key is null or char_length(agenda_key) <= 200));
create index if not exists meeting_items_meeting_idx on public.meeting_items (meeting_id, created_at);
create index if not exists meeting_items_task_idx on public.meeting_items (task_id) where task_id is not null;
alter table public.meeting_items enable row level security;

-- May the caller read this meeting (and its attendees and items)?
create or replace function public.can_see_meeting(p_meeting uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.meetings m
                  where m.id = p_meeting and public.meeting_can_read(m.preset, m.workspace_id, m.workspace_ids));
$$;
revoke execute on function public.can_see_meeting(uuid) from public, anon;
grant execute on function public.can_see_meeting(uuid) to authenticated;

do $pol$
declare pol record;
begin
  for pol in select policyname, tablename from pg_policies
              where schemaname = 'public' and tablename in ('meetings', 'meeting_attendees', 'meeting_items') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $pol$;
create policy "meetings: the people it's for read" on public.meetings for select to authenticated
  using (public.meeting_can_read(preset, workspace_id, workspace_ids));
create policy "meeting attendees: read with the meeting" on public.meeting_attendees for select to authenticated
  using (public.can_see_meeting(meeting_id));
create policy "meeting items: read with the meeting" on public.meeting_items for select to authenticated
  using (public.can_see_meeting(meeting_id));
revoke all on public.meetings, public.meeting_attendees, public.meeting_items from public, anon, authenticated;
grant select on public.meetings, public.meeting_attendees, public.meeting_items to authenticated;
grant select, insert, update, delete on public.meetings, public.meeting_attendees, public.meeting_items to service_role;

-- ---------- 4. running a meeting ----------
-- (internal) A host project that can hold the notes doc: one of its own, not archived.
create or replace function public.meeting_doc_ok(p_ws uuid, p_doc uuid, p_project uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
declare found_doc boolean;
begin
  if p_project is null then return p_doc is null; end if;
  if not exists (select 1 from public.projects p where p.id = p_project and p.workspace_id = p_ws and p.archived_at is null) then
    return false;
  end if;
  if p_doc is null or to_regclass('public.project_docs') is null then return true; end if;
  execute 'select exists (select 1 from public.project_docs d where d.id = $1 and d.project_id = $2)' into found_doc using p_doc, p_project;
  return found_doc;
end; $$;
revoke execute on function public.meeting_doc_ok(uuid, uuid, uuid) from public, anon, authenticated;

-- Start one: the host, the kind, a title, the businesses it covers (leadership only; the host is always
-- one), Kanbo's agenda, who's asked (only people who may read it are kept; the caller always is), the
-- project its notes doc goes in, and the meeting before it (its actions are on this agenda).
create or replace function public.start_meeting(p_ws uuid, p_preset text, p_title text, p_workspace_ids uuid[],
  p_agenda jsonb, p_attendees uuid[], p_doc_project uuid, p_previous uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  wss uuid[];
  t text := btrim(coalesce(p_title, ''));
  prev uuid;
  who uuid;
  r public.meetings;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_ws is null or p_preset is null or p_preset not in ('team', 'leadership') then raise exception 'invalid meeting'; end if;
  wss := array(select distinct x from unnest(array[p_ws] || coalesce(p_workspace_ids, '{}'::uuid[])) x where x is not null order by 1);
  if cardinality(wss) > 12 or (p_preset = 'team' and cardinality(wss) <> 1) then raise exception 'invalid meeting'; end if;
  if not public.meeting_can_read(p_preset, p_ws, wss) then raise exception 'not authorized'; end if;
  if char_length(t) < 1 or char_length(t) > 120 then raise exception 'invalid meeting'; end if;
  if p_agenda is null or jsonb_typeof(p_agenda) <> 'array' or jsonb_array_length(p_agenda) > 200
     or octet_length(p_agenda::text) > 262144 then
    raise exception 'invalid agenda';
  end if;
  if p_doc_project is not null and not public.meeting_doc_ok(p_ws, null, p_doc_project) then raise exception 'not authorized'; end if;
  if (select count(*) from public.meetings m where m.started_by = me and m.started_at > now() - interval '1 day') >= 40 then
    raise exception 'too many meetings';
  end if;
  -- one live meeting of a kind over the same businesses at a time, whichever of them hosts it (a Group
  -- meeting's host can differ week to week); one left running for 12 hours is closed, without a recap
  perform pg_advisory_xact_lock(hashtext('kanbo.meeting:' || array_to_string(wss, ',') || ':' || p_preset));
  update public.meetings set status = 'ended', ended_at = now(), updated_at = now()
   where workspace_id = any (wss) and workspace_ids = wss and preset = p_preset and status = 'live' and started_at < now() - interval '12 hours';
  if exists (select 1 from public.meetings m
              where m.workspace_id = any (wss) and m.workspace_ids = wss and m.preset = p_preset and m.status = 'live') then
    raise exception 'already running';
  end if;
  -- the meeting before: the last of this kind over the same businesses (its actions open this one)
  select m.id into prev from public.meetings m
   where m.id = p_previous and m.workspace_id = any (wss) and m.workspace_ids = wss and m.preset = p_preset and m.status = 'ended';
  insert into public.meetings (workspace_id, workspace_ids, preset, title, agenda, presenter_id, started_by, previous_id, doc_project_id)
    values (p_ws, wss, p_preset, t, p_agenda, me, me, prev, p_doc_project)
    returning * into r;
  insert into public.meeting_attendees (meeting_id, user_id, invited, joined_at) values (r.id, me, true, now());
  for who in select distinct x from unnest(coalesce(p_attendees, '{}'::uuid[])) x where x is not null and x <> me limit 100 loop
    if public.meeting_user_ok(who, p_preset, p_ws, wss) then
      insert into public.meeting_attendees (meeting_id, user_id, invited) values (r.id, who, true) on conflict do nothing;
    end if;
  end loop;
  return r;
end; $$;
revoke execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) from public, anon;
grant execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) to authenticated;

-- (internal) The meeting, locked, if the caller may read it; otherwise 'not authorized' (whether or not it exists).
create or replace function public.meeting_for_caller(p_meeting uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  if auth.uid() is null or p_meeting is null then raise exception 'not authorized'; end if;
  select * into m from public.meetings where id = p_meeting for update;
  if not found or not public.meeting_can_read(m.preset, m.workspace_id, m.workspace_ids) then raise exception 'not authorized'; end if;
  return m;
end; $$;
revoke execute on function public.meeting_for_caller(uuid) from public, anon, authenticated;

-- The presenter moves to an agenda item: everyone watching follows.
create or replace function public.move_meeting(p_meeting uuid, p_place integer, p_key text)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if m.status <> 'live' then raise exception 'meeting ended'; end if;
  if m.presenter_id is distinct from auth.uid() then raise exception 'not the presenter'; end if;
  if p_place is null or p_place < 0 or p_place >= greatest(jsonb_array_length(m.agenda), 1)
     or (p_key is not null and char_length(p_key) > 200) then
    raise exception 'invalid place';
  end if;
  update public.meetings set place = p_place, place_key = p_key, moved_at = now(), updated_at = now()
   where id = p_meeting returning * into m;
  return m;
end; $$;
revoke execute on function public.move_meeting(uuid, integer, text) from public, anon;
grant execute on function public.move_meeting(uuid, integer, text) to authenticated;

-- Present from here: anyone who may read it takes over (and has joined).
create or replace function public.present_meeting(p_meeting uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if m.status <> 'live' then raise exception 'meeting ended'; end if;
  insert into public.meeting_attendees (meeting_id, user_id, invited, joined_at) values (p_meeting, auth.uid(), false, now())
    on conflict (meeting_id, user_id) do update set joined_at = coalesce(public.meeting_attendees.joined_at, excluded.joined_at);
  update public.meetings set presenter_id = auth.uid(), updated_at = now() where id = p_meeting returning * into m;
  return m;
end; $$;
revoke execute on function public.present_meeting(uuid) from public, anon;
grant execute on function public.present_meeting(uuid) to authenticated;

-- Hand over: the presenter (or the host's owners and admins) passes the agenda to someone who has joined
-- and may read it.
create or replace function public.hand_meeting(p_meeting uuid, p_user uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if m.status <> 'live' then raise exception 'meeting ended'; end if;
  if auth.uid() is distinct from m.presenter_id and public.ws_role(m.workspace_id) not in ('owner', 'admin') then
    raise exception 'not the presenter';
  end if;
  if not public.meeting_user_ok(p_user, m.preset, m.workspace_id, m.workspace_ids)
     or not exists (select 1 from public.meeting_attendees a where a.meeting_id = p_meeting and a.user_id = p_user and a.joined_at is not null) then
    raise exception 'not allowed: they need to be in the meeting';
  end if;
  update public.meetings set presenter_id = p_user, updated_at = now() where id = p_meeting returning * into m;
  return m;
end; $$;
revoke execute on function public.hand_meeting(uuid, uuid) from public, anon;
grant execute on function public.hand_meeting(uuid, uuid) to authenticated;

-- Join (watch): the caller is recorded as there. Nothing happens once it has ended.
create or replace function public.join_meeting(p_meeting uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if m.status <> 'live' then return; end if;
  insert into public.meeting_attendees (meeting_id, user_id, invited, joined_at) values (p_meeting, auth.uid(), false, now())
    on conflict (meeting_id, user_id) do update set joined_at = coalesce(public.meeting_attendees.joined_at, excluded.joined_at);
end; $$;
revoke execute on function public.join_meeting(uuid) from public, anon;
grant execute on function public.join_meeting(uuid) to authenticated;

-- (internal) An item's fields, checked against its meeting: an owner who works at the host (not a guest),
-- a sensible day, a task of the host's.
create or replace function public.meeting_item_ok(m public.meetings, p_kind text, p_body text, p_key text, p_owner uuid, p_due date, p_task uuid)
returns void language plpgsql security definer stable set search_path = public as $$
begin
  if p_kind is null or p_kind not in ('note', 'decision', 'action') or char_length(btrim(coalesce(p_body, ''))) not between 1 and 1000
     or (p_key is not null and char_length(p_key) > 200)
     or (p_due is not null and (p_due < current_date - 400 or p_due > current_date + 732)) then
    raise exception 'invalid item';
  end if;
  if p_owner is not null and not public.meeting_user_ok(p_owner, 'team', m.workspace_id, null) then
    raise exception 'not allowed: an action''s owner must be on the team';
  end if;
  if p_task is not null and not exists (select 1 from public.tasks t where t.id = p_task and t.workspace_id = m.workspace_id) then
    raise exception 'not authorized';
  end if;
end; $$;
revoke execute on function public.meeting_item_ok(public.meetings, text, text, text, uuid, date, uuid) from public, anon, authenticated;

-- (internal) Items can be written while it runs and for 7 days after.
create or replace function public.meeting_open_for_items(m public.meetings)
returns boolean language sql stable set search_path = public as $$
  select m.status = 'live' or (m.ended_at is not null and m.ended_at > now() - interval '7 days');
$$;
revoke execute on function public.meeting_open_for_items(public.meetings) from public, anon, authenticated;

-- Log a note, a decision or an action (on an agenda item, or at large).
create or replace function public.add_meeting_item(p_meeting uuid, p_kind text, p_body text, p_agenda_key text,
  p_owner uuid, p_due date, p_task uuid)
returns public.meeting_items language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  r public.meeting_items;
begin
  m := public.meeting_for_caller(p_meeting);
  if not public.meeting_open_for_items(m) then raise exception 'meeting closed'; end if;
  perform public.meeting_item_ok(m, p_kind, p_body, p_agenda_key, p_owner, p_due, p_task);
  if (select count(*) from public.meeting_items i where i.meeting_id = p_meeting) >= 300 then raise exception 'too many items'; end if;
  insert into public.meeting_items (meeting_id, workspace_id, kind, body, agenda_key, owner_id, due_on, task_id, created_by)
    values (p_meeting, m.workspace_id, p_kind, btrim(p_body), p_agenda_key, p_owner, p_due, p_task, auth.uid())
    returning * into r;
  return r;
end; $$;
revoke execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) from public, anon;
grant execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) to authenticated;

-- Change an item (the whole of it: kind, words, owner, day, task). Its meeting and agenda item stay.
create or replace function public.update_meeting_item(p_item uuid, p_kind text, p_body text, p_owner uuid, p_due date, p_task uuid)
returns public.meeting_items language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  r public.meeting_items;
begin
  select * into r from public.meeting_items where id = p_item;
  if not found then raise exception 'not authorized'; end if;
  m := public.meeting_for_caller(r.meeting_id);
  if not public.meeting_open_for_items(m) then raise exception 'meeting closed'; end if;
  perform public.meeting_item_ok(m, p_kind, p_body, r.agenda_key, p_owner, p_due, p_task);
  update public.meeting_items set kind = p_kind, body = btrim(p_body), owner_id = p_owner, due_on = p_due, task_id = p_task, updated_at = now()
   where id = p_item returning * into r;
  return r;
end; $$;
revoke execute on function public.update_meeting_item(uuid, text, text, uuid, date, uuid) from public, anon;
grant execute on function public.update_meeting_item(uuid, text, text, uuid, date, uuid) to authenticated;

-- Take an item out.
create or replace function public.delete_meeting_item(p_item uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  mid uuid;
begin
  select meeting_id into mid from public.meeting_items where id = p_item;
  if not found then raise exception 'not authorized'; end if;
  m := public.meeting_for_caller(mid);
  if not public.meeting_open_for_items(m) then raise exception 'meeting closed'; end if;
  delete from public.meeting_items where id = p_item;
end; $$;
revoke execute on function public.delete_meeting_item(uuid) from public, anon;
grant execute on function public.delete_meeting_item(uuid) to authenticated;

-- Remember the notes doc (a doc in one of the host's projects).
create or replace function public.set_meeting_doc(p_meeting uuid, p_doc uuid, p_project uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if p_doc is null or not public.meeting_doc_ok(m.workspace_id, p_doc, p_project) then raise exception 'not authorized'; end if;
  update public.meetings set doc_id = p_doc, doc_project_id = p_project, updated_at = now() where id = p_meeting returning * into m;
  return m;
end; $$;
revoke execute on function public.set_meeting_doc(uuid, uuid, uuid) from public, anon;
grant execute on function public.set_meeting_doc(uuid, uuid, uuid) to authenticated;

-- End it (the presenter, whoever started it, or the host's owners and admins): the recap goes to everyone
-- asked or there who may still read it, but the caller. Ending twice sends nothing more.
create or replace function public.end_meeting(p_meeting uuid, p_doc uuid, p_project uuid)
returns public.meetings language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  me uuid := auth.uid();
  who text;
  decisions integer;
  actions integer;
  r uuid;
begin
  m := public.meeting_for_caller(p_meeting);
  if m.status = 'ended' then return m; end if;
  if me is distinct from m.presenter_id and me is distinct from m.started_by and public.ws_role(m.workspace_id) not in ('owner', 'admin') then
    raise exception 'not authorized';
  end if;
  if p_doc is not null and not public.meeting_doc_ok(m.workspace_id, p_doc, p_project) then raise exception 'not authorized'; end if;
  update public.meetings set status = 'ended', ended_at = now(), ended_by = me, updated_at = now(),
         doc_id = coalesce(p_doc, doc_id), doc_project_id = case when p_doc is null then doc_project_id else p_project end
   where id = p_meeting returning * into m;
  select count(*) filter (where kind = 'decision'), count(*) filter (where kind = 'action')
    into decisions, actions from public.meeting_items where meeting_id = p_meeting;
  who := public.kanbo_person_name(me);
  for r in select a.user_id from public.meeting_attendees a
            where a.meeting_id = p_meeting and a.user_id <> me
            order by a.joined_at nulls last, a.user_id limit 100 loop
    if not public.meeting_user_ok(r, m.preset, m.workspace_id, m.workspace_ids) or not public.notif_on(r, 'update') then continue; end if;
    insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
    values (r, null, left(m.title, 200), 'meeting', left(coalesce(who, 'Someone'), 200), jsonb_build_object(
      'meeting_id', m.id, 'workspace_id', m.workspace_id, 'preset', m.preset,
      'decisions', decisions, 'actions', actions, 'doc_id', m.doc_id, 'project_id', m.doc_project_id));
  end loop;
  return m;
end; $$;
revoke execute on function public.end_meeting(uuid, uuid, uuid) from public, anon;
grant execute on function public.end_meeting(uuid, uuid, uuid) to authenticated;

-- Delete one for good (whoever started it, or the host's owners and admins): its recaps go with it.
create or replace function public.delete_meeting(p_meeting uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.meetings;
begin
  m := public.meeting_for_caller(p_meeting);
  if auth.uid() is distinct from m.started_by and public.ws_role(m.workspace_id) not in ('owner', 'admin') then
    raise exception 'not authorized';
  end if;
  delete from public.meetings where id = p_meeting;
end; $$;
revoke execute on function public.delete_meeting(uuid) from public, anon;
grant execute on function public.delete_meeting(uuid) to authenticated;

-- A deleted meeting (or its business) takes its Inbox recaps with it.
create index if not exists activity_meeting_ref_idx on public.activity ((meta ->> 'meeting_id')) where kind = 'meeting';
create or replace function public.meeting_after_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.activity a where a.kind = 'meeting' and a.meta ->> 'meeting_id' = old.id::text;
  return null;
end; $$;
revoke execute on function public.meeting_after_delete() from public, anon, authenticated;
drop trigger if exists trg_meeting_after_delete on public.meetings;
create trigger trg_meeting_after_delete after delete on public.meetings
  for each row execute function public.meeting_after_delete();

-- ---------- 5. realtime: the presenter's place, who's there, and what's logged ----------
do $rt$
declare t text;
begin
  foreach t in array array['meetings', 'meeting_attendees', 'meeting_items'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;                  -- already streaming
      when object_not_in_prerequisite_state then null;  -- publication is FOR ALL TABLES
      when undefined_object then null;                  -- no realtime publication (local Postgres)
    end;
  end loop;
end $rt$;

-- ---------- 6. who's in the room: the meeting's presence channel ----------
-- The room says who's there (and offers Hand over to them) on the PRIVATE Realtime channel
-- "kanbo:meeting:<id>" (lib/presence). 0048's kanbo_realtime_allowed knew only tasks, docs and projects,
-- so Realtime refused every join. The same function, with a meeting branch: read and say you're there
-- (extension 'presence'), anyone who may read the meeting (can_see_meeting); broadcast, nobody (the
-- presenter's place travels on the meetings table). 0048 carries the same branch (it answers no for a
-- meeting until this file has made can_see_meeting), so running 0048 again keeps it. Only where 0048 is in.
do $presence$
begin
  if to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is null then return; end if;
  execute $fn$
create or replace function public.kanbo_realtime_allowed(p_topic text, p_extension text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_id uuid;
  v_project uuid;
  v_archived timestamptz;
begin
  if auth.uid() is null or p_topic is null or not public.can_act() then return false; end if;
  if p_topic !~ '^kanbo:(task|doc|project|meeting):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  if p_write and p_extension is distinct from 'presence' and p_extension is distinct from 'broadcast' then return false; end if;
  v_kind := split_part(p_topic, ':', 2);
  v_id := split_part(p_topic, ':', 3)::uuid;
  if v_kind = 'task' then
    return public.can_see_task(v_id);
  elsif v_kind = 'project' then
    if p_write and p_extension <> 'presence' then return false; end if;
    return public.can_see_project(v_id);
  elsif v_kind = 'meeting' then
    -- (0056: who's in the room; nothing is broadcast on it)
    if p_write and p_extension <> 'presence' then return false; end if;
    if to_regprocedure('public.can_see_meeting(uuid)') is null then return false; end if;
    return public.can_see_meeting(v_id);
  end if;
  select d.project_id, d.archived_at into v_project, v_archived from public.project_docs d where d.id = v_id;
  if v_project is null then return false; end if;
  if p_write and p_extension = 'broadcast' then
    return v_archived is null and public.can_edit_project(v_project);
  end if;
  return public.can_see_project(v_project);
end; $$
  $fn$;
  revoke all on function public.kanbo_realtime_allowed(text, text, boolean) from public, anon;
  grant execute on function public.kanbo_realtime_allowed(text, text, boolean) to authenticated;
end $presence$;

-- ---------- 7. 0058's project access survives a re-run of this file ----------
-- Belt and braces: a first run after 0058 makes meetings and meeting_items without
-- 0058's triggers on them.  When 0058 is in, put it back.
do $projectaccess$
begin
  if to_regprocedure('public.project_access_restore()') is not null then
    perform public.project_access_restore();
  end if;
end $projectaccess$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0056') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0056')                                  as recorded,
--   (select bool_and(relrowsecurity) from pg_class where oid in ('public.meetings'::regclass,
--     'public.meeting_attendees'::regclass, 'public.meeting_items'::regclass))                                as rls,
--   not has_table_privilege('authenticated', 'public.meetings', 'insert')
--     and not has_table_privilege('authenticated', 'public.meetings', 'update')
--     and not has_table_privilege('authenticated', 'public.meeting_items', 'insert')
--     and not has_table_privilege('authenticated', 'public.meeting_attendees', 'insert')                       as no_client_writes,
--   not has_table_privilege('anon', 'public.meetings', 'select')
--     and not has_table_privilege('anon', 'public.meeting_items', 'select')                                    as anon_reads_nothing,
--   has_function_privilege('authenticated', 'public.start_meeting(uuid,text,text,uuid[],jsonb,uuid[],uuid,uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.start_meeting(uuid,text,text,uuid[],jsonb,uuid[],uuid,uuid)', 'execute') as start_fn,
--   has_function_privilege('authenticated', 'public.end_meeting(uuid,uuid,uuid)', 'execute')
--     and not has_function_privilege('anon', 'public.end_meeting(uuid,uuid,uuid)', 'execute')                 as end_fn,
--   not has_function_privilege('authenticated', 'public.meeting_user_ok(uuid,text,uuid,uuid[])', 'execute')  as internal_helpers,
--   exists (select 1 from pg_trigger where tgname = 'trg_meeting_after_delete' and not tgisinternal)          as recaps_follow,
--   (not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
--     or (select puballtables from pg_publication where pubname = 'supabase_realtime')
--     or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--          and tablename in ('meetings', 'meeting_attendees', 'meeting_items')) = 3)                            as streams,
--   (to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is null
--     or (select prosrc like '%kanbo:(task|doc|project|meeting)%' from pg_proc
--          where oid = 'public.kanbo_realtime_allowed(text,text,boolean)'::regprocedure))                     as room_presence;
-- ============================================================
-- <<<<<<<<<< end of 0056_meetings.sql <<<<<<<<<<

-- >>>>>>>>>> 0057_adoption_health.sql >>>>>>>>>>
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
--      Days run in Europe/London. Only the people who work there (owners,
--      admins and members: never a guest, never the platform admin who
--      provisioned it once it's handed over), each from the day they
--      joined, never before.
--   4. Provisioning a business (platform admins only, is_admin()):
--      admin_provision_business(name, owner email, domain, pack) creates
--      the workspace (the admin owns it while they set it up), invites the
--      owner (as an admin until they join), pre-approves the company
--      domain (never a public mail domain; anyone already waiting from it
--      is let in, unless an admin revoked them) and records a handover.
--      When the invited owner joins (claim_invites), the trigger hands the
--      workspace to them: they become its owner (approved, if they were
--      still waiting: the admin chose them), the admin who set it up
--      stays as an admin, and what the admin set up there (project owners,
--      open tasks assigned to them, goals and portfolios they own) becomes
--      theirs. Only that invite hands it over (its own row, still an
--      admin's): withdrawing it, or changing its role, calls the handover
--      off, so inviting the same address again later never does. The
--      workspace history names the admin who set it up for the role
--      changes, not the person joining.
--      workspace_handovers has no client access at all.
--   5. admin_workspace_adoption(): per workspace, for platform admins:
--      people, invited, weekly active (worked there: a task changed,
--      a comment, an update), tasks done in the last 7 days, the last day
--      anyone worked there, and a pending handover. The admin who
--      provisioned a business isn't counted among its people.
--
-- Needs 0041 (ws_role, can_act, approved_domains), 0042 (schema_migrations,
-- is_admin with suspension, access_revoked, claim_invites), 0016 (sessions),
-- 0032 (admin_audit) and 0038 (task_events). Works with or without
-- 0043–0056; goals change hands only once 0052's goals.owner_id is in.
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
    raise exception '0057 needs 0041 and 0042 first: run them, then this file';
  end if;
  if to_regclass('public.sessions') is null then raise exception '0057 needs public.sessions (0016)'; end if;
  if to_regclass('public.admin_audit') is null then raise exception '0057 needs public.admin_audit (0032)'; end if;
  if to_regclass('public.task_events') is null then raise exception '0057 needs public.task_events (0038)'; end if;
  if to_regclass('public.approved_domains') is null then raise exception '0057 needs public.approved_domains (0041)'; end if;
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
  -- the workspace's first day: nobody was active in it before then (sessions are everyone's, not the workspace's)
  since date := coalesce((select (w.created_at at time zone 'Europe/London')::date from public.workspaces w where w.id = p_ws), month_from);
begin
  if auth.uid() is null or public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  return (
    -- the people who work here: owners, admins and members (never a guest, who may be anyone an owner invited;
    -- never the platform admin who provisioned it and handed it over). Each is counted only from the day they
    -- joined (joined_at; from before 0057, the day their row was made), so a session elsewhere before then is
    -- never this workspace's to see.
    with people as (
      select m.user_id, max((coalesce(m.joined_at, m.created_at) at time zone 'Europe/London')::date) as from_day
        from public.workspace_members m
       where m.workspace_id = p_ws and m.status = 'active' and m.user_id is not null
         and m.role in ('owner', 'admin', 'member')
         and not exists (select 1 from public.workspace_handovers h join public.workspaces w on w.id = h.workspace_id
                          where h.workspace_id = p_ws and h.provisioned_by = m.user_id and w.owner_id is distinct from m.user_id)
       group by m.user_id
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
    days as (select x.user_id, x.day from seen x join people p on p.user_id = x.user_id
              where x.day between greatest(month_from, since, p.from_day) and today)
    select json_build_object(
      'today', today,
      'since', since,
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
-- the owner-to-be's own invite (workspace_members.id): only that row's claim hands the workspace over
alter table public.workspace_handovers add column if not exists member_id uuid;
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

-- Mail domains anyone can sign up with: pre-approving one would let anyone in. The big providers
-- under any country ending (outlook.co.uk, yahoo.fr, gmx.de, …), the rest by name, UK ISPs included.
-- (lib/rolloutApi PUBLIC_MAIL_DOMAINS keeps the console's own copy, to say so before asking.)
create or replace function public.public_mail_domain(d text)
returns boolean language sql immutable parallel safe set search_path = pg_catalog as $$
  select lower(coalesce(d, '')) ~ ('^(gmail|googlemail|outlook|hotmail|live|windowslive|msn|yahoo|ymail|rocketmail|aol|aim|icloud'
      || '|gmx|web|mail|email|yandex|ya|protonmail|proton|zoho|zohomail|tutanota|tuta|tutamail|fastmail|hushmail|mailbox|posteo'
      || '|qq|163|126|yeah|sina|sohu|naver|daum|hanmail|rediffmail|t-online|freenet|orange|wanadoo|free|laposte|sfr|libero|virgilio'
      || '|seznam|wp|o2|onet|interia|inbox|mail2world)\.([a-z]{2,6})(\.[a-z]{2,3})?$')
    or lower(coalesce(d, '')) = any (array['me.com', 'mac.com', 'pm.me', 'hey.com', 'duck.com', 'btinternet.com', 'btopenworld.com',
      'bt.com', 'sky.com', 'virginmedia.com', 'virgin.net', 'ntlworld.com', 'blueyonder.co.uk', 'talktalk.net', 'tiscali.co.uk',
      'plus.net', 'plusnet.com', 'aol.co.uk', 'eclipse.co.uk', 'zen.co.uk', 'live.co.uk', 'mail.ru', 'bk.ru', 'list.ru', 'rambler.ru',
      'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net', 'charter.net', 'shaw.ca', 'rogers.com', 'bigpond.com',
      'optusnet.com.au', 'xtra.co.nz',
    -- shared business-ISP mail and the private relays (anyone can have an address there)
    'btconnect.com', 'talk21.com', 'plus.com', 'tesco.net', 'eircom.net', 'bluewin.ch', 'ziggo.nl', 'telenet.be', 'skynet.be', 'sympatico.ca',
    'privaterelay.appleid.com', 'mozmail.com', 'simplelogin.com', 'simplelogin.co', 'aleeas.com', 'passmail.net', 'passinbox.com']);
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
  insert into public.workspace_handovers (workspace_id, email, pack, provisioned_by, member_id) values (ws, e, pk, me, inv);

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

-- The handover: the invited owner-to-be joins, and the workspace is theirs. Only their own invite
-- (member_id), still an admin's: anyone else joining, even from the same address, never takes it over.
create or replace function public.member_handover() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  h public.workspace_handovers;
  current_owner uuid;
begin
  if new.status <> 'active' or old.status = 'active' or new.user_id is null then return null; end if;
  select * into h from public.workspace_handovers
   where workspace_id = new.workspace_id and done_at is null and member_id = new.id
   for update;
  if h.workspace_id is null then return null; end if;
  -- their invite was changed to another role before they joined: the handover's off
  if new.role <> 'admin' then
    update public.workspace_handovers set done_at = now() where workspace_id = h.workspace_id;
    return null;
  end if;
  update public.workspace_handovers set done_at = now(), new_owner = new.user_id where workspace_id = h.workspace_id;
  -- already handed over by hand (or the admin who set it up has gone): nothing more to do
  select w.owner_id into current_owner from public.workspaces w where w.id = new.workspace_id;
  if h.provisioned_by is null or current_owner is distinct from h.provisioned_by then return null; end if;

  update public.workspace_members set role = 'admin'
   where workspace_id = new.workspace_id and role = 'owner' and id <> new.id;
  update public.workspace_members set role = 'owner' where id = new.id;
  update public.workspaces set owner_id = new.user_id where id = new.workspace_id;
  -- the platform admin choosing them is their approval. (claim_invites approves someone who joins a workspace whose
  -- owner is in good standing, and by the time it looks the owner is them: an account already waiting for approval
  -- would stay on the waitlist with the business in hand, and so would everyone they invited.) Never lifts a
  -- suspension or an admin's revocation; only while whoever set it up is in good standing.
  if exists (select 1 from public.profiles o where o.id = h.provisioned_by
               and coalesce(o.approved, true) and not coalesce(o.suspended, false))
     and not public.access_revoked(new.user_id) then
    perform set_config('kanbo.trusted', 'on', true);
    update public.profiles set approved = true where id = new.user_id and not approved and not suspended;
    perform set_config('kanbo.trusted', 'off', true);
  end if;
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
  -- the workspace history (0047): the role changes above ran as the person joining; they're the
  -- handover the admin set up, so they're the admin's, marked as a handover
  if to_regclass('public.audit_events') is not null and to_regprocedure('public.kanbo_person_name(uuid)') is not null then
    begin
      execute 'update public.audit_events set actor_id = $1, actor_name = left(public.kanbo_person_name($1), 200),
                      detail = detail || jsonb_build_object(''handover'', true)
                where workspace_id = $2 and action = ''role.changed'' and created_at = now() and actor_id is not distinct from $3'
        using h.provisioned_by, new.workspace_id, new.user_id;
    exception when others then
      raise warning 'history not re-attributed (handover): %', sqlerrm;
    end;
  end if;
  return null;
end; $$;
revoke execute on function public.member_handover() from public, anon, authenticated;
drop trigger if exists trg_member_handover on public.workspace_members;
create trigger trg_member_handover after update of status on public.workspace_members
  for each row execute function public.member_handover();

-- The owner-to-be's invite is withdrawn (or their row goes): the handover's off, for good.
create or replace function public.member_handover_withdrawn() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.workspace_handovers set done_at = now()
   where workspace_id = old.workspace_id and member_id = old.id and done_at is null;
  return null;
end; $$;
revoke execute on function public.member_handover_withdrawn() from public, anon, authenticated;
drop trigger if exists trg_member_handover_withdrawn on public.workspace_members;
create trigger trg_member_handover_withdrawn after delete on public.workspace_members
  for each row execute function public.member_handover_withdrawn();

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
      -- (the admin who provisioned a business helps it start: they're not one of its people)
      select w.id, w.name, w.created_at,
        (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.status = 'active'
            and m.user_id is distinct from h.provisioned_by) as members,
        (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.status = 'invited') as invited,
        -- worked there this week (opening Kanbo isn't counted: sessions belong to no one workspace)
        (select count(distinct m.user_id) from public.workspace_members m
          where m.workspace_id = w.id and m.status = 'active' and m.user_id is not null and m.user_id is distinct from h.provisioned_by
            and (exists (select 1 from public.task_events e join public.tasks t on t.id = e.task_id
                          where t.workspace_id = w.id and e.actor_id = m.user_id and e.created_at >= week_ts)
                 or exists (select 1 from public.comments c join public.tasks t on t.id = c.task_id
                             where t.workspace_id = w.id and c.user_id = m.user_id and c.created_at >= week_ts)
                 or exists (select 1 from public.status_updates u
                             where u.workspace_id = w.id and u.user_id = m.user_id and u.created_at >= week_ts))) as weekly_active,
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
insert into public.schema_migrations (version) values ('0057') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0057')                             as recorded,
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
--   exists (select 1 from pg_trigger where tgname = 'trg_member_handover')
--     and exists (select 1 from pg_trigger where tgname = 'trg_member_handover_withdrawn')               as handover_triggers,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'workspace_handovers' and column_name = 'member_id')                     as handover_member,
--   public.public_mail_domain('outlook.co.uk') and public.public_mail_domain('virginmedia.com')
--     and public.public_mail_domain('btconnect.com') and public.public_mail_domain('privaterelay.appleid.com')
--     and not public.public_mail_domain('harbourfit.co.uk')                                            as public_domains,
--   has_function_privilege('authenticated', 'public.admin_workspace_adoption()', 'execute')
--     and not has_function_privilege('anon', 'public.admin_workspace_adoption()', 'execute')          as adoption_signed_in_only;
-- ============================================================
-- <<<<<<<<<< end of 0057_adoption_health.sql <<<<<<<<<<

-- >>>>>>>>>> 0058_project_access.sql >>>>>>>>>>
-- ============================================================
-- KANBO — project access: who can see each project (2026-11-10).
--
-- Each team workspace gets a switch, Project access. It is OFF by default,
-- and while it's off every read and write behaves exactly as it did before
-- this file: every member and guest of the workspace reads every project.
-- While it's on:
--   1. projects.visibility: Whole workspace ('workspace', every member),
--      Members only ('members': the project's people plus the workspace's
--      owners and admins) or Private ('private': the project's people plus
--      the workspace's owners). Workspace owners always see everything.
--   2. project_members: a project's people (editor, commenter, viewer).
--      The project's owner is always an editor and never has a row.
--      Guests are never more than commenters, and see only the projects
--      they're on (or own: someone made a guest after making projects keeps
--      them, as a commenter), and only those projects' people. Someone who
--      leaves a workspace takes nothing with them: the projects they own there
--      go to its owner, and the bin and the history forget their access, so
--      inviting them back gives them only what the invite says (2p; this file
--      does the same once for anyone who left before it). Nor is a project
--      given to anyone who isn't in its workspace, switch on or off.
--   3. One rank per (person, project): 0 none, 1 view, 2 comment, 3 edit,
--      from pa_rank_core() (the single table; src/lib/projectAccessMatrix.json
--      holds the same 320 rows for the app's own tests). Read = 1, comment
--      (and reply, react, attach) = 2, edit (and post an update, change a
--      doc, section, field, rule or form) = 3. Owners, admins and members
--      keep today's rights on Whole workspace projects; on Members only and
--      Private projects their project role applies (admins edit every
--      Members only project). A task (section, form, rule, update) whose
--      project isn't one of its workspace's projects counts as Whole
--      workspace: guests don't see it.
--   4. Every rule that shows project content follows the rank: tasks,
--      sections, custom fields, rules, forms, status updates and their
--      replies, reactions and "seen by", projects, comments, files, docs,
--      approvals, kudos, the bin, the workspace history, goal links, shared
--      saved views, Notion syncs, bill rates, meetings' agendas, search,
--      live channels (they ask the same helpers), the people a guest sees,
--      and what the database itself queues for email, push and webhooks
--      (Inbox notices, held notices and webhook deliveries are dropped for
--      people who can't see the work). Restrictive policies only narrow:
--      nobody gains anything.
--   5. set_project_access() (the workspace's owner only), set_project_visibility(),
--      set_project_member(), remove_project_member(), set_invite_projects() (a guest
--      invited straight onto projects), remove_invite_project() (a project's
--      managers take it off a pending invite) and set_project_owner() (About ›
--      Owner: the column's own check refuses some owners). Every access change
--      touches workspaces.project_access_changed_at, so every open app reloads.
--   6. Notion is for Whole workspace projects while the switch is on (2t): no Members only or Private
--      project has a Notion sync, a Notion import or a task with a Notion link, and every way in is
--      refused with a sentence (a sync, an import, a link, a linked task moved in, a project with them
--      made narrower, the switch turned on while one has them, the bin putting them back). The rule
--      counts the workspace's own syncs and links: one another workspace recorded (left there when
--      its project or task moved here) never runs here, and nobody here can see or remove it.
--   7. Turning the switch off again is the rollback: instant, nothing lost.
--      In an emergency, the SQL editor may switch it off directly:
--        update public.workspaces set project_access = false where id = '<ws id>';
--
-- Needs 0041, 0042, 0043, 0046 and 0047. Works with or without 0048–0057
-- (each optional table is guarded; 0052, 0053, 0054, 0055 and 0056 put
-- project access on their own tables when they run after this file).
-- Idempotent: safe to run more than once (re-running keeps every member,
-- visibility and setting; the first run alone seeds members from
-- contributor_ids).
--
-- Running other files again: 0025, 0041, 0042, 0043, 0046, 0047, 0048,
-- 0052, 0053, 0054, 0055 and 0056 each end by calling
-- project_access_restore() when this file is in, so a re-run of any of them
-- puts every rule here back by itself. 0051 and 0057 touch nothing of this
-- file's. Undo (only if this file itself is broken):
-- supabase/rollback/0058_project_access_undo.sql.
--
-- What this file read in the older files (column names and error texts it
-- reuses): 0046 webhook capture (payload task / comment+task / project),
-- 0047 approvals (approval_reviewers.user_id, 'invalid reviewers'), 0048
-- kudos (to_user, 'invalid recipient') and notify_queue (task_id, payload
-- .due.tasks[].id, payload.about.projects[]), 0052 goal_links (kind,
-- target_id; 'a goal can only link to work in its own workspace') and goals
-- ('a goal can only read its progress from a project in its own
-- workspace'), 0053 update_asks (project_id, asked_by), 0054
-- status_update_comments (update_id, mentions) and status_updates
-- (ask_user_ids; payload status_update / project), 0055 bill_rates
-- (project_id uuid; set_bill_rate's 'not authorized'), 0056 meetings
-- (agenda, preset, workspace_ids, doc_id, doc_project_id) and meeting_items
-- (task_id).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception '0058 needs 0041, 0042, 0043, 0046 and 0047 first: run them, then this file';
  end if;
  if to_regprocedure('public.ws_role(uuid)') is null or to_regprocedure('public.can_act()') is null
     or (select count(*) from public.schema_migrations where version in ('0042', '0043', '0046', '0047')) < 4
     or to_regprocedure('public.is_task_audience(uuid,uuid,uuid)') is null
     or to_regprocedure('public.can_edit_task(uuid)') is null
     or to_regprocedure('public.can_see_task(uuid)') is null
     or to_regprocedure('public.tasks_visible_to(uuid)') is null
     or to_regprocedure('public.user_ws_role(uuid,uuid)') is null
     or to_regprocedure('public.api_scope_restore()') is null
     or to_regprocedure('public.webhook_claim_outbox(integer)') is null
     or to_regprocedure('public.can_see_project(uuid)') is null
     or to_regprocedure('public.kanbo_uuid(text)') is null
     or to_regprocedure('public.audit_log(uuid,text,text,text,text,jsonb)') is null
     or to_regclass('public.trash') is null or to_regclass('public.audit_events') is null then
    raise exception '0058 needs 0041, 0042, 0043, 0046 and 0047 first: run them, then this file';
  end if;
end $pre$;

-- ---------- 1. data ----------
-- 1a. the switch and its settings. Only set_project_access() (the workspace's owner)
-- writes them from the app; the SQL editor and the service role may (the emergency switch-off).
alter table public.workspaces add column if not exists project_access boolean not null default false;
alter table public.workspaces add column if not exists project_access_default text not null default 'workspace';
alter table public.workspaces add column if not exists project_access_member_private boolean not null default false;
alter table public.workspaces add column if not exists project_access_changed_at timestamptz;
alter table public.workspaces drop constraint if exists workspaces_project_access_shape;
alter table public.workspaces add constraint workspaces_project_access_shape
  check (project_access_default in ('workspace', 'members', 'private'));

-- 1b. who can see a project. Every project there now is Whole workspace. The default
-- is dropped on purpose: an insert that doesn't say gets the workspace's default from
-- trg_projects_pa_guard (NOT NULL is checked after BEFORE triggers run).
alter table public.projects add column if not exists visibility text not null default 'workspace';
alter table public.projects alter column visibility drop default;
alter table public.projects drop constraint if exists projects_visibility_shape;
alter table public.projects add constraint projects_visibility_shape check (visibility in ('workspace', 'members', 'private'));
create index if not exists projects_restricted_idx on public.projects (workspace_id) where visibility <> 'workspace';
-- (a workspace's tasks of one project: the guest's people, closed projects, held notices)
create index if not exists tasks_ws_project_idx on public.tasks (workspace_id, project_id);

-- 1c. a project's people (team projects only; its owner is implicit and never has a row)
create table if not exists public.project_members (
  id           uuid primary key default gen_random_uuid(),           -- (loadAllRows orders by id)
  project_id   uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,   -- the project's (set by trigger)
  user_id      uuid not null references auth.users (id) on delete cascade,
  role         text not null default 'editor',
  added_by     uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint project_members_once unique (project_id, user_id),
  constraint project_members_role check (role in ('editor', 'commenter', 'viewer'))
);
create index if not exists project_members_user_idx on public.project_members (user_id, project_id);
create index if not exists project_members_ws_idx on public.project_members (workspace_id);
alter table public.project_members enable row level security;
revoke all on public.project_members from public, anon, authenticated;
grant select on public.project_members to authenticated;

-- 1d. projects a guest is invited straight onto (they become project_members when the invite is claimed)
create table if not exists public.project_member_invites (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.workspace_members (id) on delete cascade,   -- the invite row
  project_id   uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  role         text not null default 'commenter' check (role in ('editor', 'commenter', 'viewer')),
  added_by     uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  constraint project_member_invites_once unique (member_id, project_id)
);
create index if not exists project_member_invites_ws_idx on public.project_member_invites (workspace_id);
alter table public.project_member_invites enable row level security;
revoke all on public.project_member_invites from public, anon, authenticated;
grant select on public.project_member_invites to authenticated;

do $svc$ begin
  grant select, insert, update, delete on public.project_members, public.project_member_invites to service_role;
exception when undefined_object then null; end $svc$;

-- 1e. what the bin and the history knew about a project's access when they were written
alter table public.trash add column if not exists access jsonb;
alter table public.audit_events add column if not exists project_id text;
alter table public.audit_events add column if not exists access jsonb;
create index if not exists audit_events_project_idx on public.audit_events (workspace_id, project_id) where project_id is not null;
-- (a purged task's or project's earlier rows: pa_trg_audit_events)
create index if not exists audit_events_target_idx on public.audit_events (workspace_id, target_kind, target_id, created_at desc)
  where project_id is not null;
-- (the Notion syncs and links the bin holds: a binned project's, or its tasks', keep their database and
-- pages closed to people who can't see the project, as the live ones did: pa_notion_page_hidden asks per
-- link row read, the notion function per preview and import)
create index if not exists trash_notion_links_idx on public.trash using gin ((snapshot -> 'notion_links') jsonb_path_ops)
  where restored_at is null;
create index if not exists trash_notion_syncs_idx on public.trash using gin ((snapshot -> 'notion_syncs') jsonb_path_ops)
  where restored_at is null;
-- (and the links that name a database: user_notion_database_hidden reads them per preview, import and link
-- read)
create index if not exists notion_links_database_idx on public.notion_links (workspace_id, notion_database_id)
  where notion_database_id is not null;
-- 1f. whose access a webhook's deliveries follow once its address changes hands (null: its creator's)
alter table public.webhooks add column if not exists url_set_by uuid references auth.users (id) on delete set null;
-- 1g. the ids of team projects deleted for good (their bin row purged, by hand or by housekeeping),
-- with the access they had (service only, like 0047's trash_ids). 0047 frees an id with its bin
-- row, but what the bin and the history still hold of the project (tasks deleted from it earlier,
-- task.deleted, project.purged) follows a live project of that id first (D21): a new project made
-- under it would take all of that over. So the id is never a project's again (trg_projects_pa_guard),
-- and work that still names it keeps that access, read-only (pa_rank_for), never the loose rule.
create table if not exists public.project_ids_retired (
  id           uuid primary key,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  access       jsonb,
  retired_at   timestamptz not null default now()
);
create index if not exists project_ids_retired_ws_idx on public.project_ids_retired (workspace_id);
-- (and the Notion databases its sync or its imports named, and the pages its tasks were linked to by them:
-- a two-way sync wrote its tasks into those pages, so they stay its people's once it's gone: 2h, 2j)
alter table public.project_ids_retired add column if not exists notion_databases text[] not null default '{}';
alter table public.project_ids_retired add column if not exists notion_pages text[] not null default '{}';
create index if not exists project_ids_retired_pages_idx on public.project_ids_retired using gin (notion_pages);
alter table public.project_ids_retired enable row level security;
revoke all on public.project_ids_retired from public, anon, authenticated;
do $svc$ begin
  grant select, insert, update, delete on public.project_ids_retired to service_role;
exception when undefined_object then null; end $svc$;
-- 1h. a Members only or Private project that left a workspace (moved to Personal, or to another
-- workspace), with the access it had there. Nothing moves its bin entries with it, nor what an old tab,
-- the offline queue or the off window writes under its id afterwards, nor the webhook events waiting
-- for it: all of that still names it in the workspace it left, and mustn't fall to the loose rule there
-- (every member reads and edits it). It keeps that access, read-only, as 1g's work does (pa_rank_for).
-- Moved back, its row goes (the live project's access applies again). Service only.
create table if not exists public.project_departures (
  id           uuid not null,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  access       jsonb,
  left_at      timestamptz not null default now(),
  constraint project_departures_pkey primary key (id, workspace_id)
);
create index if not exists project_departures_ws_idx on public.project_departures (workspace_id);
alter table public.project_departures enable row level security;
revoke all on public.project_departures from public, anon, authenticated;
do $svc$ begin
  grant select, insert, update, delete on public.project_departures to service_role;
exception when undefined_object then null; end $svc$;
-- 1i. a Notion page that a sync or a database's importer linked to a team task, once that link has gone
-- for good while the task's project is still to be reckoned with: the task deleted for good on its own
-- (its bin row purged, by hand or by housekeeping after 30 days), or the link removed with its task still
-- there (unlinked, or by the notion function). A two-way sync wrote that task's title into the page, and
-- the page cache holds it for any link to the page, so the page stays closed to anyone who can't see the
-- project it was linked from (2h), and its database too, once no sync that linked it is left (2j), as
-- they were while the link was live or in the bin. (A project deleted for good keeps its own: 1g.)
-- Recorded whatever the switch says; it's judged only while the switch is on. Service only.
create table if not exists public.notion_pages_retired (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  page_id      text not null,
  database_id  text,
  sync_id      uuid,                 -- (the sync whose link it was: null, an importer's or a removed sync's)
  project_id   text,                 -- (as the task held it: null, no project)
  access       jsonb,                -- (the project's then: 2d)
  retired_at   timestamptz not null default now()
);
create unique index if not exists notion_pages_retired_key
  on public.notion_pages_retired (workspace_id, page_id, (coalesce(project_id, '')), (coalesce(sync_id::text, '')));
create index if not exists notion_pages_retired_db_idx on public.notion_pages_retired (workspace_id, database_id) where database_id is not null;
alter table public.notion_pages_retired enable row level security;
revoke all on public.notion_pages_retired from public, anon, authenticated;
do $svc$ begin
  grant select, insert, update, delete on public.notion_pages_retired to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- 2. the access functions ----------
-- 2a. THE RANK (the single table: SQL, the edge functions and the app mirror it)
create or replace function public.pa_member_rank(p_role text)
returns integer language sql immutable parallel safe set search_path = pg_catalog as $$
  select case p_role when 'editor' then 3 when 'commenter' then 2 when 'viewer' then 1 else 0 end;
$$;

-- p_on: the workspace's switch · p_ws_role: owner | admin | member | guest (anything else: none) ·
-- p_visibility: workspace | members | private, null for a loose row (no real project) ·
-- p_is_owner: the project's owner · p_member: their stored project role (null: no row)
create or replace function public.pa_rank_core(p_on boolean, p_ws_role text, p_visibility text, p_is_owner boolean, p_member text)
returns integer language sql immutable parallel safe set search_path = pg_catalog as $$
  select case
    when p_ws_role is null or p_ws_role not in ('owner', 'admin', 'member', 'guest') then 0   -- outsider, removed, suspended
    when not coalesce(p_on, false) then case p_ws_role when 'guest' then 2 else 3 end        -- switch off: as before
    when p_ws_role = 'owner' then 3                                                          -- owners see everything
    when p_visibility is null then case p_ws_role when 'guest' then 0 else 3 end             -- loose: the whole workspace's
    when p_ws_role = 'guest' and coalesce(p_is_owner, false) then 2                          -- a guest who owns it (made a guest later): theirs, comment at most
    when p_ws_role = 'guest' then least(public.pa_member_rank(p_member), 2)                  -- guests: their projects, comment at most
    when coalesce(p_is_owner, false) then 3                                                  -- the project's owner
    when p_visibility = 'workspace' then 3                                                   -- everyone here edits it
    when p_visibility = 'members' and p_ws_role = 'admin' then 3                             -- admins edit every Members only one
    else public.pa_member_rank(p_member)                                                     -- Members only / Private: their role
  end;
$$;
grant execute on function public.pa_member_rank(text) to public;
grant execute on function public.pa_rank_core(boolean, text, text, boolean, text) to public;

-- 2b. small internals
create or replace function public.pa_on(p_ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select w.project_access from public.workspaces w where w.id = p_ws), false);
$$;
-- (a person's membership of a workspace, whether or not they can act: the rows a project's people may have)
create or replace function public.pa_ws_member_role(p_user uuid, p_ws uuid)
returns text language sql security definer stable set search_path = public as $$
  select coalesce(
    (select m.role from public.workspace_members m
      where m.workspace_id = p_ws and m.user_id = p_user and m.status = 'active' limit 1),
    (select 'owner' from public.workspaces w where w.id = p_ws and w.owner_id = p_user),
    'none');
$$;
create or replace function public.pa_restoring()
returns boolean language sql stable set search_path = pg_catalog as $$
  select coalesce(current_setting('kanbo.restoring', true), '') = 'on'
      or coalesce(current_setting('kanbo.trash_bypass', true), '') = 'on';
$$;
create or replace function public.pa_is_client()
returns boolean language sql stable set search_path = public as $$
  select coalesce(auth.role(), '') in ('authenticated', 'anon');
$$;
revoke execute on function public.pa_on(uuid) from public, anon, authenticated;
revoke execute on function public.pa_ws_member_role(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.pa_restoring() from public, anon, authenticated;
revoke execute on function public.pa_is_client() from public, anon, authenticated;

-- 2c. ranks for someone, and for the caller
-- someone's rank on a workspace's project (p_project as stored: text; a loose id gives the loose rule).
-- A project in the bin keeps the access it had: its updates, fields, rules and forms stay until it's
-- purged (0047), and mustn't fall to the loose rule meanwhile. Nor does one deleted for good (1g):
-- work an old tab, the offline queue or the off window wrote into it after the delete stays its
-- people's. Either way it's read-only (view at most) but for the workspace's owners: nothing new is
-- written into a project that's gone, to outlive it. Nor does a Members only or Private one that has
-- left the workspace (1h): what still names it here keeps the access it had here.
create or replace function public.pa_rank_for(p_user uuid, p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case
      when not coalesce(w.project_access, false) then public.pa_rank_core(false, r.role, null, false, null)
      when p.id is not null then public.pa_rank_core(true, r.role, p.visibility, p.owner_id = p_user,
                                   (select m.role from public.project_members m where m.project_id = p.id and m.user_id = p_user))
      when b.access is not null then least(
                                   public.pa_rank_core(true, r.role, coalesce(b.access ->> 'visibility', 'workspace'),
                                     b.access ->> 'owner' = p_user::text,
                                     (select e ->> 1 from jsonb_array_elements(case when jsonb_typeof(b.access -> 'members') = 'array'
                                                                                    then b.access -> 'members' else '[]'::jsonb end) e
                                       where e ->> 0 = p_user::text limit 1)),
                                   case when r.role = 'owner' then 3 else 1 end)
      else public.pa_rank_core(true, r.role, null, false, null) end
      from public.workspaces w
      cross join lateral (select public.user_ws_role(p_user, w.id) as role) r
      left join public.projects p on p.id = public.kanbo_uuid(p_project) and p.workspace_id = w.id
      left join lateral (
        select coalesce(
                 (select x.access from public.trash x
                   where x.item_id = public.kanbo_uuid(p_project) and x.kind = 'project' and x.workspace_id = w.id and x.restored_at is null
                   order by x.deleted_at desc limit 1),
                 (select g.access from public.project_ids_retired g
                   where g.id = public.kanbo_uuid(p_project) and g.workspace_id = w.id),
                 (select d.access from public.project_departures d
                   where d.id = public.kanbo_uuid(p_project) and d.workspace_id = w.id)) as access
         where p.id is null and public.kanbo_uuid(p_project) is not null) b on true
     where w.id = p_ws and p_user is not null), 0);
$$;
create or replace function public.pa_rank(p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_rank_for(auth.uid(), p_ws, p_project);
$$;
-- (an assignee's rank, for trg_tasks_pa: someone suspended or awaiting approval is still in the
-- workspace, and has the rank they'll have once they can act again, as the app (which never knows who's
-- suspended) judges them; null: not in the workspace at all, so nothing in it is theirs to see)
create or replace function public.pa_assignee_rank(p_user uuid, p_ws uuid, p_project text)
returns integer language plpgsql security definer stable set search_path = public as $$
declare r text := public.pa_ws_member_role(p_user, p_ws); p record;
begin
  if r not in ('owner', 'admin', 'member', 'guest') then return null; end if;
  if public.user_ws_role(p_user, p_ws) <> 'none' then return public.pa_rank_for(p_user, p_ws, p_project); end if;
  select x.id, x.visibility, x.owner_id into p from public.projects x where x.id = public.kanbo_uuid(p_project) and x.workspace_id = p_ws;
  return public.pa_rank_core(public.pa_on(p_ws), r, case when p.id is null then null else p.visibility end, p.id is not null and p.owner_id = p_user,
           case when p.id is null then null
                else (select m.role from public.project_members m where m.project_id = p.id and m.user_id = p_user) end);
end; $$;
revoke execute on function public.pa_assignee_rank(uuid, uuid, text) from public, anon, authenticated;
-- The row form for the policies on projects: it never reads the projects row (an INSERT … RETURNING
-- row isn't there yet for a STABLE function), only the switch, the caller's role and their member row.
create or replace function public.pa_project_rank(p_ws uuid, p_project uuid, p_visibility text, p_owner uuid)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when not coalesce(w.project_access, false)
                then public.pa_rank_core(false, r.role, null, false, null)
                else public.pa_rank_core(true, r.role, coalesce(p_visibility, 'workspace'), p_owner = auth.uid(),
                       (select m.role from public.project_members m where m.project_id = p_project and m.user_id = auth.uid())) end
      from public.workspaces w
      cross join lateral (select public.user_ws_role(auth.uid(), w.id) as role) r
     where w.id = p_ws and auth.uid() is not null), 0);
$$;
-- (a task's and an update's rank: per row in policies that have no G() prefix, so a workspace whose
-- switch is off answers from the caller's role alone, as before this file: no project lookups)
create or replace function public.pa_task_rank(p_task uuid)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when t.workspace_id is null
                then case when t.user_id = auth.uid() and public.can_act() then 3 else 0 end
                when not public.pa_on(t.workspace_id) then public.pa_rank_core(false, public.ws_role(t.workspace_id), null, false, null)
                else public.pa_rank(t.workspace_id, t.project_id) end
      from public.tasks t where t.id = p_task), 0);
$$;
create or replace function public.pa_status_update_rank(p_update uuid)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when s.workspace_id is null
                then case when s.user_id = auth.uid() and public.can_act() then 3 else 0 end
                when not public.pa_on(s.workspace_id) then public.pa_rank_core(false, public.ws_role(s.workspace_id), null, false, null)
                else public.pa_rank(s.workspace_id, s.project_id) end
      from public.status_updates s where s.id = p_update), 0);
$$;

-- 2d. the bin's and the history's captured access: {"v":1,"visibility":…,"owner":"<uuid>","members":[["<uuid>","editor"],…]}
-- (the live project's; for one deleted for good, what it had then: 1g; for one that left, what it had here: 1h)
create or replace function public.pa_access_snapshot(p_ws uuid, p_project text)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when p.id is not null then jsonb_build_object(
    'v', 1, 'visibility', p.visibility, 'owner', p.owner_id,
    'members', coalesce((select jsonb_agg(jsonb_build_array(m.user_id, m.role) order by m.created_at, m.id)
                           from public.project_members m where m.project_id = p.id), '[]'::jsonb))
    else coalesce((select g.access from public.project_ids_retired g where g.id = public.kanbo_uuid(p_project) and g.workspace_id = p_ws),
                  (select d.access from public.project_departures d where d.id = public.kanbo_uuid(p_project) and d.workspace_id = p_ws)) end
    from (select 1) one
    left join public.projects p on p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws;
$$;
-- someone's rank from a captured access (null: the loose rule)
create or replace function public.pa_captured_rank(p_user uuid, p_ws uuid, p_access jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_rank_core(
           public.pa_on(p_ws), public.user_ws_role(p_user, p_ws),
           case when p_access is null then null else coalesce(p_access ->> 'visibility', 'workspace') end,
           p_access is not null and p_access ->> 'owner' = p_user::text,
           (select e ->> 1 from jsonb_array_elements(case when jsonb_typeof(p_access -> 'members') = 'array'
                                                          then p_access -> 'members' else '[]'::jsonb end) e
             where e ->> 0 = p_user::text limit 1));
$$;
-- what's known of a project that's gone: its newest bin row's access while it's in the bin, else
-- what it had when it was deleted for good (1g), else what it had here when it left the workspace (1h),
-- else its newest history row's (the purge row keeps what its delete captured). Null: nothing known (a
-- loose id, or a project deleted before this file)
create or replace function public.pa_gone_access(p_ws uuid, p_project text)
returns jsonb language sql security definer stable set search_path = public as $$
  select coalesce(
    (select x.access from public.trash x
      where x.item_id = public.kanbo_uuid(p_project) and x.workspace_id = p_ws and x.kind = 'project' and x.restored_at is null
      order by x.deleted_at desc limit 1),
    (select g.access from public.project_ids_retired g where g.id = public.kanbo_uuid(p_project) and g.workspace_id = p_ws),
    (select d.access from public.project_departures d where d.id = public.kanbo_uuid(p_project) and d.workspace_id = p_ws),
    (select e.access from public.audit_events e
      where e.workspace_id = p_ws and e.target_kind = 'project' and e.target_id = p_project
        and e.project_id is not null and e.access is not null
      order by e.created_at desc, e.id desc limit 1))
   where public.kanbo_uuid(p_project) is not null;
$$;
-- someone's rank on what a bin or history row names: the live project while it's there; else the
-- lower of what the row itself captured and what's known of its project (D21). A row captured while
-- its project was Whole workspace (or before this file, with nothing captured) mustn't open up once
-- that project is made Private and then deleted.
create or replace function public.pa_snapshot_rank_for(p_user uuid, p_ws uuid, p_project text, p_access jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select case
    when p_user is null or p_ws is null then 0
    when exists (select 1 from public.projects p where p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws)
      then public.pa_rank_for(p_user, p_ws, p_project)
    else (select case when g.access is null then public.pa_captured_rank(p_user, p_ws, p_access)
                      when p_access is null then public.pa_captured_rank(p_user, p_ws, g.access)
                      else least(public.pa_captured_rank(p_user, p_ws, p_access), public.pa_captured_rank(p_user, p_ws, g.access)) end
            from (select public.pa_gone_access(p_ws, p_project) as access) g) end;
$$;
create or replace function public.pa_snapshot_rank(p_ws uuid, p_project text, p_access jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_snapshot_rank_for(auth.uid(), p_ws, p_project, p_access);
$$;
-- a project's rank for someone, from the bin or the history when it's been deleted (its tasks'
-- webhook events go out after the project has gone)
create or replace function public.pa_rank_or_binned(p_user uuid, p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_snapshot_rank_for(p_user, p_ws, p_project, null);
$$;
-- the narrowest visibility a gone project's work had: what its row captured, or what's known of the
-- project, whichever is narrower ('workspace' when neither says)
create or replace function public.pa_gone_visibility(p_ws uuid, p_project text, p_access jsonb)
returns text language sql security definer stable set search_path = public as $$
  select case when 'private' in (v.a, v.b) then 'private' when 'members' in (v.a, v.b) then 'members' else 'workspace' end
    from (select p_access ->> 'visibility' as a, public.pa_gone_access(p_ws, p_project) ->> 'visibility' as b) v;
$$;

-- 2e. who's behind the switch, for the policies' cheap first test (computed once a statement)
-- The workspaces whose switch is on where the caller is an admin, member or guest (an owner always
-- has rank 3, so their rows skip the per-row call). '{}' signed out.
create or replace function public.pa_gated_ws()
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(array_agg(x.id), '{}') from (
    select distinct w.id from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where w.project_access and m.user_id = auth.uid() and m.status = 'active') x
   where auth.uid() is not null and public.ws_role(x.id) in ('admin', 'member', 'guest');
$$;
-- (a guest by their row, whether or not they can act: one who's suspended or awaiting approval reads
-- only their projects' people too, never everyone's)
create or replace function public.pa_guest_ws()
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(array_agg(x.id), '{}') from (
    select distinct w.id from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where w.project_access and m.user_id = auth.uid() and m.status = 'active' and m.role = 'guest') x
   where auth.uid() is not null;
$$;
-- the same for someone else (tasks_visible_to)
create or replace function public.pa_gated_ws_for(p_user uuid)
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(array_agg(x.id), '{}') from (
    select distinct w.id from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where w.project_access and m.user_id = p_user and m.status = 'active') x
   where p_user is not null and public.user_ws_role(p_user, x.id) in ('admin', 'member', 'guest');
$$;

-- Is this task in a workspace whose switch is on for the caller (so its comments and files follow the rank)?
create or replace function public.pa_task_gated(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.tasks t where t.id = p_task and t.workspace_id = any (public.pa_gated_ws()));
$$;

-- 2f. the people a guest sees (D16): themselves; the workspace's owners; and, on each project they're
-- on (or own), its owner, its people and its tasks' assignees, creators, collaborators and comment authors
create or replace function public.pa_guest_sees(p_ws uuid, p_target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_target is not null and (
    p_target = auth.uid()
    or exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_target)
    or exists (select 1 from public.workspace_members m
                where m.workspace_id = p_ws and m.user_id = p_target and m.status = 'active' and m.role = 'owner')
    or exists (
      select 1 from public.projects p
       where p.workspace_id = p_ws
         and (p.owner_id = auth.uid()
              or exists (select 1 from public.project_members mine
                          where mine.project_id = p.id and mine.user_id = auth.uid() and mine.workspace_id = p_ws))
         and (p.owner_id = p_target
           or exists (select 1 from public.project_members o where o.project_id = p.id and o.user_id = p_target)
           or exists (select 1 from public.tasks t
                       where t.workspace_id = p_ws and t.project_id = p.id::text
                         and (t.user_id = p_target or public.kanbo_uuid(t.assignee_id) = p_target
                              or exists (select 1 from unnest(t.collaborators) c where public.kanbo_uuid(c) = p_target)))
           or exists (select 1 from public.tasks t join public.comments c on c.task_id = t.id
                       where t.workspace_id = p_ws and t.project_id = p.id::text and c.user_id = p_target))));
$$;
-- '<ws>:<user>' for everyone the caller sees in each workspace where they're a guest behind the switch
create or replace function public.pa_guest_people()
returns text[] language sql security definer stable set search_path = public as $$
  with g as (select unnest(public.pa_guest_ws()) as ws),
  mine as (
    select pm.project_id, pm.workspace_id as ws from public.project_members pm
      join g on g.ws = pm.workspace_id
      join public.projects p on p.id = pm.project_id and p.workspace_id = pm.workspace_id
     where pm.user_id = auth.uid()
    union select p.id, p.workspace_id from public.projects p join g on g.ws = p.workspace_id where p.owner_id = auth.uid()),
  ptasks as (
    select mine.ws, t.id, t.user_id, t.assignee_id, t.collaborators from mine
      join public.tasks t on t.workspace_id = mine.ws and t.project_id = mine.project_id::text),
  people(ws, uid) as (
    select g.ws, auth.uid() from g
    union select w.id, w.owner_id from public.workspaces w join g on g.ws = w.id
    union select m.workspace_id, m.user_id from public.workspace_members m join g on g.ws = m.workspace_id
           where m.status = 'active' and m.role = 'owner'
    union select mine.ws, p.owner_id from mine join public.projects p on p.id = mine.project_id
    union select mine.ws, o.user_id from mine join public.project_members o on o.project_id = mine.project_id
    union select ptasks.ws, ptasks.user_id from ptasks
    union select ptasks.ws, public.kanbo_uuid(ptasks.assignee_id) from ptasks
    union select ptasks.ws, public.kanbo_uuid(c) from ptasks cross join lateral unnest(ptasks.collaborators) c
    union select ptasks.ws, cm.user_id from ptasks join public.comments cm on cm.task_id = ptasks.id)
  select coalesce(array_agg(distinct p.ws::text || ':' || p.uid::text), '{}') from people p
   where auth.uid() is not null and p.uid is not null;
$$;
-- May the caller see this person (their profile)? Anyone they share a workspace with where they aren't a
-- guest behind the switch; in a workspace where they are, only the people above.
create or replace function public.pa_person_visible(p_target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_target is not null and auth.uid() is not null and (
    p_target = auth.uid()
    or exists (
      select 1 from (
        select m.workspace_id as ws from public.workspace_members m where m.user_id = auth.uid() and m.status = 'active'
        union select w.id from public.workspaces w where w.owner_id = auth.uid()) mine
       where not (mine.ws = any (public.pa_guest_ws()))
         and (exists (select 1 from public.workspace_members o
                       where o.workspace_id = mine.ws and o.user_id = p_target and o.status = 'active')
              or exists (select 1 from public.workspaces w where w.id = mine.ws and w.owner_id = p_target)))
    or exists (select 1 from unnest(public.pa_guest_ws()) g(ws) where public.pa_guest_sees(g.ws, p_target)));
$$;

-- 2g. who manages a project's people and visibility (D12). p_on_rule: judge by the switch-on rule
-- whatever the switch says (visibility always is); people follow today's rule while it's off, on a
-- Whole workspace project. A Members only or Private one keeps the switch-on rule while it's off too
-- (the rollback window): otherwise anyone could add themselves, or take it over, and keep that when
-- it's switched back on.
create or replace function public.pa_manage_rule(p_project uuid, p_on_rule boolean)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select case
      when auth.uid() is null or not public.can_act() then false
      when p.workspace_id is null then p.user_id = auth.uid()
      when not (coalesce(p_on_rule, false) or coalesce(w.project_access, false) or p.visibility <> 'workspace')
        then public.can_write(p.workspace_id)
      else r.role = 'owner'
        or (r.role in ('admin', 'member') and (p.owner_id = auth.uid()
              or exists (select 1 from public.project_members m
                          where m.project_id = p.id and m.user_id = auth.uid() and m.role = 'editor')))
        or (r.role = 'admin' and p.visibility <> 'private') end
      from public.projects p
      left join public.workspaces w on w.id = p.workspace_id
      cross join lateral (select public.ws_role(p.workspace_id) as role) r
     where p.id = p_project), false);
$$;
create or replace function public.pa_can_manage(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.pa_manage_rule(p_project, false);
$$;
-- owners and admins always; members when the workspace lets them
create or replace function public.pa_may_make_private(p_ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.ws_role(p_ws) in ('owner', 'admin')
      or (public.ws_role(p_ws) = 'member'
          and coalesce((select w.project_access_member_private from public.workspaces w where w.id = p_ws), false));
$$;
create or replace function public.pa_user_may_make_private(p_user uuid, p_ws uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.user_ws_role(p_user, p_ws) in ('owner', 'admin')
      or (public.user_ws_role(p_user, p_ws) = 'member'
          and coalesce((select w.project_access_member_private from public.workspaces w where w.id = p_ws), false));
$$;

-- 2h. goal links and shared views
create or replace function public.pa_goal_target_rank(p_ws uuid, p_kind text, p_target text)
returns integer language sql security definer stable set search_path = public as $$
  select case p_kind when 'project' then public.pa_rank(p_ws, p_target)
                     when 'task' then public.pa_task_rank(public.kanbo_uuid(p_target))
                     else 3 end;
$$;
-- A shared view's rank: the lowest over every project its query names (src/lib/viewRows.ts
-- SavedViewQuery: projectId, filters.projectId, search.filters.projectId; filters.project for
-- old saved searches), 3 when it names none.
create or replace function public.pa_view_rank(p_ws uuid, p_query jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce(min(public.pa_rank(p_ws, q.x)), 3) from (
    select nullif(p_query ->> 'projectId', '') as x
    union select nullif(p_query #>> '{filters,projectId}', '')
    union select nullif(p_query #>> '{filters,project}', '')
    union select nullif(p_query #>> '{search,filters,projectId}', '')) q
   where q.x is not null and q.x <> 'all';
$$;
-- Is this Notion page one of a task's that the caller can't see? A two-way sync keeps a page's title equal
-- to its task's, and the page cache (0046) holds it for every link to the page, so a link of the caller's
-- own to that page (made before the project narrowed, or by notion_link_page with the page's id) would read
-- the hidden task's current title, and the notion function would fetch it from Notion on request. Such a
-- page is linked by the sync (kind 'synced'), or by its database's importer (notion_database_id set: a
-- one-off import, a sync that was removed, a link the bin brought back without its sync); a link someone
-- added by hand names no database, and never hides a page. It stays hidden while the project's (or the
-- task's) in the bin (the links its row holds, judged by that row's access), once the project's deleted
-- for good (the pages its row recorded, 1g), and once the task's deleted for good on its own or the link
-- is removed (1i, judged by the project it was linked from). Unless the caller can see the task that a
-- live sync links the page to: the page is that task's then, whatever an import elsewhere made of it. But
-- never while a live sync ALSO links it to a task the caller can't see: a page moved, in Notion, from one
-- synced database into another could be taken in by both syncs (the notion function no longer lets it,
-- with the switch on: heldElsewhere, movedOut), and the cache would then hold whichever task's title was
-- written last, a Private one's included. Asked by someone who isn't in the workspace (it's served at
-- /rpc): always hidden, so it never says whether a page is linked there.
create or replace function public.pa_notion_page_hidden(p_ws uuid, p_page text)
returns boolean language sql security definer stable set search_path = public as $$
  select not public.is_member(p_ws)
      or exists (select 1 from public.notion_links l
                  where l.workspace_id = p_ws and l.notion_page_id = p_page and l.kind = 'synced' and l.sync_id is not null
                    and not public.can_see_task(l.task_id))
      or ((exists (select 1 from public.notion_links l
                   where l.workspace_id = p_ws and l.notion_page_id = p_page
                     and (l.kind = 'synced' or l.notion_database_id is not null)
                     and not public.can_see_task(l.task_id))
          or exists (select 1 from public.trash r
                      where r.workspace_id = p_ws and r.restored_at is null
                        and r.snapshot -> 'notion_links' @> jsonb_build_array(jsonb_build_object('notion_page_id', p_page))
                        and exists (select 1 from jsonb_array_elements(r.snapshot -> 'notion_links') e
                                     where e ->> 'notion_page_id' = p_page
                                       and (e ->> 'kind' = 'synced' or e ->> 'notion_database_id' is not null))
                        and public.pa_snapshot_rank(r.workspace_id, r.project_id, r.access) < 1)
          or exists (select 1 from public.project_ids_retired g
                      where g.workspace_id = p_ws and g.notion_pages @> array[p_page]
                        and public.pa_rank(p_ws, g.id::text) < 1)
          or exists (select 1 from public.notion_pages_retired x
                      where x.workspace_id = p_ws and x.page_id = p_page
                        and public.pa_snapshot_rank(p_ws, x.project_id, x.access) < 1))
         and not exists (select 1 from public.notion_links l
                          where l.workspace_id = p_ws and l.notion_page_id = p_page and l.kind = 'synced' and l.sync_id is not null
                            and public.can_see_task(l.task_id)));
$$;

-- 2i. the public helpers (can_see_task, can_edit_task, can_see_project, can_edit_project and
-- can_see_status_update take their new bodies in section 5) and two new ones
create or replace function public.can_comment_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select public.pa_task_rank(p_task) >= 2;
$$;
create or replace function public.can_comment_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.pa_project_rank(p.workspace_id, p.id, p.visibility, p.owner_id) >= 2)));
$$;

do $grants$
declare f text;
begin
  -- the policies' helpers: signed-in callers only
  foreach f in array array['public.pa_rank(uuid,text)', 'public.pa_project_rank(uuid,uuid,text,uuid)', 'public.pa_task_rank(uuid)',
                           'public.pa_status_update_rank(uuid)', 'public.pa_snapshot_rank(uuid,text,jsonb)',
                           'public.pa_gated_ws()', 'public.pa_guest_ws()', 'public.pa_guest_people()',
                           'public.pa_person_visible(uuid)', 'public.pa_can_manage(uuid)', 'public.pa_may_make_private(uuid)',
                           'public.pa_goal_target_rank(uuid,text,text)', 'public.pa_view_rank(uuid,jsonb)', 'public.pa_task_gated(uuid)',
                           'public.pa_notion_page_hidden(uuid,text)',
                           'public.can_comment_task(uuid)', 'public.can_comment_project(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- internal
  foreach f in array array['public.pa_rank_for(uuid,uuid,text)', 'public.pa_access_snapshot(uuid,text)',
                           'public.pa_snapshot_rank_for(uuid,uuid,text,jsonb)', 'public.pa_rank_or_binned(uuid,uuid,text)',
                           'public.pa_captured_rank(uuid,uuid,jsonb)', 'public.pa_gone_access(uuid,text)',
                           'public.pa_gone_visibility(uuid,text,jsonb)',
                           'public.pa_gated_ws_for(uuid)', 'public.pa_guest_sees(uuid,uuid)', 'public.pa_manage_rule(uuid,boolean)',
                           'public.pa_user_may_make_private(uuid,uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $grants$;

-- 2j. service-only helpers (the edge functions: notify, daily-reminders, Slack, public forms, the API)
create or replace function public.user_project_rank(p_user uuid, p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_rank_for(p_user, p_ws, p_project);
$$;
create or replace function public.user_can_see_task(p_user uuid, p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when t.workspace_id is null then t.user_id = p_user and public.user_can_act(p_user)
                else public.pa_rank_for(p_user, t.workspace_id, t.project_id) >= 1 end
      from public.tasks t where t.id = p_task and p_user is not null), false);
$$;
create or replace function public.user_can_see_project(p_user uuid, p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when p.workspace_id is null then p.user_id = p_user and public.user_can_act(p_user)
                else public.pa_rank_for(p_user, p.workspace_id, p.id::text) >= 1 end
      from public.projects p where p.id = p_project and p_user is not null), false);
$$;
create or replace function public.user_visible_task_ids(p_user uuid, p_ids uuid[])
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(array_agg(t.id order by t.id), '{}') from public.tasks t
   where t.id = any (coalesce(p_ids, '{}')) and public.user_can_see_task(p_user, t.id);
$$;
-- the projects in a workspace that aren't open to everyone there (the switch is on and they're
-- Members only or Private; or such a project is in the bin, or was deleted for good, or has left the
-- workspace (1h), and work an old tab wrote into it since still names it): '{}' while it's off
create or replace function public.closed_project_ids(p_ws uuid)
returns text[] language sql security definer stable set search_path = public as $$
  select case when public.pa_on(p_ws)
              then coalesce((select array_agg(c.id order by c.id) from (
                     select p.id::text as id from public.projects p
                      where p.workspace_id = p_ws and p.visibility <> 'workspace'
                     union
                     select x.item_id::text from public.trash x
                      where x.workspace_id = p_ws and x.kind = 'project' and x.restored_at is null
                        and coalesce(x.access ->> 'visibility', 'workspace') <> 'workspace'
                        and not exists (select 1 from public.projects p where p.id = x.item_id and p.workspace_id = p_ws)
                     union
                     select g.id::text from public.project_ids_retired g
                      where g.workspace_id = p_ws and coalesce(g.access ->> 'visibility', 'workspace') <> 'workspace'
                     union
                     select d.id::text from public.project_departures d
                      where d.workspace_id = p_ws and coalesce(d.access ->> 'visibility', 'workspace') <> 'workspace'
                        and not exists (select 1 from public.projects p where p.id = d.id and p.workspace_id = p_ws)) c), '{}')
              else '{}'::text[] end;
$$;
-- (p_project as stored: free text, so an id in capitals names the same project, as every rank check
-- (kanbo_uuid) reads it; closed_project_ids is lower case)
create or replace function public.project_is_open(p_ws uuid, p_project text)
returns boolean language sql security definer stable set search_path = public as $$
  select p_project is null
      or not (coalesce(public.kanbo_uuid(p_project)::text, p_project) = any (public.closed_project_ids(p_ws)));
$$;
-- Is this Notion database (p_db: notion_norm_id's form) closed to someone here (the switch on)? Its pages
-- are a project's tasks they can't see: a two-way sync writes them there, so previewing or importing it
-- would show them, and keeping it in sync would take the sync over from that project (the notion
-- function: syncsOutOfSight; and trg_notion_syncs_pa, for a new sync made by notion_save_sync itself).
--   - It syncs with such a project.
--   - Its sync with one was removed, or it was imported into one: its pages stay linked to that project's
--     tasks (plain links that still name the database), and a two-way sync's edits are still in them. (A
--     task synced with a project they can see, moved since into one they can't, keeps its sync's link:
--     the sync leaves it alone, and the database is still the open project's.) A link keeps the workspace
--     it was made in when its task moves to someone's Personal list or to another workspace
--     (notion_links_guard fires only on writes to the link), and which project here it left isn't
--     recorded. So the database is judged by its tasks still here; a task that has left counts only when
--     none is (its pages may still hold what a two-way sync wrote from a closed project), and then it's
--     closed to all but the workspace's owners, who see every project. A task still here is one that any
--     of the database's links names, a sync's too (still_here: Keep in sync takes an import's plain links
--     over, and a live sync is judged by its project, above); a plain link by its task's project.
--   - Such a project is in the bin, or its tasks are: the syncs and links their bin entries hold, each
--     judged by its row's access (a binned task's link whose sync is still here is that sync's project's,
--     as a live one is). Once the project is deleted for good, the databases its row recorded (1g); once
--     such a task is deleted for good on its own, or its link removed, the page it left behind (1i: its
--     pages still hold what a two-way sync wrote), judged as a binned link is; one whose task had left
--     the workspace by then (to someone's Personal list or another workspace) as a link that has left:
--     only once none of the database's tasks is still here.
create or replace function public.user_notion_database_hidden(p_user uuid, p_ws uuid, p_db text)
returns boolean language sql security definer stable set search_path = public as $$
  with linked as (
    select coalesce(t.workspace_id = l.workspace_id, false) as here, t.project_id
      from public.notion_links l join public.tasks t on t.id = l.task_id
     where l.workspace_id = p_ws and l.sync_id is null and l.notion_database_id = p_db),
  -- (a task of the database's still here, whichever link names it: plain, or a sync's)
  still_here as (
    select 1 from public.notion_links l join public.tasks t on t.id = l.task_id
     where l.workspace_id = p_ws and l.notion_database_id = p_db and t.workspace_id = p_ws)
  select p_user is not null and p_db is not null and public.pa_on(p_ws) and (
       exists (select 1 from public.notion_syncs s
                where s.workspace_id = p_ws and s.database_id = p_db and public.pa_rank_for(p_user, p_ws, s.project_id::text) < 1)
    or exists (select 1 from linked k where k.here and public.pa_rank_for(p_user, p_ws, k.project_id) < 1)
    or (exists (select 1 from linked k where not k.here) and not exists (select 1 from still_here)
        and public.user_ws_role(p_user, p_ws) <> 'owner')
    or exists (select 1 from public.trash r
                where r.workspace_id = p_ws and r.restored_at is null
                  and ((r.snapshot -> 'notion_syncs' @> jsonb_build_array(jsonb_build_object('database_id', p_db)))
                       or (r.snapshot -> 'notion_links' @> jsonb_build_array(jsonb_build_object('notion_database_id', p_db))
                           and exists (select 1 from jsonb_array_elements(r.snapshot -> 'notion_links') e
                                        where e ->> 'notion_database_id' = p_db
                                          and not exists (select 1 from public.notion_syncs x where x.id = public.kanbo_uuid(e ->> 'sync_id')))))
                  and public.pa_snapshot_rank_for(p_user, p_ws, r.project_id, r.access) < 1)
    or exists (select 1 from public.project_ids_retired g
                where g.workspace_id = p_ws and p_db = any (g.notion_databases)
                  and public.pa_rank_for(p_user, p_ws, g.id::text) < 1)
    or exists (select 1 from public.notion_pages_retired x
                where x.workspace_id = p_ws and x.database_id = p_db
                  and not exists (select 1 from public.notion_syncs s where s.id = x.sync_id)
                  -- (one whose task had left the workspace, which names no project here, as a link whose
                  -- task has left: only once none of the database's tasks is still here)
                  and (x.project_id is not null or not exists (select 1 from still_here))
                  and public.pa_snapshot_rank_for(p_user, p_ws, x.project_id, x.access) < 1));
$$;
-- (the caller's, for notion_links' read rule: a link someone added by hand to a database's id, made before
-- that database closed to the caller, would read its title from the page cache, and the notion function
-- would fetch it again on request; notion_link_page refuses a new one. Asked by someone who isn't in the
-- workspace (it's served at /rpc): always closed, so it never says whether a database syncs there)
create or replace function public.pa_notion_database_hidden(p_ws uuid, p_db text)
returns boolean language sql security definer stable set search_path = public as $$
  select not public.is_member(p_ws) or public.user_notion_database_hidden(auth.uid(), p_ws, p_db);
$$;
revoke execute on function public.pa_notion_database_hidden(uuid, text) from public, anon;
grant execute on function public.pa_notion_database_hidden(uuid, text) to authenticated;
do $svc$
declare f text;
begin
  foreach f in array array['public.user_project_rank(uuid,uuid,text)', 'public.user_can_see_task(uuid,uuid)',
                           'public.user_can_see_project(uuid,uuid)', 'public.user_visible_task_ids(uuid,uuid[])',
                           'public.closed_project_ids(uuid)', 'public.project_is_open(uuid,text)',
                           'public.user_notion_database_hidden(uuid,uuid,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  begin
    foreach f in array array['public.user_project_rank(uuid,uuid,text)', 'public.user_can_see_task(uuid,uuid)',
                             'public.user_can_see_project(uuid,uuid)', 'public.user_visible_task_ids(uuid,uuid[])',
                             'public.closed_project_ids(uuid)', 'public.project_is_open(uuid,text)',
                             'public.user_notion_database_hidden(uuid,uuid,text)'] loop
      execute format('grant execute on function %s to service_role', f);
    end loop;
  exception when undefined_object then null;
  end;
end $svc$;

-- 2k. the touch (every open app reloads through its workspaces UPDATE handler)
create or replace function public.pa_touch(p_ws uuid)
returns void language plpgsql security definer set search_path = public as $$
declare prev text := coalesce(current_setting('kanbo.pa_write', true), '');
begin
  if p_ws is null then return; end if;
  perform set_config('kanbo.pa_write', 'on', true);
  -- (now() is the transaction's: a second touch in it changes nothing)
  update public.workspaces set project_access_changed_at = now()
   where id = p_ws and project_access_changed_at is distinct from now();
  perform set_config('kanbo.pa_write', prev, true);
end; $$;

-- 2l. what an outbox event is about (0046:929-1047 task / comment+task / project, 0047:1207-1224
-- approval+task, 0048:925-952 kudos+task, 0054:426-437 status_update+project), in that order:
--   task.*            {task: <row>}                                 → task.project_id
--   comment.created   {comment, task: {id, title, project_id, …}}    → task.project_id
--   project.*         {project: <row>}                              → project.id
--   status_update.*   {status_update: <row>, project: {id, …}|null}  → project.id, else status_update.project_id
--   approval.*        {approval, reviewers, task: {…, project_id}}   → task.project_id
--   kudos.given       {kudos, task: {…, project_id}}                → task.project_id
--   member.joined, ping                                              → null (no project)
create or replace function public.pa_webhook_project(p_event text, p_payload jsonb)
returns text language sql security definer stable set search_path = public as $$
  select coalesce(
    p_payload #>> '{task,project_id}',
    p_payload #>> '{project,id}',
    p_payload #>> '{status_update,project_id}',
    (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(p_payload #>> '{comment,task_id}')),
    (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(p_payload #>> '{approval,task_id}')),
    (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(p_payload #>> '{kudos,task_id}')));
$$;

-- 2m. a held notice for someone who can't see what it's about. notify_queue rows (0048): a task's
-- (task_id); the morning due list ('due', payload.due.tasks[].id; rendered from that list when it
-- goes out); a project update's ('update', payload.about.projects[]). Answers the payload to keep
-- (the due list without what they can't see), or null: drop it.
create or replace function public.pa_task_hidden_for(p_user uuid, p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.tasks t
                  where t.id = p_task and t.workspace_id is not null and public.pa_on(t.workspace_id)
                    and public.pa_rank_for(p_user, t.workspace_id, t.project_id) < 1);
$$;
create or replace function public.pa_notice_payload(p_user uuid, p_payload jsonb)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare p jsonb := coalesce(p_payload, '{}'::jsonb); kept jsonb;
begin
  if jsonb_typeof(p #> '{due,tasks}') = 'array' and jsonb_array_length(p #> '{due,tasks}') > 0 then
    select coalesce(jsonb_agg(e order by i), '[]'::jsonb) into kept
      from jsonb_array_elements(p #> '{due,tasks}') with ordinality a(e, i)
     where not public.pa_task_hidden_for(p_user, public.kanbo_uuid(e ->> 'id'));
    if jsonb_array_length(kept) = 0 then return null; end if;
    -- (its "…and N more" counted tasks behind the held ones it no longer knows: some may be hidden now too)
    if jsonb_array_length(kept) <> jsonb_array_length(p #> '{due,tasks}') then
      p := jsonb_set(p, '{due,tasks}', kept);
      if p #> '{due,more}' is not null then p := jsonb_set(p, '{due,more}', '0'::jsonb); end if;
    end if;
  end if;
  if jsonb_typeof(p #> '{about,projects}') = 'array' and exists (
       select 1 from jsonb_array_elements_text(p #> '{about,projects}') x
         join public.projects pr on pr.id = public.kanbo_uuid(x)
        where pr.workspace_id is not null and public.pa_on(pr.workspace_id)
          and public.pa_rank_for(p_user, pr.workspace_id, pr.id::text) < 1) then
    return null;
  end if;
  return p;
end; $$;

-- (internal) the endpoints in p_ws (just p_webhook, if given) whose viewer (who set the address, else
-- who added it) is no longer an owner, admin or member there: switched off, as the dispatcher does when
-- it finds the same, and what's waiting for them failed. Answers how many. (Switch on: otherwise its
-- project events would silently stop while member.joined still went to the address they set.)
create or replace function public.pa_webhooks_viewer_gone(p_ws uuid, p_webhook uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  if p_ws is null then return 0; end if;
  select coalesce(array_agg(w.id), '{}') into ids from public.webhooks w
   where w.active and w.workspace_id = p_ws and (p_webhook is null or w.id = p_webhook)
     and public.user_ws_role(coalesce(w.url_set_by, w.created_by), p_ws) not in ('owner', 'admin', 'member');
  if cardinality(ids) = 0 then return 0; end if;
  update public.webhooks
     set active = false, disabled_at = now(), updated_at = now(),
         disabled_reason = 'Switched off: the person who set its address no longer has access'
   where id = any (ids) and active;
  update public.webhook_deliveries
     set state = 'failed', next_attempt_at = null, lease_until = null, updated_at = now(),
         error = 'Not sent: the person who set this endpoint''s address no longer has access, so it was switched off.'
   where webhook_id = any (ids) and state = 'pending';
  return cardinality(ids);
end; $$;

-- (internal) Is the caller shown this endpoint's full address (webhook_json, to someone who manages it)?
-- With the switch on, a team endpoint's only to its viewer (who set the address, else who added it: what
-- it hears is what they can see) and the workspace's owner (who sees everything). Another admin who
-- manages it is shown it masked, as everyone else is: a catch-hook address is often the receiver's only
-- credential, and this one may hear of Private projects they're not on. They still change, switch off,
-- delete or re-point it (re-pointed, it's theirs: D19). Personal endpoints, and the switch off: everyone
-- who manages it, as before.
create or replace function public.pa_webhook_url_shown(w public.webhooks)
returns boolean language sql security definer stable set search_path = public as $$
  select w.workspace_id is null or not public.pa_on(w.workspace_id)
      or coalesce(w.url_set_by, w.created_by) = auth.uid()
      or public.ws_role(w.workspace_id) = 'owner';
$$;
-- (internal) Is p_url this endpoint's address as webhook_json showed it masked? Then a change sent with it
-- (the app's edit form, an API client's GET then PATCH) leaves the address as it is. (No address is its
-- own masked form: that always ends '/…' or '/…' and the last 4 characters of a longer path.)
create or replace function public.pa_webhook_url_kept(w public.webhooks, p_url text)
returns boolean language sql immutable set search_path = public as $$
  select p_url is not null and w.url is not null and btrim(p_url) = public.webhook_url_masked(w.url) and btrim(p_url) <> w.url;
$$;

-- 2n. held notices and pending webhooks when access narrows (a project, or a whole workspace when
-- p_project is null): what's waiting for someone who can't see it any more never goes. Only behind
-- the switch: while it's off everything goes as it did before this file. (A task's project_id, and the
-- one an event names, are free text: compared as uuids, so one written in capitals is the same project.)
create or replace function public.pa_flush_held(p_ws uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; np jsonb;
begin
  if p_ws is null or not public.pa_on(p_ws) then return; end if;
  if to_regclass('public.notify_queue') is not null then
    delete from public.notify_queue q
     where q.sent_at is null and q.task_id is not null
       and exists (select 1 from public.tasks t where t.id = q.task_id and t.workspace_id = p_ws
                    and (p_project is null or public.kanbo_uuid(t.project_id) = p_project))
       and public.pa_task_hidden_for(q.user_id, q.task_id);
    for r in select q.id, q.user_id, q.payload from public.notify_queue q
              where q.sent_at is null and q.task_id is null
                and (q.payload ? 'due' or q.payload ? 'about') loop
      np := public.pa_notice_payload(r.user_id, r.payload);
      if np is null then delete from public.notify_queue where id = r.id;
      elsif np is distinct from r.payload then update public.notify_queue set payload = np where id = r.id;
      end if;
    end loop;
  end if;
  -- (a viewer who's gone switches their endpoints off first: what's waiting for them says why)
  if p_project is null then perform public.pa_webhooks_viewer_gone(p_ws, null); end if;
  update public.webhook_deliveries d
     set state = 'failed', error = 'not sent: no longer visible', lease_until = null, next_attempt_at = null, updated_at = now()
    from public.webhooks w, public.webhook_outbox o
   where d.state = 'pending' and d.event <> 'ping' and w.id = d.webhook_id and o.id = d.outbox_id
     and w.workspace_id = p_ws
     and public.pa_webhook_project(o.event, o.payload) is not null
     and (p_project is null or public.kanbo_uuid(public.pa_webhook_project(o.event, o.payload)) = p_project)
     and public.pa_rank_or_binned(coalesce(w.url_set_by, w.created_by), p_ws, public.pa_webhook_project(o.event, o.payload)) < 1;
end; $$;

-- 2o. where tasks back from the bin go when their project has gone (restore_from_trash): somewhere
-- with the audience they had. 0047 takes the workspace's first project of any kind, so a
-- task could vanish into a Private project (and its note name it), or a Private project's work land
-- where everyone reads it. From a Whole workspace project: the workspace's first Whole workspace
-- project (switched off, 0047's own way). From a Members only or Private one, whatever the switch
-- says: nowhere but that project ('restore its project first', or, deleted for good, 'its project
-- was deleted for good'; otherwise, restored in the off window, it would be open to everyone once the
-- switch is back on). A project that has moved out of the workspace (1h) has gone from it too ('its
-- project left this workspace'). Someone on the task who can't see where it lands drops off it (an
-- assignee: its owner takes it, as D10's server writes; someone suspended keeps their place, judged by
-- the projects they'll see again, as trg_tasks_pa judges them).
-- Answers {snapshot, note} with the snapshot's tasks moved, or null (nothing moves: 0047's own way).
create or replace function public.pa_restore_landing(p_ws uuid, p_snap jsonb, p_project text, p_access jsonb)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  src jsonb := case when jsonb_typeof(p_snap -> 'tasks') = 'array' then p_snap -> 'tasks' else '[]'::jsonb end;
  out_t jsonb := '[]'::jsonb;
  x jsonb;
  pid text;
  land_id uuid;
  land_name text;
  land_owner uuid;
  who uuid;
  k text;
  on_ boolean := p_ws is not null and public.pa_on(p_ws);
  left_ws boolean;
  moved_out boolean := false;
begin
  if p_ws is null then return null; end if;
  for x in select e from jsonb_array_elements(src) e loop
    pid := x ->> 'project_id';
    -- (gone from this workspace: deleted, or moved to Personal or another workspace (1h). 0047 asks only
    -- whether it's anywhere, and would put work back here under a project that has left)
    if public.kanbo_uuid(pid) is not null and public.kanbo_uuid(x ->> 'workspace_id') = p_ws
       and not exists (select 1 from public.projects p where p.id = public.kanbo_uuid(pid) and p.workspace_id = p_ws) then
      left_ws := exists (select 1 from public.projects p where p.id = public.kanbo_uuid(pid));
      -- (switched off too, the rollback window: 0047 would put it in the workspace's first project, where
      -- everyone reads it once the switch is back on)
      if public.pa_gone_visibility(p_ws, pid, case when pid = p_project then p_access end) <> 'workspace' then
        if exists (select 1 from public.trash b where b.item_id = public.kanbo_uuid(pid) and b.workspace_id = p_ws
                                                  and b.kind = 'project' and b.restored_at is null) then
          raise exception 'restore its project first' using hint = 'It was in a Members only or Private project, and comes back with it.';
        end if;
        if left_ws then
          raise exception 'its project left this workspace' using hint = 'It was in a Members only or Private project that has moved out of this workspace, so it can''t come back here on its own.';
        end if;
        raise exception 'its project was deleted for good' using hint = 'It was in a Members only or Private project, so it can''t come back on its own.';
      end if;
      if not on_ then continue; end if;          -- (switched off: a Whole workspace project's work goes 0047's way)
      if left_ws then moved_out := true; end if;
      if land_id is null then
        select p.id, p.name, coalesce(p.owner_id, w.owner_id) into land_id, land_name, land_owner
          from public.projects p join public.workspaces w on w.id = p.workspace_id
         where p.workspace_id = p_ws and p.visibility = 'workspace'
         order by (p.archived_at is not null), p.created_at, p.id limit 1;
        if land_id is null then
          raise exception 'no project to restore into' using hint = 'Make a Whole workspace project first.';
        end if;
      end if;
      x := x || jsonb_build_object('project_id', land_id::text, 'section_id', null);
      who := public.kanbo_uuid(x ->> 'assignee_id');
      if who is not null and coalesce(public.pa_assignee_rank(who, p_ws, land_id::text), 0) < 1 then
        x := x || jsonb_build_object('assignee_id', land_owner::text);
      end if;
      foreach k in array array['collaborators', 'followers'] loop
        if jsonb_typeof(x -> k) = 'array' then
          x := jsonb_set(x, array[k], coalesce((
            select jsonb_agg(c order by i) from jsonb_array_elements_text(x -> k) with ordinality a(c, i)
             where public.kanbo_uuid(c) is null or coalesce(public.pa_assignee_rank(public.kanbo_uuid(c), p_ws, land_id::text), 0) >= 1), '[]'::jsonb));
        end if;
      end loop;
    end if;
    out_t := out_t || jsonb_build_array(x);
  end loop;
  if land_id is null then return null; end if;
  return jsonb_build_object('snapshot', jsonb_set(p_snap, '{tasks}', out_t),
                            'note', case when moved_out then 'Its project has left this workspace, so it''s back in “' || land_name || '”.'
                                         else 'Its project was deleted, so it''s back in “' || land_name || '”.' end);
end; $$;

-- 2p. someone who's left a workspace (their row deleted, or given to another account) takes nothing
-- of it with them: the team projects they own there go to the workspace's owner (who
-- sees everything anyway), and they drop out of what the bin and the history captured of its
-- projects' access (each captured owner becomes the workspace's owner too, in a binned project's own
-- snapshot as well). Otherwise, invited back (as a guest for one other project, say), they'd own
-- every project they had made, Private ones included, with everything added since (a guest who owns
-- a project keeps it, D16), and a restore from the bin would put them back on what they were on.
-- Whatever the switch says: ownership is the switch-on rule's, and the switch can go on later.
-- Only once they're out of it (another active row of theirs there keeps everything), and never while
-- the workspace itself is closing. Answers how many projects changed hands.
create or replace function public.pa_access_without(p_access jsonb, p_user uuid, p_heir uuid)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case when p_access is null or jsonb_typeof(p_access) <> 'object' or p_user is null then p_access else
    p_access
    || case when jsonb_typeof(p_access -> 'members') = 'array' then jsonb_build_object('members', coalesce((
         select jsonb_agg(e order by i) from jsonb_array_elements(p_access -> 'members') with ordinality a(e, i)
          where e ->> 0 is distinct from p_user::text), '[]'::jsonb)) else '{}'::jsonb end
    || case when p_access ->> 'owner' = p_user::text then jsonb_build_object('owner', p_heir) else '{}'::jsonb end end;
$$;
-- (a binned project's own row, as 0047 put it in the bin: who owns it, and its contributors before 0058)
create or replace function public.pa_snapshot_without(p_snap jsonb, p_user uuid, p_heir uuid)
returns jsonb language sql immutable set search_path = pg_catalog as $$
  select case when jsonb_typeof(p_snap -> 'project') <> 'object' or p_user is null then p_snap else
    jsonb_set(p_snap, '{project}', (p_snap -> 'project')
      || case when p_snap #>> '{project,owner_id}' = p_user::text then jsonb_build_object('owner_id', p_heir) else '{}'::jsonb end
      || case when jsonb_typeof(p_snap #> '{project,contributor_ids}') = 'array' then jsonb_build_object('contributor_ids', coalesce((
           select jsonb_agg(c order by i) from jsonb_array_elements(p_snap #> '{project,contributor_ids}') with ordinality a(c, i)
            where c #>> '{}' is distinct from p_user::text), '[]'::jsonb)) else '{}'::jsonb end) end;
$$;
create or replace function public.pa_forget_member(p_ws uuid, p_user uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  heir uuid;
  uid text := p_user::text;
  probe jsonb := jsonb_build_object('members', jsonb_build_array(jsonb_build_array(p_user::text)));
  n integer := 0;
begin
  if p_ws is null or p_user is null or public.pa_ws_member_role(p_user, p_ws) <> 'none' then return 0; end if;
  select w.owner_id into heir from public.workspaces w where w.id = p_ws;
  if not found then return 0; end if;                      -- (the workspace closing: its projects go with it)
  update public.projects set owner_id = heir where workspace_id = p_ws and owner_id = p_user;
  get diagnostics n = row_count;
  update public.trash x
     set access = public.pa_access_without(x.access, p_user, heir),
         snapshot = case when x.kind = 'project' then public.pa_snapshot_without(x.snapshot, p_user, heir) else x.snapshot end
   where x.workspace_id = p_ws
     and (x.access ->> 'owner' = uid or x.access @> probe
          or (x.kind = 'project' and (x.snapshot #>> '{project,owner_id}' = uid or (x.snapshot #> '{project,contributor_ids}') ? uid)));
  update public.project_ids_retired g set access = public.pa_access_without(g.access, p_user, heir)
   where g.workspace_id = p_ws and (g.access ->> 'owner' = uid or g.access @> probe);
  update public.project_departures d set access = public.pa_access_without(d.access, p_user, heir)
   where d.workspace_id = p_ws and (d.access ->> 'owner' = uid or d.access @> probe);
  update public.notion_pages_retired x set access = public.pa_access_without(x.access, p_user, heir)
   where x.workspace_id = p_ws and (x.access ->> 'owner' = uid or x.access @> probe);
  update public.audit_events e set access = public.pa_access_without(e.access, p_user, heir)
   where e.workspace_id = p_ws and e.project_id is not null and e.access is not null
     and (e.access ->> 'owner' = uid or e.access @> probe);
  return n;
end; $$;
-- (every run of this file: whoever has already left a workspace, before 0058 or while its undo file
-- had the triggers out; nothing on a later run unless someone left meanwhile)
create or replace function public.pa_forget_departed()
returns integer language plpgsql security definer set search_path = public as $$
declare r record; n integer := 0;
begin
  for r in
    select distinct x.ws, x.uid from (
      select p.workspace_id as ws, p.owner_id as uid from public.projects p where p.workspace_id is not null and p.owner_id is not null
      union select t.workspace_id, public.kanbo_uuid(t.access ->> 'owner') from public.trash t where t.workspace_id is not null and t.access is not null
      union select t.workspace_id, public.kanbo_uuid(e ->> 0) from public.trash t
              cross join lateral jsonb_array_elements(case when jsonb_typeof(t.access -> 'members') = 'array' then t.access -> 'members' else '[]'::jsonb end) e
             where t.workspace_id is not null
      union select t.workspace_id, public.kanbo_uuid(t.snapshot #>> '{project,owner_id}') from public.trash t
             where t.workspace_id is not null and t.kind = 'project'
      union select t.workspace_id, public.kanbo_uuid(c #>> '{}') from public.trash t
              cross join lateral jsonb_array_elements(case when jsonb_typeof(t.snapshot #> '{project,contributor_ids}') = 'array'
                                                           then t.snapshot #> '{project,contributor_ids}' else '[]'::jsonb end) c
             where t.workspace_id is not null and t.kind = 'project'
      union select g.workspace_id, public.kanbo_uuid(g.access ->> 'owner') from public.project_ids_retired g
      union select g.workspace_id, public.kanbo_uuid(e ->> 0) from public.project_ids_retired g
              cross join lateral jsonb_array_elements(case when jsonb_typeof(g.access -> 'members') = 'array' then g.access -> 'members' else '[]'::jsonb end) e
      union select d.workspace_id, public.kanbo_uuid(d.access ->> 'owner') from public.project_departures d
      union select d.workspace_id, public.kanbo_uuid(e ->> 0) from public.project_departures d
              cross join lateral jsonb_array_elements(case when jsonb_typeof(d.access -> 'members') = 'array' then d.access -> 'members' else '[]'::jsonb end) e
      union select x.workspace_id, public.kanbo_uuid(x.access ->> 'owner') from public.notion_pages_retired x
      union select x.workspace_id, public.kanbo_uuid(e ->> 0) from public.notion_pages_retired x
              cross join lateral jsonb_array_elements(case when jsonb_typeof(x.access -> 'members') = 'array' then x.access -> 'members' else '[]'::jsonb end) e
      union select a.workspace_id, public.kanbo_uuid(a.access ->> 'owner') from public.audit_events a
             where a.workspace_id is not null and a.project_id is not null and a.access is not null
      union select a.workspace_id, public.kanbo_uuid(e ->> 0) from public.audit_events a
              cross join lateral jsonb_array_elements(case when jsonb_typeof(a.access -> 'members') = 'array' then a.access -> 'members' else '[]'::jsonb end) e
             where a.workspace_id is not null and a.project_id is not null and a.access is not null) x
     where x.ws is not null and x.uid is not null and public.pa_ws_member_role(x.uid, x.ws) = 'none'
  loop
    n := n + public.pa_forget_member(r.ws, r.uid);
  end loop;
  return n;
end; $$;

-- 2q. what a bin row's summary may name (0047's trash_capture_task looks its project and its parent
-- up by id alone): its project only when that's a project of the row's own workspace (Personal: one
-- of its owner's own), its parent only when that's a task of the same workspace (Personal: its owner's
-- own) and, with the switch on, of the same project. Otherwise a task of your own whose project_id or
-- parent_id names someone else's work (a Private project's id read off a goal, a task's id off a
-- dependency) would put that project's name, or that task's current title, in your bin. p_strict: a
-- parent that's no longer a live task (nor binned from the same project) goes too (switching on).
create or replace function public.pa_summary_scoped(p_kind text, p_ws uuid, p_user uuid, p_project text, p_summary jsonb, p_strict boolean)
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare
  s jsonb := p_summary;
  par record;
begin
  if p_kind is distinct from 'task' or jsonb_typeof(s) is distinct from 'object' then return s; end if;
  if jsonb_typeof(s -> 'project') = 'object' and exists (
       select 1 from public.projects p
        where p.id = public.kanbo_uuid(s #>> '{project,id}')
          and case when p_ws is null then p.workspace_id is not null or p.user_id is distinct from p_user
                   else p.workspace_id is distinct from p_ws end) then
    s := s - 'project';
  end if;
  if jsonb_typeof(s -> 'parent') = 'object' then
    select t.workspace_id, t.user_id, t.project_id into par from public.tasks t where t.id = public.kanbo_uuid(s #>> '{parent,id}');
    if found then
      if (case when p_ws is null then par.workspace_id is not null or par.user_id is distinct from p_user
               else par.workspace_id is distinct from p_ws or (public.pa_on(p_ws) and par.project_id is distinct from p_project) end) then
        s := s - 'parent';
      end if;
    elsif coalesce(p_strict, false) and not exists (
        select 1 from public.trash b
         where b.item_id = public.kanbo_uuid(s #>> '{parent,id}') and b.kind = 'task'
           and b.workspace_id is not distinct from p_ws and b.project_id is not distinct from p_project) then
      s := s - 'parent';
    end if;
  end if;
  return s;
end; $$;
-- (bin rows already written: every run of this file (p_ws null), and switching a workspace on (strict:
-- a sub-task binned while it was off keeps its parent's title only if it's the same project's). Answers
-- how many changed.)
create or replace function public.pa_scrub_bin(p_ws uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  update public.trash x set summary = s.v
    from (select y.id, public.pa_summary_scoped(y.kind, y.workspace_id, y.user_id, y.project_id, y.summary, p_ws is not null) as v
            from public.trash y
           where y.kind = 'task' and y.restored_at is null and (p_ws is null or y.workspace_id = p_ws)
             and (jsonb_typeof(y.summary -> 'parent') = 'object' or jsonb_typeof(y.summary -> 'project') = 'object')) s
   where x.id = s.id and x.summary is distinct from s.v;
  get diagnostics n = row_count;
  return n;
end; $$;

-- 2r. a bin entry binned while the switch was off (or before this file) may hold sub-tasks of another
-- project than its own: 0047 takes a deleted task's (or project's) every descendant, whatever its
-- project (with the switch on, pa_trg_tasks_delete frees them first: D11). Switched on, people who can't
-- see such a sub-task would read its counts and history line, restore it into its project, or (owners
-- and admins) delete it for good. So switching on splits each one off, with its own sub-tasks of the
-- same project and what hangs off them, into a bin entry of its own, as if it had been freed before the
-- delete: in its own project, with that project's access (the capture trigger records it), the same
-- delete time, deleter and expiry, its ids reserved under it, standing on its own (no parent). What's
-- left is the entry's own project's work, and its counts and history line count only that. Each new
-- entry gets the history line its delete would have written, so it's read (and later purged) under
-- its own project. A Personal task, or another workspace's, under one stays where it is. Answers how
-- many entries it made. (pa_snap_part: a snapshot's rows that belong to these tasks)
create or replace function public.pa_snap_part(p_snap jsonb, p_ids uuid[])
returns jsonb language sql immutable set search_path = public as $$
  with el(k, e, n) as (
    select k.k, a.e, a.n
      from unnest(array['tasks', 'checklist', 'dependencies', 'comments', 'attachments', 'task_events', 'task_user_state',
                        'notion_links', 'notion_link_state', 'approvals', 'approval_reviewers']) k(k)
      cross join lateral jsonb_array_elements(case when jsonb_typeof(p_snap -> k.k) = 'array' then p_snap -> k.k else '[]'::jsonb end)
        with ordinality a(e, n)),
  links as (select public.kanbo_uuid(el.e ->> 'id') as id from el
             where el.k = 'notion_links' and public.kanbo_uuid(el.e ->> 'task_id') = any (p_ids)),
  appr as (select public.kanbo_uuid(el.e ->> 'id') as id from el
            where el.k = 'approvals' and public.kanbo_uuid(el.e ->> 'task_id') = any (p_ids))
  select jsonb_object_agg(k.k, coalesce((
           select jsonb_agg(el.e order by el.n) from el
            where el.k = k.k and case k.k
              when 'tasks' then public.kanbo_uuid(el.e ->> 'id') = any (p_ids)
              when 'dependencies' then public.kanbo_uuid(el.e ->> 'task_id') = any (p_ids)
                                    or public.kanbo_uuid(el.e ->> 'depends_on') = any (p_ids)
              when 'notion_link_state' then public.kanbo_uuid(el.e ->> 'link_id') in (select links.id from links)
              when 'approval_reviewers' then public.kanbo_uuid(el.e ->> 'approval_id') in (select appr.id from appr)
              else public.kanbo_uuid(el.e ->> 'task_id') = any (p_ids) end), '[]'::jsonb))
    from unnest(array['tasks', 'checklist', 'dependencies', 'comments', 'attachments', 'task_events', 'task_user_state',
                      'notion_links', 'notion_link_state', 'approvals', 'approval_reviewers']) k(k);
$$;
create or replace function public.pa_split_bin(p_ws uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  r     record;
  snap  jsonb;
  home  text;
  grp   jsonb;      -- task id → the top of its run of same-project ancestors in the snapshot
  roots uuid[];     -- the tops that go to entries of their own
  cut   uuid[];     -- tasks that stand on their own now
  sr    uuid;
  ids   uuid[];
  part  jsonb;
  root  jsonb;
  cnt   jsonb;
  tid   uuid;
  n     integer := 0;
begin
  if p_ws is null then return 0; end if;
  for r in
    select x.* from public.trash x
     where x.workspace_id = p_ws and x.restored_at is null and x.kind in ('task', 'project')
       and exists (select 1 from jsonb_array_elements(case when jsonb_typeof(x.snapshot -> 'tasks') = 'array'
                                                           then x.snapshot -> 'tasks' else '[]'::jsonb end) e
                    where public.kanbo_uuid(e ->> 'workspace_id') = p_ws
                      and coalesce(public.kanbo_uuid(e ->> 'project_id')::text, e ->> 'project_id')
                          is distinct from coalesce(public.kanbo_uuid(x.project_id)::text, x.project_id))
     order by x.deleted_at, x.id
     for update
  loop
    snap := r.snapshot;
    home := coalesce(public.kanbo_uuid(r.project_id)::text, r.project_id);
    with recursive t as (
      select public.kanbo_uuid(e ->> 'id') as id, public.kanbo_uuid(e ->> 'parent_id') as parent,
             coalesce(public.kanbo_uuid(e ->> 'project_id')::text, e ->> 'project_id') as proj,
             public.kanbo_uuid(e ->> 'workspace_id') as ws, a.n
        from jsonb_array_elements(snap -> 'tasks') with ordinality a(e, n)),
    g(id, root) as (
      select c.id, c.id from t c
       where not exists (select 1 from t p where p.id = c.parent and p.proj is not distinct from c.proj and p.ws is not distinct from c.ws)
      union
      select c.id, g.root from g
        join t c on c.parent = g.id
        join t p on p.id = g.id and p.proj is not distinct from c.proj and p.ws is not distinct from c.ws),
    s as (select g.root from g join t on t.id = g.root
           where t.ws = p_ws and t.proj is distinct from home group by g.root)
    select coalesce((select jsonb_object_agg(g.id::text, g.root::text) from g), '{}'::jsonb),
           coalesce((select array_agg(s.root order by t.n) from s join t on t.id = s.root), '{}'::uuid[]),
           coalesce((select array_agg(c.id) from t c
                       join g gc on gc.id = c.id and gc.root = c.id
                       join g gp on gp.id = c.parent
                      where gc.root in (select s.root from s) or gp.root in (select s.root from s)), '{}'::uuid[])
      into grp, roots, cut;
    if cardinality(roots) = 0 then continue; end if;
    snap := jsonb_set(snap, '{tasks}', (
      select jsonb_agg(case when public.kanbo_uuid(a.e ->> 'id') = any (cut) then a.e || jsonb_build_object('parent_id', null) else a.e end
                       order by a.n)
        from jsonb_array_elements(snap -> 'tasks') with ordinality a(e, n)));
    foreach sr in array roots loop
      ids := array(select k::uuid from jsonb_each_text(grp) a(k, v) where v = sr::text);
      part := jsonb_build_object('v', 1) || public.pa_snap_part(snap, ids);
      select e into root from jsonb_array_elements(snap -> 'tasks') e where public.kanbo_uuid(e ->> 'id') = sr;
      cnt := public.trash_counts(part);
      insert into public.trash (kind, item_id, workspace_id, user_id, project_id, title, summary, snapshot,
                                deleted_by, deleted_by_name, deleted_at, purge_after)
      values ('task', sr, p_ws,
              coalesce((select u.id from auth.users u where u.id = public.kanbo_uuid(root ->> 'user_id')), r.user_id),
              root ->> 'project_id', left(coalesce(root ->> 'title', ''), 500),
              jsonb_build_object(
                'project', (select jsonb_build_object('id', p.id, 'name', p.name, 'emoji', p.emoji, 'color', p.color)
                              from public.projects p where p.id = public.kanbo_uuid(root ->> 'project_id') and p.workspace_id = p_ws),
                'status', root -> 'status', 'priority', root -> 'priority', 'due_date', root -> 'due_date',
                'assignee_id', root -> 'assignee_id', 'archived', (root ->> 'archived_at') is not null,
                'counts', cnt || jsonb_build_object('subtasks', greatest((cnt ->> 'tasks')::integer - 1, 0))),
              part, r.deleted_by, r.deleted_by_name, r.deleted_at, r.purge_after)
      returning id into tid;
      update public.trash_ids set trash_id = tid
       where trash_id = r.id
         and id in (select public.kanbo_uuid(e ->> 'id')
                      from unnest(array['tasks', 'checklist', 'comments', 'attachments']) k(k)
                      cross join lateral jsonb_array_elements(part -> k.k) e);
      insert into public.audit_events (workspace_id, actor_id, actor_name, action, target_kind, target_id, target_title, detail, created_at)
      values (p_ws, r.deleted_by, left(coalesce(r.deleted_by_name, 'Kanbo'), 200), 'task.deleted', 'task', sr::text,
              left(coalesce(root ->> 'title', ''), 500),
              jsonb_build_object('trash_id', tid, 'subtasks', greatest((cnt ->> 'tasks')::integer - 1, 0), 'project_id', root ->> 'project_id'),
              r.deleted_at);
      n := n + 1;
    end loop;
    snap := snap || public.pa_snap_part(snap, array(
      select public.kanbo_uuid(e ->> 'id') from jsonb_array_elements(snap -> 'tasks') e
       where not (coalesce(grp ->> (public.kanbo_uuid(e ->> 'id')::text), '') = any (roots::text[]))));
    cnt := public.trash_counts(snap);
    update public.trash
       set snapshot = snap,
           summary = jsonb_set(summary, '{counts}', case when r.kind = 'task'
                       then cnt || jsonb_build_object('subtasks', greatest((cnt ->> 'tasks')::integer - 1, 0)) else cnt end)
     where id = r.id;
    update public.audit_events e
       set detail = e.detail || case when r.kind = 'task'
                                     then jsonb_build_object('subtasks', greatest((cnt ->> 'tasks')::integer - 1, 0))
                                     else jsonb_build_object('tasks', (cnt ->> 'tasks')::integer) end
     where e.workspace_id = p_ws and e.action = r.kind || '.deleted' and e.target_id = r.item_id::text
       and e.detail ->> 'trash_id' = r.id::text;
  end loop;
  return n;
end; $$;

-- 2s. Kanbo's ranking reasons left on a workspace's task rows (tasks.ai_reason): the app before this
-- release wrote each one there, worked out from a batch of its writer's tasks, so it can name a task in
-- a project that someone reading the row (who joins later, say, or is handed the task) must not see. The
-- reason is its assignee's own, and the app keeps it in their plan (0043's task_user_state, which it
-- mirrored there too): switching on clears the rows' (not copied into anyone's plan: the row doesn't say
-- whose it was, and a task handed on keeps its last assignee's). It counts as an edit of those tasks
-- (0046 moves their updated_at), so a Notion sync looks at each once more and finds nothing new. With
-- the switch on, no row takes one again (pa_trg_tasks). Answers how many.
create or replace function public.pa_clear_reasons(p_ws uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  if p_ws is null then return 0; end if;
  update public.tasks set ai_reason = null where workspace_id = p_ws and ai_reason is not null;
  get diagnostics n = row_count;
  return n;
end; $$;

-- 2t. Notion is for Whole workspace projects while the switch is on (the containment rule). No Members
-- only or Private project has a Notion sync, nor a task with a Notion link of any kind (one someone
-- added, a sync's, an import's), whoever writes it and however it'd get there: a new sync or a sync
-- re-pointed (notion_save_sync, the bin putting one back), a link added (notion_link_page, the notion
-- function's imports and syncs, the bin putting one back), a linked task moved in (on its own, as a
-- parent's sub-task, by the app, the API, MCP, the planner, a template or pack), a project with any of
-- those made Members only or Private (or made new as one under an id linked tasks already name, or
-- moved in as one; a task's project id counts in any spelling), or the switch turned on while one has
-- them (each refused with a sentence for the app: trg_notion_links_pa_closed, trg_tasks_pa_notion,
-- trg_notion_syncs_pa, trg_projects_pa_notion, trg_workspaces_pa_guard; a client's new project under
-- an id that work here names: trg_projects_pa_guard's 'id in use'). The page and database closure above (2j:
-- pa_notion_page_hidden, user_notion_database_hidden, notion_pages_retired) stays, for what's older
-- than this rule (the undo window, a workspace switched on before it). Switch off: nothing changes.
-- The syncs and links it counts are the workspace's own (each row names its workspace). A task or a
-- project moved here from another workspace leaves its links and syncs recorded there (notion_links_guard
-- fires only on writes to the link; nothing moves a sync): they're that workspace's, read and removed
-- there, and dead to what moved (a sync stops at a project that isn't in its workspace, projectGone, and
-- reads and writes only its own workspace's tasks), so every check here passes them by, the switch-on
-- list included, rather than refuse what nobody here can see or remove. Should what moved go back,
-- they're counted there again. (The bin bringing such a link back to a task here would make it this
-- workspace's: into a Members only or Private project, it's left out instead: pa_trg_notion_links_closed.)
-- (kanbo.notion_contain = 'off' lifts it for the SQL editor, as kanbo.restoring does the bin's checks:
-- no client sets a setting. The test suite builds the older states that way.)
create or replace function public.pa_notion_contain()
returns boolean language sql stable set search_path = pg_catalog as $$
  select coalesce(current_setting('kanbo.notion_contain', true), '') <> 'off';
$$;
-- Is this project (as a task stores it) Members only or Private here? A live one by its visibility; one
-- in the bin, deleted for good or gone from the workspace by the access it had here (pa_rank_for's rule).
create or replace function public.pa_project_closed(p_ws uuid, p_project text)
returns boolean language sql security definer stable set search_path = public as $$
  select p_ws is not null and public.kanbo_uuid(p_project) is not null and coalesce(
    (select p.visibility <> 'workspace' from public.projects p where p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws),
    (select coalesce(a.x ->> 'visibility', 'workspace') <> 'workspace'
       from (select coalesce(
               (select r.access from public.trash r
                 where r.item_id = public.kanbo_uuid(p_project) and r.kind = 'project' and r.workspace_id = p_ws and r.restored_at is null
                 order by r.deleted_at desc limit 1),
               (select g.access from public.project_ids_retired g where g.id = public.kanbo_uuid(p_project) and g.workspace_id = p_ws),
               (select d.access from public.project_departures d where d.id = public.kanbo_uuid(p_project) and d.workspace_id = p_ws)) as x) a
      where a.x is not null),
    false);
$$;
-- Is (p_ws, p_project) a Members only or Private project of a workspace whose switch is on, so nothing of
-- Notion's may come into it? It takes the locks that keep the answer true until the caller's transaction
-- ends: the project's row (FOR SHARE: making it narrower waits, or this waits for that and reads what it
-- made), and, for a closed one, the workspace's (FOR SHARE: the switch going on waits, or this waits).
-- An id no live project here has (loose, in the bin, gone) while the switch is on: the workspace's row
-- first, then the project's again, so a project made or moved in under it now (pa_trg_projects_notion
-- holds that row while it looks for linked tasks) waits for this and finds what it added, or this
-- waits for that and judges the project it made. The caller holds the task's row already (a move), or
-- takes it first (a new link).
create or replace function public.pa_notion_shut(p_ws uuid, p_project text)
returns boolean language plpgsql security definer set search_path = public as $$
declare v text; on_ boolean;
begin
  if p_ws is null or not public.pa_notion_contain() then return false; end if;
  select p.visibility into v from public.projects p
   where p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws for share;
  if not found and public.kanbo_uuid(p_project) is not null and public.pa_on(p_ws) then
    perform 1 from public.workspaces w where w.id = p_ws for share;
    select p.visibility into v from public.projects p
     where p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws for share;
  end if;
  if found then
    if v = 'workspace' then return false; end if;
  elsif not public.pa_project_closed(p_ws, p_project) then
    return false;
  end if;
  select w.project_access into on_ from public.workspaces w where w.id = p_ws for share;
  return coalesce(on_, false);
end; $$;
-- The sentences (the app, the API, MCP and the notion function show them as they are)
create or replace function public.pa_notion_closed_text(p_what text)
returns text language sql immutable set search_path = pg_catalog as $$
  select 'Members only and Private projects don''t connect to Notion yet. ' || case p_what
    when 'move' then 'Remove this task''s Notion page links first, or keep it in a Whole workspace project.'
    when 'move sub-task' then 'One of its sub-tasks has Notion page links: remove them first, or keep it in a Whole workspace project.'
    when 'link' then 'Make this project Whole workspace to link Notion pages to its tasks.'
    when 'sync' then 'Choose a Whole workspace project.'
    when 'restore task' then 'This task has Notion page links: make its project Whole workspace to restore it.'
    when 'restore project' then 'This project has a Notion sync or Notion-linked tasks: the workspace''s owner can turn project access off to restore it.'
    else 'Remove this project''s Notion sync and page links first.' end;
$$;
-- The Members only and Private projects here that still connect to Notion: their syncs, and their tasks
-- with a Notion link (one deleted, in the bin or gone from the workspace counts by the access it had:
-- no name). Switching on is refused while there are any (pa_trg_workspaces_guard). (A task's project id
-- in any spelling is that project's, as every rank reads it: one row a project.) The workspace's own
-- syncs and links, as every check of the rule counts them: one another workspace recorded, left when a
-- task or project moved here, isn't this workspace's to list or remove.
create or replace function public.pa_notion_blockers(p_ws uuid)
returns table (project_id text, name text, visibility text, syncs integer, linked_tasks integer)
language sql security definer stable set search_path = public as $$
  with linked as (
    select lower(t.project_id) as pid, count(*)::int as n
      from public.tasks t
     where t.workspace_id = p_ws and t.project_id is not null
       and exists (select 1 from public.notion_links l where l.task_id = t.id and l.workspace_id = p_ws)
     group by lower(t.project_id)),
  synced as (
    select s.project_id::text as pid, count(*)::int as n
      from public.notion_syncs s join public.projects p on p.id = s.project_id and p.workspace_id = p_ws
     where s.workspace_id = p_ws
     group by s.project_id)
  select k.pid, p.name, p.visibility, coalesce(s.n, 0), coalesce(l.n, 0)
    from (select pid from linked union select pid from synced) k
    left join linked l on l.pid = k.pid
    left join synced s on s.pid = k.pid
    left join public.projects p on p.id = public.kanbo_uuid(k.pid) and p.workspace_id = p_ws
   where p_ws is not null and public.pa_project_closed(p_ws, k.pid)
   order by p.name nulls last, k.pid;
$$;
-- (switching on with any: the sentence names how many and where, and how to clear them)
create or replace function public.pa_notion_refuse_on(p_ws uuid)
returns void language plpgsql security definer set search_path = public as $$
declare b record; names text[] := '{}'; n integer := 0; syncs integer := 0; tasks integer := 0; rest integer; msg text;
begin
  for b in select * from public.pa_notion_blockers(p_ws) loop
    n := n + 1; syncs := syncs + b.syncs; tasks := tasks + b.linked_tasks;
    if b.name is not null and cardinality(names) < 3 then names := names || ('“' || left(b.name, 60) || '”'); end if;
  end loop;
  if n = 0 then return; end if;
  rest := n - cardinality(names);
  msg := case when n = 1 then '1 Members only or Private project still connects' else n || ' Members only or Private projects still connect' end
      || ' to Notion (' || concat_ws(', ',
           case when syncs = 1 then '1 sync' when syncs > 1 then syncs || ' syncs' end,
           case when tasks = 1 then '1 task with Notion links' when tasks > 1 then tasks || ' tasks with Notion links' end) || ')'
      || case when cardinality(names) = 0 then ''
              else ': ' || case when rest > 0 then array_to_string(names, ', ') || ' and ' || rest || ' more'
                                when cardinality(names) = 1 then names[1]
                                else array_to_string(names[1:cardinality(names) - 1], ', ') || ' and ' || names[cardinality(names)] end end
      || '. Members only and Private projects don''t connect to Notion yet: remove '
      || case when n = 1 then 'its' else 'their' end || ' Notion syncs in Settings › Notion and the Notion links on '
      || case when n = 1 then 'its' else 'their' end || ' tasks, or make '
      || case when n = 1 then 'it' else 'them' end || ' Whole workspace, then turn project access on.';
  raise exception 'notion in closed projects' using hint = msg,
    detail = jsonb_build_object('projects', n, 'syncs', syncs, 'linked_tasks', tasks)::text;
end; $$;

do $internal$
declare f text;
begin
  foreach f in array array['public.pa_touch(uuid)', 'public.pa_webhook_project(text,jsonb)', 'public.pa_task_hidden_for(uuid,uuid)',
                           'public.pa_notice_payload(uuid,jsonb)', 'public.pa_flush_held(uuid,uuid)', 'public.pa_webhooks_viewer_gone(uuid,uuid)',
                           'public.pa_restore_landing(uuid,jsonb,text,jsonb)', 'public.pa_access_without(jsonb,uuid,uuid)',
                           'public.pa_snapshot_without(jsonb,uuid,uuid)', 'public.pa_forget_member(uuid,uuid)',
                           'public.pa_forget_departed()', 'public.pa_summary_scoped(text,uuid,uuid,text,jsonb,boolean)',
                           'public.pa_scrub_bin(uuid)', 'public.pa_snap_part(jsonb,uuid[])', 'public.pa_split_bin(uuid)',
                           'public.pa_clear_reasons(uuid)', 'public.pa_notion_contain()', 'public.pa_project_closed(uuid,text)',
                           'public.pa_notion_shut(uuid,text)', 'public.pa_notion_closed_text(text)',
                           'public.pa_notion_blockers(uuid)', 'public.pa_notion_refuse_on(uuid)',
                           'public.pa_webhook_url_shown(public.webhooks)', 'public.pa_webhook_url_kept(public.webhooks,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $internal$;

-- ---------- 3. seeding (the first run only) ----------
-- One row per contributor_ids entry: editor for active owners, admins and members, commenter for
-- guests; never the project's owner (implicit) or anyone who isn't in the workspace any more.
-- contributor_ids itself is left as it is, and the creator isn't added, so who gets 0054's update
-- notices stays as it was.
-- Not on a re-run. After the undo file (not recorded, but project_members kept), contributor_ids was
-- the app's list of a project's people again, with nothing keeping project_members in step: the rows
-- are brought back to it (whoever was taken off, left the workspace or became its owner meanwhile
-- loses their row; a guest's editor row becomes commenter), and the grants of invites claimed
-- meanwhile go (their projects were never given). Whoever was added meanwhile gets a row only on a
-- Whole workspace project: with the rules out, anyone could add themselves to a Members only or
-- Private one's list, so there they're added again in People & access (and nobody could open one up to
-- the whole workspace meanwhile: the undo file keeps visibility as it was). Nobody who was taken off a
-- project comes back.
-- (the undo file's guard, which kept every project's visibility as it was while this file was out,
-- goes: from here on trg_projects_pa_guard decides who changes it; and so do its stand-ins for the bin's
-- capture and purge triggers, which recorded each new bin entry's access, and each project deleted for
-- good, meanwhile: trg_trash_pa_capture and trg_trash_pa_purge do again. Every run.)
drop trigger if exists trg_projects_visibility_kept on public.projects;
drop function if exists public.project_visibility_kept();
drop trigger if exists trg_trash_access_kept on public.trash;
drop function if exists public.trash_access_kept();
drop trigger if exists trg_trash_purge_kept on public.trash;
drop function if exists public.trash_purge_kept();

do $seed$
declare resync boolean;
begin
  if exists (select 1 from public.schema_migrations where version = '0058') then return; end if;
  perform set_config('kanbo.pa_sync', 'on', true);
  resync := exists (select 1 from public.project_members);
  if resync then
    delete from public.project_members m
     using public.projects p
     where p.id = m.project_id
       and (p.workspace_id is null
            or m.user_id = p.owner_id
            or not (m.user_id = any (coalesce(p.contributor_ids, '{}'::uuid[])))
            or public.pa_ws_member_role(m.user_id, p.workspace_id) = 'none');
    update public.project_members m set workspace_id = p.workspace_id, updated_at = now()
      from public.projects p
     where p.id = m.project_id and m.workspace_id is distinct from p.workspace_id;
    update public.project_members m set role = 'commenter', updated_at = now()
     where m.role = 'editor' and public.pa_ws_member_role(m.user_id, m.workspace_id) = 'guest';
    delete from public.project_member_invites i
     where not exists (select 1 from public.workspace_members x where x.id = i.member_id and x.status = 'invited')
        or not exists (select 1 from public.projects p where p.id = i.project_id and p.workspace_id = i.workspace_id);
  end if;
  -- (in contributor_ids' order, which the mirror keeps; anyone suspended or awaiting approval is
  -- still in the workspace and keeps their place, as every trigger below judges it: their row grants
  -- nothing until they can act again, as their place in contributor_ids did)
  insert into public.project_members (project_id, workspace_id, user_id, role, created_at)
  select p.id, p.workspace_id, c.uid,
         case public.pa_ws_member_role(c.uid, p.workspace_id) when 'guest' then 'commenter' else 'editor' end,
         now() + c.n * interval '1 microsecond'
    from public.projects p
    cross join lateral (select a.x as uid, min(a.n) as n from unnest(p.contributor_ids) with ordinality a(x, n)
                         where a.x is not null group by a.x) c
   where p.workspace_id is not null
     and c.uid is distinct from p.owner_id
     and public.pa_ws_member_role(c.uid, p.workspace_id) <> 'none'
     and (not resync or p.visibility = 'workspace')
  on conflict (project_id, user_id) do nothing;
  if resync then
    -- (contributor_ids follows: anyone listed meanwhile on a Members only or Private project drops off it)
    update public.projects p set contributor_ids = coalesce(array(select m.user_id from public.project_members m
                                                                  where m.project_id = p.id order by m.created_at, m.id), '{}')
     where p.workspace_id is not null and p.visibility <> 'workspace'
       and p.contributor_ids is distinct from coalesce(array(select m.user_id from public.project_members m
                                                            where m.project_id = p.id order by m.created_at, m.id), '{}');
  end if;
  perform set_config('kanbo.pa_sync', '', true);
end $seed$;

-- ---------- 4. the functions the app calls ----------
-- Errors (the app matches them): 'not authorized' · 'not found' · 'invalid visibility' ·
-- 'invalid role' · 'invalid grants' · 'not a member of this workspace' · 'notion closed project' (a
-- project with a Notion sync or Notion-linked tasks made Members only or Private, 2t; its hint is the
-- sentence) · 'notion in closed projects' (switching on while one still connects to Notion; the hint
-- names how many and where).

-- The switch and its settings: the workspace's owner only. A null argument keeps what's there.
-- Answers {on, default, member_private, changed_at}.
create or replace function public.set_project_access(p_ws uuid, p_on boolean default null, p_default text default null,
                                                     p_member_private boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  w public.workspaces;
  was_on boolean;
  prev text := coalesce(current_setting('kanbo.pa_write', true), '');
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_ws is null or public.ws_role(p_ws) <> 'owner' then raise exception 'not authorized'; end if;
  if p_default is not null and p_default not in ('workspace', 'members', 'private') then raise exception 'invalid visibility'; end if;
  select * into w from public.workspaces where id = p_ws for update;
  if w.id is null then raise exception 'not authorized'; end if;
  was_on := w.project_access;
  if (coalesce(p_on, w.project_access), coalesce(p_default, w.project_access_default), coalesce(p_member_private, w.project_access_member_private))
     is distinct from (w.project_access, w.project_access_default, w.project_access_member_private) then
    perform set_config('kanbo.pa_write', 'on', true);
    update public.workspaces
       set project_access = coalesce(p_on, project_access),
           project_access_default = coalesce(p_default, project_access_default),
           project_access_member_private = coalesce(p_member_private, project_access_member_private)
     where id = p_ws
    returning * into w;
    perform set_config('kanbo.pa_write', prev, true);
    perform public.pa_touch(p_ws);
    -- (switching on drops what's waiting for people who won't see it: trg_workspaces_pa_after)
    perform public.audit_log(p_ws,
      case when not was_on and w.project_access then 'project_access.on'
           when was_on and not w.project_access then 'project_access.off'
           else 'project_access.settings' end,
      'workspace', p_ws::text, w.name,
      jsonb_build_object('default', w.project_access_default, 'member_private', w.project_access_member_private));
  end if;
  return jsonb_build_object('on', w.project_access, 'default', w.project_access_default,
                            'member_private', w.project_access_member_private, 'changed_at', w.project_access_changed_at);
end; $$;

-- What stands in the way of switching on (the containment rule, 2t): the Members only and Private projects
-- here that still connect to Notion, each with its syncs and its tasks that have Notion links (Settings ›
-- Workspace › Project access lists them before it's turned on). The workspace's owner only; anyone else
-- gets an empty list. Answers [{project_id, name, visibility, syncs, linked_tasks}] (name and visibility
-- null for a project that's been deleted or has left the workspace).
create or replace function public.project_access_notion_blockers(p_ws uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when auth.uid() is null or p_ws is null or public.ws_role(p_ws) <> 'owner' or not public.can_act() then '[]'::jsonb
    else coalesce((select jsonb_agg(jsonb_build_object('project_id', b.project_id, 'name', b.name, 'visibility', b.visibility,
                                                       'syncs', b.syncs, 'linked_tasks', b.linked_tasks) order by b.name nulls last, b.project_id)
                     from public.pa_notion_blockers(p_ws) b), '[]'::jsonb) end;
$$;

-- Who can see a project: its managers (D12, the switch-on rule whatever the switch says). Private needs
-- an owner or admin, or a workspace that lets members; nobody but the workspace's owner may change it so
-- that they'd lose edit rights themselves. Answers the visibility.
create or replace function public.set_project_visibility(p_project uuid, p_visibility text)
returns text language plpgsql security definer set search_path = public as $$
declare
  p public.projects;
  role text;
  mine text;
  prev text := coalesce(current_setting('kanbo.pa_write', true), '');
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_visibility is null or p_visibility not in ('workspace', 'members', 'private') then raise exception 'invalid visibility'; end if;
  select * into p from public.projects where id = p_project for update;
  if p.id is null or p.workspace_id is null or not public.can_see_project(p_project) then raise exception 'not found'; end if;
  if not public.pa_manage_rule(p_project, true) then raise exception 'not authorized'; end if;
  if p_visibility = 'private' and p.visibility <> 'private' and not public.pa_may_make_private(p.workspace_id) then
    raise exception 'not authorized';
  end if;
  role := public.ws_role(p.workspace_id);
  select m.role into mine from public.project_members m where m.project_id = p.id and m.user_id = auth.uid();
  if role <> 'owner' and public.pa_rank_core(public.pa_on(p.workspace_id), role, p_visibility, p.owner_id = auth.uid(), mine) < 3 then
    raise exception 'not authorized';
  end if;
  if p.visibility = p_visibility then return p.visibility; end if;
  perform set_config('kanbo.pa_write', 'on', true);
  update public.projects set visibility = p_visibility where id = p_project;
  perform set_config('kanbo.pa_write', prev, true);
  perform public.audit_log(p.workspace_id, 'project.visibility', 'project', p.id::text, p.name,
                           jsonb_build_object('from', p.visibility, 'to', p_visibility));
  return p_visibility;
end; $$;

-- Add someone to a project, or change their role (its managers). A guest is a commenter at most; the
-- project's owner is always an editor ('owner', nothing written). Answers the role stored.
create or replace function public.set_project_member(p_project uuid, p_user uuid, p_role text)
returns text language plpgsql security definer set search_path = public as $$
declare
  p public.projects;
  was text;
  stored text;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_role is null or p_role not in ('editor', 'commenter', 'viewer') then raise exception 'invalid role'; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null or p.workspace_id is null or not public.can_see_project(p_project) then raise exception 'not found'; end if;
  if not public.pa_can_manage(p_project) then raise exception 'not authorized'; end if;
  if p_user is null or public.user_ws_role(p_user, p.workspace_id) = 'none' then raise exception 'not a member of this workspace'; end if;
  if p_user = p.owner_id then return 'owner'; end if;
  select m.role into was from public.project_members m where m.project_id = p.id and m.user_id = p_user;
  insert into public.project_members (project_id, workspace_id, user_id, role, added_by)
  values (p.id, p.workspace_id, p_user,
          case when p_role = 'editor' and public.user_ws_role(p_user, p.workspace_id) = 'guest' then 'commenter' else p_role end,
          auth.uid())
  on conflict (project_id, user_id) do update
     set role = excluded.role, added_by = excluded.added_by, updated_at = now()
   where public.project_members.role is distinct from excluded.role
  returning role into stored;
  stored := coalesce(stored, was);
  if stored is distinct from was then
    perform public.audit_log(p.workspace_id, 'project.member', 'project', p.id::text, p.name,
                             jsonb_build_object('user_id', p_user, 'role', stored, 'from', was));
  end if;
  return stored;
end; $$;

-- Take someone off a project (its managers), or leave it yourself. The owner hands it on first.
create or replace function public.remove_project_member(p_project uuid, p_user uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  p public.projects;
  was text;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into p from public.projects where id = p_project;
  if p.id is null or p.workspace_id is null or not public.can_see_project(p_project) then raise exception 'not found'; end if;
  if not (public.pa_can_manage(p_project) or p_user = auth.uid()) then raise exception 'not authorized'; end if;
  if p_user is null or p_user = p.owner_id then raise exception 'not authorized'; end if;
  delete from public.project_members m where m.project_id = p.id and m.user_id = p_user returning m.role into was;
  if was is null then return false; end if;
  perform public.audit_log(p.workspace_id, 'project.member', 'project', p.id::text, p.name,
                           jsonb_build_object('user_id', p_user, 'role', null, 'from', was));
  return true;
end; $$;

-- The projects an invite brings (owners and admins, on a pending invite): [{"project_id": uuid, "role":
-- text}], 50 at most. They become project_members when it's claimed. It sets the grants on the projects
-- the caller manages, and only those: a grant on one they can't see stays as it is (it's that project's
-- managers', who may have made it Private since: an admin's edit of the whole list never drops it), and
-- one they can see but not manage may only be sent back as it is. Answers how many of the projects the
-- invite brings the caller can see.
create or replace function public.set_invite_projects(p_member uuid, p_grants jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  m public.workspace_members;
  g jsonb;
  pid uuid;
  r text;
  want jsonb := '{}'::jsonb;     -- project id → role
  x record;
  n integer := 0;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into m from public.workspace_members where id = p_member;
  if m.id is null or m.status <> 'invited' or public.ws_role(m.workspace_id) not in ('owner', 'admin') then
    raise exception 'not found';
  end if;
  if p_grants is null or jsonb_typeof(p_grants) <> 'array' or jsonb_array_length(p_grants) > 50 then
    raise exception 'invalid grants';
  end if;
  for g in select e from jsonb_array_elements(p_grants) e loop
    if jsonb_typeof(g) <> 'object' or public.kanbo_uuid(g ->> 'project_id') is null
       or coalesce(g ->> 'role', '') not in ('editor', 'commenter', 'viewer') then
      raise exception 'invalid grants';
    end if;
    pid := public.kanbo_uuid(g ->> 'project_id');
    r := g ->> 'role';
    if m.role = 'guest' and r = 'editor' then r := 'commenter'; end if;
    -- (a project you can't see is refused whatever the invite brings on it: accepting the grant it
    -- already has would say so; it's kept by the loop below, as you didn't ask to change it)
    if not exists (select 1 from public.projects p where p.id = pid and p.workspace_id = m.workspace_id)
       or not public.can_see_project(pid)
       or (not public.pa_can_manage(pid)
           and not exists (select 1 from public.project_member_invites i where i.member_id = p_member and i.project_id = pid and i.role = r)) then
      raise exception 'not authorized';
    end if;
    want := want || jsonb_build_object(pid::text, r);
  end loop;
  -- (what it brings now and isn't asked for: gone from the projects you manage; on one you can see but
  -- not manage, refused; on one you can't see, kept)
  for x in select i.id, i.project_id from public.project_member_invites i where i.member_id = p_member loop
    if want ? x.project_id::text then continue; end if;
    if public.pa_can_manage(x.project_id) then delete from public.project_member_invites where id = x.id;
    elsif public.can_see_project(x.project_id) then raise exception 'not authorized';
    end if;
  end loop;
  for x in select k as pid, v as role from jsonb_each_text(want) a(k, v) loop
    insert into public.project_member_invites (member_id, project_id, workspace_id, role, added_by)
    values (p_member, x.pid::uuid, m.workspace_id, x.role, auth.uid())
    on conflict (member_id, project_id) do update set role = excluded.role
     where public.project_member_invites.role is distinct from excluded.role;
  end loop;
  -- (how many of its projects you can see: one you can't is kept, never counted to you)
  select count(*) into n from public.project_member_invites where member_id = p_member and public.can_see_project(project_id);
  return n;
end; $$;

-- Take one project off a pending invite: that project's managers (a member who owns a Private project
-- sees, and can take off, a grant an admin made while it was Members only). Answers true.
create or replace function public.remove_invite_project(p_member uuid, p_project uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare i public.project_member_invites;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  -- (who may first: what a pending invite brings is its project's managers' to read, so nobody else
  -- learns from the answer whether it brings this one)
  if not public.can_see_project(p_project) then raise exception 'not found'; end if;
  if not public.pa_can_manage(p_project) then raise exception 'not authorized'; end if;
  select * into i from public.project_member_invites where member_id = p_member and project_id = p_project;
  if i.id is null then raise exception 'not found'; end if;
  delete from public.project_member_invites where id = i.id;
  return true;
end; $$;

-- Hand a team project to someone (About › Owner): the same change as an update of projects.owner_id,
-- with the same rights (edit rights on it, then trg_projects_pa_guard's: its managers where the switch-on
-- rule applies, and an active non-guest). The column's own check ('project access: edit') judges the row
-- as it will be, before trg_projects_pa_after gives the outgoing owner their editor row, so the owner of
-- a Private project (or a member who owns a Members only one) couldn't hand it on that way. As that check
-- asks, the caller still has edit rights on it afterwards. Answers the owner stored.
create or replace function public.set_project_owner(p_project uuid, p_user uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare p public.projects;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into p from public.projects where id = p_project for update;
  if p.id is null or p.workspace_id is null or not public.api_scope_ok(p.workspace_id) or not public.can_see_project(p_project) then
    raise exception 'not found';
  end if;
  if not public.can_edit_project(p_project) then raise exception 'not authorized'; end if;
  if p_user is not distinct from p.owner_id then return p.owner_id; end if;
  update public.projects set owner_id = p_user where id = p_project;
  if not public.can_edit_project(p_project) then raise exception 'not authorized'; end if;
  return p_user;
end; $$;

do $rpc$
declare f text;
begin
  foreach f in array array['public.set_project_access(uuid,boolean,text,boolean)', 'public.set_project_visibility(uuid,text)',
                           'public.project_access_notion_blockers(uuid)',
                           'public.set_project_member(uuid,uuid,text)', 'public.remove_project_member(uuid,uuid)',
                           'public.set_invite_projects(uuid,jsonb)', 'public.remove_invite_project(uuid,uuid)',
                           'public.set_project_owner(uuid,uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $rpc$;

-- ---------- 5. the rules, and putting them back ----------
-- 5a. the triggers' functions (internal: revoked from everyone below)
-- "Client": a request from the app, the REST API or MCP (auth.role() authenticated/anon). "Direct":
-- a client's own statement (not one a trigger makes for it). "Restoring": the bin putting rows back.

-- workspaces: the switch's four columns are set_project_access()'s; any change to the switch touches
create or replace function public.pa_trg_workspaces_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if public.pa_is_client() then
      new.project_access := false; new.project_access_default := 'workspace';
      new.project_access_member_private := false; new.project_access_changed_at := null;
    end if;
    return new;
  end if;
  if public.pa_is_client() and coalesce(current_setting('kanbo.pa_write', true), '') <> 'on'
     and (new.project_access, new.project_access_default, new.project_access_member_private, new.project_access_changed_at)
         is distinct from (old.project_access, old.project_access_default, old.project_access_member_private, old.project_access_changed_at) then
    raise exception 'not authorized';
  end if;
  -- (the SQL editor's emergency switch-off makes open apps reload too)
  if (new.project_access, new.project_access_default, new.project_access_member_private)
     is distinct from (old.project_access, old.project_access_default, old.project_access_member_private) then
    new.project_access_changed_at := now();
  end if;
  -- switching on: never while a Members only or Private project still connects to Notion (the
  -- containment rule, 2t: the sentence says how many, where, and what to do), whoever asks
  if new.project_access and not coalesce(old.project_access, false) and public.pa_notion_contain() then
    perform public.pa_notion_refuse_on(new.id);
  end if;
  -- switching on: a sub-task that was moved to another project on its own while it was off stands on
  -- its own from now on (D11), so its parent's delete or move never takes it along
  if new.project_access and not coalesce(old.project_access, false) then
    perform public.pa_detach_strays(new.id, null);
  end if;
  return new;
end; $$;
-- workspaces, after: switching on (set_project_access, or the SQL editor) drops held notices and
-- pending webhooks for people who won't see their work (so does the workspace changing owners: the
-- old owner may be an admin now, who doesn't see every project), splits the bin's entries that took
-- another project's sub-tasks along (2r), the bin's summaries forget a parent's title from another
-- project (a sub-task binned while it was off, or before 0058: 2q), and its task rows lose Kanbo's
-- ranking reasons (2s). An old owner with no member row of their own has left with the hand-over:
-- they take nothing with them (2p), as if their row had gone.
create or replace function public.pa_trg_workspaces_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare switched_on boolean := new.project_access and not coalesce(old.project_access, false);
begin
  if switched_on then
    perform public.pa_split_bin(new.id);
    perform public.pa_scrub_bin(new.id);
    perform public.pa_clear_reasons(new.id);
  end if;
  if new.owner_id is distinct from old.owner_id and old.owner_id is not null then
    perform public.pa_forget_member(new.id, old.owner_id);
  end if;
  if switched_on or new.owner_id is distinct from old.owner_id then
    perform public.pa_flush_held(new.id, null);
  end if;
  return null;
end; $$;

-- (internal) Does work in this workspace name this project id, in any spelling (every rank reads it so):
-- a task, an update, a section, a custom field, a rule, a form, or a bin entry that isn't the project's own?
create or replace function public.pa_id_named(p_ws uuid, p_id uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_ws is not null and p_id is not null and (
       exists (select 1 from public.tasks t where t.workspace_id = p_ws and lower(t.project_id) = p_id::text)
    or exists (select 1 from public.status_updates s where s.workspace_id = p_ws and lower(s.project_id) = p_id::text)
    or exists (select 1 from public.sections x where x.workspace_id = p_ws and lower(x.project_id) = p_id::text)
    or exists (select 1 from public.custom_field_defs x where x.workspace_id = p_ws and lower(x.project_id) = p_id::text)
    or exists (select 1 from public.automation_rules x where x.workspace_id = p_ws and lower(x.project_id) = p_id::text)
    or exists (select 1 from public.forms x where x.workspace_id = p_ws and lower(x.project_id) = p_id::text)
    or exists (select 1 from public.trash x where x.workspace_id = p_ws and lower(x.project_id) = p_id::text
                                              and x.kind <> 'project' and x.restored_at is null));
$$;
revoke execute on function public.pa_id_named(uuid, uuid) from public, anon, authenticated;

-- projects, before: a new project's visibility; visibility only through set_project_visibility();
-- an owner change by a manager to a non-guest, and a move to another workspace or Personal by a
-- manager (switch on, or a project that isn't Whole workspace); contributor_ids mirrors project_members
create or replace function public.pa_trg_projects_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  client boolean := public.pa_is_client();
  direct boolean := public.pa_is_client() and pg_trigger_depth() <= 1;
  restoring boolean := public.pa_restoring();
  d text;
  u uuid;
  prev text;
begin
  -- an id deleted for good is never a project's again, whoever asks and whatever the switch says (1g;
  -- answered like 0047's guard on ids waiting in the bin). Nor is the id of a Members only or Private
  -- project that left a workspace (1h), once nothing holds it any more (deleted for good from a Personal
  -- bin, by hand or by housekeeping; its new workspace closed; its owner's account deleted): a new
  -- project under it would be the live project there, and take over what still names it (its history,
  -- its bin entries, what an old tab wrote). The bin putting it back (a restore) is still it; moving it
  -- back is an update of its workspace, not of its id.
  if (tg_op = 'INSERT' or new.id is distinct from old.id)
     and (exists (select 1 from public.project_ids_retired g where g.id = new.id)
          or (not restoring and exists (select 1 from public.project_departures d where d.id = new.id))) then
    raise exception 'id in use' using errcode = 'unique_violation';
  end if;
  -- (nor, while the switch is on, a client's new team project under an id that work here already names:
  -- tasks, updates, sections, fields, rules, forms or bin entries left under it (moved there by hand, or
  -- left by a project that went). The new project would take that work over, and the say over who sees
  -- it, past the checks a move into it meets: a member's own Members only project would take others'
  -- tasks along with their assignees and Notion links (the containment rule, 2t). The app, the API and
  -- the notion function never choose a new project's id; the bin putting one back (a restore) is still
  -- it. Switched off, as before: nobody's access turns on an id then)
  if tg_op = 'INSERT' and client and not restoring and new.workspace_id is not null
     and public.pa_on(new.workspace_id) and public.pa_id_named(new.workspace_id, new.id) then
    raise exception 'id in use' using errcode = 'unique_violation';
  end if;
  if tg_op = 'INSERT' then
    if new.workspace_id is null then new.visibility := 'workspace'; return new; end if;
    if restoring and new.visibility is not null then
      null;                                       -- the bin puts back what it had
    elsif restoring then
      new.visibility := 'workspace';              -- binned before 0058, when every project was the whole workspace's
    elsif new.visibility is null then
      d := coalesce((select w.project_access_default from public.workspaces w where w.id = new.workspace_id), 'workspace');
      if d = 'private' and not (case when client then public.pa_may_make_private(new.workspace_id)
                                     else public.pa_user_may_make_private(new.user_id, new.workspace_id) end) then
        d := 'members';
      end if;
      new.visibility := d;
    else
      if new.visibility not in ('workspace', 'members', 'private') then raise exception 'invalid visibility'; end if;
      if client then
        if new.visibility = 'private' and not public.pa_may_make_private(new.workspace_id) then raise exception 'not authorized'; end if;
        -- (D3: a new project that isn't the whole workspace's is its maker's, so they can see what they made)
        if new.visibility <> 'workspace' and new.owner_id is distinct from auth.uid() and public.ws_role(new.workspace_id) <> 'owner' then
          raise exception 'not authorized';
        end if;
      end if;
    end if;
    -- (a new project given to someone else has an owner an owner change could give it: an active
    -- non-guest here, as the UPDATE below asks; while the switch is on, or a project that isn't Whole
    -- workspace. Switched off, a Whole workspace one: anyone in the workspace, a guest too, as before;
    -- never someone who isn't in it, below)
    if client and not restoring and new.owner_id is not null and new.owner_id is distinct from auth.uid()
       and (case when public.pa_on(new.workspace_id) or new.visibility <> 'workspace'
                 then public.user_ws_role(new.owner_id, new.workspace_id) not in ('owner', 'admin', 'member')
                 else public.pa_ws_member_role(new.owner_id, new.workspace_id) = 'none' end) then
      raise exception 'invalid owner';
    end if;
    if not restoring then
      -- its people: who's active here and isn't its owner, plus its maker (an active non-guest who isn't the owner)
      new.contributor_ids := coalesce(array(
        select q.x from (
          select a.x, min(a.n) as n
            from unnest(coalesce(new.contributor_ids, '{}'::uuid[])
                        || case when new.user_id is distinct from new.owner_id
                                 and public.user_ws_role(new.user_id, new.workspace_id) in ('owner', 'admin', 'member')
                                then array[new.user_id] else '{}'::uuid[] end) with ordinality a(x, n)
           where a.x is not null and a.x is distinct from new.owner_id
             and public.pa_ws_member_role(a.x, new.workspace_id) <> 'none'
           group by a.x) q order by q.n), '{}');
    end if;
    return new;
  end if;

  -- UPDATE
  -- (a team project's id is never a client's to change, whatever the switch says: nothing moves its
  -- tasks, updates, sections, fields, rules and forms with it (they name it by a text id), so they'd be
  -- left loose, and a project made under the old id (a Members only one of the changer's own, say) would
  -- take them over, with the say over who sees them. The app never renumbers a project; the bin puts one
  -- back with an insert)
  if client and new.id is distinct from old.id and coalesce(old.workspace_id, new.workspace_id) is not null then
    raise exception 'not authorized';
  end if;
  if new.visibility is distinct from old.visibility and client
     and coalesce(current_setting('kanbo.pa_write', true), '') <> 'on' then
    raise exception 'not authorized';
  end if;
  -- a move out of its workspace (to Personal, or another one) is its managers' while the switch is on,
  -- or on a project that isn't Whole workspace (the off window too): 0041 lets any writer make a team
  -- project their own Personal one, and a move and back would hand them its ownership and drop its people
  if direct and new.workspace_id is distinct from old.workspace_id and old.workspace_id is not null
     and (public.pa_on(old.workspace_id) or old.visibility <> 'workspace')
     and not public.pa_can_manage(old.id) then
    raise exception 'not authorized';
  end if;
  -- (and only once its work has gone: nothing moves a project's tasks, updates, sections, fields, rules
  -- or forms with it, nor what of it waits in the bin, and what it left behind would be loose work every
  -- member of its old workspace reads and edits. Anything that names it there later keeps the access it
  -- had there: pa_trg_projects_after records it, 1h. Its id in any spelling counts, as the ranks read it)
  if direct and new.workspace_id is distinct from old.workspace_id and old.workspace_id is not null
     and (public.pa_on(old.workspace_id) or old.visibility <> 'workspace')
     and public.pa_id_named(old.workspace_id, old.id) then
    raise exception 'move its tasks first' using hint = 'A project leaves its workspace only once its tasks, updates, sections, fields, rules and forms have gone, from the bin too.';
  end if;
  if new.workspace_id is null then new.visibility := 'workspace'; end if;     -- moved to Personal: nothing to gate
  -- (judged where it was, else where it's going: an owner change on the way out or in counts too)
  if direct and new.owner_id is distinct from old.owner_id and coalesce(old.workspace_id, new.workspace_id) is not null
     and (public.pa_on(coalesce(old.workspace_id, new.workspace_id)) or old.visibility <> 'workspace') then
    if not public.pa_can_manage(old.id) then raise exception 'not authorized'; end if;
    if new.workspace_id is not null
       and public.user_ws_role(new.owner_id, new.workspace_id) not in ('owner', 'admin', 'member') then
      raise exception 'invalid owner';
    end if;
  end if;
  -- (whatever the switch says, a team project's owner is someone in its workspace, given it by an owner
  -- change or taking it there by a move: one who isn't, invited back later for anything (a guest for
  -- another project), would have it again as its owner once the switch is on, as someone who left
  -- would, but for 2p handing a leaver's projects on. Switched off, a guest may still be given a Whole
  -- workspace one, as before)
  if direct and new.workspace_id is not null and new.owner_id is not null
     and (new.owner_id is distinct from old.owner_id or new.workspace_id is distinct from old.workspace_id)
     and public.pa_ws_member_role(new.owner_id, new.workspace_id) = 'none' then
    raise exception 'invalid owner';
  end if;
  if new.contributor_ids is distinct from old.contributor_ids and coalesce(current_setting('kanbo.pa_sync', true), '') <> 'on' then
    -- an older tab writing contributor_ids: today's rule while the switch is off (on a Whole workspace
    -- project), the managers' while it's on
    if direct and not public.pa_can_manage(old.id) then raise exception 'not authorized'; end if;
    if new.workspace_id is not null and new.workspace_id is not distinct from old.workspace_id then
      prev := coalesce(current_setting('kanbo.pa_sync', true), '');
      perform set_config('kanbo.pa_sync', 'on', true);
      for u in select a.x from unnest(coalesce(new.contributor_ids, '{}'::uuid[])) with ordinality a(x, n)
                where a.x is not null and not (a.x = any (coalesce(old.contributor_ids, '{}'::uuid[]))) order by a.n loop
        if u is not distinct from new.owner_id or u is not distinct from old.owner_id
           or public.pa_ws_member_role(u, new.workspace_id) = 'none' then
          continue;
        end if;
        insert into public.project_members (project_id, workspace_id, user_id, role, added_by, created_at)
        values (old.id, new.workspace_id, u,
                case when public.pa_ws_member_role(u, new.workspace_id) = 'guest' then 'commenter' else 'editor' end,
                public.kanbo_actor(), clock_timestamp())
        on conflict (project_id, user_id) do nothing;
      end loop;
      delete from public.project_members m
       where m.project_id = old.id
         and m.user_id = any (array(select x from unnest(coalesce(old.contributor_ids, '{}'::uuid[])) x
                                     where not (x = any (coalesce(new.contributor_ids, '{}'::uuid[])))));
      perform set_config('kanbo.pa_sync', prev, true);
      new.contributor_ids := coalesce(array(select m.user_id from public.project_members m
                                             where m.project_id = old.id order by m.created_at, m.id), '{}');
    end if;
  end if;
  return new;
end; $$;

-- (internal) contributor_ids := the project's people, without anyone's triggers re-applying it
create or replace function public.pa_mirror_contributors(p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare prev text := coalesce(current_setting('kanbo.pa_sync', true), ''); ids uuid[];
begin
  ids := coalesce(array(select m.user_id from public.project_members m where m.project_id = p_project order by m.created_at, m.id), '{}');
  perform set_config('kanbo.pa_sync', 'on', true);
  update public.projects set contributor_ids = ids where id = p_project and contributor_ids is distinct from ids;
  perform set_config('kanbo.pa_sync', prev, true);
end; $$;

-- (internal) D11's strays: the tasks under p_roots (every task in the workspace when null) that sit in
-- another project than their parent's become tasks of their own (parent_id := null). Answers how many.
create or replace function public.pa_detach_strays(p_ws uuid, p_roots uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare ids uuid[];
begin
  if p_ws is null then return 0; end if;
  if p_roots is null then
    select coalesce(array_agg(c.id), '{}') into ids
      from public.tasks c join public.tasks p on p.id = c.parent_id
     where c.workspace_id = p_ws and p.workspace_id = p_ws and c.project_id is distinct from p.project_id;
  else
    with recursive d(id, project_id, stray) as (
      select t.id, t.project_id, false from public.tasks t where t.id = any (p_roots) and t.workspace_id = p_ws
      union
      select c.id, c.project_id, c.project_id is distinct from d.project_id
        from public.tasks c join d on c.parent_id = d.id and not d.stray
       where c.workspace_id = p_ws
    ) select coalesce(array_agg(distinct d.id), '{}') into ids from d where d.stray;
  end if;
  if cardinality(ids) = 0 then return 0; end if;
  update public.tasks set parent_id = null where id = any (ids) and parent_id is not null;
  return cardinality(ids);
end; $$;

-- projects, after: a new project's people; a narrower visibility flushes what's waiting; an owner
-- change (switch on, or a project that isn't Whole workspace) swaps the owner and their row; a move
-- takes its people's rows along
create or replace function public.pa_trg_projects_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  prev text := coalesce(current_setting('kanbo.pa_sync', true), '');
  u uuid;
  vrank constant jsonb := '{"workspace": 0, "members": 1, "private": 2}';
begin
  if tg_op = 'INSERT' then
    if new.workspace_id is null or public.pa_restoring() then return null; end if;   -- (a restore's people: trg_trash_pa_restore)
    perform set_config('kanbo.pa_sync', 'on', true);
    for u in select a.x from unnest(coalesce(new.contributor_ids, '{}'::uuid[])) with ordinality a(x, n) order by a.n loop
      if u is not distinct from new.owner_id or public.pa_ws_member_role(u, new.workspace_id) = 'none' then continue; end if;
      insert into public.project_members (project_id, workspace_id, user_id, role, added_by, created_at)
      values (new.id, new.workspace_id, u,
              case when public.pa_ws_member_role(u, new.workspace_id) = 'guest' then 'commenter' else 'editor' end,
              public.kanbo_actor(), clock_timestamp())
      on conflict (project_id, user_id) do nothing;
    end loop;
    perform set_config('kanbo.pa_sync', prev, true);
    return null;
  end if;

  if new.workspace_id is distinct from old.workspace_id then
    -- (1h: a Members only or Private project keeps, in the workspace it leaves, the access it had there,
    -- for whatever still names it there; back in a workspace, what it had left behind there is its again)
    if old.workspace_id is not null and old.visibility <> 'workspace' then
      insert into public.project_departures (id, workspace_id, access)
      values (old.id, old.workspace_id, jsonb_build_object(
                'v', 1, 'visibility', old.visibility, 'owner', old.owner_id,
                'members', coalesce((select jsonb_agg(jsonb_build_array(m.user_id, m.role) order by m.created_at, m.id)
                                       from public.project_members m where m.project_id = old.id), '[]'::jsonb)))
      on conflict (id, workspace_id) do update set access = excluded.access, left_at = now();
    end if;
    if new.workspace_id is not null then
      delete from public.project_departures where id = new.id and workspace_id = new.workspace_id;
    end if;
    perform set_config('kanbo.pa_sync', 'on', true);
    if new.workspace_id is null then
      delete from public.project_members where project_id = new.id;
    else
      delete from public.project_members m where m.project_id = new.id and public.pa_ws_member_role(m.user_id, new.workspace_id) = 'none';
      update public.project_members set workspace_id = new.workspace_id where project_id = new.id and workspace_id is distinct from new.workspace_id;
    end if;
    perform set_config('kanbo.pa_sync', prev, true);
    if new.workspace_id is not null then perform public.pa_mirror_contributors(new.id); end if;
  end if;
  if new.visibility is distinct from old.visibility and new.workspace_id is not null then
    perform public.pa_touch(new.workspace_id);
    if coalesce((vrank ->> new.visibility)::int, 0) > coalesce((vrank ->> old.visibility)::int, 0) then
      perform public.pa_flush_held(new.workspace_id, new.id);
    end if;
  end if;
  if new.owner_id is distinct from old.owner_id and new.workspace_id is not null
     and (public.pa_on(new.workspace_id) or new.visibility <> 'workspace') then
    perform set_config('kanbo.pa_sync', 'on', true);
    delete from public.project_members where project_id = new.id and user_id = new.owner_id;
    if old.owner_id is not null and public.user_ws_role(old.owner_id, new.workspace_id) in ('owner', 'admin', 'member') then
      insert into public.project_members (project_id, workspace_id, user_id, role, added_by, created_at)
      values (new.id, new.workspace_id, old.owner_id, 'editor', public.kanbo_actor(), clock_timestamp())
      on conflict (project_id, user_id) do update set role = 'editor', updated_at = now();
    end if;
    perform set_config('kanbo.pa_sync', prev, true);
    perform public.pa_mirror_contributors(new.id);
    perform public.pa_touch(new.workspace_id);
    perform public.pa_flush_held(new.workspace_id, new.id);
  end if;
  return null;
end; $$;

-- project_members, before: a team project's, in its workspace, of someone who's in it; a guest
-- comments at most; the project's owner never has a row
create or replace function public.pa_trg_project_members_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; r text;
begin
  select x.workspace_id, x.owner_id into p from public.projects x where x.id = new.project_id;
  if not found then raise exception 'not found'; end if;
  if p.workspace_id is null then raise exception 'not authorized'; end if;
  if tg_op = 'UPDATE' then
    new.project_id := old.project_id; new.user_id := old.user_id; new.created_at := old.created_at; new.updated_at := now();
  end if;
  new.workspace_id := p.workspace_id;
  r := public.pa_ws_member_role(new.user_id, p.workspace_id);
  if r = 'none' then raise exception 'not a member of this workspace'; end if;
  if new.user_id = p.owner_id then return null; end if;
  if r = 'guest' and new.role = 'editor' then new.role := 'commenter'; end if;
  return new;
end; $$;

-- project_members, after: contributor_ids follows (unless the mirror itself wrote this), apps
-- reload, and what's waiting for someone who lost access goes
create or replace function public.pa_trg_project_members_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  pid uuid := case when tg_op = 'DELETE' then old.project_id else new.project_id end;
begin
  -- (a role change leaves who's on it as it was: contributor_ids, and its webhooks, aren't touched)
  if tg_op <> 'UPDATE' and coalesce(current_setting('kanbo.pa_sync', true), '') <> 'on' then
    perform public.pa_mirror_contributors(pid);
  end if;
  perform public.pa_touch(ws);
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and public.pa_member_rank(new.role) < public.pa_member_rank(old.role)) then
    perform public.pa_flush_held(ws, pid);
  end if;
  return null;
end; $$;

-- workspace_members, after: leaving a workspace (or being removed) takes your project rows with you,
-- hands the projects you own there to its owner, and drops you from what the bin and the history
-- captured (2p); a guest's editor rows become commenter; a claimed invite brings its projects
create or replace function public.pa_trg_ws_members() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record; own uuid;
begin
  -- (and what's waiting for them goes: leaving, or becoming a guest, loses Whole workspace projects too)
  if tg_op = 'DELETE' then
    if old.user_id is not null then
      delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
      perform public.pa_forget_member(old.workspace_id, old.user_id);
      perform public.pa_flush_held(old.workspace_id, null);
    end if;
    return null;
  end if;
  -- (a row made inactive isn't someone leaving: the app removes people by deleting their row, and
  -- nothing in it sets an active row back to invited; only their project rows go, as before)
  if old.status = 'active' and new.status is distinct from 'active' and old.user_id is not null then
    delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
    perform public.pa_flush_held(old.workspace_id, null);
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
    perform public.pa_forget_member(old.workspace_id, old.user_id);
  end if;
  if new.status = 'active' and new.user_id is not null and new.role = 'guest' and old.role is distinct from 'guest' then
    update public.project_members set role = 'commenter'
     where workspace_id = new.workspace_id and user_id = new.user_id and role = 'editor';
  end if;
  -- (any role change of someone in it: an owner handing over (transfer_ownership, 0057's handover) or an
  -- admin made a member sees fewer projects, and what's waiting for their endpoints follows; so does
  -- becoming a guest, which loses Whole workspace projects too)
  if old.status = 'active' and new.status = 'active' and new.user_id is not null and new.role is distinct from old.role then
    perform public.pa_flush_held(new.workspace_id, null);
  end if;
  if old.status = 'invited' and new.status = 'active' and new.user_id is not null then
    select w.owner_id into own from public.workspaces w where w.id = new.workspace_id;
    for g in select i.project_id, i.role, i.added_by from public.project_member_invites i
              join public.projects p on p.id = i.project_id and p.workspace_id = new.workspace_id
             where i.member_id = new.id order by i.created_at, i.id loop
      if new.user_id is not distinct from (select p.owner_id from public.projects p where p.id = g.project_id) then continue; end if;
      insert into public.project_members (project_id, workspace_id, user_id, role, added_by, created_at)
      values (g.project_id, new.workspace_id, new.user_id,
              case when new.role = 'guest' and g.role = 'editor' then 'commenter' else g.role end, g.added_by, clock_timestamp())
      on conflict (project_id, user_id) do nothing;
    end loop;
    delete from public.project_member_invites where member_id = new.id;
  end if;
  return null;
end; $$;

-- tasks, before (switch on): a sub-task has its parent's project (D11); an assignee who can't see the
-- project is refused from the app, and handed to the project's owner from the server (D10), its plan
-- (on today, the slot, the My-tasks section) released as any hand-on releases it; collaborators and
-- followers who can't see it drop out. The assignee is judged as a member: someone
-- suspended or awaiting approval by the project they'll see once they can act (pa_assignee_rank), and
-- someone who has left the workspace keeps a task they already had when it moves (nothing here is
-- theirs to see, wherever it goes: as before, and as remove_member leaves it), but is never given one.
-- And a team task's row never holds Kanbo's ranking reason (ai_reason): it's its assignee's own.
create or replace function public.pa_trg_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  direct boolean := public.pa_is_client() and pg_trigger_depth() <= 1;
  par record;
  moved boolean;
  who uuid;
  ar integer;
begin
  if new.workspace_id is null or not public.pa_on(new.workspace_id) then return new; end if;
  -- (Kanbo's reason for ranking a task is its assignee's own, kept in their plan (0043's task_user_state):
  -- one on the row is read by everyone who can see the task, and one worked out from a batch that held
  -- their tasks in other projects can name a Members only or Private one's (one written before the switch
  -- went on can name one that someone who joins later, or is handed the task, must not see). So the row
  -- holds none here, whoever writes it: an older tab, the API's next occurrence, the bin putting a task
  -- back, a task moved in from elsewhere, a hand-on. Switching on clears those already there
  -- (pa_trg_workspaces_after: pa_clear_reasons). Clearing one is fine)
  if new.ai_reason is not null then new.ai_reason := null; end if;
  if public.pa_restoring() then
    -- (back from the bin under a parent that's in another project now: it comes back on its own)
    if new.parent_id is not null then
      select t.project_id, t.workspace_id into par from public.tasks t where t.id = new.parent_id;
      if found and par.workspace_id = new.workspace_id and par.project_id is distinct from new.project_id then
        new.parent_id := null;
      end if;
    end if;
    return new;
  end if;
  if new.parent_id is not null
     and (tg_op = 'INSERT' or new.parent_id is distinct from old.parent_id or new.project_id is distinct from old.project_id
          or new.workspace_id is distinct from old.workspace_id) then
    select t.project_id, t.workspace_id into par from public.tasks t where t.id = new.parent_id;
    if found and par.workspace_id = new.workspace_id then new.project_id := par.project_id; end if;
  end if;
  moved := tg_op = 'INSERT' or new.project_id is distinct from old.project_id or new.workspace_id is distinct from old.workspace_id;
  who := public.kanbo_uuid(new.assignee_id);
  if who is not null and (moved or new.assignee_id is distinct from old.assignee_id) then
    ar := public.pa_assignee_rank(who, new.workspace_id, new.project_id);
    if coalesce(ar, 0) < 1 and not (ar is null and tg_op = 'UPDATE' and new.assignee_id is not distinct from old.assignee_id) then
      if direct then
        raise exception 'assignee can''t see this project' using errcode = '42501';
      end if;
      new.assignee_id := coalesce(
        (select p.owner_id from public.projects p where p.id = public.kanbo_uuid(new.project_id) and p.workspace_id = new.workspace_id),
        (select w.owner_id from public.workspaces w where w.id = new.workspace_id))::text;
      -- (and, as every hand-on, the plan on it was the old assignee's: never a slot in its new one's day)
      new.plan_today := false; new.scheduled := null; new.my_section_id := null;
    end if;
  end if;
  -- (collaborators and followers as the assignee: someone suspended or awaiting approval keeps their
  -- place, judged by the projects they'll see once they can act again; someone who has left goes)
  if moved or new.collaborators is distinct from old.collaborators then
    new.collaborators := coalesce(array(
      select c from unnest(coalesce(new.collaborators, '{}'::text[])) with ordinality a(c, i)
       where public.kanbo_uuid(c) is null or coalesce(public.pa_assignee_rank(public.kanbo_uuid(c), new.workspace_id, new.project_id), 0) >= 1
       order by i), '{}');
  end if;
  if moved or new.followers is distinct from old.followers then
    new.followers := coalesce(array(
      select f from unnest(coalesce(new.followers, '{}'::text[])) with ordinality a(f, i)
       where public.kanbo_uuid(f) is null or coalesce(public.pa_assignee_rank(public.kanbo_uuid(f), new.workspace_id, new.project_id), 0) >= 1
       order by i), '{}');
  end if;
  return new;
end; $$;

-- tasks, after a move (switch on): the sub-tasks that were in its project move with it. One in another
-- project (moved there on its own while the switch was off, or back from the bin) isn't the mover's to
-- take: it stays where it is, on its own (D11). (It fires on a new parent too: trg_tasks_pa moves a
-- re-parented task to its parent's project itself, and an UPDATE OF trigger only sees the columns the
-- statement named.)
create or replace function public.pa_trg_tasks_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null or new.project_id is not distinct from old.project_id or not public.pa_on(new.workspace_id) then
    return null;
  end if;
  update public.tasks set parent_id = null
   where parent_id = new.id and workspace_id = new.workspace_id
     and project_id is distinct from old.project_id and project_id is distinct from new.project_id;
  update public.tasks set project_id = new.project_id
   where parent_id = new.id and workspace_id = new.workspace_id and project_id is not distinct from old.project_id;
  return null;
end; $$;

-- tasks and projects, before delete (switch on; sorts before 0047's trg_trash_task / trg_trash_project):
-- a sub-task in another project than its parent stands on its own first, so the delete (parent_id's
-- on delete cascade, the bin's whole-tree entry) never takes it, or puts it in a bin row people who
-- can't see it may purge
create or replace function public.pa_trg_tasks_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.workspace_id is not null and public.pa_on(old.workspace_id) then
    perform public.pa_detach_strays(old.workspace_id, array[old.id]);
  end if;
  return old;
end; $$;
create or replace function public.pa_trg_projects_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.workspace_id is not null and public.pa_on(old.workspace_id) then
    perform public.pa_detach_strays(old.workspace_id,
      array(select t.id from public.tasks t where t.workspace_id = old.workspace_id and t.project_id = old.id::text));
  end if;
  return old;
end; $$;

-- status_updates (0054's Asks): only people who can comment on it (sorts after its guard and author triggers)
create or replace function public.pa_trg_status_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null or not public.pa_on(new.workspace_id) then return new; end if;
  new.ask_user_ids := coalesce(array(
    select x from unnest(coalesce(new.ask_user_ids, '{}'::uuid[])) with ordinality a(x, i)
     where public.pa_rank_for(x, new.workspace_id, new.project_id) >= 2 order by i), '{}');
  return new;
end; $$;

-- status_update_comments (0054): the @mentioned are people who can reply to the update (a mention asks
-- for a reply, 0054's notice says so: as with Asks, never a viewer, who can't)
create or replace function public.pa_trg_status_update_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select x.workspace_id, x.project_id into s from public.status_updates x where x.id = new.update_id;
  if s.workspace_id is null or not public.pa_on(s.workspace_id) then return new; end if;
  new.mentions := coalesce(array(
    select x from unnest(coalesce(new.mentions, '{}'::uuid[])) with ordinality a(x, i)
     where public.pa_rank_for(x, s.workspace_id, s.project_id) >= 2 order by i), '{}');
  return new;
end; $$;

-- activity (the Inbox), before: nobody hears about work they can't see. The subject: the task; else
-- meta.status_update_id; else meta.doc_id's project; else meta.project_id. A meeting's recap always
-- arrives (it says nothing of the project), without a notes doc they can't open.
create or replace function public.pa_trg_activity_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.meta, '{}'::jsonb);
  ws uuid;
  proj text;
begin
  begin
    if new.task_id is not null then
      select t.workspace_id, t.project_id into ws, proj from public.tasks t where t.id = new.task_id;
    else
      if public.kanbo_uuid(m ->> 'status_update_id') is not null then
        select s.workspace_id, s.project_id into ws, proj from public.status_updates s where s.id = public.kanbo_uuid(m ->> 'status_update_id');
      end if;
      if ws is null and public.kanbo_uuid(m ->> 'doc_id') is not null then
        select p.workspace_id, p.id::text into ws, proj from public.project_docs d join public.projects p on p.id = d.project_id
         where d.id = public.kanbo_uuid(m ->> 'doc_id');
      end if;
      if ws is null and public.kanbo_uuid(m ->> 'project_id') is not null then
        select p.workspace_id, p.id::text into ws, proj from public.projects p where p.id = public.kanbo_uuid(m ->> 'project_id');
      end if;
    end if;
    if ws is null or not public.pa_on(ws) or public.pa_rank_for(new.user_id, ws, proj) >= 1 then return new; end if;
  exception when others then
    raise warning 'project access: notice withheld (%)', sqlerrm;
  end;
  if new.kind = 'meeting' then
    new.meta := m - 'doc_id' - 'project_id';
    return new;
  end if;
  return null;                                   -- dropped: the write that made it goes on
end; $$;

-- notify_queue (0048), before: what's held for email and push. Never raises (a raise reads as
-- "unavailable" in _shared/notifyQueue.ts and sends at once): a notice it can't judge is dropped.
create or replace function public.pa_trg_notify_queue_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb;
begin
  begin
    if new.task_id is not null and public.pa_task_hidden_for(new.user_id, new.task_id) then return null; end if;
    p := public.pa_notice_payload(new.user_id, new.payload);
    if p is null then return null; end if;
    new.payload := p;
    return new;
  exception when others then
    raise warning 'project access: held notice dropped (%)', sqlerrm;
    return null;
  end;
end; $$;

-- webhook_deliveries (0046), before: an endpoint hears only what its viewer (who set its address,
-- else who made it) can see now. Fan-out skips the rest; a redeliver of one they can't is failed.
-- A viewer who's no longer an owner, admin or member there switches the endpoint off: nothing goes,
-- an event with no project (member.joined) included.
create or replace function public.pa_trg_webhook_deliveries_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record; o record; proj text;
begin
  if tg_op = 'UPDATE' and not (new.state = 'pending' and old.state is distinct from 'pending') then return new; end if;
  if new.event = 'ping' then return new; end if;
  select x.workspace_id, x.created_by, x.url_set_by into w from public.webhooks x where x.id = new.webhook_id;
  if w.workspace_id is null or not public.pa_on(w.workspace_id) then return new; end if;
  if public.user_ws_role(coalesce(w.url_set_by, w.created_by), w.workspace_id) not in ('owner', 'admin', 'member') then
    perform public.pa_webhooks_viewer_gone(w.workspace_id, new.webhook_id);
    if tg_op = 'INSERT' then return null; end if;
    new.state := 'failed'; new.lease_until := null; new.next_attempt_at := null;
    new.error := 'Not sent: the person who set this endpoint''s address no longer has access, so it was switched off.';
    return new;
  end if;
  select x.event, x.payload into o from public.webhook_outbox x where x.id = new.outbox_id;
  proj := public.pa_webhook_project(o.event, o.payload);
  if proj is null or public.pa_rank_or_binned(coalesce(w.url_set_by, w.created_by), w.workspace_id, proj) >= 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then return null; end if;
  new.state := 'failed'; new.error := 'not sent: no longer visible'; new.lease_until := null; new.next_attempt_at := null;
  return new;
end; $$;

-- webhooks: re-pointing an endpoint makes whoever did it its viewer (D19), and what's still queued for
-- it (retries, the backlog) goes to the new address only if the new viewer can see it. Its viewer's
-- account deleted (url_set_by nulled by its foreign key, the address the same): it never falls back to
-- its creator's access, which may be wider (an admin could re-point an owner's endpoint, delete their
-- own account and have it all): it's switched off as when they leave, whatever the switch says (the
-- dispatcher judges a viewer the same way with it off), and what's waiting for it fails. Switched back
-- on after its viewer went, whoever does it takes the address on as theirs: its viewer from then on
-- (else the next delivery would switch it off again, or its creator's access would apply).
create or replace function public.pa_trg_webhooks_url() returns trigger
language plpgsql security definer set search_path = public as $$
declare gone constant text := 'Switched off: the person who set its address no longer has access';
begin
  if new.url is distinct from old.url then
    new.url_set_by := coalesce(public.kanbo_actor(), old.url_set_by);
    if new.workspace_id is not null and public.pa_on(new.workspace_id) then
      update public.webhook_deliveries d
         set state = 'failed', error = 'not sent: no longer visible', lease_until = null, next_attempt_at = null, updated_at = now()
        from public.webhook_outbox o
       where d.webhook_id = new.id and d.state = 'pending' and d.event <> 'ping' and o.id = d.outbox_id
         and public.pa_webhook_project(o.event, o.payload) is not null
         and public.pa_rank_or_binned(coalesce(new.url_set_by, new.created_by), new.workspace_id,
                                      public.pa_webhook_project(o.event, o.payload)) < 1;
    end if;
  elsif old.url_set_by is not null and new.url_set_by is null and old.url_set_by is distinct from old.created_by then
    new.active := false;
    new.disabled_at := coalesce(case when old.active then now() end, old.disabled_at, now());
    new.disabled_reason := gone;
    update public.webhook_deliveries
       set state = 'failed', next_attempt_at = null, lease_until = null, updated_at = now(),
           error = 'Not sent: the person who set this endpoint''s address no longer has access, so it was switched off.'
     where webhook_id = new.id and state = 'pending';
  end if;
  if new.active and not old.active and old.disabled_reason = gone and new.url is not distinct from old.url
     and public.kanbo_actor() is not null then
    new.url_set_by := public.kanbo_actor();
  end if;
  return new;
end; $$;

-- approval_reviewers (0047): a reviewer can comment on the task (never a viewer); a reviewer who
-- has since lost that can't decide
create or replace function public.pa_trg_approval_reviewers() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if public.pa_restoring() then return new; end if;
  if tg_op = 'UPDATE' and (new.decision is not distinct from old.decision or new.decision is null) then return new; end if;
  select x.workspace_id, x.project_id into t from public.approvals a join public.tasks x on x.id = a.task_id where a.id = new.approval_id;
  if t.workspace_id is null or not public.pa_on(t.workspace_id) then return new; end if;
  if public.pa_rank_for(new.user_id, t.workspace_id, t.project_id) >= 2 then return new; end if;
  if tg_op = 'INSERT' then raise exception 'invalid reviewers'; end if;
  raise exception 'approval not found';
end; $$;

-- approvals (0047), cancelled by someone (cancel_approval): its asker, or someone who can edit the task
-- (asking for one needs edit rights, deciding one comment rights and being asked). 0047 lets any owner or
-- admin cancel; on a Private project an admin has only their project role, and a viewer or commenter
-- doesn't call off someone else's request: 'approval not found', cancel_approval's own answer for a
-- request that isn't theirs. (A task leaving its workspace cancels its request from a trigger: not this.)
create or replace function public.pa_trg_approvals_cancel() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and pg_trigger_depth() <= 1 and new.status = 'cancelled' and old.status is distinct from 'cancelled'
     and old.workspace_id is not null and public.pa_on(old.workspace_id)
     and old.requested_by is distinct from auth.uid() and public.pa_task_rank(old.task_id) < 3 then
    raise exception 'approval not found';
  end if;
  return new;
end; $$;

-- kudos (0048): its recipient can see the task; from the app, its giver can comment on it (a viewer
-- can't react, nor leave a note: give_kudos and update_kudos ask only can_see_task). A changed note or
-- emoji goes into the recipient's Inbox item (update_kudos rewrites it in place, past the Inbox gate), so
-- it too is only for a recipient who can still see the task: otherwise 'invalid recipient', as giving.
create or replace function public.pa_trg_kudos() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select x.workspace_id, x.project_id into t from public.tasks x where x.id = new.task_id;
  if t.workspace_id is null or not public.pa_on(t.workspace_id) then return new; end if;
  if public.pa_is_client() and not public.pa_restoring() and public.pa_rank_for(new.from_user, t.workspace_id, t.project_id) < 2 then
    raise exception 'not authorized';
  end if;
  if (tg_op = 'INSERT' or (not public.pa_restoring()
                           and (new.note is distinct from old.note or new.emoji is distinct from old.emoji
                                or new.to_user is distinct from old.to_user)))
     and public.pa_rank_for(new.to_user, t.workspace_id, t.project_id) < 1 then
    raise exception 'invalid recipient';
  end if;
  return new;
end; $$;

-- trash, before insert: the project's access when it went in, and a summary that names only what's in
-- the row's own scope (2q: no project or parent of someone else's, whatever the switch says; with it
-- on, no parent's title from another project)
create or replace function public.pa_trg_trash_capture() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.access := public.pa_access_snapshot(new.workspace_id, new.project_id);
  new.summary := public.pa_summary_scoped(new.kind, new.workspace_id, new.user_id, new.project_id, new.summary, false);
  return new;
end; $$;

-- trash, restore (restored_at set): a project comes back with its people; the caller needs edit rights
-- on the item's project (live, else the lower of what the row captured and what's known of the
-- project); a task comes back only into its own project, or (from a Whole workspace project that's
-- gone) into a Whole workspace one: restore_from_trash picks it (pa_restore_landing), and this checks
-- where it actually is. A raise undoes the whole restore.
create or replace function public.pa_trg_trash_restore() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ws uuid := old.workspace_id;
  prev text := coalesce(current_setting('kanbo.pa_sync', true), '');
  e jsonb;
  uid uuid;
  r text;
begin
  if not (old.restored_at is null and new.restored_at is not null) or ws is null then return new; end if;
  if old.kind = 'project' and exists (select 1 from public.projects p where p.id = old.item_id and p.workspace_id = ws) then
    perform set_config('kanbo.pa_sync', 'on', true);
    if jsonb_typeof(old.access -> 'members') = 'array' then
      for e in select x from jsonb_array_elements(old.access -> 'members') x loop
        uid := public.kanbo_uuid(e ->> 0); r := e ->> 1;
        if uid is null or coalesce(r, '') not in ('editor', 'commenter', 'viewer') or public.pa_ws_member_role(uid, ws) = 'none' then continue; end if;
        insert into public.project_members (project_id, workspace_id, user_id, role, created_at)
        values (old.item_id, ws, uid, r, clock_timestamp())
        on conflict (project_id, user_id) do update set role = excluded.role, updated_at = now();
      end loop;
    else
      for uid in select a.x from public.projects p cross join lateral unnest(p.contributor_ids) with ordinality a(x, n)
                  where p.id = old.item_id order by a.n loop
        if uid is null or public.pa_ws_member_role(uid, ws) = 'none' then continue; end if;
        insert into public.project_members (project_id, workspace_id, user_id, role, created_at)
        values (old.item_id, ws, uid, case when public.pa_ws_member_role(uid, ws) = 'guest' then 'commenter' else 'editor' end, clock_timestamp())
        on conflict (project_id, user_id) do nothing;
      end loop;
    end if;
    perform set_config('kanbo.pa_sync', prev, true);
    perform public.pa_mirror_contributors(old.item_id);
    perform public.pa_touch(ws);
  end if;
  if public.pa_is_client() and public.pa_on(ws) then
    if public.pa_snapshot_rank(ws, old.project_id, old.access) < 3 then raise exception 'not found'; end if;
    if old.kind = 'task' and exists (
         select 1 from public.tasks t
          where t.id = old.item_id and t.project_id is distinct from old.project_id
            and not exists (select 1 from public.projects p
                             where p.id = public.kanbo_uuid(t.project_id) and p.workspace_id = ws and p.visibility = 'workspace'
                               and public.pa_gone_visibility(ws, old.project_id, old.access) = 'workspace')) then
      raise exception 'not found';
    end if;
  end if;
  return new;
end; $$;

-- (1i: the pages that a sync's or a database importer's links in p_links tie to a task, left behind as
-- linked from p_project, with p_access; a link someone added by hand names no database, and isn't one)
create or replace function public.pa_retire_notion_pages(p_ws uuid, p_project text, p_access jsonb, p_links jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.notion_pages_retired as g (workspace_id, page_id, database_id, sync_id, project_id, access)
  select distinct on (e ->> 'notion_page_id', public.kanbo_uuid(e ->> 'sync_id'))
         p_ws, e ->> 'notion_page_id', e ->> 'notion_database_id', public.kanbo_uuid(e ->> 'sync_id'), p_project, p_access
    from jsonb_array_elements(case when jsonb_typeof(p_links) = 'array' then p_links else '[]'::jsonb end) e
   where p_ws is not null and e ->> 'notion_page_id' is not null
     and (e ->> 'kind' = 'synced' or e ->> 'notion_database_id' is not null)
   order by e ->> 'notion_page_id', public.kanbo_uuid(e ->> 'sync_id'), e ->> 'notion_database_id' nulls last
  on conflict (workspace_id, page_id, (coalesce(project_id, '')), (coalesce(sync_id::text, '')))
  do update set database_id = coalesce(excluded.database_id, g.database_id), access = coalesce(excluded.access, g.access),
                retired_at = now();
$$;

-- trash, delete for good: edit rights on the item's project (housekeeping, the service role, passes),
-- for a client's own delete (purge_trash): never a row a foreign key takes with an account (its creator's,
-- in a workspace that goes with them), which Admin › Delete user (0029's admin_delete_user: the platform
-- admin, a client with no rank there) would otherwise be refused, as GoTrue's delete never is.
-- A team project's own row: its id is retired with the access it had (1g), whatever the switch says
-- (with the Notion databases and pages its row held: 2h, 2j);
-- and if that wasn't Whole workspace, work that still names it (written after the delete: an old tab,
-- the offline queue, the off window) goes to the bin as entries of its own, which keep that access,
-- rather than outliving the project as loose work every member reads (D6). Its sections go with it.
create or replace function public.pa_trg_trash_purge() returns trigger
language plpgsql security definer set search_path = public as $$
declare roots uuid[];
begin
  if public.pa_is_client() and pg_trigger_depth() <= 1 and old.workspace_id is not null and public.pa_on(old.workspace_id)
     and public.pa_snapshot_rank(old.workspace_id, old.project_id, old.access) < 3 then
    raise exception 'not found';
  end if;
  if old.kind = 'project' and old.restored_at is null and old.workspace_id is not null
     and not exists (select 1 from public.projects p where p.id = old.item_id)
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then     -- (not the workspace closing)
    insert into public.project_ids_retired (id, workspace_id, access, notion_databases, notion_pages)
    values (old.item_id, old.workspace_id, coalesce(old.access, public.pa_gone_access(old.workspace_id, old.item_id::text)),
            array(select distinct x from (
                    select e ->> 'database_id' as x from jsonb_array_elements(case when jsonb_typeof(old.snapshot -> 'notion_syncs') = 'array'
                                                                                  then old.snapshot -> 'notion_syncs' else '[]'::jsonb end) e
                    union
                    select e ->> 'notion_database_id' from jsonb_array_elements(case when jsonb_typeof(old.snapshot -> 'notion_links') = 'array'
                                                                                     then old.snapshot -> 'notion_links' else '[]'::jsonb end) e
                     where not exists (select 1 from public.notion_syncs n where n.id = public.kanbo_uuid(e ->> 'sync_id'))) d
                   where x is not null order by 1),
            array(select distinct e ->> 'notion_page_id'
                    from jsonb_array_elements(case when jsonb_typeof(old.snapshot -> 'notion_links') = 'array'
                                                   then old.snapshot -> 'notion_links' else '[]'::jsonb end) e
                   where e ->> 'notion_page_id' is not null and (e ->> 'kind' = 'synced' or e ->> 'notion_database_id' is not null)
                   order by 1))
    on conflict (id) do update set workspace_id = excluded.workspace_id,
                                   access = coalesce(excluded.access, public.project_ids_retired.access), retired_at = now(),
                                   notion_databases = array(select distinct x from unnest(public.project_ids_retired.notion_databases
                                                                                          || excluded.notion_databases) x order by 1),
                                   notion_pages = array(select distinct x from unnest(public.project_ids_retired.notion_pages
                                                                                      || excluded.notion_pages) x order by 1);
    if public.pa_gone_visibility(old.workspace_id, old.item_id::text, old.access) <> 'workspace' then
      select coalesce(array_agg(t.id), '{}') into roots from public.tasks t
       where t.workspace_id = old.workspace_id and t.project_id = old.item_id::text
         and not exists (select 1 from public.tasks x where x.id = t.parent_id and x.workspace_id = t.workspace_id
                                                         and x.project_id = t.project_id);
      if cardinality(roots) > 0 then delete from public.tasks where id = any (roots); end if;   -- (0047's bin entries)
      delete from public.sections s where s.workspace_id = old.workspace_id and s.project_id = old.item_id::text;
    end if;
  elsif old.kind <> 'project' and old.restored_at is null and old.workspace_id is not null
        and jsonb_typeof(old.snapshot -> 'notion_links') = 'array'
        and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    -- a task (and its sub-tasks) deleted for good on its own: the pages its synced or importer-made links
    -- tied it to, with its row's project and access (1i), as its row held them
    perform public.pa_retire_notion_pages(old.workspace_id, old.project_id,
                                          coalesce(old.access, public.pa_access_snapshot(old.workspace_id, old.project_id)),
                                          old.snapshot -> 'notion_links');
  end if;
  return old;
end; $$;

-- notion_links, after delete: a sync's or an importer's link removed while its task is still there
-- (notion_unlink_page, the notion function) leaves its page behind (1i) with the task's project and its
-- access now; a task that has left the workspace it was linked in (to someone's Personal list or another
-- workspace), with none here: closed to all but this workspace's owners, as its database is (2j). One
-- that goes with its task is the bin's: the task's bin entry holds it (and its purge records it, above),
-- unless that entry is another workspace's (the task had left): then, as one that has left.
create or replace function public.pa_trg_notion_links_gone() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not (old.kind = 'synced' or old.notion_database_id is not null)
     or not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then     -- (not the workspace closing)
    return old;
  end if;
  select x.workspace_id, x.project_id into t from public.tasks x where x.id = old.task_id;
  if not found and exists (select 1 from public.trash r
                            where r.workspace_id = old.workspace_id and r.restored_at is null
                              and r.snapshot -> 'notion_links' @> jsonb_build_array(jsonb_build_object('id', old.id))) then
    return old;
  end if;
  perform public.pa_retire_notion_pages(old.workspace_id,
            case when t.workspace_id = old.workspace_id then t.project_id end,
            case when t.workspace_id = old.workspace_id then public.pa_access_snapshot(old.workspace_id, t.project_id)
                 else jsonb_build_object('v', 1, 'visibility', 'private', 'owner', null, 'members', '[]'::jsonb) end,
            jsonb_build_array(to_jsonb(old)));
  return old;
end; $$;

-- audit_events, before insert: the project a history row is about, and its access then. A task or
-- project that's gone by now (deleted for good from the bin, by hand or by housekeeping after 30 days:
-- its bin row and its project may both have gone, and 0047's purge row names neither) takes what the
-- history knew while it was there: its newest earlier row's project and access (task.deleted,
-- project.deleted, …). Never raises.
create or replace function public.pa_trg_audit_events() returns trigger
language plpgsql security definer set search_path = public as $$
declare prior record;
begin
  begin
    new.project_id := case new.target_kind
      when 'project' then new.target_id
      when 'task' then coalesce(new.detail ->> 'project_id',
                                (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(new.target_id)))
      when 'doc' then (select d.project_id::text from public.project_docs d where d.id = public.kanbo_uuid(new.target_id))
      else new.detail ->> 'project_id' end;
    new.access := public.pa_access_snapshot(new.workspace_id, new.project_id);
    if new.access is null and new.target_kind in ('task', 'project') and new.target_id is not null and new.workspace_id is not null then
      select e.project_id, e.access into prior from public.audit_events e
       where e.workspace_id = new.workspace_id and e.target_kind = new.target_kind and e.target_id = new.target_id
         and e.project_id is not null
       order by (e.access is not null) desc, e.created_at desc, e.id desc limit 1;
      if found then
        new.project_id := coalesce(new.project_id, prior.project_id);
        new.access := coalesce(public.pa_access_snapshot(new.workspace_id, new.project_id), prior.access);
      end if;
    end if;
  exception when others then
    raise warning 'project access: history row kept without its project (%)', sqlerrm;
  end;
  return new;
end; $$;

-- goal_links (0052), before insert (after 0052's guard sets its workspace): only work you can see
create or replace function public.pa_trg_goal_links() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and new.workspace_id is not null and new.kind in ('project', 'task') and public.pa_on(new.workspace_id)
     and public.pa_goal_target_rank(new.workspace_id, new.kind, new.target_id) < 1 then
    raise exception 'a goal can only link to work in its own workspace';
  end if;
  return new;
end; $$;

-- goals.project_id: a goal reads its progress only from a project you can see
-- (judged in the goal's own workspace: this sorts before 0052's trg_goals_v2_guard, which puts an
-- UPDATE's workspace_id back, so a statement that also sets it to null is judged by the old one)
create or replace function public.pa_trg_goals_project() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid := coalesce(case when tg_op = 'UPDATE' then old.workspace_id end, new.workspace_id);
begin
  if public.pa_is_client() and ws is not null and new.project_id is not null
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and public.pa_on(ws) and public.pa_rank(ws, new.project_id) < 1 then
    raise exception 'a goal can only read its progress from a project in its own workspace';
  end if;
  return new;
end; $$;

-- forms: a new public link is for people who can edit the form's project (rotate_form_public_token).
-- Someone who can't see the form is told what a missing one's id gets ('form not found'), so an id read
-- before its project narrowed doesn't say the form is still there.
create or replace function public.pa_trg_forms_token() returns trigger
language plpgsql security definer set search_path = public as $$
declare r integer;
begin
  if public.pa_is_client() and new.public_token is distinct from old.public_token and new.workspace_id is not null
     and public.pa_on(new.workspace_id) then
    r := public.pa_rank(new.workspace_id, new.project_id);
    if r < 1 then raise exception 'form not found'; end if;
    if r < 3 then raise exception 'not authorized'; end if;
  end if;
  return new;
end; $$;

-- notion_syncs (0046): into a project you can edit (notion_save_sync; the bin putting one back is the restore's to judge),
-- and never a new sync of a database closed to you (user_notion_database_hidden).
-- One database syncs with one project a workspace (notion_save_sync upserts on it): re-pointing a sync
-- is also taking it from its project, so that needs edit rights there too. Otherwise an admin who can't
-- see a Private project would take its sync over, and its pages would come into a project of theirs.
-- (Those rights as this workspace judges the project, pa_rank: one that has left the workspace by what
-- it had here (1h), as notion_delete_sync does, so its owners can sync the database elsewhere again.)
create or replace function public.pa_trg_notion_syncs() returns trigger
language plpgsql security definer set search_path = public as $$
declare kept boolean := false; pws uuid;
begin
  -- (the containment rule, 2t: never into a Members only or Private project while the switch is on,
  -- whoever writes it, the bin putting one back too. The bin's insert of a database that syncs with
  -- another project by now writes nothing (restore_from_trash says its sync wasn't restored): that one's
  -- row is held (FOR KEY SHARE) so it stays there until the restore ends)
  if tg_op = 'INSERT' and public.pa_restoring() then
    perform 1 from public.notion_syncs x where x.workspace_id = new.workspace_id and x.database_id = new.database_id for key share;
    kept := found;
  end if;
  -- (judged where the sync is, when its project is there too: a sync row names its workspace, and only
  -- notion_save_sync checks the two agree. One whose project is in another workspace by now (the bin
  -- putting back a project that moved there, with the sync its old workspace recorded) never runs
  -- (projectGone), and is that old workspace's, as 2t counts it; should the project go back, that's
  -- judged then. The project's row is held (FOR SHARE) first, so a move of it waits for this)
  if tg_op = 'INSERT' and not kept
     or tg_op = 'UPDATE' and (new.project_id is distinct from old.project_id or new.workspace_id is distinct from old.workspace_id) then
    select p.workspace_id into pws from public.projects p where p.id = new.project_id for share;
    if pws is not distinct from new.workspace_id and public.pa_notion_shut(new.workspace_id, new.project_id::text) then
      raise exception 'notion closed project'
        using hint = public.pa_notion_closed_text(case when public.pa_restoring() then 'restore project' else 'sync' end);
    end if;
  end if;
  if public.pa_is_client() and not public.pa_restoring() and new.workspace_id is not null and public.pa_on(new.workspace_id)
     and tg_op = 'UPDATE' and new.project_id is distinct from old.project_id
     and public.pa_rank(new.workspace_id, old.project_id::text) < 3 then
    raise exception 'already syncs' using hint = 'This Notion database already syncs with a project here that you can''t change.';
  end if;
  if public.pa_is_client() and not public.pa_restoring() and new.workspace_id is not null and public.pa_on(new.workspace_id)
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and not public.can_edit_project(new.project_id) then
    raise exception 'invalid project';
  end if;
  -- (a new sync of a database whose pages are a project's you can't see, its own sync removed or the
  -- project in the bin or deleted for good: notion_save_sync called directly, past the notion function's
  -- check, would bring them into a project of yours on its first run. One that syncs already is the
  -- update's to judge: notion_save_sync's insert goes on to update it)
  if public.pa_is_client() and not public.pa_restoring() and tg_op = 'INSERT' and new.workspace_id is not null
     and public.pa_on(new.workspace_id)
     and not exists (select 1 from public.notion_syncs s where s.workspace_id = new.workspace_id and s.database_id = new.database_id)
     and public.user_notion_database_hidden(auth.uid(), new.workspace_id, new.database_id) then
    raise exception 'invalid database' using hint = 'This Notion database''s pages are tasks in a project here that you can''t see.';
  end if;
  return new;
end; $$;

-- notion_links (0046), the containment rule (2t): while the switch is on, no task of a Members only or
-- Private project gets a Notion link of any kind (one someone adds, a sync's or an import's, the bin
-- putting one back), whoever writes it. The task's row is held (FOR SHARE) first, so a move of it waits
-- for this, or this for the move and judges where it went; pa_notion_shut holds the project's and the
-- workspace's. (A link whose task isn't a team task is 0046's guard's to refuse.)
create or replace function public.pa_trg_notion_links_closed() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  if not public.pa_notion_contain() or (tg_op = 'UPDATE' and new.task_id is not distinct from old.task_id) then return new; end if;
  -- (a link that's there already: the bin's insert of it writes nothing, and anyone else's fails. Held
  -- (FOR KEY SHARE) so it stays there until this ends)
  if tg_op = 'INSERT' then
    perform 1 from public.notion_links x where x.task_id = new.task_id and x.notion_page_id = new.notion_page_id for key share;
    if found then return new; end if;
  end if;
  select x.workspace_id, x.project_id into t from public.tasks x where x.id = new.task_id for share;
  if t.workspace_id is not null and public.pa_notion_shut(t.workspace_id, t.project_id) then
    -- (the bin putting back a link that was another workspace's when it went in: its task had moved here
    -- with it still recorded there, dead to it, and 2t passed it by. notion_links_guard has made it this
    -- workspace's by now, so it's left out, and the restore goes on, rather than refused for a link
    -- nobody here could see or remove)
    if tg_op = 'INSERT' and public.pa_restoring() and exists (
         select 1 from public.trash r
          where r.workspace_id = t.workspace_id and r.restored_at is null
            and r.snapshot -> 'notion_links' @> jsonb_build_array(jsonb_build_object('id', new.id))
            and not r.snapshot -> 'notion_links' @> jsonb_build_array(jsonb_build_object('id', new.id, 'workspace_id', t.workspace_id))) then
      return null;
    end if;
    -- (the bin putting it back: its project's own restore, while that project's entry is still in the bin,
    -- or a task's into a live project)
    raise exception 'notion closed project' using hint = public.pa_notion_closed_text(case
      when not public.pa_restoring() then 'link'
      when exists (select 1 from public.trash r where r.item_id = public.kanbo_uuid(t.project_id) and r.kind = 'project'
                     and r.workspace_id = t.workspace_id and r.restored_at is null) then 'restore project'
      else 'restore task' end);
  end if;
  return new;
end; $$;

-- tasks (the containment rule, 2t): a task with a Notion link never moves into a Members only or Private
-- project while the switch is on (refused, never unlinked): on its own, as a sub-task its parent takes
-- along (pa_trg_tasks_after's update comes through here), or re-parented under a task there (trg_tasks_pa
-- has moved it to its parent's project by now: it sorts first). Whoever writes it: the app, the API,
-- MCP, the planner, the bin. Its links in the workspace it's in, or going to (2t: a task moved to
-- another workspace leaves its links recorded in the one it left, where they never sync with it; moved
-- back, they're its again). A sub-task its parent takes along says so: the parent may have none.
create or replace function public.pa_trg_tasks_notion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null or not public.pa_notion_contain()
     or (new.project_id is not distinct from old.project_id and new.workspace_id is not distinct from old.workspace_id) then
    return new;
  end if;
  if exists (select 1 from public.notion_links l where l.task_id = new.id and l.workspace_id = new.workspace_id)
     and public.pa_notion_shut(new.workspace_id, new.project_id) then
    raise exception 'notion closed project' using hint = public.pa_notion_closed_text(
      case when pg_trigger_depth() > 1 and new.parent_id is not null
                and exists (select 1 from public.tasks p where p.id = new.parent_id and p.project_id is not distinct from new.project_id)
           then 'move sub-task' else 'move' end);
  end if;
  return new;
end; $$;

-- projects (the containment rule, 2t): one with a Notion sync, or a task with a Notion link, is never made
-- Members only or Private while the switch is on (Members only to Private included), nor taken, as one,
-- into a workspace whose switch is on, nor made as one there (whoever writes it: a new project under an
-- id that tasks here already name takes them in; the bin putting one back). Its tasks are found by their
-- project id in any spelling, as every rank reads it. The workspace's row is held (FOR NO KEY UPDATE:
-- this goes on to touch it) before looking, so the switch going on waits for this, or this for it; and
-- a page linked meanwhile to a task under an id no live project here has (or a linked task moved to
-- one) holds that row too (pa_notion_shut), so it waits for this and judges the project this made, or
-- this waits for it and finds its link. (Made narrower in place, the project's own row does that.)
-- Its syncs and its tasks' links in that workspace (2t): a project or a task moved here from another one
-- leaves its syncs and links recorded there, where they're counted should it go back.
create or replace function public.pa_trg_projects_notion() returns trigger
language plpgsql security definer set search_path = public as $$
declare on_ boolean;
begin
  if new.workspace_id is null or new.visibility = 'workspace' or not public.pa_notion_contain()
     or (tg_op = 'UPDATE' and new.visibility is not distinct from old.visibility and new.workspace_id is not distinct from old.workspace_id) then
    return new;
  end if;
  select w.project_access into on_ from public.workspaces w where w.id = new.workspace_id for no key update;
  if not coalesce(on_, false) then return new; end if;
  if exists (select 1 from public.notion_syncs s where s.project_id = new.id and s.workspace_id = new.workspace_id)
     or exists (select 1 from public.tasks t
                 where t.workspace_id = new.workspace_id and lower(t.project_id) = new.id::text
                   and exists (select 1 from public.notion_links l where l.task_id = t.id and l.workspace_id = new.workspace_id)) then
    raise exception 'notion closed project' using hint = public.pa_notion_closed_text(
      case when tg_op = 'INSERT' and public.pa_restoring() then 'restore project' else 'project' end);
  end if;
  return new;
end; $$;

-- update_asks (0053): only about a project the asker can see (ask_for_update)
create or replace function public.pa_trg_update_asks() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and public.pa_on(new.workspace_id) and public.pa_rank(new.workspace_id, new.project_id::text) < 1 then
    raise exception 'not authorized';
  end if;
  return new;
end; $$;

-- bill_rates (0055): a project's rate only for a project you can see (set_bill_rate's own answer). (Only
-- on a write of what it judges: deleting the account that last set a rate empties updated_by (on delete
-- set null), and Admin › Delete user runs as the platform admin, who may have no rank on the project.)
create or replace function public.pa_trg_bill_rates() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and new.project_id is not null and public.pa_on(new.workspace_id)
     and public.pa_rank(new.workspace_id, new.project_id::text) < 1 then
    raise exception 'not authorized';
  end if;
  return new;
end; $$;

-- meetings (0056): a stored agenda carries only what its audience may see (D17). Audience-open: a
-- team meeting, a Whole workspace project (or one where the switch is off); a leadership meeting,
-- Whole workspace or Members only. Each task and project is judged in its own workspace (a Group
-- meeting covers several); one that isn't a live task or project of the meeting's businesses goes.
create or replace function public.pa_audience_open(p_preset text, p_wss uuid[], p_ws uuid, p_visibility text)
returns boolean language sql stable set search_path = public as $$
  select p_ws is not null and p_ws = any (p_wss)
     and (not public.pa_on(p_ws) or p_visibility is null or p_visibility = 'workspace'
          or (p_preset = 'leadership' and p_visibility = 'members'));
$$;
-- (a task whose project has gone, to the bin or for good, keeps the visibility it had, as pa_rank_for
-- and closed_project_ids do: work written into a Private project after its delete never counts as loose)
create or replace function public.pa_task_audience_open(p_preset text, p_wss uuid[], p_task text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select public.pa_audience_open(p_preset, p_wss, t.workspace_id,
             case when p.id is not null then p.visibility
                  when public.kanbo_uuid(t.project_id) is not null then public.pa_gone_visibility(t.workspace_id, t.project_id, null) end)
      from public.tasks t
      left join public.projects p on p.id = public.kanbo_uuid(t.project_id) and p.workspace_id = t.workspace_id
     where t.id = public.kanbo_uuid(p_task)), false);
$$;
create or replace function public.pa_project_audience_open(p_preset text, p_wss uuid[], p_project text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select public.pa_audience_open(p_preset, p_wss, p.workspace_id, p.visibility)
      from public.projects p where p.id = public.kanbo_uuid(p_project)), false);
$$;
create or replace function public.pa_trg_meetings() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  wss uuid[] := coalesce(new.workspace_ids, '{}'::uuid[]) || new.workspace_id;
  item jsonb;
  out_a jsonb := '[]'::jsonb;
  k text;
  doc_project uuid;
begin
  if not exists (select 1 from unnest(wss) x where public.pa_on(x)) then return new; end if;
  -- the notes doc goes in a project its audience can open (when it's set or changed: a meeting whose
  -- notes project has since narrowed still ends, and its recap goes out without the doc)
  if new.doc_project_id is not null and (tg_op = 'INSERT' or new.doc_project_id is distinct from old.doc_project_id)
     and not public.pa_project_audience_open(new.preset, wss, new.doc_project_id::text) then
    raise exception 'not authorized';
  end if;
  if new.doc_id is not null and (tg_op = 'INSERT' or new.doc_id is distinct from old.doc_id)
     and to_regclass('public.project_docs') is not null then
    select d.project_id into doc_project from public.project_docs d where d.id = new.doc_id;
    if doc_project is not null and not public.pa_project_audience_open(new.preset, wss, doc_project::text) then
      raise exception 'not authorized';
    end if;
  end if;
  if tg_op = 'UPDATE' and new.agenda is not distinct from old.agenda then return new; end if;
  for item in select e from jsonb_array_elements(case when jsonb_typeof(new.agenda) = 'array' then new.agenda else '[]'::jsonb end) e loop
    if jsonb_typeof(item) = 'object' then
      if item ->> 'kind' = 'person' then
        foreach k in array array['done', 'today', 'blocked', 'holding'] loop
          if jsonb_typeof(item -> k) = 'array' then
            item := jsonb_set(item, array[k], coalesce((
              select jsonb_agg(x order by i) from jsonb_array_elements(item -> k) with ordinality a(x, i)
               where public.pa_task_audience_open(new.preset, wss, x ->> 'taskId')), '[]'::jsonb));
          end if;
        end loop;
      elsif item ->> 'kind' = 'risks' and jsonb_typeof(item -> 'risks') = 'array' then
        item := jsonb_set(item, '{risks}', coalesce((
          select jsonb_agg(x order by i) from jsonb_array_elements(item -> 'risks') with ordinality a(x, i)
           where not exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(x -> 'taskIds') = 'array'
                                                                          then x -> 'taskIds' else '[]'::jsonb end) tid
                              where not public.pa_task_audience_open(new.preset, wss, tid))), '[]'::jsonb));
      elsif item ->> 'kind' = 'projects' and jsonb_typeof(item -> 'projects') = 'array' then
        item := jsonb_set(item, '{projects}', coalesce((
          select jsonb_agg(x order by i) from jsonb_array_elements(item -> 'projects') with ordinality a(x, i)
           where public.pa_project_audience_open(new.preset, wss, x ->> 'id')), '[]'::jsonb));
      elsif item ->> 'kind' = 'actions' and jsonb_typeof(item -> 'actions') = 'array' then
        item := jsonb_set(item, '{actions}', coalesce((
          select jsonb_agg(x order by i) from jsonb_array_elements(item -> 'actions') with ordinality a(x, i)
           where coalesce(x ->> 'taskId', '') = '' or public.pa_task_audience_open(new.preset, wss, x ->> 'taskId')), '[]'::jsonb));
      end if;
    end if;
    out_a := out_a || jsonb_build_array(item);
  end loop;
  new.agenda := out_a;
  return new;
end; $$;

-- meeting_items (0056): an item's task is one you can see that the meeting's audience may see
create or replace function public.pa_trg_meeting_items() returns trigger
language plpgsql security definer set search_path = public as $$
declare m record; tws uuid;
begin
  if new.task_id is null or not public.pa_is_client() then return new; end if;
  if tg_op = 'UPDATE' and new.task_id is not distinct from old.task_id then return new; end if;
  select x.workspace_id into tws from public.tasks x where x.id = new.task_id;
  if tws is null or not public.pa_on(tws) then return new; end if;
  select x.preset, coalesce(x.workspace_ids, '{}'::uuid[]) || x.workspace_id as wss into m from public.meetings x where x.id = new.meeting_id;
  if not public.can_see_task(new.task_id) or not public.pa_task_audience_open(m.preset, m.wss, new.task_id::text) then
    raise exception 'not authorized';
  end if;
  return new;
end; $$;

do $trgfns$
declare f text;
begin
  foreach f in array array['pa_trg_workspaces_guard', 'pa_trg_workspaces_after', 'pa_trg_projects_guard', 'pa_trg_projects_after', 'pa_trg_project_members_guard',
                           'pa_trg_project_members_after', 'pa_trg_ws_members', 'pa_trg_tasks', 'pa_trg_tasks_after',
                           'pa_trg_status_update', 'pa_trg_status_update_comment', 'pa_trg_activity_gate', 'pa_trg_notify_queue_gate',
                           'pa_trg_webhook_deliveries_gate', 'pa_trg_webhooks_url', 'pa_trg_approval_reviewers', 'pa_trg_kudos',
                           'pa_trg_trash_capture', 'pa_trg_trash_restore', 'pa_trg_trash_purge', 'pa_trg_audit_events',
                           'pa_trg_goal_links', 'pa_trg_goals_project', 'pa_trg_forms_token', 'pa_trg_notion_syncs',
                           'pa_trg_update_asks', 'pa_trg_bill_rates', 'pa_trg_meetings', 'pa_trg_meeting_items',
                           'pa_trg_tasks_delete', 'pa_trg_projects_delete', 'pa_trg_approvals_cancel', 'pa_trg_notion_links_gone',
                           'pa_trg_notion_links_closed', 'pa_trg_tasks_notion', 'pa_trg_projects_notion'] loop
    execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.pa_mirror_contributors(uuid)', 'public.pa_detach_strays(uuid,uuid[])',
                           'public.pa_retire_notion_pages(uuid,text,jsonb,jsonb)',
                           'public.pa_audience_open(text,uuid[],uuid,text)',
                           'public.pa_task_audience_open(text,uuid[],text)', 'public.pa_project_audience_open(text,uuid[],text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $trgfns$;

-- 5b. every policy and every trigger, one list each (restore makes them, intact checks them)
-- G(x) = workspace_id is null or not (workspace_id = any ((select pa_gated_ws()))) or x: rows outside a
-- switched-on workspace, and every row an owner reads, cost one array test and no lookups.
create or replace function public.pa_policy_defs()
returns table (tbl text, name text, cmd text, permissive boolean, using_sql text, check_sql text)
language sql immutable set search_path = pg_catalog as $$
  with g(p) as (select 'workspace_id is null or not (workspace_id = any ((select public.pa_gated_ws())::uuid[])) or '::text),
  r(t, x) as (
    select a.t, 'public.pa_rank(workspace_id, project_id)'
      from unnest(array['tasks', 'sections', 'custom_field_defs', 'automation_rules', 'forms', 'status_updates']) a(t)
    union all select 'projects', 'public.pa_project_rank(workspace_id, id, visibility, owner_id)')
  -- A, B: rows that carry (workspace_id, project_id), and projects themselves
  select r.t, 'project access: read', 'select', false, g.p || r.x || ' >= 1', null::text from r, g
  union all select r.t, 'project access: create', 'insert', false, null, g.p || r.x || ' >= 3' from r, g
  union all select r.t, 'project access: edit', 'update', false, g.p || r.x || ' >= 3', g.p || r.x || ' >= 3' from r, g
  union all select r.t, 'project access: delete', 'delete', false, g.p || r.x || ' >= 3', null from r, g
  -- C: rows reached through a task (their reads go through tasks already)
  union all select 'comments', 'project access: comment', 'insert', false, null, 'public.can_comment_task(task_id)'
  union all select 'comments', 'project access: edit own', 'update', false,
                   'not public.pa_task_gated(task_id) or public.can_comment_task(task_id)',
                   'not public.pa_task_gated(task_id) or public.can_comment_task(task_id)'
  union all select 'comments', 'project access: delete own', 'delete', false,
                   'not public.pa_task_gated(task_id) or public.can_see_task(task_id)', null
  -- (a dependency's other end: its read rule (0042) asks only for the dependent task, so a member reading a
  -- Whole workspace task would learn the id of a Private task it waits on)
  union all select 'task_dependencies', 'project access: read', 'select', false,
                   'not public.pa_task_gated(depends_on) or public.can_see_task(depends_on)', null
  union all select 'attachments', 'project access: attach', 'insert', false, null, 'public.can_comment_task(task_id)'
  union all select 'attachments', 'project access: remove files', 'delete', false,
                   'not public.pa_task_gated(task_id) or public.can_see_task(task_id)', null
  -- D: an update's conversation (0054; reads and "seen by" follow can_see_status_update)
  union all select 'status_update_comments', 'project access: replies', 'insert', false, null, 'public.pa_status_update_rank(update_id) >= 2'
  union all select 'status_update_comments', 'project access: edit own', 'update', false,
                   'public.pa_status_update_rank(update_id) >= 2', 'public.pa_status_update_rank(update_id) >= 2'
  union all select 'status_update_reactions', 'project access: replies', 'insert', false, null, 'public.pa_status_update_rank(update_id) >= 2'
  -- E: other tables that name a project or a task
  union all select 'trash', 'project access: read', 'select', false, g.p || 'public.pa_snapshot_rank(workspace_id, project_id, access) >= 1', null from g
  union all select 'audit_events', 'project access: read', 'select', false,
                   'project_id is null or actor_id = auth.uid() or not (workspace_id = any ((select public.pa_gated_ws())::uuid[])) '
                   || 'or public.pa_snapshot_rank(workspace_id, project_id, access) >= 1', null
  union all select 'goal_links', 'project access: read', 'select', false,
                   'kind = ''view'' or ' || g.p || 'public.pa_goal_target_rank(workspace_id, kind, target_id) >= 1', null from g
  union all select 'saved_views', 'project access: read', 'select', false,
                   'not shared or user_id = auth.uid() or ' || g.p || 'public.pa_view_rank(workspace_id, query) >= 1', null from g
  union all select 'notion_syncs', 'project access: read', 'select', false, g.p || 'public.can_see_project(project_id)', null from g
  -- (a link to a page that a task you can't see is synced with or was imported from, live, in the bin or
  -- deleted for good: its page title is that task's, kept so by a two-way sync: pa_notion_page_hidden. Nor
  -- one added by hand to a database closed to you: its title is the database's: pa_notion_database_hidden)
  union all select 'notion_links', 'project access: read', 'select', false,
                   g.p || '(public.can_see_task(task_id) and not public.pa_notion_page_hidden(workspace_id, notion_page_id) '
                   || 'and (kind = ''synced'' or notion_database_id is not null '
                   || 'or not public.pa_notion_database_hidden(workspace_id, notion_page_id)))', null from g
  union all select 'notion_page_cache', 'project access: read', 'select', false,
                   g.p || 'exists (select 1 from public.notion_links l where l.workspace_id = notion_page_cache.workspace_id '
                   || 'and l.notion_page_id = notion_page_cache.notion_page_id)', null from g
  union all select 'bill_rates', 'project access: read', 'select', false,
                   'project_id is null or ' || g.p || 'public.pa_rank(workspace_id, project_id::text) >= 1', null from g
  -- F: the people a guest sees
  union all select 'workspace_members', 'project access: people', 'select', false,
                   'user_id = auth.uid() or not (workspace_id = any ((select public.pa_guest_ws())::uuid[])) '
                   || 'or (workspace_id::text || '':'' || coalesce(user_id::text, '''')) = any ((select public.pa_guest_people())::text[])', null
  union all select 'profiles', 'project access: people', 'select', false,
                   'id = auth.uid() or cardinality((select public.pa_guest_ws())) = 0 or public.pa_person_visible(id)', null
  -- G: this file's own tables
  union all select 'project_members', 'project members: read', 'select', true, 'user_id = auth.uid() or public.can_see_project(project_id)', null
  union all select 'project_members', 'api key scope', 'all', false, 'public.api_scope_ok(workspace_id)', 'public.api_scope_ok(workspace_id)'
  -- (a pending invite's grants: the workspace's owners and admins, on the projects they can see, and each project's managers)
  union all select 'project_member_invites', 'project invites: leads read', 'select', true,
                   '(public.ws_role(workspace_id) in (''owner'', ''admin'') and public.can_see_project(project_id)) or public.pa_can_manage(project_id)', null
  union all select 'project_member_invites', 'api key scope', 'all', false, 'public.api_scope_ok(workspace_id)', 'public.api_scope_ok(workspace_id)';
$$;

-- needs_column: the trigger is made only where that column is there
create or replace function public.pa_trigger_defs()
returns table (tbl text, name text, timing text, fn text, needs_column text)
language sql immutable set search_path = pg_catalog as $$
  values
    ('workspaces', 'trg_workspaces_pa_guard', 'before insert or update', 'pa_trg_workspaces_guard', null::text),
    ('workspaces', 'trg_workspaces_pa_after', 'after update of project_access, owner_id', 'pa_trg_workspaces_after', null),
    ('projects', 'trg_projects_pa_guard', 'before insert or update', 'pa_trg_projects_guard', null),
    ('projects', 'trg_projects_pa_after', 'after insert or update of visibility, owner_id, workspace_id', 'pa_trg_projects_after', null),
    -- (never on an update of added_by alone: that's the foreign key emptying it when its account is
    -- deleted, which can reach the row after its project has gone in the same statement)
    ('project_members', 'trg_project_members_guard', 'before insert or update of project_id, user_id, role, workspace_id', 'pa_trg_project_members_guard', null),
    ('project_members', 'trg_project_members_after', 'after insert or update of project_id, user_id, role, workspace_id or delete', 'pa_trg_project_members_after', null),
    ('workspace_members', 'trg_ws_members_pa', 'after update of role, status, user_id or delete', 'pa_trg_ws_members', null),
    ('tasks', 'trg_tasks_pa', 'before insert or update of project_id, parent_id, assignee_id, collaborators, followers, workspace_id, ai_reason', 'pa_trg_tasks', null),
    ('tasks', 'trg_tasks_pa_after', 'after update of project_id, parent_id, workspace_id', 'pa_trg_tasks_after', null),
    ('tasks', 'trg_tasks_pa_delete', 'before delete', 'pa_trg_tasks_delete', null),
    ('projects', 'trg_projects_pa_delete', 'before delete', 'pa_trg_projects_delete', null),
    ('status_updates', 'trg_status_update_pa', 'before insert or update', 'pa_trg_status_update', 'ask_user_ids'),
    ('status_update_comments', 'trg_status_update_comment_pa', 'before insert or update', 'pa_trg_status_update_comment', null),
    ('activity', 'trg_activity_pa_gate', 'before insert', 'pa_trg_activity_gate', null),
    ('notify_queue', 'trg_notify_queue_pa_gate', 'before insert', 'pa_trg_notify_queue_gate', null),
    ('webhook_deliveries', 'trg_webhook_deliveries_pa_gate', 'before insert or update of state', 'pa_trg_webhook_deliveries_gate', null),
    ('webhooks', 'trg_webhooks_pa_url', 'before update of url, url_set_by, active', 'pa_trg_webhooks_url', null),
    ('approval_reviewers', 'trg_approval_reviewers_pa', 'before insert or update of decision', 'pa_trg_approval_reviewers', null),
    ('approvals', 'trg_approvals_pa_cancel', 'before update of status', 'pa_trg_approvals_cancel', null),
    ('kudos', 'trg_kudos_pa', 'before insert or update of emoji, note', 'pa_trg_kudos', null),
    ('trash', 'trg_trash_pa_capture', 'before insert', 'pa_trg_trash_capture', null),
    ('trash', 'trg_trash_pa_restore', 'before update of restored_at', 'pa_trg_trash_restore', null),
    ('trash', 'trg_trash_pa_purge', 'before delete', 'pa_trg_trash_purge', null),
    ('audit_events', 'trg_audit_events_pa', 'before insert', 'pa_trg_audit_events', null),
    ('goal_links', 'trg_goal_links_pa', 'before insert', 'pa_trg_goal_links', null),
    ('goals', 'trg_goals_pa_project', 'before insert or update of project_id', 'pa_trg_goals_project', 'project_id'),
    ('forms', 'trg_forms_pa_token', 'before update of public_token', 'pa_trg_forms_token', 'public_token'),
    ('notion_syncs', 'trg_notion_syncs_pa', 'before insert or update of project_id, workspace_id', 'pa_trg_notion_syncs', null),
    ('notion_links', 'trg_notion_links_pa_gone', 'after delete', 'pa_trg_notion_links_gone', null),
    -- (the containment rule, 2t)
    ('notion_links', 'trg_notion_links_pa_closed', 'before insert or update of task_id', 'pa_trg_notion_links_closed', null),
    ('tasks', 'trg_tasks_pa_notion', 'before update of project_id, parent_id, workspace_id', 'pa_trg_tasks_notion', null),
    ('projects', 'trg_projects_pa_notion', 'before insert or update of visibility, workspace_id', 'pa_trg_projects_notion', null),
    ('update_asks', 'trg_update_asks_pa', 'before insert', 'pa_trg_update_asks', null),
    -- (never on an update of updated_by alone: that's the foreign key emptying it when its account is deleted)
    ('bill_rates', 'trg_bill_rates_pa', 'before insert or update of project_id, workspace_id, hourly_rate', 'pa_trg_bill_rates', null),
    ('meetings', 'trg_meetings_pa', 'before insert or update of agenda, doc_id, doc_project_id', 'pa_trg_meetings', null),
    ('meeting_items', 'trg_meeting_items_pa', 'before insert or update of task_id', 'pa_trg_meeting_items', null);
$$;
revoke execute on function public.pa_policy_defs() from public, anon, authenticated;
revoke execute on function public.pa_trigger_defs() from public, anon, authenticated;
do $svc$ begin
  grant execute on function public.pa_policy_defs() to service_role;
  grant execute on function public.pa_trigger_defs() to service_role;
exception when undefined_object then null; end $svc$;

-- 5c. (Re)makes everything: every policy above, the twenty-two bodies this file changes (each equal to
-- its old one while the switch is off, but for 0041's comment author trigger, which isn't about access),
-- and every trigger. Run below, and by 0025, 0041,
-- 0042, 0043, 0046, 0047, 0048, 0052, 0053, 0054, 0055 and 0056 when one of them is run again (they
-- drop policies or put an old body back). Safe in any state from 0047 on, and twice in a row.
-- Returns how many objects it made.
create or replace function public.project_access_restore()
returns integer language plpgsql set search_path = public as $restore$
declare
  d record;
  n integer := 0;
begin
  -- the policies (signed-in callers: a signed-out one has no rows here to narrow, and gets none, as before)
  for d in select * from public.pa_policy_defs() loop
    if to_regclass('public.' || d.tbl) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', d.name, d.tbl);
    execute format('create policy %I on public.%I as %s for %s to authenticated%s%s', d.name, d.tbl,
                   case when d.permissive then 'permissive' else 'restrictive' end, d.cmd,
                   case when d.using_sql is null then '' else ' using (' || d.using_sql || ')' end,
                   case when d.check_sql is null then '' else ' with check (' || d.check_sql || ')' end);
    n := n + 1;
  end loop;

  -- the helpers (0043's can_see_task, 0042's can_edit_task, 0047's can_see_project and can_edit_project):
  -- the rank where the switch is on; where it's off, each one's old rule word for word (they're
  -- asked once a row by policies that have no G() prefix: task plans, kudos, approvals, snoozes)
  execute $fn$
create or replace function public.can_see_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and case when public.pa_on(t.workspace_id) then public.pa_rank(t.workspace_id, t.project_id) >= 1
                                                 else public.is_member(t.workspace_id) end)));
$b$ $fn$;
  execute $fn$
create or replace function public.can_edit_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and case when public.pa_on(t.workspace_id) then public.pa_rank(t.workspace_id, t.project_id) >= 3
                                                 else public.can_write(t.workspace_id) end)));
$b$ $fn$;
  execute $fn$
create or replace function public.can_see_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and case when public.pa_on(p.workspace_id)
                                                 then public.pa_project_rank(p.workspace_id, p.id, p.visibility, p.owner_id) >= 1
                                                 else public.is_member(p.workspace_id) end)));
$b$ $fn$;
  execute $fn$
create or replace function public.can_edit_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and case when public.pa_on(p.workspace_id)
                                                 then public.pa_project_rank(p.workspace_id, p.id, p.visibility, p.owner_id) >= 3
                                                 else public.can_write(p.workspace_id) end)));
$b$ $fn$;
  revoke execute on function public.can_see_task(uuid) from public, anon;
  revoke execute on function public.can_edit_task(uuid) from public, anon;
  revoke execute on function public.can_see_project(uuid) from public, anon;
  revoke execute on function public.can_edit_project(uuid) from public, anon;
  grant execute on function public.can_see_task(uuid) to authenticated;
  grant execute on function public.can_edit_task(uuid) to authenticated;
  grant execute on function public.can_see_project(uuid) to authenticated;
  grant execute on function public.can_edit_project(uuid) to authenticated;
  n := n + 4;

  -- 0043's tasks_visible_to (the calendar feed; service only): the same, with the rank on team tasks
  -- in a switched-on workspace
  execute $fn$
create or replace function public.tasks_visible_to(p_user uuid)
returns setof public.tasks language sql security definer stable set search_path = public as $b$
  select t.* from public.tasks t
   where p_user is not null
     and not exists (select 1 from public.profiles p
                      where p.id = p_user and (coalesce(p.suspended, false) or not coalesce(p.approved, true)))
     and ((t.workspace_id is null and t.user_id = p_user)
       or (t.workspace_id is not null and (
             exists (select 1 from public.workspace_members m
                      where m.workspace_id = t.workspace_id and m.user_id = p_user and m.status = 'active')
          or exists (select 1 from public.workspaces w where w.id = t.workspace_id and w.owner_id = p_user))
           and (not (t.workspace_id = any ((select public.pa_gated_ws_for(p_user))::uuid[]))
                or public.pa_rank_for(p_user, t.workspace_id, t.project_id) >= 1)));
$b$ $fn$;
  revoke execute on function public.tasks_visible_to(uuid) from public, anon, authenticated;
  begin
    grant execute on function public.tasks_visible_to(uuid) to service_role;
  exception when undefined_object then null;
  end;
  n := n + 1;

  -- 0042's toggle_task_follow: following is for anyone who can see the task
  execute $fn$
create or replace function public.toggle_task_follow(p_task uuid, p_follow boolean default null)
returns text[] language plpgsql security definer set search_path = public as $b$
declare
  me     text := lower(auth.uid()::text);
  t      record;
  now_on boolean;
  result text[];
begin
  if me is null then raise exception 'not authorized'; end if;
  select id, user_id, workspace_id, coalesce(followers, '{}') as followers
    into t from public.tasks where id = p_task for update;
  if t.id is null or public.pa_task_rank(p_task) < 1 then
    raise exception 'task not found';          -- same answer whether it's gone or not yours
  end if;
  now_on := exists (select 1 from unnest(t.followers) f where lower(f) = me);
  if coalesce(p_follow, not now_on) = now_on then return t.followers; end if;  -- already so: no write
  update public.tasks x
     set followers = case when now_on
                          then array(select f from unnest(x.followers) with ordinality as a(f, i)
                                      where lower(f) is distinct from me order by i)
                          else coalesce(x.followers, '{}') || me end
   where x.id = p_task
  returning x.followers into result;
  return result;
end;
$b$ $fn$;
  revoke execute on function public.toggle_task_follow(uuid, boolean) from public, anon;
  grant execute on function public.toggle_task_follow(uuid, boolean) to authenticated;
  n := n + 1;

  -- 0025's toggle_comment_reaction: reacting is commenting (never a viewer)
  execute $fn$
create or replace function public.toggle_comment_reaction(p_comment uuid, p_emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $b$
declare
  v_uid  uuid := auth.uid();
  v_react jsonb;
  v_list  jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  -- caller must be allowed to comment on the comment's task
  if not exists (select 1 from public.comments c where c.id = p_comment and public.pa_task_rank(c.task_id) >= 2) then
    raise exception 'not authorized';
  end if;

  select coalesce(reactions, '{}'::jsonb) into v_react from public.comments where id = p_comment;
  v_list := coalesce(v_react -> p_emoji, '[]'::jsonb);

  if v_list ? v_uid::text then
    v_list := (select coalesce(jsonb_agg(x), '[]'::jsonb)
               from jsonb_array_elements_text(v_list) x where x <> v_uid::text);
  else
    v_list := v_list || to_jsonb(v_uid::text);
  end if;

  if jsonb_array_length(v_list) = 0 then
    v_react := v_react - p_emoji;
  else
    v_react := jsonb_set(v_react, array[p_emoji], v_list, true);
  end if;

  update public.comments set reactions = v_react where id = p_comment;
  return v_react;
end;
$b$ $fn$;
  revoke execute on function public.toggle_comment_reaction(uuid, text) from public, anon;
  grant execute on function public.toggle_comment_reaction(uuid, text) to authenticated;
  n := n + 1;

  -- 0054's can_see_status_update (only where 0054 is in): its rule, and the rank on team updates
  if to_regclass('public.status_update_comments') is not null then
    execute $fn$
create or replace function public.can_see_status_update(p_update uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.status_updates s
     where s.id = p_update
       and public.api_scope_ok(s.workspace_id)
       and ((s.workspace_id is null and s.user_id = auth.uid() and public.can_act())
         or (s.workspace_id is not null and public.is_member(s.workspace_id)
             and (not public.pa_on(s.workspace_id) or public.pa_rank(s.workspace_id, s.project_id) >= 1))));
$b$ $fn$;
    revoke execute on function public.can_see_status_update(uuid) from public, anon;
    grant execute on function public.can_see_status_update(uuid) to authenticated;
    n := n + 1;

    -- 0054's status_update_project_ok: with the switch on, a project the caller can't see is no answer
    -- either (it never says which hidden ids are live projects). Switch off: 0054's, line for line.
    execute $fn$
create or replace function public.status_update_project_ok(p_project text, p_ws uuid)
returns boolean language plpgsql security definer stable set search_path = public as $b$
begin
  if p_ws is null then return true; end if;
  if not public.is_member(p_ws) then return false; end if;
  if p_project is null or p_project !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  if public.pa_on(p_ws) and public.pa_rank(p_ws, p_project) < 1 then return false; end if;
  return exists (select 1 from public.projects p where p.id = p_project::uuid and p.workspace_id = p_ws);
end; $b$ $fn$;
    revoke execute on function public.status_update_project_ok(text, uuid) from public, anon;
    grant execute on function public.status_update_project_ok(text, uuid) to authenticated;
    n := n + 1;
  end if;

  -- 0053's ask_for_update (only where 0053 is in): with the switch on, a project the caller can't see
  -- gets 'not authorized' before anything is said about it (archived, its owner, an ask already made:
  -- the trigger on update_asks only ever saw the insert). Switch off: 0053's, line for line.
  if to_regclass('public.update_asks') is not null then
    execute $fn$
create or replace function public.ask_for_update(p_project uuid)
returns public.update_asks language plpgsql security definer set search_path = public as $b$
declare
  me uuid := auth.uid();
  p record;
  r public.update_asks;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select id, workspace_id, owner_id, archived_at into p from public.projects where id = p_project;
  if not found or p.workspace_id is null or coalesce(public.ws_role(p.workspace_id), 'none') not in ('owner', 'admin') then
    raise exception 'not authorized';
  end if;
  if public.pa_on(p.workspace_id) and public.pa_rank(p.workspace_id, p_project::text) < 1 then
    raise exception 'not authorized';
  end if;
  if p.archived_at is not null then raise exception 'not allowed: the project is archived'; end if;
  if p.owner_id is null then raise exception 'not allowed: no owner'; end if;
  if p.owner_id = me then raise exception 'not allowed: your own project'; end if;
  if not exists (select 1 from public.workspace_members m
                  where m.workspace_id = p.workspace_id and m.user_id = p.owner_id and m.status = 'active')
     and not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id) then
    raise exception 'not allowed: the owner has left';
  end if;
  -- a guest can't post an update, so there's nothing to ask them for
  if not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id)
     and not exists (select 1 from public.workspace_members m where m.workspace_id = p.workspace_id and m.user_id = p.owner_id
                      and m.status = 'active' and m.role in ('owner', 'admin', 'member')) then
    raise exception 'not allowed: the owner is a guest';
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
end; $b$ $fn$;
    revoke execute on function public.ask_for_update(uuid) from public, anon;
    grant execute on function public.ask_for_update(uuid) to authenticated;
    n := n + 1;
  end if;

  -- 0046's notion_status: with the switch on, sync_count counts only the syncs of projects the caller
  -- can see (the notion_syncs rows they read), never a Members only or Private project's. Switch off: 0046's.
  execute $fn$
create or replace function public.notion_status(p_ws uuid)
returns jsonb language sql security definer stable set search_path = public as $b$
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
    'sync_count',        (select count(*) from public.notion_syncs s
                           where s.workspace_id = p_ws and (not public.pa_on(p_ws) or public.can_see_project(s.project_id)))) end
  from (select 1) as one
  left join public.workspace_integrations i on i.workspace_id = p_ws;
$b$; $fn$;
  revoke execute on function public.notion_status(uuid) from public, anon;
  grant execute on function public.notion_status(uuid) to authenticated;
  n := n + 1;

  -- 0046's notion_set_sync_enabled and notion_delete_sync: with the switch on, the sync of a project the
  -- caller can't edit is 'sync not found', what an id that isn't there gets, before anything else. They
  -- answer with the whole sync (its last error names tasks), and a sync's id outlives sight of its
  -- project: every member read it while the project was open, and a synced task moved out keeps it on
  -- its link. (Switching it back on would send a Private project's tasks to its Notion database again.)
  -- The project is judged as this workspace judges it (pa_rank): one that has left the workspace (to
  -- someone's Personal list or another workspace: a direct write, the app never moves one) by what it
  -- had here (1h), so the workspace's owners can still remove the sync it left behind (can_edit_project
  -- asks the project's new home, and that sync would fail every run, never to be removed).
  -- Switch off: 0046's, line for line.
  execute $fn$
create or replace function public.notion_set_sync_enabled(p_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $b$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  if public.pa_on(s.workspace_id) and public.pa_rank(s.workspace_id, s.project_id::text) < 3 then
    raise exception 'sync not found';
  end if;
  if coalesce(p_enabled, false) and not exists (select 1 from public.workspace_integrations i
                                                 where i.workspace_id = s.workspace_id and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  update public.notion_syncs set enabled = coalesce(p_enabled, false), updated_at = now() where id = p_id returning * into s;
  return public.notion_sync_json(s);
end; $b$ $fn$;
  revoke execute on function public.notion_set_sync_enabled(uuid, boolean) from public, anon;
  grant execute on function public.notion_set_sync_enabled(uuid, boolean) to authenticated;
  n := n + 1;
  execute $fn$
create or replace function public.notion_delete_sync(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $b$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  if public.pa_on(s.workspace_id) and public.pa_rank(s.workspace_id, s.project_id::text) < 3 then
    raise exception 'sync not found';
  end if;
  update public.notion_links set kind = 'reference', sync_id = null where sync_id = p_id;
  delete from public.notion_syncs where id = p_id;
  return true;
end; $b$ $fn$;
  revoke execute on function public.notion_delete_sync(uuid) from public, anon;
  grant execute on function public.notion_delete_sync(uuid) to authenticated;
  n := n + 1;

  -- 0046's notion_link_page: with the switch on, never to a page that's a synced task's the caller can't
  -- see ('invalid page', as for an id that isn't a page): the answer, and the page cache through the
  -- new link, would carry that task's current title (pa_notion_page_hidden). Nor to a database closed to
  -- them (user_notion_database_hidden): the notion function links a database pasted as a page, and its
  -- answer and cached title would be the database's, which notion_syncs keeps from them. Nor, the
  -- containment rule (2t), to a task of a Members only or Private project, before anything else is
  -- said about the page (trg_notion_links_pa_closed refuses the row itself). Switch off: 0046's.
  execute $fn$
create or replace function public.notion_link_page(p_task uuid, p_page_id text)
returns jsonb language plpgsql security definer set search_path = public as $b$
declare pid text := public.notion_norm_id(p_page_id); ws uuid; proj text; l public.notion_links;
begin
  if auth.uid() is null or not public.can_edit_task(p_task) then raise exception 'task not found'; end if;
  select t.workspace_id, t.project_id into ws, proj from public.tasks t where t.id = p_task;
  if ws is null then raise exception 'notion links need a team task'; end if;
  if not exists (select 1 from public.workspace_integrations i where i.workspace_id = ws and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  if public.pa_notion_shut(ws, proj) then
    raise exception 'notion closed project' using hint = public.pa_notion_closed_text('link');
  end if;
  if pid is null then raise exception 'invalid page'; end if;
  if public.pa_on(ws) and (public.pa_notion_page_hidden(ws, pid) or public.user_notion_database_hidden(auth.uid(), ws, pid)) then
    raise exception 'invalid page';
  end if;
  select * into l from public.notion_links where task_id = p_task and notion_page_id = pid;
  if l.id is null then
    if (select count(*) from public.notion_links x where x.task_id = p_task) >= 20 then raise exception 'too many links'; end if;
    insert into public.notion_links (workspace_id, task_id, notion_page_id, kind, created_by)
    values (ws, p_task, pid, 'reference', auth.uid())
    returning * into l;
  end if;
  return public.notion_link_json(l);
end; $b$ $fn$;
  revoke execute on function public.notion_link_page(uuid, text) from public, anon;
  grant execute on function public.notion_link_page(uuid, text) to authenticated;
  n := n + 1;

  -- 0055's set_bill_rate (only where 0055 is in): with the switch on, a project the caller can't see is
  -- 'not authorized' before anything else is said about it (its rate checked: that would say it's a
  -- project of this workspace; trg_bill_rates_pa only ever saw the write). Switch off: 0055's.
  if to_regclass('public.bill_rates') is not null then
    execute $fn$
create or replace function public.set_bill_rate(p_ws uuid, p_project uuid, p_rate numeric)
returns public.bill_rates language plpgsql security definer set search_path = public as $b$
declare r public.bill_rates;
begin
  if public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p_project is not null and not exists (select 1 from public.projects p where p.id = p_project and p.workspace_id = p_ws) then
    raise exception 'not authorized';
  end if;
  if p_project is not null and public.pa_on(p_ws) and public.pa_rank(p_ws, p_project::text) < 1 then
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
end; $b$; $fn$;
    revoke execute on function public.set_bill_rate(uuid, uuid, numeric) from public, anon;
    grant execute on function public.set_bill_rate(uuid, uuid, numeric) to authenticated;
    n := n + 1;
  end if;

  -- 0056's start_meeting and add_meeting_item (only where 0056 is in): with the switch on, a notes
  -- project the caller can't see (or the meeting's audience can't open), or a task they can't see, is
  -- 'not authorized' before the day's limit, 'already running' or the item cap say it's a live project
  -- (or task) of this workspace (trg_meetings_pa and trg_meeting_items_pa only ever saw the write).
  -- Switch off: 0056's.
  if to_regclass('public.meetings') is not null then
    execute $fn$
create or replace function public.start_meeting(p_ws uuid, p_preset text, p_title text, p_workspace_ids uuid[],
  p_agenda jsonb, p_attendees uuid[], p_doc_project uuid, p_previous uuid)
returns public.meetings language plpgsql security definer set search_path = public as $b$
declare
  me uuid := auth.uid();
  wss uuid[];
  t text := btrim(coalesce(p_title, ''));
  prev uuid;
  who uuid;
  r public.meetings;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_ws is null or p_preset is null or p_preset not in ('team', 'leadership') then raise exception 'invalid meeting'; end if;
  wss := array(select distinct x from unnest(array[p_ws] || coalesce(p_workspace_ids, '{}'::uuid[])) x where x is not null order by 1);
  if cardinality(wss) > 12 or (p_preset = 'team' and cardinality(wss) <> 1) then raise exception 'invalid meeting'; end if;
  if not public.meeting_can_read(p_preset, p_ws, wss) then raise exception 'not authorized'; end if;
  if char_length(t) < 1 or char_length(t) > 120 then raise exception 'invalid meeting'; end if;
  if p_agenda is null or jsonb_typeof(p_agenda) <> 'array' or jsonb_array_length(p_agenda) > 200
     or octet_length(p_agenda::text) > 262144 then
    raise exception 'invalid agenda';
  end if;
  if p_doc_project is not null and not public.meeting_doc_ok(p_ws, null, p_doc_project) then raise exception 'not authorized'; end if;
  if p_doc_project is not null and exists (select 1 from unnest(wss) x where public.pa_on(x))
     and (public.pa_rank(p_ws, p_doc_project::text) < 1 or not public.pa_project_audience_open(p_preset, wss, p_doc_project::text)) then
    raise exception 'not authorized';
  end if;
  if (select count(*) from public.meetings m where m.started_by = me and m.started_at > now() - interval '1 day') >= 40 then
    raise exception 'too many meetings';
  end if;
  -- one live meeting of a kind over the same businesses at a time, whichever of them hosts it (a Group
  -- meeting's host can differ week to week); one left running for 12 hours is closed, without a recap
  perform pg_advisory_xact_lock(hashtext('kanbo.meeting:' || array_to_string(wss, ',') || ':' || p_preset));
  update public.meetings set status = 'ended', ended_at = now(), updated_at = now()
   where workspace_id = any (wss) and workspace_ids = wss and preset = p_preset and status = 'live' and started_at < now() - interval '12 hours';
  if exists (select 1 from public.meetings m
              where m.workspace_id = any (wss) and m.workspace_ids = wss and m.preset = p_preset and m.status = 'live') then
    raise exception 'already running';
  end if;
  -- the meeting before: the last of this kind over the same businesses (its actions open this one)
  select m.id into prev from public.meetings m
   where m.id = p_previous and m.workspace_id = any (wss) and m.workspace_ids = wss and m.preset = p_preset and m.status = 'ended';
  insert into public.meetings (workspace_id, workspace_ids, preset, title, agenda, presenter_id, started_by, previous_id, doc_project_id)
    values (p_ws, wss, p_preset, t, p_agenda, me, me, prev, p_doc_project)
    returning * into r;
  insert into public.meeting_attendees (meeting_id, user_id, invited, joined_at) values (r.id, me, true, now());
  for who in select distinct x from unnest(coalesce(p_attendees, '{}'::uuid[])) x where x is not null and x <> me limit 100 loop
    if public.meeting_user_ok(who, p_preset, p_ws, wss) then
      insert into public.meeting_attendees (meeting_id, user_id, invited) values (r.id, who, true) on conflict do nothing;
    end if;
  end loop;
  return r;
end; $b$; $fn$;
    revoke execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) from public, anon;
    grant execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) to authenticated;
    execute $fn$
create or replace function public.add_meeting_item(p_meeting uuid, p_kind text, p_body text, p_agenda_key text,
  p_owner uuid, p_due date, p_task uuid)
returns public.meeting_items language plpgsql security definer set search_path = public as $b$
declare
  m public.meetings;
  r public.meeting_items;
begin
  m := public.meeting_for_caller(p_meeting);
  if not public.meeting_open_for_items(m) then raise exception 'meeting closed'; end if;
  perform public.meeting_item_ok(m, p_kind, p_body, p_agenda_key, p_owner, p_due, p_task);
  if p_task is not null and public.pa_on(m.workspace_id) and not public.can_see_task(p_task) then raise exception 'not authorized'; end if;
  if (select count(*) from public.meeting_items i where i.meeting_id = p_meeting) >= 300 then raise exception 'too many items'; end if;
  insert into public.meeting_items (meeting_id, workspace_id, kind, body, agenda_key, owner_id, due_on, task_id, created_by)
    values (p_meeting, m.workspace_id, p_kind, btrim(p_body), p_agenda_key, p_owner, p_due, p_task, auth.uid())
    returning * into r;
  return r;
end; $b$; $fn$;
    revoke execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) from public, anon;
    grant execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) to authenticated;
    n := n + 2;
  end if;

  -- 0048's kanbo_realtime_allowed (0056 makes the same body, with a comment of its own; only where 0048 is
  -- in): with the switch on, a task's live channel takes a 'typing' broadcast only from someone who can
  -- comment on it (D7: a viewer, a viewer guest too, can't, so their name never shows as typing there);
  -- reading it and saying you're there stay anyone who can see it. Switch off: 0056's, line for line.
  if to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is not null then
    execute $fn$
create or replace function public.kanbo_realtime_allowed(p_topic text, p_extension text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public as $b$
declare
  v_kind text;
  v_id uuid;
  v_project uuid;
  v_archived timestamptz;
begin
  if auth.uid() is null or p_topic is null or not public.can_act() then return false; end if;
  if p_topic !~ '^kanbo:(task|doc|project|meeting):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  if p_write and p_extension is distinct from 'presence' and p_extension is distinct from 'broadcast' then return false; end if;
  v_kind := split_part(p_topic, ':', 2);
  v_id := split_part(p_topic, ':', 3)::uuid;
  if v_kind = 'task' then
    if p_write and p_extension = 'broadcast' and public.pa_on((select t.workspace_id from public.tasks t where t.id = v_id)) then
      return public.can_comment_task(v_id);
    end if;
    return public.can_see_task(v_id);
  elsif v_kind = 'project' then
    if p_write and p_extension <> 'presence' then return false; end if;
    return public.can_see_project(v_id);
  elsif v_kind = 'meeting' then
    -- (0056: who's in the room; nothing is broadcast on it)
    if p_write and p_extension <> 'presence' then return false; end if;
    if to_regprocedure('public.can_see_meeting(uuid)') is null then return false; end if;
    return public.can_see_meeting(v_id);
  end if;
  select d.project_id, d.archived_at into v_project, v_archived from public.project_docs d where d.id = v_id;
  if v_project is null then return false; end if;
  if p_write and p_extension = 'broadcast' then
    return v_archived is null and public.can_edit_project(v_project);
  end if;
  return public.can_see_project(v_project);
end; $b$ $fn$;
    revoke all on function public.kanbo_realtime_allowed(text, text, boolean) from public, anon;
    grant execute on function public.kanbo_realtime_allowed(text, text, boolean) to authenticated;
    n := n + 1;
  end if;

  -- 0047's approval_json: with the switch on, can_decide also needs comment rights on the task (D7: a
  -- reviewer who's only a viewer now, or can't see it, isn't offered a decision trg_approval_reviewers_pa
  -- would refuse), and an owner or admin who isn't its asker is offered can_cancel only with edit rights
  -- on it (trg_approvals_pa_cancel). Switch off: 0047's, line for line.
  execute $fn$
create or replace function public.approval_json(a public.approvals)
returns jsonb language sql security definer stable set search_path = public as $b$
  select jsonb_build_object(
    'id', a.id, 'task_id', a.task_id, 'workspace_id', a.workspace_id,
    'requested_by', a.requested_by,
    'requested_by_name', case when a.requested_by is not null then public.kanbo_person_name(a.requested_by) end,
    'title', a.title, 'note', a.note, 'attachment_id', a.attachment_id,
    'status', a.status, 'rule', a.rule,
    'created_at', a.created_at, 'updated_at', a.updated_at, 'resolved_at', a.resolved_at,
    'reviewers', coalesce((select jsonb_agg(jsonb_build_object(
                             'user_id', r.user_id, 'name', public.kanbo_person_name(r.user_id),
                             'decision', r.decision, 'comment', r.comment, 'decided_at', r.decided_at)
                           order by r.decided_at nulls last, public.kanbo_person_name(r.user_id))
                            from public.approval_reviewers r where r.approval_id = a.id), '[]'::jsonb),
    'can_decide', a.status = 'pending' and auth.uid() is not null and public.is_member(a.workspace_id)
                  and exists (select 1 from public.approval_reviewers r where r.approval_id = a.id and r.user_id = auth.uid())
                  and (not public.pa_on(a.workspace_id) or public.pa_task_rank(a.task_id) >= 2),
    'can_cancel', a.status = 'pending' and auth.uid() is not null and public.can_act()
                  and (a.requested_by = auth.uid()
                       or (public.ws_role(a.workspace_id) in ('owner', 'admin')
                           and (not public.pa_on(a.workspace_id) or public.pa_task_rank(a.task_id) >= 3))));
$b$ $fn$;
  revoke execute on function public.approval_json(public.approvals) from public, anon, authenticated;
  n := n + 1;

  -- 0046's list_webhook_deliveries: with the switch on, only deliveries of events about work the caller can
  -- see (or about no project): an owner's endpoint hears of Private projects, and its log mustn't tell
  -- everyone else when they changed. Switch off: 0046's, line for line.
  execute $fn$
create or replace function public.list_webhook_deliveries(p_id uuid, p_limit integer default 25)
returns jsonb language plpgsql security definer stable set search_path = public as $b$
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
               and (w.workspace_id is null or not public.pa_on(w.workspace_id) or x.event = 'ping'
                    or coalesce((select public.pa_rank_or_binned(auth.uid(), w.workspace_id, public.pa_webhook_project(o.event, o.payload))
                                   from public.webhook_outbox o where o.id = x.outbox_id
                                    and public.pa_webhook_project(o.event, o.payload) is not null), 1) >= 1)
             order by x.created_at desc, x.id limit greatest(1, least(coalesce(p_limit, 25), 100))) d), '[]'::jsonb);
end; $b$ $fn$;
  revoke execute on function public.list_webhook_deliveries(uuid, integer) from public, anon;
  grant execute on function public.list_webhook_deliveries(uuid, integer) to authenticated;
  n := n + 1;

  -- 0046's webhook_json: with the switch on, a team endpoint's full address only for its viewer and the
  -- workspace's owner (pa_webhook_url_shown); another admin who manages it reads it masked (can_manage
  -- stays true). Switch off: 0046's, line for line.
  execute $fn$
create or replace function public.webhook_json(w public.webhooks)
returns jsonb language sql security definer stable set search_path = public as $b$
  select jsonb_build_object(
    'id', w.id, 'workspace_id', w.workspace_id,
    'url', case when c.manage and public.pa_webhook_url_shown(w) then w.url else public.webhook_url_masked(w.url) end,
    'description', w.description,
    'events', to_jsonb(w.events), 'active', w.active,
    'created_by', w.created_by, 'created_by_name', public.kanbo_person_name(w.created_by),
    'failure_count', w.failure_count, 'last_status', w.last_status, 'last_error', w.last_error,
    'last_delivery_at', w.last_delivery_at, 'disabled_at', w.disabled_at, 'disabled_reason', w.disabled_reason,
    'created_at', w.created_at, 'updated_at', w.updated_at,
    'can_manage', c.manage)
    from (select coalesce(public.webhook_can_manage(w), false) as manage) c;
$b$ $fn$;
  revoke execute on function public.webhook_json(public.webhooks) from public, anon, authenticated;
  n := n + 1;

  -- 0046's update_webhook: an address sent back as webhook_json showed it masked leaves the address as it is
  -- (pa_webhook_url_kept: the app's edit form, prefilled with it, sends it back with every save), rather than
  -- pointing the endpoint at the masked text. Otherwise 0046's, line for line.
  execute $fn$
create or replace function public.update_webhook(p_id uuid, p_url text default null, p_events text[] default null,
                                                 p_active boolean default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $b$
declare w public.webhooks; u text := btrim(coalesce(p_url, '')); evs text[]; d text;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
  if public.pa_webhook_url_kept(w, p_url) then p_url := null; end if;
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
end; $b$ $fn$;
  revoke execute on function public.update_webhook(uuid, text, text[], boolean, text) from public, anon;
  grant execute on function public.update_webhook(uuid, text, text[], boolean, text) to authenticated;
  n := n + 1;

  -- 0047's restore_from_trash: with the switch on, edit rights on the item's project first (what isn't
  -- yours to restore is 'not found', restored or not), and a task whose project has gone comes back
  -- somewhere with the audience it had (pa_restore_landing). Already restored, it says where the task is
  -- now only to someone who can see it there (moved since into a project they can't see: no project).
  -- A project whose Notion database syncs with another project by now comes back without its sync
  -- (trash_restore_project keeps the one there), and says so: in the sync's own workspace (one another
  -- workspace recorded, for a project that moved here, comes back as that workspace's, 2t). Switch off:
  -- 0047's, line for line.
  execute $fn$
create or replace function public.restore_from_trash(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $b$
declare
  me   uuid := auth.uid();
  r    public.trash;
  heir uuid;
  res  jsonb;
  prev text;
  pid  text;
  land jsonb;
  lost boolean := false;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into r from public.trash where id = p_id for update;
  if r.id is null
     or not ((r.workspace_id is null and r.user_id = me)
             or (r.workspace_id is not null and public.can_write(r.workspace_id))) then
    raise exception 'not found';                 -- same answer whether it's gone or not yours
  end if;
  if r.workspace_id is not null and public.pa_on(r.workspace_id)
     and public.pa_snapshot_rank(r.workspace_id, r.project_id, r.access) < 3 then
    raise exception 'not found';
  end if;
  if r.restored_at is not null then
    return jsonb_build_object('id', r.id, 'kind', r.kind, 'item_id', r.item_id, 'status', 'already_restored',
                              'project_id', case when r.kind = 'project' then r.item_id::text
                                                 else (select t.project_id from public.tasks t where t.id = r.item_id
                                                          and (r.workspace_id is null or not public.pa_on(r.workspace_id)
                                                               or (t.workspace_id = r.workspace_id and public.can_see_task(t.id)))) end,
                              'note', null, 'counts', r.summary -> 'counts');
  end if;
  heir := case when r.workspace_id is null then r.user_id
               else (select w.owner_id from public.workspaces w where w.id = r.workspace_id) end;
  if r.kind <> 'project' then land := public.pa_restore_landing(r.workspace_id, r.snapshot, r.project_id, r.access); end if;
  if r.kind = 'project' and r.workspace_id is not null and public.pa_on(r.workspace_id) then
    lost := exists (select 1 from jsonb_array_elements(case when jsonb_typeof(r.snapshot -> 'notion_syncs') = 'array'
                                                            then r.snapshot -> 'notion_syncs' else '[]'::jsonb end) s
                      join public.notion_syncs n on n.workspace_id = coalesce(public.kanbo_uuid(s ->> 'workspace_id'), r.workspace_id)
                                                and n.database_id = s ->> 'database_id'
                                                and n.id is distinct from public.kanbo_uuid(s ->> 'id'));
  end if;
  prev := coalesce(current_setting('kanbo.restoring', true), '');
  perform set_config('kanbo.restoring', 'on', true);
  if r.kind = 'project' then res := public.trash_restore_project(r.snapshot, heir);
  else res := public.trash_restore_tasks(coalesce(land -> 'snapshot', r.snapshot), heir);
  end if;
  perform set_config('kanbo.restoring', prev, true);
  if land ->> 'note' is not null then
    res := res || jsonb_build_object('note', concat_ws(' ', land ->> 'note', nullif(res ->> 'note', '')));
  end if;
  if lost then
    res := res || jsonb_build_object('note', concat_ws(' ', nullif(res ->> 'note', ''),
                                       'Its Notion sync wasn''t restored: that database syncs with another project now.'));
  end if;
  update public.trash set restored_at = now(), restored_by = me where id = r.id;
  delete from public.trash_ids where trash_id = r.id;               -- its ids are in use again
  pid := case when r.kind = 'project' then r.item_id::text
              else (select t.project_id from public.tasks t where t.id = r.item_id) end;
  if r.workspace_id is not null then
    perform public.audit_log(r.workspace_id, r.kind || '.restored', r.kind, r.item_id::text, r.title,
                             jsonb_build_object('trash_id', r.id, 'project_id', pid, 'note', res ->> 'note'));
  end if;
  return jsonb_build_object('id', r.id, 'kind', r.kind, 'item_id', r.item_id, 'status', 'restored',
                            'project_id', pid, 'note', res ->> 'note', 'counts', r.summary -> 'counts');
end;
$b$ $fn$;
  revoke execute on function public.restore_from_trash(uuid) from public, anon;
  grant execute on function public.restore_from_trash(uuid) to authenticated;
  n := n + 1;

  -- 0041's comment_author_from_profile (trg_comment_author): not about access, and the same whatever the
  -- switch says. Under a client's role 0041 took every update of a comment for its author's own edit: a
  -- reaction (toggle_comment_reaction) gave the comment the reactor's name, and Admin › Delete user
  -- (0029's admin_delete_user: the platform admin, a client) had its emptying of a commenter's author
  -- (0041's before_user_delete, then the foreign key) put back, so the account was never deleted. Now
  -- only the author's own edit takes their name; anyone else's keeps the author and their name; and the
  -- author empties only once their account has gone (the foreign key's SET NULL, which runs after the
  -- auth.users row has, as 0054's update replies have it), never by a client's own update.
  execute $fn$
create or replace function public.comment_author_from_profile() returns trigger
language plpgsql security definer set search_path = public as $b$
declare n text;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then return new; end if;
  if tg_op = 'UPDATE' then
    new.task_id := old.task_id;
    if not (new.user_id is null and not exists (select 1 from auth.users u where u.id = old.user_id)) then
      new.user_id := old.user_id;
    end if;
    if old.user_id is distinct from auth.uid() then
      new.author_name := old.author_name;
      return new;
    end if;
  end if;
  select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into n from public.profiles p where p.id = auth.uid();
  new.author_name := coalesce(n, (select email from auth.users where id = auth.uid()), 'Someone');
  return new;
end; $b$ $fn$;
  n := n + 1;

  -- the triggers
  for d in select * from public.pa_trigger_defs() loop
    if to_regclass('public.' || d.tbl) is null then continue; end if;
    if d.needs_column is not null and not exists (
         select 1 from pg_catalog.pg_attribute a
          where a.attrelid = to_regclass('public.' || d.tbl) and a.attname = d.needs_column and a.attnum > 0 and not a.attisdropped) then
      continue;
    end if;
    execute format('drop trigger if exists %I on public.%I', d.name, d.tbl);
    execute format('create trigger %I %s on public.%I for each row execute function public.%I()', d.name, d.timing, d.tbl, d.fn);
    n := n + 1;
  end loop;
  return n;
end; $restore$;
revoke execute on function public.project_access_restore() from public, anon, authenticated;

-- 5d. Is all of it in place? Every policy (restrictive where it should be, row security on) on every
-- table that's here; each changed helper's body is this file's; every trigger; projects.visibility
-- has no default (the guard fills it).
create or replace function public.project_access_intact()
returns boolean language sql stable set search_path = pg_catalog, public as $$
  select
    not exists (
      select 1 from public.pa_policy_defs() d
       where to_regclass('public.' || d.tbl) is not null
         and not exists (
           select 1 from pg_catalog.pg_policy p join pg_catalog.pg_class c on c.oid = p.polrelid
            where p.polrelid = to_regclass('public.' || d.tbl) and p.polname = d.name and c.relrowsecurity
              and p.polpermissive = d.permissive
              and p.polcmd = case d.cmd when 'select' then 'r' when 'insert' then 'a' when 'update' then 'w'
                                        when 'delete' then 'd' else '*' end))
    and not exists (
      select 1 from public.pa_trigger_defs() d
       where to_regclass('public.' || d.tbl) is not null
         and (d.needs_column is null or exists (
               select 1 from pg_catalog.pg_attribute a
                where a.attrelid = to_regclass('public.' || d.tbl) and a.attname = d.needs_column and a.attnum > 0 and not a.attisdropped))
         and not exists (select 1 from pg_catalog.pg_trigger t
                          where t.tgrelid = to_regclass('public.' || d.tbl) and t.tgname = d.name and not t.tgisinternal))
    and not exists (
      select 1 from unnest(array['public.can_see_task(uuid)', 'public.can_edit_task(uuid)', 'public.can_see_project(uuid)',
                                 'public.can_edit_project(uuid)', 'public.tasks_visible_to(uuid)',
                                 'public.toggle_task_follow(uuid,boolean)', 'public.toggle_comment_reaction(uuid,text)',
                                 'public.restore_from_trash(uuid)', 'public.approval_json(public.approvals)',
                                 'public.list_webhook_deliveries(uuid,integer)', 'public.webhook_json(public.webhooks)',
                                 'public.update_webhook(uuid,text,text[],boolean,text)']
                           || case when to_regclass('public.status_update_comments') is not null
                                   then array['public.can_see_status_update(uuid)', 'public.status_update_project_ok(text,uuid)'] else '{}'::text[] end
                           || case when to_regclass('public.update_asks') is not null
                                   then array['public.ask_for_update(uuid)'] else '{}'::text[] end
                           || array['public.notion_status(uuid)', 'public.notion_set_sync_enabled(uuid,boolean)',
                                    'public.notion_delete_sync(uuid)', 'public.notion_link_page(uuid,text)']
                           || case when to_regclass('public.bill_rates') is not null
                                   then array['public.set_bill_rate(uuid,uuid,numeric)'] else '{}'::text[] end
                           || case when to_regclass('public.meetings') is not null
                                   then array['public.start_meeting(uuid,text,text,uuid[],jsonb,uuid[],uuid,uuid)',
                                              'public.add_meeting_item(uuid,text,text,text,uuid,date,uuid)'] else '{}'::text[] end
                           || case when to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is not null
                                   then array['public.kanbo_realtime_allowed(text,text,boolean)'] else '{}'::text[] end) f(sig)
       where not coalesce((select position('public.pa_' in p.prosrc) > 0 from pg_catalog.pg_proc p
                            where p.oid = to_regprocedure(f.sig)), false))
    and coalesce((select position('old.user_id is distinct from auth.uid()' in p.prosrc) > 0 from pg_catalog.pg_proc p
                   where p.oid = to_regprocedure('public.comment_author_from_profile()')), false)
    and not exists (select 1 from pg_catalog.pg_attrdef ad join pg_catalog.pg_attribute a on a.attrelid = ad.adrelid and a.attnum = ad.adnum
                     where ad.adrelid = 'public.projects'::regclass and a.attname = 'visibility')
    and exists (select 1 from pg_catalog.pg_attribute a
                 where a.attrelid = 'public.projects'::regclass and a.attname = 'visibility' and a.attnotnull);
$$;
revoke execute on function public.project_access_intact() from public, anon, authenticated;
do $svc$ begin
  grant execute on function public.project_access_intact() to service_role;
exception when undefined_object then null; end $svc$;

do $restore$
begin
  perform public.project_access_restore();
end $restore$;

-- 5e. people who left before this file (or while its undo file had the triggers out): what
-- trg_ws_members_pa does when someone leaves (2p). Their team projects go to the workspace's owner.
do $departed$
begin
  perform public.pa_forget_departed();
end $departed$;

-- 5f. the bin's summaries already written (before this file, or while its undo file had the trigger
-- out): none names a project or a parent of someone else's (2q). Every run; nothing changes twice.
do $bin$
begin
  perform public.pa_scrub_bin(null);
end $bin$;

-- ---------- 6. the history's projects (the first run only) ----------
-- Rows written before this file: the project they're about (their access wasn't recorded).
do $history$
begin
  if exists (select 1 from public.schema_migrations where version = '0058') then return; end if;
  update public.audit_events e set project_id = x.pid
    from (select a.id, case a.target_kind
                 when 'project' then a.target_id
                 when 'task' then coalesce(a.detail ->> 'project_id',
                                           (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(a.target_id)))
                 when 'doc' then (select d.project_id::text from public.project_docs d where d.id = public.kanbo_uuid(a.target_id))
                 else a.detail ->> 'project_id' end as pid
            from public.audit_events a where a.project_id is null) x
   where e.id = x.id and x.pid is not null;
  -- (a task deleted for good before this file: its purge row names no project, its task.deleted row does)
  update public.audit_events e set project_id = x.pid
    from (select distinct on (a.id) a.id, b.project_id as pid
            from public.audit_events a
            join public.audit_events b on b.workspace_id = a.workspace_id and b.target_kind = a.target_kind
                                       and b.target_id = a.target_id and b.project_id is not null
           where a.project_id is null and a.target_kind = 'task'
           order by a.id, b.created_at desc) x
   where e.id = x.id;
end $history$;

-- ---------- 7. done: record it ----------
insert into public.schema_migrations (version) values ('0058') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0058')                         as recorded,
--   public.project_access_intact()                                                                  as rules_intact,
--   (select count(*) from public.projects where visibility is null) = 0                             as visibility_filled,
--   not exists (select 1 from public.workspaces where project_access)                                as everyone_still_off,
--   not has_table_privilege('authenticated', 'public.project_members', 'insert')
--     and not has_table_privilege('authenticated', 'public.project_members', 'delete')               as members_through_functions,
--   not has_table_privilege('authenticated', 'public.project_ids_retired', 'select')                 as retired_ids_private,
--   not has_table_privilege('authenticated', 'public.notion_pages_retired', 'select')                as retired_pages_private,
--   not has_table_privilege('authenticated', 'public.project_departures', 'select')                  as departures_private,
--   has_function_privilege('authenticated', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute')
--     and not has_function_privilege('anon', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute') as switch_fn,
--   not has_function_privilege('authenticated', 'public.project_access_restore()', 'execute')        as restore_private,
--   not has_function_privilege('authenticated', 'public.user_project_rank(uuid,uuid,text)', 'execute') as service_helpers_private,
--   public.api_scope_intact()                                                                       as api_keys_still_scoped,
--   not exists (select 1 from public.projects p where p.workspace_id is not null and p.owner_id is not null
--                 and not exists (select 1 from public.workspace_members m where m.workspace_id = p.workspace_id
--                                    and m.user_id = p.owner_id and m.status = 'active')
--                 and not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id)) as owners_still_in,
--   (select count(*) from public.project_members) >= 0                                              as members_table,
--   not exists (select 1 from public.workspaces w where w.project_access
--                 and exists (select 1 from public.pa_notion_blockers(w.id)))                         as notion_contained;
--
-- everyone_still_off is true right after the first run. It turns false once an owner switches a
-- workspace on in Settings › Workspace › Project access: that's expected. notion_contained: no workspace
-- that's switched on has a Members only or Private project with a Notion sync or Notion-linked tasks
-- (2t). Before switching a workspace on, its owner's list is
--   select * from public.pa_notion_blockers('<ws id>');
-- ============================================================
-- <<<<<<<<<< end of 0058_project_access.sql <<<<<<<<<<

-- ============================================================
-- CHECK: one row. Every column true, and "not true" = none.
-- ============================================================
with
  v0051 as (
    select
      exists (select 1 from public.schema_migrations where version = '0051')                          as recorded,
      (select count(*) from pg_policies where schemaname = 'public' and policyname = 'guests: no team reports'
        and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
        and tablename in ('goals', 'portfolios')) = 2                                                 as guest_lock,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'status_updates' and column_name = 'author_id')                       as author_column,
      exists (select 1 from pg_trigger where tgname = 'trg_status_update_author' and not tgisinternal)  as author_trigger,
      not has_function_privilege('authenticated', 'public.guest_lock_restore()', 'execute')            as restore_private
  ),
  v0052 as (
    select
      exists (select 1 from public.schema_migrations where version = '0052')                           as recorded,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'goals'
        and column_name in ('owner_id', 'contributors', 'period', 'period_start', 'period_end', 'start_value', 'direction',
                            'confidence', 'kind', 'visibility', 'archived_at', 'icon', 'color', 'pace', 'weight')) = 15  as goal_columns,
      public.goal_rules_intact()                                                                         as rules_intact,
      public.guest_lock_intact()                                                                         as guest_lock,
      (select count(*) from pg_publication_tables where pubname = 'supabase_realtime'
        and tablename in ('goal_checkins', 'goal_links')) = 2                                            as live_sync,
      not exists (select 1 from public.goals where workspace_id is not null and owner_id is null
                   and exists (select 1 from public.workspace_members m where m.workspace_id = goals.workspace_id
                                and m.user_id = goals.user_id and m.status = 'active' and m.role <> 'guest')) as owners_filled,
      not has_function_privilege('authenticated', 'public.goal_rules_restore()', 'execute')
      and not has_function_privilege('authenticated', 'public.goals_v2_guard()', 'execute')
      and not has_function_privilege('authenticated', 'public.goal_search_restore()', 'execute')
      and not has_function_privilege('authenticated', 'public.goals_delete_guard()', 'execute')          as hooks_private,
      exists (select 1 from pg_trigger where tgname = 'trg_goals_delete_guard')                          as key_results_kept,
      exists (select 1 from information_schema.columns where table_schema = 'public'
        and table_name = 'goal_checkins' and column_name = 'prev_value')
      and exists (select 1 from pg_trigger t where t.tgname = 'trg_goal_checkins_apply'
        and t.tgtype & 16 = 16)                                                                          as checkin_records,
      to_regprocedure('public.kanbo_fts(text, text)') is null
      or (pg_get_functiondef(to_regprocedure('public.search_all(text, jsonb, integer)')) like '%''goal''::text%'
          and not (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.search_all(text, jsonb, integer)'))
          and to_regclass('public.goals_fts_idx') is not null)                                           as goals_in_search
  ),
  v0053 as (
    select
      exists (select 1 from public.schema_migrations where version = '0053')                            as recorded,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'workspaces' and column_name = 'update_rhythm')                          as workspace_day,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'projects' and column_name = 'update_rhythm')                            as project_day,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'status_updates'
        and column_name in ('recovery_plan', 'target_date')) = 2                                            as plan_columns,
      (select relrowsecurity from pg_class where oid = 'public.update_asks'::regclass)                     as asks_rls,
      not has_table_privilege('authenticated', 'public.update_asks', 'insert')                             as asks_no_client_writes,
      has_function_privilege('authenticated', 'public.ask_for_update(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.ask_for_update(uuid)', 'execute')                   as ask_signed_in_only,
      has_function_privilege('authenticated', 'public.set_update_rhythm(uuid,jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.set_update_rhythm(uuid,jsonb)', 'execute')          as rhythm_signed_in_only,
      (to_regclass('public.notify_queue') is null
        or pg_get_constraintdef((select oid from pg_constraint where conname = 'notify_queue_shape')) like '%update%') as queue_takes_update
  ),
  v0054 as (
    select
      exists (select 1 from public.schema_migrations where version = '0054')                            as recorded,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'status_updates'
        and column_name in ('edited_at', 'sections', 'ask_user_ids')) = 3                                    as update_columns,
      (select count(*) from pg_policies where schemaname = 'public' and tablename = 'status_updates'
        and permissive = 'RESTRICTIVE' and policyname like 'updates:%') = 3                                  as authors_only,
      (select bool_and(relrowsecurity) from pg_class where oid in ('public.status_update_comments'::regclass,
        'public.status_update_reactions'::regclass, 'public.status_update_views'::regclass,
        'public.portfolio_updates'::regclass))                                                              as new_tables_rls,
      not has_table_privilege('authenticated', 'public.status_update_views', 'insert')                     as views_through_function,
      has_function_privilege('authenticated', 'public.mark_status_updates_seen(uuid[])', 'execute')
        and not has_function_privilege('anon', 'public.mark_status_updates_seen(uuid[])', 'execute')       as seen_signed_in_only,
      'status_update.posted' = any (public.webhook_event_names())                                          as webhook_event,
      (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'portfolios'
        and column_name in ('owner_id', 'description', 'target_date', 'follower_ids', 'color', 'emoji')) = 6  as portfolio_details,
      exists (select 1 from pg_trigger where tgname = 'trg_status_update_after' and not tgisinternal)      as notices,
      exists (select 1 from pg_trigger where tgname = 'trg_status_update_comment_gone' and not tgisinternal) as comment_notices_go,
      (to_regclass('public.notify_queue') is null
        or pg_get_constraintdef((select oid from pg_constraint where conname = 'notify_queue_shape')) like '%update%') as queue_takes_update
  ),
  v0055 as (
    select
      exists (select 1 from public.schema_migrations where version = '0055')                                  as recorded,
      (select relrowsecurity from pg_class where oid = 'public.member_availability'::regclass)                  as hours_rls,
      (select relrowsecurity from pg_class where oid = 'public.time_off'::regclass)                             as time_off_rls,
      (select relrowsecurity from pg_class where oid = 'public.time_off_notes'::regclass)                       as reasons_rls,
      (select relrowsecurity from pg_class where oid = 'public.bill_rates'::regclass)                           as rates_rls,
      not has_table_privilege('authenticated', 'public.member_availability', 'insert')
        and not has_table_privilege('authenticated', 'public.time_off', 'update')
        and not has_table_privilege('authenticated', 'public.time_off_notes', 'insert')
        and not has_table_privilege('authenticated', 'public.bill_rates', 'update')                             as no_client_writes,
      not has_table_privilege('anon', 'public.time_off_notes', 'select')
        and not has_table_privilege('anon', 'public.bill_rates', 'select')                                      as anon_reads_nothing,
      has_function_privilege('authenticated', 'public.set_member_availability(uuid,uuid,numeric,smallint[],smallint,smallint)', 'execute')
        and not has_function_privilege('anon', 'public.set_member_availability(uuid,uuid,numeric,smallint[],smallint,smallint)', 'execute') as hours_fn,
      has_function_privilege('authenticated', 'public.save_time_off(uuid,uuid,uuid,date,date,text,text)', 'execute')
        and not has_function_privilege('anon', 'public.save_time_off(uuid,uuid,uuid,date,date,text,text)', 'execute')                       as time_off_fn,
      not has_function_privilege('authenticated', 'public.on_team_at(uuid,uuid)', 'execute')
        and to_regprocedure('public.leads_person(uuid)') is null                                                as helpers,
      (select count(*) from information_schema.columns where table_schema = 'public' and column_name = 'workspace_id'
        and table_name in ('time_off', 'time_off_notes')) = 2                                                    as recorded_at,
      has_function_privilege('authenticated', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')
        and not has_function_privilege('anon', 'public.set_bill_rate(uuid,uuid,numeric)', 'execute')                                    as rates_fn,
      (not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
        or (select puballtables from pg_publication where pubname = 'supabase_realtime')
        or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename in ('member_availability', 'time_off')) = 2)                                           as streams
  ),
  v0056 as (
    select
      exists (select 1 from public.schema_migrations where version = '0056')                                  as recorded,
      (select bool_and(relrowsecurity) from pg_class where oid in ('public.meetings'::regclass,
        'public.meeting_attendees'::regclass, 'public.meeting_items'::regclass))                                as rls,
      not has_table_privilege('authenticated', 'public.meetings', 'insert')
        and not has_table_privilege('authenticated', 'public.meetings', 'update')
        and not has_table_privilege('authenticated', 'public.meeting_items', 'insert')
        and not has_table_privilege('authenticated', 'public.meeting_attendees', 'insert')                       as no_client_writes,
      not has_table_privilege('anon', 'public.meetings', 'select')
        and not has_table_privilege('anon', 'public.meeting_items', 'select')                                    as anon_reads_nothing,
      has_function_privilege('authenticated', 'public.start_meeting(uuid,text,text,uuid[],jsonb,uuid[],uuid,uuid)', 'execute')
        and not has_function_privilege('anon', 'public.start_meeting(uuid,text,text,uuid[],jsonb,uuid[],uuid,uuid)', 'execute') as start_fn,
      has_function_privilege('authenticated', 'public.end_meeting(uuid,uuid,uuid)', 'execute')
        and not has_function_privilege('anon', 'public.end_meeting(uuid,uuid,uuid)', 'execute')                 as end_fn,
      not has_function_privilege('authenticated', 'public.meeting_user_ok(uuid,text,uuid,uuid[])', 'execute')  as internal_helpers,
      exists (select 1 from pg_trigger where tgname = 'trg_meeting_after_delete' and not tgisinternal)          as recaps_follow,
      (not exists (select 1 from pg_publication where pubname = 'supabase_realtime')
        or (select puballtables from pg_publication where pubname = 'supabase_realtime')
        or (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
             and tablename in ('meetings', 'meeting_attendees', 'meeting_items')) = 3)                            as streams,
      (to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is null
        or (select prosrc like '%kanbo:(task|doc|project|meeting)%' from pg_proc
             where oid = 'public.kanbo_realtime_allowed(text,text,boolean)'::regprocedure))                     as room_presence
  ),
  v0057 as (
    select
      exists (select 1 from public.schema_migrations where version = '0057')                             as recorded,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'workspace_members' and column_name = 'joined_at')                       as joined_at,
      exists (select 1 from pg_trigger where tgname = 'trg_member_joined_at')                              as joined_trigger,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'workspaces' and column_name = 'rollout')                                 as rollout_column,
      has_function_privilege('authenticated', 'public.set_workspace_rollout(uuid,jsonb)', 'execute')
        and not has_function_privilege('anon', 'public.set_workspace_rollout(uuid,jsonb)', 'execute')    as rollout_signed_in_only,
      has_function_privilege('authenticated', 'public.workspace_activity(uuid)', 'execute')
        and not has_function_privilege('anon', 'public.workspace_activity(uuid)', 'execute')             as activity_signed_in_only,
      (select relrowsecurity from pg_class where oid = 'public.workspace_handovers'::regclass)            as handovers_rls,
      not has_table_privilege('authenticated', 'public.workspace_handovers', 'select')
        and not has_table_privilege('authenticated', 'public.workspace_handovers', 'insert')             as handovers_no_client_access,
      has_function_privilege('authenticated', 'public.admin_provision_business(text,text,text,text)', 'execute')
        and not has_function_privilege('anon', 'public.admin_provision_business(text,text,text,text)', 'execute') as provision_signed_in_only,
      exists (select 1 from pg_trigger where tgname = 'trg_member_handover')
        and exists (select 1 from pg_trigger where tgname = 'trg_member_handover_withdrawn')               as handover_triggers,
      exists (select 1 from information_schema.columns where table_schema = 'public'
               and table_name = 'workspace_handovers' and column_name = 'member_id')                     as handover_member,
      public.public_mail_domain('outlook.co.uk') and public.public_mail_domain('virginmedia.com')
        and public.public_mail_domain('btconnect.com') and public.public_mail_domain('privaterelay.appleid.com')
        and not public.public_mail_domain('harbourfit.co.uk')                                            as public_domains,
      has_function_privilege('authenticated', 'public.admin_workspace_adoption()', 'execute')
        and not has_function_privilege('anon', 'public.admin_workspace_adoption()', 'execute')          as adoption_signed_in_only
  ),
  v0058 as (
    select
      exists (select 1 from public.schema_migrations where version = '0058')                         as recorded,
      public.project_access_intact()                                                                  as rules_intact,
      (select count(*) from public.projects where visibility is null) = 0                             as visibility_filled,
      not exists (select 1 from public.workspaces where project_access)                                as everyone_still_off,
      not has_table_privilege('authenticated', 'public.project_members', 'insert')
        and not has_table_privilege('authenticated', 'public.project_members', 'delete')               as members_through_functions,
      not has_table_privilege('authenticated', 'public.project_ids_retired', 'select')                 as retired_ids_private,
      not has_table_privilege('authenticated', 'public.notion_pages_retired', 'select')                as retired_pages_private,
      not has_table_privilege('authenticated', 'public.project_departures', 'select')                  as departures_private,
      has_function_privilege('authenticated', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute')
        and not has_function_privilege('anon', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute') as switch_fn,
      not has_function_privilege('authenticated', 'public.project_access_restore()', 'execute')        as restore_private,
      not has_function_privilege('authenticated', 'public.user_project_rank(uuid,uuid,text)', 'execute') as service_helpers_private,
      public.api_scope_intact()                                                                       as api_keys_still_scoped,
      not exists (select 1 from public.projects p where p.workspace_id is not null and p.owner_id is not null
                    and not exists (select 1 from public.workspace_members m where m.workspace_id = p.workspace_id
                                       and m.user_id = p.owner_id and m.status = 'active')
                    and not exists (select 1 from public.workspaces w where w.id = p.workspace_id and w.owner_id = p.owner_id)) as owners_still_in,
      (select count(*) from public.project_members) >= 0                                              as members_table,
      not exists (select 1 from public.workspaces w where w.project_access
                    and exists (select 1 from public.pa_notion_blockers(w.id)))                         as notion_contained
  )
select
  (select bool_and(e.value = 'true'::jsonb) from v0051 v, jsonb_each(to_jsonb(v)) e) as "0051",
  (select bool_and(e.value = 'true'::jsonb) from v0052 v, jsonb_each(to_jsonb(v)) e) as "0052",
  (select bool_and(e.value = 'true'::jsonb) from v0053 v, jsonb_each(to_jsonb(v)) e) as "0053",
  (select bool_and(e.value = 'true'::jsonb) from v0054 v, jsonb_each(to_jsonb(v)) e) as "0054",
  (select bool_and(e.value = 'true'::jsonb) from v0055 v, jsonb_each(to_jsonb(v)) e) as "0055",
  (select bool_and(e.value = 'true'::jsonb) from v0056 v, jsonb_each(to_jsonb(v)) e) as "0056",
  (select bool_and(e.value = 'true'::jsonb) from v0057 v, jsonb_each(to_jsonb(v)) e) as "0057",
  (select bool_and(e.value = 'true'::jsonb) from v0058 v, jsonb_each(to_jsonb(v)) e) as "0058",
  (select coalesce(string_agg(k, ', '), 'none') from (
    select '0051 ' || e.key as k from v0051 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0052 ' || e.key as k from v0052 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0053 ' || e.key as k from v0053 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0054 ' || e.key as k from v0054 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0055 ' || e.key as k from v0055 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0056 ' || e.key as k from v0056 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0057 ' || e.key as k from v0057 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
    union all
    select '0058 ' || e.key as k from v0058 v, jsonb_each(to_jsonb(v)) e where e.value is distinct from 'true'::jsonb
  ) m) as "not true";
