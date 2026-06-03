-- ============================================================
-- KORA — user-created tags.
-- Built-in starter tags (Design, Engineering, …) live in the app
-- as reference data; this table holds custom tags a user adds.
-- tasks.tags is text[] holding tag keys (built-in slugs or row ids).
-- ============================================================

create table if not exists public.tags (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  label      text not null,
  color      text not null default 'oklch(0.74 0.14 230)',
  created_at timestamptz not null default now()
);
create index if not exists tags_user_id_idx on public.tags (user_id);

alter table public.tags enable row level security;

create policy "own tags" on public.tags
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
