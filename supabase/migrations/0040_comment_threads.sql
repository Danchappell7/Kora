-- ============================================================
-- KANBO — threaded comment replies (2026-07-01)
--   Adds comments.parent_id so a comment can reply to another. One
--   level deep (replies attach to a top-level comment). ON DELETE
--   CASCADE removes a thread's replies when the parent is deleted.
-- Idempotent.
-- ============================================================
alter table public.comments
  add column if not exists parent_id uuid references public.comments (id) on delete cascade;

create index if not exists comments_parent_idx on public.comments (parent_id);
