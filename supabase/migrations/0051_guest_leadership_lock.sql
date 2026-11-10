-- ============================================================
-- KANBO — guests can't read a team's goals or portfolios (2026-11-09).
-- A stop-gap ahead of private projects.
--
--   1. goals, portfolios: a team row is read by its workspace's owner,
--      admins and members only. A guest (a client, a freelancer) no longer
--      sees the group's targets or how its projects are grouped, through the
--      app, the REST API or realtime. A restrictive "guests: no team reports"
--      SELECT policy on each table, ANDed with 0041's "read: personal or
--      member": members and above read exactly what they did, personal rows
--      (workspace_id null) are untouched, and writes were already
--      members-only (0041 can_write). Status updates stay readable: a guest
--      keeps the updates on the projects they follow. 0041 drops every policy
--      on these tables when it's run again, so it calls guest_lock_restore()
--      to put this one back, as it does for 0046.
--   2. status_updates.author_id: who posted an update. user_id is the row's
--      keeper, and when the author deletes their account it passes to the
--      workspace's owner (0042 before_user_delete), so it can't say who wrote
--      it. author_id is set from the person posting (never from the request),
--      can't be changed afterwards, and is emptied when that account is
--      deleted: the app shows "Former member". Existing updates take user_id
--      once, on the first run.
--
--   Guests can STILL read every task, project, comment and doc in the
--   workspace until private projects ship (wave 4). The app's hiding of
--   Pulse, Workload and Insights for guests is an interface gate only.
--
-- Needs 0041 (ws_role) and 0042 (schema_migrations). Works with or without
-- 0043–0050. Idempotent: safe to run more than once (re-running keeps every
-- author, including an emptied one).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regprocedure('public.ws_role(uuid)') is null or to_regclass('public.schema_migrations') is null
     or not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0051 needs 0041 and 0042 first: run them, then this file';
  end if;
end $pre$;

-- ---------- 1. goals and portfolios are for members ----------
-- (Re)creates the "guests: no team reports" policy on each table: run below,
-- and by 0041 when it's run again (it drops every policy on these tables).
-- Returns how many tables it covered (a missing table is skipped).
create or replace function public.guest_lock_restore()
returns integer language plpgsql set search_path = public as $$
declare t text; n integer := 0;
begin
  -- status updates are read by guests too (an early draft of this file locked them: undo that)
  if to_regclass('public.status_updates') is not null then
    drop policy if exists "guests: no team reports" on public.status_updates;
  end if;
  foreach t in array array['goals', 'portfolios'] loop
    if to_regclass('public.' || t) is null then continue; end if;
    execute format('drop policy if exists "guests: no team reports" on public.%I', t);
    -- ws_role() is 'none' (never NULL) for outsiders, who 0041's read policy already
    -- turns away; here only a guest is refused, so members and above read as before
    execute format('create policy "guests: no team reports" on public.%I as restrictive for select using '
                   || '(workspace_id is null or public.ws_role(workspace_id) <> ''guest'')', t);
    n := n + 1;
  end loop;
  return n;
end; $$;
revoke execute on function public.guest_lock_restore() from public, anon, authenticated;

-- Is it on both tables (restrictive, for SELECT, row security on)?
create or replace function public.guest_lock_intact()
returns boolean language sql stable set search_path = pg_catalog, public as $$
  select coalesce(bool_and(c.relrowsecurity and exists (
           select 1 from pg_catalog.pg_policy p
            where p.polrelid = c.oid and p.polname = 'guests: no team reports' and not p.polpermissive and p.polcmd = 'r')), false)
    from unnest(array['goals', 'portfolios']) as t(name)
    join pg_catalog.pg_class c on c.oid = to_regclass('public.' || t.name);
$$;
revoke execute on function public.guest_lock_intact() from public, anon, authenticated;

do $lock$
begin
  perform public.guest_lock_restore();
end $lock$;

-- ---------- 2. who wrote each status update ----------
alter table public.status_updates add column if not exists author_id uuid;
do $fk$
begin
  alter table public.status_updates add constraint status_updates_author_id_fkey
    foreign key (author_id) references auth.users (id) on delete set null;
exception when duplicate_object then null;   -- already there
end $fk$;
create index if not exists status_updates_author_idx on public.status_updates (author_id);
-- (the trigger below would keep an empty author empty: it's put back after the fill)
drop trigger if exists trg_status_update_author on public.status_updates;

-- the updates posted before this: their keeper is the best we know. Once only, so a
-- re-run never refills an author whose account has since been deleted.
do $fill$
begin
  if not exists (select 1 from public.schema_migrations where version = '0051') then
    update public.status_updates set author_id = user_id where author_id is null;
  end if;
end $fill$;

-- The person posting is the author, whatever the request says; afterwards it never
-- changes, except to empty it once that account is deleted (the foreign key's SET NULL
-- runs after the auth.users row has gone). Nobody can blank it to disown an update.
-- Server-side writers (service role, SQL editor) may name an author, else the keeper.
create or replace function public.status_update_author() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if coalesce(auth.role(), '') in ('authenticated', 'anon') then
      new.author_id := auth.uid();
    else
      new.author_id := coalesce(new.author_id, new.user_id);
    end if;
  elsif new.author_id is distinct from old.author_id
        and not (new.author_id is null and not exists (select 1 from auth.users u where u.id = old.author_id)) then
    new.author_id := old.author_id;
  end if;
  return new;
end; $$;
revoke execute on function public.status_update_author() from public, anon, authenticated;
create trigger trg_status_update_author before insert or update on public.status_updates
  for each row execute function public.status_update_author();

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0051') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0051')                          as recorded,
--   (select count(*) from pg_policies where schemaname = 'public' and policyname = 'guests: no team reports'
--     and permissive = 'RESTRICTIVE' and cmd = 'SELECT'
--     and tablename in ('goals', 'portfolios')) = 2                                                 as guest_lock,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'status_updates' and column_name = 'author_id')                       as author_column,
--   exists (select 1 from pg_trigger where tgname = 'trg_status_update_author' and not tgisinternal)  as author_trigger,
--   not has_function_privilege('authenticated', 'public.guest_lock_restore()', 'execute')            as restore_private;
-- ============================================================
