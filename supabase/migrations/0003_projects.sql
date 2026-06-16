-- ============================================================
-- KANBO — user-created projects.
-- The built-in "Personal" project lives in the app as reference
-- data (id 'p-personal'); this table holds any extra projects a
-- user creates. tasks.project_id is free text, so it references
-- either 'p-personal' or a row id here.
-- ============================================================

create table if not exists public.projects (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  name         text not null,
  emoji        text default '📁',
  color        text default 'oklch(0.74 0.14 230)',
  workspace_id text,
  created_at   timestamptz not null default now()
);
create index if not exists projects_user_id_idx on public.projects (user_id);

alter table public.projects enable row level security;

create policy "own projects" on public.projects
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
