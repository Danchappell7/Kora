-- ============================================================
-- KANBO — invite-gated early access (2026-06-19)
--   While Kanbo is free, new users must be approved before they can
--   use the app. Existing accounts are grandfathered in (never locked out).
--   1. access_requests: public "request early access" submissions.
--   2. profiles.approved: the access gate (default false for new signups).
--   3. trigger: auto-approve the admin + anyone whose request was approved.
--   4. approve_access_request(): admin action — approves a request and
--      flips any existing profile with that email.
-- Idempotent.
-- ============================================================

-- ---------- 1. access_requests ----------
create table if not exists public.access_requests (
  id         uuid primary key default gen_random_uuid(),
  name       text not null default '',
  email      text not null,
  note       text,
  status     text not null default 'pending',   -- pending | approved | declined
  created_at timestamptz not null default now()
);
alter table public.access_requests enable row level security;

-- anyone (even signed-out) may submit a request; only the admin can read/update
drop policy if exists "submit access request" on public.access_requests;
create policy "submit access request" on public.access_requests for insert with check (true);
drop policy if exists "admin reads requests" on public.access_requests;
create policy "admin reads requests" on public.access_requests for select
  using ((auth.jwt() ->> 'email') = 'danchappell7@gmail.com');
drop policy if exists "admin updates requests" on public.access_requests;
create policy "admin updates requests" on public.access_requests for update
  using ((auth.jwt() ->> 'email') = 'danchappell7@gmail.com');

-- the landing form runs signed-out, so the anon role must be able to insert
-- (RLS still governs what — the "submit access request" policy above)
grant insert on public.access_requests to anon, authenticated;
grant select, update on public.access_requests to authenticated;

-- ---------- 2. profiles.approved (the gate) ----------
alter table public.profiles add column if not exists approved boolean not null default false;
-- grandfather every existing account so nobody currently using Kanbo is locked out
update public.profiles set approved = true where approved = false;

-- ---------- 3. auto-approve admin + pre-approved emails at signup ----------
create or replace function public.profile_auto_approve() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.email = 'danchappell7@gmail.com'
     or exists (select 1 from public.access_requests r
                where lower(r.email) = lower(new.email) and r.status = 'approved') then
    new.approved := true;
  end if;
  return new;
end; $$;
drop trigger if exists trg_profile_auto_approve on public.profiles;
create trigger trg_profile_auto_approve before insert on public.profiles
  for each row execute function public.profile_auto_approve();

-- ---------- 4. admin approval action ----------
create or replace function public.approve_access_request(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if (auth.jwt() ->> 'email') <> 'danchappell7@gmail.com' then
    raise exception 'not authorized';
  end if;
  update public.access_requests set status = 'approved' where id = p_id;
  update public.profiles p set approved = true
    from public.access_requests r
    where r.id = p_id and lower(p.email) = lower(r.email);
end; $$;
grant execute on function public.approve_access_request(uuid) to authenticated;
