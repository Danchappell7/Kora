-- ============================================================
-- KANBO — per-task change history (2026-06-22)
--   A task_events audit log written by a trigger whenever a task's status,
--   assignee, due date or priority changes. Readable by anyone who can see
--   the task (own or workspace member). Rows are written server-side only
--   (SECURITY DEFINER trigger), so clients can't forge history. Idempotent.
-- ============================================================

create table if not exists public.task_events (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  actor_id   uuid references auth.users (id) on delete set null,
  actor_name text,
  field      text not null,
  old_value  text,
  new_value  text,
  created_at timestamptz not null default now()
);
create index if not exists task_events_task_idx on public.task_events (task_id, created_at desc);

alter table public.task_events enable row level security;
drop policy if exists "read task events" on public.task_events;
create policy "read task events" on public.task_events for select using (
  exists (select 1 from public.tasks t where t.id = task_id
          and (t.user_id = auth.uid() or (t.workspace_id is not null and public.is_member(t.workspace_id))))
);
grant select on public.task_events to authenticated;

create or replace function public.log_task_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); aname text;
begin
  if actor is null then return NEW; end if;  -- ignore service writes
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into aname from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  if NEW.status is distinct from OLD.status then
    insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value) values (NEW.id, actor, aname, 'status', OLD.status, NEW.status);
  end if;
  if NEW.assignee_id is distinct from OLD.assignee_id then
    insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value) values (NEW.id, actor, aname, 'assignee', OLD.assignee_id, NEW.assignee_id);
  end if;
  if NEW.due_date is distinct from OLD.due_date then
    insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value) values (NEW.id, actor, aname, 'due', OLD.due_date::text, NEW.due_date::text);
  end if;
  if NEW.priority is distinct from OLD.priority then
    insert into public.task_events (task_id, actor_id, actor_name, field, old_value, new_value) values (NEW.id, actor, aname, 'priority', OLD.priority, NEW.priority);
  end if;
  return NEW;
end; $$;

drop trigger if exists trg_task_event on public.tasks;
create trigger trg_task_event after update on public.tasks for each row execute function public.log_task_event();
