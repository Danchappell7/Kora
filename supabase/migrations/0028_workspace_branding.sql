-- ============================================================
-- KANBO — workspace branding (logo) + close/delete workspace (2026-06-20)
--   1. workspaces.logo_url — a branded logo per workspace.
--   2. update_workspace() — owner/admin set name + logo (guarded).
--   3. delete_workspace() — OWNER ONLY; removes the workspace. Every
--      workspace-scoped table already FKs workspaces with ON DELETE CASCADE,
--      so tasks/projects/sections/members/etc. are cleaned up automatically.
-- Logos reuse the existing public 'avatars' bucket (uploaded under the
-- uploader's uid folder), so no new bucket/policy is needed.
-- Idempotent.
-- ============================================================

alter table public.workspaces add column if not exists logo_url text;

-- owner/admin can rename + set the logo
create or replace function public.update_workspace(p_ws uuid, p_name text, p_logo text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.ws_role(p_ws) not in ('owner', 'admin')
     and not exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = auth.uid()) then
    raise exception 'not authorized';
  end if;
  update public.workspaces
     set name = coalesce(nullif(btrim(p_name), ''), name),
         logo_url = p_logo
   where id = p_ws;
end; $$;
grant execute on function public.update_workspace(uuid, text, text) to authenticated;

-- owner only: permanently close a workspace (cascades to all its data)
create or replace function public.delete_workspace(p_ws uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.workspaces w where w.id = p_ws and w.owner_id = auth.uid()) then
    raise exception 'only the owner can close a workspace';
  end if;
  delete from public.workspaces where id = p_ws;   -- cascades to members/projects/tasks/etc.
end; $$;
grant execute on function public.delete_workspace(uuid) to authenticated;
