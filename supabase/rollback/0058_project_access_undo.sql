-- ============================================================
-- KANBO — undo database update 0058 (project access). ONLY if 0058 itself is broken.
--
-- The normal rollback is the switch: an owner turns Project access off in Settings ›
-- Workspace (or, in an emergency, the SQL editor runs
--   update public.workspaces set project_access = false where id = '<ws id>';
-- or, for every workspace, … where project_access;). That's instant and loses nothing.
--
-- This file removes 0058's rules and puts the helpers' old bodies back, KEEPING THE DATA:
-- who's on which project (project_members, project_member_invites), each project's
-- visibility, the workspaces' settings (every switch is turned off: with no rules behind
-- it, a switch that says "on" would only mislead the app), trash.access,
-- audit_events.project_id / access, webhooks.url_set_by and the ids of projects deleted for
-- good (project_ids_retired: nothing reads it while 0058 is out). While it's out, the app keeps a
-- project's people in contributor_ids again (as before 0058) and nothing keeps project_members
-- in step. Running 0058 again afterwards puts every rule back and brings project_members back
-- to contributor_ids (people taken off meanwhile, or who left the workspace, lose their rows;
-- people added meanwhile get one on a Whole workspace project, and are added again in People &
-- access on a Members only or Private one), so nobody who was taken off a project comes back, and
-- nobody gets into a closed one by listing themselves while the rules were out. Anyone who left a
-- workspace meanwhile is forgotten as 0058 forgets them (pa_forget_departed: the projects they own
-- there go to its owner), unless they're back in it by then. Owners aren't put back: while this is
-- out, any writer may set a project's owner (and someone removed and invited back keeps what they
-- owned), so check the owner of each Members only and Private project after 0058 runs again (About).
-- Then switch each workspace on again.
--
-- Safe to run more than once. Nothing here needs 0058's own functions to be working.
-- ============================================================

-- ---------- 1. the restore hook goes first, so a re-run of an older file skips it ----------
drop function if exists public.project_access_restore();
drop function if exists public.project_access_intact();

-- ---------- 2. every policy and trigger 0058 made ----------
do $undo$
declare r record;
begin
  for r in select * from (values
    ('tasks', 'project access: read'),
    ('tasks', 'project access: create'),
    ('tasks', 'project access: edit'),
    ('tasks', 'project access: delete'),
    ('sections', 'project access: read'),
    ('sections', 'project access: create'),
    ('sections', 'project access: edit'),
    ('sections', 'project access: delete'),
    ('custom_field_defs', 'project access: read'),
    ('custom_field_defs', 'project access: create'),
    ('custom_field_defs', 'project access: edit'),
    ('custom_field_defs', 'project access: delete'),
    ('automation_rules', 'project access: read'),
    ('automation_rules', 'project access: create'),
    ('automation_rules', 'project access: edit'),
    ('automation_rules', 'project access: delete'),
    ('forms', 'project access: read'),
    ('forms', 'project access: create'),
    ('forms', 'project access: edit'),
    ('forms', 'project access: delete'),
    ('status_updates', 'project access: read'),
    ('status_updates', 'project access: create'),
    ('status_updates', 'project access: edit'),
    ('status_updates', 'project access: delete'),
    ('projects', 'project access: read'),
    ('projects', 'project access: create'),
    ('projects', 'project access: edit'),
    ('projects', 'project access: delete'),
    ('comments', 'project access: comment'),
    ('comments', 'project access: edit own'),
    ('comments', 'project access: delete own'),
    ('attachments', 'project access: attach'),
    ('attachments', 'project access: remove files'),
    ('status_update_comments', 'project access: replies'),
    ('status_update_comments', 'project access: edit own'),
    ('status_update_reactions', 'project access: replies'),
    ('trash', 'project access: read'),
    ('audit_events', 'project access: read'),
    ('goal_links', 'project access: read'),
    ('saved_views', 'project access: read'),
    ('notion_syncs', 'project access: read'),
    ('notion_links', 'project access: read'),
    ('notion_page_cache', 'project access: read'),
    ('bill_rates', 'project access: read'),
    ('workspace_members', 'project access: people'),
    ('profiles', 'project access: people')) as x(tbl, name) loop
    if to_regclass('public.' || r.tbl) is not null then
      execute format('drop policy if exists %I on public.%I', r.name, r.tbl);
    end if;
  end loop;
  -- (0058's own tables keep their policies: they still hold its data, read the way 0058 had it)
  for r in select * from (values
    ('workspaces', 'trg_workspaces_pa_guard'),
    ('workspaces', 'trg_workspaces_pa_after'),
    ('projects', 'trg_projects_pa_guard'),
    ('projects', 'trg_projects_pa_after'),
    ('project_members', 'trg_project_members_guard'),
    ('project_members', 'trg_project_members_after'),
    ('workspace_members', 'trg_ws_members_pa'),
    ('tasks', 'trg_tasks_pa'),
    ('tasks', 'trg_tasks_pa_after'),
    ('tasks', 'trg_tasks_pa_delete'),
    ('projects', 'trg_projects_pa_delete'),
    ('status_updates', 'trg_status_update_pa'),
    ('status_update_comments', 'trg_status_update_comment_pa'),
    ('activity', 'trg_activity_pa_gate'),
    ('notify_queue', 'trg_notify_queue_pa_gate'),
    ('webhook_deliveries', 'trg_webhook_deliveries_pa_gate'),
    ('webhooks', 'trg_webhooks_pa_url'),
    ('approval_reviewers', 'trg_approval_reviewers_pa'),
    ('kudos', 'trg_kudos_pa'),
    ('trash', 'trg_trash_pa_capture'),
    ('trash', 'trg_trash_pa_restore'),
    ('trash', 'trg_trash_pa_purge'),
    ('audit_events', 'trg_audit_events_pa'),
    ('goal_links', 'trg_goal_links_pa'),
    ('goals', 'trg_goals_pa_project'),
    ('forms', 'trg_forms_pa_token'),
    ('notion_syncs', 'trg_notion_syncs_pa'),
    ('update_asks', 'trg_update_asks_pa'),
    ('bill_rates', 'trg_bill_rates_pa'),
    ('meetings', 'trg_meetings_pa'),
    ('meeting_items', 'trg_meeting_items_pa')) as x(tbl, name) loop
    if to_regclass('public.' || r.tbl) is not null then
      execute format('drop trigger if exists %I on public.%I', r.name, r.tbl);
    end if;
  end loop;
end $undo$;

-- ---------- 3. a project made without saying who can see it is Whole workspace ----------
do $vis$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'visibility') then
    alter table public.projects alter column visibility set default 'workspace';
  end if;
end $vis$;

-- ---------- 4. the functions the app calls go (the app then says project access isn't switched on yet) ----------
drop function if exists public.set_project_access(uuid, boolean, text, boolean);
drop function if exists public.set_project_visibility(uuid, text);
drop function if exists public.set_project_member(uuid, uuid, text);
drop function if exists public.remove_project_member(uuid, uuid);
drop function if exists public.set_invite_projects(uuid, jsonb);
drop function if exists public.remove_invite_project(uuid, uuid);

-- ---------- 5. every switch off (the settings, members and visibility are kept for next time) ----------
do $off$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'project_access') then
    update public.workspaces set project_access = false where project_access;
  end if;
end $off$;

-- ---------- 6. the helpers' bodies as their own files had them (copies, not re-runs) ----------
-- (0025_security_hardening.sql)
create or replace function public.toggle_comment_reaction(p_comment uuid, p_emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_react jsonb;
  v_list  jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  -- caller must be allowed to see the comment (own task or shared workspace)
  if not exists (
    select 1 from public.comments c
    join public.tasks t on t.id = c.task_id
    where c.id = p_comment
      and (t.user_id = v_uid
           or (t.workspace_id is not null and public.is_member(t.workspace_id)))
  ) then
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
$$;
grant execute on function public.toggle_comment_reaction(uuid, text) to authenticated;

-- (0042_rollout_hardening.sql)
create or replace function public.can_edit_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and public.can_write(t.workspace_id))));
$$;
grant execute on function public.can_edit_task(uuid) to authenticated;

-- (0042_rollout_hardening.sql)
create or replace function public.toggle_task_follow(p_task uuid, p_follow boolean default null)
returns text[] language plpgsql security definer set search_path = public as $$
declare
  me     text := lower(auth.uid()::text);
  t      record;
  now_on boolean;
  result text[];
begin
  if me is null then raise exception 'not authorized'; end if;
  select id, user_id, workspace_id, coalesce(followers, '{}') as followers
    into t from public.tasks where id = p_task for update;
  if t.id is null
     or not ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
             or (t.workspace_id is not null and public.is_member(t.workspace_id))) then
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
end; $$;
revoke execute on function public.toggle_task_follow(uuid, boolean) from public, anon;
grant execute on function public.toggle_task_follow(uuid, boolean) to authenticated;

-- (0043_integrations_push_forms_plans.sql)
create or replace function public.can_see_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and public.is_member(t.workspace_id))));
$$;
revoke execute on function public.can_see_task(uuid) from public, anon;
grant execute on function public.can_see_task(uuid) to authenticated;

-- (0043_integrations_push_forms_plans.sql)
create or replace function public.tasks_visible_to(p_user uuid)
returns setof public.tasks language sql security definer stable set search_path = public as $$
  select t.* from public.tasks t
   where p_user is not null
     and not exists (select 1 from public.profiles p
                      where p.id = p_user and (coalesce(p.suspended, false) or not coalesce(p.approved, true)))
     and ((t.workspace_id is null and t.user_id = p_user)
       or (t.workspace_id is not null and (
             exists (select 1 from public.workspace_members m
                      where m.workspace_id = t.workspace_id and m.user_id = p_user and m.status = 'active')
          or exists (select 1 from public.workspaces w where w.id = t.workspace_id and w.owner_id = p_user))));
$$;
revoke execute on function public.tasks_visible_to(uuid) from public, anon, authenticated;
do $svc$ begin
  grant execute on function public.tasks_visible_to(uuid) to service_role;
exception when undefined_object then null; end $svc$;

-- (0047_bin_history_approvals_docs.sql)
create or replace function public.can_see_project(p_project uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.projects p
     where p.id = p_project
       and ((p.workspace_id is null and p.user_id = auth.uid() and public.can_act())
         or (p.workspace_id is not null and public.is_member(p.workspace_id))));
$$;

-- (0047_bin_history_approvals_docs.sql)
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

-- (0047_bin_history_approvals_docs.sql)
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
revoke execute on function public.restore_from_trash(uuid) from public, anon;
grant execute on function public.restore_from_trash(uuid) to authenticated;

-- (0054_update_conversation.sql, only where 0054 is in)
do $csu$
begin
  if to_regclass('public.status_update_comments') is null then return; end if;
  execute $fn$
create or replace function public.can_see_status_update(p_update uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.status_updates s
     where s.id = p_update
       and public.api_scope_ok(s.workspace_id)
       and ((s.workspace_id is null and s.user_id = auth.uid() and public.can_act())
         or (s.workspace_id is not null and public.is_member(s.workspace_id))));
$$;
  $fn$;
  revoke execute on function public.can_see_status_update(uuid) from public, anon;
  grant execute on function public.can_see_status_update(uuid) to authenticated;
end $csu$;

-- ---------- 7. it's no longer recorded ----------
delete from public.schema_migrations where version = '0058';

-- ---------- 8. only if you're sure: this loses who's on which project ----------
-- Uncomment and run on its own, after everything above, to take 0058's data out too.
--
-- drop table if exists public.project_member_invites;
-- drop table if exists public.project_members;
-- drop table if exists public.project_ids_retired;
-- alter table public.projects drop column if exists visibility;
-- alter table public.workspaces drop column if exists project_access, drop column if exists project_access_default,
--   drop column if exists project_access_member_private, drop column if exists project_access_changed_at;
-- alter table public.trash drop column if exists access;
-- alter table public.audit_events drop column if exists project_id, drop column if exists access;
-- alter table public.webhooks drop column if exists url_set_by;

-- ============================================================
-- VERIFY (every column should be true):
--
-- select
--   not exists (select 1 from public.schema_migrations where version = '0058')                       as unrecorded,
--   to_regprocedure('public.project_access_restore()') is null                                          as hook_gone,
--   not exists (select 1 from pg_policies where schemaname = 'public' and policyname like 'project access:%') as rules_gone,
--   not exists (select 1 from pg_trigger where tgname in ('trg_projects_pa_guard', 'trg_tasks_pa', 'trg_activity_pa_gate'))  as triggers_gone,
--   position('pa_' in (select prosrc from pg_proc where oid = 'public.can_see_task(uuid)'::regprocedure)) = 0     as old_helpers,
--   not exists (select 1 from public.workspaces where project_access)                                    as every_switch_off;
-- ============================================================
