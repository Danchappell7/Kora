-- ============================================================
-- KANBO — in-app automation rules. When a task is created in a project,
-- enabled rules apply their actions (set priority/assignee/section, add
-- tag). Runs client-side at task-creation time. Additive + idempotent.
-- RLS mirrors tasks/projects: own OR active member of the workspace.
-- ============================================================

create table if not exists public.automation_rules (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users (id) on delete cascade,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  project_id   text not null,
  name         text not null,
  trigger      text not null default 'task_created',
  actions      jsonb not null default '[]'::jsonb,   -- [{ type, value }]
  enabled      boolean not null default true,
  created_at   timestamptz not null default now()
);
create index if not exists automation_rules_project_idx on public.automation_rules (project_id);
alter table public.automation_rules enable row level security;
drop policy if exists "own or workspace rules" on public.automation_rules;
create policy "own or workspace rules" on public.automation_rules
  for all using      (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)))
          with check (user_id = auth.uid() or (workspace_id is not null and public.is_member(workspace_id)));
