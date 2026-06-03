-- ============================================================
-- KORA — enable real-time change streams for multi-tab / multi-device sync.
-- Adds the user-data tables to Supabase's realtime publication. RLS still
-- applies, so a client only receives changes to rows it's allowed to see.
-- ============================================================

alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.tags;
alter publication supabase_realtime add table public.subtasks;
