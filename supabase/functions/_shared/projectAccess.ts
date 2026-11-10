// ============================================================
// KANBO — project access for the edge functions (0058).          [w4]
//
// A workspace with Project access switched on keeps Members only and Private
// projects to their people, and its guests to the projects they're on. The
// database's own rules (RLS) do that for everything that runs AS a person
// (the app, the API, MCP, the Slack app's withUser). The functions that run
// with the service role skip RLS (email and push, the digest, the Slack
// stand-up, public forms), so they ask the database here, through 0058's
// service-only helpers:
//
//   user_can_see_task(user, task)        user_can_see_project(user, project)
//   user_visible_task_ids(user, ids[])   user_project_rank(user, ws, project)
//   closed_project_ids(ws)               project_is_open(ws, project)
//
// Before 0058 (the database at 0050..0057) those functions aren't there: the
// answer is "missing" (42883 / PGRST202, or a table or column error), and
// every helper falls back to today's rule (everyone in the workspace sees
// every project), which is what the database itself still does then. Any
// OTHER failure throws AccessLookupFailed: the caller holds and retries, or
// sends nothing. A failed check never falls back to the workspace rule.
//
// One "missing" answer is remembered for the life of a projectAccess(db)
// object (one request, one drain or digest run), so a run before 0058 asks
// once, not once per person. A new run asks again: once 0058 is in, the next
// run sees it.
//
// For code that runs AS the person, inside their transaction (the API and
// MCP handlers, under RLS), a failed statement would end the transaction, so
// it never calls a function that might be missing: accessInstalled() asks
// to_regprocedure first (which never errors), and personRankSql() works a
// colleague's rank out with 0058's own rank table from rows the caller can
// already read.
//
// Pure (no Deno globals, no remote imports): vitest runs it with fakes
// (projectAccess.test.ts), the PGlite suite against the real migrations.
// ============================================================
import type { Tx } from "./api/types.ts";

/** Error codes that mean 0058 isn't in: a function, table or column it adds is missing. */
export const MISSING_ACCESS_CODES = ["42883", "PGRST202", "42P01", "PGRST205", "42703", "PGRST204"] as const;

/** Is this error the database saying 0058 isn't in (so today's rule applies)? */
export function isMissingAccessFn(err: unknown): boolean {
  const code = String((err as { code?: unknown } | null)?.code ?? "");
  return (MISSING_ACCESS_CODES as readonly string[]).includes(code);
}

/** A project-access lookup that couldn't be made (anything but "missing"). Never read as "allowed". */
export class AccessLookupFailed extends Error {
  constructor(what: string, cause?: unknown) {
    const c = cause as { code?: unknown; message?: unknown } | null | undefined;
    super(`project access lookup failed (${what}): ${String(c?.code ?? "")} ${String(c?.message ?? cause ?? "")}`.trim().slice(0, 300));
    this.name = "AccessLookupFailed";
  }
}

/** A service-role supabase-js client (only .rpc is used). */
export interface RpcDb {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }> | any;
}
/** Either the supabase-js client or the privileged SQL connection (api/db.ts service). */
export type AccessDb = RpcDb | Tx;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isTx = (db: AccessDb): db is Tx => typeof (db as Tx).query === "function" && typeof (db as RpcDb).rpc !== "function";

export interface ProjectAccess {
  /** the subset of `ids` (in their order) the person may see; before 0058, `ids` as they are */
  visibleTaskIds(userId: string, ids: readonly string[]): Promise<string[]>;
  /** may they see this task? before 0058, yes (the caller's own workspace check still applies) */
  canSeeTask(userId: string, taskId: string): Promise<boolean>;
  /** may they see this project? before 0058, yes */
  canSeeProject(userId: string, projectId: string): Promise<boolean>;
  /** the people (in their order) who may see this task; before 0058, all of them */
  usersWhoCanSeeTask(taskId: string, userIds: readonly string[]): Promise<string[]>;
  /** the people (in their order) who may see this project; before 0058, all of them */
  usersWhoCanSeeProject(projectId: string, userIds: readonly string[]): Promise<string[]>;
  /** the workspace's projects that aren't open to everyone there (lower-case ids); empty while the switch is off or before 0058 */
  closedProjects(workspaceId: string): Promise<Set<string>>;
  /** is this project (tasks.project_id text) open to the whole workspace? a loose id is; before 0058, every one is */
  projectIsOpen(workspaceId: string, projectId: string | null): Promise<boolean>;
  /** 0 none · 1 view · 2 comment · 3 edit; null before 0058 (use the workspace role) */
  projectRank(userId: string, workspaceId: string, projectId: string): Promise<number | null>;
  /** a lookup has said 0058 isn't in: from then on every answer is today's rule, without asking */
  readonly before0058: boolean;
}

type Answer<T> = { missing: true } | { missing: false; value: T };

/** The project-access checks for one request or run (remembers a "missing" answer for its own life). */
export function projectAccess(db: AccessDb): ProjectAccess {
  let missing = false;

  async function ask<T>(fn: string, args: Record<string, unknown>, sql: string, params: unknown[]): Promise<Answer<T>> {
    if (missing) return { missing: true };
    if (isTx(db)) {
      let rows: { v: T }[];
      try { rows = await db.query<{ v: T }>(sql, params); } catch (e) {
        if (isMissingAccessFn(e)) { missing = true; return { missing: true }; }
        throw new AccessLookupFailed(fn, e);
      }
      return { missing: false, value: rows[0]?.v as T };
    }
    let r: { data: unknown; error: unknown } | null | undefined;
    try { r = await db.rpc(fn, args); } catch (e) { throw new AccessLookupFailed(fn, e); }
    if (!r || typeof r !== "object") throw new AccessLookupFailed(fn, "no answer");
    if (r.error) {
      if (isMissingAccessFn(r.error)) { missing = true; return { missing: true }; }
      throw new AccessLookupFailed(fn, r.error);
    }
    return { missing: false, value: r.data as T };
  }

  const canSeeTask = async (userId: string, taskId: string): Promise<boolean> => {
    if (!isUuid(userId) || !isUuid(taskId)) return false;
    const a = await ask<boolean>("user_can_see_task", { p_user: userId, p_task: taskId },
      `select public.user_can_see_task($1::uuid, $2::uuid) as v`, [userId, taskId]);
    return a.missing ? true : a.value === true;
  };
  const canSeeProject = async (userId: string, projectId: string): Promise<boolean> => {
    if (!isUuid(userId) || !isUuid(projectId)) return false;
    const a = await ask<boolean>("user_can_see_project", { p_user: userId, p_project: projectId },
      `select public.user_can_see_project($1::uuid, $2::uuid) as v`, [userId, projectId]);
    return a.missing ? true : a.value === true;
  };
  /** the first check alone (it may say "missing", and then nobody is asked), then the rest together */
  const everyone = async (ids: readonly string[], check: (id: string) => Promise<boolean>): Promise<string[]> => {
    const list = [...new Set(ids)];
    if (!list.length) return [];
    const first = await check(list[0]);
    if (missing) return list;
    const rest = await Promise.all(list.slice(1).map(check));
    return list.filter((_, i) => (i === 0 ? first : rest[i - 1]));
  };

  return {
    get before0058() { return missing; },
    async visibleTaskIds(userId, ids) {
      const wanted = ids.filter(isUuid);
      if (!wanted.length) return [];
      if (!isUuid(userId)) return [];
      const a = await ask<string[] | null>("user_visible_task_ids", { p_user: userId, p_ids: wanted },
        `select coalesce(public.user_visible_task_ids($1::uuid, array(select (jsonb_array_elements_text($2::jsonb))::uuid))::text[], '{}') as v`,
        [userId, JSON.stringify(wanted)]);
      if (a.missing) return [...ids];
      const seen = new Set((Array.isArray(a.value) ? a.value : []).map((x) => String(x).toLowerCase()));
      return ids.filter((id) => seen.has(String(id).toLowerCase()));
    },
    canSeeTask,
    canSeeProject,
    usersWhoCanSeeTask: (taskId, userIds) => everyone(userIds, (u) => canSeeTask(u, taskId)),
    usersWhoCanSeeProject: (projectId, userIds) => everyone(userIds, (u) => canSeeProject(u, projectId)),
    async closedProjects(workspaceId) {
      if (!isUuid(workspaceId)) return new Set();
      const a = await ask<string[] | null>("closed_project_ids", { p_ws: workspaceId },
        `select coalesce(public.closed_project_ids($1::uuid), '{}') as v`, [workspaceId]);
      if (a.missing) return new Set();
      return new Set((Array.isArray(a.value) ? a.value : []).map((x) => String(x).toLowerCase()));
    },
    async projectIsOpen(workspaceId, projectId) {
      if (!projectId || !isUuid(workspaceId)) return true;
      const a = await ask<boolean>("project_is_open", { p_ws: workspaceId, p_project: projectId },
        `select public.project_is_open($1::uuid, $2::text) as v`, [workspaceId, projectId]);
      return a.missing ? true : a.value !== false;
    },
    async projectRank(userId, workspaceId, projectId) {
      if (!isUuid(userId) || !isUuid(workspaceId)) return 0;
      const a = await ask<number | null>("user_project_rank", { p_user: userId, p_ws: workspaceId, p_project: projectId },
        `select public.user_project_rank($1::uuid, $2::uuid, $3::text) as v`, [userId, workspaceId, projectId]);
      if (a.missing) return null;
      const n = Number(a.value);
      return Number.isFinite(n) ? n : 0;
    },
  };
}

/* ---- the design's one-off forms (a fresh projectAccess each time) ---- */

/** user_visible_task_ids: the ones they may see; before 0058, `ids` unchanged. */
export const visibleTaskIds = (db: AccessDb, userId: string, ids: readonly string[]) => projectAccess(db).visibleTaskIds(userId, ids);
/** user_can_see_project; before 0058, true. */
export const canSeeProject = (db: AccessDb, userId: string, projectId: string) => projectAccess(db).canSeeProject(userId, projectId);
/** closed_project_ids as a set; before 0058 (or switched off), empty. */
export const closedProjects = (db: AccessDb, workspaceId: string) => projectAccess(db).closedProjects(workspaceId);
/** user_project_rank; before 0058, null (use the workspace role). */
export const projectRank = (db: AccessDb, userId: string, workspaceId: string, projectId: string) =>
  projectAccess(db).projectRank(userId, workspaceId, projectId);

/** A supabase-js client's table reads (for workspaceAccessOn). */
// deno-lint-ignore no-explicit-any
export type TableDb = { from(table: string): any };

/**
 * Is Project access switched on in this workspace? false before 0058 (no column) or when the row can't be
 * read: only for wording (an invite email), never for deciding who sees what.
 */
export async function workspaceAccessOn(db: TableDb, workspaceId: string): Promise<boolean> {
  if (!isUuid(workspaceId)) return false;
  try {
    const { data, error } = await db.from("workspaces").select("project_access").eq("id", workspaceId).maybeSingle();
    if (error) return false;
    return (data as { project_access?: unknown } | null)?.project_access === true;
  } catch {
    return false;
  }
}

/* ---- inside the person's own transaction (RLS) ---- */

/** Is 0058 in? Asked as the person, inside their transaction: to_regprocedure never errors. */
export async function accessInstalled(tx: Tx): Promise<boolean> {
  const rs = await tx.query<{ on: boolean }>(`select to_regprocedure('public.pa_rank_core(boolean,text,text,boolean,text)') is not null as "on"`);
  return rs[0]?.on === true;
}

/** The caller's own rank on (workspace, tasks.project_id) through 0058's pa_rank. Only once accessInstalled() is true. */
export async function myProjectRank(tx: Tx, workspaceId: string, projectId: string): Promise<number> {
  const rs = await tx.query<{ r: number }>(`select public.pa_rank($1::uuid, $2::text) as r`, [workspaceId, projectId]);
  return Number(rs[0]?.r ?? 0);
}

const UUID_SQL = "'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'";
const asUuidSql = (text: string) => `(case when (${text}) ~* ${UUID_SQL} then (${text})::uuid end)`;

/**
 * SQL: the rank (0..3) the person whose id is the text `userSql` has on the project `projectSql`
 * (tasks.project_id text: a uuid, or a loose id) in the workspace `wsSql` (a uuid expression). It's
 * 0058's own table (pa_rank_core, granted to everyone), fed from rows the caller reads under RLS:
 * the switch, the person's active membership, the project's visibility and owner, and their row in
 * project_members. The caller must be able to see the project (they're writing to it), so all of it
 * is readable to them. Unlike user_project_rank it doesn't know about suspended accounts or binned
 * projects; the database's own trigger is the last word on an assignee. Only once accessInstalled().
 */
export function personRankSql(userSql: string, wsSql: string, projectSql: string): string {
  const u = asUuidSql(userSql);
  const p = asUuidSql(projectSql);
  return `coalesce((select public.pa_rank_core(coalesce(paw.project_access, false),
      coalesce((select pam.role from public.workspace_members pam
                 where pam.workspace_id = paw.id and pam.user_id = ${u} and pam.status = 'active' limit 1),
               case when paw.owner_id = ${u} then 'owner' end, 'none'),
      pap.visibility, coalesce(pap.owner_id = ${u}, false),
      (select papm.role from public.project_members papm where papm.project_id = pap.id and papm.user_id = ${u}))
    from public.workspaces paw left join public.projects pap on pap.id = ${p} and pap.workspace_id = paw.id
   where paw.id = ${wsSql}), 0)`;
}
