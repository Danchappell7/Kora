-- ============================================================
-- KANBO — manual board ordering.
--   A `position` float lets users drag-reorder cards within a board
--   column and have it stick. Fractional indexing: a card dropped between
--   two others gets the midpoint of their positions, so a single-row update
--   reorders without renumbering the column. Backfilled from created_at so
--   existing tasks keep their current (creation) order; new rows default to
--   "now", landing at the bottom of their column.
-- ============================================================

alter table public.tasks add column if not exists position double precision;

update public.tasks
   set position = extract(epoch from created_at)
 where position is null;

alter table public.tasks
  alter column position set default extract(epoch from now());

create index if not exists tasks_position_idx on public.tasks (position);
