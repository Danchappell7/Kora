-- ============================================================
-- KANBO — subscriptions: 7-day free trial, then paid Personal/Team.
-- One row per user. The trial starts the first time the app calls
-- ensure_subscription(). Only the Stripe webhook (service role)
-- changes plan/status; users can read their own row.
-- ============================================================

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  plan                   text check (plan in ('personal','team')),
  status                 text not null default 'trialing'
                           check (status in ('trialing','active','past_due','canceled')),
  trial_ends_at          timestamptz not null default (now() + interval '7 days'),
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  seats                  integer not null default 1,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "see own subscription" on public.subscriptions
  for select using (user_id = auth.uid());

-- create-if-missing; returns the caller's subscription (starts the trial)
create or replace function public.ensure_subscription()
returns public.subscriptions
language plpgsql security definer
set search_path = public
as $$
declare s public.subscriptions;
begin
  select * into s from subscriptions where user_id = auth.uid();
  if not found then
    insert into subscriptions (user_id) values (auth.uid()) returning * into s;
  end if;
  return s;
end;
$$;

alter publication supabase_realtime add table public.subscriptions;
