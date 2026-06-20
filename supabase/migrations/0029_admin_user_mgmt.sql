-- ============================================================
-- KANBO — admin user management (2026-06-20)
--   1. profiles.is_admin + profiles.suspended flags.
--   2. is_admin() helper (founding email OR profiles.is_admin) — admin identity
--      moves off the hardcoded email so "grant admin" actually works.
--   3. admin mutation RPCs: set_approved / set_admin / set_suspended / delete_user.
--   4. admin_account_detail() — the per-user drawer payload.
-- All mutating RPCs are SECURITY DEFINER and gated by is_admin(). Idempotent.
-- ============================================================

alter table public.profiles add column if not exists is_admin   boolean not null default false;
alter table public.profiles add column if not exists suspended  boolean not null default false;

-- seed the founding admin
update public.profiles set is_admin = true
 where id = (select id from auth.users where lower(email) = 'danchappell7@gmail.com');

-- ---------- is_admin(): founding email OR the profiles flag ----------
create or replace function public.is_admin()
returns boolean language sql security definer stable set search_path = public as $$
  select coalesce((select p.is_admin from public.profiles p where p.id = auth.uid()), false)
      or lower(coalesce((select email from auth.users where id = auth.uid()), '')) = 'danchappell7@gmail.com';
$$;
grant execute on function public.is_admin() to authenticated;

-- ---------- approve / revoke the early-access gate ----------
create or replace function public.admin_set_approved(p_user uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.profiles set approved = p_approved where id = p_user;
end; $$;
grant execute on function public.admin_set_approved(uuid, boolean) to authenticated;

-- ---------- grant / revoke admin ----------
create or replace function public.admin_set_admin(p_user uuid, p_is_admin boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_user = auth.uid() and not p_is_admin then raise exception 'cannot remove your own admin'; end if;
  update public.profiles set is_admin = p_is_admin where id = p_user;
end; $$;
grant execute on function public.admin_set_admin(uuid, boolean) to authenticated;

-- ---------- suspend / unsuspend (suspended users are blocked at the gate) ----------
create or replace function public.admin_set_suspended(p_user uuid, p_suspended boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_user = auth.uid() then raise exception 'cannot suspend yourself'; end if;
  update public.profiles set suspended = p_suspended where id = p_user;
end; $$;
grant execute on function public.admin_set_suspended(uuid, boolean) to authenticated;

-- ---------- permanently delete a user (cascades through auth.users FKs) ----------
create or replace function public.admin_delete_user(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  if p_user = auth.uid() then raise exception 'cannot delete yourself'; end if;
  delete from auth.users where id = p_user;   -- cascades to profiles/tasks/workspaces/etc.
end; $$;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- ---------- per-user detail for the admin drawer ----------
create or replace function public.admin_account_detail(p_user uuid)
returns json language plpgsql security definer set search_path = public as $$
declare u record; prof record;
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  select email, created_at, last_sign_in_at into u from auth.users where id = p_user;
  select first_name, last_name, approved, is_admin, suspended into prof from public.profiles where id = p_user;
  return json_build_object(
    'id', p_user,
    'email', u.email,
    'name', btrim(coalesce(prof.first_name,'') || ' ' || coalesce(prof.last_name,'')),
    'created_at', u.created_at,
    'last_sign_in_at', u.last_sign_in_at,
    'approved', coalesce(prof.approved, true),
    'is_admin', coalesce(prof.is_admin, false),
    'suspended', coalesce(prof.suspended, false),
    'workspaces_owned', (select count(*) from public.workspaces w where w.owner_id = p_user),
    'workspaces_member', (select count(*) from public.workspace_members m where m.user_id = p_user and m.status = 'active'),
    'tasks_total', (select count(*) from public.tasks t where t.user_id = p_user),
    'tasks_done', (select count(*) from public.tasks t where t.user_id = p_user and t.status = 'done'),
    'plan', (select s.plan from public.subscriptions s where s.user_id = p_user),
    'sub_status', (select s.status from public.subscriptions s where s.user_id = p_user)
  );
end; $$;
grant execute on function public.admin_account_detail(uuid) to authenticated;

-- ---------- extend admin_accounts() with approval/admin/suspended flags ----------
-- (re-create so the table can show status without an extra per-row round-trip)
create or replace function public.admin_accounts()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select json_agg(row_to_json(x)) from (
      select u.id, u.email, u.created_at, u.last_sign_in_at,
             btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as name,
             coalesce(p.approved, true)  as approved,
             coalesce(p.is_admin, false) as is_admin,
             coalesce(p.suspended,false) as suspended
        from auth.users u
        left join public.profiles p on p.id = u.id
       order by u.created_at desc
    ) x
  ), '[]'::json);
end; $$;
grant execute on function public.admin_accounts() to authenticated;
