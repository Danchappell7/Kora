-- ============================================================
-- KANBO — the UX wave (2026-10-09): first run, universal search, calmer
-- notifications, shared views, board covers and WIP limits, a template
-- library, kudos and live presence. Additive: nothing the app does today
-- changes shape.
--
--   1. profiles.onboarding (jsonb): the guided tour, the "Get set up"
--      checklist, the sample project and gentle-nudge settings (streak),
--      one top-level key per feature. Your own row only (the existing
--      profile policies; the privilege trigger only guards is_admin /
--      suspended / approved / email). merge_onboarding(patch) and
--      merge_notify_prefs(patch) merge one level deep atomically (null
--      removes a key), so two devices or two features never clobber each
--      other. notify_prefs gains a light shape check (new writes only) and
--      notif_on() no longer throws on a value that isn't a boolean.
--      notify_prefs keys (all optional; anything unset = the default):
--        "<kind>"         in-app on/off (assigned, mention, comment, approval, kudos)
--        "<kind>_email"   email on/off           (default on)
--        "<kind>_push"    push on/off            (default on; 0043)
--        "due_email", "due_push"                 (daily reminders)
--        "delivery"       'realtime' | 'digest'  (default realtime)
--        "digest_time"    'HH:MM', 24 h, the person's local time (default '08:00')
--        "quiet_hours"    { "start": 'HH:MM', "end": 'HH:MM', "days": [1..7] (ISO, Mon = 1) } | null
--        "timezone"       IANA name, e.g. 'Europe/London' (the default)
--        "bundle"         false = never bundle push/email (default on)
--   2. Universal search. Full-text (the 'simple' and 'english'
--      configurations together) over tasks (title, description), comments
--      (body), projects (name, description) and project docs (title + the
--      text of their blocks: project_docs.plain_text, kept up to date by a
--      trigger). Expression GIN indexes (kanbo_fts), so no row grows and
--      nothing extra travels to the app, realtime, the bin or webhooks.
--      search_all(q, filters, lim) is SECURITY INVOKER: it runs as the
--      caller, under every row-level policy, so it can never return a row
--      the caller couldn't select themselves. Ranked typed hits (task,
--      comment, doc, project, person) with a highlighted snippet.
--   3. saved_views: a filtered list saved as a view (name, emoji, kind,
--      query, pinned, position), personal or shared with a workspace.
--      Everyone reads their own and the shared ones of workspaces they're
--      in (guests too); writers share; you edit your own; owners and admins
--      also edit, unpin or delete the shared ones. adopt_saved_searches()
--      moves the caller's old saved searches across (same ids).
--   4. task_templates: the template library, with the same rules as views.
--   5. tasks.cover_attachment_id (an image file on the same task; cleared
--      when the file is deleted) and projects.board_settings (WIP limits,
--      "show project covers": writers of the project).
--      merge_board_settings(project, patch) merges one change atomically
--      (one level deep, two for "wip"; null removes), as merge_onboarding.
--   6. notification_snoozes: snooze a thread (a task) until a time. Your own
--      rows, for tasks you can see (guests too: it's your Inbox, not the
--      task). Snoozed threads send no push or email; the Inbox brings them
--      back when the snooze ends.
--   7. notify_queue (service only): push/email held back for bundling
--      (2-minute window per task per recipient), quiet hours and digests.
--      notify_queue_claim() / notify_queue_finish() for the notify drain.
--   8. kudos: one-tap thanks on a teammate's finished team task. One per
--      giver per task; anyone who can see the task (guests too: it's a
--      reaction, not content) gives one through give_kudos(); the
--      recipient gets an Inbox item (kind 'kudos', pref 'kudos') and the
--      workspace's webhooks a 'kudos.given' event. take_back_kudos() undoes
--      it. Read by the task's audience. Kudos don't come back with a task
--      restored from the bin.
--   9. Account deletion: shared views and templates in team workspaces move
--      to the workspace's owner (personal ones go with the person).
--  10. Realtime: saved_views, kudos and notification_snoozes.
--  15. Live presence (u5): Realtime Authorization for the private
--      "kanbo:task|doc|project:<id>" channels — who's viewing, typing, doc
--      co-editing. kanbo_realtime_allowed() and two policies on
--      realtime.messages (skipped where Realtime has no Authorization).
--      Without them every join is refused and presence stays off.
--  16. Doc versions: one per 10 minutes of a doc's editing whoever saves
--      (save_project_doc), so people writing together live don't push the
--      older history out of the last 50.
--
-- Needs 0047. Idempotent: safe to run more than once (re-running keeps
-- every view, template, snooze, queued notice and kudos). RUN IT LAST:
-- 0046 and 0047 recreate webhook_event_names() and the webhooks check
-- without 'kudos.given' — if either is ever run again, run this file again
-- straight afterwards (they stop with an error while a webhook subscribes
-- to kudos.given; see docs/integrations/database-0048.md).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0047') then
    raise exception '0048 needs 0047 first: run 0047_bin_history_approvals_docs.sql, then this file';
  end if;
end $pre$;

-- ---------- 1. helpers ----------
-- The searchable text of a title and a body: words as typed ('simple': exact
-- and prefix matches, names, codes) and English stems ('english': "pricing"
-- finds "prices"). Titles weigh more. Immutable: the GIN indexes below are on
-- this exact expression, and search_all() matches it word for word.
create or replace function public.kanbo_fts(p_title text, p_body text)
returns tsvector language sql immutable parallel safe set search_path = pg_catalog as $$
  select setweight(to_tsvector('simple'::regconfig, left(coalesce(p_title, ''), 1000)), 'A')
      || setweight(to_tsvector('english'::regconfig, left(coalesce(p_title, ''), 1000)), 'A')
      || setweight(to_tsvector('simple'::regconfig, left(coalesce(p_body, ''), 60000)), 'C')
      || setweight(to_tsvector('english'::regconfig, left(coalesce(p_body, ''), 60000)), 'C');
$$;

-- A doc body (lib/docs DocBlock[]) as plain text: each block's spans joined,
-- one line per block (dividers and empty blocks skipped), at most 200k chars.
create or replace function public.kanbo_doc_plain_text(p_body jsonb)
returns text language plpgsql immutable parallel safe set search_path = pg_catalog as $$
declare out_text text;
begin
  if p_body is null or jsonb_typeof(p_body) <> 'array' then return ''; end if;
  select coalesce(string_agg(x.line, E'\n' order by x.bo), '') into out_text
    from (select b.bo,
                 (select string_agg(coalesce(s.v ->> 'text', ''), '' order by s.so)
                    from jsonb_array_elements(case when jsonb_typeof(b.v -> 'spans') = 'array' then b.v -> 'spans' else '[]'::jsonb end)
                         with ordinality s(v, so)
                   where jsonb_typeof(s.v) = 'object') as line
            from jsonb_array_elements(p_body) with ordinality b(v, bo)
           where jsonb_typeof(b.v) = 'object') x
   where x.line is not null and btrim(x.line) <> '';
  return left(out_text, 200000);
end; $$;

-- A notification pref: ON unless explicitly off. Since 0048 notify_prefs also
-- holds strings and objects (delivery, digest_time, quiet_hours, timezone), so
-- a value that isn't a boolean (or 'true'/'false') counts as unset instead of
-- throwing — a malformed pref must never block the comment or assignment
-- whose trigger asks.
create or replace function public.notif_on(p_user uuid, p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case jsonb_typeof(p.notify_prefs -> p_key)
             when 'boolean' then (p.notify_prefs -> p_key)::text::boolean
             when 'string' then case lower(p.notify_prefs ->> p_key) when 'false' then false when 'true' then true end
           end
      from public.profiles p where p.id = p_user), true);
$$;
grant execute on function public.notif_on(uuid, text) to authenticated;

-- ---------- 2. profiles: onboarding + notification prefs ----------
alter table public.profiles add column if not exists onboarding jsonb not null default '{}'::jsonb;
alter table public.profiles drop constraint if exists profiles_onboarding_shape;
alter table public.profiles add constraint profiles_onboarding_shape check (
  jsonb_typeof(onboarding) = 'object' and pg_column_size(onboarding) <= 16384);
-- new writes only (NOT VALID): rows written before 0048 stay as they are
alter table public.profiles drop constraint if exists profiles_notify_prefs_shape;
alter table public.profiles add constraint profiles_notify_prefs_shape check (
  jsonb_typeof(notify_prefs) = 'object' and pg_column_size(notify_prefs) <= 8192
  and (not (notify_prefs ? 'delivery') or notify_prefs ->> 'delivery' in ('realtime', 'digest'))
  and (not (notify_prefs ? 'digest_time') or coalesce(notify_prefs ->> 'digest_time', '') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')
  and (not (notify_prefs ? 'timezone') or (jsonb_typeof(notify_prefs -> 'timezone') = 'string'
                                           and char_length(notify_prefs ->> 'timezone') between 1 and 64))
  and (not (notify_prefs ? 'quiet_hours') or jsonb_typeof(notify_prefs -> 'quiet_hours') in ('object', 'null'))) not valid;

-- Merge a patch into your own onboarding / notify_prefs, one level deep, in
-- one statement (null removes a key). Runs as you: the profile policies and
-- the privilege trigger apply. Errors: 'not authorized' · 'invalid patch' ·
-- 'profile not found' · a check violation when the result is too large.
create or replace function public.merge_onboarding(p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare out_v jsonb;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid patch'; end if;
  update public.profiles
     set onboarding = (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                         from jsonb_each(coalesce(onboarding, '{}'::jsonb) || p_patch) e
                        where jsonb_typeof(e.value) <> 'null')
   where id = auth.uid()
  returning onboarding into out_v;
  if out_v is null then raise exception 'profile not found'; end if;
  return out_v;
end; $$;

create or replace function public.merge_notify_prefs(p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare out_v jsonb;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid patch'; end if;
  update public.profiles
     set notify_prefs = (select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
                           from jsonb_each(coalesce(notify_prefs, '{}'::jsonb) || p_patch) e
                          where jsonb_typeof(e.value) <> 'null')
   where id = auth.uid()
  returning notify_prefs into out_v;
  if out_v is null then raise exception 'profile not found'; end if;
  return out_v;
end; $$;
revoke execute on function public.merge_onboarding(jsonb) from public, anon;
revoke execute on function public.merge_notify_prefs(jsonb) from public, anon;
grant execute on function public.merge_onboarding(jsonb) to authenticated;
grant execute on function public.merge_notify_prefs(jsonb) to authenticated;

-- ---------- 3. search ----------
-- 3a. a doc's plain text (search + snippets), maintained by a trigger
alter table public.project_docs add column if not exists plain_text text not null default '';

create or replace function public.project_docs_plain_text() returns trigger
language plpgsql set search_path = public as $$
begin
  new.plain_text := public.kanbo_doc_plain_text(new.body);
  return new;
end; $$;
revoke execute on function public.project_docs_plain_text() from public, anon, authenticated;
drop trigger if exists trg_project_docs_plain_text on public.project_docs;
create trigger trg_project_docs_plain_text before insert or update of body, plain_text on public.project_docs
  for each row execute function public.project_docs_plain_text();
-- (first run, and any doc written while the trigger was missing)
update public.project_docs d set plain_text = public.kanbo_doc_plain_text(d.body)
 where d.plain_text is distinct from public.kanbo_doc_plain_text(d.body);

-- 3b. the indexes search_all() uses (the exact same expressions)
create index if not exists tasks_fts_idx on public.tasks using gin (public.kanbo_fts(title, description));
create index if not exists comments_fts_idx on public.comments using gin (public.kanbo_fts(''::text, body));
create index if not exists projects_fts_idx on public.projects using gin (public.kanbo_fts(name, description));
create index if not exists project_docs_fts_idx on public.project_docs using gin (public.kanbo_fts(title, plain_text));

-- 3c. search_all(q, filters, lim)
-- SECURITY INVOKER: every row comes through the caller's own row-level
-- policies (and is also narrowed to their workspaces up front, so a broad
-- word stays cheap). Words match as typed or as prefixes (2+ letters:
-- "laun" finds "launch") and as English stems; every word must match.
-- filters (all optional):
--   kinds            ['task','comment','doc','project','person'] (default all)
--   workspace_id     a workspace id · 'personal' or null = Personal only ·
--                    absent = everywhere you are
--   project_id       tasks, comments (their task's), docs and that project
--   assignee_id      tasks assigned to (or shared with) this person (text id)
--   statuses         ['todo','progress','review','blocked','done'] (tasks)
--   exclude_done     true: open tasks only
--   due_from, due_to 'YYYY-MM-DD', inclusive (tasks; the app works out
--                    "overdue", "this week", "friday" in the person's zone)
--   author_id        comments by this person
--   include_archived true: archived tasks, projects and docs (and those in
--                    archived projects) too
-- With no searchable words, task filters alone still list tasks (rank 0,
-- soonest due first); otherwise nothing comes back.
-- lim: per kind (1–50, default 20). Rows come grouped by kind: tasks,
-- comments, docs, projects, people; best first within each.
-- snippet: the matching part of the body (description, comment, doc text,
-- project description) with matches wrapped in U+E000 … U+E001 — split on
-- those, never render it as HTML. People: snippet = their email.
-- Errors: 'not authorized' · 'invalid filters'.
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
  kinds     text[] := array['task', 'comment', 'doc', 'project', 'person'];
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
       where k in ('task', 'comment', 'doc', 'project', 'person');
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
revoke execute on function public.search_all(text, jsonb, integer) from public, anon;
grant execute on function public.search_all(text, jsonb, integer) to authenticated;

-- ---------- 4. saved views + 5. task templates ----------
create table if not exists public.saved_views (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,   -- null = personal
  user_id      uuid not null references auth.users (id) on delete cascade,  -- who made it
  name         text not null,
  emoji        text,
  kind         text not null default 'my_tasks',                            -- where it opens
  query        jsonb not null default '{}'::jsonb,                          -- lib/views SavedViewQuery
  pinned       boolean not null default false,                              -- in the sidebar's Views group
  position     double precision,
  shared       boolean not null default false,                              -- with the workspace
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists saved_views_user_idx on public.saved_views (user_id, position);
create index if not exists saved_views_shared_idx on public.saved_views (workspace_id, position) where shared;
alter table public.saved_views drop constraint if exists saved_views_shape;
alter table public.saved_views add constraint saved_views_shape check (
  char_length(btrim(name)) between 1 and 80
  and (emoji is null or char_length(emoji) <= 16)
  and kind in ('my_tasks', 'project', 'search')
  and jsonb_typeof(query) = 'object' and pg_column_size(query) <= 8192
  and (not shared or workspace_id is not null));

create table if not exists public.task_templates (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces (id) on delete cascade,   -- null = personal
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  emoji        text,
  body         jsonb not null default '{}'::jsonb,   -- { title, description, priority, estimate, tags, subtasks[], checklist[] }
  shared       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists task_templates_user_idx on public.task_templates (user_id, created_at desc);
create index if not exists task_templates_shared_idx on public.task_templates (workspace_id, created_at desc) where shared;
alter table public.task_templates drop constraint if exists task_templates_shape;
alter table public.task_templates add constraint task_templates_shape check (
  char_length(btrim(name)) between 1 and 80
  and (emoji is null or char_length(emoji) <= 16)
  and jsonb_typeof(body) = 'object' and pg_column_size(body) <= 32768
  and (not (body ? 'title') or (jsonb_typeof(body -> 'title') = 'string' and char_length(body ->> 'title') <= 500))
  and (not (body ? 'subtasks') or (jsonb_typeof(body -> 'subtasks') = 'array' and jsonb_array_length(body -> 'subtasks') <= 50))
  and (not (body ? 'checklist') or (jsonb_typeof(body -> 'checklist') = 'array' and jsonb_array_length(body -> 'checklist') <= 50))
  and (not shared or workspace_id is not null));

-- Who made a view/template, and where it lives, never change (the account
-- deletion hand-over below may: kanbo.reassign, or a server-side role).
-- updated_at moves on every edit; a per-person cap on how many there are.
create or replace function public.saved_rows_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare cap integer := case tg_table_name when 'saved_views' then 300 else 300 end; cnt integer;
begin
  if tg_op = 'INSERT' then
    new.updated_at := now();
    new.name := btrim(new.name);
    execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into cnt using new.user_id;
    if cnt >= cap then raise exception 'too many %', replace(tg_table_name, '_', ' '); end if;
    return new;
  end if;
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and coalesce(current_setting('kanbo.reassign', true), '') <> 'on' then
    new.id := old.id; new.user_id := old.user_id; new.workspace_id := old.workspace_id; new.created_at := old.created_at;
  end if;
  new.name := btrim(new.name);
  new.updated_at := now();
  return new;
end; $$;
revoke execute on function public.saved_rows_guard() from public, anon, authenticated;
drop trigger if exists trg_saved_views_guard on public.saved_views;
create trigger trg_saved_views_guard before insert or update on public.saved_views
  for each row execute function public.saved_rows_guard();
drop trigger if exists trg_task_templates_guard on public.task_templates;
create trigger trg_task_templates_guard before insert or update on public.task_templates
  for each row execute function public.saved_rows_guard();

-- ---------- 6. covers + board settings ----------
-- the task's cover: one of its own image files. DEFERRABLE so a restore from
-- the bin can put the task back before its files (same transaction).
alter table public.tasks add column if not exists cover_attachment_id uuid;
do $fk$
begin
  if not exists (select 1 from pg_constraint where conname = 'tasks_cover_attachment_id_fkey') then
    alter table public.tasks add constraint tasks_cover_attachment_id_fkey
      foreign key (cover_attachment_id) references public.attachments (id) on delete set null
      deferrable initially deferred;
  end if;
end $fk$;
create index if not exists tasks_cover_idx on public.tasks (cover_attachment_id) where cover_attachment_id is not null;

create or replace function public.task_cover_check() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.cover_attachment_id is null then return new; end if;
  if tg_op = 'UPDATE' and new.cover_attachment_id is not distinct from old.cover_attachment_id then return new; end if;
  if coalesce(current_setting('kanbo.restoring', true), '') = 'on' then return new; end if;   -- the bin puts back what was there
  if not exists (select 1 from public.attachments a
                  where a.id = new.cover_attachment_id and a.task_id = new.id and a.mime like 'image/%') then
    raise exception 'invalid cover' using hint = 'A cover must be an image file on the same task.';
  end if;
  return new;
end; $$;
revoke execute on function public.task_cover_check() from public, anon, authenticated;
drop trigger if exists trg_task_cover_check on public.tasks;
create trigger trg_task_cover_check before insert or update of cover_attachment_id on public.tasks
  for each row execute function public.task_cover_check();

-- the project's board: { wip: { "<column key>": n }, covers: bool } (lib/boards)
alter table public.projects add column if not exists board_settings jsonb not null default '{}'::jsonb;
alter table public.projects drop constraint if exists projects_board_settings_shape;
alter table public.projects add constraint projects_board_settings_shape check (
  jsonb_typeof(board_settings) = 'object' and pg_column_size(board_settings) <= 4096);

-- Merge one change into a project's board settings in one statement, so two
-- writers (or a tab that missed a live update) never overwrite each other's
-- limits: "wip" merges a level deeper (a null removes that limit, "wip": null
-- all of them; a limit is a whole number 1-999), "covers" is true or goes
-- (false / null), any other key merges as merge_onboarding does (null
-- removes it). Runs as you: the project's own update policies decide
-- (writers; never guests, the suspended or outsiders). Errors:
-- 'not authorized' · 'invalid patch' · 'project not found' (or not yours to
-- change) · a check violation when the result is too large.
create or replace function public.merge_board_settings(p_project uuid, p_patch jsonb)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  patch_wip jsonb;
  out_v jsonb;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  if p_project is null or p_patch is null or jsonb_typeof(p_patch) <> 'object' then raise exception 'invalid patch'; end if;
  if p_patch ? 'wip' and jsonb_typeof(p_patch -> 'wip') not in ('object', 'null') then raise exception 'invalid patch'; end if;
  if p_patch ? 'covers' and jsonb_typeof(p_patch -> 'covers') not in ('boolean', 'null') then raise exception 'invalid patch'; end if;
  patch_wip := case when jsonb_typeof(p_patch -> 'wip') = 'object' then p_patch -> 'wip' else '{}'::jsonb end;
  if exists (select 1 from jsonb_each(patch_wip) w
              where char_length(w.key) not between 1 and 200
                 or not (jsonb_typeof(w.value) = 'null'
                         or (jsonb_typeof(w.value) = 'number'
                             and (w.value #>> '{}')::numeric between 1 and 999
                             and (w.value #>> '{}')::numeric = trunc((w.value #>> '{}')::numeric)))) then
    raise exception 'invalid patch';
  end if;
  update public.projects pr
     set board_settings = (
       select coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb)
         from jsonb_each(
                coalesce(pr.board_settings, '{}'::jsonb) || (p_patch - 'wip')
                || case when not (p_patch ? 'wip') then '{}'::jsonb
                        else jsonb_build_object('wip', (
                          select coalesce(jsonb_object_agg(w.key, w.value), '{}'::jsonb)
                            from jsonb_each(
                                   case when jsonb_typeof(p_patch -> 'wip') = 'object'
                                         and jsonb_typeof(pr.board_settings -> 'wip') = 'object'
                                        then pr.board_settings -> 'wip' else '{}'::jsonb end
                                   || patch_wip) w
                           where jsonb_typeof(w.value) <> 'null')) end) e
        where jsonb_typeof(e.value) <> 'null'
          and not (e.key = 'covers' and e.value = 'false'::jsonb)
          and not (e.key = 'wip' and e.value = '{}'::jsonb))
   where pr.id = p_project
  returning pr.board_settings into out_v;
  if out_v is null then raise exception 'project not found'; end if;
  return out_v;
end; $$;
revoke execute on function public.merge_board_settings(uuid, jsonb) from public, anon;
grant execute on function public.merge_board_settings(uuid, jsonb) to authenticated;

-- ---------- 7. notification snoozes ----------
create table if not exists public.notification_snoozes (
  user_id    uuid not null references auth.users (id) on delete cascade,
  task_id    uuid not null references public.tasks (id) on delete cascade,
  until      timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (user_id, task_id)
);
create index if not exists notification_snoozes_until_idx on public.notification_snoozes (until);

create or replace function public.snooze_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.until is null or new.until > now() + interval '366 days' or new.until < now() - interval '1 day' then
    raise exception 'invalid snooze';
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    if (select count(*) from public.notification_snoozes s where s.user_id = new.user_id) >= 1000 then
      raise exception 'too many snoozes';
    end if;
  else
    new.user_id := old.user_id; new.task_id := old.task_id; new.created_at := old.created_at;
  end if;
  return new;
end; $$;
revoke execute on function public.snooze_guard() from public, anon, authenticated;
drop trigger if exists trg_snooze_guard on public.notification_snoozes;
create trigger trg_snooze_guard before insert or update on public.notification_snoozes
  for each row execute function public.snooze_guard();

-- ---------- 8. the notify queue (service only) ----------
-- One row per recipient, channel and event, held until deliver_after (end of
-- the 2-minute bundle window, of quiet hours, or the digest). event_key makes
-- enqueueing idempotent (upsert on_conflict=user_id,channel,event_key with
-- ignore-duplicates); bundle_key groups what's sent together ('task:<id>').
create table if not exists public.notify_queue (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,   -- the recipient
  channel       text not null,                                               -- 'push' | 'email'
  kind          text not null,                                               -- assigned | mention | comment | approval | kudos | due | digest
  event_key     text not null,
  bundle_key    text not null,
  task_id       uuid,
  actor_id      uuid references auth.users (id) on delete set null,
  actor_name    text not null default '',
  title         text not null default '',
  payload       jsonb not null default '{}'::jsonb,
  deliver_after timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  claimed_at    timestamptz,
  attempts      integer not null default 0,
  sent_at       timestamptz,
  last_error    text,
  constraint notify_queue_once unique (user_id, channel, event_key)
);
create index if not exists notify_queue_due_idx on public.notify_queue (deliver_after, id) where sent_at is null;
create index if not exists notify_queue_bundle_idx on public.notify_queue (user_id, bundle_key, created_at desc);
create index if not exists notify_queue_sent_idx on public.notify_queue (sent_at) where sent_at is not null;
alter table public.notify_queue drop constraint if exists notify_queue_shape;
alter table public.notify_queue add constraint notify_queue_shape check (
  channel in ('push', 'email')
  and kind in ('assigned', 'mention', 'comment', 'approval', 'kudos', 'due', 'digest')
  and char_length(event_key) between 1 and 200 and char_length(bundle_key) between 1 and 200
  and char_length(actor_name) <= 200 and char_length(title) <= 500
  and jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 8192
  and (last_error is null or char_length(last_error) <= 500));

-- SERVICE ROLE ONLY (the notify drain). Claims what's due (lease: a claim
-- older than p_lease_seconds is claimable again; 5 attempts at most) and
-- tidies up: sent rows after 7 days, failed ones after 2, snoozes 30 days
-- after they ended.
create or replace function public.notify_queue_claim(p_limit integer default 200, p_lease_seconds integer default 120)
returns setof public.notify_queue language plpgsql security definer set search_path = public as $$
begin
  delete from public.notify_queue where sent_at is not null and sent_at < now() - interval '7 days';
  delete from public.notify_queue where sent_at is null and attempts >= 5 and created_at < now() - interval '2 days';
  delete from public.notification_snoozes where until < now() - interval '30 days';
  return query
  with c as (
    select q.id from public.notify_queue q
     where q.sent_at is null and q.deliver_after <= now() and q.attempts < 5
       and (q.claimed_at is null or q.claimed_at < now() - make_interval(secs => greatest(coalesce(p_lease_seconds, 120), 30)))
     order by q.deliver_after, q.id
     limit least(greatest(coalesce(p_limit, 200), 1), 1000)
     for update skip locked
  )
  update public.notify_queue q set claimed_at = now(), attempts = q.attempts + 1
    from c where q.id = c.id
  returning q.*;
end; $$;

-- SERVICE ROLE ONLY. p_error null: sent. Otherwise released for a retry after
-- 2 minutes × attempts (the 5th failure gives up).
create or replace function public.notify_queue_finish(p_ids bigint[], p_error text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare k integer;
begin
  if p_error is null then
    update public.notify_queue set sent_at = now(), last_error = null where id = any (p_ids) and sent_at is null;
  else
    update public.notify_queue
       set claimed_at = null, last_error = left(p_error, 500),
           deliver_after = now() + make_interval(mins => 2 * greatest(attempts, 1))
     where id = any (p_ids) and sent_at is null;
  end if;
  get diagnostics k = row_count;
  return k;
end; $$;
revoke execute on function public.notify_queue_claim(integer, integer) from public, anon, authenticated;
revoke execute on function public.notify_queue_finish(bigint[], text) from public, anon, authenticated;

-- ---------- 9. kudos ----------
create table if not exists public.kudos (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,  -- the task's, when given
  from_user    uuid not null references auth.users (id) on delete cascade,
  to_user      uuid not null references auth.users (id) on delete cascade,
  emoji        text not null default '🎉',
  note         text,
  created_at   timestamptz not null default now(),
  constraint kudos_once unique (task_id, from_user)
);
create index if not exists kudos_ws_idx on public.kudos (workspace_id, created_at desc);
create index if not exists kudos_to_idx on public.kudos (to_user, created_at desc);
create index if not exists kudos_from_idx on public.kudos (from_user, created_at desc);
alter table public.kudos drop constraint if exists kudos_shape;
alter table public.kudos add constraint kudos_shape check (
  emoji in ('🎉', '👏', '🙌', '💪', '⭐', '🚀', '❤️', '🔥', '💯', '🏆')
  and (note is null or char_length(note) between 1 and 140)
  and from_user <> to_user);

-- Give kudos for a finished team task (anyone who can see it; guests too).
-- The recipient is the task's assignee, or p_to when it names the assignee or
-- a collaborator; never yourself. Idempotent: a second call returns the
-- first. At most 100 a day per giver.
-- Answers the kudos row + { from_name, to_name }.
-- Errors: 'not authorized' · 'task not found' · 'kudos need a team task' ·
--         'task not done' · 'invalid emoji' · 'invalid note' ·
--         'invalid recipient' · 'not for yourself' · 'too many kudos'
create or replace function public.give_kudos(p_task uuid, p_emoji text default '🎉', p_note text default null,
                                             p_to uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  me   uuid := auth.uid();
  t    record;
  to_u uuid;
  em   text := coalesce(nullif(btrim(coalesce(p_emoji, '')), ''), '🎉');
  nt   text := nullif(btrim(coalesce(p_note, '')), '');
  k    public.kudos;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  select x.id, x.title, x.status, x.workspace_id, x.user_id, x.assignee_id, x.collaborators into t
    from public.tasks x where x.id = p_task;
  if t.id is null or not public.can_see_task(p_task) then raise exception 'task not found'; end if;
  if t.workspace_id is null then raise exception 'kudos need a team task'; end if;
  if t.status <> 'done' then raise exception 'task not done'; end if;
  if em not in ('🎉', '👏', '🙌', '💪', '⭐', '🚀', '❤️', '🔥', '💯', '🏆') then raise exception 'invalid emoji'; end if;
  if nt is not null and char_length(nt) > 140 then raise exception 'invalid note'; end if;
  if p_to is not null then
    if not (p_to::text = t.assignee_id or p_to::text = any (coalesce(t.collaborators, '{}'))) then
      raise exception 'invalid recipient';
    end if;
    to_u := p_to;
  else
    to_u := public.kanbo_uuid(t.assignee_id);
  end if;
  if to_u is null then raise exception 'invalid recipient'; end if;
  if to_u = me then raise exception 'not for yourself'; end if;
  if not public.is_task_audience(t.workspace_id, t.user_id, to_u) then raise exception 'invalid recipient'; end if;

  select * into k from public.kudos x where x.task_id = p_task and x.from_user = me;
  if k.id is null then
    if (select count(*) from public.kudos x where x.from_user = me and x.created_at > now() - interval '1 day') >= 100 then
      raise exception 'too many kudos';
    end if;
    insert into public.kudos (task_id, workspace_id, from_user, to_user, emoji, note)
    values (p_task, t.workspace_id, me, to_u, em, nt)
    on conflict on constraint kudos_once do nothing
    returning * into k;
    if k.id is null then select * into k from public.kudos x where x.task_id = p_task and x.from_user = me; end if;
  end if;
  return to_jsonb(k) || jsonb_build_object('from_name', public.kanbo_person_name(k.from_user),
                                           'to_name', public.kanbo_person_name(k.to_user));
end; $$;

-- Take your kudos back (and its Inbox item). true when there was one.
create or replace function public.take_back_kudos(p_task uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare k public.kudos;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  delete from public.kudos x where x.task_id = p_task and x.from_user = auth.uid() returning * into k;
  if k.id is null then return false; end if;
  delete from public.activity a where a.user_id = k.to_user and a.kind = 'kudos' and a.meta ->> 'kudos_id' = k.id::text;
  return true;
end; $$;
revoke execute on function public.give_kudos(uuid, text, text, uuid) from public, anon;
revoke execute on function public.take_back_kudos(uuid) from public, anon;
grant execute on function public.give_kudos(uuid, text, text, uuid) to authenticated;
grant execute on function public.take_back_kudos(uuid) to authenticated;

-- the recipient's Inbox item (pref 'kudos') and the webhook event
create or replace function public.kudos_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare t record; from_name text;
begin
  select x.id, x.title, x.project_id, x.workspace_id, x.status into t from public.tasks x where x.id = new.task_id;
  from_name := public.kanbo_person_name(new.from_user);
  if public.notif_on(new.to_user, 'kudos') then
    insert into public.activity (user_id, task_id, task_title, kind, detail, meta)
    values (new.to_user, new.task_id, coalesce(t.title, 'a task'), 'kudos', from_name,
            jsonb_build_object('kudos_id', new.id, 'emoji', new.emoji, 'note', new.note));
  end if;
  if exists (select 1 from public.webhooks w where w.active) then
    begin
      perform public.webhook_enqueue(new.workspace_id, null, 'kudos.given', new.id::text,
        jsonb_build_object('kudos', to_jsonb(new), 'from_name', from_name,
                           'to_name', public.kanbo_person_name(new.to_user),
                           'task', jsonb_build_object('id', t.id, 'title', t.title, 'project_id', t.project_id,
                                                      'workspace_id', t.workspace_id, 'status', t.status)));
    exception when others then
      raise warning 'webhook capture skipped (kudos): %', sqlerrm;   -- never block the kudos
    end;
  end if;
  return null;
end; $$;
revoke execute on function public.kudos_after_insert() from public, anon, authenticated;
drop trigger if exists trg_kudos_after_insert on public.kudos;
create trigger trg_kudos_after_insert after insert on public.kudos
  for each row execute function public.kudos_after_insert();

-- ---------- 10. row security ----------
do $rls$
declare t text; pol record;
begin
  foreach t in array array['saved_views', 'task_templates', 'notification_snoozes', 'notify_queue', 'kudos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $rls$;

-- views + templates: your own (personal, or in a workspace you're in) and the
-- shared ones of your workspaces; writers share; owners/admins manage shared
do $saved$
declare t text;
begin
  foreach t in array array['saved_views', 'task_templates'] loop
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format($p$create policy "read: own or shared" on public.%I for select to authenticated using (
      (user_id = auth.uid() and public.can_act())
      or (shared and workspace_id is not null and public.is_member(workspace_id)))$p$, t);
    execute format($p$create policy "create: own" on public.%I for insert to authenticated with check (
      user_id = auth.uid() and public.can_act()
      and (workspace_id is null or public.is_member(workspace_id))
      and (not shared or public.can_write(workspace_id)))$p$, t);
    execute format($p$create policy "edit: own, or shared by an owner/admin" on public.%I for update to authenticated using (
      (user_id = auth.uid() and public.can_act())
      or (shared and workspace_id is not null and public.ws_role(workspace_id) in ('owner', 'admin')))
      with check (
      (user_id = auth.uid() and public.can_act()
        and (workspace_id is null or public.is_member(workspace_id))
        and (not shared or public.can_write(workspace_id)))
      or (workspace_id is not null and public.ws_role(workspace_id) in ('owner', 'admin')))$p$, t);
    execute format($p$create policy "delete: own, or shared by an owner/admin" on public.%I for delete to authenticated using (
      (user_id = auth.uid() and public.can_act())
      or (shared and workspace_id is not null and public.ws_role(workspace_id) in ('owner', 'admin')))$p$, t);
  end loop;
end $saved$;

-- snoozes: your own, for tasks you can see
grant select, insert, update, delete on public.notification_snoozes to authenticated;
create policy "snoozes: own, visible task" on public.notification_snoozes
  for all to authenticated
  using (user_id = auth.uid() and public.can_see_task(task_id))
  with check (user_id = auth.uid() and public.can_see_task(task_id));

-- kudos: the task's audience reads; writes only through give_kudos / take_back_kudos
grant select on public.kudos to authenticated;
create policy "kudos: task audience" on public.kudos
  for select to authenticated using (public.can_see_task(task_id));

-- notify_queue: service only (no grants, no policies)

-- (one-time, and a re-run) the caller's old saved searches → saved views
-- (same ids, pinned, kind 'search'); the old rows go. Runs as the caller.
create or replace function public.adopt_saved_searches()
returns integer language plpgsql security invoker set search_path = public as $$
declare n integer;
begin
  if auth.uid() is null or not public.can_act() then raise exception 'not authorized'; end if;
  insert into public.saved_views (id, user_id, workspace_id, name, kind, query, pinned, position, shared, created_at)
  select s.id, s.user_id, null, left(coalesce(nullif(btrim(s.name), ''), 'Saved search'), 80), 'search',
         jsonb_build_object('v', 1, 'filters', case when jsonb_typeof(s.query) = 'object' then s.query else '{}'::jsonb end),
         true, extract(epoch from s.created_at), false, s.created_at
    from (select x.* from public.saved_searches x
           where x.user_id = auth.uid() and pg_column_size(x.query) <= 8000
           order by x.created_at desc limit 200) s
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  delete from public.saved_searches x
   where x.user_id = auth.uid()
     and exists (select 1 from public.saved_views v where v.id = x.id and v.user_id = auth.uid());
  return n;
end; $$;
revoke execute on function public.adopt_saved_searches() from public, anon;
grant execute on function public.adopt_saved_searches() to authenticated;

-- ---------- 11. webhooks: kudos.given ----------
create or replace function public.webhook_event_names()
returns text[] language sql immutable as $$
  select array['task.created','task.updated','task.completed','task.deleted',
               'comment.created','project.created','project.updated','member.joined',
               'approval.requested','approval.decided','kudos.given']::text[];
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

-- ---------- 12. account deletion keeps the team's shared views and templates ----------
-- Runs after 0041's and 0047's (same event, alphabetical): a workspace has
-- already been handed to its heir, so shared rows the person made move to
-- that owner; their own unshared ones go with them.
create or replace function public.before_user_delete_0048() returns trigger
language plpgsql security definer set search_path = public as $$
declare prev text := coalesce(current_setting('kanbo.reassign', true), '');
begin
  perform set_config('kanbo.reassign', 'on', true);
  update public.saved_views v set user_id = ws.owner_id
    from public.workspaces ws
   where v.workspace_id = ws.id and v.user_id = old.id and v.shared and ws.owner_id <> old.id;
  update public.task_templates x set user_id = ws.owner_id
    from public.workspaces ws
   where x.workspace_id = ws.id and x.user_id = old.id and x.shared and ws.owner_id <> old.id;
  perform set_config('kanbo.reassign', prev, true);
  return old;
end; $$;
revoke execute on function public.before_user_delete_0048() from public, anon, authenticated;
drop trigger if exists trg_before_user_delete_0048 on auth.users;
create trigger trg_before_user_delete_0048 before delete on auth.users
  for each row execute function public.before_user_delete_0048();

-- ---------- 13. service-role grants ----------
do $svc$
begin
  grant select, insert, update, delete on public.notify_queue to service_role;
  grant select, insert, update, delete on public.notification_snoozes to service_role;
  grant select, insert, update, delete on public.kudos to service_role;
  grant select, insert, update, delete on public.saved_views to service_role;
  grant select, insert, update, delete on public.task_templates to service_role;
  grant execute on function public.notify_queue_claim(integer, integer) to service_role;
  grant execute on function public.notify_queue_finish(bigint[], text) to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- 14. realtime: views, kudos and snoozes stream to whoever can read them ----------
do $rt$
declare t text;
begin
  foreach t in array array['saved_views', 'kudos', 'notification_snoozes'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;
      when object_not_in_prerequisite_state then null;
      when undefined_object then null;
    end;
  end loop;
end $rt$;

-- ---------- 15. live presence: who may use the kanbo:* Realtime channels (u5) ----------
-- Presence rides Supabase Realtime on PRIVATE channels, one per object: "kanbo:task:<id>",
-- "kanbo:doc:<id>", "kanbo:project:<id>" (lib/presence). Realtime Authorization asks these policies on
-- realtime.messages when someone joins (and again when their token refreshes). Nothing is stored.
--   read  (see who's there; receive typing, doc edits, carets): anyone who can see the object.
--   write, extension 'presence' (say you're there): the same people.
--   write, extension 'broadcast': on a task, anyone who can see it (guests comment, so they may type);
--     on a doc, people who can edit its project (never guests) while it isn't archived — edits, carets,
--     "saved" notices and the order check; on a project, nobody (it's presence only).
-- Suspended or unapproved people: nothing (can_act). Signed out: nothing. Only uuids after the prefix.
-- A Realtime without Authorization (no realtime.messages) skips the policies: presence then stays off,
-- because the app only ever joins these channels as private ones.
create or replace function public.kanbo_realtime_allowed(p_topic text, p_extension text, p_write boolean)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  v_kind text;
  v_id uuid;
  v_project uuid;
  v_archived timestamptz;
begin
  if auth.uid() is null or p_topic is null or not public.can_act() then return false; end if;
  if p_topic !~ '^kanbo:(task|doc|project):[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
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
  end if;
  select d.project_id, d.archived_at into v_project, v_archived from public.project_docs d where d.id = v_id;
  if v_project is null then return false; end if;
  if p_write and p_extension = 'broadcast' then
    return v_archived is null and public.can_edit_project(v_project);
  end if;
  return public.can_see_project(v_project);
end; $$;
revoke all on function public.kanbo_realtime_allowed(text, text, boolean) from public, anon;
grant execute on function public.kanbo_realtime_allowed(text, text, boolean) to authenticated;

do $live$
begin
  if to_regclass('realtime.messages') is null or to_regprocedure('realtime.topic()') is null then return; end if;
  execute 'drop policy if exists "kanbo presence: read" on realtime.messages';
  execute 'drop policy if exists "kanbo presence: write" on realtime.messages';
  execute $p$create policy "kanbo presence: read" on realtime.messages for select to authenticated
    using (public.kanbo_realtime_allowed(realtime.topic(), extension, false))$p$;
  execute $p$create policy "kanbo presence: write" on realtime.messages for insert to authenticated
    with check (public.kanbo_realtime_allowed(realtime.topic(), extension, true))$p$;
end $live$;

-- ---------- 16. doc versions while people write together (u5) ----------
-- Live co-editing (lib/presence) has everyone in a doc autosaving their own
-- work in turn. 0047 cut a new version whenever the saver changed, so two
-- people writing together filled the last 50 within minutes and pushed out
-- every older version: the history that "Keep mine" and lost words point
-- to. A version now covers 10 minutes of the doc's editing whoever saves
-- (it names who saved it last); a checkpoint (a restore, keep mine) still
-- starts one of its own. Otherwise save_project_doc is 0047's, unchanged.
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

  -- versions (0048): one per 10 minutes of the doc's editing, whoever saves,
  -- naming who saved it last; the last 50. (People writing together live
  -- save in turn: a version per person per save would push every older
  -- version out of the 50 within minutes.) A checkpoint always starts a new
  -- one (the newest version always holds what the doc said before this
  -- save: every save writes it). A new one is stamped with the doc's
  -- updated_at, which always moves on, so it sorts after every earlier
  -- version even when two saves share a millisecond.
  select v.id, v.saved_by, v.saved_at into lastv from public.project_doc_versions v
   where v.doc_id = d.id order by v.saved_at desc, v.id desc limit 1;
  if not coalesce(p_checkpoint, false)
     and lastv.id is not null and lastv.saved_at > now() - interval '10 minutes' then
    update public.project_doc_versions set title = d.title, body = d.body, saved_by = me where id = lastv.id;
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
revoke execute on function public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean) from public, anon;
grant execute on function public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean) to authenticated;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0048') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0048')                        as recorded,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--     and table_name = 'profiles' and column_name = 'onboarding')                                   as onboarding,
--   (select count(*) from pg_indexes where schemaname = 'public'
--     and indexname in ('tasks_fts_idx', 'comments_fts_idx', 'projects_fts_idx', 'project_docs_fts_idx')) = 4 as search_indexes,
--   not (select p.prosecdef from pg_proc p where p.oid = 'public.search_all(text, jsonb, integer)'::regprocedure)
--   and not has_function_privilege('anon', 'public.search_all(text, jsonb, integer)', 'execute')    as search_runs_as_caller,
--   exists (select 1 from pg_trigger where tgname = 'trg_project_docs_plain_text')                   as doc_plain_text,
--   (select count(*) from pg_policies where schemaname = 'public'
--     and tablename in ('saved_views', 'task_templates')) = 8                                         as views_and_templates,
--   exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'notification_snoozes') as snoozes,
--   not has_table_privilege('authenticated', 'public.kudos', 'insert')
--   and has_table_privilege('authenticated', 'public.kudos', 'select')                              as kudos_through_functions,
--   not has_table_privilege('authenticated', 'public.notify_queue', 'select')                       as notify_queue_service_only,
--   exists (select 1 from pg_constraint where conname = 'tasks_cover_attachment_id_fkey' and condeferrable) as task_covers,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--     and table_name = 'projects' and column_name = 'board_settings')
--   and exists (select 1 from pg_proc p where p.oid = to_regprocedure('public.merge_board_settings(uuid, jsonb)')
--     and not p.prosecdef)                                                                         as board_settings,
--   'kudos.given' = any (public.webhook_event_names())                                               as kudos_event,
--   (select count(*) from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public'
--     and tablename in ('saved_views', 'kudos', 'notification_snoozes')) = 3                         as realtime,
--   (to_regclass('realtime.messages') is null or (select count(*) from pg_policies where schemaname = 'realtime'
--     and tablename = 'messages' and policyname in ('kanbo presence: read', 'kanbo presence: write')) = 2) as live_presence,
--   position('saved_by = me where id = lastv.id' in (select p.prosrc from pg_proc p
--     where p.oid = 'public.save_project_doc(uuid, uuid, text, jsonb, timestamptz, text, uuid[], boolean)'::regprocedure)) > 0 as doc_versions,
--   exists (select 1 from pg_trigger where tgname = 'trg_before_user_delete_0048')                  as account_deletion;
-- ============================================================
