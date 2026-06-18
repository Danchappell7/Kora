-- ============================================================
-- KANBO — manager / reporting layer: goals (OKRs), portfolios, and
-- project status updates. Additive + idempotent. Paste & Run.
-- RLS mirrors tasks/projects: own OR active member of the workspace.
-- ============================================================

-- ---------- goals / OKRs ----------
create table if not exists public.goals (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  name         text not null,
  description  text,
  target       numeric,
  current      numeric,
  unit         text,
  due          date,
  status       text not null default 'on_track',  -- on_track | at_risk | off_track | done
  position     double precision,
  created_at   timestamptz not null default now()
);
alter table public.goals enable row level security;
drop policy if exists "own or workspace goals" on public.goals;
create policy "own or workspace goals" on public.goals
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));

-- ---------- portfolios ----------
create table if not exists public.portfolios (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  name         text not null,
  project_ids  text[] not null default '{}',
  created_at   timestamptz not null default now()
);
alter table public.portfolios enable row level security;
drop policy if exists "own or workspace portfolios" on public.portfolios;
create policy "own or workspace portfolios" on public.portfolios
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));

-- ---------- project status updates ----------
create table if not exists public.status_updates (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  project_id   text not null,
  summary      text not null,
  status       text not null default 'on_track',  -- on_track | at_risk | off_track
  created_at   timestamptz not null default now()
);
create index if not exists status_updates_project_idx on public.status_updates (project_id, created_at desc);
alter table public.status_updates enable row level security;
drop policy if exists "own or workspace status" on public.status_updates;
create policy "own or workspace status" on public.status_updates
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));
