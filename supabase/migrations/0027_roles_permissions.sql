-- ============================================================
-- KANBO — workspace roles & permissions (2026-06-20)
--   Roles: owner / admin / member / guest.
--   All member mutations go through SECURITY DEFINER RPCs with explicit
--   guards, so an admin can manage members without being able to touch the
--   owner or other admins. No content-RLS changes here (low risk) — guest
--   project-scoping ships as a separate, tested migration.
-- Idempotent.
-- ============================================================

-- ---------- 1. widen the role set ----------
alter table public.workspace_members drop constraint if exists workspace_members_role_check;
alter table public.workspace_members
  add constraint workspace_members_role_check check (role in ('owner', 'admin', 'member', 'guest'));

-- ---------- 2. caller's role in a workspace ----------
create or replace function public.ws_role(ws uuid) returns text
language sql security definer stable set search_path = public as $$
  select role from public.workspace_members
  where workspace_id = ws and user_id = auth.uid() and status = 'active' limit 1;
$$;
grant execute on function public.ws_role(uuid) to authenticated;

-- ---------- 3. invite a member (owner/admin) ----------
create or replace function public.invite_member(p_ws uuid, p_email text, p_name text default '', p_role text default 'member')
returns public.workspace_members
language plpgsql security definer set search_path = public as $$
declare
  caller text := public.ws_role(p_ws);
  row public.workspace_members;
begin
  if caller not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p_role not in ('admin', 'member', 'guest') then raise exception 'invalid role'; end if;
  if p_role = 'admin' and caller <> 'owner' then raise exception 'only the owner can add admins'; end if;
  insert into public.workspace_members (workspace_id, email, name, role, status)
  values (p_ws, p_email, coalesce(p_name, ''), p_role, 'invited')
  on conflict (workspace_id, email) do update set role = excluded.role, name = excluded.name
  returning * into row;
  return row;
end; $$;
grant execute on function public.invite_member(uuid, text, text, text) to authenticated;

-- ---------- 4. change a member's role (owner/admin, with guards) ----------
create or replace function public.set_member_role(p_member uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.workspace_members;
  caller text;
begin
  select * into m from public.workspace_members where id = p_member;
  if m is null then raise exception 'member not found'; end if;
  caller := public.ws_role(m.workspace_id);
  if caller not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p_role not in ('admin', 'member', 'guest') then raise exception 'invalid role'; end if;        -- use transfer_ownership for owner
  if m.role = 'owner' then raise exception 'cannot change the owner''s role'; end if;
  if (m.role = 'admin' or p_role = 'admin') and caller <> 'owner' then
    raise exception 'only the owner can manage admins';
  end if;
  update public.workspace_members set role = p_role where id = p_member;
end; $$;
grant execute on function public.set_member_role(uuid, text) to authenticated;

-- ---------- 5. remove a member (owner/admin, or self leaving) ----------
create or replace function public.remove_member(p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.workspace_members;
  caller text;
begin
  select * into m from public.workspace_members where id = p_member;
  if m is null then return; end if;
  caller := public.ws_role(m.workspace_id);
  if m.role = 'owner' then raise exception 'transfer ownership before removing the owner'; end if;
  -- allowed if you're managing (owner/admin) or removing yourself
  if not (caller in ('owner', 'admin') or m.user_id = auth.uid()) then raise exception 'not authorized'; end if;
  if m.role = 'admin' and caller <> 'owner' and m.user_id <> auth.uid() then
    raise exception 'only the owner can remove an admin';
  end if;
  delete from public.workspace_members where id = p_member;
end; $$;
grant execute on function public.remove_member(uuid) to authenticated;

-- ---------- 6. transfer ownership (owner only) ----------
create or replace function public.transfer_ownership(p_ws uuid, p_member uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  m public.workspace_members;
begin
  if public.ws_role(p_ws) <> 'owner' then raise exception 'only the owner can transfer ownership'; end if;
  select * into m from public.workspace_members where id = p_member and workspace_id = p_ws and status = 'active';
  if m is null or m.user_id is null then raise exception 'pick an active member to hand ownership to'; end if;
  update public.workspace_members set role = 'admin' where workspace_id = p_ws and role = 'owner';
  update public.workspace_members set role = 'owner' where id = p_member;
  update public.workspaces set owner_id = m.user_id where id = p_ws;
end; $$;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;
