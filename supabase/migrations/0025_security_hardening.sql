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

-- ---------- 4. comment reactions RPC (any viewer toggles their OWN reaction) ----------
-- The author-only UPDATE policy above means teammates couldn't react. This
-- SECURITY DEFINER function lets anyone who can SEE the comment add/remove only
-- their own uid in the reactions map — without opening up write access to the
-- comment itself.
create or replace function public.toggle_comment_reaction(p_comment uuid, p_emoji text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_react jsonb;
  v_list  jsonb;
begin
  if v_uid is null then raise exception 'not authenticated'; end if;

  -- caller must be allowed to see the comment (own task or shared workspace)
  if not exists (
    select 1 from public.comments c
    join public.tasks t on t.id = c.task_id
    where c.id = p_comment
      and (t.user_id = v_uid
           or (t.workspace_id is not null and public.is_member(t.workspace_id)))
  ) then
    raise exception 'not authorized';
  end if;

  select coalesce(reactions, '{}'::jsonb) into v_react from public.comments where id = p_comment;
  v_list := coalesce(v_react -> p_emoji, '[]'::jsonb);

  if v_list ? v_uid::text then
    v_list := (select coalesce(jsonb_agg(x), '[]'::jsonb)
               from jsonb_array_elements_text(v_list) x where x <> v_uid::text);
  else
    v_list := v_list || to_jsonb(v_uid::text);
  end if;

  if jsonb_array_length(v_list) = 0 then
    v_react := v_react - p_emoji;
  else
    v_react := jsonb_set(v_react, array[p_emoji], v_list, true);
  end if;

  update public.comments set reactions = v_react where id = p_comment;
  return v_react;
end;
$$;

grant execute on function public.toggle_comment_reaction(uuid, text) to authenticated;
