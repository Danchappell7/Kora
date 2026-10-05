-- ============================================================
-- KANBO — push devices: only save_push_subscription() writes them, and the
-- 20-device cap lives in the database (2026-10-05). Follow-up to 0043.
--
-- Why: 0043's "push: own rows" policy is FOR ALL, and Supabase grants every
-- new table to `authenticated` by default, so a signed-in person could
-- INSERT (or UPDATE) their own push_subscriptions rows straight through the
-- REST API, past save_push_subscription() and its 20-device cap: thousands of
-- junk https rows, say. This file:
--   1. lets the app only read and remove its own rows (no INSERT/UPDATE);
--      save_push_subscription() (security definer) stays the one way in;
--   2. keeps each person's 20 newest devices whenever a row is added or
--      handed to someone, whoever writes it (a trigger, so the cap holds for
--      the service role too, and if a grant ever comes back);
--   3. trims anyone already over 20 (newest kept), once.
-- The app is unchanged: it saves through save_push_subscription(), reads its
-- own row by endpoint and deletes its own rows, all still allowed.
-- Needs 0043. Idempotent: safe to run more than once, and re-running 0043
-- afterwards doesn't undo it (0043 never grants to `authenticated`).
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.push_subscriptions') is null
     or not exists (select 1 from public.schema_migrations where version = '0043') then
    raise exception '0044 needs 0043 first: run 0043_integrations_push_forms_plans.sql, then this file';
  end if;
end $pre$;

-- ---------- 1. the app reads and removes its own rows; nothing else ----------
revoke all on public.push_subscriptions from public, anon, authenticated;
grant select, delete on public.push_subscriptions to authenticated;

do $ps$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions' loop
    execute format('drop policy %I on public.push_subscriptions', pol.policyname);
  end loop;
end $ps$;
create policy "push: read own" on public.push_subscriptions
  for select using (user_id = auth.uid());
-- removing your own devices stays open even when suspended: it only ever
-- stops notifications (sign-out, "switch off everywhere")
create policy "push: remove own" on public.push_subscriptions
  for delete using (user_id = auth.uid());

-- ---------- 2. 20 newest devices per person, however a row got there ----------
create or replace function public.push_subscriptions_keep_newest() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from public.push_subscriptions
   where id in (select id from public.push_subscriptions where user_id = new.user_id
                 order by created_at desc, id offset 20);
  return null;
end; $$;
revoke execute on function public.push_subscriptions_keep_newest() from public, anon, authenticated;
drop trigger if exists trg_push_subscriptions_cap on public.push_subscriptions;
create trigger trg_push_subscriptions_cap after insert or update of user_id on public.push_subscriptions
  for each row execute function public.push_subscriptions_keep_newest();

-- ---------- 3. trim anyone already over the cap (once; newest kept) ----------
delete from public.push_subscriptions s
 using (select id, row_number() over (partition by user_id order by created_at desc, id) as n
          from public.push_subscriptions) r
 where s.id = r.id and r.n > 20;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0044') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0044')                     as recorded,
--   not has_any_column_privilege('authenticated', 'public.push_subscriptions', 'insert')
--   and not has_any_column_privilege('authenticated', 'public.push_subscriptions', 'update')  as push_writes_via_function_only,
--   has_table_privilege('authenticated', 'public.push_subscriptions', 'select')
--   and has_table_privilege('authenticated', 'public.push_subscriptions', 'delete')           as push_read_and_remove_own,
--   exists (select 1 from pg_trigger where tgname = 'trg_push_subscriptions_cap')              as push_cap_trigger,
--   not exists (select 1 from public.push_subscriptions group by user_id having count(*) > 20) as push_within_cap;
-- ============================================================
