-- ============================================================
-- KORA — file attachments on tasks (Supabase Storage + metadata).
-- The attachments table follows task visibility (own + shared
-- workspace). Files live in a private bucket; downloads use
-- short-lived signed URLs. Object paths embed a random uuid so
-- they aren't guessable.
-- ============================================================

create table if not exists public.attachments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  name       text not null,
  size       bigint not null default 0,
  mime       text not null default '',
  path       text not null,
  created_at timestamptz not null default now()
);
create index if not exists attachments_task_idx on public.attachments (task_id, created_at);

alter table public.attachments enable row level security;

create policy "attachments of visible tasks" on public.attachments
  for select using (exists (select 1 from public.tasks t where t.id = task_id));
create policy "attach as yourself" on public.attachments
  for insert with check (user_id = auth.uid() and exists (select 1 from public.tasks t where t.id = task_id));
create policy "delete own attachments" on public.attachments
  for delete using (user_id = auth.uid());

alter publication supabase_realtime add table public.attachments;

-- ---------- storage bucket + policies ----------
insert into storage.buckets (id, name, public)
values ('task-files', 'task-files', false)
on conflict (id) do nothing;

create policy "authenticated read task-files" on storage.objects
  for select to authenticated using (bucket_id = 'task-files');
create policy "authenticated upload task-files" on storage.objects
  for insert to authenticated with check (bucket_id = 'task-files');
create policy "owner delete task-files" on storage.objects
  for delete to authenticated using (bucket_id = 'task-files' and owner = auth.uid());
