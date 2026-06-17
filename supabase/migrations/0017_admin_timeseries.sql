-- ============================================================
-- KANBO — admin analytics, part 2: time-series + breakdowns for the
-- charts on the hidden /admin dashboard. Paste into the Supabase SQL
-- editor and Run. Safe to re-run. Admins only (same gate as 0016).
--   admin_series() returns:
--     days        : 30 daily buckets {d, signups, sessions, active, tasks, actions}
--     by_status   : task counts per status   {todo, progress, review, blocked, done}
--     by_priority : task counts per priority  {low, medium, high, urgent}
-- ============================================================

create or replace function public.admin_series()
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
