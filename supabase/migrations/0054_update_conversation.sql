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
--      (FYI), and anyone it @mentions ("Needs your reply").
--   5. status_update_reactions: one of six emoji per person per update;
--      you add and take back only your own.
--   6. status_update_views: "Seen by 6". mark_status_updates_seen(ids)
--      records the caller (never the author) on the updates they can read;
--      nothing else writes it.
--   7. Webhooks: 'status_update.posted' (team and personal endpoints).
--   8. Portfolio pages (c-portfolio-workspace, phase one): portfolios gain
--      owner_id, description, target_date, follower_ids, color, emoji.
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
create or replace function public.status_update_project_ok(p_project text, p_ws uuid)
returns boolean language plpgsql security definer stable set search_path = public as $$
begin
  if p_ws is null then return true; end if;
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
-- is 0051's to keep); an edit of what it says is marked; the people an Ask names are only ever
-- people who can read it (never its author). Server-side writers keep theirs. (user_id, the
-- row's keeper, isn't locked: account deletion hands it to the workspace's owner, sometimes from
-- a signed-in admin's call, and the permissive policies already keep a personal row its owner's.)
create or replace function public.status_update_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare client boolean := coalesce(auth.role(), '') in ('authenticated', 'anon');
begin
  if tg_op = 'UPDATE' and client then
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
      when (new.summary, new.status, new.sections, new.recovery_plan, new.target_date, new.ask_user_ids)
           is distinct from (old.summary, old.status, old.sections, old.recovery_plan, old.target_date, old.ask_user_ids)
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
      -- 120 an hour each: room for a lively thread, not for a flood
      if (select count(*) from public.status_update_comments c where c.user_id = auth.uid() and c.created_at > now() - interval '1 hour') >= 120 then
        raise exception 'too many comments';
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

-- the owner and followers hear about a new one (FYI)
create or replace function public.portfolio_update_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare p record; r uuid; who text;
begin
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
create trigger trg_portfolio_update_after after insert on public.portfolio_updates
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
--   exists (select 1 from pg_trigger where tgname = 'trg_status_update_after' and not tgisinternal)      as notices;
-- ============================================================
