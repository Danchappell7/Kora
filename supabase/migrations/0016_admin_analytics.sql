-- ============================================================
-- KANBO — internal admin analytics: a sessions table (for dwell time) and
-- the admin_stats() aggregate function used by the hidden /admin dashboard.
-- Paste into the Supabase SQL editor and Run. (The /admin page shows live
-- account numbers even without this; this adds dwell time + cross-user totals.)
-- ============================================================

-- ---------- sessions: lightweight active-time tracking ----------
create table if not exists public.sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  started_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create index if not exists sessions_user_idx on public.sessions (user_id, started_at desc);
create index if not exists sessions_seen_idx on public.sessions (last_seen_at);

alter table public.sessions enable row level security;
drop policy if exists "own sessions" on public.sessions;
create policy "own sessions" on public.sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ---------- admin_stats(): cross-user aggregates (admins only) ----------
create or replace function public.admin_stats()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  me text := (select email from auth.users where id = auth.uid());
begin
  if me is null or lower(me) not in ('danchappell7@gmail.com') then
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

-- ---------- admin_accounts(): full account list (admins only) ----------
create or replace function public.admin_accounts()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  me text := (select email from auth.users where id = auth.uid());
begin
  if me is null or lower(me) not in ('danchappell7@gmail.com') then
    raise exception 'not authorized';
  end if;
  return (
    select coalesce(json_agg(json_build_object(
      'id', u.id,
      'email', u.email,
      'name', coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email),
      'created_at', u.created_at,
      'last_sign_in_at', u.last_sign_in_at
    ) order by u.created_at desc), '[]'::json)
    from auth.users u
    left join public.profiles p on p.id = u.id
  );
end;
$$;

grant execute on function public.admin_accounts() to authenticated;
