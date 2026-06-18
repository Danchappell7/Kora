-- ============================================================
-- KANBO — time tracking + goal nesting/linking. Additive + idempotent.
-- ============================================================

-- actual time logged on a task (estimate already lives in effort_hours)
alter table public.tasks add column if not exists logged_hours numeric;

-- goal nesting (sub-goals) + optional link to a project for auto-progress
alter table public.goals add column if not exists parent_id  uuid references public.goals (id) on delete set null;
alter table public.goals add column if not exists project_id text;
