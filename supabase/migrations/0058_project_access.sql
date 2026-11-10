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
--      they're on, and only those projects' people.
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
--      set_project_member(), remove_project_member() and set_invite_projects()
--      (a guest invited straight onto projects). Every access change touches
--      workspaces.project_access_changed_at, so every open app reloads.
--   6. Turning the switch off again is the rollback: instant, nothing lost.
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
-- 1f. whose access a webhook's deliveries follow once its address changes hands (null: its creator's)
alter table public.webhooks add column if not exists url_set_by uuid references auth.users (id) on delete set null;

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
-- purged (0047), and mustn't fall to the loose rule meanwhile.
create or replace function public.pa_rank_for(p_user uuid, p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case
      when not coalesce(w.project_access, false) then public.pa_rank_core(false, r.role, null, false, null)
      when p.id is not null then public.pa_rank_core(true, r.role, p.visibility, p.owner_id = p_user,
                                   (select m.role from public.project_members m where m.project_id = p.id and m.user_id = p_user))
      when b.access is not null then public.pa_rank_core(true, r.role, coalesce(b.access ->> 'visibility', 'workspace'),
                                   b.access ->> 'owner' = p_user::text,
                                   (select e ->> 1 from jsonb_array_elements(case when jsonb_typeof(b.access -> 'members') = 'array'
                                                                                  then b.access -> 'members' else '[]'::jsonb end) e
                                     where e ->> 0 = p_user::text limit 1))
      else public.pa_rank_core(true, r.role, null, false, null) end
      from public.workspaces w
      cross join lateral (select public.user_ws_role(p_user, w.id) as role) r
      left join public.projects p on p.id = public.kanbo_uuid(p_project) and p.workspace_id = w.id
      left join lateral (
        select x.access from public.trash x
         where p.id is null and public.kanbo_uuid(p_project) is not null
           and x.item_id = public.kanbo_uuid(p_project) and x.kind = 'project' and x.workspace_id = w.id and x.restored_at is null
         order by x.deleted_at desc limit 1) b on true
     where w.id = p_ws and p_user is not null), 0);
$$;
create or replace function public.pa_rank(p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_rank_for(auth.uid(), p_ws, p_project);
$$;
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
create or replace function public.pa_task_rank(p_task uuid)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when t.workspace_id is null
                then case when t.user_id = auth.uid() and public.can_act() then 3 else 0 end
                else public.pa_rank(t.workspace_id, t.project_id) end
      from public.tasks t where t.id = p_task), 0);
$$;
create or replace function public.pa_status_update_rank(p_update uuid)
returns integer language sql security definer stable set search_path = public as $$
  select coalesce((
    select case when s.workspace_id is null
                then case when s.user_id = auth.uid() and public.can_act() then 3 else 0 end
                else public.pa_rank(s.workspace_id, s.project_id) end
      from public.status_updates s where s.id = p_update), 0);
$$;

-- 2d. the bin's and the history's captured access: {"v":1,"visibility":…,"owner":"<uuid>","members":[["<uuid>","editor"],…]}
create or replace function public.pa_access_snapshot(p_ws uuid, p_project text)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when p.id is null then null else jsonb_build_object(
    'v', 1, 'visibility', p.visibility, 'owner', p.owner_id,
    'members', coalesce((select jsonb_agg(jsonb_build_array(m.user_id, m.role) order by m.created_at, m.id)
                           from public.project_members m where m.project_id = p.id), '[]'::jsonb)) end
    from (select 1) one
    left join public.projects p on p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws;
$$;
-- someone's rank on what a bin or history row names: the live project while it's there, else what was captured
create or replace function public.pa_snapshot_rank_for(p_user uuid, p_ws uuid, p_project text, p_access jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select case
    when p_user is null or p_ws is null then 0
    when exists (select 1 from public.projects p where p.id = public.kanbo_uuid(p_project) and p.workspace_id = p_ws)
      then public.pa_rank_for(p_user, p_ws, p_project)
    else public.pa_rank_core(
           public.pa_on(p_ws), public.user_ws_role(p_user, p_ws),
           case when p_access is null then null else coalesce(p_access ->> 'visibility', 'workspace') end,
           p_access is not null and p_access ->> 'owner' = p_user::text,
           (select e ->> 1 from jsonb_array_elements(case when jsonb_typeof(p_access -> 'members') = 'array'
                                                          then p_access -> 'members' else '[]'::jsonb end) e
             where e ->> 0 = p_user::text limit 1)) end;
$$;
create or replace function public.pa_snapshot_rank(p_ws uuid, p_project text, p_access jsonb)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_snapshot_rank_for(auth.uid(), p_ws, p_project, p_access);
$$;
-- a project's rank for someone, from the bin when it's been deleted (its tasks' webhook events
-- go out after the project has gone)
create or replace function public.pa_rank_or_binned(p_user uuid, p_ws uuid, p_project text)
returns integer language sql security definer stable set search_path = public as $$
  select public.pa_snapshot_rank_for(p_user, p_ws, p_project,
    (select x.access from public.trash x
      where x.workspace_id = p_ws and x.kind = 'project' and x.item_id = public.kanbo_uuid(p_project)
      order by x.deleted_at desc limit 1));
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
create or replace function public.pa_guest_ws()
returns uuid[] language sql security definer stable set search_path = public as $$
  select coalesce(array_agg(x.id), '{}') from (
    select distinct w.id from public.workspaces w
      join public.workspace_members m on m.workspace_id = w.id
     where w.project_access and m.user_id = auth.uid() and m.status = 'active' and m.role = 'guest') x
   where auth.uid() is not null and public.ws_role(x.id) = 'guest';
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
-- on, its owner, its people and its tasks' assignees, creators, collaborators and comment authors
create or replace function public.pa_guest_sees(p_ws uuid, p_target uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select p_target is not null and (
    p_target = auth.uid()
    or exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_target)
    or exists (select 1 from public.workspace_members m
                where m.workspace_id = p_ws and m.user_id = p_target and m.status = 'active' and m.role = 'owner')
    or exists (
      select 1 from public.project_members mine
        join public.projects p on p.id = mine.project_id and p.workspace_id = p_ws
       where mine.user_id = auth.uid() and mine.workspace_id = p_ws
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
     where pm.user_id = auth.uid()),
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
                           'public.can_comment_task(uuid)', 'public.can_comment_project(uuid)'] loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- internal
  foreach f in array array['public.pa_rank_for(uuid,uuid,text)', 'public.pa_access_snapshot(uuid,text)',
                           'public.pa_snapshot_rank_for(uuid,uuid,text,jsonb)', 'public.pa_rank_or_binned(uuid,uuid,text)',
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
-- Members only or Private): '{}' while it's off
create or replace function public.closed_project_ids(p_ws uuid)
returns text[] language sql security definer stable set search_path = public as $$
  select case when public.pa_on(p_ws)
              then coalesce((select array_agg(p.id::text order by p.id) from public.projects p
                              where p.workspace_id = p_ws and p.visibility <> 'workspace'), '{}')
              else '{}'::text[] end;
$$;
create or replace function public.project_is_open(p_ws uuid, p_project text)
returns boolean language sql security definer stable set search_path = public as $$
  select p_project is null or not (p_project = any (public.closed_project_ids(p_ws)));
$$;
do $svc$
declare f text;
begin
  foreach f in array array['public.user_project_rank(uuid,uuid,text)', 'public.user_can_see_task(uuid,uuid)',
                           'public.user_can_see_project(uuid,uuid)', 'public.user_visible_task_ids(uuid,uuid[])',
                           'public.closed_project_ids(uuid)', 'public.project_is_open(uuid,text)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  begin
    foreach f in array array['public.user_project_rank(uuid,uuid,text)', 'public.user_can_see_task(uuid,uuid)',
                             'public.user_can_see_project(uuid,uuid)', 'public.user_visible_task_ids(uuid,uuid[])',
                             'public.closed_project_ids(uuid)', 'public.project_is_open(uuid,text)'] loop
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
    if jsonb_array_length(kept) <> jsonb_array_length(p #> '{due,tasks}') then p := jsonb_set(p, '{due,tasks}', kept); end if;
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

-- 2n. held notices and pending webhooks when access narrows (a project, or a whole workspace when
-- p_project is null): what's waiting for someone who can't see it any more never goes
create or replace function public.pa_flush_held(p_ws uuid, p_project uuid)
returns void language plpgsql security definer set search_path = public as $$
declare r record; np jsonb;
begin
  if p_ws is null then return; end if;
  if to_regclass('public.notify_queue') is not null then
    delete from public.notify_queue q
     where q.sent_at is null and q.task_id is not null
       and exists (select 1 from public.tasks t where t.id = q.task_id and t.workspace_id = p_ws
                    and (p_project is null or t.project_id = p_project::text))
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
  update public.webhook_deliveries d
     set state = 'failed', error = 'not sent: no longer visible', lease_until = null, next_attempt_at = null, updated_at = now()
    from public.webhooks w, public.webhook_outbox o
   where d.state = 'pending' and d.event <> 'ping' and w.id = d.webhook_id and o.id = d.outbox_id
     and w.workspace_id = p_ws
     and public.pa_webhook_project(o.event, o.payload) is not null
     and (p_project is null or public.pa_webhook_project(o.event, o.payload) = p_project::text)
     and public.pa_rank_or_binned(coalesce(w.url_set_by, w.created_by), p_ws, public.pa_webhook_project(o.event, o.payload)) < 1;
end; $$;

do $internal$
declare f text;
begin
  foreach f in array array['public.pa_touch(uuid)', 'public.pa_webhook_project(text,jsonb)', 'public.pa_task_hidden_for(uuid,uuid)',
                           'public.pa_notice_payload(uuid,jsonb)', 'public.pa_flush_held(uuid,uuid)'] loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
end $internal$;

-- ---------- 3. seeding (the first run only) ----------
-- One row per contributor_ids entry: editor for active owners, admins and members, commenter for
-- guests; never the project's owner (implicit) or anyone not active. contributor_ids itself is left
-- as it is, and the creator isn't added, so who gets 0054's update notices stays as it was.
-- Not on a re-run. After the undo file (not recorded, but project_members kept), contributor_ids was
-- the app's list of a project's people again, with nothing keeping project_members in step: the rows
-- are brought back to it (whoever was taken off, left the workspace or became its owner meanwhile
-- loses their row; whoever was added gets one; a guest's editor row becomes commenter), and the
-- grants of invites claimed meanwhile go (their projects were never given). Nobody who was taken off
-- a project comes back.
do $seed$
begin
  if exists (select 1 from public.schema_migrations where version = '0058') then return; end if;
  perform set_config('kanbo.pa_sync', 'on', true);
  if exists (select 1 from public.project_members) then
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
  insert into public.project_members (project_id, workspace_id, user_id, role)
  select p.id, p.workspace_id, c.uid,
         case public.user_ws_role(c.uid, p.workspace_id) when 'guest' then 'commenter' else 'editor' end
    from public.projects p
    cross join lateral (select distinct x as uid from unnest(p.contributor_ids) x where x is not null) c
   where p.workspace_id is not null
     and c.uid is distinct from p.owner_id
     and public.user_ws_role(c.uid, p.workspace_id) in ('owner', 'admin', 'member', 'guest')
  on conflict (project_id, user_id) do nothing;
  perform set_config('kanbo.pa_sync', '', true);
end $seed$;

-- ---------- 4. the functions the app calls ----------
-- Errors (the app matches them): 'not authorized' · 'not found' · 'invalid visibility' ·
-- 'invalid role' · 'invalid grants' · 'not a member of this workspace'.

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
    if not was_on and w.project_access then perform public.pa_flush_held(p_ws, null); end if;
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

-- The projects an invite brings (owners and admins, on a pending invite): replaces its grants,
-- [{"project_id": uuid, "role": text}], 50 at most. They become project_members when it's claimed.
create or replace function public.set_invite_projects(p_member uuid, p_grants jsonb)
returns integer language plpgsql security definer set search_path = public as $$
declare
  m public.workspace_members;
  g jsonb;
  pid uuid;
  r text;
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
    if not exists (select 1 from public.projects p where p.id = pid and p.workspace_id = m.workspace_id)
       or not public.pa_can_manage(pid) then
      raise exception 'not authorized';
    end if;
  end loop;
  delete from public.project_member_invites where member_id = p_member;
  for g in select e from jsonb_array_elements(p_grants) e loop
    pid := public.kanbo_uuid(g ->> 'project_id');
    r := g ->> 'role';
    if m.role = 'guest' and r = 'editor' then r := 'commenter'; end if;
    insert into public.project_member_invites (member_id, project_id, workspace_id, role, added_by)
    values (p_member, pid, m.workspace_id, r, auth.uid())
    on conflict (member_id, project_id) do update set role = excluded.role;
  end loop;
  select count(*) into n from public.project_member_invites where member_id = p_member;
  return n;
end; $$;

do $rpc$
declare f text;
begin
  foreach f in array array['public.set_project_access(uuid,boolean,text,boolean)', 'public.set_project_visibility(uuid,text)',
                           'public.set_project_member(uuid,uuid,text)', 'public.remove_project_member(uuid,uuid)',
                           'public.set_invite_projects(uuid,jsonb)'] loop
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
  -- switching on: a sub-task that was moved to another project on its own while it was off stands on
  -- its own from now on (D11), so its parent's delete or move never takes it along
  if new.project_access and not coalesce(old.project_access, false) then
    perform public.pa_detach_strays(new.id, null);
  end if;
  return new;
end; $$;

-- projects, before: a new project's visibility; visibility only through set_project_visibility();
-- an owner change by a manager to a non-guest (switch on, or a project that isn't Whole workspace);
-- contributor_ids mirrors project_members
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
  if tg_op = 'INSERT' then
    if new.workspace_id is null then new.visibility := 'workspace'; return new; end if;
    if restoring and new.visibility is not null then
      null;                                       -- the bin puts back what it had (a pre-0058 one has none: the default)
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
  if new.visibility is distinct from old.visibility and client
     and coalesce(current_setting('kanbo.pa_write', true), '') <> 'on' then
    raise exception 'not authorized';
  end if;
  if new.workspace_id is null then new.visibility := 'workspace'; end if;     -- moved to Personal: nothing to gate
  if direct and new.owner_id is distinct from old.owner_id and new.workspace_id is not null
     and (public.pa_on(new.workspace_id) or old.visibility <> 'workspace') then
    if not public.pa_can_manage(old.id) then raise exception 'not authorized'; end if;
    if public.user_ws_role(new.owner_id, new.workspace_id) not in ('owner', 'admin', 'member') then raise exception 'invalid owner'; end if;
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
  if coalesce(current_setting('kanbo.pa_sync', true), '') <> 'on' then perform public.pa_mirror_contributors(pid); end if;
  perform public.pa_touch(ws);
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and public.pa_member_rank(new.role) < public.pa_member_rank(old.role)) then
    perform public.pa_flush_held(ws, pid);
  end if;
  return null;
end; $$;

-- workspace_members, after: leaving a workspace (or being removed) takes your project rows with you;
-- a guest's editor rows become commenter; a claimed invite brings its projects
create or replace function public.pa_trg_ws_members() returns trigger
language plpgsql security definer set search_path = public as $$
declare g record; own uuid;
begin
  if tg_op = 'DELETE' then
    if old.user_id is not null then
      delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
    end if;
    return null;
  end if;
  if old.status = 'active' and new.status is distinct from 'active' and old.user_id is not null then
    delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
  end if;
  if old.user_id is not null and new.user_id is distinct from old.user_id then
    delete from public.project_members where workspace_id = old.workspace_id and user_id = old.user_id;
  end if;
  if new.status = 'active' and new.user_id is not null and new.role = 'guest' and old.role is distinct from 'guest' then
    update public.project_members set role = 'commenter'
     where workspace_id = new.workspace_id and user_id = new.user_id and role = 'editor';
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
-- project is refused from the app, and handed to the project's owner from the server (D10);
-- collaborators and followers who can't see it drop out
create or replace function public.pa_trg_tasks() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  direct boolean := public.pa_is_client() and pg_trigger_depth() <= 1;
  par record;
  moved boolean;
  who uuid;
begin
  if new.workspace_id is null or not public.pa_on(new.workspace_id) then return new; end if;
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
  if who is not null and (moved or new.assignee_id is distinct from old.assignee_id)
     and public.pa_rank_for(who, new.workspace_id, new.project_id) < 1 then
    if direct then
      raise exception 'assignee can''t see this project' using errcode = '42501';
    end if;
    new.assignee_id := coalesce(
      (select p.owner_id from public.projects p where p.id = public.kanbo_uuid(new.project_id) and p.workspace_id = new.workspace_id),
      (select w.owner_id from public.workspaces w where w.id = new.workspace_id))::text;
  end if;
  if moved or new.collaborators is distinct from old.collaborators then
    new.collaborators := coalesce(array(
      select c from unnest(coalesce(new.collaborators, '{}'::text[])) with ordinality a(c, i)
       where public.kanbo_uuid(c) is null or public.pa_rank_for(public.kanbo_uuid(c), new.workspace_id, new.project_id) >= 1
       order by i), '{}');
  end if;
  if moved or new.followers is distinct from old.followers then
    new.followers := coalesce(array(
      select f from unnest(coalesce(new.followers, '{}'::text[])) with ordinality a(f, i)
       where public.kanbo_uuid(f) is null or public.pa_rank_for(public.kanbo_uuid(f), new.workspace_id, new.project_id) >= 1
       order by i), '{}');
  end if;
  return new;
end; $$;

-- tasks, after a move (switch on): the sub-tasks that were in its project move with it. One in another
-- project (moved there on its own while the switch was off, or back from the bin) isn't the mover's to
-- take: it stays where it is, on its own (D11).
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

-- status_update_comments (0054): the @mentioned are people who can read the update
create or replace function public.pa_trg_status_update_comment() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record;
begin
  select x.workspace_id, x.project_id into s from public.status_updates x where x.id = new.update_id;
  if s.workspace_id is null or not public.pa_on(s.workspace_id) then return new; end if;
  new.mentions := coalesce(array(
    select x from unnest(coalesce(new.mentions, '{}'::uuid[])) with ordinality a(x, i)
     where public.pa_rank_for(x, s.workspace_id, s.project_id) >= 1 order by i), '{}');
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
create or replace function public.pa_trg_webhook_deliveries_gate() returns trigger
language plpgsql security definer set search_path = public as $$
declare w record; o record; proj text;
begin
  if tg_op = 'UPDATE' and not (new.state = 'pending' and old.state is distinct from 'pending') then return new; end if;
  if new.event = 'ping' then return new; end if;
  select x.workspace_id, x.created_by, x.url_set_by into w from public.webhooks x where x.id = new.webhook_id;
  if w.workspace_id is null or not public.pa_on(w.workspace_id) then return new; end if;
  select x.event, x.payload into o from public.webhook_outbox x where x.id = new.outbox_id;
  proj := public.pa_webhook_project(o.event, o.payload);
  if proj is null or public.pa_rank_or_binned(coalesce(w.url_set_by, w.created_by), w.workspace_id, proj) >= 1 then
    return new;
  end if;
  if tg_op = 'INSERT' then return null; end if;
  new.state := 'failed'; new.error := 'not sent: no longer visible'; new.lease_until := null; new.next_attempt_at := null;
  return new;
end; $$;

-- webhooks: re-pointing an endpoint makes whoever did it its viewer (D19)
create or replace function public.pa_trg_webhooks_url() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.url is distinct from old.url then new.url_set_by := coalesce(public.kanbo_actor(), old.url_set_by); end if;
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

-- kudos (0048): its recipient can see the task
create or replace function public.pa_trg_kudos() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record;
begin
  select x.workspace_id, x.project_id into t from public.tasks x where x.id = new.task_id;
  if t.workspace_id is null or not public.pa_on(t.workspace_id) then return new; end if;
  if public.pa_rank_for(new.to_user, t.workspace_id, t.project_id) < 1 then raise exception 'invalid recipient'; end if;
  return new;
end; $$;

-- trash, before insert: the project's access when it went in (and no parent's title from another project)
create or replace function public.pa_trg_trash_capture() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.access := public.pa_access_snapshot(new.workspace_id, new.project_id);
  if new.workspace_id is not null and public.pa_on(new.workspace_id) and jsonb_typeof(new.summary -> 'parent') = 'object'
     and (select t.project_id from public.tasks t where t.id = public.kanbo_uuid(new.summary #>> '{parent,id}')) is distinct from new.project_id then
    new.summary := new.summary - 'parent';
  end if;
  return new;
end; $$;

-- trash, restore (restored_at set): a project comes back with its people; the caller needs edit rights
-- on the item's project (live, else as it was when deleted); a task of a deleted Private or Members
-- only project is its workspace owner's to bring back. A raise undoes the whole restore.
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
    if old.kind = 'task'
       and not exists (select 1 from public.projects p where p.id = public.kanbo_uuid(old.project_id) and p.workspace_id = ws)
       and coalesce(old.access ->> 'visibility', 'workspace') <> 'workspace'
       and public.ws_role(ws) <> 'owner' then
      raise exception 'not found';
    end if;
  end if;
  return new;
end; $$;

-- trash, delete for good: edit rights on the item's project (housekeeping, the service role, passes)
create or replace function public.pa_trg_trash_purge() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and old.workspace_id is not null and public.pa_on(old.workspace_id)
     and public.pa_snapshot_rank(old.workspace_id, old.project_id, old.access) < 3 then
    raise exception 'not found';
  end if;
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
create or replace function public.pa_trg_goals_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and new.workspace_id is not null and new.project_id is not null
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and public.pa_on(new.workspace_id) and public.pa_rank(new.workspace_id, new.project_id) < 1 then
    raise exception 'a goal can only read its progress from a project in its own workspace';
  end if;
  return new;
end; $$;

-- forms: a new public link is for people who can edit the form's project (rotate_form_public_token)
create or replace function public.pa_trg_forms_token() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and new.public_token is distinct from old.public_token and new.workspace_id is not null
     and public.pa_on(new.workspace_id) and public.pa_rank(new.workspace_id, new.project_id) < 3 then
    raise exception 'not authorized';
  end if;
  return new;
end; $$;

-- notion_syncs (0046): into a project you can edit (notion_save_sync; the bin putting one back is the restore's to judge)
create or replace function public.pa_trg_notion_syncs() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if public.pa_is_client() and not public.pa_restoring() and new.workspace_id is not null and public.pa_on(new.workspace_id)
     and (tg_op = 'INSERT' or new.project_id is distinct from old.project_id)
     and not public.can_edit_project(new.project_id) then
    raise exception 'invalid project';
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

-- bill_rates (0055): a project's rate only for a project you can see (set_bill_rate's own answer)
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
create or replace function public.pa_task_audience_open(p_preset text, p_wss uuid[], p_task text)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select public.pa_audience_open(p_preset, p_wss, t.workspace_id, p.visibility)
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
  -- the notes doc goes in a project its audience can open
  if new.doc_project_id is not null and not public.pa_project_audience_open(new.preset, wss, new.doc_project_id::text) then
    raise exception 'not authorized';
  end if;
  if new.doc_id is not null and to_regclass('public.project_docs') is not null then
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
  foreach f in array array['pa_trg_workspaces_guard', 'pa_trg_projects_guard', 'pa_trg_projects_after', 'pa_trg_project_members_guard',
                           'pa_trg_project_members_after', 'pa_trg_ws_members', 'pa_trg_tasks', 'pa_trg_tasks_after',
                           'pa_trg_status_update', 'pa_trg_status_update_comment', 'pa_trg_activity_gate', 'pa_trg_notify_queue_gate',
                           'pa_trg_webhook_deliveries_gate', 'pa_trg_webhooks_url', 'pa_trg_approval_reviewers', 'pa_trg_kudos',
                           'pa_trg_trash_capture', 'pa_trg_trash_restore', 'pa_trg_trash_purge', 'pa_trg_audit_events',
                           'pa_trg_goal_links', 'pa_trg_goals_project', 'pa_trg_forms_token', 'pa_trg_notion_syncs',
                           'pa_trg_update_asks', 'pa_trg_bill_rates', 'pa_trg_meetings', 'pa_trg_meeting_items',
                           'pa_trg_tasks_delete', 'pa_trg_projects_delete'] loop
    execute format('revoke execute on function public.%I() from public, anon, authenticated', f);
  end loop;
  foreach f in array array['public.pa_mirror_contributors(uuid)', 'public.pa_detach_strays(uuid,uuid[])',
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
  union all select 'notion_links', 'project access: read', 'select', false, g.p || 'public.can_see_task(task_id)', null from g
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
  union all select 'project_member_invites', 'project invites: leads read', 'select', true, 'public.ws_role(workspace_id) in (''owner'', ''admin'')', null
  union all select 'project_member_invites', 'api key scope', 'all', false, 'public.api_scope_ok(workspace_id)', 'public.api_scope_ok(workspace_id)';
$$;

-- needs_column: the trigger is made only where that column is there
create or replace function public.pa_trigger_defs()
returns table (tbl text, name text, timing text, fn text, needs_column text)
language sql immutable set search_path = pg_catalog as $$
  values
    ('workspaces', 'trg_workspaces_pa_guard', 'before insert or update', 'pa_trg_workspaces_guard', null::text),
    ('projects', 'trg_projects_pa_guard', 'before insert or update', 'pa_trg_projects_guard', null),
    ('projects', 'trg_projects_pa_after', 'after insert or update of visibility, owner_id, workspace_id', 'pa_trg_projects_after', null),
    ('project_members', 'trg_project_members_guard', 'before insert or update', 'pa_trg_project_members_guard', null),
    ('project_members', 'trg_project_members_after', 'after insert or update or delete', 'pa_trg_project_members_after', null),
    ('workspace_members', 'trg_ws_members_pa', 'after update of role, status, user_id or delete', 'pa_trg_ws_members', null),
    ('tasks', 'trg_tasks_pa', 'before insert or update of project_id, parent_id, assignee_id, collaborators, followers, workspace_id', 'pa_trg_tasks', null),
    ('tasks', 'trg_tasks_pa_after', 'after update of project_id', 'pa_trg_tasks_after', null),
    ('tasks', 'trg_tasks_pa_delete', 'before delete', 'pa_trg_tasks_delete', null),
    ('projects', 'trg_projects_pa_delete', 'before delete', 'pa_trg_projects_delete', null),
    ('status_updates', 'trg_status_update_pa', 'before insert or update', 'pa_trg_status_update', 'ask_user_ids'),
    ('status_update_comments', 'trg_status_update_comment_pa', 'before insert or update', 'pa_trg_status_update_comment', null),
    ('activity', 'trg_activity_pa_gate', 'before insert', 'pa_trg_activity_gate', null),
    ('notify_queue', 'trg_notify_queue_pa_gate', 'before insert', 'pa_trg_notify_queue_gate', null),
    ('webhook_deliveries', 'trg_webhook_deliveries_pa_gate', 'before insert or update of state', 'pa_trg_webhook_deliveries_gate', null),
    ('webhooks', 'trg_webhooks_pa_url', 'before update of url', 'pa_trg_webhooks_url', null),
    ('approval_reviewers', 'trg_approval_reviewers_pa', 'before insert or update of decision', 'pa_trg_approval_reviewers', null),
    ('kudos', 'trg_kudos_pa', 'before insert', 'pa_trg_kudos', null),
    ('trash', 'trg_trash_pa_capture', 'before insert', 'pa_trg_trash_capture', null),
    ('trash', 'trg_trash_pa_restore', 'before update of restored_at', 'pa_trg_trash_restore', null),
    ('trash', 'trg_trash_pa_purge', 'before delete', 'pa_trg_trash_purge', null),
    ('audit_events', 'trg_audit_events_pa', 'before insert', 'pa_trg_audit_events', null),
    ('goal_links', 'trg_goal_links_pa', 'before insert', 'pa_trg_goal_links', null),
    ('goals', 'trg_goals_pa_project', 'before insert or update of project_id', 'pa_trg_goals_project', 'project_id'),
    ('forms', 'trg_forms_pa_token', 'before update of public_token', 'pa_trg_forms_token', 'public_token'),
    ('notion_syncs', 'trg_notion_syncs_pa', 'before insert or update of project_id', 'pa_trg_notion_syncs', null),
    ('update_asks', 'trg_update_asks_pa', 'before insert', 'pa_trg_update_asks', null),
    ('bill_rates', 'trg_bill_rates_pa', 'before insert or update', 'pa_trg_bill_rates', null),
    ('meetings', 'trg_meetings_pa', 'before insert or update of agenda, doc_id, doc_project_id', 'pa_trg_meetings', null),
    ('meeting_items', 'trg_meeting_items_pa', 'before insert or update of task_id', 'pa_trg_meeting_items', null);
$$;
revoke execute on function public.pa_policy_defs() from public, anon, authenticated;
revoke execute on function public.pa_trigger_defs() from public, anon, authenticated;
do $svc$ begin
  grant execute on function public.pa_policy_defs() to service_role;
  grant execute on function public.pa_trigger_defs() to service_role;
exception when undefined_object then null; end $svc$;

-- 5c. (Re)makes everything: every policy above, the eight helper bodies this file changes (each
-- equal to its old one while the switch is off), and every trigger. Run below, and by 0025, 0041,
-- 0042, 0043, 0046, 0047, 0048, 0052, 0053, 0054, 0055 and 0056 when one of them is run again (they
-- drop policies or put an old body back). Safe in any state from 0047 on, and twice in a row.
-- Returns how many objects it made.
create or replace function public.project_access_restore()
returns integer language plpgsql set search_path = public as $restore$
declare
  d record;
  n integer := 0;
begin
  -- the policies
  for d in select * from public.pa_policy_defs() loop
    if to_regclass('public.' || d.tbl) is null then continue; end if;
    execute format('drop policy if exists %I on public.%I', d.name, d.tbl);
    execute format('create policy %I on public.%I as %s for %s%s%s', d.name, d.tbl,
                   case when d.permissive then 'permissive' else 'restrictive' end, d.cmd,
                   case when d.using_sql is null then '' else ' using (' || d.using_sql || ')' end,
                   case when d.check_sql is null then '' else ' with check (' || d.check_sql || ')' end);
    n := n + 1;
  end loop;

  -- the helpers (0043's can_see_task, 0042's can_edit_task, 0047's can_see_project and can_edit_project):
  -- thin wrappers over the rank
  execute $fn$
create or replace function public.can_see_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select public.pa_task_rank(p_task) >= 1;
$b$ $fn$;
  execute $fn$
create or replace function public.can_edit_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select public.pa_task_rank(p_task) >= 3;
$b$ $fn$;
  execute $fn$
create or replace function public.can_see_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.pa_project_rank(p.workspace_id, p.id, p.visibility, p.owner_id) >= 1)));
$b$ $fn$;
  execute $fn$
create or replace function public.can_edit_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $b$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.pa_project_rank(p.workspace_id, p.id, p.visibility, p.owner_id) >= 3)));
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
             and public.pa_rank(s.workspace_id, s.project_id) >= 1)));
$b$ $fn$;
    revoke execute on function public.can_see_status_update(uuid) from public, anon;
    grant execute on function public.can_see_status_update(uuid) to authenticated;
    n := n + 1;
  end if;

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
                                 'public.toggle_task_follow(uuid,boolean)', 'public.toggle_comment_reaction(uuid,text)']
                           || case when to_regclass('public.status_update_comments') is not null
                                   then array['public.can_see_status_update(uuid)'] else '{}'::text[] end) f(sig)
       where not coalesce((select position('public.pa_' in p.prosrc) > 0 from pg_catalog.pg_proc p
                            where p.oid = to_regprocedure(f.sig)), false))
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
--   has_function_privilege('authenticated', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute')
--     and not has_function_privilege('anon', 'public.set_project_access(uuid,boolean,text,boolean)', 'execute') as switch_fn,
--   not has_function_privilege('authenticated', 'public.project_access_restore()', 'execute')        as restore_private,
--   not has_function_privilege('authenticated', 'public.user_project_rank(uuid,uuid,text)', 'execute') as service_helpers_private,
--   public.api_scope_intact()                                                                       as api_keys_still_scoped,
--   (select count(*) from public.project_members) >= 0                                              as members_table;
--
-- everyone_still_off is true right after the first run. It turns false once an owner switches a
-- workspace on in Settings › Workspace › Project access: that's expected.
-- ============================================================
