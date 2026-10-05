-- ============================================================
-- KANBO — several calendar accounts per person, and a choice of calendars
-- inside each one (2026-10-05).
--
-- Until now calendar_connections allowed one Google and one Microsoft account
-- per person (unique (user_id, provider)), and Kanbo only ever read each
-- account's primary calendar. This file:
--   1. makes sure every connection has its own id (0011 already made `id` the
--      primary key; this backfills and enforces it on any older hand-made
--      table), which the app now uses to refer to one account;
--   2. swaps the one-per-provider rule for one row per ACCOUNT:
--      unique (user_id, provider, lower(account_email)), so a work Google, a
--      personal Google and an Outlook account can all be connected;
--   3. adds selected_calendars jsonb — which of the account's calendars Kanbo
--      shows, as [{id, name, color, primary}], at most 25. NULL (every
--      existing row) means "the primary calendar only": exactly what Kanbo
--      did before, so nothing changes for anyone until they choose;
--   4. keeps both tables service-role only: RLS on, NO policies, no grants to
--      anon/authenticated. OAuth tokens never reach the browser; the app only
--      learns connection id, provider, account email and the calendar
--      choice, through the `calendar` Edge Function.
-- oauth_states needs no new column: the account chooser is a provider-side
-- prompt, and the account is identified when the handshake finishes.
--
-- Order: deploy the updated `calendar` function FIRST, then run this file.
-- The old function saves with ON CONFLICT (user_id, provider), which stops
-- matching once step 2 drops that rule (connecting would fail until the new
-- function is live); the new function works before and after this file.
--
-- Needs 0011 only (0042's schema_migrations ledger is used when present).
-- Idempotent: safe to run more than once.
-- ============================================================

-- ---------- 0. preflight ----------
do $pre$
begin
  if to_regclass('public.calendar_connections') is null or to_regclass('public.oauth_states') is null then
    raise exception '0045 needs 0011 first: run 0011_calendar_connections.sql, then this file';
  end if;
end $pre$;

-- ---------- 1. every connection has its own id ----------
alter table public.calendar_connections add column if not exists id uuid;
alter table public.calendar_connections alter column id set default gen_random_uuid();
update public.calendar_connections set id = gen_random_uuid() where id is null;
alter table public.calendar_connections alter column id set not null;
do $id$
declare idnum smallint;
begin
  select attnum into idnum from pg_attribute
   where attrelid = 'public.calendar_connections'::regclass and attname = 'id' and not attisdropped;
  -- 0011's primary key already makes ids unique; only a table without one gets an index
  if not exists (
    select 1 from pg_index i
     where i.indrelid = 'public.calendar_connections'::regclass and i.indisunique
       and i.indnkeyatts = 1 and i.indkey[0] = idnum and i.indexprs is null and i.indpred is null) then
    create unique index calendar_connections_id_key on public.calendar_connections (id);
  end if;
end $id$;

alter table public.calendar_connections alter column account_email set default '';
update public.calendar_connections set account_email = '' where account_email is null;

-- ---------- 2. one row per account, not per provider ----------
do $uq$
declare r record;
begin
  -- the old unique (user_id, provider) constraint, whatever it was called
  for r in
    select c.conname from pg_constraint c
     where c.conrelid = 'public.calendar_connections'::regclass and c.contype = 'u'
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(c.conkey) k join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k)
           = array['provider', 'user_id']
  loop
    execute format('alter table public.calendar_connections drop constraint %I', r.conname);
  end loop;
  -- …and a plain unique index on the same pair, if one was made by hand
  for r in
    select ci.relname from pg_index i join pg_class ci on ci.oid = i.indexrelid
     where i.indrelid = 'public.calendar_connections'::regclass and i.indisunique and not i.indisprimary
       and i.indexprs is null and i.indpred is null
       and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid)
       and (select array_agg(a.attname::text order by a.attname::text)
              from unnest(i.indkey::int2[]) k join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k)
           = array['provider', 'user_id']
  loop
    execute format('drop index public.%I', r.relname);
  end loop;
end $uq$;

-- (the old rule allowed no duplicates; this only guards a hand-edited table:
--  the most recently updated row for an account is kept)
delete from public.calendar_connections c
 using (select id, row_number() over (partition by user_id, provider, lower(account_email)
                                      order by updated_at desc, created_at desc, id) as n
          from public.calendar_connections) d
 where c.id = d.id and d.n > 1;

create unique index if not exists calendar_connections_user_provider_email_key
  on public.calendar_connections (user_id, provider, lower(account_email));

-- ---------- 3. which calendars to show (NULL = the primary only) ----------
alter table public.calendar_connections add column if not exists selected_calendars jsonb;
alter table public.calendar_connections alter column selected_calendars set default null;
alter table public.calendar_connections drop constraint if exists calendar_connections_selected_calendars_shape;
alter table public.calendar_connections add constraint calendar_connections_selected_calendars_shape check (
  selected_calendars is null
  or (jsonb_typeof(selected_calendars) = 'array'
      and jsonb_array_length(selected_calendars) <= 25
      and octet_length(selected_calendars::text) <= 32768
      and not jsonb_path_exists(selected_calendars,
            '$[*] ? (@.type() != "object" || !exists(@.id ? (@.type() == "string")))')));

-- ---------- 4. still service-role only ----------
alter table public.calendar_connections enable row level security;
alter table public.oauth_states enable row level security;
revoke all on public.calendar_connections from anon, authenticated;
revoke all on public.oauth_states from anon, authenticated;
do $pol$
declare pol record;
begin
  for pol in select tablename, policyname from pg_policies
              where schemaname = 'public' and tablename in ('calendar_connections', 'oauth_states') loop
    execute format('drop policy %I on public.%I', pol.policyname, pol.tablename);
  end loop;
end $pol$;

-- ---------- done: record it (0042's ledger, when it's there) ----------
do $rec$
begin
  if to_regclass('public.schema_migrations') is not null then
    insert into public.schema_migrations (version) values ('0045') on conflict (version) do nothing;
  end if;
end $rec$;

-- ============================================================
-- VERIFY (run after the migration; every column should be true):
--
-- select
--   (to_regclass('public.schema_migrations') is null
--     or exists (select 1 from public.schema_migrations where version = '0045'))          as recorded,
--   exists (select 1 from information_schema.columns where table_schema = 'public'
--            and table_name = 'calendar_connections' and column_name = 'selected_calendars') as selected_calendars,
--   exists (select 1 from pg_indexes where schemaname = 'public'
--            and indexname = 'calendar_connections_user_provider_email_key')               as one_row_per_account,
--   not exists (select 1 from pg_constraint where conrelid = 'public.calendar_connections'::regclass
--                and contype = 'u' and conname = 'calendar_connections_user_id_provider_key') as several_per_provider,
--   (select relrowsecurity from pg_class where oid = 'public.calendar_connections'::regclass)
--   and not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'calendar_connections')
--   and not has_table_privilege('authenticated', 'public.calendar_connections', 'select')
--   and not has_table_privilege('anon', 'public.calendar_connections', 'select')             as tokens_server_only,
--   (select relrowsecurity from pg_class where oid = 'public.oauth_states'::regclass)
--   and not has_table_privilege('authenticated', 'public.oauth_states', 'select')            as oauth_states_server_only;
-- ============================================================
