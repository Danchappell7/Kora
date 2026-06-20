-- ============================================================
-- KANBO — admin growth analytics (2026-06-20)
--   1. admin_series_range(p_days) — generalises admin_series() to N daily
--      buckets (7 / 30 / 90) so the chart can offer a date range. Same shape.
--   2. admin_funnel() — signup → approved → activated → active counts.
--   Both admins only via is_admin(). Idempotent.
-- ============================================================

create or replace function public.admin_series_range(p_days integer default 30)
returns json language plpgsql security definer set search_path = public as $$
declare n integer := greatest(1, least(coalesce(p_days, 30), 365));
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return json_build_object(
    'days', (
      with days as (
        select generate_series((current_date - ((n - 1) || ' days')::interval)::date, current_date, interval '1 day')::date as d
      )
      select coalesce(json_agg(json_build_object(
        'd',       to_char(days.d, 'YYYY-MM-DD'),
        'signups', (select count(*) from auth.users     u where u.created_at::date  = days.d),
        'sessions',(select count(*) from public.sessions s where s.started_at::date = days.d),
        'active',  (select count(distinct s.user_id) from public.sessions s where s.started_at::date = days.d),
        'tasks',   (select count(*) from public.tasks    t where t.created_at::date  = days.d),
        'actions', (select count(*) from public.activity a where a.created_at::date  = days.d)
      ) order by days.d), '[]'::json)
      from days
    ),
    'by_status',   (select coalesce(json_object_agg(status, n2), '{}'::json)   from (select status, count(*) n2 from public.tasks group by status) s),
    'by_priority', (select coalesce(json_object_agg(priority, n2), '{}'::json) from (select priority, count(*) n2 from public.tasks group by priority) p)
  );
end; $$;
grant execute on function public.admin_series_range(integer) to authenticated;

-- ---------- conversion funnel ----------
create or replace function public.admin_funnel()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return json_build_object(
    'signups',   (select count(*) from auth.users),
    'approved',  (select count(*) from public.profiles where approved is true),
    'activated', (select count(distinct user_id) from public.tasks),
    'active_30d',(select count(*) from auth.users where last_sign_in_at > now() - interval '30 days')
  );
end; $$;
grant execute on function public.admin_funnel() to authenticated;
