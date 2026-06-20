-- ============================================================
-- KANBO — admin trial extension (2026-06-20)
--   Give testers comp access for a set number of months by pushing their
--   subscription trial end date out. Per-user + bulk. Admins only.
--   NOTE: while VITE_BILLING_ENABLED is off (free testing mode) nobody is
--   ever locked out regardless of this date — this just keeps the dates tidy
--   and lets you grant comp time once billing is switched on. Idempotent.
-- ============================================================

create or replace function public.admin_extend_trial(p_user uuid, p_months integer)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  insert into public.subscriptions (user_id, status, trial_ends_at)
  values (p_user, 'trialing', now() + (p_months || ' months')::interval)
  on conflict (user_id) do update
    set trial_ends_at = greatest(public.subscriptions.trial_ends_at, now()) + (p_months || ' months')::interval,
        status = case when public.subscriptions.status in ('canceled','past_due') then 'trialing'
                      else public.subscriptions.status end,
        updated_at = now();
end; $$;
grant execute on function public.admin_extend_trial(uuid, integer) to authenticated;

-- bulk: push every active trial out by N months; returns how many were extended
create or replace function public.admin_extend_all_trials(p_months integer)
returns integer language plpgsql security definer set search_path = public as $$
declare cnt integer;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.subscriptions
     set trial_ends_at = greatest(trial_ends_at, now()) + (p_months || ' months')::interval,
         updated_at = now()
   where status = 'trialing';
  get diagnostics cnt = row_count;
  return cnt;
end; $$;
grant execute on function public.admin_extend_all_trials(integer) to authenticated;
