-- ============================================================
-- KANBO — soft-archive projects (2026-06-22)
--   projects.archived_at: when set, the project is hidden from the sidebar
--   and pickers but kept (with all its tasks) and restorable. Idempotent.
-- ============================================================

alter table public.projects add column if not exists archived_at timestamptz;
create index if not exists projects_archived_idx on public.projects (archived_at);
