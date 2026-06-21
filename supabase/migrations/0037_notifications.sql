-- ============================================================
-- KANBO — notifications: per-user preferences + comment notifications.
--   - profiles.notify_prefs (jsonb): per-category in-app/email toggles.
--   - notif_on(user, key): reads a pref, defaulting to ON when unset.
--   - assignment + mention triggers now respect the in-app pref.
--   - NEW comment trigger: notifies the task owner + followers (minus the
--     author and anyone already @mentioned), respecting the comment pref.
--   Idempotent.
-- ============================================================

alter table public.profiles add column if not exists notify_prefs jsonb not null default '{}'::jsonb;

-- a pref is ON unless explicitly set to false
create or replace function public.notif_on(p_user uuid, p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select (notify_prefs ->> p_key)::boolean from public.profiles where id = p_user), true);
$$;
grant execute on function public.notif_on(uuid, text) to authenticated;

-- ---------- assignment (respect pref) ----------
create or replace function public.notify_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := auth.uid(); actor_name text;
begin
  if NEW.assignee_id is null then return NEW; end if;
  if actor is null or NEW.assignee_id = actor::text then return NEW; end if;
  if TG_OP = 'UPDATE' and NEW.assignee_id is not distinct from OLD.assignee_id then return NEW; end if;
  if NEW.assignee_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then return NEW; end if;
  if not public.notif_on(NEW.assignee_id::uuid, 'assigned') then return NEW; end if;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  insert into public.activity (user_id, task_id, task_title, kind, detail)
  values (NEW.assignee_id::uuid, NEW.id, NEW.title, 'assigned', coalesce(actor_name, 'Someone'));
  return NEW;
end; $$;

-- ---------- mentions (respect pref) ----------
create or replace function public.notify_mentioned()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := NEW.user_id; actor_name text; m uuid; t_title text;
begin
  if NEW.mentions is null or array_length(NEW.mentions, 1) is null then return NEW; end if;
  select title into t_title from public.tasks where id = NEW.task_id;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  foreach m in array NEW.mentions loop
    if m <> actor and public.notif_on(m, 'mention') then
      insert into public.activity (user_id, task_id, task_title, kind, detail)
      values (m, NEW.task_id, coalesce(t_title, 'a task'), 'mention', coalesce(actor_name, 'Someone'));
    end if;
  end loop;
  return NEW;
end; $$;

-- ---------- comments → owner + followers (new) ----------
create or replace function public.notify_comment()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor uuid := NEW.user_id; actor_name text; t record; m uuid;
begin
  select user_id, title, coalesce(followers, '{}') as followers from public.tasks where id = NEW.task_id into t;
  if t is null then return NEW; end if;
  select coalesce(nullif(btrim(coalesce(p.first_name,'') || ' ' || coalesce(p.last_name,'')), ''), u.email, 'Someone')
    into actor_name from auth.users u left join public.profiles p on p.id = u.id where u.id = actor;
  for m in (
    select distinct x from (
      select t.user_id as x
      union
      select f::uuid from unnest(t.followers) f where f ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    ) q
    where x is not null and x <> actor
      and not (x = any (coalesce(NEW.mentions, '{}')))
      and public.notif_on(x, 'comment')
  ) loop
    insert into public.activity (user_id, task_id, task_title, kind, detail)
    values (m, NEW.task_id, coalesce(t.title, 'a task'), 'comment', coalesce(actor_name, 'Someone'));
  end loop;
  return NEW;
end; $$;

drop trigger if exists trg_notify_comment on public.comments;
create trigger trg_notify_comment after insert on public.comments
  for each row execute function public.notify_comment();
