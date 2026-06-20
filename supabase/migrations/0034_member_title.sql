-- ============================================================
-- KANBO — member job title / position (2026-06-20)
--   A free-text title per workspace member (e.g. "Co-founder", "Designer"),
--   separate from the permission role (owner/admin/member/guest).
--   Owners/admins can set anyone's title; a member can set their own.
--   Idempotent.
-- ============================================================

alter table public.workspace_members add column if not exists title text;

create or replace function public.set_member_title(p_member uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
declare m public.workspace_members; caller text;
begin
  select * into m from public.workspace_members where id = p_member;
  if m is null then raise exception 'member not found'; end if;
  caller := public.ws_role(m.workspace_id);
  if caller not in ('owner', 'admin') and m.user_id is distinct from auth.uid() then
    raise exception 'not authorized';
  end if;
  update public.workspace_members
     set title = nullif(btrim(p_title), '')
   where id = p_member;
end; $$;
grant execute on function public.set_member_title(uuid, text) to authenticated;
