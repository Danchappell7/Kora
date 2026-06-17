-- ============================================================
-- KANBO — notify a user when someone ELSE assigns them a task.
--   Activity rows are per-recipient and RLS-locked to user_id = auth.uid(),
--   so a client can't write into another user's feed. This SECURITY DEFINER
--   trigger does it server-side: on assignment (insert or reassign) it drops
--   an 'assigned' activity into the assignee's inbox, stamped with the
--   actor's display name. Self-assignment and service writes are ignored.
-- ============================================================

create or replace function public.notify_assignee()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := auth.uid();
  actor_name text;
begin
  if NEW.assignee_id is null then return NEW; end if;
  -- assignee_id is TEXT (it can hold non-uuid ids too); compare as text and
  -- ignore self-assignment / service writes
  if actor is null or NEW.assignee_id = actor::text then return NEW; end if;
  -- on reassign, only fire when the assignee actually changed
  if TG_OP = 'UPDATE' and NEW.assignee_id is not distinct from OLD.assignee_id then
    return NEW;
  end if;
  -- only notify real accounts (assignee_id must be a uuid)
  if NEW.assignee_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return NEW;
  end if;

  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email, 'Someone')
    into actor_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = actor;

  insert into public.activity (user_id, task_id, task_title, kind, detail)
  values (NEW.assignee_id::uuid, NEW.id, NEW.title, 'assigned', coalesce(actor_name, 'Someone'));

  return NEW;
end;
$$;

drop trigger if exists trg_notify_assignee on public.tasks;
create trigger trg_notify_assignee
  after insert or update of assignee_id on public.tasks
  for each row execute function public.notify_assignee();
