// ============================================================
// KANBO — replay the repo's real migrations in PGlite (Postgres compiled to
// WebAssembly), with just enough of Supabase stubbed around them: the auth
// schema, roles, storage, vault, cron and net.
//
// Nothing here touches a real database. Run with run.mjs (see README.md).
// ============================================================
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Tx, UserDb, UserScope } from "../../functions/_shared/api/types.ts";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** Where PGlite lives: PGLITE_PATH, or the copy already on Daniel's Mac. */
export function pglitePath(): string {
  return process.env.PGLITE_PATH || join(process.env.HOME || "", "Downloads/standing-portal/node_modules/@electric-sql/pglite");
}

/** The stand-in for what Supabase provides before migrations run. */
const SUPABASE_STUBS = `
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_admin') then create role supabase_admin nologin; end if;
end $$;
create schema if not exists auth;
create schema if not exists extensions;
create schema if not exists storage;
create schema if not exists vault;
create schema if not exists cron;
create schema if not exists net;
create schema if not exists realtime;
grant usage on schema public, auth, extensions, storage to anon, authenticated, service_role;
-- Supabase's default privileges: new tables, sequences and functions in public are open to these
-- roles until a migration says otherwise (and RLS decides the rest)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  raw_app_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  banned_until timestamptz,
  deleted_at timestamptz,
  is_sso_user boolean default false,
  is_anonymous boolean default false
);
create table if not exists auth.identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete cascade,
  provider text,
  identity_data jsonb default '{}'::jsonb
);
grant select on auth.users to service_role;
create or replace function auth.uid() returns uuid language sql stable as $f$
  select nullif(coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'sub', '')::uuid
$f$;
create or replace function auth.role() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'role'
$f$;
create or replace function auth.jwt() returns jsonb language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$f$;
create or replace function auth.email() returns text language sql stable as $f$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb ->> 'email'
$f$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id text primary key, name text, public boolean default false, owner uuid,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create or replace function storage.foldername(name text) returns text[] language sql immutable as $f$
  select (string_to_array(name, '/'))[1:greatest(array_length(string_to_array(name, '/'), 1) - 1, 0)]
$f$;
create or replace function storage.filename(name text) returns text language sql immutable as $f$
  select (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$f$;
grant all on storage.buckets, storage.objects to authenticated, service_role;

create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text);
create or replace view vault.decrypted_secrets as select id, name, secret, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(p_secret text, p_name text default null, p_description text default null)
  returns uuid language sql as $f$ insert into vault.secrets (name, secret) values (p_name, p_secret) returning id $f$;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text);
create or replace function cron.schedule(p_name text, p_schedule text, p_command text) returns bigint language sql as $f$
  insert into cron.job (jobname, schedule, command) values (p_name, p_schedule, p_command) returning jobid
$f$;
create or replace function cron.unschedule(p_name text) returns boolean language sql as $f$
  delete from cron.job where jobname = p_name returning true
$f$;
create or replace function net.http_post(url text, headers jsonb default '{}', body jsonb default '{}', timeout_milliseconds integer default 5000)
  returns bigint language sql as $f$ select 1::bigint $f$;
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if;
end $$;
`;

export interface Pg {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: { query: Pg["query"]; exec: Pg["exec"] }) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Every migration file name, in order. */
export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
}

export function migrationSql(file: string): string {
  return readFileSync(join(MIGRATIONS, file), "utf8");
}

/** The real files, as Supabase runs them, apart from what PGlite itself can't do. */
function adapt(sql: string): string {
  return sql
    // PGlite has no pg_cron / pg_net / vault / pgcrypto packages to load; the schemas above stand in
    .replace(/create\s+extension\s+if\s+not\s+exists\s+"?(pg_cron|pg_net|supabase_vault|vault|pg_trgm|unaccent)"?[^;]*;/gi, "select 1;");
}

/** A fresh database with the listed migrations applied in order. */
export async function freshDatabase(files: string[]): Promise<Pg> {
  const url = pathToFileURL(join(pglitePath(), "dist/index.js")).href;
  const { PGlite } = await import(url);
  const pg = new PGlite() as Pg;
  await pg.exec(SUPABASE_STUBS);
  for (const f of files) {
    try {
      await pg.exec(adapt(migrationSql(f)));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${String((e as Error).message)}`);
    }
  }
  return pg;
}

/** Apply one more file (for "migrating twice"). */
export async function applyFile(pg: Pg, file: string): Promise<void> {
  await pg.exec(adapt(migrationSql(file)));
}

/** db.ts's WITH_USER_SQL (db.ts is Deno-only, so a contract test keeps the two the same). */
export const WITH_USER_SQL =
  "select set_config('role', 'authenticated', true), set_config('statement_timeout', '15s', true), " +
  "set_config('request.jwt.claims', $1, true), set_config('kanbo.api_workspace', $2, true)";

/** Postgres dates come back as JS Dates from PGlite; the live driver gives strings. */
function txOf(q: { query: Pg["query"] }): Tx {
  return {
    async query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<T[]> {
      const rs = await q.query<T>(text, params as unknown[]);
      return rs.rows;
    },
  };
}

export interface HarnessDb extends UserDb { service: Tx }

/** The same transaction shape as db.ts createApiDb, on PGlite. */
export function harnessDb(pg: Pg): HarnessDb {
  return {
    service: txOf(pg),
    withUser<T>(scope: UserScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
      return pg.transaction(async (t) => {
        await t.exec(scope.readOnly ? "set transaction read only" : "set transaction read write");
        await t.query(WITH_USER_SQL, [JSON.stringify({ sub: scope.userId, role: "authenticated" }), scope.workspaceId ?? ""]);
        return fn(txOf(t));
      }) as Promise<T>;
    },
  };
}

/** Run one statement as a signed-in person, the way PostgREST would (for RPCs from the app). */
export async function asPerson<T = Record<string, unknown>>(pg: Pg, userId: string, sql: string, params: unknown[] = []): Promise<T[]> {
  return pg.transaction(async (t) => {
    await t.query(WITH_USER_SQL, [JSON.stringify({ sub: userId, role: "authenticated" }), ""]);
    return (await t.query<T>(sql, params)).rows;
  }) as Promise<T[]>;
}

/** Make a person (the signup triggers from the migrations run, as they do live). */
export async function makeUser(pg: Pg, email: string, first = ""): Promise<string> {
  const rs = await pg.query<{ id: string }>(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id::text as id`,
    [email, JSON.stringify({ first_name: first })]);
  return rs.rows[0].id;
}
