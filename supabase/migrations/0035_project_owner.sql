-- ============================================================
-- KANBO — project owner + contributors (2026-06-20)
--   Every project has exactly one owner (defaults to its creator) plus a
--   list of contributors. owner_id is backfilled from the creator and made
--   NOT NULL so a project can never be ownerless. Idempotent.
-- ============================================================

alter table public.projects add column if not exists owner_id uuid references auth.users (id) on delete set null;
alter table public.projects add column if not exists contributor_ids uuid[] not null default '{}';

-- backfill existing projects: owner = original creator
update public.projects set owner_id = user_id where owner_id is null;

-- enforce: never ownerless (every row now has one from the backfill)
alter table public.projects alter column owner_id set not null;
