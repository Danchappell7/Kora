-- ============================================================
-- KANBO — security hardening (2026-06-18)
--   1. task-files storage bucket: was readable/writable by ANY
--      authenticated user (cross-tenant file leak). Scope to the
--      owning user + collaborators who can see the attachment row.
--   2. profiles: was readable (incl. email) by EVERY signed-in user.
--      Scope to self + people who share an active workspace.
--   3. comments: add the missing (author-scoped) UPDATE policy so
--      comment edits/reactions stop silently failing — without
--      over-granting write access to other users' comments.
-- Idempotent: safe to run more than once.
-- ============================================================

-- ---------- 1. task-files storage bucket ----------
-- Object paths are "<uid>/<taskId>/<random>_<file>", so the first
-- path segment identifies the owner (same scheme as the avatars bucket).
drop policy if exists "authenticated read task-files"  on storage.objects;
drop policy if exists "authenticated upload task-files" on storage.objects;
drop policy if exists "read own task-files"            on storage.objects;
drop policy if exists "read shared task-files"         on storage.objects;
drop policy if exists "upload own task-files"          on storage.objects;

-- read files you uploaded...
create policy "read own task-files" on storage.objects
  for select to authenticated
  using (bucket_id = 'task-files' and (storage.foldername(name))[1] = auth.uid()::text);

-- ...plus files attached to a task you're allowed to see. The attachments
-- table's own RLS already limits visible rows to your own + shared-workspace
-- tasks, so this correlated EXISTS inherits that scoping for free.
create policy "read shared task-files" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'task-files'
    and exists (select 1 from public.attachments a where a.path = storage.objects.name)
  );

-- you may only upload into your own "<uid>/..." folder
create policy "upload own task-files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'task-files' and (storage.foldername(name))[1] = auth.uid()::text);
-- (existing "owner delete task-files" policy from 0008 is already correct)

-- ---------- 2. profiles: self + co-members only ----------
-- SECURITY DEFINER helper avoids RLS recursion on workspace_members
-- (same pattern as is_member() in 0007).
create or replace function public.shares_workspace(other uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1
    from public.workspace_members m1
    join public.workspace_members m2 on m1.workspace_id = m2.workspace_id
    where m1.user_id = auth.uid() and m1.status = 'active'
      and m2.user_id = other     and m2.status = 'active'
  );
$$;

drop policy if exists "read profiles" on public.profiles;
create policy "read profiles" on public.profiles
  for select using (id = auth.uid() or public.shares_workspace(id));

-- ---------- 3. comments: missing UPDATE policy (author-scoped) ----------
drop policy if exists "update own comments" on public.comments;
create policy "update own comments" on public.comments
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
