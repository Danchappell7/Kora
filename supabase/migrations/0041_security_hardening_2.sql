-- ============================================================
-- KANBO — security hardening 2 (2026-09-29, pre business rollout)
-- Closes the holes found in the rollout audit, each reproduced against a
-- replay of the live schema before fixing (see the attack suite):
--   1. profiles: users could set their own is_admin / approved / suspended
--      (become platform admin, self-approve, un-suspend); profile email was
--      client-controlled and drove auto-approval; no profile row at signup
--      meant no approval gate.
--   2. role checks: ws_role() returned NULL for non-members, and every
--      `caller not in (...)` / `<> 'owner'` guard treats NULL as "allowed" —
--      outsiders could invite themselves as admin, take ownership, rename,
--      remove members. Re-inviting an active member silently changed their
--      role (demote the owner).
--   3. membership: members could UPDATE their own membership row (promote to
--      owner, move into another workspace); owners could insert anyone as an
--      active member without an invite.
--   4. content (tasks, projects, sections, custom fields, goals, portfolios,
--      status updates, automations, forms): "creator OR member" meant removed
--      members kept their work and anyone could plant rows in any workspace;
--      suspension wasn't enforced by the API; guests had full write access;
--      any member could hard-delete any team project.
--   5. comments: deleting a comment cascaded away teammates' replies; author
--      name was client-supplied (spoofable).
--   6. account deletion cascaded away the person's team work and any
--      workspace they owned (or failed outright for project owners).
--   7. seed_demo_data(uid) was callable by anyone for any uid.
-- Also adds approved_domains: anyone signing up with a company email domain
-- on that list is auto-approved (frictionless internal rollout).
-- Idempotent — safe to re-run.
-- ============================================================

-- ---------- 0. helpers ----------
-- can the caller act at all? (not suspended, approved). No profile row = yes,
-- so nobody without a row is locked out; new signups always get a row below.
create or replace function public.can_act() returns boolean
language sql security definer stable set search_path = public as $$
  select not exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and (coalesce(p.suspended, false) or not coalesce(p.approved, true))
  );
$$;

-- active member (or the workspace's owner) AND allowed to act
create or replace function public.is_member(ws uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select public.can_act() and (
    exists (select 1 from public.workspace_members m
            where m.workspace_id = ws and m.status = 'active' and m.user_id = auth.uid())
    or exists (select 1 from public.workspaces w where w.id = ws and w.owner_id = auth.uid())
  );
$$;

-- caller's role; 'none' (never NULL) for non-members / suspended, so every
-- `not in (...)` / `<> 'owner'` guard fails closed.
create or replace function public.ws_role(ws uuid) returns text
language sql security definer stable set search_path = public as $$
  select case when not public.can_act() then 'none' else coalesce(
    (select m.role from public.workspace_members m
      where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active' limit 1),
    (select 'owner' from public.workspaces w where w.id = ws and w.owner_id = auth.uid()),
    'none') end;
$$;

-- may write content (guests are read-only; they can still comment)
create or replace function public.can_write(ws uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select public.ws_role(ws) in ('owner', 'admin', 'member');
$$;

grant execute on function public.can_act() to authenticated;
grant execute on function public.is_member(uuid) to authenticated;
grant execute on function public.ws_role(uuid) to authenticated;
grant execute on function public.can_write(uuid) to authenticated;

-- ---------- 1. profiles: privileged columns, trusted email, row at signup ----------
create table if not exists public.approved_domains (
  domain     text primary key check (domain = lower(domain) and domain !~ '@'),
  added_by   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
alter table public.approved_domains enable row level security;
drop policy if exists "admins manage approved domains" on public.approved_domains;
create policy "admins manage approved domains" on public.approved_domains
  for all using (public.is_admin()) with check (public.is_admin());

create or replace function public.protect_profile_privileges() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  real_email text := (select email from auth.users where id = new.id);
begin
  -- server-side callers (service role, signup trigger, SQL editor) and
  -- platform admins may set anything
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') or public.is_admin() then
    return new;
  end if;
  new.email := coalesce(real_email, new.email);          -- email can't be spoofed
  if tg_op = 'INSERT' then
    new.is_admin := false; new.suspended := false; new.approved := false;  -- auto-approve (runs next) decides
  else
    new.is_admin := old.is_admin; new.suspended := old.suspended; new.approved := old.approved;
  end if;
  return new;
end; $$;
-- named to sort BEFORE trg_profile_auto_approve (same-event triggers fire alphabetically)
drop trigger if exists trg_0_protect_profile_privileges on public.profiles;
create trigger trg_0_protect_profile_privileges before insert or update on public.profiles
  for each row execute function public.protect_profile_privileges();

-- auto-approve: founding admin, an approved access request, or an approved
-- company domain — always judged on the REAL account email
create or replace function public.profile_auto_approve() returns trigger
language plpgsql security definer set search_path = public as $$
declare e text := lower(coalesce((select email from auth.users where id = new.id), new.email, ''));
begin
  if e = 'danchappell7@gmail.com'
     or exists (select 1 from public.access_requests r where lower(r.email) = e and r.status = 'approved')
     or exists (select 1 from public.approved_domains d where d.domain = split_part(e, '@', 2)) then
    new.approved := true;
  end if;
  return new;
end; $$;

-- every new account gets a profile row, so the approval gate always applies
create or replace function public.ensure_profile_for_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email) on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile after insert on auth.users
  for each row execute function public.ensure_profile_for_new_user();

-- backfill rows for existing accounts that never saved a profile. They were
-- never gated before, so they keep access (approved) — nobody is locked out.
insert into public.profiles (id, email, approved)
select u.id, u.email, true from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id)
on conflict (id) do nothing;

-- ---------- 2. role-guarded RPCs: fail closed ----------
create or replace function public.invite_member(p_ws uuid, p_email text, p_name text default '', p_role text default 'member')
returns public.workspace_members
language plpgsql security definer set search_path = public as $$
declare
  caller text := public.ws_role(p_ws);
  e text := lower(btrim(p_email));
  existing public.workspace_members;
  row public.workspace_members;
begin
  if caller not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  if p_role not in ('admin', 'member', 'guest') then raise exception 'invalid role'; end if;
  if p_role = 'admin' and caller <> 'owner' then raise exception 'only the owner can add admins'; end if;
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'invalid email'; end if;
  select * into existing from public.workspace_members where workspace_id = p_ws and lower(email) = e;
  if existing.id is not null and existing.status = 'active' then
    raise exception 'already a member — change their role from the team list';
  end if;
  insert into public.workspace_members (workspace_id, email, name, role, status)
  values (p_ws, e, coalesce(p_name, ''), p_role, 'invited')
  on conflict (workspace_id, email) do update set role = excluded.role, name = excluded.name
    where public.workspace_members.status = 'invited'
  returning * into row;
  return row;
end; $$;

create or replace function public.set_member_title(p_member uuid, p_title text)
returns void language plpgsql security definer set search_path = public as $$
declare m public.workspace_members; caller text;
begin
  select * into m from public.workspace_members where id = p_member;
  if m.id is null then raise exception 'member not found'; end if;
  caller := public.ws_role(m.workspace_id);
  if caller not in ('owner', 'admin') and m.user_id is distinct from auth.uid() then
    raise exception 'not authorized';
  end if;
  if caller = 'none' then raise exception 'not authorized'; end if;
  update public.workspace_members set title = nullif(btrim(p_title), '') where id = p_member;
end; $$;

create or replace function public.update_workspace(p_ws uuid, p_name text, p_logo text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.ws_role(p_ws) not in ('owner', 'admin') then raise exception 'not authorized'; end if;
  update public.workspaces
     set name = coalesce(nullif(btrim(p_name), ''), name), logo_url = p_logo
   where id = p_ws;
end; $$;
-- (set_member_role / remove_member / transfer_ownership keep their 0027 bodies:
--  with ws_role() now returning 'none' instead of NULL their guards fail closed.)

-- ---------- 3. membership rows: only through the guarded RPCs ----------
drop policy if exists "owner or self updates membership" on public.workspace_members;
drop policy if exists "owner invites members" on public.workspace_members;
drop policy if exists "owner adds own membership" on public.workspace_members;
create policy "owner adds own membership" on public.workspace_members
  for insert with check (
    user_id = auth.uid() and role = 'owner'
    and exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );
drop policy if exists "owner or self removes membership" on public.workspace_members;
drop policy if exists "leave a workspace" on public.workspace_members;
create policy "leave a workspace" on public.workspace_members
  for delete using (user_id = auth.uid() and role <> 'owner');

-- ---------- 4. content: personal = creator only; team = current members ----------
do $content$
declare
  t text;
  pol record;
  personal text := '(workspace_id is null and user_id = auth.uid() and public.can_act())';
begin
  foreach t in array array['tasks','projects','sections','custom_field_defs','goals','portfolios','status_updates','automation_rules','forms'] loop
    for pol in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', pol.policyname, t);
    end loop;
    execute format('create policy "read: personal or member" on public.%I for select using (%s or (workspace_id is not null and public.is_member(workspace_id)))', t, personal);
    execute format('create policy "create: personal or writer" on public.%I for insert with check (%s or (workspace_id is not null and user_id = auth.uid() and public.can_write(workspace_id)))', t, personal);
    execute format('create policy "edit: personal or writer" on public.%I for update using (%s or (workspace_id is not null and public.can_write(workspace_id))) with check (%s or (workspace_id is not null and public.can_write(workspace_id)))', t, personal, personal);
    if t = 'projects' then
      -- a team project can only be deleted by its creator, its owner, or a workspace owner/admin
      execute format('create policy "delete: personal, creator, owner or admin" on public.%I for delete using (%s or (workspace_id is not null and public.can_write(workspace_id) and (user_id = auth.uid() or owner_id = auth.uid() or public.ws_role(workspace_id) in (''owner'',''admin''))))', t, personal);
    else
      execute format('create policy "delete: personal or writer" on public.%I for delete using (%s or (workspace_id is not null and public.can_write(workspace_id)))', t, personal);
    end if;
  end loop;
end $content$;

-- ---------- 5. comments: keep replies, trusted author name ----------
alter table public.comments add column if not exists parent_id uuid;
alter table public.comments drop constraint if exists comments_parent_id_fkey;
alter table public.comments add constraint comments_parent_id_fkey
  foreign key (parent_id) references public.comments (id) on delete set null;
create index if not exists comments_parent_idx on public.comments (parent_id);

create or replace function public.comment_author_from_profile() returns trigger
language plpgsql security definer set search_path = public as $$
declare n text;
begin
  if coalesce(auth.role(), '') not in ('authenticated', 'anon') then return new; end if;
  select nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '')
    into n from public.profiles p where p.id = auth.uid();
  new.author_name := coalesce(n, (select email from auth.users where id = auth.uid()), 'Someone');
  if tg_op = 'UPDATE' then new.user_id := old.user_id; new.task_id := old.task_id; end if;
  return new;
end; $$;
drop trigger if exists trg_comment_author on public.comments;
create trigger trg_comment_author before insert or update on public.comments
  for each row execute function public.comment_author_from_profile();

-- a departed teammate's comments stay (shown by name) instead of vanishing
alter table public.comments alter column user_id drop not null;
alter table public.comments drop constraint if exists comments_user_id_fkey;
alter table public.comments add constraint comments_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

-- ---------- 6. account deletion keeps the team's work ----------
-- projects.owner_id was ON DELETE SET NULL *and* NOT NULL, so deleting any
-- project owner failed; ownership is now handed over below before deletion.
alter table public.projects drop constraint if exists projects_owner_id_fkey;
alter table public.projects add constraint projects_owner_id_fkey
  foreign key (owner_id) references auth.users (id) on delete cascade;

create or replace function public.before_user_delete() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  w record;
  heir uuid;
  t text;
begin
  -- hand each team workspace the person owns to its next admin/member
  for w in select id from public.workspaces where owner_id = old.id loop
    select m.user_id into heir from public.workspace_members m
     where m.workspace_id = w.id and m.status = 'active' and m.user_id is not null and m.user_id <> old.id
     order by case m.role when 'admin' then 0 when 'member' then 1 else 2 end, m.created_at
     limit 1;
    if heir is not null then
      update public.workspaces set owner_id = heir where id = w.id;
      update public.workspace_members set role = 'owner' where workspace_id = w.id and user_id = heir;
    end if;   -- nobody else in it: it's effectively personal and goes with them
  end loop;
  -- re-attribute their work in surviving team workspaces to that workspace's owner
  foreach t in array array['tasks','projects','sections','custom_field_defs','goals','portfolios','status_updates','automation_rules','forms'] loop
    execute format('update public.%I x set user_id = ws.owner_id from public.workspaces ws where x.workspace_id = ws.id and x.user_id = $1 and ws.owner_id <> $1', t) using old.id;
  end loop;
  update public.projects p set owner_id = ws.owner_id from public.workspaces ws
   where p.workspace_id = ws.id and p.owner_id = old.id and ws.owner_id <> old.id;
  update public.projects set owner_id = user_id where owner_id = old.id and user_id <> old.id;
  update public.attachments a set user_id = t2.user_id from public.tasks t2
   where a.task_id = t2.id and a.user_id = old.id and t2.user_id <> old.id;
  update public.comments set user_id = null where user_id = old.id;
  return old;
end; $$;
drop trigger if exists trg_before_user_delete on auth.users;
create trigger trg_before_user_delete before delete on auth.users
  for each row execute function public.before_user_delete();

-- ---------- 7. internal helpers are not public endpoints ----------
do $$ begin
  revoke execute on function public.seed_demo_data(uuid) from public, anon, authenticated;
exception when undefined_function then null; end $$;
revoke execute on function public.before_user_delete() from public, anon, authenticated;
revoke execute on function public.ensure_profile_for_new_user() from public, anon, authenticated;
