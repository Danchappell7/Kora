-- ============================================================
-- KANBO — rollout hardening (2026-09-30, before the team rollout)
-- Closes the server-side gaps that remain once 0041 is applied. Each one was
-- reproduced against a replay of the live schema before fixing (attack suite).
--   1. Invites: anyone could sign up with an invited colleague's address and
--      claim their invite (no confirmed-email check); invited teammates were
--      then stuck on the early-access waitlist. Now only a CONFIRMED address
--      can claim, and an invite counts as approval from the moment the
--      address is confirmed (so the invitee's first load is already past the
--      waitlist). An invite never undoes an admin's "Revoke access".
--   2. Access requests: anyone could insert a request already marked
--      'approved' (self-approval) or of any size; repeats piled up. Admin
--      checks were hard-coded to one email, so a delegated admin couldn't see
--      or approve requests and saw no stats. Now is_admin() everywhere.
--      A suspended platform admin also loses admin powers.
--   3. Files: an attachments row could point at someone else's storage path
--      and so unlock their file; the public avatars bucket could be listed by
--      anyone, leaking every user and workspace id; a removed member could
--      still delete files they had uploaded to the team's tasks.
--   4. Notifications: @mentions, assignments and comment notices went to any
--      uuid the client supplied (inbox spam, task titles leaking to strangers,
--      and a comment failed outright if a follower's account was deleted).
--      Now only people who can see the task are notified; comment notices
--      also reach the assignee, collaborators and the parent comment's author.
--   5. remove_member: any member or guest could delete a pending invite (NULL
--      check), and a removed person stayed on followers/collaborators.
--   6. Tags can belong to a workspace and are shared with its members.
--   7. Realtime now streams sections, custom fields, goals, portfolios,
--      status updates, automations, forms and dependencies.
--   8. Service-only tables for the edge functions (rate_limits, ai_usage) and
--      a schema_migrations ledger.
--   9. Checklist items (subtasks) and task dependencies were writable by
--      anyone who could see the task, guests included. They now follow 0041:
--      everyone who sees the task reads them; only people who can edit the
--      task (never guests) add, change or remove them.
--  10. Following a task: guests could not follow (0041 rejects their task
--      updates). toggle_task_follow() lets anyone who can see a task add or
--      remove only their own id.
-- Needs 0041. Idempotent: safe to run more than once.
-- RUN IT LAST. Re-running an older migration that this file overrides puts the
-- old hole back (e.g. 0010 re-creates the listable avatar policy, 0025 the
-- unchecked task-files read, 0037 notifications to any id, 0041 two functions
-- below). If any of 0004, 0007, 0008, 0010, 0012, 0014, 0016, 0017, 0025,
-- 0026, 0027, 0029, 0037 or 0041 is ever run again, run this file again
-- straight afterwards.
-- ============================================================

-- ---------- 0. preflight + ledger ----------
do $pre$
begin
  if to_regprocedure('public.can_write(uuid)') is null or to_regclass('public.approved_domains') is null then
    raise exception '0042 needs 0041 first: run 0041_security_hardening_2.sql, then this file';
  end if;
end $pre$;

create table if not exists public.schema_migrations (
  version    text primary key,
  applied_at timestamptz not null default now()
);
alter table public.schema_migrations enable row level security;
revoke all on public.schema_migrations from anon, authenticated;
grant select on public.schema_migrations to authenticated;
drop policy if exists "admins read schema_migrations" on public.schema_migrations;
create policy "admins read schema_migrations" on public.schema_migrations
  for select using (public.is_admin());

-- ---------- 1. trusted server-side writes + admin identity ----------
-- SECURITY DEFINER functions may set privileged profile columns by setting the
-- transaction-local flag kanbo.trusted = 'on' around the write. Clients can't
-- reach it: PostgREST runs no raw SQL and set_config() is not an exposed RPC.
create or replace function public.protect_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  real_email text := (select email from auth.users where id = new.id);
begin
  -- server-side callers (service role, signup trigger, SQL editor), trusted
  -- definer functions and platform admins may set anything
  if coalesce(auth.role(), '') not in ('authenticated', 'anon')
     or coalesce(current_setting('kanbo.trusted', true), '') = 'on'
     or public.is_admin() then
    return new;
  end if;
  new.email := coalesce(real_email, new.email);          -- email can't be spoofed
  if tg_op = 'INSERT' then
    new.is_admin := false; new.suspended := false; new.approved := false;  -- auto-approve (runs next) decides
  else
    new.is_admin := old.is_admin; new.suspended := old.suspended; new.approved := old.approved;
  end if;
  return new;
end; $$;

-- founding email OR the profiles flag — but a suspended admin is not an admin
-- (otherwise they could un-suspend themselves through their own profile row)
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select p.is_admin and not coalesce(p.suspended, false)
                     from public.profiles p where p.id = auth.uid()), false)
      or lower(coalesce((select email from auth.users where id = auth.uid()), '')) = 'danchappell7@gmail.com';
$$;
grant execute on function public.is_admin() to authenticated;

-- ---------- 2. invites: confirmed email only; an invite = approval ----------
-- With Supabase "Confirm email" OFF, GoTrue stamps email_confirmed_at at sign-up,
-- so today's invites keep working; once it is ON, an unconfirmed squatter can't
-- claim a colleague's invite.

-- Did a platform admin revoke this account's access (Admin > Revoke access,
-- logged as 'Revoked access') without granting it again since? An invite from a
-- workspace owner must not quietly undo that. Internal helper.
create or replace function public.access_revoked(p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((
    select a.detail = 'Revoked access'
      from public.admin_audit a
     where a.action = 'approve'
       and a.detail in ('Revoked access', 'Approved access')
       and (a.target = p_user::text
            or lower(btrim(a.target)) = (select lower(btrim(u.email)) from auth.users u where u.id = p_user))
     order by a.created_at desc, a.id desc
     limit 1), false);
$$;
revoke execute on function public.access_revoked(uuid) from public, anon, authenticated;

create or replace function public.claim_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare
  me       uuid := auth.uid();
  my_email text;
  claimed  uuid[];
  n        integer;
begin
  if me is null then return 0; end if;
  select lower(btrim(u.email)) into my_email
    from auth.users u where u.id = me and u.email_confirmed_at is not null;
  if coalesce(my_email, '') = '' then return 0; end if;

  with c as (
    update public.workspace_members
       set user_id = me, status = 'active'
     where status = 'invited' and user_id is null and lower(btrim(email)) = my_email
    returning workspace_id
  )
  select coalesce(array_agg(workspace_id), '{}') into claimed from c;
  n := coalesce(array_length(claimed, 1), 0);

  -- an invite from a workspace whose owner is in good standing lets you in
  -- (never lifts a suspension or an admin's revocation)
  if n > 0 and not public.access_revoked(me) and exists (
    select 1 from public.workspaces w
      left join public.profiles o on o.id = w.owner_id
     where w.id = any (claimed)
       and coalesce(o.approved, true) and not coalesce(o.suspended, false)
  ) then
    perform set_config('kanbo.trusted', 'on', true);
    update public.profiles set approved = true
     where id = me and not approved and not suspended;
    perform set_config('kanbo.trusted', 'off', true);
  end if;
  return n;
end; $$;
grant execute on function public.claim_invites() to authenticated;

-- An invite also approves the account the moment its address is confirmed, so
-- the invitee's FIRST load already passes the waitlist (the app reads the
-- profile before it calls claim_invites). GoTrue inserts the user and stamps
-- email_confirmed_at in a separate UPDATE (at once when "Confirm email" is off,
-- when the link is clicked when it is on), so this watches both. Joining the
-- workspace is still claim_invites' job. Never blocks a sign-up.
create or replace function public.approve_invited_on_confirm() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email_confirmed_at is null then return null; end if;
  if tg_op = 'UPDATE' and old.email_confirmed_at is not null then return null; end if;
  begin
    if exists (
         select 1 from public.workspace_members m
           join public.workspaces w on w.id = m.workspace_id
           left join public.profiles o on o.id = w.owner_id
          where m.status = 'invited' and m.user_id is null
            and lower(btrim(m.email)) = lower(btrim(new.email))
            and coalesce(o.approved, true) and not coalesce(o.suspended, false))
       and not public.access_revoked(new.id) then
      perform set_config('kanbo.trusted', 'on', true);
      insert into public.profiles (id, email, approved) values (new.id, new.email, true)
      on conflict (id) do update set approved = true
        where not public.profiles.approved and not public.profiles.suspended;
      perform set_config('kanbo.trusted', 'off', true);
    end if;
  exception when others then
    perform set_config('kanbo.trusted', 'off', true);
    raise warning 'approve_invited_on_confirm skipped: %', sqlerrm;
  end;
  return null;
end; $$;
revoke execute on function public.approve_invited_on_confirm() from public, anon, authenticated;
-- sorts after on_auth_user_created_profile (0041), so the profile row exists
drop trigger if exists on_auth_user_invite_approval on auth.users;
create trigger on_auth_user_invite_approval
  after insert or update of email_confirmed_at on auth.users
  for each row execute function public.approve_invited_on_confirm();

-- invite rows addressed to you are visible only once that address is confirmed
-- (returns only the caller's own address, so it is safe for any role to run)
create or replace function public.my_confirmed_email()
returns text language sql security definer stable set search_path = public as $$
  select lower(btrim(u.email)) from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;
$$;
grant execute on function public.my_confirmed_email() to anon, authenticated;

drop policy if exists "see members of my workspaces" on public.workspace_members;
create policy "see members of my workspaces" on public.workspace_members
  for select using (
    public.is_member(workspace_id)
    or user_id = auth.uid()
    or lower(email) = (select public.my_confirmed_email())
    or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );

-- one-time: people who already accepted an invite before this migration but
-- were left on the waitlist. Skips anyone an admin explicitly revoked. Runs on
-- the FIRST application only, so re-running this file never re-approves anyone.
do $backfill$
begin
  if exists (select 1 from public.schema_migrations where version = '0042') then return; end if;
  perform set_config('kanbo.trusted', 'on', true);
  update public.profiles p set approved = true
    from auth.users u
   where u.id = p.id
     and not p.approved and not p.suspended
     and u.email_confirmed_at is not null
     and exists (
       select 1 from public.workspace_members m
         join public.workspaces w on w.id = m.workspace_id
         left join public.profiles o on o.id = w.owner_id
        where m.user_id = p.id and m.status = 'active' and w.owner_id <> p.id
          and coalesce(o.approved, true) and not coalesce(o.suspended, false))
     and not public.access_revoked(p.id);
  perform set_config('kanbo.trusted', 'off', true);
end $backfill$;

-- ---------- 3. access requests + admin checks via is_admin() ----------
-- normalise, stop queue-jumping, and make a repeat request a quiet no-op
-- (same behaviour as the request-access edge function)
create or replace function public.access_request_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.email := lower(btrim(coalesce(new.email, '')));
  new.name  := btrim(coalesce(new.name, ''));
  if coalesce(auth.role(), '') in ('anon', 'authenticated') then
    new.created_at := now();
  end if;
  -- a repeat while one is pending, or after approval (they can just sign up),
  -- is a no-op. But if the approved account was later revoked, the new request
  -- goes into the admin queue instead of vanishing.
  if new.status = 'pending' and exists (
       select 1 from public.access_requests r
        where lower(btrim(r.email)) = new.email
          and (r.status = 'pending'
               or (r.status = 'approved' and not exists (
                     select 1 from auth.users u join public.profiles p on p.id = u.id
                      where lower(btrim(u.email)) = new.email and not p.approved)))) then
    return null;
  end if;
  return new;
end; $$;
drop trigger if exists trg_access_request_before_insert on public.access_requests;
create trigger trg_access_request_before_insert before insert on public.access_requests
  for each row execute function public.access_request_before_insert();

-- signed-out visitors may only file a pending, sensibly sized request
drop policy if exists "submit access request" on public.access_requests;
create policy "submit access request" on public.access_requests
  for insert with check (
    status = 'pending'
    and length(email) <= 254
    and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
    and length(coalesce(name, '')) <= 120
    and length(coalesce(note, '')) <= 2000
  );
drop policy if exists "admin reads requests" on public.access_requests;
create policy "admin reads requests" on public.access_requests
  for select using (public.is_admin());
drop policy if exists "admin updates requests" on public.access_requests;
create policy "admin updates requests" on public.access_requests
  for update using (public.is_admin()) with check (public.is_admin());

-- one open request per address. Fold any existing duplicates into the oldest
-- request first (keeping the latest name and every note) so the index can build.
with grp as (
  select lower(btrim(email)) as e,
         (array_agg(id order by created_at, id))[1] as keep_id,
         (array_agg(btrim(name) order by created_at desc) filter (where btrim(coalesce(name, '')) <> ''))[1] as latest_name,
         string_agg(btrim(note), E'\n' order by created_at) filter (where btrim(coalesce(note, '')) <> '') as notes
    from public.access_requests
   where status = 'pending'
   group by 1
  having count(*) > 1
)
update public.access_requests r
   set name = coalesce(g.latest_name, r.name),
       note = coalesce(g.notes, r.note)
  from grp g
 where r.id = g.keep_id;
delete from public.access_requests r
 using (select id, row_number() over (partition by lower(btrim(email)) order by created_at, id) as rn
          from public.access_requests where status = 'pending') d
 where r.id = d.id and d.rn > 1;
create unique index if not exists access_requests_one_pending_per_email
  on public.access_requests (lower(btrim(email))) where status = 'pending';

-- approve by the REAL account email (auth.users), never the editable profile copy
create or replace function public.approve_access_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare e text;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.access_requests set status = 'approved' where id = p_id
  returning lower(btrim(email)) into e;
  if e is null then return; end if;
  update public.profiles p set approved = true
    from auth.users u
   where u.id = p.id and lower(u.email) = e and not p.approved;
end; $$;
grant execute on function public.approve_access_request(uuid) to authenticated;

create or replace function public.admin_stats()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return json_build_object(
    'total_users',      (select count(*) from auth.users),
    'new_signups_30d',  (select count(*) from auth.users where created_at      > now() - interval '30 days'),
    'active_users_30d', (select count(*) from auth.users where last_sign_in_at > now() - interval '30 days'),
    'total_tasks',      (select count(*) from public.tasks),
    'completed_tasks',  (select count(*) from public.tasks where status = 'done'),
    'actions_30d',      (select count(*) from public.activity where created_at > now() - interval '30 days'),
    'dau',              (select count(distinct user_id) from public.sessions where last_seen_at > now() - interval '1 day'),
    'wau',              (select count(distinct user_id) from public.sessions where last_seen_at > now() - interval '7 days'),
    'sessions_30d',     (select count(*) from public.sessions where started_at > now() - interval '30 days'),
    'avg_session_sec',  coalesce((select round(avg(extract(epoch from (last_seen_at - started_at))))::int from public.sessions where started_at > now() - interval '30 days' and last_seen_at > started_at), 0),
    'mrr_cents',        0
  );
end;
$$;
grant execute on function public.admin_stats() to authenticated;

create or replace function public.admin_series()
returns json
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return json_build_object(
    'days', (
      with days as (
        select generate_series(
          (current_date - interval '29 days')::date,
          current_date,
          interval '1 day'
        )::date as d
      )
      select coalesce(json_agg(json_build_object(
        'd',       to_char(days.d, 'YYYY-MM-DD'),
        'signups', (select count(*) from auth.users    u where u.created_at::date  = days.d),
        'sessions',(select count(*) from public.sessions s where s.started_at::date = days.d),
        'active',  (select count(distinct s.user_id) from public.sessions s where s.started_at::date = days.d),
        'tasks',   (select count(*) from public.tasks    t where t.created_at::date  = days.d),
        'actions', (select count(*) from public.activity a where a.created_at::date  = days.d)
      ) order by days.d), '[]'::json)
      from days
    ),
    'by_status', (
      select coalesce(json_object_agg(status, n), '{}'::json)
      from (select status, count(*) n from public.tasks group by status) s
    ),
    'by_priority', (
      select coalesce(json_object_agg(priority, n), '{}'::json)
      from (select priority, count(*) n from public.tasks group by priority) p
    )
  );
end;
$$;
grant execute on function public.admin_series() to authenticated;

-- ---------- 4. files: no forged attachment paths, no avatar listing ----------
-- an attachment row must point inside YOUR folder for THAT task
-- (uploads are stored at "<uid>/<taskId>/<random>_<name>")
drop policy if exists "attach as yourself" on public.attachments;
create policy "attach as yourself" on public.attachments
  for insert with check (
    user_id = auth.uid()
    and split_part(path, '/', 1) = auth.uid()::text
    and split_part(path, '/', 2) = task_id::text
    and exists (select 1 from public.tasks t where t.id = task_id)
  );

-- teammates' files: the attachment row must also belong to the task its path
-- names, so any row forged before this migration unlocks nothing
drop policy if exists "read shared task-files" on storage.objects;
create policy "read shared task-files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-files'
    and exists (select 1 from public.attachments a
                 where a.path = storage.objects.name
                   and split_part(a.path, '/', 2) = a.task_id::text)
  );

-- you may delete a file you uploaded only while you can still see the task it
-- is attached to (or once nothing links to it, e.g. an upload whose attachment
-- row never saved). A removed member can no longer wipe a file the team's task
-- still shows. The helper only answers for paths in the caller's own folder.
create or replace function public.my_task_file_attached(p_path text)
returns boolean language sql security definer stable set search_path = public as $$
  select split_part(p_path, '/', 1) = auth.uid()::text
     and exists (select 1 from public.attachments a where a.path = p_path);
$$;
grant execute on function public.my_task_file_attached(text) to authenticated;
drop policy if exists "owner delete task-files" on storage.objects;
create policy "owner delete task-files" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'task-files'
    and owner = auth.uid()
    and (storage.foldername(name))[1] = auth.uid()::text
    and (exists (select 1 from public.attachments a where a.path = storage.objects.name)
         or not public.my_task_file_attached(storage.objects.name))
  );

-- avatars stay public by URL (public bucket), but nobody can list the bucket;
-- you can still see (and so upsert) your own folder
drop policy if exists "avatar public read" on storage.objects;
drop policy if exists "avatar read own" on storage.objects;
create policy "avatar read own" on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
update storage.buckets
   set allowed_mime_types = '{image/png,image/jpeg,image/gif,image/webp}',
       file_size_limit = 5242880
 where id = 'avatars';

-- ---------- 5. notifications only reach people who can see the task ----------
-- a team task: active members of its workspace (and its owner); a personal
-- task: its creator. Internal helper (triggers only).
create or replace function public.is_task_audience(p_ws uuid, p_creator uuid, p_user uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select case
    when p_user is null then false
    when p_ws is null then p_user = p_creator
    else exists (select 1 from public.workspace_members m
                  where m.workspace_id = p_ws and m.user_id = p_user and m.status = 'active')
      or exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = p_user)
  end;
$$;
revoke execute on function public.is_task_audience(uuid, uuid, uuid) from public, anon, authenticated;

create or replace function public.notify_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); actor_name text;
begin
  if NEW.assignee_id is null then return NEW; end if;
  if actor is null or NEW.assignee_id = actor::text then return NEW; end if;
  if TG_OP = 'UPDATE' and NEW.assignee_id is not distinct from OLD.assignee_id then return NEW; end if;
  if NEW.assignee_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return NEW; end if;
  if not public.is_task_audience(NEW.workspace_id, NEW.user_id, NEW.assignee_id::uuid) then return NEW; end if;
  if not public.notif_on(NEW.assignee_id::uuid, 'assigned') then return NEW; end if;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  insert into public.activity (user_id, task_id, task_title, kind, detail)
  values (NEW.assignee_id::uuid, NEW.id, NEW.title, 'assigned', coalesce(actor_name, 'Someone'));
  return NEW;
end; $$;

create or replace function public.notify_mentioned()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := NEW.user_id; actor_name text; t record; m uuid;
begin
  if NEW.mentions is null or array_length(NEW.mentions, 1) is null then return NEW; end if;
  select id, user_id, workspace_id, title into t from public.tasks where id = NEW.task_id;
  if t.id is null then return NEW; end if;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  for m in select distinct x from unnest(NEW.mentions) x where x is not null loop
    if m is not distinct from actor then continue; end if;
    if not public.is_task_audience(t.workspace_id, t.user_id, m) then continue; end if;
    if not public.notif_on(m, 'mention') then continue; end if;
    insert into public.activity (user_id, task_id, task_title, kind, detail)
    values (m, NEW.task_id, coalesce(t.title, 'a task'), 'mention', coalesce(actor_name, 'Someone'));
  end loop;
  return NEW;
end; $$;

-- creator + assignee + collaborators + followers + the author of the comment
-- being replied to, minus the author and anyone @mentioned (they get a
-- mention notice instead)
create or replace function public.notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor uuid := NEW.user_id;
  actor_name text;
  t record;
  parent_author uuid;
  x text;
  m uuid;
begin
  select id, user_id, workspace_id, title, assignee_id,
         coalesce(followers, '{}') as followers, coalesce(collaborators, '{}') as collaborators
    into t from public.tasks where id = NEW.task_id;
  if t.id is null then return NEW; end if;
  if NEW.parent_id is not null then
    select c.user_id into parent_author from public.comments c
     where c.id = NEW.parent_id and c.task_id = NEW.task_id;
  end if;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  for x in
    select distinct lower(btrim(v))
      from unnest(array[t.user_id::text, t.assignee_id, parent_author::text] || t.followers || t.collaborators) v
     where v is not null
  loop
    if x !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then continue; end if;
    m := x::uuid;
    if m is not distinct from actor or m = any (coalesce(NEW.mentions, '{}')) then continue; end if;
    if not public.is_task_audience(t.workspace_id, t.user_id, m) then continue; end if;
    if not public.notif_on(m, 'comment') then continue; end if;
    insert into public.activity (user_id, task_id, task_title, kind, detail)
    values (m, NEW.task_id, coalesce(t.title, 'a task'), 'comment', coalesce(actor_name, 'Someone'));
  end loop;
  return NEW;
end; $$;

-- ---------- 6. remove_member: NULL-safe guards + tidy up after the person ----------
create or replace function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m       public.workspace_members;
  caller  text;
  is_self boolean;
  uid_txt text;
begin
  select * into m from public.workspace_members where id = p_member;
  if m.id is null then return; end if;
  caller  := public.ws_role(m.workspace_id);              -- 'none' (never NULL) for outsiders
  is_self := coalesce(m.user_id = auth.uid(), false);     -- invite rows have no user_id
  if m.role = 'owner' then raise exception 'transfer ownership before removing the owner'; end if;
  -- allowed if you're managing (owner/admin) or removing yourself
  if not (caller in ('owner', 'admin') or is_self) then raise exception 'not authorized'; end if;
  if m.role = 'admin' and caller <> 'owner' and not is_self then
    raise exception 'only the owner can remove an admin';
  end if;
  delete from public.workspace_members where id = p_member;

  -- they no longer follow or collaborate on this workspace's tasks
  if m.user_id is not null then
    uid_txt := m.user_id::text;
    update public.tasks t
       set followers     = array(select f from unnest(t.followers) with ordinality as a(f, i)
                                  where lower(f) is distinct from uid_txt order by i),
           collaborators = array(select c from unnest(t.collaborators) with ordinality as b(c, i)
                                  where lower(c) is distinct from uid_txt order by i)
     where t.workspace_id = m.workspace_id
       and (exists (select 1 from unnest(t.followers) f where lower(f) = uid_txt)
         or exists (select 1 from unnest(t.collaborators) c where lower(c) = uid_txt));
  end if;
end; $$;
grant execute on function public.remove_member(uuid) to authenticated;

-- ---------- 7. workspace tags ----------
alter table public.tags add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;
create index if not exists tags_workspace_idx on public.tags (workspace_id);

-- same rules as 0041 content: personal = creator only; team = current members
-- read, owner/admin/member write (guests read-only). Every existing policy is
-- dropped first (policies are OR-ed, so a stray one would widen access).
do $tags$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'tags' loop
    execute format('drop policy %I on public.tags', pol.policyname);
  end loop;
end $tags$;
create policy "tags read: personal or member" on public.tags
  for select using (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and public.is_member(workspace_id)));
create policy "tags create: personal or writer" on public.tags
  for insert with check (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and user_id = auth.uid() and public.can_write(workspace_id)));
create policy "tags edit: personal or writer" on public.tags
  for update using (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and public.can_write(workspace_id)))
  with check (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and public.can_write(workspace_id)));
create policy "tags delete: personal or writer" on public.tags
  for delete using (
    (workspace_id is null and user_id = auth.uid() and public.can_act())
    or (workspace_id is not null and public.can_write(workspace_id)));

-- account deletion (0041) keeps the team's work: now includes workspace tags
create or replace function public.before_user_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  w record;
  heir uuid;
  t text;
begin
  -- hand each team workspace the person owns to its next admin/member
  for w in select id from public.workspaces where owner_id = old.id loop
    select m.user_id into heir from public.workspace_members m
     where m.workspace_id = w.id and m.status = 'active' and m.user_id is not null and m.user_id <> old.id
     order by case m.role when 'admin' then 0 when 'member' then 1 else 2 end, m.created_at
     limit 1;
    if heir is not null then
      update public.workspaces set owner_id = heir where id = w.id;
      update public.workspace_members set role = 'owner' where workspace_id = w.id and user_id = heir;
    end if;   -- nobody else in it: it's effectively personal and goes with them
  end loop;
  -- re-attribute their work in surviving team workspaces to that workspace's owner
  foreach t in array array['tasks','projects','sections','custom_field_defs','goals','portfolios','status_updates','automation_rules','forms','tags'] loop
    execute format('update public.%I x set user_id = ws.owner_id from public.workspaces ws where x.workspace_id = ws.id and x.user_id = $1 and ws.owner_id <> $1', t) using old.id;
  end loop;
  update public.projects p set owner_id = ws.owner_id from public.workspaces ws
   where p.workspace_id = ws.id and p.owner_id = old.id and ws.owner_id <> old.id;
  update public.projects set owner_id = user_id where owner_id = old.id and user_id <> old.id;
  update public.attachments a set user_id = t2.user_id from public.tasks t2
   where a.task_id = t2.id and a.user_id = old.id and t2.user_id <> old.id;
  update public.comments set user_id = null where user_id = old.id;
  return old;
end; $$;
revoke execute on function public.before_user_delete() from public, anon, authenticated;

-- ---------- 7b. checklist items + dependencies: editors write, guests read ----------
-- 0007's "for all" policies let anyone who could SEE the task (guests, too)
-- add, tick, rename and delete checklist items and dependencies. Same rule as
-- 0041's content now: may the caller edit this task?
create or replace function public.can_edit_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and public.can_write(t.workspace_id))));
$$;
grant execute on function public.can_edit_task(uuid) to authenticated;

do $children$
declare t text; pol record;
begin
  foreach t in array array['subtasks', 'task_dependencies'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
  end loop;
end $children$;

create policy "subtasks read: visible task" on public.subtasks
  for select using (exists (select 1 from public.tasks t where t.id = task_id));
create policy "subtasks create: task editors" on public.subtasks
  for insert with check (public.can_edit_task(task_id));
create policy "subtasks edit: task editors" on public.subtasks
  for update using (public.can_edit_task(task_id)) with check (public.can_edit_task(task_id));
create policy "subtasks delete: task editors" on public.subtasks
  for delete using (public.can_edit_task(task_id));

-- a dependency may only point at a task the caller can see
create policy "dependencies read: visible task" on public.task_dependencies
  for select using (exists (select 1 from public.tasks t where t.id = task_id));
create policy "dependencies create: task editors" on public.task_dependencies
  for insert with check (
    public.can_edit_task(task_id) and exists (select 1 from public.tasks d where d.id = depends_on));
create policy "dependencies edit: task editors" on public.task_dependencies
  for update using (public.can_edit_task(task_id))
  with check (public.can_edit_task(task_id) and exists (select 1 from public.tasks d where d.id = depends_on));
create policy "dependencies delete: task editors" on public.task_dependencies
  for delete using (public.can_edit_task(task_id));

-- ---------- 7c. following a task: everyone who can see it, guests too ----------
-- Following only adds or removes the caller's OWN id, so it is open to anyone
-- who can see the task (same rule as 0041's task read policy), including guests,
-- whose direct task updates 0041 rejects. One locked update, so two people
-- following at once never overwrite each other. p_follow: true = follow,
-- false = unfollow, null = toggle. Returns the task's followers afterwards.
-- The app always passes true or false (store.setTaskFollow), so a screen that
-- is out of date can't flip the person's choice; null is for the SQL editor.
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

-- ---------- 8. realtime for the remaining shared tables ----------
do $rt$
declare t text;
begin
  foreach t in array array['sections','custom_field_defs','goals','portfolios','status_updates','automation_rules','forms','task_dependencies'] loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when duplicate_object then null;                  -- already streaming
      when object_not_in_prerequisite_state then null;  -- publication is FOR ALL TABLES
    end;
  end loop;
end $rt$;

-- ---------- 9. service-only tables for the edge functions ----------
-- RLS on with no policies: only the service role (edge functions) can touch them.
create table if not exists public.rate_limits (
  key     text primary key,
  last_at timestamptz not null default now(),
  count   integer not null default 0
);
create index if not exists rate_limits_last_at_idx on public.rate_limits (last_at);
alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from anon, authenticated;

create table if not exists public.ai_usage (
  user_id uuid not null references auth.users (id) on delete cascade,
  day     date not null default current_date,
  calls   integer not null default 0,
  primary key (user_id, day)
);
alter table public.ai_usage enable row level security;
revoke all on public.ai_usage from anon, authenticated;

-- internal helpers are not public endpoints
revoke execute on function public.access_request_before_insert() from public, anon, authenticated;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0042') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0042')                 as recorded,
--   exists (select 1 from information_schema.columns
--            where table_schema = 'public' and table_name = 'tags' and column_name = 'workspace_id') as tags_workspace_id,
--   (select count(*) from pg_publication_tables
--     where pubname = 'supabase_realtime' and schemaname = 'public'
--       and tablename in ('sections','custom_field_defs','goals','portfolios','status_updates',
--                         'automation_rules','forms','task_dependencies')) = 8                as realtime_tables,
--   (select count(*) from pg_policies where schemaname = 'public' and tablename = 'access_requests'
--       and policyname in ('submit access request','admin reads requests','admin updates requests')
--       and coalesce(qual, '') || coalesce(with_check, '') not like '%danchappell7%') = 3     as access_request_policies,
--   (select count(*) from pg_policies where schemaname = 'public' and tablename = 'tags'
--       and policyname like 'tags %') = 4                                                       as tags_policies,
--   exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'attachments'
--            and policyname = 'attach as yourself' and with_check like '%split_part%')          as attachment_paths,
--   not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
--                and policyname = 'avatar public read')
--   and exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
--                and policyname = 'avatar read own')                                          as avatars_unlisted,
--   (select allowed_mime_types is not null and file_size_limit = 5242880
--      from storage.buckets where id = 'avatars')                                              as avatar_limits,
--   (select bool_and(prosrc not like '%danchappell7%') from pg_proc
--     where pronamespace = 'public'::regnamespace
--       and proname in ('admin_stats','admin_series','approve_access_request'))                as admin_checks_use_is_admin,
--   (select prosrc like '%email_confirmed_at%' from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'claim_invites')              as invites_need_confirmed_email,
--   (select prosrc like '%kanbo.trusted%' from pg_proc
--     where pronamespace = 'public'::regnamespace and proname = 'protect_profile_privileges') as trusted_flag,
--   exists (select 1 from pg_trigger where tgname = 'on_auth_user_invite_approval'
--            and tgrelid = 'auth.users'::regclass)                                           as invite_approves_on_confirm,
--   (select count(*) from pg_policies where schemaname = 'public'
--       and tablename in ('subtasks', 'task_dependencies')) = 8
--   and (select count(*) from pg_policies where schemaname = 'public'
--       and tablename in ('subtasks', 'task_dependencies') and cmd <> 'SELECT'
--       and coalesce(qual, '') || coalesce(with_check, '') like '%can_edit_task%') = 6    as checklist_deps_editors_only,
--   exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects'
--            and policyname = 'owner delete task-files' and qual like '%attachments%')      as task_file_delete_scoped,
--   exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace
--            and proname = 'toggle_task_follow' and prosecdef)                                 as follow_for_viewers,
--   (select relrowsecurity from pg_class where oid = 'public.rate_limits'::regclass)
--   and (select relrowsecurity from pg_class where oid = 'public.ai_usage'::regclass)          as service_tables_locked;
--
-- Any other read policy on the avatars bucket (e.g. one added from the
-- dashboard) would re-open listing. Expect exactly one row, 'avatar read own':
--
-- select policyname, roles, qual from pg_policies
--  where schemaname = 'storage' and tablename = 'objects'
--    and cmd in ('SELECT', 'ALL') and coalesce(qual, '') like '%avatars%';
-- ============================================================
