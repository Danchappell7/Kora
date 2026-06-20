-- ============================================================
-- KANBO — admin billing aggregate (2026-06-20)
--   admin_billing(): subscription mix, plan distribution, real MRR and a
--   "trials ending in the next 7 days" follow-up list. Admins only.
--   MRR uses list prices: Personal $8/mo (800c), Team $12/seat/mo (1200c),
--   counting active + past_due subscriptions. Idempotent.
-- ============================================================

create or replace function public.admin_billing()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return json_build_object(
    'trialing',      (select count(*) from public.subscriptions where status = 'trialing'),
    'active',        (select count(*) from public.subscriptions where status = 'active'),
    'past_due',      (select count(*) from public.subscriptions where status = 'past_due'),
    'canceled',      (select count(*) from public.subscriptions where status = 'canceled'),
    'plan_personal', (select count(*) from public.subscriptions where plan = 'personal' and status in ('active','past_due')),
    'plan_team',     (select count(*) from public.subscriptions where plan = 'team'     and status in ('active','past_due')),
    'seats_active',  (select coalesce(sum(seats),0) from public.subscriptions where status in ('active','past_due')),
    'mrr_cents',     (select coalesce(sum(case when plan = 'personal' then 800
                                               when plan = 'team'     then 1200 * coalesce(seats,1)
                                               else 0 end), 0)
                        from public.subscriptions where status in ('active','past_due')),
    'trials_ending', coalesce((
      select json_agg(row_to_json(t)) from (
        select u.email,
               btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as name,
               s.trial_ends_at, s.plan
          from public.subscriptions s
          join auth.users u on u.id = s.user_id
          left join public.profiles p on p.id = s.user_id
         where s.status = 'trialing' and s.trial_ends_at between now() and now() + interval '7 days'
         order by s.trial_ends_at asc
      ) t
    ), '[]'::json)
  );
end; $$;
grant execute on function public.admin_billing() to authenticated;
