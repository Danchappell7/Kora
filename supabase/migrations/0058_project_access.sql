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
--      does the same once for anyone who left before it).
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
--      made narrower, the switch turned on while one has them, the bin putting them back).
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
-- written last, a Private one's included.
create or replace function public.pa_notion_page_hidden(p_ws uuid, p_page text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.notion_links l
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
-- would fetch it again on request; notion_link_page refuses a new one)
create or replace function public.pa_notion_database_hidden(p_ws uuid, p_db text)
returns boolean language sql security definer stable set search_path = public as $$
  select public.user_notion_database_hidden(auth.uid(), p_ws, p_db);
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
    when 'link' then 'Make this project Whole workspace to link Notion pages to its tasks.'
    when 'sync' then 'Choose a Whole workspace project.'
    when 'restore task' then 'This task has Notion page links: make its project Whole workspace to restore it.'
    when 'restore project' then 'This project has a Notion sync or Notion-linked tasks: the workspace''s owner can turn project access off to restore it.'
    else 'Remove this project''s Notion sync and page links first.' end;
$$;
-- The Members only and Private projects here that still connect to Notion: their syncs, and their tasks
-- with a Notion link (one deleted, in the bin or gone from the workspace counts by the access it had:
-- no name). Switching on is refused while there are any (pa_trg_workspaces_guard). (A task's project id
-- in any spelling is that project's, as every rank reads it: one row a project.)
create or replace function public.pa_notion_blockers(p_ws uuid)
returns table (project_id text, name text, visibility text, syncs integer, linked_tasks integer)
language sql security definer stable set search_path = public as $$
  with linked as (
    select lower(t.project_id) as pid, count(*)::int as n
      from public.tasks t
     where t.workspace_id = p_ws and t.project_id is not null
       and exists (select 1 from public.notion_links l where l.task_id = t.id)
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
    -- workspace)
    if client and not restoring and new.owner_id is not null and new.owner_id is distinct from auth.uid()
       and (public.pa_on(new.workspace_id) or new.visibility <> 'workspace')
       and public.user_ws_role(new.owner_id, new.workspace_id) not in ('owner', 'admin', 'member') then
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
declare kept boolean := false;
begin
  -- (the containment rule, 2t: never into a Members only or Private project while the switch is on,
  -- whoever writes it, the bin putting one back too. The bin's insert of a database that syncs with
  -- another project by now writes nothing (restore_from_trash says its sync wasn't restored): that one's
  -- row is held (FOR KEY SHARE) so it stays there until the restore ends)
  if tg_op = 'INSERT' and public.pa_restoring() then
    perform 1 from public.notion_syncs x where x.workspace_id = new.workspace_id and x.database_id = new.database_id for key share;
    kept := found;
  end if;
  -- (judged where the project is: a sync row names its workspace, and only notion_save_sync checks the two agree)
  if (tg_op = 'INSERT' and not kept or tg_op = 'UPDATE' and new.project_id is distinct from old.project_id)
     and public.pa_notion_shut(coalesce((select p.workspace_id from public.projects p where p.id = new.project_id), new.workspace_id),
                               new.project_id::text) then
    raise exception 'notion closed project'
      using hint = public.pa_notion_closed_text(case when public.pa_restoring() then 'restore project' else 'sync' end);
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
-- along (pa_trg_tasks_after's update comes through here), re-parented under a task there (trg_tasks_pa
-- has moved it to its parent's project by now: it sorts first), or into another workspace's. Whoever
-- writes it: the app, the API, MCP, the planner, the bin.
create or replace function public.pa_trg_tasks_notion() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null or not public.pa_notion_contain()
     or (new.project_id is not distinct from old.project_id and new.workspace_id is not distinct from old.workspace_id) then
    return new;
  end if;
  if exists (select 1 from public.notion_links l where l.task_id = new.id)
     and public.pa_notion_shut(new.workspace_id, new.project_id) then
    raise exception 'notion closed project' using hint = public.pa_notion_closed_text('move');
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
  if exists (select 1 from public.notion_syncs s where s.project_id = new.id)
     or exists (select 1 from public.tasks t
                 where t.workspace_id = new.workspace_id and lower(t.project_id) = new.id::text
                   and exists (select 1 from public.notion_links l where l.task_id = t.id)) then
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
    ('notion_syncs', 'trg_notion_syncs_pa', 'before insert or update of project_id', 'pa_trg_notion_syncs', null),
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
  -- (trash_restore_project keeps the one there), and says so. Switch off: 0047's, line for line.
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
                      join public.notion_syncs n on n.workspace_id = r.workspace_id and n.database_id = s ->> 'database_id'
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
