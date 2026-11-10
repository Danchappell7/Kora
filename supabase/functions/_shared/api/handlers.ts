// ============================================================
// KANBO — public API v1: the endpoints (0046).                   [a1]
//
// Every handler reads and writes ONLY through asUser(ctx, tx => …): one
// transaction as the key's user, so RLS decides what exists, the "api key
// scope" policies pin a team key to its workspace, and GETs / read keys
// run READ ONLY. Inside it we query tables (plus the can_* / ws_role
// helpers the policies use) — never a SECURITY DEFINER function that
// would see past the key's scope.
//
// A team key's workspace is also filtered for explicitly (keyWorkspace):
// every row a handler reads by id or lists must be in it, so the key stays
// inside its workspace even if the restrictive policies were ever missing
// (verify_api_key also refuses team keys then). Personal keys: no filter.
//
// The checks here come on top of RLS so callers get clear answers:
// 404 for things they can't see, 403 for things they can see but not
// change, 422 naming the field. RLS stays the last word either way.
//
// Project access (0058): RLS already keeps a Members only or Private project
// to its people. On top, for clear answers: writing into a project (a task,
// a section, a move, the project itself) needs edit rights on it (403 "You
// can see this project but can't change it."); a viewer or a guest who isn't
// a commenter can't comment (403); and an assignee, a rule's assignee and the
// people kept on a moved task must be able to see the project it's in (an
// assignee who can't: 422 on assigneeId; on a move they're replaced by you).
// Every check is made as the key's user inside their transaction, and only
// once 0058 is in (accessInstalled asks to_regprocedure, which never fails),
// so before 0058 nothing here changes.
//
// Like the app: project automation rules run on create / status change /
// completion (automationRules.ts, each value checked), and moving a task
// out of a workspace is for its makers or that workspace's owners and
// admins. Completing a repeating task makes its next occurrence, and a new
// assignee clears the old one's plan. If-Match on a write is checked with the
// row locked (412).
//
// Pure module (no Deno globals): exercised by supabase/tests/pglite against the
// real migrations.
// ============================================================
import { planRules, type RuleRow, type RuleTrigger } from "../automationRules.ts";
import type { NlpRecurrence } from "../nlp.ts";
import { nextOccurrenceDates, shiftISO } from "../recurrence.ts";
import { dateInZone, DEFAULT_TIMEZONE, isTimeZone, localMidnight } from "../zone.ts";
import {
  API_PRIORITIES, serialiseComment, serialiseMember, serialiseProject, serialiseSection, serialiseTask, serialiseWorkspace,
  type ApiMe,
} from "./serialise.ts";
import {
  ApiFail, asUser, assertInScope, badQuery, BUILTIN_TAGS, etagFor, etagMatches, forbidden, invalid, keyWorkspace, list, notFound, ok,
  OUTSIDE_WORKSPACE, preconditionFailed, Sql,
} from "./core.ts";
import {
  API_LIMITS, checkCommentCreate, checkProjectCreate, checkProjectPatch, checkSectionCreate, checkTaskCreate, checkTaskPatch,
  cursorKeySql, decodeCursor, encodeCursor, escapeLike, isUuid, parseBool, parsePageQuery, parseProjectQuery,
  parseTaskQuery, PERSONAL_PROJECT_ID, queryFingerprint, unknownParams, UUID_RE, type Cursor, type TaskInput,
} from "./validate.ts";
import type { RouteContext } from "./router.ts";
import type { Tx } from "./types.ts";
import { slackPermalinkOf } from "../slackPermalink.ts";
import { accessInstalled, myProjectRank, personRankSql } from "../projectAccess.ts";

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v == null || v === "" ? null : String(v));
/** a text[] column as strings ([] when empty) */
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/* ------------------------------------------------------------ SQL pieces */

export const TASK_COLS = `t.id::text as id, t.user_id::text as user_id, t.title, t.description, t.status, t.priority,
  t.project_id, t.section_id, t.parent_id::text as parent_id, t.assignee_id, t.workspace_id::text as workspace_id,
  t.due_date::text as due_date, t.due_time, t.start_date::text as start_date, t.completed_at::text as completed_at,
  t.tags, t.effort_hours::float8 as effort_hours, t.logged_hours::float8 as logged_hours, t.is_milestone, t.recurrence,
  t.archived_at, t.created_at, t.updated_at,
  (to_jsonb(t) ->> 'slack_permalink') as slack_permalink`;

const PROJECT_COLS = `p.id::text as id, p.user_id::text as user_id, p.workspace_id::text as workspace_id, p.name, p.emoji,
  p.color, p.description, p.status, p.owner_id::text as owner_id, p.contributor_ids::text[] as contributor_ids,
  p.archived_at, p.created_at, (to_jsonb(p) ->> 'visibility') as visibility`;

const SECTION_COLS = `s.id::text as id, s.project_id, s.workspace_id::text as workspace_id, s.name, s.position, s.created_at`;

const COMMENT_COLS = `c.id::text as id, c.task_id::text as task_id, c.parent_id::text as parent_id, c.user_id::text as user_id,
  c.author_name, c.body, c.mentions::text[] as mentions, c.created_at`;

const WRITER_ROLES = ["owner", "admin", "member"];
const GUEST_READ_ONLY = "Guests can view this workspace but can't add or change things in it.";
/** a built-in tag id ("design", …) — never an inherited key such as "constructor" */
const isBuiltinTag = (id: string) => Object.prototype.hasOwnProperty.call(BUILTIN_TAGS, id);

/* ------------------------------------------------------------ shared lookups */

function pathId(ctx: RouteContext, what: string): string {
  const id = ctx.params.id;
  if (!isUuid(id)) throw notFound(what);
  return id.toLowerCase();
}

async function wsRole(tx: Tx, ws: string): Promise<string> {
  const rs = await tx.query<{ role: string | null }>(`select public.ws_role($1::uuid) as role`, [ws]);
  return String(rs[0]?.role ?? "none");
}

function requireWriter(role: string) {
  if (WRITER_ROLES.includes(role)) return;
  if (role === "guest") throw forbidden(GUEST_READ_ONLY);
  throw notFound("Workspace");
}

/** Is 0058 in? Asked once per transaction (as the key's user). */
const installed = new WeakMap<Tx, Promise<boolean>>();
function accessOn(tx: Tx): Promise<boolean> {
  if (!installed.has(tx)) installed.set(tx, accessInstalled(tx));
  return installed.get(tx)!;
}

const CANT_CHANGE_PROJECT = "You can see this project but can't change it.";

/** Writing into a team project (a task, a section, a move, the project itself) needs edit rights on it (0058). */
async function requireProjectEditor(tx: Tx, ws: string, project: string): Promise<void> {
  if (!(await accessOn(tx))) return;
  if ((await myProjectRank(tx, ws, project)) < 3) throw forbidden(CANT_CHANGE_PROJECT);
}

/** Can this person see `project` (tasks.project_id) in `ws`? Always, before 0058. */
async function seesProject(tx: Tx, ws: string, user: string, project: string): Promise<boolean> {
  if (!(await accessOn(tx))) return true;
  const rs = await tx.query<{ r: number }>(`select ${personRankSql("$1::text", "$2::uuid", "$3::text")} as r`, [user, ws, project]);
  return Number(rs[0]?.r ?? 0) >= 1;
}

async function workspaceVisible(tx: Tx, ws: string): Promise<boolean> {
  const rs = await tx.query<{ ok: boolean }>(`select exists (select 1 from public.workspaces w where w.id = $1::uuid) as ok`, [ws]);
  return rs[0]?.ok === true;
}

/** SQL: `col` is in the key's workspace ($n holds keyWorkspace(): null = a personal key, no filter). */
export const inKeyWs = (col: string, n: number) => `($${n}::uuid is null or ${col} = $${n}::uuid)`;

/** A project the key can reach (RLS, and a team key's own workspace), or null. */
async function loadProject(tx: Tx, id: string, kws: string | null): Promise<Row | null> {
  const rs = await tx.query(`select ${PROJECT_COLS} from public.projects p where p.id = $1::uuid and ${inKeyWs("p.workspace_id", 2)}`, [id, kws]);
  return rs[0] ?? null;
}

/** A task the key can reach (RLS, and a team key's own workspace), or null. `extras` may use $2 (kws). */
async function loadTask(tx: Tx, id: string, kws: string | null, extras = ""): Promise<Row | null> {
  const rs = await tx.query(`select ${TASK_COLS}${extras} from public.tasks t where t.id = $1::uuid and ${inKeyWs("t.workspace_id", 2)}`, [id, kws]);
  return rs[0] ?? null;
}

/** Is there a task with this id the key can reach? */
async function taskVisible(tx: Tx, id: string, kws: string | null): Promise<boolean> {
  return (await tx.query(`select 1 from public.tasks t where t.id = $1::uuid and ${inKeyWs("t.workspace_id", 2)}`, [id, kws])).length > 0;
}

/** tag id → label / colour for the tags these tasks carry (built-ins + the tags table, as the user sees it). */
async function tagMap(tx: Tx, rows: Row[], kws: string | null): Promise<Map<string, { label: string | null; color: string | null }>> {
  const ids = new Set<string>();
  for (const r of rows) for (const t of (Array.isArray(r.tags) ? r.tags : [])) ids.add(String(t));
  const map = new Map<string, { label: string | null; color: string | null }>();
  for (const id of ids) if (isBuiltinTag(id)) map.set(id, BUILTIN_TAGS[id]);
  const uuids = [...ids].filter(isUuid);
  if (uuids.length) {
    const rs = await tx.query<{ id: string; label: string; color: string }>(
      `select g.id::text as id, g.label, g.color from public.tags g
        where g.id in (select (jsonb_array_elements_text($1::jsonb))::uuid) and ${inKeyWs("g.workspace_id", 2)}`, [JSON.stringify(uuids), kws]);
    for (const r of rs) map.set(r.id, { label: r.label, color: r.color });
  }
  return map;
}

export async function serialiseTasks(ctx: RouteContext, tx: Tx, rows: Row[]) {
  const tags = await tagMap(tx, rows, keyWorkspace(ctx.principal));
  return rows.map((r) => serialiseTask(r, { appUrl: ctx.appUrl, tags }));
}

/** Is this person in `ws` (null = Personal: only you)? */
async function inTaskWorkspace(tx: Tx, ws: string | null, user: string, me: string): Promise<boolean> {
  if (user === me) return true;
  if (!ws || !isUuid(user)) return false;
  const rs = await tx.query<{ ok: boolean }>(
    `select (exists (select 1 from public.workspace_members m
                      where m.workspace_id = $1::uuid and m.user_id = $2::uuid and m.status = 'active')
          or exists (select 1 from public.workspaces w where w.id = $1::uuid and w.owner_id = $2::uuid)) as ok`, [ws, user]);
  return rs[0]?.ok === true;
}

/** Can this person be on a task in `ws` (null = Personal: only you), in `project` (0058: they must be able to see it)? */
async function canBeOnTask(tx: Tx, ws: string | null, user: string, me: string, project?: string): Promise<boolean> {
  if (!(await inTaskWorkspace(tx, ws, user, me))) return false;
  return user === me || !ws || project === undefined || seesProject(tx, ws, user, project);
}

/** assigneeId input → the tasks.assignee_id value ('' = unassigned), for a task in `project`. */
async function resolveAssignee(tx: Tx, input: string | null, ws: string | null, me: string, project?: string): Promise<string> {
  if (input === null) return "";
  const user = input === "me" ? me : input;
  if (!(await inTaskWorkspace(tx, ws, user, me))) {
    throw invalid({ assigneeId: ws ? "That person isn't an active member of this task's workspace." : "Tasks in your Personal list can only be assigned to you." });
  }
  if (ws && user !== me && project !== undefined && !(await seesProject(tx, ws, user, project))) {
    throw invalid({ assigneeId: "That person can't see this project." });
  }
  return user;
}

/** SQL: is the person in `col` (a user id as text) allowed on a task in `ws`? Mirrors the app's retarget(). With
 *  `project` (only once 0058 is in): they must be able to see that project too. */
function visibleSql(q: Sql, col: string, ws: string | null, me: string, project: string | null = null): string {
  if (!ws) return `(${col} = '' or ${col} = ${q.p(me)})`;
  const w = q.p(ws);
  const member = `exists (select 1 from public.workspace_members m where m.workspace_id = ${w}::uuid and m.status = 'active' and m.user_id::text = ${col})
    or exists (select 1 from public.workspaces w2 where w2.id = ${w}::uuid and w2.owner_id::text = ${col})`;
  if (project === null) return `(${col} = '' or ${col} = ${q.p(me)}
    or ${member})`;
  return `(${col} = '' or ${col} = ${q.p(me)}
    or ((${member}) and ${personRankSql(col, `${w}::uuid`, `${q.p(project)}::text`)} >= 1))`;
}

/** Tag ids or labels → tag ids for a task in `ws`: built-ins, existing tags, or new ones (labels). */
async function resolveTags(tx: Tx, items: string[], ws: string | null, me: string): Promise<string[]> {
  const out: string[] = [];
  const scope = `g.workspace_id is not distinct from $2::uuid and (g.workspace_id is not null or g.user_id = $3::uuid)`;
  for (const item of items) {
    let id: string | null = null;
    if (isBuiltinTag(item)) id = item;
    else if (UUID_RE.test(item)) {
      const rs = await tx.query<{ id: string }>(`select g.id::text as id from public.tags g where g.id = $1::uuid and ${scope}`, [item.toLowerCase(), ws, me]);
      if (!rs[0]) throw invalid({ tags: `There's no tag ${item} in this ${ws ? "workspace" : "Personal list"}.` });
      id = rs[0].id;
    } else {
      const rs = await tx.query<{ id: string }>(
        `select g.id::text as id from public.tags g where lower(g.label) = lower($1) and ${scope} order by g.created_at, g.id limit 1`, [item, ws, me]);
      if (rs[0]) id = rs[0].id;
      else {
        const builtin = Object.entries(BUILTIN_TAGS).find(([, t]) => t.label.toLowerCase() === item.toLowerCase());
        if (builtin) id = builtin[0];
        else {
          const made = await tx.query<{ id: string }>(
            `insert into public.tags (user_id, label, workspace_id) values ($1::uuid, $2, $3::uuid) returning id::text as id`, [me, item, ws]);
          id = made[0].id;
        }
      }
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/* ------------------------------------------------------------ automation rules */

/** What a project's rules do to a task, every value already checked. */
interface RuleEffect { priority?: string; assigneeId?: string; sectionId?: string; addTags: string[] }

/** Rule tag values → tag ids a task in `ws` may carry: built-in ids, this workspace's tags (your own
 *  personal ones for a personal task) by id, or a label exactly one of those has. Never makes a tag. */
async function ruleTags(tx: Tx, values: string[], ws: string | null, me: string): Promise<string[]> {
  const out: string[] = [];
  const scope = `g.workspace_id is not distinct from $1::uuid and (g.workspace_id is not null or g.user_id = $2::uuid)`;
  for (const value of values.slice(0, 50)) {
    let id: string | null = null;
    if (isBuiltinTag(value)) id = value;
    else if (UUID_RE.test(value)) {
      const rs = await tx.query<{ id: string }>(`select g.id::text as id from public.tags g where g.id = $3::uuid and ${scope}`, [ws, me, value.toLowerCase()]);
      id = rs[0]?.id ?? null;
    } else {
      // older rules stored the tag's name (the app's resolveTagId): only an unambiguous one counts
      const want = value.trim().toLowerCase();
      const rs = await tx.query<{ id: string }>(
        `select g.id::text as id from public.tags g where lower(btrim(g.label)) = $3 and ${scope} limit 2`, [ws, me, want]);
      const hits = [...Object.entries(BUILTIN_TAGS).filter(([, t]) => t.label.toLowerCase() === want).map(([k]) => k), ...rs.map((r) => r.id)];
      if (hits.length === 1) id = hits[0];
    }
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The project's enabled rules for these triggers, as the key's user sees them (RLS; a team key only its
 * workspace's), oldest first: the rules of the task's own workspace, or your own for a personal task
 * (project ids are free text, so a rule elsewhere naming this id never counts). Folded the app's way
 * (later rules win, tags add up), then each value checked: a priority Kanbo knows, an assignee who can
 * be on the task, a section of this project, a tag the task may carry. Anything else is skipped.
 */
async function ruleEffect(tx: Tx, triggers: RuleTrigger[], project: string, ws: string | null, me: string): Promise<RuleEffect> {
  const out: RuleEffect = { addTags: [] };
  const rules = await tx.query<RuleRow>(
    `select r.user_id::text as user_id, r.workspace_id::text as workspace_id, r.project_id, r.trigger, r.actions, r.enabled
       from public.automation_rules r
      where r.project_id = $1 and r.enabled and r.trigger in (select jsonb_array_elements_text($2::jsonb))
        and r.workspace_id is not distinct from $3::uuid and (r.workspace_id is not null or r.user_id = $4::uuid)
      order by r.created_at, r.id limit 50`, [project, JSON.stringify(triggers), ws, me]);
  if (!rules.length) return out;
  const plan = planRules(rules, triggers);
  if (plan.priority && (API_PRIORITIES as readonly string[]).includes(plan.priority)) out.priority = plan.priority;
  if (plan.assigneeId) {
    const who = plan.assigneeId.toLowerCase();
    if (isUuid(who) && await canBeOnTask(tx, ws, who, me, project)) out.assigneeId = who;
  }
  if (plan.sectionId && isUuid(plan.sectionId)) {
    const sec = await tx.query<{ id: string }>(`select s.id::text as id from public.sections s where s.id = $1::uuid and s.project_id = $2`,
      [plan.sectionId.toLowerCase(), project]);
    if (sec[0]) out.sectionId = sec[0].id;
  }
  out.addTags = await ruleTags(tx, plan.tags.map((t) => t.value), ws, me);
  return out;
}

/** `base` plus the rules' tags, in order, once each. */
const withTags = (base: string[], add: string[]) => [...new Set([...base, ...add])];

/* ------------------------------------------------------------ pagination */

async function readCursor(raw: string | undefined, mode: string, fp: string): Promise<Cursor | null> {
  if (!raw) return null;
  const c = decodeCursor(raw);
  if (!c || c.m !== mode || c.f !== fp) throw badQuery({ cursor: "This cursor doesn't belong to this request. Start again without it." });
  return c;
}

/** `rows` were fetched with limit + 1: the page and the next cursor (null on the last page). */
function pageOf(rows: Row[], limit: number, mode: string, fp: string, keyField = "_ck") {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const next = rows.length > limit && last ? encodeCursor({ m: mode, k: String(last[keyField]), i: String(last.id), f: fp }) : null;
  return { page, next };
}

/** `and (col, id) > / < (cursor)` */
function after(q: Sql, c: Cursor | null, col: string, idCol: string, dir: "asc" | "desc"): string {
  if (!c) return "";
  return ` and (${col}, ${idCol}) ${dir === "asc" ? ">" : "<"} (${q.p(c.k)}::timestamp at time zone 'UTC', ${q.p(c.i)}::uuid)`;
}

/* ============================================================ me, workspaces, members */

export async function getMe(ctx: RouteContext): Promise<Response> {
  if (unknownParams(ctx.url.searchParams, []).length) throw badQuery({ query: "This endpoint takes no query parameters." });
  const rows = await asUser(ctx, (tx) => tx.query(
    `select nullif(p.email, '') as email,
            nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), '') as name
       from public.profiles p where p.id = $1::uuid`, [ctx.principal.userId]));
  const r = rows[0] ?? {};
  const me: ApiMe = {
    object: "user",
    id: ctx.principal.userId,
    email: s(r.email),
    name: s(r.name),
    key: { id: ctx.principal.keyId, access: ctx.principal.access, workspaceId: ctx.principal.workspaceId },
  };
  return ok(ctx, me);
}

export async function listWorkspaces(ctx: RouteContext): Promise<Response> {
  if (unknownParams(ctx.url.searchParams, []).length) throw badQuery({ query: "This endpoint takes no query parameters." });
  const rows = await asUser(ctx, (tx) => tx.query(
    `select w.id::text as id, w.name, w.logo_url, w.owner_id::text as owner_id, w.created_at, public.ws_role(w.id) as role
       from public.workspaces w where ${inKeyWs("w.id", 1)} order by w.created_at, w.id limit 500`, [keyWorkspace(ctx.principal)]));
  return ok(ctx, list(rows.filter((r) => r.role !== "none").map(serialiseWorkspace), null));
}

export async function listMembers(ctx: RouteContext): Promise<Response> {
  const pq = parsePageQuery(ctx.url.searchParams, ["workspace"]);
  if (!pq.ok) throw badQuery(pq.fields);
  const raw = pq.value.extra.workspace ?? ctx.principal.workspaceId;
  if (!raw) throw badQuery({ workspace: "Say which workspace: ?workspace=<id> (GET /workspaces lists them)." });
  if (!isUuid(raw)) throw badQuery({ workspace: "Use a workspace id." });
  const ws = raw.toLowerCase();
  assertInScope(ctx.principal, ws);
  const fp = await queryFingerprint({ r: "members", ws });
  const cur = await readCursor(pq.value.cursor, "m", fp);
  const rows = await asUser(ctx, async (tx) => {
    if (!(await workspaceVisible(tx, ws))) throw notFound("Workspace");
    const q = new Sql();
    const sql = `select m.id::text as id, m.workspace_id::text as workspace_id, m.user_id::text as user_id,
        coalesce(nullif(btrim(coalesce(pr.first_name, '') || ' ' || coalesce(pr.last_name, '')), ''), nullif(m.name, ''), m.email) as name,
        m.email, m.role, m.status, m.title, m.created_at, ${cursorKeySql("m.created_at")} as _ck
      from public.workspace_members m left join public.profiles pr on pr.id = m.user_id
      where m.workspace_id = ${q.p(ws)}::uuid${after(q, cur, "m.created_at", "m.id", "asc")}
      order by m.created_at, m.id limit ${q.p(pq.value.limit + 1)}::int`;
    return tx.query(sql, q.params);
  });
  const { page, next } = pageOf(rows, pq.value.limit, "m", fp);
  return ok(ctx, list(page.map(serialiseMember), next));
}

/* ============================================================ projects */

export async function listProjects(ctx: RouteContext): Promise<Response> {
  const pq = parseProjectQuery(ctx.url.searchParams);
  if (!pq.ok) throw badQuery(pq.fields);
  const v = pq.value;
  if (v.workspace) assertInScope(ctx.principal, v.workspace === "personal" ? null : v.workspace);
  const fp = await queryFingerprint({ r: "projects", ws: v.workspace, a: v.includeArchived });
  const cur = await readCursor(v.cursor, "p", fp);
  const rows = await asUser(ctx, (tx) => {
    const q = new Sql();
    const where: string[] = ["true"];
    if (v.workspace === "personal") where.push("p.workspace_id is null");
    else if (v.workspace) where.push(`p.workspace_id = ${q.p(v.workspace)}::uuid`);
    const kws = keyWorkspace(ctx.principal);
    if (kws) where.push(`p.workspace_id = ${q.p(kws)}::uuid`);
    if (!v.includeArchived) where.push("p.archived_at is null");
    const sql = `select ${PROJECT_COLS}, ${cursorKeySql("p.created_at")} as _ck from public.projects p
      where ${where.join(" and ")}${after(q, cur, "p.created_at", "p.id", "asc")}
      order by p.created_at, p.id limit ${q.p(v.limit + 1)}::int`;
    return tx.query(sql, q.params);
  });
  const { page, next } = pageOf(rows, v.limit, "p", fp);
  return ok(ctx, list(page.map((r) => serialiseProject(r, { appUrl: ctx.appUrl })), next));
}

export async function getProject(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Project");
  const row = await asUser(ctx, (tx) => loadProject(tx, id, keyWorkspace(ctx.principal)));
  if (!row) throw notFound("Project");
  return ok(ctx, serialiseProject(row, { appUrl: ctx.appUrl }));
}

export async function createProject(ctx: RouteContext): Promise<Response> {
  const c = checkProjectCreate(ctx.body ?? {});
  if (!c.ok) throw invalid(c.fields);
  const v = c.value;
  const p = ctx.principal;
  // a team key's projects live in its workspace; a personal key's default to the Personal list
  const ws = v.workspaceId !== undefined ? v.workspaceId : p.workspaceId;
  assertInScope(p, ws);
  const row = await asUser(ctx, async (tx) => {
    if (ws) requireWriter(await wsRole(tx, ws));
    // who can see it (0058): left out, the workspace's default for new projects (the database fills it in)
    if (v.visibility !== undefined) {
      if (!ws) throw invalid({ visibility: "A Personal project is only ever yours: leave visibility out." });
      if (!(await accessOn(tx))) throw invalid({ visibility: "Project access isn't available yet, so leave visibility out." });
      if (v.visibility === "private") {
        const [may] = await tx.query<{ ok: boolean }>(`select public.pa_may_make_private($1::uuid) as ok`, [ws]);
        if (may?.ok !== true) throw forbidden("You can't make private projects in this workspace.");
      }
    }
    const q = new Sql();
    const me = q.p(p.userId);
    const vis = v.visibility !== undefined ? { col: ", visibility", val: `, ${q.p(v.visibility)}` } : { col: "", val: "" };
    const made = await tx.query<{ id: string }>(
      `insert into public.projects (user_id, owner_id, name, workspace_id, emoji, color, description, status${vis.col})
       values (${me}::uuid, ${me}::uuid, ${q.p(v.name)}, ${q.p(ws)}::uuid, coalesce(${q.p(v.emoji ?? null)}, '📁'),
               coalesce(${q.p(v.color ?? null)}, 'oklch(0.74 0.14 230)'), ${q.p(v.description ?? null)}, ${q.p(v.status ?? null)}${vis.val})
       returning id::text as id`, q.params);
    return loadProject(tx, made[0].id, keyWorkspace(p));
  });
  if (!row) throw new ApiFail(500, "internal", "The project was made but couldn't be read back.");
  const out = serialiseProject(row, { appUrl: ctx.appUrl });
  return ok(ctx, out, 201, { Location: `${ctx.apiBase}/projects/${row.id}`, ETag: await etagFor(out) });
}

export async function updateProject(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Project");
  const c = checkProjectPatch(ctx.body ?? {});
  if (!c.ok) throw invalid(c.fields);
  const v = c.value;
  const kws = keyWorkspace(ctx.principal);
  const row = await asUser(ctx, async (tx) => {
    // a team project: owners, admins and members; with Project access (0058), edit rights on this project
    const team = (await accessOn(tx)) ? "public.can_write(p.workspace_id) and public.pa_rank(p.workspace_id, p.id::text) >= 3" : "public.can_write(p.workspace_id)";
    const rs = await tx.query<{ can_edit: boolean }>(
      `select case when p.workspace_id is null then p.user_id = auth.uid() and public.can_act()
                   else ${team} end as can_edit
         from public.projects p where p.id = $1::uuid and ${inKeyWs("p.workspace_id", 2)}`, [id, kws]);
    if (!rs[0]) throw notFound("Project");
    if (!rs[0].can_edit) throw forbidden(CANT_CHANGE_PROJECT);
    const ifMatch = ctx.req.headers.get("if-match");
    if (ifMatch !== null) {
      // held until this transaction ends: nobody changes it between the check and the write
      await tx.query(`select 1 from public.projects p where p.id = $1::uuid for update`, [id]);
      const now = await loadProject(tx, id, kws);
      if (!now || !etagMatches(ifMatch, await etagFor(serialiseProject(now, { appUrl: ctx.appUrl })))) throw preconditionFailed("project");
    }
    const q = new Sql();
    const sets: string[] = [];
    if (v.name !== undefined) sets.push(`name = ${q.p(v.name)}`);
    if (v.emoji !== undefined) sets.push(`emoji = coalesce(${q.p(v.emoji)}, '📁')`);
    if (v.color !== undefined) sets.push(`color = coalesce(${q.p(v.color)}, 'oklch(0.74 0.14 230)')`);
    if (v.description !== undefined) sets.push(`description = ${q.p(v.description)}`);
    if (v.status !== undefined) sets.push(`status = ${q.p(v.status)}`);
    if (v.archived !== undefined) sets.push(v.archived ? "archived_at = coalesce(archived_at, now())" : "archived_at = null");
    if (sets.length) {
      const done = await tx.query(`update public.projects p set ${sets.join(", ")}
        where p.id = ${q.p(id)}::uuid and ${inKeyWs("p.workspace_id", q.params.length + 1)} returning p.id`, [...q.params, kws]);
      if (!done.length) throw forbidden("You can see this project but can't change it.");
    }
    return loadProject(tx, id, kws);
  });
  if (!row) throw notFound("Project");
  const out = serialiseProject(row, { appUrl: ctx.appUrl });
  return ok(ctx, out, 200, { ETag: await etagFor(out) });
}

/* ============================================================ sections */

export async function listSections(ctx: RouteContext): Promise<Response> {
  const sp = ctx.url.searchParams;
  const extra = unknownParams(sp, ["project"]);
  if (extra.length) throw badQuery(Object.fromEntries(extra.map((k) => [k, "Unknown query parameter."])));
  const project = sp.get("project");
  if (!project) throw badQuery({ project: "Say which project: ?project=<id>." });
  if (!isUuid(project)) throw badQuery({ project: "Use a project id." });
  const pid = project.toLowerCase();
  const kws = keyWorkspace(ctx.principal);
  const rows = await asUser(ctx, async (tx) => {
    if (!(await loadProject(tx, pid, kws))) throw notFound("Project");
    // a project has a handful of sections: all of them, in board order
    return tx.query(`select ${SECTION_COLS} from public.sections s where s.project_id = $1 and ${inKeyWs("s.workspace_id", 2)}
      order by s.position nulls last, s.created_at, s.id limit 500`, [pid, kws]);
  });
  return ok(ctx, list(rows.map(serialiseSection), null));
}

export async function createSection(ctx: RouteContext): Promise<Response> {
  const c = checkSectionCreate(ctx.body ?? {});
  if (!c.ok) throw invalid(c.fields);
  const v = c.value;
  const row = await asUser(ctx, async (tx) => {
    const proj = await loadProject(tx, v.projectId, keyWorkspace(ctx.principal));
    if (!proj) throw invalid({ projectId: "There's no project with that id (or you can't see it)." });
    const ws = s(proj.workspace_id);
    assertInScope(ctx.principal, ws);
    if (ws) requireWriter(await wsRole(tx, ws));
    if (ws) await requireProjectEditor(tx, ws, v.projectId);
    const rs = await tx.query(
      `insert into public.sections (user_id, workspace_id, project_id, name, position)
       values ($1::uuid, $2::uuid, $3, $4, extract(epoch from clock_timestamp()) * 1000)
       returning id::text as id, project_id, workspace_id::text as workspace_id, name, position, created_at`,
      [ctx.principal.userId, ws, v.projectId, v.name]);
    return rs[0];
  });
  return ok(ctx, serialiseSection(row), 201);
}

/* ============================================================ tasks */

export async function listTasks(ctx: RouteContext): Promise<Response> {
  const pq = parseTaskQuery(ctx.url.searchParams);
  if (!pq.ok) throw badQuery(pq.fields);
  const v = pq.value;
  const p = ctx.principal;
  if (v.workspace) assertInScope(p, v.workspace === "personal" ? null : v.workspace);
  if (p.workspaceId && v.project === PERSONAL_PROJECT_ID) throw forbidden(OUTSIDE_WORKSPACE);
  const mode = v.updatedSince ? "u" : "c";
  const { cursor: _c, limit: _l, ...filters } = v;
  const fp = await queryFingerprint({ r: "tasks", ...filters, me: v.assignee === "me" ? p.userId : undefined });
  const cur = await readCursor(v.cursor, mode, fp);

  const rows = await asUser(ctx, async (tx) => {
    const q = new Sql();
    const where: string[] = ["true"];
    if (v.workspace === "personal") where.push("t.workspace_id is null");
    else if (v.workspace) where.push(`t.workspace_id = ${q.p(v.workspace)}::uuid`);
    const kws = keyWorkspace(p);
    if (kws) where.push(`t.workspace_id = ${q.p(kws)}::uuid`);
    if (v.project) where.push(`t.project_id = ${q.p(v.project)}`);
    if (v.section) where.push(`t.section_id = ${q.p(v.section)}`);
    if (v.assignee === "none") where.push(`t.assignee_id = ''`);
    else if (v.assignee) where.push(`t.assignee_id = ${q.p(v.assignee === "me" ? p.userId : v.assignee)}`);
    if (v.parent === "none") where.push("t.parent_id is null");
    else if (v.parent) where.push(`t.parent_id = ${q.p(v.parent)}::uuid`);
    if (v.status) where.push(`t.status in (select jsonb_array_elements_text(${q.p(JSON.stringify(v.status))}::jsonb))`);
    if (v.dueBefore) where.push(`t.due_date <= ${q.p(v.dueBefore)}::date`);
    if (v.dueAfter) where.push(`t.due_date >= ${q.p(v.dueAfter)}::date`);
    if (v.updatedSince) where.push(`t.updated_at >= ${q.p(v.updatedSince)}::timestamptz`);
    if (!v.includeArchived) where.push("t.archived_at is null");
    if (v.q) {
      const like = q.p(`%${escapeLike(v.q)}%`);
      where.push(`(t.title ilike ${like} escape '\\' or t.description ilike ${like} escape '\\')`);
    }
    const order = mode === "u" ? "t.updated_at asc, t.id asc" : "t.created_at desc, t.id desc";
    const keyset = mode === "u" ? after(q, cur, "t.updated_at", "t.id", "asc") : after(q, cur, "t.created_at", "t.id", "desc");
    const sql = `select ${TASK_COLS}, ${cursorKeySql(mode === "u" ? "t.updated_at" : "t.created_at")} as _ck
      from public.tasks t where ${where.join(" and ")}${keyset}
      order by ${order} limit ${q.p(v.limit + 1)}::int`;
    const rs = await tx.query(sql, q.params);
    const tags = await tagMap(tx, rs.slice(0, v.limit), kws);
    return { rs, tags };
  });
  const { page, next } = pageOf(rows.rs, v.limit, mode, fp);
  return ok(ctx, list(page.map((r) => serialiseTask(r, { appUrl: ctx.appUrl, tags: rows.tags })), next));
}

/** A task exactly as GET /tasks/:id shows it (with subtaskIds / dependencyIds): its ETag is GET's. */
async function fullTask(ctx: RouteContext, tx: Tx, id: string) {
  const row = await loadTask(tx, id, keyWorkspace(ctx.principal), `,
      array(select c.id::text from public.tasks c where c.parent_id = t.id and ${inKeyWs("c.workspace_id", 2)} order by c.created_at, c.id) as subtask_ids,
      array(select d.depends_on::text from public.task_dependencies d where d.task_id = t.id order by d.depends_on) as dependency_ids`);
  if (!row) throw notFound("Task");
  return (await serialiseTasks(ctx, tx, [row]))[0];
}

export async function getTask(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  if (unknownParams(ctx.url.searchParams, []).length) throw badQuery({ query: "This endpoint takes no query parameters." });
  const out = await asUser(ctx, (tx) => fullTask(ctx, tx, id));
  return ok(ctx, out);
}

/** Read a task back after a write (inside the same transaction), as GET shows it. */
const readBack = fullTask;

/** A written task's answer: GET's shape, with the ETag a later If-Match needs. */
async function taskAnswer(ctx: RouteContext, task: Awaited<ReturnType<typeof fullTask>>, status = 200, headers: Record<string, string> = {}, next: NextOccurrence | null = null) {
  return ok(ctx, next ? { ...task, nextOccurrence: next } : task, status, { ...headers, ETag: await etagFor(task) });
}

export function createTask(ctx: RouteContext): Promise<Response> {
  return createTaskWith(ctx);
}

/** What Kanbo's own integrations may add to a new task that API callers can't (0049). */
export interface TaskCreateExtras {
  /** the Slack message the task was made from (the Slack app); must be a Slack message link */
  slackPermalink?: string | null;
}

/** POST /tasks, for the API and for Kanbo's own integrations (the Slack app also records the Slack message). */
export async function createTaskWith(ctx: RouteContext, extras: TaskCreateExtras = {}): Promise<Response> {
  const permalink = extras.slackPermalink ? slackPermalinkOf(extras.slackPermalink) : null;
  if (extras.slackPermalink && !permalink) throw invalid({ slackPermalink: "That isn't a Slack message link." });
  const c = checkTaskCreate(ctx.body ?? {});
  if (!c.ok) throw invalid(c.fields);
  const v = c.value;
  const p = ctx.principal;
  const me = p.userId;
  const task = await asUser(ctx, async (tx) => {
    // the parent, if it's a sub-task
    let parent: Row | null = null;
    if (v.parentId) {
      parent = (await loadTask(tx, v.parentId, keyWorkspace(p))) ?? null;
      if (!parent) throw invalid({ parentId: "There's no task with that id (or you can't see it)." });
    }
    // where it lives: the project (or the parent's project, or the Personal list)
    const target = v.projectId !== undefined ? (v.projectId ?? PERSONAL_PROJECT_ID)
      : parent ? String(parent.project_id) : PERSONAL_PROJECT_ID;
    if (v.projectId === undefined && !parent) {
      if (p.workspaceId) throw invalid({ projectId: "A team key adds tasks to its workspace's projects: give a projectId." });
      if (v.workspaceId) throw invalid({ projectId: "Give a projectId to add a task to a workspace." });
    }
    let ws: string | null = null;
    if (target !== PERSONAL_PROJECT_ID) {
      const proj = isUuid(target) ? await loadProject(tx, target, keyWorkspace(p)) : null;
      if (!proj) throw invalid({ projectId: "There's no project with that id (or you can't see it)." });
      ws = s(proj.workspace_id);
    }
    if (parent && (String(parent.project_id) !== target || s(parent.workspace_id) !== ws)) {
      throw invalid({ parentId: "A sub-task lives in its parent's project. Leave out projectId, or use the parent's." });
    }
    if (v.workspaceId !== undefined && v.workspaceId !== ws) {
      throw invalid({ workspaceId: "That isn't the project's workspace. Leave workspaceId out: a task always lives in its project's workspace." });
    }
    assertInScope(p, ws);
    if (ws) requireWriter(await wsRole(tx, ws));
    if (ws) await requireProjectEditor(tx, ws, target);

    const assignee = v.assigneeId === undefined ? "" : await resolveAssignee(tx, v.assigneeId, ws, me, target);
    if (v.sectionId) {
      const sec = await tx.query(`select 1 from public.sections s where s.id = $1::uuid and s.project_id = $2`, [v.sectionId, target]);
      if (!sec.length) throw invalid({ sectionId: "That section isn't in this task's project." });
    }
    const asked = v.tags ? await resolveTags(tx, v.tags, ws, me) : [];
    // the project's "When a task is created" rules, as the app runs them on a new task (later rules win)
    const fx = await ruleEffect(tx, ["task_created"], target, ws, me);
    const tags = withTags(asked, fx.addTags);
    const status = v.status ?? "todo";
    const q = new Sql();
    const made = await tx.query<{ id: string }>(
      `insert into public.tasks (user_id, title, description, status, priority, project_id, section_id, parent_id,
         assignee_id, workspace_id, due_date, due_time, start_date, completed_at, tags, effort_hours, position${permalink ? ", slack_permalink" : ""})
       values (${q.p(me)}::uuid, ${q.p(v.title)}, ${q.p(v.description ?? "")}, ${q.p(status)}, ${q.p(fx.priority ?? v.priority ?? "medium")},
         ${q.p(target)}, ${q.p(fx.sectionId ?? v.sectionId ?? null)}, ${q.p(v.parentId ?? null)}::uuid, ${q.p(fx.assigneeId ?? assignee)}, ${q.p(ws)}::uuid,
         ${q.p(v.dueDate ?? null)}::date, ${q.p(v.dueTime ?? null)}, ${q.p(v.startDate ?? null)}::date,
         ${status === "done" ? "current_date" : "null"}, array(select jsonb_array_elements_text(${q.p(JSON.stringify(tags))}::jsonb)),
         ${q.p(v.effortHours ?? null)}::numeric, extract(epoch from clock_timestamp()) * 1000${permalink ? `, ${q.p(permalink)}` : ""})
       returning id::text as id`, q.params);
    return readBack(ctx, tx, made[0].id);
  });
  return taskAnswer(ctx, task, 201, { Location: `${ctx.apiBase}/tasks/${task.id}` });
}

/** The task and every sub-task under it (recursive, cycle-safe). */
const treeSql = (rootParam: string) => `with recursive d(id) as (
    select ${rootParam}::uuid
    union
    select c.id from public.tasks c join d on c.parent_id = d.id)`;

async function setArchived(tx: Tx, id: string, archived: boolean, kws: string | null) {
  if (archived) {
    // the app's rule: archiving a task archives its sub-tasks with it (same moment)
    await tx.query(`${treeSql("$1")} update public.tasks t set archived_at = now()
      where t.id in (select id from d) and t.archived_at is null and ${inKeyWs("t.workspace_id", 2)}`, [id, kws]);
  } else {
    // restoring brings back the sub-tasks that were archived with it
    await tx.query(`${treeSql("$1")} update public.tasks t set archived_at = null
      where t.id in (select id from d) and t.archived_at = (select r.archived_at from public.tasks r where r.id = $1::uuid)
        and ${inKeyWs("t.workspace_id", 2)}`, [id, kws]);
  }
}

/**
 * The task, when the key's user may change it (else 404 / 403). With If-Match, the row is locked
 * until the transaction ends and the caller's ETag must still be GET's (else 412), so an edit made
 * in the app since the caller read the task is never silently overwritten.
 */
async function editableTask(ctx: RouteContext, tx: Tx, id: string): Promise<Row> {
  const read = () => loadTask(tx, id, keyWorkspace(ctx.principal), ", public.can_edit_task(t.id) as can_edit");
  let row = await read();
  if (!row) throw notFound("Task");
  if (row.can_edit !== true) throw forbidden("You can see this task but can't change it.");
  const ifMatch = ctx.req.headers.get("if-match");
  if (ifMatch !== null) {
    await tx.query(`select 1 from public.tasks t where t.id = $1::uuid for update`, [id]);
    if (!etagMatches(ifMatch, await etagFor(await fullTask(ctx, tx, id)))) throw preconditionFailed("task");
    row = (await read()) ?? row; // as it is now that it's locked
  }
  return row;
}

/** A status change's triggers: "status changed", then "task completed" when it completes the task. */
const statusTriggers = (from: unknown, to: string): RuleTrigger[] =>
  from === to ? [] : to === "done" ? ["status_changed", "task_completed"] : ["status_changed"];

export function updateTask(ctx: RouteContext): Promise<Response> {
  return updateTaskWith(ctx);
}

/** What the MCP server's update_task adds to PATCH /tasks/:id (never the public API). */
export interface TaskUpdateExtras {
  /** added to the end of the description, in the same update, so nothing has to be read and sent back */
  appendDescription?: string;
  /** says why a new description can't be saved, given what's stored, or null */
  refuseDescription?: (stored: string, next: string) => string | null;
}

/** PATCH /tasks/:id, for the API and for Kanbo's own MCP server. */
export async function updateTaskWith(ctx: RouteContext, extras: TaskUpdateExtras = {}): Promise<Response> {
  const id = pathId(ctx, "Task");
  const body = ctx.body ?? {};
  // adding to the description can be the whole of the change
  const c = extras.appendDescription && !Object.keys(body).length ? { ok: true as const, value: {} as TaskInput } : checkTaskPatch(body);
  if (!c.ok) throw invalid(c.fields);
  const v: TaskInput = c.value;
  const p = ctx.principal;
  const me = p.userId;
  let next: NextOccurrence | null = null;
  const task = await asUser(ctx, async (tx) => {
    const cur = await editableTask(ctx, tx, id);
    const curWs = s(cur.workspace_id);
    const q = new Sql();
    const sets: string[] = [];
    let ws = curWs;
    let project = String(cur.project_id);
    let projectChanged = false;
    let moved = false; // to another workspace (or to / from the Personal list)
    // the columns the project's rules may change too: undefined = leave as it is
    let section: string | null | undefined;
    let assignee: string | undefined;
    let priority: string | undefined;
    let tags: string[] | undefined;

    // ---- project (and with it the workspace) ----
    if (v.projectId !== undefined) {
      const want = v.projectId ?? PERSONAL_PROJECT_ID;
      if (want !== project) {
        if (want === PERSONAL_PROJECT_ID) {
          assertInScope(p, null);
          if (s(cur.user_id) !== me) throw forbidden("Only the person who made a task can move it to their Personal list.");
          ws = null;
        } else {
          const proj = await loadProject(tx, want, keyWorkspace(p));
          if (!proj) throw invalid({ projectId: "There's no project with that id (or you can't see it)." });
          ws = s(proj.workspace_id);
          // into a project you can't edit (0058: a viewer, a commenter): no
          if (ws) await requireProjectEditor(tx, ws, want);
        }
        assertInScope(p, ws);
        moved = ws !== curWs;
        if (moved) {
          if (cur.parent_id) throw invalid({ projectId: "A sub-task moves with its parent. Move the parent task instead." });
          // Leaving a workspace takes the task, its sub-tasks and their comments away from everyone
          // there: only for the people who made all of it, or that workspace's owners and admins.
          if (curWs && !["owner", "admin"].includes(await wsRole(tx, curWs))) {
            const others = await tx.query(`${treeSql("$1")} select 1 from public.tasks t
              where t.id in (select id from d) and t.user_id is distinct from $2::uuid limit 1`, [id, me]);
            if (others.length) {
              throw forbidden("Only this workspace's owners and admins can move a task someone else made (or one with sub-tasks someone else made) to another workspace.");
            }
          }
          if (ws) requireWriter(await wsRole(tx, ws));
          else {
            const others = await tx.query(`${treeSql("$1")} select 1 from public.tasks t where t.id in (select id from d) and t.user_id <> $2::uuid limit 1`, [id, me]);
            if (others.length) throw forbidden("Some of its sub-tasks were made by other people, so it can't move to your Personal list.");
          }
        }
        project = want;
        projectChanged = true;
        sets.push(`project_id = ${q.p(want)}`, `workspace_id = ${q.p(ws)}::uuid`);
        if (v.sectionId === undefined) section = null;
      }
    }

    // ---- section (in the task's project, after any move) ----
    if (v.sectionId !== undefined) {
      if (v.sectionId === null) section = null;
      else {
        const sec = await tx.query(`select 1 from public.sections s where s.id = $1::uuid and s.project_id = $2`, [v.sectionId, project]);
        if (!sec.length) throw invalid({ sectionId: "That section isn't in this task's project." });
        section = v.sectionId;
      }
    }

    // ---- people ----
    // with Project access (0058), anyone kept on it must be able to see its project: checked on every move
    const access = await accessOn(tx);
    const recheck = moved || (projectChanged && access);
    const seen = access ? project : undefined;
    if (v.assigneeId !== undefined) assignee = await resolveAssignee(tx, v.assigneeId, ws, me, seen);
    else if (recheck && cur.assignee_id && !(await canBeOnTask(tx, ws, String(cur.assignee_id), me, seen))) {
      assignee = me; // as the app does: they can't see it there, so it comes to you
    }
    if (recheck) {
      sets.push(`followers = array(select x from unnest(t.followers) x where ${visibleSql(q, "x", ws, me, seen ?? null)})`);
      sets.push(`collaborators = array(select x from unnest(t.collaborators) x where ${visibleSql(q, "x", ws, me, seen ?? null)})`);
    }

    // ---- fields ----
    if (v.title !== undefined) sets.push(`title = ${q.p(v.title)}`);
    if (v.description !== undefined) {
      const refusal = extras.refuseDescription?.(String(cur.description ?? ""), v.description);
      if (refusal) throw invalid({ description: refusal });
      sets.push(`description = ${q.p(v.description)}`);
    }
    if (extras.appendDescription) {
      const stored = String(cur.description ?? "");
      if (stored.length + extras.appendDescription.length + 2 > API_LIMITS.description) {
        throw invalid({ appendToDescription: `That would make the description longer than ${API_LIMITS.description.toLocaleString("en-GB")} characters. Nothing was changed.` });
      }
      // in the update itself, so an edit made in the app a moment ago isn't lost
      sets.push(`description = case when coalesce(t.description, '') = '' then ${q.p(extras.appendDescription)} else t.description || E'\\n\\n' || ${q.p(extras.appendDescription)} end`);
    }
    if (v.priority !== undefined) priority = v.priority;
    const triggers = v.status !== undefined ? statusTriggers(cur.status, v.status) : [];
    if (v.status !== undefined && v.status !== cur.status) {
      sets.push(`status = ${q.p(v.status)}`);
      if (v.status === "done") sets.push("completed_at = current_date");
      else if (cur.status === "done") sets.push("completed_at = null");
    }
    const due = v.dueDate !== undefined ? v.dueDate : s(cur.due_date);
    const start = v.startDate !== undefined ? v.startDate : s(cur.start_date);
    if (start && due && start > due) throw invalid({ startDate: "startDate is after dueDate." });
    if (v.dueTime && !due) throw invalid({ dueTime: "Give the task a dueDate before a dueTime." });
    if (v.dueDate !== undefined) sets.push(`due_date = ${q.p(v.dueDate)}::date`);
    if (v.dueTime !== undefined) sets.push(`due_time = ${q.p(v.dueTime)}`);
    else if (v.dueDate === null) sets.push("due_time = null");
    if (v.startDate !== undefined) sets.push(`start_date = ${q.p(v.startDate)}::date`);
    if (v.effortHours !== undefined) sets.push(`effort_hours = ${q.p(v.effortHours)}::numeric`);
    if (v.tags !== undefined) tags = await resolveTags(tx, v.tags, ws, me);

    // ---- the project's "status changed" / "task completed" rules (App.tsx onStatusChange) ----
    if (triggers.length) {
      const fx = await ruleEffect(tx, triggers, project, ws, me);
      if (fx.priority !== undefined) priority = fx.priority;
      if (fx.assigneeId !== undefined) assignee = fx.assigneeId;
      if (fx.sectionId !== undefined) section = fx.sectionId;
      if (fx.addTags.length) tags = withTags(tags ?? strings(cur.tags), fx.addTags);
    }
    if (section !== undefined) sets.push(`section_id = ${q.p(section)}`);
    if (assignee !== undefined) {
      sets.push(`assignee_id = ${q.p(assignee)}`);
      if (assignee !== String(cur.assignee_id ?? "")) sets.push(...RELEASED_PLAN);
    }
    if (priority !== undefined) sets.push(`priority = ${q.p(priority)}`);
    if (tags !== undefined) sets.push(`tags = array(select jsonb_array_elements_text(${q.p(JSON.stringify(tags))}::jsonb))`);

    // completing a repeating task: its next occurrence is made from the task as it stood, as in the app
    if (v.status === "done" && cur.status !== "done") next = await spawnNextOccurrence(ctx, tx, cur);

    const kws = keyWorkspace(p);
    if (sets.length) {
      const done = await tx.query(`update public.tasks t set ${sets.join(", ")}
        where t.id = ${q.p(id)}::uuid and ${inKeyWs("t.workspace_id", q.params.length + 1)} returning t.id`, [...q.params, kws]);
      if (!done.length) throw forbidden("You can see this task but can't change it.");
    }
    if (projectChanged) {
      // sub-tasks go where their parent goes (the app's cascadeToDescendants); across
      // workspaces, people who can't see them there are dropped, as the app's retarget() does
      const m = new Sql();
      const root = m.p(id);
      const sp = seen ?? null;
      const people = recheck ? `,
          plan_today = case when ${visibleSql(m, "t.assignee_id", ws, me, sp)} then t.plan_today else false end,
          scheduled = case when ${visibleSql(m, "t.assignee_id", ws, me, sp)} then t.scheduled else null end,
          my_section_id = case when ${visibleSql(m, "t.assignee_id", ws, me, sp)} then t.my_section_id else null end,
          assignee_id = case when ${visibleSql(m, "t.assignee_id", ws, me, sp)} then t.assignee_id else ${m.p(me)} end,
          followers = array(select x from unnest(t.followers) x where ${visibleSql(m, "x", ws, me, sp)}),
          collaborators = array(select x from unnest(t.collaborators) x where ${visibleSql(m, "x", ws, me, sp)})` : "";
      await tx.query(`with recursive d(id) as (
          select c.id from public.tasks c where c.parent_id = ${root}::uuid
          union select c.id from public.tasks c join d on c.parent_id = d.id)
        update public.tasks t set project_id = ${m.p(project)}, workspace_id = ${m.p(ws)}::uuid, section_id = null${people}
        where t.id in (select id from d) and ${inKeyWs("t.workspace_id", m.params.length + 1)}`, [...m.params, kws]);
    }
    if (v.archived !== undefined && (cur.archived_at != null) !== v.archived) await setArchived(tx, id, v.archived, kws);
    return readBack(ctx, tx, id);
  });
  return taskAnswer(ctx, task, 200, {}, next);
}

/**
 * When a task changes hands its row's plan (the slot, "on today", the My-tasks section) stops being
 * anyone's: a task you hand on never lands in your slot on their day (App.tsx releasedPlan).
 */
const RELEASED_PLAN = ["plan_today = false", "scheduled = null", "my_section_id = null"];

/* ============================================================ repeating tasks */

export interface NextOccurrence { id: string; dueDate: string }

const RECURRENCES = ["daily", "weekdays", "weekly", "biweekly", "monthly"];

/** Their saved time zone (notify_prefs.timezone, 0048), if any. Reads the row as JSON so nothing depends on 0048. */
export async function savedZone(tx: Tx, me: string): Promise<string | null> {
  const rs = await tx.query<{ tz: string | null }>(
    `select to_jsonb(p) -> 'notify_prefs' ->> 'timezone' as tz from public.profiles p where p.id = $1::uuid`, [me]);
  const tz = rs[0]?.tz ?? null;
  return isTimeZone(tz) ? tz : null;
}

const CLONED_COLS = `title, description, priority, project_id, section_id, my_section_id, assignee_id, workspace_id, due_time, tags,
  focus_min, ai_score, ai_reason, energy, dur, followers, collaborators, custom, effort_hours, is_milestone, recurrence`;

/**
 * Completing a repeating task makes its next occurrence, in the same transaction, the way the app's
 * buildRecurrence does: same work and people, back to to-do, a fresh plan, no logged time and no
 * dependencies, made by whoever completed it. Its sub-tasks come too, with their dates moved by as
 * much; sub-tasks that repeat on their own stay behind, because they make their own next occurrence.
 * The checklist comes unticked. An open occurrence already due on or after that date means there's
 * nothing to make, so completing, reopening and completing again doesn't make two.
 */
async function spawnNextOccurrence(ctx: RouteContext, tx: Tx, cur: Row): Promise<NextOccurrence | null> {
  const recurrence = String(cur.recurrence ?? "none");
  if (!RECURRENCES.includes(recurrence)) return null;
  const me = ctx.principal.userId;
  const id = String(cur.id);
  const zone = (await savedZone(tx, me)) ?? DEFAULT_TIMEZONE;
  const today = localMidnight(dateInZone(new Date(), zone));
  const [orig] = await tx.query<{ d: string | null }>(`select t.original_due_date::text as d from public.tasks t where t.id = $1::uuid`, [id]);
  const occ = nextOccurrenceDates({ recurrence: recurrence as NlpRecurrence, dueDate: s(cur.due_date), startDate: s(cur.start_date), originalDueDate: orig?.d ?? null }, today);
  const already = await tx.query(
    `select 1 from public.tasks x
      where x.id <> $1::uuid and x.status <> 'done' and x.archived_at is null and x.parent_id is not distinct from $2::uuid
        and x.title = $3 and x.project_id = $4 and x.recurrence = $5 and x.due_date >= $6::date limit 1`,
    [id, s(cur.parent_id), String(cur.title ?? ""), String(cur.project_id), recurrence, occ.dueDate]);
  if (already.length) return null;
  const clone = async (from: string, parent: string | null, due: string | null, start: string | null, original: string | null) => {
    const made = await tx.query<{ id: string }>(
      `insert into public.tasks (user_id, status, parent_id, due_date, start_date, original_due_date, position, ${CLONED_COLS})
       select $1::uuid, 'todo', $2::uuid, $3::date, $4::date, $5::date, extract(epoch from clock_timestamp()) * 1000, ${CLONED_COLS}
         from public.tasks where id = $6::uuid
       returning id::text as id`, [me, parent, due, start, original, from]);
    return made[0].id;
  };
  const root = await clone(id, s(cur.parent_id), occ.dueDate, occ.startDate, occ.originalDueDate);
  const kids = await tx.query<Row>(
    `${treeSql("$1")}
     select t.id::text as id, t.parent_id::text as parent_id, t.recurrence, t.archived_at, t.due_date::text as due_date, t.start_date::text as start_date
       from public.tasks t where t.id in (select id from d) and t.id <> $1::uuid order by t.created_at, t.id limit 500`, [id]);
  const copies = new Map<string, string>([[id, root]]);
  let waiting = kids.filter((k) => k.archived_at == null && String(k.recurrence ?? "none") === "none");
  // parents before children; one whose parent stayed behind (archived, or its own series) stays behind with it
  for (let round = 0; waiting.length && round < 64; round++) {
    const ready = waiting.filter((k) => copies.has(String(k.parent_id)));
    if (!ready.length) break;
    for (const k of ready) {
      const moved = (iso: unknown) => { const d = s(iso); return d ? shiftISO(d, occ.shiftDays) : null; };
      copies.set(String(k.id), await clone(String(k.id), copies.get(String(k.parent_id))!, moved(k.due_date), moved(k.start_date), null));
    }
    waiting = waiting.filter((k) => !copies.has(String(k.id)));
  }
  await tx.query(`insert into public.subtasks (task_id, title, done, position) select $1::uuid, c.title, false, c.position from public.subtasks c where c.task_id = $2::uuid`, [root, id]);
  return { id: root, dueDate: occ.dueDate };
}

export async function completeTask(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  const me = ctx.principal.userId;
  let next: NextOccurrence | null = null;
  const task = await asUser(ctx, async (tx) => {
    const cur = await editableTask(ctx, tx, id);
    if (cur.status !== "done") {
      next = await spawnNextOccurrence(ctx, tx, cur);
      // the project's "status changed" and "task completed" rules, as completing it in the app runs them
      const fx = await ruleEffect(tx, statusTriggers(cur.status, "done"), String(cur.project_id), s(cur.workspace_id), me);
      const q = new Sql();
      const sets = ["status = 'done'", "completed_at = current_date"];
      if (fx.priority !== undefined) sets.push(`priority = ${q.p(fx.priority)}`);
      if (fx.assigneeId !== undefined) {
        sets.push(`assignee_id = ${q.p(fx.assigneeId)}`);
        if (fx.assigneeId !== String(cur.assignee_id ?? "")) sets.push(...RELEASED_PLAN);
      }
      if (fx.sectionId !== undefined) sets.push(`section_id = ${q.p(fx.sectionId)}`);
      if (fx.addTags.length) sets.push(`tags = array(select jsonb_array_elements_text(${q.p(JSON.stringify(withTags(strings(cur.tags), fx.addTags)))}::jsonb))`);
      await tx.query(`update public.tasks t set ${sets.join(", ")} where t.id = ${q.p(id)}::uuid and t.status <> 'done'`, q.params);
    }
    return readBack(ctx, tx, id);
  });
  return taskAnswer(ctx, task, 200, {}, next);
}

export async function deleteTask(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  const extra = [...ctx.url.searchParams.keys()].filter((k) => k !== "hard");
  if (extra.length) throw badQuery(Object.fromEntries(extra.map((k) => [k, "Unknown query parameter."])));
  const hard = parseBool(ctx.url.searchParams.get("hard"));
  if (hard === null) throw badQuery({ hard: "Use true or false." });
  await asUser(ctx, async (tx) => {
    const cur = await editableTask(ctx, tx, id);
    if (!hard) return setArchived(tx, id, true, keyWorkspace(ctx.principal));
    const ws = s(cur.workspace_id);
    if (ws) {
      const role = await wsRole(tx, ws);
      if (role !== "owner" && role !== "admin") {
        throw forbidden("Only workspace owners and admins can delete tasks for good. Leave out hard=true to archive it instead.");
      }
    } else if (s(cur.user_id) !== ctx.principal.userId) {
      throw forbidden("Only the person who made a personal task can delete it.");
    }
    const gone = await tx.query(`delete from public.tasks t where t.id = $1::uuid returning t.id`, [id]);
    if (!gone.length) throw forbidden("You can't delete this task.");
  });
  return ok(ctx, null, 204);
}

/**
 * What Kanbo's MCP server's delete_task runs (not a public REST route): into the recycle bin and
 * nowhere else. Anyone who can edit the task may do this, as in the app (the tasks delete policy
 * decides, as the key's user). The BEFORE DELETE trigger from 0047 keeps the task, its sub-tasks and
 * comments for 30 days; if that trigger isn't there, nothing is deleted.
 */
export async function binTask(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  const out = await asUser(ctx, async (tx) => {
    const cur = await editableTask(ctx, tx, id);
    const bin = await tx.query<{ present: boolean }>(
      `select exists (select 1 from pg_catalog.pg_trigger g
                       where g.tgrelid = 'public.tasks'::regclass and g.tgname = 'trg_trash_task' and g.tgenabled <> 'D') as present`);
    if (bin[0]?.present !== true) throw new ApiFail(409, "conflict", "Kanbo's recycle bin isn't set up yet, so this task wasn't deleted.");
    const gone = await tx.query(`delete from public.tasks t where t.id = $1::uuid returning t.id`, [id]);
    if (!gone.length) throw forbidden("You can't delete this task.");
    return { object: "task", id, title: String(cur.title ?? ""), inRecycleBin: true, keptForDays: 30 };
  });
  return ok(ctx, out);
}

/* ============================================================ comments */

export async function listComments(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  const pq = parsePageQuery(ctx.url.searchParams);
  if (!pq.ok) throw badQuery(pq.fields);
  const fp = await queryFingerprint({ r: "comments", id });
  const cur = await readCursor(pq.value.cursor, "k", fp);
  const rows = await asUser(ctx, async (tx) => {
    if (!(await taskVisible(tx, id, keyWorkspace(ctx.principal)))) throw notFound("Task");
    const q = new Sql();
    return tx.query(`select ${COMMENT_COLS}, ${cursorKeySql("c.created_at")} as _ck from public.comments c
      where c.task_id = ${q.p(id)}::uuid${after(q, cur, "c.created_at", "c.id", "asc")}
      order by c.created_at, c.id limit ${q.p(pq.value.limit + 1)}::int`, q.params);
  });
  const { page, next } = pageOf(rows, pq.value.limit, "k", fp);
  return ok(ctx, list(page.map(serialiseComment), next));
}

/**
 * The task's comments, newest first, for the MCP server: the newest comment on a thread is usually
 * the one that matters. The cursor walks back to older ones. Mounted only on its route table.
 */
export async function listRecentComments(ctx: RouteContext): Promise<Response> {
  const id = pathId(ctx, "Task");
  const pq = parsePageQuery(ctx.url.searchParams);
  if (!pq.ok) throw badQuery(pq.fields);
  const fp = await queryFingerprint({ r: "comments-recent", id });
  const cur = await readCursor(pq.value.cursor, "kd", fp);
  const rows = await asUser(ctx, async (tx) => {
    if (!(await taskVisible(tx, id, keyWorkspace(ctx.principal)))) throw notFound("Task");
    const q = new Sql();
    return tx.query(`select ${COMMENT_COLS}, ${cursorKeySql("c.created_at")} as _ck from public.comments c
      where c.task_id = ${q.p(id)}::uuid${after(q, cur, "c.created_at", "c.id", "desc")}
      order by c.created_at desc, c.id desc limit ${q.p(pq.value.limit + 1)}::int`, q.params);
  });
  const { page, next } = pageOf(rows, pq.value.limit, "kd", fp);
  return ok(ctx, list(page.map(serialiseComment), next));
}

export function createComment(ctx: RouteContext): Promise<Response> {
  return createCommentWith(ctx);
}

/** What the MCP server's add_comment adds: who the text mentions (people who can see the task's project), and anything to tell the caller. */
export type CommentMentions = (tx: Tx, body: string, workspaceId: string | null, projectId: string | null) => Promise<{ ids: string[]; answer: Record<string, unknown> }>;

/** POST /tasks/:id/comments, for the API and for Kanbo's own MCP server. */
export async function createCommentWith(ctx: RouteContext, mentions?: CommentMentions): Promise<Response> {
  const id = pathId(ctx, "Task");
  const c = checkCommentCreate(ctx.body ?? {});
  if (!c.ok) throw invalid(c.fields);
  const v = c.value;
  let extra: Record<string, unknown> = {};
  const row = await asUser(ctx, async (tx) => {
    const seen = await tx.query<{ workspace_id: string | null; project_id: string | null }>(
      `select t.workspace_id::text as workspace_id, t.project_id from public.tasks t where t.id = $1::uuid and ${inKeyWs("t.workspace_id", 2)}`, [id, keyWorkspace(ctx.principal)]);
    if (!seen[0]) throw notFound("Task");
    // a viewer reads but doesn't comment (0058; guests comment on what they're on)
    if (seen[0].workspace_id && (await accessOn(tx))) {
      const [c] = await tx.query<{ ok: boolean }>(`select public.can_comment_task($1::uuid) as ok`, [id]);
      if (c?.ok !== true) throw forbidden("You can see this task but can't comment on it.");
    }
    if (v.parentId) {
      const par = await tx.query(`select 1 from public.comments c where c.id = $1::uuid and c.task_id = $2::uuid`, [v.parentId, id]);
      if (!par.length) throw invalid({ parentId: "That comment isn't on this task." });
    }
    const read = mentions ? await mentions(tx, v.body, seen[0].workspace_id, seen[0].project_id) : null;
    extra = read?.answer ?? {};
    // guests may comment (RLS: comment as yourself on a task you can see)
    const rs = await tx.query(`insert into public.comments as c (task_id, user_id, body, parent_id, mentions)
      values ($1::uuid, $2::uuid, $3, $4::uuid, array(select (jsonb_array_elements_text($5::jsonb))::uuid)) returning ${COMMENT_COLS}`,
      [id, ctx.principal.userId, v.body, v.parentId, JSON.stringify(read?.ids ?? [])]);
    // the task's comment count, as the app keeps it (writers only — a guest's count catches up when someone edits)
    await tx.query(`update public.tasks t set comments = (select count(*) from public.comments k where k.task_id = t.id)
      where t.id = $1::uuid and public.can_edit_task(t.id)`, [id]);
    return rs[0];
  });
  return ok(ctx, { ...serialiseComment(row), ...extra }, 201);
}
