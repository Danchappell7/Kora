-- ============================================================
-- KANBO — intake forms. A form is tied to a project; submitting it
-- creates a task in that project. Additive + idempotent.
-- RLS mirrors tasks/projects: own OR active member of the workspace.
-- (Public/unauthenticated submission would need an edge function — this
--  is the in-app version any signed-in teammate can use.)
-- ============================================================

create table if not exists public.forms (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  project_id   text not null,
  name         text not null,
  description  text,
  fields       jsonb not null default '[]'::jsonb,  -- ["description","priority","dueDate","assignee"]
  created_at   timestamptz not null default now()
);
create index if not exists forms_project_idx on public.forms (project_id);
alter table public.forms enable row level security;
drop policy if exists "own or workspace forms" on public.forms;
create policy "own or workspace forms" on public.forms
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));
