-- ============================================================
-- KANBO — admin oversight & comms (2026-06-20)
--   1. admin_workspaces()      — every workspace with owner, members, tasks.
--   2. admin_close_workspace() — admin can close ANY workspace (cascades).
--   3. admin_audit table + admin_log() / admin_audit_list() — action trail.
--   4. banners table + admin_set_banner() / admin_clear_banner() + active read
--      for the app-wide broadcast banner.
--   Admin-only via is_admin(). Idempotent.
-- ============================================================

-- ---------- 1. workspaces overview ----------
create or replace function public.admin_workspaces()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select json_agg(row_to_json(x)) from (
      select w.id, w.name, w.logo_url, w.created_at,
             u.email as owner_email,
             btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')) as owner_name,
             (select count(*) from public.workspace_members m where m.workspace_id = w.id and m.status = 'active') as members,
             (select count(*) from public.tasks t where t.workspace_id = w.id) as tasks
        from public.workspaces w
        left join auth.users u on u.id = w.owner_id
        left join public.profiles p on p.id = w.owner_id
       order by w.created_at desc
    ) x
  ), '[]'::json);
end; $$;
grant execute on function public.admin_workspaces() to authenticated;

-- ---------- 2. admin can close any workspace ----------
create or replace function public.admin_close_workspace(p_ws uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  delete from public.workspaces where id = p_ws;   -- cascades to members/projects/tasks/etc.
end; $$;
grant execute on function public.admin_close_workspace(uuid) to authenticated;

-- ---------- 3. audit log ----------
create table if not exists public.admin_audit (
  id          uuid primary key default gen_random_uuid(),
  actor_id    uuid references auth.users (id) on delete set null,
  actor_email text,
  action      text not null,
  target      text,
  detail      text,
  created_at  timestamptz not null default now()
);
create index if not exists admin_audit_created_idx on public.admin_audit (created_at desc);
alter table public.admin_audit enable row level security;
drop policy if exists "admins read audit" on public.admin_audit;
create policy "admins read audit" on public.admin_audit for select using (public.is_admin());

create or replace function public.admin_log(p_action text, p_target text, p_detail text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  insert into public.admin_audit (actor_id, actor_email, action, target, detail)
  values (auth.uid(), (select email from auth.users where id = auth.uid()), p_action, p_target, p_detail);
end; $$;
grant execute on function public.admin_log(text, text, text) to authenticated;

create or replace function public.admin_audit_list()
returns json language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  return coalesce((
    select json_agg(row_to_json(x)) from (
      select id, actor_email, action, target, detail, created_at
        from public.admin_audit order by created_at desc limit 200
    ) x
  ), '[]'::json);
end; $$;
grant execute on function public.admin_audit_list() to authenticated;

-- ---------- 4. broadcast banner ----------
create table if not exists public.banners (
  id         uuid primary key default gen_random_uuid(),
  message    text not null,
  kind       text not null default 'info' check (kind in ('info','warning','success')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.banners enable row level security;
drop policy if exists "read active banners" on public.banners;
create policy "read active banners" on public.banners for select using (active is true);
grant select on public.banners to authenticated, anon;

create or replace function public.admin_set_banner(p_message text, p_kind text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.banners set active = false where active is true;   -- one active banner at a time
  insert into public.banners (message, kind, active) values (p_message, coalesce(nullif(p_kind,''),'info'), true);
end; $$;
grant execute on function public.admin_set_banner(text, text) to authenticated;

create or replace function public.admin_clear_banner()
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'not authorized'; end if;
  update public.banners set active = false where active is true;
end; $$;
grant execute on function public.admin_clear_banner() to authenticated;
