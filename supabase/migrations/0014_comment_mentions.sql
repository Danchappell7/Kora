-- ============================================================
-- KANBO — notify teammates when they're @mentioned in a comment.
--   comments.mentions holds the user ids the author tagged (resolved
--   client-side from "@Name" tokens). Activity rows are RLS-locked to
--   user_id = auth.uid(), so only this SECURITY DEFINER trigger can drop a
--   'mention' notification into someone else's inbox. The author isn't
--   notified about mentioning themselves.
-- ============================================================

alter table public.comments add column if not exists mentions uuid[] not null default '{}';

create or replace function public.notify_mentioned()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor uuid := coalesce(auth.uid(), NEW.user_id);
  actor_name text;
  ttitle text;
  m uuid;
begin
  if NEW.mentions is null or array_length(NEW.mentions, 1) is null then return NEW; end if;

  select coalesce(nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''), u.email, NEW.author_name, 'Someone')
    into actor_name
    from auth.users u
    left join public.profiles p on p.id = u.id
   where u.id = actor;

  select title into ttitle from public.tasks where id = NEW.task_id;

  foreach m in array NEW.mentions loop
    if m is not null and m <> NEW.user_id then
      insert into public.activity (user_id, task_id, task_title, kind, detail)
      values (m, NEW.task_id, coalesce(ttitle, ''), 'mention', coalesce(actor_name, 'Someone'));
    end if;
  end loop;

  return NEW;
end;
$$;

drop trigger if exists trg_notify_mentioned on public.comments;
create trigger trg_notify_mentioned
  after insert on public.comments
  for each row execute function public.notify_mentioned();
