-- ============================================================
-- KANBO — team workspaces + invites + shared visibility, and
-- recurring tasks.
--
-- Model:
--  - workspaces: owned by a user.
--  - workspace_members: one row per member; invites are rows with
--    status 'invited' keyed by email, claimed on first sign-in.
--  - tasks/projects gain workspace_id (null = personal).
--  - RLS: you can see/edit your own rows OR anything in a workspace
--    you're an active member of. Subtasks/dependencies/comments
--    inherit visibility from their parent task.
-- ============================================================

-- ---------- recurring tasks ----------
alter table public.tasks add column if not exists recurrence text not null default 'none'
  check (recurrence in ('none','daily','weekly','monthly'));

-- ---------- workspaces ----------
create table if not exists public.workspaces (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  owner_id   uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid references auth.users (id) on delete cascade,
  email        text not null,
  name         text not null default '',
  role         text not null default 'member' check (role in ('owner','member')),
  status       text not null default 'invited' check (status in ('invited','active')),
  created_at   timestamptz not null default now(),
  unique (workspace_id, email)
);
create index if not exists ws_members_ws_idx on public.workspace_members (workspace_id);
create index if not exists ws_members_user_idx on public.workspace_members (user_id);

-- membership check; SECURITY DEFINER so policies can use it without RLS recursion
create or replace function public.is_member(ws uuid)
returns boolean
language sql security definer stable
set search_path = public
as $$
  select exists (
    select 1 from workspace_members m
    where m.workspace_id = ws and m.status = 'active' and m.user_id = auth.uid()
  );
$$;

-- claim pending invites for the signed-in user's email (called on app load)
create or replace function public.claim_invites()
returns integer
language plpgsql security definer
set search_path = public
as $$
declare n integer;
begin
  update workspace_members
     set user_id = auth.uid(), status = 'active'
   where status = 'invited'
     and user_id is null
     and lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''));
  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------- workspace columns on user data ----------
alter table public.tasks add column if not exists workspace_id uuid references public.workspaces (id) on delete cascade;
create index if not exists tasks_workspace_idx on public.tasks (workspace_id);

-- projects.workspace_id was text; sanitize then convert to uuid
update public.projects set workspace_id = null
  where workspace_id is not null
    and workspace_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
alter table public.projects
  alter column workspace_id type uuid using nullif(workspace_id, '')::uuid;
alter table public.projects
  add constraint projects_workspace_fk foreign key (workspace_id) references public.workspaces (id) on delete cascade;

-- ---------- RLS ----------
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;

create policy "see own or member workspaces" on public.workspaces
  for select using (owner_id = auth.uid() or public.is_member(id));
create policy "create own workspaces" on public.workspaces
  for insert with check (owner_id = auth.uid());
create policy "owner manages workspace" on public.workspaces
  for update using (owner_id = auth.uid());
create policy "owner deletes workspace" on public.workspaces
  for delete using (owner_id = auth.uid());

create policy "see members of my workspaces" on public.workspace_members
  for select using (
    public.is_member(workspace_id)
    or user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );
create policy "owner invites members" on public.workspace_members
  for insert with check (
    exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );
create policy "owner or self updates membership" on public.workspace_members
  for update using (
    user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email', ''))
    or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );
create policy "owner or self removes membership" on public.workspace_members
  for delete using (
    user_id = auth.uid()
    or exists (select 1 from public.workspaces w where w.id = workspace_id and w.owner_id = auth.uid())
  );

-- tasks/projects: own OR member-of-workspace
drop policy if exists "own tasks" on public.tasks;
create policy "own or workspace tasks" on public.tasks
  for all using (
    user_id = auth.uid()
    or (workspace_id is not null and public.is_member(workspace_id))
  ) with check (
    user_id = auth.uid()
    or (workspace_id is not null and public.is_member(workspace_id))
  );

drop policy if exists "own projects" on public.projects;
create policy "own or workspace projects" on public.projects
  for all using (
    user_id = auth.uid()
    or (workspace_id is not null and public.is_member(workspace_id))
  ) with check (
    user_id = auth.uid()
    or (workspace_id is not null and public.is_member(workspace_id))
  );

-- children inherit parent-task visibility (subquery respects tasks RLS)
drop policy if exists "own subtasks" on public.subtasks;
create policy "subtasks of visible tasks" on public.subtasks
  for all using (exists (select 1 from public.tasks t where t.id = task_id))
  with check (exists (select 1 from public.tasks t where t.id = task_id));

drop policy if exists "own dependencies" on public.task_dependencies;
create policy "dependencies of visible tasks" on public.task_dependencies
  for all using (exists (select 1 from public.tasks t where t.id = task_id))
  with check (exists (select 1 from public.tasks t where t.id = task_id));

drop policy if exists "own comments" on public.comments;
create policy "comments on visible tasks" on public.comments
  for select using (exists (select 1 from public.tasks t where t.id = task_id));
create policy "comment as yourself" on public.comments
  for insert with check (user_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id));
create policy "delete own comments" on public.comments
  for delete using (user_id = auth.uid());

-- realtime
alter publication supabase_realtime add table public.workspaces;
alter publication supabase_realtime add table public.workspace_members;
