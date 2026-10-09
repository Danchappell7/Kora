-- ============================================================
-- KANBO — recycle bin, workspace history, approvals and project docs
-- (2026-10-09). Additive: nothing the app does today changes shape, except
-- that a deleted task or project now waits 30 days in the bin.
--
--   1. Recycle bin (public.trash). Deleting a task (with its sub-tasks) or a
--      project no longer destroys it: BEFORE DELETE triggers snapshot the
--      whole row graph — the task and every descendant, their checklist
--      items, dependencies (both directions), comments, attachment rows,
--      change history, everyone's plans (task_user_state), Notion links and
--      approvals; a project also takes its sections, docs (with versions),
--      Notion syncs and every task in it (in the project's own scope only:
--      its workspace's tasks, or its creator's personal ones). The bin row
--      is readable by the same people as the original (personal: its
--      creator; team: the workspace's members) — every column except the
--      snapshot itself, which only the definer functions read.
--        restore_from_trash(id)        writers (personal: the creator). Puts
--                                      everything back under its original ids,
--                                      into its project/section when they're
--                                      still there, otherwise the workspace's
--                                      first project (or Personal), with a
--                                      note. Idempotent; refuses while any of
--                                      the ids exists again.
--        restore_trash_items(ids[])    the same for several (bulk restore,
--                                      Undo), newest delete first; one failure
--                                      doesn't stop the rest.
--        purge_trash(id)               delete forever: owner/admin for team
--                                      items, the creator for personal ones.
--        trash_housekeeping()          purges what's 30 days old (also run by
--                                      the daily api_housekeeping() cron job).
--      While an item is in the bin its ids stay reserved (public.trash_ids,
--      service only): nobody can create a task, project, section, doc,
--      checklist item, comment or file row under one of them, or change a
--      row's id to one, so knowing a binned id (a guest reads item_id) can't
--      block its restore. A restore or purge frees them.
--      Not in the bin: what goes because its whole workspace is closed, or
--      because its owner's account is deleted (nobody would see it there).
--      Storage: a purge removes only the database rows. The files of purged
--      attachments are queued in public.storage_cleanup (service only).
--      TODO(storage): a housekeeping edge function drains storage_cleanup
--      with the service role (re-checks no attachments row points at the
--      path, removes the object from the task-files bucket, deletes the queue
--      row). Until it exists, files stay in storage after a purge.
--   2. Workspace history (public.audit_events): who did what in a team
--      workspace — deletes, restores and purges, project archive, invites,
--      joins, removals, role changes, renames, integrations, API keys and
--      webhooks. Written only by triggers and definer functions (a failure
--      never blocks the change itself). Owners/admins read all of it; other
--      members only their own actions. Kept 365 days.
--   3. Approvals (approvals, approval_reviewers). People who can edit a team
--      task request approval from 1–10 workspace members (guests may
--      review); "any" resolves on the first approval, "all" when everyone
--      approved; any "changes requested" resolves it as that. One open
--      request per task. Reviewers decide only their own row; the requester
--      (or an owner/admin) cancels. Each step notifies the right people in
--      the Inbox (kind 'approval', pref 'approval'), adds an 'approval' entry
--      to the task's history (task_events) and sends approval.requested /
--      approval.decided to webhooks. A request belongs to its task's
--      workspace: when the task leaves it (moved to another workspace, or to
--      Personal) its open request is cancelled, and the old workspace's
--      webhooks get approval.decided ('cancelled') with only what that
--      workspace already knew about the task (as 0046 sends it task.deleted
--      'moved'). Nothing is decided, cancelled or announced across workspaces.
--   4. Project docs (project_docs, project_doc_versions). A block document
--      per project, readable by the project's audience (guests read only).
--      All writes through save_project_doc() (optimistic concurrency on
--      updated_at: a stale save gets the server's copy back as a conflict),
--      set_project_doc_props() and delete_project_doc(). Versions are cut
--      every 10 minutes of one person's editing (or when someone else
--      saves, or the save is a checkpoint: a restore or "keep mine"); the
--      last 50 are kept. @mentions notify once each (Inbox kind
--      'doc_mention', pref 'mention').
--   5. activity.meta (jsonb): what an Inbox item points at beyond its task
--      ({ approval_id, event, status } · { doc_id, project_id }).
--   6. Restores stay quiet: the notification triggers, the comment author
--      stamp and the comment webhook skip rows a restore puts back
--      (kanbo.restoring). Restored tasks and projects do send task.created /
--      project.created to webhooks (they're back).
--   7. Account deletion keeps the team's bin: team bin rows a departing
--      person created move to the workspace's owner first (as 0041 does
--      for their tasks).
--   8. kanbo_health(): one cheap query for the health edge function
--      (service role only).
--   9. sign_in_hints(): the sign-in page's Google `hd` hint — the ONE
--      auto-approved company domain when there is exactly one, otherwise
--      null. Callable signed out on purpose; never returns a list. Also kept
--      as the stand-alone paste supabase/sql/sign_in_hints.sql (same SQL).
--
-- Needs 0043 and 0046. Idempotent: safe to run more than once (re-running
-- keeps every bin item, event, approval and doc). RUN IT LAST. 0046
-- recreates webhook_event_names(), the webhooks check, api_housekeeping()
-- and the comment webhook trigger; 0012/0014/0037/0041 recreate the
-- notification and author triggers. If any of them is ever run again, run
-- this file again straight afterwards (0046 alone would refuse webhooks
-- that subscribe to approval events, and restores would notify again).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0046') then
    raise exception '0047 needs 0046 first: run 0046_api_webhooks_notion.sql, then this file';
  end if;
  if to_regclass('public.task_user_state') is null then
    raise exception '0047 needs 0043 first: run 0043_integrations_push_forms_plans.sql, then 0046, then this file';
  end if;
end $pre$;

-- ---------- 1. helpers ----------
-- a text that is a uuid → that uuid; anything else → null (never raises)
create or replace function public.kanbo_uuid(p text)
returns uuid language sql immutable set search_path = pg_catalog as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end;
$$;
revoke execute on function public.kanbo_uuid(text) from public, anon, authenticated;

-- the caller when their account still exists: null for the service role and
-- cron, and while their own account is being deleted, so it is always safe
-- to store in a column that references auth.users
create or replace function public.kanbo_actor()
returns uuid language sql security definer stable set search_path = public as $$
  select u.id from auth.users u where u.id = auth.uid();
$$;
revoke execute on function public.kanbo_actor() from public, anon, authenticated;

-- may the caller see this project? (0041's project read rule)
create or replace function public.can_see_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.is_member(p.workspace_id))));
$$;
-- may the caller change this project's content (its docs)? personal: its
-- creator; team: owners, admins and members (never guests)
create or replace function public.can_edit_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.can_write(p.workspace_id))));
$$;
revoke execute on function public.can_see_project(uuid) from public, anon;
revoke execute on function public.can_edit_project(uuid) from public, anon;
grant execute on function public.can_see_project(uuid) to authenticated;
grant execute on function public.can_edit_project(uuid) to authenticated;

-- a dependency's other end is looked up on every delete now
create index if not exists task_dependencies_depends_on_idx on public.task_dependencies (depends_on);

-- ---------- 2. activity.meta ----------
alter table public.activity add column if not exists meta jsonb;

-- ---------- 3. tables ----------
-- 3a. workspace history
create table if not exists public.audit_events (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  actor_id     uuid references auth.users (id) on delete set null,
  actor_name   text not null default '',
  action       text not null,
  target_kind  text,
  target_id    text,
  target_title text,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists audit_events_ws_idx on public.audit_events (workspace_id, created_at desc, id);
create index if not exists audit_events_actor_idx on public.audit_events (workspace_id, actor_id, created_at desc);
create index if not exists audit_events_created_idx on public.audit_events (created_at);
alter table public.audit_events drop constraint if exists audit_events_shape;
alter table public.audit_events add constraint audit_events_shape check (
  action ~ '^[a-z_]+\.[a-z_]+$' and length(action) <= 60
  and length(actor_name) <= 200
  and (target_kind is null or length(target_kind) <= 40)
  and (target_id is null or length(target_id) <= 200)
  and (target_title is null or length(target_title) <= 500)
  and jsonb_typeof(detail) = 'object' and pg_column_size(detail) <= 4096);

-- 3b. the recycle bin
create table if not exists public.trash (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null,
  item_id         uuid not null,                 -- the task's / project's id (it comes back under it)
  workspace_id    uuid references public.workspaces (id) on delete cascade,   -- null = personal
  user_id         uuid references auth.users (id) on delete cascade,          -- the row's creator
  project_id      text,                          -- a task's project when deleted; a project's own id
  title           text not null default '',
  summary         jsonb not null default '{}'::jsonb,   -- what the bin shows (counts, project, parent)
  snapshot        jsonb not null,                -- the row graph: definer functions only
  deleted_by      uuid references auth.users (id) on delete set null,
  deleted_by_name text,
  deleted_at      timestamptz not null default now(),
  purge_after     timestamptz not null default (now() + interval '30 days'),
  restored_at     timestamptz,
  restored_by     uuid references auth.users (id) on delete set null
);
create index if not exists trash_ws_idx on public.trash (workspace_id, deleted_at desc) where workspace_id is not null;
create index if not exists trash_personal_idx on public.trash (user_id, deleted_at desc) where workspace_id is null;
create index if not exists trash_item_idx on public.trash (item_id);
create index if not exists trash_purge_idx on public.trash (purge_after) where restored_at is null;
alter table public.trash drop constraint if exists trash_shape;
alter table public.trash add constraint trash_shape check (
  kind in ('task', 'project')
  and length(title) <= 500
  and (deleted_by_name is null or length(deleted_by_name) <= 200)
  and jsonb_typeof(summary) = 'object' and jsonb_typeof(snapshot) = 'object');

-- files of purged attachments, waiting to be removed from storage (service only)
create table if not exists public.storage_cleanup (
  bucket     text not null,
  path       text not null,
  reason     text not null default 'bin',
  queued_at  timestamptz not null default now(),
  attempts   integer not null default 0,
  last_error text,
  primary key (bucket, path)
);

-- the ids a bin item will come back under, reserved while it waits (service
-- only; read by the guard trigger in section 6). A purge or a bin row's
-- workspace closing frees them with the row; a restore frees them itself.
create table if not exists public.trash_ids (
  id       uuid primary key,
  trash_id uuid not null references public.trash (id) on delete cascade
);
create index if not exists trash_ids_trash_idx on public.trash_ids (trash_id);

-- 3c. approvals
create table if not exists public.approvals (
  id            uuid primary key default gen_random_uuid(),
  task_id       uuid not null references public.tasks (id) on delete cascade,
  workspace_id  uuid not null references public.workspaces (id) on delete cascade,
  requested_by  uuid references auth.users (id) on delete set null,
  title         text not null default '',
  note          text,
  attachment_id uuid references public.attachments (id) on delete set null,
  status        text not null default 'pending',
  rule          text not null default 'any',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  resolved_at   timestamptz
);
create index if not exists approvals_task_idx on public.approvals (task_id, created_at desc);
create index if not exists approvals_ws_idx on public.approvals (workspace_id, status, created_at desc);
create index if not exists approvals_requester_idx on public.approvals (requested_by) where status = 'pending';
create unique index if not exists approvals_one_pending_per_task on public.approvals (task_id) where status = 'pending';
alter table public.approvals drop constraint if exists approvals_shape;
alter table public.approvals add constraint approvals_shape check (
  status in ('pending', 'approved', 'changes_requested', 'cancelled')
  and rule in ('any', 'all')
  and length(title) <= 200
  and (note is null or length(note) <= 2000)
  and ((status = 'pending') = (resolved_at is null)));

create table if not exists public.approval_reviewers (
  approval_id uuid not null references public.approvals (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  decision    text,
  comment     text,
  decided_at  timestamptz,
  primary key (approval_id, user_id)
);
create index if not exists approval_reviewers_user_idx on public.approval_reviewers (user_id);
alter table public.approval_reviewers drop constraint if exists approval_reviewers_shape;
alter table public.approval_reviewers add constraint approval_reviewers_shape check (
  (decision is null or decision in ('approved', 'changes_requested'))
  and (comment is null or length(comment) <= 2000)
  and ((decision is null) = (decided_at is null)));

-- 3d. project docs
create table if not exists public.project_docs (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,   -- the project's (null = personal)
  title        text not null default '',
  body         jsonb not null default '[]'::jsonb,                          -- the block list (lib/docs)
  icon         text,
  position     double precision,
  mentions     uuid[] not null default '{}',                                -- who the doc @mentions now
  created_by   uuid references auth.users (id) on delete set null,
  updated_by   uuid references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz
);
create index if not exists project_docs_project_idx on public.project_docs (project_id, position);
create index if not exists project_docs_ws_idx on public.project_docs (workspace_id) where workspace_id is not null;
alter table public.project_docs drop constraint if exists project_docs_shape;
alter table public.project_docs add constraint project_docs_shape check (
  length(title) <= 200
  and jsonb_typeof(body) = 'array'
  and (icon is null or length(icon) <= 64)
  and cardinality(mentions) <= 100);

create table if not exists public.project_doc_versions (
  id       uuid primary key default gen_random_uuid(),
  doc_id   uuid not null references public.project_docs (id) on delete cascade,
  title    text not null default '',
  body     jsonb not null default '[]'::jsonb,
  saved_by uuid references auth.users (id) on delete set null,
  saved_at timestamptz not null default now()
);
create index if not exists project_doc_versions_doc_idx on public.project_doc_versions (doc_id, saved_at desc, id desc);

-- ---------- 4. row security ----------
do $rls$
declare t text; pol record;
begin
  foreach t in array array['audit_events','trash','storage_cleanup','trash_ids','approvals','approval_reviewers','project_docs','project_doc_versions'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $rls$;

-- history: owners/admins read the workspace's; everyone else only their own actions
grant select on public.audit_events to authenticated;
create policy "history: owners and admins, or your own" on public.audit_events
  for select to authenticated using (
    public.is_member(workspace_id)
    and (public.ws_role(workspace_id) in ('owner', 'admin') or actor_id = auth.uid()));

-- bin: the original's audience; every column but the snapshot
grant select (id, kind, item_id, workspace_id, user_id, project_id, title, summary, deleted_by, deleted_by_name,
              deleted_at, purge_after, restored_at, restored_by) on public.trash to authenticated;
create policy "bin: personal or member" on public.trash
  for select to authenticated using (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and public.is_member(workspace_id)));

-- storage_cleanup, trash_ids: service only (no grants, no policies)

-- approvals: whoever can see the task; writes only through the functions below
grant select on public.approvals to authenticated;
grant select on public.approval_reviewers to authenticated;
create policy "approvals: task audience" on public.approvals
  for select to authenticated using (public.can_see_task(task_id));
create policy "approval reviewers: visible approval" on public.approval_reviewers
  for select to authenticated using (exists (select 1 from public.approvals a where a.id = approval_id));

-- docs: the project's audience reads; writes only through the functions below
grant select on public.project_docs to authenticated;
grant select on public.project_doc_versions to authenticated;
create policy "docs: project audience" on public.project_docs
  for select to authenticated using (exists (select 1 from public.projects p where p.id = project_id));
create policy "doc versions: visible doc" on public.project_doc_versions
  for select to authenticated using (exists (select 1 from public.project_docs d where d.id = doc_id));

-- ---------- 5. workspace history: writer + capture triggers ----------
-- Internal. Never raises: history must not block the change it records.
-- Skips a workspace that is being closed (its rows cascade away anyway).
create or replace function public.audit_log(p_ws uuid, p_action text, p_target_kind text, p_target_id text,
                                            p_target_title text, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare actor uuid;
begin
  if p_ws is null or not exists (select 1 from public.workspaces w where w.id = p_ws) then return; end if;
  actor := public.kanbo_actor();
  insert into public.audit_events (workspace_id, actor_id, actor_name, action, target_kind, target_id, target_title, detail)
  values (p_ws, actor, left(case when actor is null then 'Kanbo' else public.kanbo_person_name(actor) end, 200),
          p_action, p_target_kind, left(p_target_id, 200), left(p_target_title, 500),
          case when jsonb_typeof(p_detail) = 'object' and pg_column_size(p_detail) <= 4096 then p_detail else '{}'::jsonb end);
exception when others then
  raise warning 'history skipped (%): %', p_action, sqlerrm;
end; $$;
revoke execute on function public.audit_log(uuid, text, text, text, text, jsonb) from public, anon, authenticated;

-- projects: archived / unarchived
create or replace function public.audit_capture_project() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is not null and old.archived_at is distinct from new.archived_at
     and (old.archived_at is null) <> (new.archived_at is null) then
    perform public.audit_log(new.workspace_id, case when new.archived_at is null then 'project.unarchived' else 'project.archived' end,
                             'project', new.id::text, new.name, '{}'::jsonb);
  end if;
  return null;
exception when others then
  raise warning 'history skipped (projects): %', sqlerrm;
  return null;
end; $$;

-- workspace_members: invited / joined / role changed / removed (left)
create or replace function public.audit_capture_member() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  who text;
  actor uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    who := coalesce(nullif(btrim(new.name), ''), new.email);
    if new.status = 'invited' then
      perform public.audit_log(new.workspace_id, 'member.invited', 'member', coalesce(new.user_id::text, new.id::text), who,
                               jsonb_build_object('email', new.email, 'role', new.role));
    elsif new.status = 'active' and new.user_id is not null
          and not (new.role = 'owner' and exists (select 1 from public.workspaces w where w.id = new.workspace_id and w.owner_id = new.user_id)) then
      perform public.audit_log(new.workspace_id, 'member.joined', 'member', new.user_id::text,
                               coalesce(nullif(btrim(new.name), ''), public.kanbo_person_name(new.user_id)),
                               jsonb_build_object('email', new.email, 'role', new.role));
    end if;
  elsif tg_op = 'UPDATE' then
    who := coalesce(nullif(btrim(new.name), ''), case when new.user_id is not null then public.kanbo_person_name(new.user_id) end, new.email);
    if old.status = 'invited' and new.status = 'active' and new.user_id is not null then
      perform public.audit_log(new.workspace_id, 'member.joined', 'member', new.user_id::text, who,
                               jsonb_build_object('email', new.email, 'role', new.role));
    end if;
    if old.role is distinct from new.role then
      perform public.audit_log(new.workspace_id, 'role.changed', 'member', coalesce(new.user_id::text, new.id::text), who,
                               jsonb_build_object('from', old.role, 'to', new.role, 'email', new.email));
    end if;
  else
    who := coalesce(nullif(btrim(old.name), ''), old.email);
    perform public.audit_log(old.workspace_id, 'member.removed', 'member', coalesce(old.user_id::text, old.id::text), who,
                             jsonb_build_object('email', old.email, 'role', old.role,
                                                'invite', old.status = 'invited',
                                                'self', old.user_id is not null and old.user_id = actor,
                                                'account_deleted', old.user_id is not null
                                                  and not exists (select 1 from auth.users u where u.id = old.user_id)));
  end if;
  return null;
exception when others then
  raise warning 'history skipped (workspace_members): %', sqlerrm;
  return null;
end; $$;

-- workspaces: renamed
create or replace function public.audit_capture_workspace() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if old.name is distinct from new.name then
    perform public.audit_log(new.id, 'workspace.renamed', 'workspace', new.id::text, new.name,
                             jsonb_build_object('from', old.name, 'to', new.name));
  end if;
  return null;
exception when others then
  raise warning 'history skipped (workspaces): %', sqlerrm;
  return null;
end; $$;

-- workspace_integrations: Slack / Notion connected or disconnected (never the URL or token)
create or replace function public.audit_capture_integration() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  was_slack boolean := tg_op = 'UPDATE' and old.slack_webhook_url is not null;
  was_notion boolean := tg_op = 'UPDATE' and old.notion_token is not null;
begin
  if (new.slack_webhook_url is not null) <> was_slack then
    perform public.audit_log(new.workspace_id, case when new.slack_webhook_url is not null then 'integration.connected' else 'integration.disconnected' end,
                             'integration', 'slack', 'Slack',
                             jsonb_build_object('provider', 'slack', 'channel', new.slack_channel_label));
  end if;
  if (new.notion_token is not null) <> was_notion then
    perform public.audit_log(new.workspace_id, case when new.notion_token is not null then 'integration.connected' else 'integration.disconnected' end,
                             'integration', 'notion', 'Notion',
                             jsonb_build_object('provider', 'notion', 'notion_workspace',
                                                case when new.notion_token is not null then new.notion_workspace_name else old.notion_workspace_name end));
  end if;
  return null;
exception when others then
  raise warning 'history skipped (workspace_integrations): %', sqlerrm;
  return null;
end; $$;

-- api_keys: a team key made or revoked (never the key or its hash)
create or replace function public.audit_capture_api_key() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.workspace_id is null then return null; end if;
  if tg_op = 'INSERT' then
    perform public.audit_log(new.workspace_id, 'api_key.created', 'api_key', new.id::text, new.name,
                             jsonb_build_object('access', new.access, 'prefix', new.prefix, 'expires_at', new.expires_at));
  elsif old.revoked_at is null and new.revoked_at is not null then
    perform public.audit_log(new.workspace_id, 'api_key.revoked', 'api_key', new.id::text, new.name,
                             jsonb_build_object('access', new.access, 'prefix', new.prefix));
  end if;
  return null;
exception when others then
  raise warning 'history skipped (api_keys): %', sqlerrm;
  return null;
end; $$;

-- webhooks: a team endpoint added or deleted (its host only: the full URL can be a credential)
create or replace function public.audit_capture_webhook() returns trigger
language plpgsql security definer set search_path = public as $$
declare w public.webhooks := case when tg_op = 'DELETE' then old else new end; host text;
begin
  if w.workspace_id is null then return null; end if;
  host := coalesce(substring(w.url from '^https://([^/:?#]+)'), 'an endpoint');
  perform public.audit_log(w.workspace_id, case when tg_op = 'DELETE' then 'webhook.deleted' else 'webhook.created' end,
                           'webhook', w.id::text, host, jsonb_build_object('host', host, 'events', to_jsonb(w.events)));
  return null;
exception when others then
  raise warning 'history skipped (webhooks): %', sqlerrm;
  return null;
end; $$;

revoke execute on function public.audit_capture_project() from public, anon, authenticated;
revoke execute on function public.audit_capture_member() from public, anon, authenticated;
revoke execute on function public.audit_capture_workspace() from public, anon, authenticated;
revoke execute on function public.audit_capture_integration() from public, anon, authenticated;
revoke execute on function public.audit_capture_api_key() from public, anon, authenticated;
revoke execute on function public.audit_capture_webhook() from public, anon, authenticated;

drop trigger if exists trg_audit_project on public.projects;
create trigger trg_audit_project after update of archived_at on public.projects
  for each row execute function public.audit_capture_project();
drop trigger if exists trg_audit_member on public.workspace_members;
create trigger trg_audit_member after insert or update of status, role, user_id or delete on public.workspace_members
  for each row execute function public.audit_capture_member();
drop trigger if exists trg_audit_workspace on public.workspaces;
create trigger trg_audit_workspace after update of name on public.workspaces
  for each row execute function public.audit_capture_workspace();
drop trigger if exists trg_audit_integration on public.workspace_integrations;
create trigger trg_audit_integration after insert or update on public.workspace_integrations
  for each row execute function public.audit_capture_integration();
drop trigger if exists trg_audit_api_key on public.api_keys;
create trigger trg_audit_api_key after insert or update of revoked_at on public.api_keys
  for each row execute function public.audit_capture_api_key();
drop trigger if exists trg_audit_webhook on public.webhooks;
create trigger trg_audit_webhook after insert or delete on public.webhooks
  for each row execute function public.audit_capture_webhook();

-- ---------- 6. the recycle bin: capture ----------
-- Rows already inside a bin entry (a deleted parent's sub-tasks, as the
-- foreign key cascades to them) are skipped by id: the parent's trigger
-- lists them in kanbo.trash_skip (transaction-local), each child's trigger
-- takes its id back out. kanbo.trash_bypass = 'on' skips the bin entirely
-- (set only by the definer functions here, around their own deletes).
-- Clients can't set either: PostgREST runs no raw SQL, and set_config() is
-- not an exposed function. Even if they could, it would only make their own
-- allowed delete permanent — what every delete was before this file.
create or replace function public.trash_skip_add(p_ids uuid[])
returns void language plpgsql set search_path = public as $$
declare cur text := coalesce(nullif(current_setting('kanbo.trash_skip', true), ''), ',');
begin
  if p_ids is null or cardinality(p_ids) = 0 then return; end if;
  perform set_config('kanbo.trash_skip', cur || array_to_string(p_ids, ',') || ',', true);
end; $$;

create or replace function public.trash_skip_take(p_id uuid)
returns boolean language plpgsql set search_path = public as $$
declare
  cur text := coalesce(current_setting('kanbo.trash_skip', true), '');
  key text := ',' || p_id::text || ',';
begin
  if cur = '' or position(key in cur) = 0 then return false; end if;
  cur := replace(cur, key, ',');
  perform set_config('kanbo.trash_skip', case when cur = ',' then '' else cur end, true);
  return true;
end; $$;
revoke execute on function public.trash_skip_add(uuid[]) from public, anon, authenticated;
revoke execute on function public.trash_skip_take(uuid) from public, anon, authenticated;

-- everything that hangs off these tasks (they're all still there)
create or replace function public.trash_task_graph(p_ids uuid[])
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'tasks', coalesce((select jsonb_agg(to_jsonb(t) order by t.created_at, t.id) from public.tasks t where t.id = any (p_ids)), '[]'::jsonb),
    'checklist', coalesce((select jsonb_agg(to_jsonb(s) order by s.task_id, s.position, s.id) from public.subtasks s where s.task_id = any (p_ids)), '[]'::jsonb),
    'dependencies', coalesce((select jsonb_agg(to_jsonb(d)) from public.task_dependencies d
                               where d.task_id = any (p_ids) or d.depends_on = any (p_ids)), '[]'::jsonb),
    'comments', coalesce((select jsonb_agg(to_jsonb(c) order by c.created_at, c.id) from public.comments c where c.task_id = any (p_ids)), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at, a.id) from public.attachments a where a.task_id = any (p_ids)), '[]'::jsonb),
    'task_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.created_at, e.id) from public.task_events e where e.task_id = any (p_ids)), '[]'::jsonb),
    'task_user_state', coalesce((select jsonb_agg(to_jsonb(s)) from public.task_user_state s where s.task_id = any (p_ids)), '[]'::jsonb),
    'notion_links', coalesce((select jsonb_agg(to_jsonb(l)) from public.notion_links l where l.task_id = any (p_ids)), '[]'::jsonb),
    'notion_link_state', coalesce((select jsonb_agg(to_jsonb(s)) from public.notion_link_state s
                                     join public.notion_links l on l.id = s.link_id where l.task_id = any (p_ids)), '[]'::jsonb),
    'approvals', coalesce((select jsonb_agg(to_jsonb(a) order by a.created_at, a.id) from public.approvals a where a.task_id = any (p_ids)), '[]'::jsonb),
    'approval_reviewers', coalesce((select jsonb_agg(to_jsonb(r)) from public.approval_reviewers r
                                      join public.approvals a on a.id = r.approval_id where a.task_id = any (p_ids)), '[]'::jsonb));
$$;
revoke execute on function public.trash_task_graph(uuid[]) from public, anon, authenticated;

create or replace function public.trash_counts(p_snap jsonb)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'tasks', jsonb_array_length(coalesce(p_snap -> 'tasks', '[]'::jsonb)),
    'comments', jsonb_array_length(coalesce(p_snap -> 'comments', '[]'::jsonb)),
    'attachments', jsonb_array_length(coalesce(p_snap -> 'attachments', '[]'::jsonb)),
    'checklist', jsonb_array_length(coalesce(p_snap -> 'checklist', '[]'::jsonb)),
    'sections', jsonb_array_length(coalesce(p_snap -> 'sections', '[]'::jsonb)),
    'docs', jsonb_array_length(coalesce(p_snap -> 'docs', '[]'::jsonb)));
$$;
revoke execute on function public.trash_counts(jsonb) from public, anon, authenticated;

-- Reserve the ids a bin entry will come back under: its tasks, checklist
-- items, comments, files, sections, docs and its project (every table whose
-- ids a person can choose). Children's ids (dependencies, plans, approvals,
-- versions…) are the server's own or restore without a conflict.
create or replace function public.trash_reserve(p_trash uuid, p_snap jsonb)
returns void language sql set search_path = public as $$
  insert into public.trash_ids (id, trash_id)
  select distinct x.id, p_trash
    from (select public.kanbo_uuid(e ->> 'id') as id
            from unnest(array['tasks', 'checklist', 'comments', 'attachments', 'sections', 'docs']) k,
                 jsonb_array_elements(case when jsonb_typeof(p_snap -> k) = 'array' then p_snap -> k else '[]'::jsonb end) e
          union all
          select public.kanbo_uuid(p_snap -> 'project' ->> 'id')) x
   where x.id is not null
  on conflict (id) do update set trash_id = excluded.trash_id;
$$;
revoke execute on function public.trash_reserve(uuid, jsonb) from public, anon, authenticated;

create or replace function public.trash_capture_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  ids   uuid[];
  snap  jsonb;
  actor uuid;
  tid   uuid;
  cnt   jsonb;
begin
  if coalesce(current_setting('kanbo.trash_bypass', true), '') = 'on' then return old; end if;
  if public.trash_skip_take(old.id) then return old; end if;              -- in its parent's (or project's) entry
  if old.workspace_id is not null and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;                                                           -- the whole workspace is being closed
  end if;
  if not exists (select 1 from auth.users u where u.id = old.user_id) then
    return old;                                                           -- its owner's account is being deleted
  end if;
  with recursive d(id) as (
    select old.id
    union
    select t.id from public.tasks t join d on t.parent_id = d.id
  ) select array_agg(d.id) into ids from d;
  snap := public.trash_task_graph(ids);
  cnt := public.trash_counts(snap);
  actor := public.kanbo_actor();
  insert into public.trash (kind, item_id, workspace_id, user_id, project_id, title, summary, snapshot, deleted_by, deleted_by_name)
  values ('task', old.id, old.workspace_id, old.user_id, old.project_id, left(coalesce(old.title, ''), 500),
          jsonb_build_object(
            'project', (select jsonb_build_object('id', p.id, 'name', p.name, 'emoji', p.emoji, 'color', p.color)
                          from public.projects p where p.id = public.kanbo_uuid(old.project_id)),
            'parent', (select jsonb_build_object('id', x.id, 'title', x.title) from public.tasks x where x.id = old.parent_id),
            'status', old.status, 'priority', old.priority, 'due_date', old.due_date, 'assignee_id', old.assignee_id,
            'archived', old.archived_at is not null,
            'counts', cnt || jsonb_build_object('subtasks', greatest((cnt ->> 'tasks')::integer - 1, 0))),
          jsonb_build_object('v', 1) || snap,
          actor, left(case when actor is null then 'Kanbo' else public.kanbo_person_name(actor) end, 200))
  returning id into tid;
  perform public.trash_reserve(tid, snap);
  perform public.trash_skip_add(array_remove(ids, old.id));
  if old.workspace_id is not null then
    perform public.audit_log(old.workspace_id, 'task.deleted', 'task', old.id::text, old.title,
                             jsonb_build_object('trash_id', tid, 'subtasks', cardinality(ids) - 1, 'project_id', old.project_id));
  end if;
  return old;
end; $$;

create or replace function public.trash_capture_project() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  tids  uuid[];
  sids  uuid[];
  snap  jsonb;
  actor uuid;
  tid   uuid;
  prev  text;
  cnt   jsonb;
begin
  if coalesce(current_setting('kanbo.trash_bypass', true), '') = 'on' then return old; end if;
  if old.workspace_id is not null and not exists (select 1 from public.workspaces w where w.id = old.workspace_id) then
    return old;
  end if;
  if not exists (select 1 from auth.users u where u.id = old.user_id) then return old; end if;
  -- its tasks, in its own scope (a stranger's task naming this project stays theirs), and every sub-task of them
  with recursive roots as (
    select t.id from public.tasks t
     where t.project_id = old.id::text
       and ((old.workspace_id is null and t.workspace_id is null and t.user_id = old.user_id)
         or (old.workspace_id is not null and t.workspace_id = old.workspace_id))
  ), d(id) as (
    select r.id from roots r
    union
    select t.id from public.tasks t join d on t.parent_id = d.id
  ) select coalesce(array_agg(d.id), '{}') into tids from d;
  select coalesce(array_agg(s.id), '{}') into sids from public.sections s
   where s.project_id = old.id::text
     and ((old.workspace_id is null and s.workspace_id is null and s.user_id = old.user_id)
       or (old.workspace_id is not null and s.workspace_id = old.workspace_id));
  snap := jsonb_build_object(
            'v', 1,
            'project', to_jsonb(old),
            'sections', coalesce((select jsonb_agg(to_jsonb(s) order by s.position nulls last, s.created_at, s.id)
                                    from public.sections s where s.id = any (sids)), '[]'::jsonb),
            'docs', coalesce((select jsonb_agg(to_jsonb(x) order by x.position nulls last, x.created_at, x.id)
                                from public.project_docs x where x.project_id = old.id), '[]'::jsonb),
            'doc_versions', coalesce((select jsonb_agg(to_jsonb(v) order by v.saved_at, v.id)
                                        from public.project_doc_versions v join public.project_docs x on x.id = v.doc_id
                                       where x.project_id = old.id), '[]'::jsonb),
            'notion_syncs', coalesce((select jsonb_agg(to_jsonb(n)) from public.notion_syncs n where n.project_id = old.id), '[]'::jsonb))
          || public.trash_task_graph(tids);
  cnt := public.trash_counts(snap);
  actor := public.kanbo_actor();
  insert into public.trash (kind, item_id, workspace_id, user_id, project_id, title, summary, snapshot, deleted_by, deleted_by_name)
  values ('project', old.id, old.workspace_id, old.user_id, old.id::text, left(coalesce(old.name, ''), 500),
          jsonb_build_object(
            'project', jsonb_build_object('id', old.id, 'name', old.name, 'emoji', old.emoji, 'color', old.color,
                                          'description', old.description),
            'archived', old.archived_at is not null,
            'counts', cnt),
          snap, actor, left(case when actor is null then 'Kanbo' else public.kanbo_person_name(actor) end, 200))
  returning id into tid;
  perform public.trash_reserve(tid, snap);
  -- its tasks and sections go into this one entry: delete them without bin entries of their own
  prev := coalesce(current_setting('kanbo.trash_bypass', true), '');
  perform set_config('kanbo.trash_bypass', 'on', true);
  delete from public.tasks where id = any (tids);
  delete from public.sections where id = any (sids);
  perform set_config('kanbo.trash_bypass', prev, true);
  if old.workspace_id is not null then
    perform public.audit_log(old.workspace_id, 'project.deleted', 'project', old.id::text, old.name,
                             jsonb_build_object('trash_id', tid, 'tasks', cardinality(tids), 'sections', cardinality(sids)));
  end if;
  return old;
end; $$;

revoke execute on function public.trash_capture_task() from public, anon, authenticated;
revoke execute on function public.trash_capture_project() from public, anon, authenticated;

drop trigger if exists trg_trash_task on public.tasks;
create trigger trg_trash_task before delete on public.tasks
  for each row execute function public.trash_capture_task();
drop trigger if exists trg_trash_project on public.projects;
create trigger trg_trash_project before delete on public.projects
  for each row execute function public.trash_capture_project();

-- Binned ids stay reserved: no new row under one, and no row's id changed to
-- one, except by the restore itself (kanbo.restoring, set only by
-- restore_from_trash around its own inserts). Answers like a duplicate key.
create or replace function public.trash_guard_ids() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.id is not distinct from old.id then return new; end if;
  if coalesce(current_setting('kanbo.restoring', true), '') = 'on' then return new; end if;
  if exists (select 1 from public.trash_ids r where r.id = new.id) then
    raise exception 'id in use' using errcode = 'unique_violation';
  end if;
  return new;
end; $$;
revoke execute on function public.trash_guard_ids() from public, anon, authenticated;

do $guard$
declare t text;
begin
  foreach t in array array['tasks', 'projects', 'sections', 'project_docs', 'subtasks', 'comments', 'attachments'] loop
    execute format('drop trigger if exists trg_trash_guard_ids on public.%I', t);
    execute format('create trigger trg_trash_guard_ids before insert or update of id on public.%I '
                   'for each row execute function public.trash_guard_ids()', t);
  end loop;
end $guard$;

-- (re-running this file) reserve the ids of what's already in the bin
do $reserve$
declare r record;
begin
  for r in select x.id, x.snapshot from public.trash x
            where x.restored_at is null
              and not exists (select 1 from public.trash_ids i where i.trash_id = x.id)
            order by x.deleted_at loop
    perform public.trash_reserve(r.id, r.snapshot);
  end loop;
end $reserve$;

-- ---------- 7. the recycle bin: restore ----------
-- Insert jsonb rows into a table, naming only the columns the rows carry (a
-- column added after the snapshot was taken gets its default). Internal.
create or replace function public.trash_insert(p_table text, p_rows jsonb, p_skip_conflicts boolean default false)
returns integer language plpgsql set search_path = public as $$
declare cols text; n integer;
begin
  if p_table not in ('tasks','subtasks','task_dependencies','comments','attachments','task_events','task_user_state',
                     'notion_links','notion_link_state','approvals','approval_reviewers','projects','sections',
                     'project_docs','project_doc_versions','notion_syncs') then
    raise exception 'trash_insert: % is not restorable', p_table;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then return 0; end if;
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum) into cols
    from pg_catalog.pg_attribute a
   where a.attrelid = ('public.' || p_table)::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = ''
     and exists (select 1 from jsonb_array_elements(p_rows) r where r ? a.attname);
  if cols is null then return 0; end if;
  execute format('insert into public.%I (%s) select %s from jsonb_populate_recordset(null::public.%I, $1)%s',
                 p_table, cols, cols, p_table, case when p_skip_conflicts then ' on conflict do nothing' else '' end)
    using p_rows;
  get diagnostics n = row_count;
  return n;
end; $$;
revoke execute on function public.trash_insert(text, jsonb, boolean) from public, anon, authenticated;

-- rows whose p_col names an account that no longer exists: point it at p_to (null clears it)
create or replace function public.trash_fix_user(p_rows jsonb, p_col text, p_to uuid default null)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(case
           when x ->> p_col is null then x
           when exists (select 1 from auth.users u where u.id = public.kanbo_uuid(x ->> p_col)) then x
           else jsonb_set(x, array[p_col], coalesce(to_jsonb(p_to), 'null'::jsonb)) end), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x;
$$;
-- only the rows whose p_col names an account that still exists
create or replace function public.trash_keep_users(p_rows jsonb, p_col text)
returns jsonb language sql stable set search_path = public as $$
  select coalesce(jsonb_agg(x), '[]'::jsonb)
    from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) x
   where exists (select 1 from auth.users u where u.id = public.kanbo_uuid(x ->> p_col));
$$;
revoke execute on function public.trash_fix_user(jsonb, text, uuid) from public, anon, authenticated;
revoke execute on function public.trash_keep_users(jsonb, text) from public, anon, authenticated;

-- Put a snapshot's tasks (and everything hanging off them) back. p_heir owns
-- rows whose creator's account is gone (the workspace's owner). Returns
-- { tasks, note, moved_to }. Internal.
create or replace function public.trash_restore_tasks(p_snap jsonb, p_heir uuid)
returns jsonb language plpgsql set search_path = public as $$
declare
  src     jsonb := coalesce(p_snap -> 'tasks', '[]'::jsonb);
  ids     uuid[];
  out_r   jsonb[] := '{}';
  x       jsonb;
  pid     text;
  pid2    text;
  pname   text;
  ws      uuid;
  sec     text;
  msec    text;
  par     text;
  uid     text;
  moved   text;
  orphan  boolean := false;
  n       integer;
  rows    jsonb;
  done    jsonb := '{}'::jsonb;    -- fallback project per workspace (ws id → [id, name])
begin
  if jsonb_array_length(src) = 0 then return jsonb_build_object('tasks', 0); end if;
  select array_agg((e ->> 'id')::uuid) into ids from jsonb_array_elements(src) e;
  if exists (select 1 from public.tasks t where t.id = any (ids)) then
    raise exception 'restore conflict' using hint = 'Some of these tasks exist again.';
  end if;

  for x in select e from jsonb_array_elements(src) e loop
    pid := x ->> 'project_id';
    ws := public.kanbo_uuid(x ->> 'workspace_id');
    pid2 := pid;
    if public.kanbo_uuid(pid) is not null and not exists (select 1 from public.projects p where p.id = public.kanbo_uuid(pid)) then
      -- its project is gone: the workspace's first project, or Personal
      if ws is null then
        pid2 := 'p-personal'; moved := 'Personal';
      else
        if done ? ws::text then
          pid2 := done -> ws::text ->> 0; pname := done -> ws::text ->> 1;
        else
          select p.id::text, p.name into pid2, pname from public.projects p
           where p.workspace_id = ws order by (p.archived_at is not null), p.created_at, p.id limit 1;
          if pid2 is null then
            raise exception 'no project to restore into' using hint = 'Make a project in this workspace first.';
          end if;
          done := done || jsonb_build_object(ws::text, jsonb_build_array(pid2, pname));
        end if;
        moved := pname;
      end if;
    end if;
    sec := x ->> 'section_id';
    if sec is not null and (pid2 is distinct from pid
        or not exists (select 1 from public.sections s where s.id = public.kanbo_uuid(sec))) then
      sec := null;
    end if;
    msec := x ->> 'my_section_id';
    if msec is not null and not exists (select 1 from public.sections s where s.id = public.kanbo_uuid(msec)) then
      msec := null;
    end if;
    par := x ->> 'parent_id';
    if par is not null and not (public.kanbo_uuid(par) = any (ids))
       and not exists (select 1 from public.tasks t where t.id = public.kanbo_uuid(par)) then
      par := null; orphan := true;
    end if;
    uid := x ->> 'user_id';
    if not exists (select 1 from auth.users u where u.id = public.kanbo_uuid(uid)) then uid := p_heir::text; end if;
    out_r := array_append(out_r, x || jsonb_build_object('project_id', pid2, 'section_id', sec, 'my_section_id', msec,
                                                          'parent_id', par, 'user_id', uid));
  end loop;
  n := public.trash_insert('tasks', to_jsonb(out_r));

  perform public.trash_insert('subtasks', p_snap -> 'checklist');

  -- comments: replies to a comment that's gone become top-level; departed authors stay by name
  select coalesce(jsonb_agg(c || jsonb_build_object(
           'parent_id', case when c ->> 'parent_id' is null then null
                             when exists (select 1 from jsonb_array_elements(p_snap -> 'comments') o where o ->> 'id' = c ->> 'parent_id') then c -> 'parent_id'
                             when exists (select 1 from public.comments o where o.id = public.kanbo_uuid(c ->> 'parent_id')) then c -> 'parent_id'
                             else null end)), '[]'::jsonb)
    into rows from jsonb_array_elements(coalesce(p_snap -> 'comments', '[]'::jsonb)) c;
  perform public.trash_insert('comments', public.trash_fix_user(rows, 'user_id', null));

  -- attachments: a departed uploader's files belong to the task's owner (as 0041 does)
  select coalesce(jsonb_agg(case
           when exists (select 1 from auth.users u where u.id = public.kanbo_uuid(a ->> 'user_id')) then a
           else jsonb_set(a, '{user_id}', to_jsonb((select t.user_id from public.tasks t where t.id = public.kanbo_uuid(a ->> 'task_id')))) end), '[]'::jsonb)
    into rows from jsonb_array_elements(coalesce(p_snap -> 'attachments', '[]'::jsonb)) a;
  perform public.trash_insert('attachments', rows);

  perform public.trash_insert('task_events', public.trash_fix_user(p_snap -> 'task_events', 'actor_id', null));
  perform public.trash_insert('task_user_state', public.trash_keep_users(p_snap -> 'task_user_state', 'user_id'), true);

  -- dependencies whose both ends are there now
  select coalesce(jsonb_agg(d), '[]'::jsonb) into rows
    from jsonb_array_elements(coalesce(p_snap -> 'dependencies', '[]'::jsonb)) d
   where exists (select 1 from public.tasks t where t.id = public.kanbo_uuid(d ->> 'task_id'))
     and exists (select 1 from public.tasks t where t.id = public.kanbo_uuid(d ->> 'depends_on'));
  perform public.trash_insert('task_dependencies', rows, true);

  -- Notion links: a link whose sync is gone (or whose page the sync has linked
  -- to another task since) comes back as a plain link
  select coalesce(jsonb_agg(l || case
           when l ->> 'sync_id' is not null
                and exists (select 1 from public.notion_syncs s where s.id = public.kanbo_uuid(l ->> 'sync_id'))
                and not exists (select 1 from public.notion_links o
                                 where o.sync_id = public.kanbo_uuid(l ->> 'sync_id') and o.notion_page_id = l ->> 'notion_page_id')
             then '{}'::jsonb
           else jsonb_build_object('sync_id', null, 'kind', 'reference') end), '[]'::jsonb)
    into rows from jsonb_array_elements(coalesce(p_snap -> 'notion_links', '[]'::jsonb)) l;
  perform public.trash_insert('notion_links', public.trash_fix_user(rows, 'created_by', null), true);
  select coalesce(jsonb_agg(s), '[]'::jsonb) into rows
    from jsonb_array_elements(coalesce(p_snap -> 'notion_link_state', '[]'::jsonb)) s
   where exists (select 1 from public.notion_links l where l.id = public.kanbo_uuid(s ->> 'link_id'));
  perform public.trash_insert('notion_link_state', rows, true);

  -- approvals and their reviews
  select coalesce(jsonb_agg(case
           when a ->> 'attachment_id' is null
                or exists (select 1 from public.attachments x where x.id = public.kanbo_uuid(a ->> 'attachment_id')) then a
           else jsonb_set(a, '{attachment_id}', 'null'::jsonb) end), '[]'::jsonb)
    into rows from jsonb_array_elements(coalesce(p_snap -> 'approvals', '[]'::jsonb)) a;
  perform public.trash_insert('approvals', public.trash_fix_user(rows, 'requested_by', null), true);
  select coalesce(jsonb_agg(r), '[]'::jsonb) into rows
    from jsonb_array_elements(public.trash_keep_users(p_snap -> 'approval_reviewers', 'user_id')) r
   where exists (select 1 from public.approvals a where a.id = public.kanbo_uuid(r ->> 'approval_id'));
  perform public.trash_insert('approval_reviewers', rows, true);

  return jsonb_build_object(
    'tasks', n,
    'moved_to', moved,
    'note', nullif(concat_ws(' ',
              case when moved is not null then 'Its project was deleted, so it''s back in ' ||
                   case when moved = 'Personal' then 'Personal.' else '“' || moved || '”.' end end,
              case when orphan then 'Its parent task isn''t there any more, so it''s a top-level task now.' end), ''));
end; $$;
revoke execute on function public.trash_restore_tasks(jsonb, uuid) from public, anon, authenticated;

create or replace function public.trash_restore_project(p_snap jsonb, p_heir uuid)
returns jsonb language plpgsql set search_path = public as $$
declare
  proj jsonb := p_snap -> 'project';
  rows jsonb;
begin
  if proj is null or exists (select 1 from public.projects p where p.id = public.kanbo_uuid(proj ->> 'id')) then
    raise exception 'restore conflict' using hint = 'The project exists again.';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_snap -> 'sections', '[]'::jsonb)) s
              join public.sections x on x.id = public.kanbo_uuid(s ->> 'id'))
     or exists (select 1 from jsonb_array_elements(coalesce(p_snap -> 'docs', '[]'::jsonb)) d
                 join public.project_docs x on x.id = public.kanbo_uuid(d ->> 'id')) then
    raise exception 'restore conflict' using hint = 'Some of its sections or docs exist again.';
  end if;
  rows := public.trash_fix_user(public.trash_fix_user(jsonb_build_array(proj), 'user_id', p_heir), 'owner_id', p_heir);
  perform public.trash_insert('projects', rows);
  perform public.trash_insert('sections', public.trash_fix_user(p_snap -> 'sections', 'user_id', p_heir));
  perform public.trash_insert('notion_syncs', public.trash_fix_user(p_snap -> 'notion_syncs', 'created_by', null), true);
  perform public.trash_insert('project_docs',
            public.trash_fix_user(public.trash_fix_user(p_snap -> 'docs', 'created_by', null), 'updated_by', null));
  perform public.trash_insert('project_doc_versions', public.trash_fix_user(p_snap -> 'doc_versions', 'saved_by', null));
  return public.trash_restore_tasks(p_snap, p_heir);
end; $$;
revoke execute on function public.trash_restore_project(jsonb, uuid) from public, anon, authenticated;

-- Restore one bin item. Writers of its workspace (personal: its creator).
-- Answers { id, kind, item_id, status: 'restored' | 'already_restored',
--           project_id (where the task / project now is), note, counts }.
-- Errors: 'not authorized' · 'not found' (gone, or not yours) ·
--         'restore conflict' (an id exists again: only for rows made before
--         the ids were reserved) · 'no project to restore into'
create or replace function public.restore_from_trash(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  r    public.trash;
  heir uuid;
  res  jsonb;
  prev text;
  pid  text;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into r from public.trash where id = p_id for update;
  if r.id is null
     or not ((r.workspace_id is null and r.user_id = me)
             or (r.workspace_id is not null and public.can_write(r.workspace_id))) then
    raise exception 'not found';                 -- same answer whether it's gone or not yours
  end if;
  if r.restored_at is not null then
    return jsonb_build_object('id', r.id, 'kind', r.kind, 'item_id', r.item_id, 'status', 'already_restored',
                              'project_id', case when r.kind = 'project' then r.item_id::text
                                                 else (select t.project_id from public.tasks t where t.id = r.item_id) end,
                              'note', null, 'counts', r.summary -> 'counts');
  end if;
  heir := case when r.workspace_id is null then r.user_id
               else (select w.owner_id from public.workspaces w where w.id = r.workspace_id) end;
  prev := coalesce(current_setting('kanbo.restoring', true), '');
  perform set_config('kanbo.restoring', 'on', true);
  if r.kind = 'project' then res := public.trash_restore_project(r.snapshot, heir);
  else res := public.trash_restore_tasks(r.snapshot, heir);
  end if;
  perform set_config('kanbo.restoring', prev, true);
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
end; $$;

-- Several at once (bulk restore, Undo): newest delete first, so a parent
-- comes back before a sub-task that was deleted on its own earlier. Each item
-- succeeds or fails alone. Answers [{ id, ok, result | error }].
create or replace function public.restore_trash_items(p_ids uuid[])
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  out_r jsonb := '[]'::jsonb;
  i uuid;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return out_r; end if;
  if cardinality(p_ids) > 200 then raise exception 'too many items'; end if;
  for i in select x.id from unnest(p_ids) as x(id)
            left join public.trash t on t.id = x.id
           group by x.id, t.deleted_at order by t.deleted_at desc nulls last loop
    begin
      out_r := out_r || jsonb_build_array(jsonb_build_object('id', i, 'ok', true, 'result', public.restore_from_trash(i)));
    exception when others then
      out_r := out_r || jsonb_build_array(jsonb_build_object('id', i, 'ok', false, 'error', sqlerrm));
    end;
  end loop;
  return out_r;
end; $$;

-- ---------- 8. the recycle bin: purge ----------
-- Delete a bin row for good. Its attachments' files are queued for storage
-- cleanup; a deleted project's leftover settings (custom fields, rules,
-- request forms, status updates — rows that only name the project) go too.
-- Internal (purge_trash and trash_housekeeping check who may).
create or replace function public.trash_purge_row(p_id uuid)
returns void language plpgsql set search_path = public as $$
declare r public.trash; t text;
begin
  select * into r from public.trash where id = p_id;
  if r.id is null then return; end if;
  if r.restored_at is null then
    insert into public.storage_cleanup (bucket, path, reason)
    select distinct 'task-files', a ->> 'path', 'bin'
      from jsonb_array_elements(coalesce(r.snapshot -> 'attachments', '[]'::jsonb)) a
     where coalesce(a ->> 'path', '') <> ''
       and not exists (select 1 from public.attachments x where x.path = a ->> 'path')
    on conflict do nothing;
    if r.kind = 'project' and not exists (select 1 from public.projects p where p.id = r.item_id) then
      foreach t in array array['custom_field_defs', 'automation_rules', 'forms', 'status_updates'] loop
        execute format('delete from public.%I x where x.project_id = $1 and '
                       || '((x.workspace_id is null and $2::uuid is null and x.user_id = $3) or x.workspace_id = $2)', t)
          using r.item_id::text, r.workspace_id, r.user_id;
      end loop;
    end if;
  end if;
  delete from public.trash where id = r.id;
end; $$;
revoke execute on function public.trash_purge_row(uuid) from public, anon, authenticated;

-- "Delete forever": owners/admins for team items, the creator for personal ones.
create or replace function public.purge_trash(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.trash;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into r from public.trash where id = p_id for update;
  if r.id is null
     or not ((r.workspace_id is null and r.user_id = me)
             or (r.workspace_id is not null and public.ws_role(r.workspace_id) in ('owner', 'admin'))) then
    raise exception 'not found';
  end if;
  perform public.trash_purge_row(r.id);
  if r.workspace_id is not null and r.restored_at is null then
    perform public.audit_log(r.workspace_id, r.kind || '.purged', r.kind, r.item_id::text, r.title,
                             jsonb_build_object('deleted_at', r.deleted_at, 'deleted_by', r.deleted_by_name));
  end if;
  return true;
end; $$;

-- Daily (service role / pg_cron; api_housekeeping() calls it too): purge
-- what's past purge_after, forget restored rows after 30 days, history after
-- 365 days. Answers the counts.
create or replace function public.trash_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare r record; a integer := 0; b integer; c integer;
begin
  for r in select id, kind, item_id, workspace_id, title, deleted_at, deleted_by_name from public.trash
            where restored_at is null and purge_after <= now()
            order by purge_after limit 1000 for update skip locked loop
    perform public.trash_purge_row(r.id);
    if r.workspace_id is not null then
      perform public.audit_log(r.workspace_id, r.kind || '.purged', r.kind, r.item_id::text, r.title,
                               jsonb_build_object('expired', true, 'deleted_at', r.deleted_at, 'deleted_by', r.deleted_by_name));
    end if;
    a := a + 1;
  end loop;
  delete from public.trash where restored_at is not null and restored_at < now() - interval '30 days';
  get diagnostics b = row_count;
  delete from public.audit_events where created_at < now() - interval '365 days';
  get diagnostics c = row_count;
  return jsonb_build_object('purged', a, 'restored_cleared', b, 'history_pruned', c);
end; $$;

revoke execute on function public.restore_from_trash(uuid) from public, anon;
revoke execute on function public.restore_trash_items(uuid[]) from public, anon;
revoke execute on function public.purge_trash(uuid) from public, anon;
revoke execute on function public.trash_housekeeping() from public, anon, authenticated;
grant execute on function public.restore_from_trash(uuid) to authenticated;
grant execute on function public.restore_trash_items(uuid[]) to authenticated;
grant execute on function public.purge_trash(uuid) to authenticated;

-- 0046's daily tidy-up also empties the bin (same cron job, nothing new to schedule)
create or replace function public.api_housekeeping()
returns jsonb language plpgsql security definer set search_path = public as $$
declare a integer; b integer; c integer; bin jsonb;
begin
  delete from public.api_idempotency where created_at < now() - interval '24 hours';
  get diagnostics a = row_count;
  delete from public.webhook_outbox where created_at < now() - interval '14 days';
  get diagnostics b = row_count;
  delete from public.rate_limits where key like 'kanbo:api:%' and last_at < now() - interval '1 day';
  get diagnostics c = row_count;
  begin
    bin := public.trash_housekeeping();
  exception when others then
    raise warning 'bin housekeeping skipped: %', sqlerrm;
    bin := jsonb_build_object('error', sqlerrm);
  end;
  return jsonb_build_object('idempotency', a, 'outbox', b, 'rate_limits', c, 'bin', bin);
end; $$;
revoke execute on function public.api_housekeeping() from public, anon, authenticated;

-- ---------- 9. approvals ----------
create or replace function public.approval_json(a public.approvals)
returns jsonb language sql security definer stable set search_path = public as $$
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
                  and exists (select 1 from public.approval_reviewers r where r.approval_id = a.id and r.user_id = auth.uid()),
    'can_cancel', a.status = 'pending' and auth.uid() is not null and public.can_act()
                  and (a.requested_by = auth.uid() or public.ws_role(a.workspace_id) in ('owner', 'admin')));
$$;
create or replace function public.approval_task_json(p_task uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('id', t.id, 'title', t.title, 'project_id', t.project_id, 'workspace_id', t.workspace_id,
                            'status', t.status, 'due_date', t.due_date)
    from public.tasks t where t.id = p_task;
$$;
revoke execute on function public.approval_json(public.approvals) from public, anon, authenticated;
revoke execute on function public.approval_task_json(uuid) from public, anon, authenticated;

-- the status an approval resolves to, from its reviews
create or replace function public.approval_resolve(p_approval uuid, p_rule text)
returns text language sql stable set search_path = public as $$
  select case
    when exists (select 1 from public.approval_reviewers r where r.approval_id = p_approval and r.decision = 'changes_requested')
      then 'changes_requested'
    when p_rule = 'any' and exists (select 1 from public.approval_reviewers r where r.approval_id = p_approval and r.decision = 'approved')
      then 'approved'
    when p_rule = 'all' and exists (select 1 from public.approval_reviewers r where r.approval_id = p_approval)
         and not exists (select 1 from public.approval_reviewers r where r.approval_id = p_approval and r.decision is distinct from 'approved')
      then 'approved'
    else 'pending' end;
$$;
revoke execute on function public.approval_resolve(uuid, text) from public, anon, authenticated;

-- approval.requested / approval.decided to the request's workspace's webhooks
-- (never blocks). The task as it is now, unless p_task says what to send (a
-- task leaving the workspace: what the old workspace knew). Never sends a
-- task that's in another workspace now.
drop function if exists public.approval_webhook(public.approvals, text, jsonb);   -- (before p_task)
create or replace function public.approval_webhook(a public.approvals, p_event text, p_decision jsonb default null,
                                                   p_task jsonb default null)
returns void language plpgsql security definer set search_path = public as $$
declare tj jsonb;
begin
  if not exists (select 1 from public.webhooks w where w.active) then return; end if;
  tj := coalesce(p_task, public.approval_task_json(a.task_id));
  if tj is null or public.kanbo_uuid(tj ->> 'workspace_id') is distinct from a.workspace_id then return; end if;
  perform public.webhook_enqueue(a.workspace_id, null, p_event, a.id::text,
    jsonb_build_object(
      'approval', to_jsonb(a),
      'reviewers', coalesce((select jsonb_agg(to_jsonb(r) order by r.user_id) from public.approval_reviewers r where r.approval_id = a.id), '[]'::jsonb),
      'task', tj)
    || case when p_decision is not null then jsonb_build_object('decision', p_decision) else '{}'::jsonb end);
exception when others then
  raise warning 'webhook capture skipped (approvals): %', sqlerrm;
end; $$;
revoke execute on function public.approval_webhook(public.approvals, text, jsonb, jsonb) from public, anon, authenticated;

-- Ask for approval on a team task (people who can edit it; never guests).
-- p_reviewers: 1–10 people in the task's workspace (guests may review), not
-- you. p_rule 'any' | 'all'. p_attachment: one of the task's files.
-- Errors: 'not authorized' · 'task not found' · 'approvals need a team task' ·
-- 'invalid rule' · 'invalid reviewers' · 'invalid note' · 'invalid attachment' · 'already pending'
create or replace function public.request_approval(p_task uuid, p_reviewers uuid[], p_note text default null,
                                                   p_rule text default 'any', p_title text default null,
                                                   p_attachment uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  t       record;
  rv      uuid[];
  rl      text := lower(btrim(coalesce(p_rule, 'any')));
  nt      text := nullif(btrim(coalesce(p_note, '')), '');
  a       public.approvals;
  m       uuid;
  me_name text;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select x.id, x.title, x.workspace_id, x.user_id into t from public.tasks x where x.id = p_task;
  if t.id is null or not public.can_edit_task(p_task) then raise exception 'task not found'; end if;
  if t.workspace_id is null then raise exception 'approvals need a team task'; end if;
  if rl not in ('any', 'all') then raise exception 'invalid rule'; end if;
  if nt is not null and length(nt) > 2000 then raise exception 'invalid note'; end if;
  select coalesce(array_agg(distinct x), '{}') into rv from unnest(coalesce(p_reviewers, '{}')) x where x is not null and x <> me;
  if cardinality(rv) < 1 or cardinality(rv) > 10
     or exists (select 1 from unnest(rv) x where public.user_ws_role(x, t.workspace_id) = 'none') then
    raise exception 'invalid reviewers';
  end if;
  if p_attachment is not null and not exists (select 1 from public.attachments x where x.id = p_attachment and x.task_id = p_task) then
    raise exception 'invalid attachment';
  end if;
  perform pg_advisory_xact_lock(hashtext('kanbo:approvals:' || p_task::text));
  if exists (select 1 from public.approvals x where x.task_id = p_task and x.status = 'pending') then
    raise exception 'already pending';
  end if;
  insert into public.approvals (task_id, workspace_id, requested_by, title, note, attachment_id, rule)
  values (p_task, t.workspace_id, me, left(coalesce(nullif(btrim(coalesce(p_title, '')), ''), t.title, ''), 200), nt, p_attachment, rl)
  returning * into a;
  insert into public.approval_reviewers (approval_id, user_id) select a.id, x from unnest(rv) x;
  me_name := public.kanbo_person_name(me);
  foreach m in array rv loop
    if public.notif_on(m, 'approval') then
      insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
      values (m, t.id, coalesce(t.title, ''), 'approval', me_name,
              jsonb_build_object('approval_id', a.id, 'event', 'requested', 'status', 'pending', 'rule', rl));
    end if;
  end loop;
  insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value)
  values (t.id, me, me_name, 'approval', 'pending', 'requested');
  perform public.approval_webhook(a, 'approval.requested');
  return public.approval_json(a);
end; $$;

-- A reviewer approves or asks for changes (only their own review; while the
-- request is open; they can change their mind until it resolves).
-- Errors: 'not authorized' · 'invalid decision' · 'invalid comment' ·
--         'approval not found' (gone, or you're not a reviewer) · 'approval closed'
create or replace function public.decide_approval(p_approval uuid, p_decision text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  a       public.approvals;
  d       text := lower(btrim(coalesce(p_decision, '')));
  c       text := nullif(btrim(coalesce(p_comment, '')), '');
  st      text;
  t       record;
  me_name text;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if d not in ('approved', 'changes_requested') then raise exception 'invalid decision'; end if;
  if c is not null and length(c) > 2000 then raise exception 'invalid comment'; end if;
  select * into a from public.approvals where id = p_approval for update;
  if a.id is null or not public.can_see_task(a.task_id)
     or not exists (select 1 from public.approval_reviewers r where r.approval_id = a.id and r.user_id = me) then
    raise exception 'approval not found';
  end if;
  if a.status <> 'pending'
     or (select x.workspace_id from public.tasks x where x.id = a.task_id) is distinct from a.workspace_id then
    raise exception 'approval closed';            -- (a task that left the workspace has its request cancelled)
  end if;
  update public.approval_reviewers set decision = d, comment = c, decided_at = now()
   where approval_id = a.id and user_id = me;
  st := public.approval_resolve(a.id, a.rule);
  update public.approvals set status = st, updated_at = now(), resolved_at = case when st <> 'pending' then now() end
   where id = a.id returning * into a;
  me_name := public.kanbo_person_name(me);
  select x.id, x.title, x.workspace_id, x.user_id into t from public.tasks x where x.id = a.task_id;
  if a.requested_by is not null and a.requested_by <> me
     and public.is_task_audience(t.workspace_id, t.user_id, a.requested_by)
     and public.notif_on(a.requested_by, 'approval') then
    insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
    values (a.requested_by, t.id, coalesce(t.title, ''), 'approval', me_name,
            jsonb_build_object('approval_id', a.id, 'event', d, 'status', st, 'comment', left(c, 280)));
  end if;
  insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value)
  values (t.id, me, me_name, 'approval', st, d);
  perform public.approval_webhook(a, 'approval.decided',
            jsonb_build_object('user_id', me, 'decision', d, 'comment', c, 'decided_at', now()));
  return public.approval_json(a);
end; $$;

-- The requester (or an owner/admin of the workspace) withdraws an open request.
create or replace function public.cancel_approval(p_approval uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); a public.approvals; me_name text;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into a from public.approvals where id = p_approval for update;
  if a.id is null or not public.can_see_task(a.task_id)
     or not (a.requested_by = me or public.ws_role(a.workspace_id) in ('owner', 'admin')) then
    raise exception 'approval not found';
  end if;
  if a.status <> 'pending'
     or (select x.workspace_id from public.tasks x where x.id = a.task_id) is distinct from a.workspace_id then
    raise exception 'approval closed';
  end if;
  update public.approvals set status = 'cancelled', updated_at = now(), resolved_at = now()
   where id = a.id returning * into a;
  me_name := public.kanbo_person_name(me);
  insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value)
  values (a.task_id, me, me_name, 'approval', 'cancelled', 'cancelled');
  perform public.approval_webhook(a, 'approval.decided',
            jsonb_build_object('user_id', me, 'decision', 'cancelled', 'comment', null, 'decided_at', now()));
  return public.approval_json(a);
end; $$;

-- A task's approvals, newest first (anyone who can see the task).
create or replace function public.task_approvals(p_task uuid)
returns jsonb language plpgsql security definer stable set search_path = public as $$
begin
  if auth.uid() is null or not public.can_see_task(p_task) then raise exception 'task not found'; end if;
  return coalesce((select jsonb_agg(public.approval_json(a) order by a.created_at desc, a.id)
                     from (select * from public.approvals x where x.task_id = p_task
                            order by x.created_at desc, x.id limit 20) a), '[]'::jsonb);
end; $$;

-- Open requests waiting on you, and open requests you made (each with its task).
create or replace function public.list_my_approvals()
returns jsonb language plpgsql security definer stable set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  return jsonb_build_object(
    'to_review', coalesce((
      select jsonb_agg(public.approval_json(a) || jsonb_build_object('task', public.approval_task_json(a.task_id))
                       order by a.created_at desc, a.id)
        from (select x.* from public.approvals x
                join public.approval_reviewers r on r.approval_id = x.id and r.user_id = me and r.decision is null
               where x.status = 'pending' and public.can_see_task(x.task_id)
                 and exists (select 1 from public.tasks t where t.id = x.task_id and t.workspace_id = x.workspace_id)
               order by x.created_at desc limit 200) a), '[]'::jsonb),
    'requested', coalesce((
      select jsonb_agg(public.approval_json(a) || jsonb_build_object('task', public.approval_task_json(a.task_id))
                       order by a.created_at desc, a.id)
        from (select x.* from public.approvals x
               where x.requested_by = me and x.status = 'pending' and public.can_see_task(x.task_id)
                 and exists (select 1 from public.tasks t where t.id = x.task_id and t.workspace_id = x.workspace_id)
               order by x.created_at desc limit 200) a), '[]'::jsonb));
end; $$;

revoke execute on function public.request_approval(uuid, uuid[], text, text, text, uuid) from public, anon;
revoke execute on function public.decide_approval(uuid, text, text) from public, anon;
revoke execute on function public.cancel_approval(uuid) from public, anon;
revoke execute on function public.task_approvals(uuid) from public, anon;
revoke execute on function public.list_my_approvals() from public, anon;
grant execute on function public.request_approval(uuid, uuid[], text, text, text, uuid) to authenticated;
grant execute on function public.decide_approval(uuid, text, text) to authenticated;
grant execute on function public.cancel_approval(uuid) to authenticated;
grant execute on function public.task_approvals(uuid) to authenticated;
grant execute on function public.list_my_approvals() to authenticated;

-- A task leaving its workspace (moved to another one, or to Personal) takes
-- no open request with it: the request is cancelled. The old workspace's
-- webhooks hear approval.decided ('cancelled', by whoever moved it) with the
-- task as it was there, never its new title, project or workspace; the
-- task's history says why ('approval': moved → cancelled). Its reviewers'
-- "Approvals for you" drops it; their Inbox notices stay, as for any task
-- they can no longer see. Never blocks the move.
create or replace function public.approvals_follow_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  a       public.approvals;
  actor   uuid;
  aname   text;
  was     jsonb;
begin
  begin
    for a in update public.approvals x
                set status = 'cancelled', updated_at = now(), resolved_at = now()
              where x.task_id = new.id and x.status = 'pending' and x.workspace_id is distinct from new.workspace_id
             returning x.* loop
      if actor is null and aname is null then
        actor := public.kanbo_actor();
        aname := left(case when actor is null then 'Kanbo' else public.kanbo_person_name(actor) end, 200);
        was := jsonb_build_object('id', old.id, 'title', old.title, 'project_id', old.project_id,
                                  'workspace_id', old.workspace_id, 'status', old.status, 'due_date', old.due_date);
      end if;
      insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value)
      values (new.id, actor, aname, 'approval', 'cancelled', 'moved');
      if old.workspace_id is not null and a.workspace_id = old.workspace_id then
        perform public.approval_webhook(a, 'approval.decided',
                  jsonb_build_object('user_id', actor, 'decision', 'cancelled', 'reason', 'moved', 'comment', null, 'decided_at', now()),
                  was);
      end if;
    end loop;
  exception when others then
    raise warning 'approvals skipped (task moved): %', sqlerrm;
  end;
  return null;
end; $$;
revoke execute on function public.approvals_follow_task() from public, anon, authenticated;
drop trigger if exists trg_approvals_follow_task on public.tasks;
create trigger trg_approvals_follow_task after update of workspace_id on public.tasks
  for each row when (old.workspace_id is distinct from new.workspace_id)
  execute function public.approvals_follow_task();
-- (re-running this file) an open request whose task is in another workspace already
update public.approvals a set status = 'cancelled', updated_at = now(), resolved_at = now()
 where a.status = 'pending'
   and not exists (select 1 from public.tasks t where t.id = a.task_id and t.workspace_id = a.workspace_id);

-- ---------- 10. project docs ----------
create or replace function public.project_doc_json(d public.project_docs)
returns jsonb language sql security definer stable set search_path = public as $$
  select to_jsonb(d) || jsonb_build_object(
    'created_by_name', case when d.created_by is not null then public.kanbo_person_name(d.created_by) end,
    'updated_by_name', case when d.updated_by is not null then public.kanbo_person_name(d.updated_by) end,
    'can_edit', public.can_edit_project(d.project_id));
$$;
revoke execute on function public.project_doc_json(public.project_docs) from public, anon, authenticated;

-- Create or save a doc (people who can edit its project; never guests).
--   new doc: p_doc = a fresh uuid (the app makes it), p_project, p_base_updated_at null
--   save:    p_base_updated_at = the updated_at the editor last loaded/saved.
--            Someone else saved since → { status: 'conflict', doc: theirs }
--            (keep mine = save again with base = their updated_at).
--   p_icon null keeps the icon ('' clears it). p_mentions: every person the doc
--   @mentions now (null = unchanged); people newly mentioned (who can see the
--   project) get one Inbox notice each.
--   p_checkpoint: this save is a version of its own, never folded into your
--            last one (a restore from Version history, keep mine): the version
--            that held what the doc said just before stays in the history.
--   A new doc can't take the id of a doc whose project is in the bin.
-- Answers { status: 'saved' | 'conflict', doc }.
-- Errors: 'not authorized' · 'invalid doc' · 'invalid body' · 'doc too large' ·
--         'invalid title' · 'project not found' · 'doc not found' · 'not allowed' · 'too many docs'
drop function if exists public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[]);   -- (before p_checkpoint)
create or replace function public.save_project_doc(p_doc uuid, p_project uuid, p_title text, p_body jsonb,
                                                   p_base_updated_at timestamptz default null, p_icon text default null,
                                                   p_mentions uuid[] default null, p_checkpoint boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me      uuid := auth.uid();
  d       public.project_docs;
  p       record;
  ttl     text := btrim(coalesce(p_title, ''));
  ic      text := case when p_icon is null then null else nullif(btrim(p_icon), '') end;
  ts      timestamptz := date_trunc('milliseconds', clock_timestamp());
  oldm    uuid[];
  newm    uuid[];
  m       uuid;
  me_name text;
  lastv   record;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_doc is null then raise exception 'invalid doc'; end if;
  if p_body is null or jsonb_typeof(p_body) <> 'array' then raise exception 'invalid body'; end if;
  if octet_length(p_body::text) > 1048576 then raise exception 'doc too large'; end if;
  if length(ttl) > 200 then raise exception 'invalid title'; end if;
  if ic is not null and length(ic) > 64 then raise exception 'invalid icon'; end if;
  select * into d from public.project_docs where id = p_doc for update;
  if d.id is null then
    if p_base_updated_at is not null then raise exception 'doc not found'; end if;   -- deleted while open: don't bring it back
    if p_project is null or not public.can_edit_project(p_project) then raise exception 'project not found'; end if;
    -- a doc of a project in the bin keeps its id for the restore (the guard trigger refuses it too)
    if exists (select 1 from public.trash_ids r where r.id = p_doc) then raise exception 'invalid doc'; end if;
    perform pg_advisory_xact_lock(hashtext('kanbo:docs:' || p_project::text));
    if (select count(*) from public.project_docs x where x.project_id = p_project) >= 200 then raise exception 'too many docs'; end if;
    select x.workspace_id into p from public.projects x where x.id = p_project;
    insert into public.project_docs (id, project_id, workspace_id, title, body, icon, position, created_by, updated_by, created_at, updated_at)
    values (p_doc, p_project, p.workspace_id, ttl, p_body, ic,
            coalesce((select max(x.position) from public.project_docs x where x.project_id = p_project), 0) + 1,
            me, me, ts, ts)
    returning * into d;
    oldm := '{}';
  else
    if not public.can_edit_project(d.project_id) then
      if public.can_see_project(d.project_id) then raise exception 'not allowed'; end if;
      raise exception 'doc not found';
    end if;
    if p_project is not null and p_project <> d.project_id then raise exception 'invalid doc'; end if;
    if p_base_updated_at is null
       or date_trunc('milliseconds', d.updated_at) <> date_trunc('milliseconds', p_base_updated_at) then
      return jsonb_build_object('status', 'conflict', 'doc', public.project_doc_json(d));
    end if;
    oldm := d.mentions;
    update public.project_docs
       set title = ttl, body = p_body, icon = case when p_icon is null then icon else ic end,
           updated_by = me, updated_at = greatest(ts, date_trunc('milliseconds', d.updated_at) + interval '1 millisecond')
     where id = d.id
    returning * into d;
  end if;

  -- versions: one per 10 minutes of the same person's editing; the last 50.
  -- A checkpoint always starts a new one (the newest version always holds
  -- what the doc said before this save: every save writes it). A new one is
  -- stamped with the doc's updated_at, which always moves on, so it sorts
  -- after every earlier version even when two saves share a millisecond.
  select v.id, v.saved_by, v.saved_at into lastv from public.project_doc_versions v
   where v.doc_id = d.id order by v.saved_at desc, v.id desc limit 1;
  if not coalesce(p_checkpoint, false)
     and lastv.id is not null and lastv.saved_by = me and lastv.saved_at > now() - interval '10 minutes' then
    update public.project_doc_versions set title = d.title, body = d.body where id = lastv.id;
  else
    insert into public.project_doc_versions (doc_id, title, body, saved_by, saved_at) values (d.id, d.title, d.body, me, d.updated_at);
    delete from public.project_doc_versions
     where id in (select v.id from public.project_doc_versions v where v.doc_id = d.id
                   order by v.saved_at desc, v.id desc offset 50);
  end if;

  -- mentions: notify the people newly mentioned, once each
  if p_mentions is not null then
    select coalesce(array_agg(x), '{}') into newm
      from (select distinct x from unnest(p_mentions) x where x is not null limit 100) q;
    me_name := public.kanbo_person_name(me);
    select x.workspace_id, x.user_id into p from public.projects x where x.id = d.project_id;
    for m in select x from unnest(newm) x where not (x = any (coalesce(oldm, '{}'))) loop
      if m = me or not public.is_task_audience(p.workspace_id, p.user_id, m) or not public.notif_on(m, 'mention') then
        continue;
      end if;
      insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
      values (m, null, coalesce(nullif(d.title, ''), 'Untitled'), 'doc_mention', me_name,
              jsonb_build_object('doc_id', d.id, 'project_id', d.project_id));
    end loop;
    update public.project_docs set mentions = newm where id = d.id returning * into d;
  end if;
  return jsonb_build_object('status', 'saved', 'doc', public.project_doc_json(d));
end; $$;

-- Icon, order and archive (people who can edit the project). These don't
-- count as an edit: updated_at stays, so an open editor never conflicts.
-- p_icon null keeps ('' clears); p_position null keeps; p_archived null keeps.
create or replace function public.set_project_doc_props(p_doc uuid, p_icon text default null, p_position double precision default null,
                                                        p_archived boolean default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.project_docs; ic text := case when p_icon is null then null else nullif(btrim(p_icon), '') end;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if ic is not null and length(ic) > 64 then raise exception 'invalid icon'; end if;
  select * into d from public.project_docs where id = p_doc for update;
  if d.id is null or not public.can_see_project(d.project_id) then raise exception 'doc not found'; end if;
  if not public.can_edit_project(d.project_id) then raise exception 'not allowed'; end if;
  update public.project_docs
     set icon = case when p_icon is null then icon else ic end,
         position = coalesce(p_position, position),
         archived_at = case when p_archived is null then archived_at when p_archived then coalesce(archived_at, now()) else null end
   where id = d.id
  returning * into d;
  return public.project_doc_json(d);
end; $$;

create or replace function public.delete_project_doc(p_doc uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare d public.project_docs;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  select * into d from public.project_docs where id = p_doc for update;
  if d.id is null or not public.can_see_project(d.project_id) then raise exception 'doc not found'; end if;
  if not public.can_edit_project(d.project_id) then raise exception 'not allowed'; end if;
  delete from public.project_docs where id = d.id;
  return true;
end; $$;

revoke execute on function public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean) from public, anon;
revoke execute on function public.set_project_doc_props(uuid, text, double precision, boolean) from public, anon;
revoke execute on function public.delete_project_doc(uuid) from public, anon;
grant execute on function public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean) to authenticated;
grant execute on function public.set_project_doc_props(uuid, text, double precision, boolean) to authenticated;
grant execute on function public.delete_project_doc(uuid) to authenticated;

-- ---------- 11. restores stay quiet ----------
-- The same triggers, skipped for rows a restore puts back (kanbo.restoring is
-- only ever set by restore_from_trash, around its own inserts): no
-- re-sent assignment / mention / comment notices, the comments keep their
-- authors' names, and comments don't go to webhooks again.
do $quiet$
declare quiet constant text := '(coalesce(current_setting(''kanbo.restoring'', true), '''') <> ''on'')';
begin
  drop trigger if exists trg_notify_assignee on public.tasks;
  execute 'create trigger trg_notify_assignee after insert or update of assignee_id on public.tasks '
          'for each row when ' || quiet || ' execute function public.notify_assignee()';
  drop trigger if exists trg_notify_mentioned on public.comments;
  execute 'create trigger trg_notify_mentioned after insert on public.comments '
          'for each row when ' || quiet || ' execute function public.notify_mentioned()';
  drop trigger if exists trg_notify_comment on public.comments;
  execute 'create trigger trg_notify_comment after insert on public.comments '
          'for each row when ' || quiet || ' execute function public.notify_comment()';
  drop trigger if exists trg_comment_author on public.comments;
  execute 'create trigger trg_comment_author before insert or update on public.comments '
          'for each row when ' || quiet || ' execute function public.comment_author_from_profile()';
  drop trigger if exists trg_webhook_comment on public.comments;
  execute 'create trigger trg_webhook_comment after insert on public.comments '
          'for each row when ' || quiet || ' execute function public.webhook_capture_comment()';
end $quiet$;

-- ---------- 12. webhooks: approval events ----------
create or replace function public.webhook_event_names()
returns text[] language sql immutable as $$
  select array['task.created','task.updated','task.completed','task.deleted',
               'comment.created','project.created','project.updated','member.joined',
               'approval.requested','approval.decided']::text[];
$$;
grant execute on function public.webhook_event_names() to public;
alter table public.webhooks drop constraint if exists webhooks_shape;
alter table public.webhooks add constraint webhooks_shape check (
  public.webhook_url_ok(url)
  and cardinality(events) between 1 and 16 and events <@ public.webhook_event_names()
  and secret ~ '^whsec_[A-Za-z0-9_-]{43}$'
  and (description is null or length(description) <= 200)
  and (last_error is null or length(last_error) <= 500)
  and (disabled_reason is null or length(disabled_reason) <= 200)
  and failure_count >= 0);

-- ---------- 13. account deletion keeps the team's bin ----------
-- Runs after 0041/0042's trg_before_user_delete (same event, alphabetical),
-- so a workspace has already been handed to its heir: team bin rows the
-- person created move to that owner (their personal ones go with them).
create or replace function public.before_user_delete_0047() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  update public.trash x set user_id = ws.owner_id
    from public.workspaces ws
   where x.workspace_id = ws.id and x.user_id = old.id and ws.owner_id <> old.id;
  return old;
end; $$;
revoke execute on function public.before_user_delete_0047() from public, anon, authenticated;
drop trigger if exists trg_before_user_delete_0047 on auth.users;
create trigger trg_before_user_delete_0047 before delete on auth.users
  for each row execute function public.before_user_delete_0047();

-- ---------- 14. health and the sign-in hint ----------
-- SERVICE ROLE ONLY (the health edge function): one cheap round trip.
create or replace function public.kanbo_health()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('ok', true, 'time', now(),
                            'schema', (select max(version) from public.schema_migrations));
$$;
revoke execute on function public.kanbo_health() from public, anon, authenticated;

-- sign_in_hints(): "Continue with Google" passes Google's `hd` hint (that
-- company's accounts first in the account chooser) when exactly ONE company
-- domain is auto-approved. Signed-out visitors can't read approved_domains
-- (admins only), so this answers just that: { "google_hd": "acme.co.uk" } with
-- one approved domain, { "google_hd": null } with none or several. A hint
-- only: it never decides who gets in. Public on purpose (anon may call it):
-- it's the domain the sign-in page itself shows. Same statements as
-- supabase/sql/sign_in_hints.sql (src/auth/signInHintsSql.test.ts checks).
create or replace function public.sign_in_hints()
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object('google_hd',
    (select case when count(*) = 1 then min(d.domain) end from public.approved_domains d));
$$;
revoke execute on function public.sign_in_hints() from public;
grant execute on function public.sign_in_hints() to anon, authenticated, service_role;

-- ---------- 15. service-role grants ----------
do $svc$
begin
  grant execute on function public.trash_housekeeping() to service_role;
  grant execute on function public.kanbo_health() to service_role;
  grant execute on function public.api_housekeeping() to service_role;
  grant select, insert, update, delete on public.storage_cleanup to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- 16. realtime: approvals and docs stream to their audience ----------
do $rt$
declare t text;
begin
  foreach t in array array['approvals', 'approval_reviewers', 'project_docs'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when object_not_in_prerequisite_state then null;
      when undefined_object then null;
    end;
  end loop;
end $rt$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0047') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0047')                        as recorded,
--   (select count(*) from pg_trigger where tgname in ('trg_trash_task', 'trg_trash_project')) = 2     as bin_triggers,
--   not has_column_privilege('authenticated', 'public.trash', 'snapshot', 'select')
--   and has_column_privilege('authenticated', 'public.trash', 'summary', 'select')                   as bin_snapshot_hidden,
--   not has_table_privilege('authenticated', 'public.audit_events', 'insert')
--   and not has_table_privilege('authenticated', 'public.approvals', 'insert')
--   and not has_table_privilege('authenticated', 'public.project_docs', 'update')                   as writes_through_functions,
--   not has_table_privilege('authenticated', 'public.storage_cleanup', 'select')                     as cleanup_queue_service_only,
--   (select count(*) from pg_trigger where tgname = 'trg_trash_guard_ids') = 7
--   and not has_table_privilege('authenticated', 'public.trash_ids', 'select')                      as bin_ids_reserved,
--   (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--     and tablename in ('approvals', 'approval_reviewers', 'project_docs')) = 3                       as realtime,
--   'approval.decided' = any (public.webhook_event_names())                                          as approval_events,
--   (select count(*) from pg_trigger where tgname in ('trg_notify_assignee', 'trg_notify_mentioned',
--     'trg_notify_comment', 'trg_comment_author', 'trg_webhook_comment')
--     and pg_get_triggerdef(oid) like '%kanbo.restoring%') = 5                                        as restores_quiet,
--   exists (select 1 from pg_trigger where tgname = 'trg_before_user_delete_0047')                  as account_deletion,
--   exists (select 1 from pg_trigger where tgname = 'trg_approvals_follow_task')                    as approvals_follow_task,
--   not has_function_privilege('authenticated', 'public.kanbo_health()', 'execute')                 as health_service_only,
--   to_regprocedure('public.sign_in_hints()') is not null
--   and has_function_privilege('anon', 'public.sign_in_hints()', 'execute')                         as sign_in_hint;
-- ============================================================
