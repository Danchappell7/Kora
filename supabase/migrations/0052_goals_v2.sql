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
--                admins, the goal's owner and its contributors only.
--        edit    a team goal, delete it, post a check-in or link work to it:
--                owners and admins, the goal's owner and its named
--                contributors (any member could, 0041:213-226).
--        hand over (owner, contributors, visibility): owners and admins and
--                the goal's owner.
--        create  a company goal (a team goal with no parent): owners and
--                admins. A key result under a goal: whoever may edit that goal.
--        personal goals stay their creator's alone.
--   3. goal_checkins: a value, confidence and a one-line note. The author is
--      the person posting (never the request), can't be changed and empties
--      when that account is deleted ("Former member"). The newest check-in
--      sets the goal's current value (and its confidence); deleting the
--      newest puts the one before back.
--   4. goal_links: one goal to many projects, tasks or (shared) saved views,
--      always in the goal's own workspace (a personal goal: your own personal
--      work). goals.project_id stays (the project its % comes from) and is
--      copied into goal_links once.
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
grant execute on function public.goal_visible(uuid, text, uuid, uuid[]) to authenticated;
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
  return new;
end; $$;
revoke execute on function public.goals_v2_guard() from public, anon, authenticated;
drop trigger if exists trg_goals_v2_guard on public.goals;
create trigger trg_goals_v2_guard before insert or update on public.goals
  for each row execute function public.goals_v2_guard();

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
create index if not exists goal_checkins_goal_idx on public.goal_checkins (goal_id, created_at desc);
create index if not exists goal_checkins_ws_idx on public.goal_checkins (workspace_id);
create index if not exists goal_checkins_author_idx on public.goal_checkins (author_id);

-- The goal's workspace, the author (the person posting) and the time are the server's.
-- Afterwards none of them change, except the author emptying once that account is deleted.
create or replace function public.goal_checkins_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare signed_in boolean := coalesce(auth.role(), '') in ('authenticated', 'anon'); g record;
begin
  if tg_op = 'INSERT' then
    select x.workspace_id, x.owner_id, x.user_id, x.contributors into g from public.goals x where x.id = new.goal_id;
    -- someone who may not check in on this goal is refused by row security (and learns nothing here)
    if not found or (signed_in and not public.goal_editable(g.workspace_id, g.owner_id, g.contributors, g.user_id)) then
      if signed_in then return new; end if;
      raise exception 'no such goal';
    end if;
    new.workspace_id := g.workspace_id;
    new.note := nullif(btrim(coalesce(new.note, '')), '');
    if signed_in then
      new.author_id := auth.uid(); new.created_at := now();
    else
      new.author_id := coalesce(new.author_id, g.owner_id, g.user_id);
    end if;
    return new;
  end if;
  new.goal_id := old.goal_id; new.workspace_id := old.workspace_id;
  new.note := nullif(btrim(coalesce(new.note, '')), '');
  if signed_in then new.created_at := old.created_at; end if;
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
-- person posting (they may edit the goal, or they couldn't have posted).
create or replace function public.goal_checkins_apply() returns trigger
language plpgsql set search_path = public as $$
declare latest record;
begin
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.goal_checkins c
                    where c.goal_id = new.goal_id and c.id <> new.id
                      and (c.created_at > new.created_at or (c.created_at = new.created_at and c.id > new.id))) then
      update public.goals set current = new.value, confidence = coalesce(new.confidence, confidence) where id = new.goal_id;
    end if;
    return new;
  end if;
  -- the newest one taken back: the one before it is the value again
  if not exists (select 1 from public.goal_checkins c
                  where c.goal_id = old.goal_id
                    and (c.created_at > old.created_at or (c.created_at = old.created_at and c.id > old.id))) then
    select c.value, c.confidence into latest from public.goal_checkins c
     where c.goal_id = old.goal_id order by c.created_at desc, c.id desc limit 1;
    if found then
      update public.goals set current = latest.value, confidence = coalesce(latest.confidence, confidence) where id = old.goal_id;
    end if;
  end if;
  return old;
end; $$;
revoke execute on function public.goal_checkins_apply() from public, anon, authenticated;
drop trigger if exists trg_goal_checkins_apply on public.goal_checkins;
create trigger trg_goal_checkins_apply after insert or delete on public.goal_checkins
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
    using (public.goal_visible(workspace_id, visibility, owner_id, contributors));
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
--   and not has_function_privilege('authenticated', 'public.goals_v2_guard()', 'execute')              as hooks_private;
-- ============================================================
