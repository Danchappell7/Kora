-- ============================================================
-- KANBO — integrations, push, public request forms, plans that follow you
-- (2026-10-04). Additive: nothing existing changes shape or behaviour.
--   1. Slack (workspace_integrations): one Incoming Webhook per team
--      workspace. The URL is a secret: no client can read it, members
--      included. Owners/admins set or clear it through definer functions;
--      everyone in the workspace sees only slack_status() (connected or not,
--      a channel label, the daily auto-post time). The slack-post /
--      slack-standup edge functions read it with the service role.
--   2. Calendar feed (calendar_feed_tokens): one unguessable token per person
--      for their private ICS subscription URL. Only its owner sees it; the
--      server always picks the token (a client can't choose a weak one).
--      tasks_visible_to(user) gives the ics-feed function (service role) the
--      same task visibility as the app's read policy.
--   3. Web push (push_subscriptions): one row per device. Own rows only;
--      save_push_subscription() moves an endpoint to whoever subscribed on
--      that device last (a browser shared by two accounts).
--   4. Public request forms (forms.public_token / public_enabled): people who
--      may edit the form (never guests) switch the public link on or off; the
--      token is always server-generated and only rotate_form_public_token()
--      replaces it. The public-form edge function (service role) reads it.
--   5. Plans that follow you (task_user_state): each person's own plan on a
--      task (slot, "on today", the day that plan is for, My-tasks section,
--      Kanbo's ranking), private to them and only for tasks they can see.
--      Streams over realtime.
-- Needs 0042. Idempotent: safe to run more than once (re-running keeps every
-- token, URL and plan). Owners of this file: see docs/integrations/*.md.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.schema_migrations') is null then
    raise exception '0043 needs 0042 first: run 0042_rollout_hardening.sql, then this file';
  end if;
  if not exists (select 1 from public.schema_migrations where version = '0042') then
    raise exception '0043 needs 0042 first: run 0042_rollout_hardening.sql, then this file';
  end if;
end $pre$;

-- can the caller see this task? The same rule as 0041's task read policy:
-- their own personal task, or any task in a workspace they're an active
-- member (or guest) of. Used by the task_user_state policies.
create or replace function public.can_see_task(p_task uuid)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.tasks t
     where t.id = p_task
       and ((t.workspace_id is null and t.user_id = auth.uid() and public.can_act())
         or (t.workspace_id is not null and public.is_member(t.workspace_id))));
$$;
revoke execute on function public.can_see_task(uuid) from public, anon;
grant execute on function public.can_see_task(uuid) to authenticated;

-- ---------- 1. Slack: workspace_integrations ----------
create table if not exists public.workspace_integrations (
  workspace_id        uuid primary key references public.workspaces (id) on delete cascade,
  slack_webhook_url   text,
  slack_autopost      boolean not null default false,
  slack_autopost_time text,
  slack_channel_label text,
  updated_by          uuid references auth.users (id) on delete set null,
  updated_at          timestamptz not null default now()
);
alter table public.workspace_integrations drop constraint if exists workspace_integrations_slack_url;
alter table public.workspace_integrations add constraint workspace_integrations_slack_url check (
  slack_webhook_url is null
  or (length(slack_webhook_url) <= 500 and slack_webhook_url ~ '^https://hooks\.slack\.com/services/[A-Za-z0-9_/-]+$'));
alter table public.workspace_integrations drop constraint if exists workspace_integrations_slack_time;
alter table public.workspace_integrations add constraint workspace_integrations_slack_time check (
  slack_autopost_time is null or slack_autopost_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.workspace_integrations drop constraint if exists workspace_integrations_slack_label;
alter table public.workspace_integrations add constraint workspace_integrations_slack_label check (
  slack_channel_label is null or length(slack_channel_label) <= 80);
-- RLS on, no policies, no grants: only the service role (edge functions) and
-- the definer functions below touch it. Members never read the URL.
alter table public.workspace_integrations enable row level security;
revoke all on public.workspace_integrations from anon, authenticated;
do $wi$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'workspace_integrations' loop
    execute format('drop policy %I on public.workspace_integrations', pol.policyname);
  end loop;
end $wi$;

-- what everyone in the workspace may know (never the URL); null for anyone
-- who isn't in the workspace, so an outsider learns nothing
create or replace function public.slack_status(p_ws uuid)
returns jsonb language sql security definer stable set search_path = public as $$
  select case when p_ws is null or not public.is_member(p_ws) then null else jsonb_build_object(
    'connected',     i.slack_webhook_url is not null,
    'channel_label', i.slack_channel_label,
    'autopost',      coalesce(i.slack_autopost, false) and i.slack_webhook_url is not null,
    'autopost_time', i.slack_autopost_time,
    'can_manage',    public.ws_role(p_ws) in ('owner', 'admin'),
    'can_post',      public.can_write(p_ws),
    'updated_at',    i.updated_at) end
  from (select 1) as one
  left join public.workspace_integrations i on i.workspace_id = p_ws;
$$;

-- owners/admins connect a channel by pasting its Incoming Webhook URL
create or replace function public.slack_connect(p_ws uuid, p_url text, p_channel_label text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  url   text := btrim(coalesce(p_url, ''));
  label text := nullif(left(btrim(coalesce(p_channel_label, '')), 80), '');
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  if length(url) > 500 or url !~ '^https://hooks\.slack\.com/services/[A-Za-z0-9_/-]+$' then
    raise exception 'invalid webhook url';
  end if;
  insert into public.workspace_integrations as i (workspace_id, slack_webhook_url, slack_channel_label, updated_by, updated_at)
  values (p_ws, url, label, auth.uid(), now())
  on conflict (workspace_id) do update
     set slack_webhook_url = excluded.slack_webhook_url,
         slack_channel_label = excluded.slack_channel_label,
         updated_by = excluded.updated_by,
         updated_at = now();
  return public.slack_status(p_ws);
end; $$;

-- owners/admins disconnect: the URL is forgotten and auto-post switches off
create or replace function public.slack_disconnect(p_ws uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  update public.workspace_integrations
     set slack_webhook_url = null, slack_autopost = false, updated_by = auth.uid(), updated_at = now()
   where workspace_id = p_ws;
  return public.slack_status(p_ws);
end; $$;

-- owners/admins switch the daily stand-up post on (at HH:MM, Europe/London) or off
create or replace function public.slack_set_autopost(p_ws uuid, p_enabled boolean, p_time text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t   text := nullif(btrim(coalesce(p_time, '')), '');
  cur record;
begin
  if auth.uid() is null or p_ws is null or public.ws_role(p_ws) not in ('owner', 'admin') then
    raise exception 'not allowed';
  end if;
  if t is not null and t !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'invalid time';
  end if;
  select slack_webhook_url, slack_autopost_time into cur from public.workspace_integrations where workspace_id = p_ws for update;
  if coalesce(p_enabled, false) and cur.slack_webhook_url is null then
    raise exception 'not connected';
  end if;
  if coalesce(p_enabled, false) and coalesce(t, cur.slack_autopost_time) is null then
    raise exception 'invalid time';
  end if;
  update public.workspace_integrations
     set slack_autopost = coalesce(p_enabled, false),
         slack_autopost_time = coalesce(t, slack_autopost_time),
         updated_by = auth.uid(), updated_at = now()
   where workspace_id = p_ws;
  return public.slack_status(p_ws);
end; $$;

revoke execute on function public.slack_status(uuid) from public, anon;
revoke execute on function public.slack_connect(uuid, text, text) from public, anon;
revoke execute on function public.slack_disconnect(uuid) from public, anon;
revoke execute on function public.slack_set_autopost(uuid, boolean, text) from public, anon;
grant execute on function public.slack_status(uuid) to authenticated;
grant execute on function public.slack_connect(uuid, text, text) to authenticated;
grant execute on function public.slack_disconnect(uuid) to authenticated;
grant execute on function public.slack_set_autopost(uuid, boolean, text) to authenticated;

-- ---------- 2. calendar feed tokens ----------
create table if not exists public.calendar_feed_tokens (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  token       text not null unique default replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
  include_due boolean not null default true,
  created_at  timestamptz not null default now()
);
alter table public.calendar_feed_tokens drop constraint if exists calendar_feed_tokens_token_format;
alter table public.calendar_feed_tokens add constraint calendar_feed_tokens_token_format check (token ~ '^[A-Za-z0-9_-]{32,128}$');

-- the server always picks the token: a client insert gets a fresh one, a
-- client update keeps the old one (rotate_calendar_feed_token() replaces it)
create or replace function public.calendar_feed_token_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and coalesce(current_setting('kanbo.trusted', true), '') <> 'on' then
    if tg_op = 'INSERT' then
      new.token := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
      new.created_at := now();
    else
      new.token := old.token; new.user_id := old.user_id; new.created_at := old.created_at;
    end if;
  end if;
  return new;
end; $$;
revoke execute on function public.calendar_feed_token_guard() from public, anon, authenticated;
drop trigger if exists trg_calendar_feed_token_guard on public.calendar_feed_tokens;
create trigger trg_calendar_feed_token_guard before insert or update on public.calendar_feed_tokens
  for each row execute function public.calendar_feed_token_guard();

alter table public.calendar_feed_tokens enable row level security;
revoke all on public.calendar_feed_tokens from anon;
do $cf$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'calendar_feed_tokens' loop
    execute format('drop policy %I on public.calendar_feed_tokens', pol.policyname);
  end loop;
end $cf$;
create policy "feed token: own row" on public.calendar_feed_tokens
  for all using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_act());

-- the caller's feed (made on first use): { token, include_due, created_at }
create or replace function public.calendar_feed()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r record;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  insert into public.calendar_feed_tokens (user_id) values (me) on conflict (user_id) do nothing;
  select token, include_due, created_at into r from public.calendar_feed_tokens where user_id = me;
  return jsonb_build_object('token', r.token, 'include_due', r.include_due, 'created_at', r.created_at);
end; $$;

-- "Reset link": a new token; the old URL stops working at once
create or replace function public.rotate_calendar_feed_token()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); tok text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  perform set_config('kanbo.trusted', 'on', true);
  insert into public.calendar_feed_tokens (user_id, token, created_at) values (me, tok, now())
  on conflict (user_id) do update set token = excluded.token, created_at = excluded.created_at;
  perform set_config('kanbo.trusted', 'off', true);
  return public.calendar_feed();
end; $$;
revoke execute on function public.calendar_feed() from public, anon;
revoke execute on function public.rotate_calendar_feed_token() from public, anon;
grant execute on function public.calendar_feed() to authenticated;
grant execute on function public.rotate_calendar_feed_token() to authenticated;

-- every task a person can see (service role only: the ics-feed function has
-- no JWT, just the feed token). Same rule as the task read policy, including
-- "a suspended or not-yet-approved account sees nothing".
create or replace function public.tasks_visible_to(p_user uuid)
returns setof public.tasks language sql security definer stable set search_path = public as $$
  select t.* from public.tasks t
   where p_user is not null
     and not exists (select 1 from public.profiles p
                      where p.id = p_user and (coalesce(p.suspended, false) or not coalesce(p.approved, true)))
     and ((t.workspace_id is null and t.user_id = p_user)
       or (t.workspace_id is not null and (
             exists (select 1 from public.workspace_members m
                      where m.workspace_id = t.workspace_id and m.user_id = p_user and m.status = 'active')
          or exists (select 1 from public.workspaces w where w.id = t.workspace_id and w.owner_id = p_user))));
$$;
revoke execute on function public.tasks_visible_to(uuid) from public, anon, authenticated;
do $svc$ begin
  grant execute on function public.tasks_visible_to(uuid) to service_role;
exception when undefined_object then null; end $svc$;

-- ---------- 3. web push subscriptions ----------
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);
alter table public.push_subscriptions drop constraint if exists push_subscriptions_shape;
alter table public.push_subscriptions add constraint push_subscriptions_shape check (
  endpoint ~ '^https://' and length(endpoint) <= 1000
  and length(p256dh) between 1 and 200 and length(auth) between 1 and 100
  and (user_agent is null or length(user_agent) <= 300));
alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
do $ps$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'push_subscriptions' loop
    execute format('drop policy %I on public.push_subscriptions', pol.policyname);
  end loop;
end $ps$;
create policy "push: own rows" on public.push_subscriptions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid() and public.can_act());

-- Save this device's subscription for the caller. A browser endpoint belongs
-- to whoever subscribed on it last (two accounts on one computer), so a row
-- another account left on this endpoint moves to the caller; knowing an
-- endpoint means holding the device. Keeps each person's 20 newest devices.
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); rid uuid;
begin
  if me is null or not public.can_act() then raise exception 'not authorized'; end if;
  if coalesce(p_endpoint, '') !~ '^https://' or length(p_endpoint) > 1000
     or coalesce(length(p_p256dh), 0) not between 1 and 200 or coalesce(length(p_auth), 0) not between 1 and 100 then
    raise exception 'invalid subscription';
  end if;
  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values (me, p_endpoint, p_p256dh, p_auth, nullif(left(coalesce(p_user_agent, ''), 300), ''))
  on conflict (endpoint) do update
     set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
         user_agent = excluded.user_agent, created_at = case when push_subscriptions.user_id = excluded.user_id
                                                            then push_subscriptions.created_at else now() end
  returning id into rid;
  delete from public.push_subscriptions
   where id in (select id from public.push_subscriptions where user_id = me order by created_at desc, id offset 20);
  return rid;
end; $$;
revoke execute on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;

-- ---------- 4. public request forms ----------
alter table public.forms add column if not exists public_token text;
alter table public.forms add column if not exists public_enabled boolean not null default false;
create unique index if not exists forms_public_token_key on public.forms (public_token);
alter table public.forms drop constraint if exists forms_public_token_format;
alter table public.forms add constraint forms_public_token_format check (
  public_token is null or public_token ~ '^[A-Za-z0-9_-]{24,128}$');

-- Clients can switch the link on and off (0041's form policies: personal
-- creator or workspace writers; never guests) but never choose the token:
-- switching on mints one if there's none, and only rotate_form_public_token()
-- replaces it.
create or replace function public.forms_public_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if coalesce(auth.role(), '') in ('authenticated', 'anon')
     and coalesce(current_setting('kanbo.trusted', true), '') <> 'on' then
    if tg_op = 'INSERT' then new.public_token := null;
    else new.public_token := old.public_token; end if;
  end if;
  new.public_enabled := coalesce(new.public_enabled, false);
  if new.public_enabled and new.public_token is null then
    new.public_token := replace(gen_random_uuid()::text, '-', '');
  end if;
  return new;
end; $$;
revoke execute on function public.forms_public_guard() from public, anon, authenticated;
drop trigger if exists trg_forms_public_guard on public.forms;
create trigger trg_forms_public_guard before insert or update on public.forms
  for each row execute function public.forms_public_guard();

-- "Regenerate link": anyone who may edit the form; the old link stops working
create or replace function public.rotate_form_public_token(p_form uuid)
returns text language plpgsql security definer set search_path = public as $$
declare f record; tok text := replace(gen_random_uuid()::text, '-', '');
begin
  if auth.uid() is null then raise exception 'not authorized'; end if;
  select id, user_id, workspace_id into f from public.forms where id = p_form for update;
  if f.id is null
     or not ((f.workspace_id is null and f.user_id = auth.uid() and public.can_act())
             or (f.workspace_id is not null and public.can_write(f.workspace_id))) then
    raise exception 'form not found';           -- same answer whether it's gone or not yours
  end if;
  perform set_config('kanbo.trusted', 'on', true);
  update public.forms set public_token = tok where id = p_form;
  perform set_config('kanbo.trusted', 'off', true);
  return tok;
end; $$;
revoke execute on function public.rotate_form_public_token(uuid) from public, anon;
grant execute on function public.rotate_form_public_token(uuid) to authenticated;

-- ---------- 5. plans that follow you: task_user_state ----------
create table if not exists public.task_user_state (
  task_id       uuid not null references public.tasks (id) on delete cascade,
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  scheduled     integer,          -- minutes from midnight (the plan canvas's slot)
  plan_today    boolean,          -- on the person's day
  plan_day      date,             -- the day `scheduled` / `plan_today` are for
  my_section_id text,             -- their My-tasks section
  ai_score      integer,          -- Kanbo's ranking for them
  ai_reason     text,
  updated_at    timestamptz not null default now(),
  primary key (task_id, user_id)
);
create index if not exists task_user_state_user_idx on public.task_user_state (user_id);
alter table public.task_user_state drop constraint if exists task_user_state_sizes;
alter table public.task_user_state add constraint task_user_state_sizes check (
  (my_section_id is null or length(my_section_id) <= 200)
  and (ai_reason is null or length(ai_reason) <= 2000));

create or replace function public.task_user_state_touch() returns trigger
language plpgsql set search_path = public as $$
begin
  new.updated_at := now();
  return new;
end; $$;
revoke execute on function public.task_user_state_touch() from public, anon, authenticated;
drop trigger if exists trg_task_user_state_touch on public.task_user_state;
create trigger trg_task_user_state_touch before insert or update on public.task_user_state
  for each row execute function public.task_user_state_touch();

alter table public.task_user_state enable row level security;
revoke all on public.task_user_state from anon;
do $tus$
declare pol record;
begin
  for pol in select policyname from pg_policies where schemaname = 'public' and tablename = 'task_user_state' loop
    execute format('drop policy %I on public.task_user_state', pol.policyname);
  end loop;
end $tus$;
-- your own rows, and only for tasks you can see (guests too: it's their plan,
-- not the task). A removed member's rows stay but can't be read or written.
create policy "plan state: own, visible task" on public.task_user_state
  for all using (user_id = auth.uid() and public.can_see_task(task_id))
  with check (user_id = auth.uid() and public.can_see_task(task_id));

do $rt$
begin
  begin
    alter publication supabase_realtime add table public.task_user_state;
  exception
    when duplicate_object then null;                  -- already streaming
    when object_not_in_prerequisite_state then null;  -- publication is FOR ALL TABLES
    when undefined_object then null;                  -- no realtime publication (local Postgres)
  end;
end $rt$;

-- ---------- done: record it ----------
insert into public.schema_migrations (version) values ('0043') on conflict (version) do nothing;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   exists (select 1 from public.schema_migrations where version = '0043')                as recorded,
--   (select relrowsecurity from pg_class where oid = 'public.workspace_integrations'::regclass)
--   and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'workspace_integrations')
--   and not has_table_privilege('authenticated', 'public.workspace_integrations', 'select') as slack_url_server_only,
--   (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
--     and proname in ('slack_status','slack_connect','slack_disconnect','slack_set_autopost')) = 4 as slack_functions,
--   (select relrowsecurity from pg_class where oid = 'public.calendar_feed_tokens'::regclass)
--   and exists (select 1 from pg_trigger where tgname = 'trg_calendar_feed_token_guard')        as feed_tokens_guarded,
--   (select relrowsecurity from pg_class where oid = 'public.push_subscriptions'::regclass)     as push_rls,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'forms' and column_name = 'public_token')
--   and exists (select 1 from pg_trigger where tgname = 'trg_forms_public_guard')               as public_forms,
--   (select relrowsecurity from pg_class where oid = 'public.task_user_state'::regclass)
--   and exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'task_user_state'
--                and qual like '%can_see_task%')                                               as plan_state_rls,
--   exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
--            and schemaname = 'public' and tablename = 'task_user_state')                     as plan_state_realtime,
--   not has_function_privilege('authenticated', 'public.tasks_visible_to(uuid)', 'execute')    as feed_tasks_service_only;
-- ============================================================
