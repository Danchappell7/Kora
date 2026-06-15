-- ============================================================
-- KORA — run migrations 0005 through 0009 (in order).
-- Paste this whole file into a new Supabase SQL query and Run.
-- ============================================================


-- ===== supabase/migrations/0005_realtime.sql =====
-- ============================================================
-- KORA — enable real-time change streams for multi-tab / multi-device sync.
-- Adds the user-data tables to Supabase's realtime publication. RLS still
-- applies, so a client only receives changes to rows it's allowed to see.
-- ============================================================

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.tags;
alter publication supabase_realtime add table public.subtasks;


-- ===== supabase/migrations/0006_comments_activity.sql =====
-- ============================================================
-- KORA — real comment threads + activity feed (powers the Inbox).
-- comments: threaded discussion per task.
-- activity: event log (created / status / completed / comment / deleted).
--   task_id has NO foreign key on purpose — activity entries survive
--   task deletion; task_title is snapshotted for display.
-- ============================================================

create table if not exists public.comments (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  author_name text not null default '',
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists comments_task_id_idx on public.comments (task_id, created_at);

create table if not exists public.activity (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  task_id    uuid,
  task_title text not null default '',
  kind       text not null,
  detail     text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists activity_user_created_idx on public.activity (user_id, created_at desc);

alter table public.comments enable row level security;
alter table public.activity enable row level security;

create policy "own comments" on public.comments
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "own activity" on public.activity
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.comments;
alter publication supabase_realtime add table public.activity;


-- ===== supabase/migrations/0007_teams_recurrence.sql =====
-- ============================================================
-- KORA — team workspaces + invites + shared visibility, and
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


-- ===== supabase/migrations/0008_attachments.sql =====
-- ============================================================
-- KORA — file attachments on tasks (Supabase Storage + metadata).
-- The attachments table follows task visibility (own + shared
-- workspace). Files live in a private bucket; downloads use
-- short-lived signed URLs. Object paths embed a random uuid so
-- they aren't guessable.
-- ============================================================

create table if not exists public.attachments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  size       bigint not null default 0,
  mime       text not null default '',
  path       text not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_task_idx on public.attachments (task_id, created_at);

alter table public.attachments enable row level security;

create policy "attachments of visible tasks" on public.attachments
  for select using (exists (select 1 from public.tasks t where t.id = task_id));
create policy "attach as yourself" on public.attachments
  for insert with check (user_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id));
create policy "delete own attachments" on public.attachments
  for delete using (user_id = auth.uid());

alter publication supabase_realtime add table public.attachments;

-- ---------- storage bucket + policies ----------
insert into storage.buckets (id, name, public)
values ('task-files', 'task-files', false)
on conflict (id) do nothing;

create policy "authenticated read task-files" on storage.objects
  for select to authenticated using (bucket_id = 'task-files');
create policy "authenticated upload task-files" on storage.objects
  for insert to authenticated with check (bucket_id = 'task-files');
create policy "owner delete task-files" on storage.objects
  for delete to authenticated using (bucket_id = 'task-files' and owner = auth.uid());


-- ===== supabase/migrations/0009_billing.sql =====
-- ============================================================
-- KORA — subscriptions: 7-day free trial, then paid Personal/Team.
-- One row per user. The trial starts the first time the app calls
-- ensure_subscription(). Only the Stripe webhook (service role)
-- changes plan/status; users can read their own row.
-- ============================================================

create table if not exists public.subscriptions (
  user_id                uuid primary key references auth.users (id) on delete cascade,
  plan                   text check (plan in ('personal','team')),
  status                 text not null default 'trialing'
                           check (status in ('trialing','active','past_due','canceled')),
  trial_ends_at          timestamptz not null default (now() + interval '7 days'),
  stripe_customer_id     text,
  stripe_subscription_id text,
  current_period_end     timestamptz,
  seats                  integer not null default 1,
  updated_at             timestamptz not null default now()
);

alter table public.subscriptions enable row level security;

create policy "see own subscription" on public.subscriptions
  for select using (user_id = auth.uid());

-- create-if-missing; returns the caller's subscription (starts the trial)
create or replace function public.ensure_subscription()
returns public.subscriptions
language plpgsql security definer
set search_path = public
as $$
declare s public.subscriptions;
begin
  select * into s from subscriptions where user_id = auth.uid();
  if not found then
    insert into subscriptions (user_id) values (auth.uid()) returning * into s;
  end if;
  return s;
end;
$$;

alter publication supabase_realtime add table public.subscriptions;

