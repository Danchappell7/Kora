-- ============================================================
-- KANBO — Asana-style sub-tasks. A sub-task is just a normal task row
-- with parent_id pointing at its parent. Deleting a parent cascades to
-- its children. The frontend tolerates this column being absent (it just
-- treats every task as top-level until this runs).
--   Paste into the Supabase SQL editor and Run. Idempotent.
-- ============================================================

alter table public.tasks
  add column if not exists parent_id uuid references public.tasks (id) on delete cascade;

create index if not exists tasks_parent_idx on public.tasks (parent_id);
