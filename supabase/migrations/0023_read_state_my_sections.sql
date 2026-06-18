-- ============================================================
-- KANBO — per-item inbox read state + personal "My Tasks" sections.
-- Additive + idempotent. Paste & Run.
-- ============================================================

-- read state per activity row (null = unread)
alter table public.activity add column if not exists read_at timestamptz;

-- personal sections for My Tasks (separate from project sections, which use
-- tasks.section_id). Personal sections are stored in `sections` with
-- project_id = '__my'.
alter table public.tasks add column if not exists my_section_id text;
