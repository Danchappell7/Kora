-- ============================================================
-- KANBO — real comment threads + activity feed (powers the Inbox).
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
