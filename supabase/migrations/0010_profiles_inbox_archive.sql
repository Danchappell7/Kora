-- ============================================================
-- KORA — user profiles + inbox archiving
--   profiles: real identity (first/last name, pronouns, avatar) so
--     collaborators see people, not raw emails. Readable by any signed-in
--     user (names/avatars power assignees, comments, team); editable only
--     by the owner.
--   activity.archived_at: lets users clear reviewed inbox items without
--     destroying history (null = still in the inbox).
-- ============================================================

-- ---------- inbox archive ----------
alter table public.activity add column if not exists archived_at timestamptz;
create index if not exists activity_user_active_idx
  on public.activity (user_id, created_at desc) where archived_at is null;

-- ---------- profiles ----------
create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  first_name text not null default '',
  last_name  text not null default '',
  pronouns   text not null default '',
  email      text not null default '',
  avatar_url text,
  updated_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "read profiles"      on public.profiles;
drop policy if exists "insert own profile" on public.profiles;
drop policy if exists "update own profile" on public.profiles;

-- any authenticated user may read profiles (collaboration); write only your own
create policy "read profiles"      on public.profiles for select using (auth.uid() is not null);
create policy "insert own profile" on public.profiles for insert with check (id = auth.uid());
create policy "update own profile" on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

alter publication supabase_realtime add table public.profiles;

-- ---------- avatars storage bucket (public-read) ----------
insert into storage.buckets (id, name, public)
  values ('avatars', 'avatars', true)
  on conflict (id) do update set public = true;

drop policy if exists "avatar public read" on storage.objects;
drop policy if exists "avatar write own"   on storage.objects;
drop policy if exists "avatar update own"  on storage.objects;
drop policy if exists "avatar delete own"  on storage.objects;

-- files live under "<uid>/..." so the first path segment scopes ownership
create policy "avatar public read" on storage.objects
  for select using (bucket_id = 'avatars');
create policy "avatar write own" on storage.objects
  for insert with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatar update own" on storage.objects
  for update using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "avatar delete own" on storage.objects
  for delete using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
