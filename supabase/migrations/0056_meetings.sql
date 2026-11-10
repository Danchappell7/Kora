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
--      watching follows. One live meeting of a kind per host (and set of
--      businesses) at a time; one left running for 12 hours is closed.
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
  -- one live meeting of a kind (over the same businesses) at a time; one left running for 12 hours is closed, without a recap
  perform pg_advisory_xact_lock(hashtext('kanbo.meeting:' || p_ws::text || ':' || p_preset));
  update public.meetings set status = 'ended', ended_at = now(), updated_at = now()
   where workspace_id = p_ws and preset = p_preset and status = 'live' and started_at < now() - interval '12 hours';
  if exists (select 1 from public.meetings m where m.workspace_id = p_ws and m.preset = p_preset and m.status = 'live' and m.workspace_ids = wss) then
    raise exception 'already running';
  end if;
  select m.id into prev from public.meetings m
   where m.id = p_previous and m.workspace_id = p_ws and m.preset = p_preset and m.workspace_ids = wss and m.status = 'ended';
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
--          and tablename in ('meetings', 'meeting_attendees', 'meeting_items')) = 3)                            as streams;
-- ============================================================
