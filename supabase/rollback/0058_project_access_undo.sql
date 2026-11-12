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
-- visibility (which nobody can change from the app or the API while this is out, nor move a
-- Members only or Private project out of its workspace, nor reuse an id 0058 retired: section 3),
-- the workspaces' settings (every switch is turned off: with no rules behind
-- it, a switch that says "on" would only mislead the app), trash.access (which the bin goes on
-- recording while this is out: section 3b),
-- audit_events.project_id / access, webhooks.url_set_by, the ids of projects deleted for
-- good (project_ids_retired), where Members only and Private projects left a workspace from
-- (project_departures) and the Notion pages tasks left behind (notion_pages_retired): nothing reads
-- those three while 0058 is out (but section 3, which keeps the first two's ids from new projects; nor
-- does anything record a page left behind meanwhile). While it's out, the app keeps a
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
-- Nor does anything keep Notion out of Members only and Private projects while this is out (0058's
-- containment rule): once 0058 runs again, a workspace isn't switched on while one of them has a Notion
-- sync or Notion-linked tasks (select * from public.pa_notion_blockers('<ws id>') lists them).
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
    ('task_dependencies', 'project access: read'),
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
    ('approvals', 'trg_approvals_pa_cancel'),
    ('kudos', 'trg_kudos_pa'),
    ('trash', 'trg_trash_pa_capture'),
    ('trash', 'trg_trash_pa_restore'),
    ('trash', 'trg_trash_pa_purge'),
    ('audit_events', 'trg_audit_events_pa'),
    ('goal_links', 'trg_goal_links_pa'),
    ('goals', 'trg_goals_pa_project'),
    ('forms', 'trg_forms_pa_token'),
    ('notion_syncs', 'trg_notion_syncs_pa'),
    ('notion_links', 'trg_notion_links_pa_gone'),
    ('notion_links', 'trg_notion_links_pa_closed'),
    ('tasks', 'trg_tasks_pa_notion'),
    ('projects', 'trg_projects_pa_notion'),
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
-- And nobody changes a project's visibility from the app or the API while this is out (the SQL editor
-- and the service role still may): a Members only or Private project opened up meanwhile would stay open
-- when 0058 runs again, and whoever listed themselves on it would be on it. Nor a team project's id, as
-- with 0058 in: its work (which names it by a text id) would be left loose, and a project made under the
-- old id meanwhile would have it, and the say over who sees it, when 0058 runs again. Nor does a Members
-- only or Private project leave its workspace (for someone's Personal list, or another workspace) from the
-- app or the API: nothing moves its work with it, and with no departure recorded (0058's
-- trg_projects_pa_after is out) what it left behind would be loose work every member reads and edits when
-- 0058 runs again, and whoever moved it could bring it back as theirs. Nor, whoever asks, is a project made
-- (or renumbered) under an id deleted for good or one a Members only or Private project left a workspace
-- under (project_ids_retired, project_departures: kept while this is out), as with 0058 in: that project
-- would take over what still names the id (its history, its bin entries) when 0058 runs again. The bin
-- putting a project back is still it. 0058 takes this out again.
do $vis$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'visibility') then
    alter table public.projects alter column visibility set default 'workspace';
    execute $fn$
create or replace function public.project_visibility_kept() returns trigger
language plpgsql security definer set search_path = public as $b$
declare restoring boolean := coalesce(current_setting('kanbo.restoring', true), '') = 'on'
                             or coalesce(current_setting('kanbo.trash_bypass', true), '') = 'on';
begin
  if tg_op = 'INSERT' or new.id is distinct from old.id then
    if to_regclass('public.project_ids_retired') is not null then
      if exists (select 1 from public.project_ids_retired g where g.id = new.id) then
        raise exception 'id in use' using errcode = 'unique_violation';
      end if;
    end if;
    if not restoring and to_regclass('public.project_departures') is not null then
      if exists (select 1 from public.project_departures d where d.id = new.id) then
        raise exception 'id in use' using errcode = 'unique_violation';
      end if;
    end if;
  end if;
  if tg_op = 'INSERT' then return new; end if;
  if coalesce(auth.role(), '') in ('authenticated', 'anon') then
    if new.id is distinct from old.id and coalesce(old.workspace_id, new.workspace_id) is not null then
      raise exception 'not authorized';
    end if;
    if new.workspace_id is distinct from old.workspace_id and old.workspace_id is not null
       and coalesce(old.visibility, 'workspace') <> 'workspace' then
      raise exception 'not authorized';
    end if;
    new.visibility := old.visibility;
  end if;
  return new;
end; $b$ $fn$;
    revoke execute on function public.project_visibility_kept() from public, anon, authenticated;
    drop trigger if exists trg_projects_visibility_kept on public.projects;
    create trigger trg_projects_visibility_kept before insert or update of visibility, id, workspace_id on public.projects
      for each row execute function public.project_visibility_kept();
  end if;
end $vis$;

-- ---------- 3b. the bin still records who could see what it takes, and what it deletes for good ----------
-- (trash.access, as 0058's capture trigger does, without its functions: the project's visibility, owner and
-- people as they are when its work, or the project itself, goes to the bin.) A Members only or Private
-- project deleted while this is out leaves its updates, fields, rules and forms behind under its id, and
-- once 0058 runs again they, and the bin entry, keep the access its row records; with none recorded they'd
-- fall to the loose rule (every member reads and edits them), and a restore would bring back whoever listed
-- themselves on its contributors meanwhile. Nor is a project deleted for good meanwhile (purge_trash, or
-- the bin's daily clean-up) forgotten: its id is retired with that access (project_ids_retired, as 0058's
-- purge trigger does), so what it left behind keeps it and no new project takes the id. 0058 takes both
-- out again.
do $bin$
begin
  if to_regclass('public.trash') is not null and to_regclass('public.project_members') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trash' and column_name = 'access')
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'projects' and column_name = 'visibility') then
    execute $fn$
create or replace function public.trash_access_kept() returns trigger
language plpgsql security definer set search_path = public as $b$
declare pid uuid := public.kanbo_uuid(new.project_id);
begin
  if new.access is not null or new.workspace_id is null or pid is null then return new; end if;
  select jsonb_build_object('v', 1, 'visibility', p.visibility, 'owner', p.owner_id,
           'members', coalesce((select jsonb_agg(jsonb_build_array(m.user_id, m.role) order by m.created_at, m.id)
                                  from public.project_members m where m.project_id = p.id), '[]'::jsonb))
    into new.access
    from public.projects p where p.id = pid and p.workspace_id = new.workspace_id;
  if new.access is null and to_regclass('public.project_ids_retired') is not null then
    select g.access into new.access from public.project_ids_retired g where g.id = pid and g.workspace_id = new.workspace_id;
  end if;
  if new.access is null and to_regclass('public.project_departures') is not null then
    select d.access into new.access from public.project_departures d where d.id = pid and d.workspace_id = new.workspace_id;
  end if;
  return new;
end; $b$ $fn$;
    revoke execute on function public.trash_access_kept() from public, anon, authenticated;
    drop trigger if exists trg_trash_access_kept on public.trash;
    create trigger trg_trash_access_kept before insert on public.trash
      for each row execute function public.trash_access_kept();
  end if;
  if to_regclass('public.trash') is not null and to_regclass('public.project_ids_retired') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'trash' and column_name = 'access') then
    execute $fn$
create or replace function public.trash_purge_kept() returns trigger
language plpgsql security definer set search_path = public as $b$
begin
  if old.kind = 'project' and old.restored_at is null and old.workspace_id is not null
     and not exists (select 1 from public.projects p where p.id = old.item_id)
     and exists (select 1 from public.workspaces w where w.id = old.workspace_id) then     -- (not the workspace closing)
    insert into public.project_ids_retired (id, workspace_id, access, notion_databases, notion_pages)
    values (old.item_id, old.workspace_id,
            coalesce(old.access, (select e.access from public.audit_events e
                                   where e.workspace_id = old.workspace_id and e.target_kind = 'project' and e.target_id = old.item_id::text
                                     and e.access is not null
                                   order by e.created_at desc, e.id desc limit 1)),
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
  end if;
  return old;
end; $b$ $fn$;
    revoke execute on function public.trash_purge_kept() from public, anon, authenticated;
    drop trigger if exists trg_trash_purge_kept on public.trash;
    create trigger trg_trash_purge_kept before delete on public.trash
      for each row execute function public.trash_purge_kept();
  end if;
end $bin$;

-- ---------- 4. the functions the app calls go (the app then says project access isn't switched on yet) ----------
drop function if exists public.set_project_access(uuid, boolean, text, boolean);
drop function if exists public.set_project_visibility(uuid, text);
drop function if exists public.set_project_member(uuid, uuid, text);
drop function if exists public.remove_project_member(uuid, uuid);
drop function if exists public.set_invite_projects(uuid, jsonb);
drop function if exists public.remove_invite_project(uuid, uuid);
drop function if exists public.set_project_owner(uuid, uuid);
drop function if exists public.project_access_notion_blockers(uuid);

-- ---------- 5. every switch off (the settings, members and visibility are kept for next time) ----------
do $off$
begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'workspaces' and column_name = 'project_access') then
    update public.workspaces set project_access = false where project_access;
  end if;
end $off$;

-- ---------- 6. the helpers' bodies as their own files had them (copies, not re-runs) ----------
-- (but for 0041's comment_author_from_profile, which keeps 0058's body: it isn't about access, and
-- 0041's own gives a comment its reactor's name and refuses Admin › Delete user for anyone who has
-- commented. Running 0041 again puts 0041's back.)
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

-- (0047_bin_history_approvals_docs.sql)
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
revoke execute on function public.approval_json(public.approvals) from public, anon, authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.list_webhook_deliveries(p_id uuid, p_limit integer default 25)
returns jsonb language plpgsql security definer stable set search_path = public as $$
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
             order by x.created_at desc, x.id limit greatest(1, least(coalesce(p_limit, 25), 100))) d), '[]'::jsonb);
end; $$;
revoke execute on function public.list_webhook_deliveries(uuid, integer) from public, anon;
grant execute on function public.list_webhook_deliveries(uuid, integer) to authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.webhook_json(w public.webhooks)
returns jsonb language sql security definer stable set search_path = public as $$
  select jsonb_build_object(
    'id', w.id, 'workspace_id', w.workspace_id,
    'url', case when c.manage then w.url else public.webhook_url_masked(w.url) end,
    'description', w.description,
    'events', to_jsonb(w.events), 'active', w.active,
    'created_by', w.created_by, 'created_by_name', public.kanbo_person_name(w.created_by),
    'failure_count', w.failure_count, 'last_status', w.last_status, 'last_error', w.last_error,
    'last_delivery_at', w.last_delivery_at, 'disabled_at', w.disabled_at, 'disabled_reason', w.disabled_reason,
    'created_at', w.created_at, 'updated_at', w.updated_at,
    'can_manage', c.manage)
    from (select coalesce(public.webhook_can_manage(w), false) as manage) c;
$$;
revoke execute on function public.webhook_json(public.webhooks) from public, anon, authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.update_webhook(p_id uuid, p_url text default null, p_events text[] default null,
                                                 p_active boolean default null, p_description text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare w public.webhooks; u text := btrim(coalesce(p_url, '')); evs text[]; d text;
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select * into w from public.webhooks where id = p_id for update;
  if w.id is null or not public.webhook_can_manage(w) then raise exception 'webhook not found'; end if;
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
end; $$;
revoke execute on function public.update_webhook(uuid, text, text[], boolean, text) from public, anon;
grant execute on function public.update_webhook(uuid, text, text[], boolean, text) to authenticated;

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
  execute $fn$
create or replace function public.status_update_project_ok(p_project text, p_ws uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
begin
  if p_ws is null then return true; end if;
  if not public.is_member(p_ws) then return false; end if;
  if p_project is null or p_project !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
  return exists (select 1 from public.projects p where p.id = p_project::uuid and p.workspace_id = p_ws);
end; $$;
  $fn$;
  revoke execute on function public.status_update_project_ok(text, uuid) from public, anon;
  grant execute on function public.status_update_project_ok(text, uuid) to authenticated;
end $csu$;

-- (0053_update_rhythm.sql, only where 0053 is in)
do $ask$
begin
  if to_regclass('public.update_asks') is null then return; end if;
  execute $fn$
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
  $fn$;
  revoke execute on function public.ask_for_update(uuid) from public, anon;
  grant execute on function public.ask_for_update(uuid) to authenticated;
end $ask$;

-- (0046_api_webhooks_notion.sql)
create or replace function public.notion_status(p_ws uuid)
returns jsonb language sql security definer stable set search_path = public as $$
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
    'sync_count',        (select count(*) from public.notion_syncs s where s.workspace_id = p_ws)) end
  from (select 1) as one
  left join public.workspace_integrations i on i.workspace_id = p_ws;
$$;
revoke execute on function public.notion_status(uuid) from public, anon;
grant execute on function public.notion_status(uuid) to authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.notion_set_sync_enabled(p_id uuid, p_enabled boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  if coalesce(p_enabled, false) and not exists (select 1 from public.workspace_integrations i
                                                 where i.workspace_id = s.workspace_id and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  update public.notion_syncs set enabled = coalesce(p_enabled, false), updated_at = now() where id = p_id returning * into s;
  return public.notion_sync_json(s);
end; $$;
revoke execute on function public.notion_set_sync_enabled(uuid, boolean) from public, anon;
grant execute on function public.notion_set_sync_enabled(uuid, boolean) to authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.notion_delete_sync(p_id uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare s public.notion_syncs;
begin
  select * into s from public.notion_syncs where id = p_id for update;
  if s.id is null or auth.uid() is null or public.ws_role(s.workspace_id) not in ('owner', 'admin') then
    raise exception 'sync not found';
  end if;
  update public.notion_links set kind = 'reference', sync_id = null where sync_id = p_id;
  delete from public.notion_syncs where id = p_id;
  return true;
end; $$;
revoke execute on function public.notion_delete_sync(uuid) from public, anon;
grant execute on function public.notion_delete_sync(uuid) to authenticated;

-- (0046_api_webhooks_notion.sql)
create or replace function public.notion_link_page(p_task uuid, p_page_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pid text := public.notion_norm_id(p_page_id); ws uuid; l public.notion_links;
begin
  if auth.uid() is null or not public.can_edit_task(p_task) then raise exception 'task not found'; end if;
  select t.workspace_id into ws from public.tasks t where t.id = p_task;
  if ws is null then raise exception 'notion links need a team task'; end if;
  if not exists (select 1 from public.workspace_integrations i where i.workspace_id = ws and i.notion_token is not null) then
    raise exception 'notion not connected';
  end if;
  if pid is null then raise exception 'invalid page'; end if;
  select * into l from public.notion_links where task_id = p_task and notion_page_id = pid;
  if l.id is null then
    if (select count(*) from public.notion_links x where x.task_id = p_task) >= 20 then raise exception 'too many links'; end if;
    insert into public.notion_links (workspace_id, task_id, notion_page_id, kind, created_by)
    values (ws, p_task, pid, 'reference', auth.uid())
    returning * into l;
  end if;
  return public.notion_link_json(l);
end; $$;
revoke execute on function public.notion_link_page(uuid, text) from public, anon;
grant execute on function public.notion_link_page(uuid, text) to authenticated;

-- (0055_shared_availability.sql, only where 0055 is in)
do $rate$
begin
  if to_regclass('public.bill_rates') is null then return; end if;
  execute $fn$
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
  $fn$;
  revoke execute on function public.set_bill_rate(uuid, uuid, numeric) from public, anon;
  grant execute on function public.set_bill_rate(uuid, uuid, numeric) to authenticated;
end $rate$;

-- (0056_meetings.sql, only where 0056 is in)
do $meet$
begin
  if to_regclass('public.meetings') is null then return; end if;
  execute $fn$
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
  $fn$;
  revoke execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) from public, anon;
  grant execute on function public.start_meeting(uuid, text, text, uuid[], jsonb, uuid[], uuid, uuid) to authenticated;
  execute $fn$
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
  $fn$;
  revoke execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) from public, anon;
  grant execute on function public.add_meeting_item(uuid, text, text, text, uuid, date, uuid) to authenticated;
end $meet$;

-- (0056_meetings.sql where 0056 is in, else 0048_ux_wave.sql: the same function, each with a comment of
-- its own; only where 0048 is in)
do $live$
begin
  if to_regprocedure('public.kanbo_realtime_allowed(text,text,boolean)') is null then return; end if;
  if to_regclass('public.meetings') is not null then
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
  else
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
    -- (0056's meeting room: who's there; nothing is broadcast on it. No meetings yet: no)
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
  end if;
  revoke all on function public.kanbo_realtime_allowed(text, text, boolean) from public, anon;
  grant execute on function public.kanbo_realtime_allowed(text, text, boolean) to authenticated;
end $live$;

-- ---------- 7. it's no longer recorded ----------
delete from public.schema_migrations where version = '0058';

-- ---------- 8. only if you're sure: this loses who's on which project ----------
-- Uncomment and run on its own, after everything above, to take 0058's data out too.
--
-- drop trigger if exists trg_projects_visibility_kept on public.projects;
-- drop function if exists public.project_visibility_kept();
-- drop trigger if exists trg_trash_access_kept on public.trash;
-- drop function if exists public.trash_access_kept();
-- drop trigger if exists trg_trash_purge_kept on public.trash;
-- drop function if exists public.trash_purge_kept();
-- drop table if exists public.project_member_invites;
-- drop table if exists public.project_members;
-- drop table if exists public.project_ids_retired;
-- drop table if exists public.project_departures;
-- drop table if exists public.notion_pages_retired;
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
--   not exists (select 1 from public.workspaces where project_access)                                    as every_switch_off,
--   exists (select 1 from pg_trigger where tgname = 'trg_projects_visibility_kept')                        as visibility_kept,
--   exists (select 1 from pg_trigger where tgname = 'trg_trash_access_kept')
--     and exists (select 1 from pg_trigger where tgname = 'trg_trash_purge_kept')                            as bin_access_kept;
-- ============================================================
