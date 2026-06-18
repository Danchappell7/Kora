-- ============================================================
-- KANBO — Asana-parity wave. All additive + idempotent. Paste into the
-- Supabase SQL editor and Run. Adds:
--   tasks:  reactions, followers, collaborators (multi-assignee),
--           section_id, custom (field values), effort_hours (workload)
--   tables: sections, custom_field_defs, saved_searches
-- RLS mirrors tasks/projects: own OR active member of the workspace.
-- ============================================================

-- ---------- task-level additions ----------
alter table public.tasks add column if not exists reactions     jsonb  not null default '{}'::jsonb;
alter table public.tasks add column if not exists followers      text[] not null default '{}';
alter table public.tasks add column if not exists collaborators  text[] not null default '{}';
alter table public.tasks add column if not exists section_id     text;
alter table public.tasks add column if not exists custom         jsonb  not null default '{}'::jsonb;
alter table public.tasks add column if not exists effort_hours   numeric;

-- ---------- sections: ordered groupings within a project ----------
create table if not exists public.sections (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  project_id   text not null,
  name         text not null,
  position     double precision,
  created_at   timestamptz not null default now()
);
create index if not exists sections_project_idx on public.sections (project_id);
alter table public.sections enable row level security;
drop policy if exists "own or workspace sections" on public.sections;
create policy "own or workspace sections" on public.sections
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));

-- ---------- custom field definitions (per project) ----------
create table if not exists public.custom_field_defs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  project_id   text not null,
  name         text not null,
  type         text not null,                      -- text | number | dropdown | date | people | checkbox
  options      jsonb not null default '[]'::jsonb, -- choices for dropdown
  position     double precision,
  created_at   timestamptz not null default now()
);
create index if not exists cfd_project_idx on public.custom_field_defs (project_id);
alter table public.custom_field_defs enable row level security;
drop policy if exists "own or workspace cfd" on public.custom_field_defs;
create policy "own or workspace cfd" on public.custom_field_defs
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));

-- ---------- saved searches (per user) ----------
create table if not exists public.saved_searches (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  query      jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.saved_searches enable row level security;
drop policy if exists "own saved searches" on public.saved_searches;
create policy "own saved searches" on public.saved_searches
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
