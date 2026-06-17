-- ============================================================
-- KANBO — Asana-parity additions (all additive / idempotent).
--   tasks:    start_date, due_time, archived_at, is_milestone
--   projects: description, status
--   comments: reactions (emoji -> array of user ids who reacted)
-- Frontend tolerates these being absent until this runs.
-- ============================================================

alter table public.tasks add column if not exists start_date  date;
alter table public.tasks add column if not exists due_time     text;
alter table public.tasks add column if not exists archived_at  timestamptz;
alter table public.tasks add column if not exists is_milestone boolean not null default false;

alter table public.projects add column if not exists description text;
alter table public.projects add column if not exists status      text;

alter table public.comments add column if not exists reactions jsonb not null default '{}';
