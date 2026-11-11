-- ============================================================
-- KANBO — database updates 0051 to 0057 in ONE paste.
-- Made by scripts/bundle-migrations.mjs from: 0051_guest_leadership_lock.sql, 0052_goals_v2.sql, 0053_update_rhythm.sql, 0054_update_conversation.sql, 0055_shared_availability.sql, 0056_meetings.sql, 0057_adoption_health.sql.
-- Don't edit this file: change the migration files, then run
--   node scripts/bundle-migrations.mjs 0051 0057
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
  )
select
  (select bool_and(e.value = 'true'::jsonb) from v0051 v, jsonb_each(to_jsonb(v)) e) as "0051",
  (select bool_and(e.value = 'true'::jsonb) from v0052 v, jsonb_each(to_jsonb(v)) e) as "0052",
  (select bool_and(e.value = 'true'::jsonb) from v0053 v, jsonb_each(to_jsonb(v)) e) as "0053",
  (select bool_and(e.value = 'true'::jsonb) from v0054 v, jsonb_each(to_jsonb(v)) e) as "0054",
  (select bool_and(e.value = 'true'::jsonb) from v0055 v, jsonb_each(to_jsonb(v)) e) as "0055",
  (select bool_and(e.value = 'true'::jsonb) from v0056 v, jsonb_each(to_jsonb(v)) e) as "0056",
  (select bool_and(e.value = 'true'::jsonb) from v0057 v, jsonb_each(to_jsonb(v)) e) as "0057",
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
  ) m) as "not true";
