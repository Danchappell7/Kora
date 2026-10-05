// ============================================================
// KANBO — Notion: import and the two-way sync engine (0046).         [a3]
//
// Pure (database, Notion client and clock are passed in): the notion edge
// function wires postgres.js (db.ts) and fetch; the PGlite replay wires
// PGlite and a fake Notion.
//
// WHO DOES WHAT. Every read and write of tasks, projects and tags runs as a
// person, with RLS, in db.withUser({userId, workspaceId}) — the caller for
// an import, the sync's created_by for a sync run — scoped to the
// workspace (kanbo.api_workspace). The service connection only does what
// no person can: read the integration token, write notion_links /
// notion_page_cache (no client writes exist), keep notion_link_state (the
// per-field baselines; no client can read or write it), the per-database
// lease, and the sync's bookkeeping (last_run_at, cursor, stats, errors).
//
// NOTION → KANBO. Each run queries the database for pages edited since the
// last one (last_edited_time on or after the cursor − 2 minutes, oldest
// first, 100 a request). A page with no link becomes a task in the project.
// THE MERGE IS PER FIELD (notionMap planSync). notion_link_state keeps, for
// each link, a fingerprint of every field's value as both sides last agreed
// it. A field only Notion changed comes in; one only Kanbo changed goes out
// (two-way) or stays (from Notion only); one both changed goes the way of the
// later edit (task updated_at against the page's last_edited_time, whole
// minutes, so a tie goes to Kanbo); one neither changed is left alone. An
// edit to anything the sync doesn't carry (priority, position, an unmapped
// property, the page body) therefore never carries a stale field across.
// A link also stores the task's updated_at (last_synced_at) and the page's
// last_edited_time (notion_last_edited) after each write, so a run skips
// pages and tasks nobody has touched since.
// A page whose IMPORTER-MADE plain link (a one-off import of this database,
// or a removed sync of it: notion_links.notion_database_id is set) sits on a
// task in the project is taken over rather than imported twice, merged with
// the baseline the import left. Links people add by hand (no database id)
// are never taken over. An old page this workspace has seen before that
// lost its link had its task deleted in Kanbo: it isn't brought back
// (notion_page_cache remembers it); a page moved into the database from
// elsewhere was never seen and is imported.
// KANBO → NOTION (two-way). Linked tasks changed since their last sync are
// merged with their page the same way, and only the fields Kanbo changed
// are PATCHed. A page archived or in the trash archives its task.
//
// NEVER OVER A PERSON'S EDIT. A field coming in from Notion is planned
// against the task as it is in that same transaction: a batch locks the
// tasks its pages are linked to (FOR UPDATE) before reading them, and the
// push re-reads and locks each task after fetching its page (never across a
// Notion request). Every write is also conditional on the task's updated_at
// being the one read; if it isn't (changed meanwhile), nothing is written
// and the link's last_synced_at and baseline stay as they were, so the next
// run merges again with the person's edit.
//
// ONE AT A TIME. A lease per (workspace, database) in rate_limits
// ('kanbo:notion:lease:…', 3 minutes, released at the end) means an import
// and a sync run of the same database never overlap, so nothing is
// imported twice by a double submit or two admins at once. Sync runs are
// also claimed (notion_syncs.last_run_at).
//
// LIMITS. A run stops starting Notion requests at its deadline or request
// budget; the cursor then remembers where the query got to and the next run
// carries on. A one-off import reads oldest-created first and brings in up
// to 1,000 new tasks; it answers with where it stopped (`resume`), and
// "Import the rest" carries on from there.
// ============================================================
import { parseNotionId, type NotionFieldMapping } from "./notion.ts";
import type { Tx, UserScope } from "./api/types.ts";
import { isNotionError, type NotionApi } from "./notionApi.ts";
import {
  baselineOf, checkMapping, formatCursor, isKanboStatus, LIMITS, ms, nextBaseline, OVERLAP_MS, oneLine, pageMeta, parseCursor,
  planSync, pullPatch, pushProperties, readBaseline, readMapping, readPage, sameBaseline, schemaOf, tagColour, tagKey, taskFromPage,
  type Baseline, type KanboStatus, type MapContext, type NPage, type PageFields, type PullPatch, type SyncCursor, type SyncField,
  type SyncTask, type TagValue,
} from "./notionMap.ts";

export interface NotionDb {
  /** privileged: token, links, cache, sync bookkeeping only */
  service: Tx;
  withUser<T>(scope: UserScope, fn: (tx: Tx) => Promise<T>): Promise<T>;
}
export interface SyncDeps {
  db: NotionDb;
  /** a Notion client for a token, stopping new requests at `deadline` */
  notion: (token: string, deadline: number) => NotionApi;
  now: () => number;
  newId: () => string;
  log: (level: "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;
}

export interface SyncStats { created: number; updated: number; pushed: number; skipped: number; at?: string }
export type Direction = "two_way" | "from_notion";

/** A refusal with its HTTP answer (the handler turns it into JSON). */
export class NotionActionError extends Error {
  constructor(readonly status: number, readonly reason: string, message: string, readonly retryAfter?: number) {
    super(message);
    this.name = "NotionActionError";
  }
}

export const SYNC_TEXT = {
  noUser: "The person who set up this sync no longer has access. An owner or admin can save it again.",
  notConnected: "Notion isn't connected to this workspace any more. An owner or admin can reconnect it in Settings.",
  projectGone: "The project this sync fills has been archived or moved. Remove the sync, or import the database into another project.",
  badMapping: "This sync's field mapping can't be read. Remove the sync and import the database again.",
  invalidToken: "Notion no longer accepts Kanbo's integration secret. An owner or admin can reconnect Notion in Settings.",
  notShared: "Kanbo can't see this Notion database any more. In Notion, open it and add your Kanbo integration under ••• › Connections.",
  rateLimited: "Notion asked Kanbo to slow down. The sync carries on at its next run.",
  unavailable: "Notion wasn't responding. The sync tries again at its next run.",
  internal: "Something went wrong on Kanbo's side. The sync tries again at its next run.",
  busy: "This database is being imported or synced right now. Try again in a minute or two.",
} as const;

class SyncStop extends Error {}

/** Any failure in a run → the sentence Settings shows. */
export function syncErrorText(e: unknown, what: "database" | "page" = "database"): string {
  if (e instanceof SyncStop || e instanceof NotionActionError) return e.message;
  if (isNotionError(e)) {
    switch (e.kind) {
      case "invalid_token": return SYNC_TEXT.invalidToken;
      case "not_shared": return what === "database" ? SYNC_TEXT.notShared : "Kanbo can't see that Notion page. It may have been deleted, or not shared with your Kanbo integration.";
      case "rate_limited": return SYNC_TEXT.rateLimited;
      case "network": case "unavailable": case "conflict": case "timeout": return SYNC_TEXT.unavailable;
      case "archived": return "That Notion page is archived.";
      case "validation": return `Notion turned a change down${e.message ? `: ${oneLine(e.message, 200).replace(/[.\s]+$/, "")}` : ""}.`;
    }
  }
  return SYNC_TEXT.internal;
}

/* ------------------------------------------------------------ SQL */

const TASK_COLS = `t.id::text as t_id, t.title, coalesce(t.description, '') as description, t.status, t.due_date::text as due_date,
  t.start_date::text as start_date, coalesce(t.assignee_id, '') as assignee_id, coalesce(t.tags, '{}') as tags,
  t.archived_at is not null as archived, t.workspace_id::text as t_ws, t.project_id as t_project,
  t.updated_at::text as updated_at, ((extract(epoch from t.updated_at) * 1000000)::bigint)::text as updated_us`;
const LINK_COLS = `l.id::text as link_id, l.notion_page_id,
  case when l.notion_last_edited is null then null else ((extract(epoch from l.notion_last_edited) * 1000)::bigint)::text end as notion_ms`;

interface LinkTaskRow {
  link_id: string; notion_page_id: string; notion_ms: string | null;
  t_id: string | null; title: string; description: string; status: string; due_date: string | null; start_date: string | null;
  assignee_id: string; tags: string[] | null; archived: boolean | null; t_ws: string | null; t_project: string | null;
  updated_at: string; updated_us: string; k_changed?: boolean;
}
const asTask = (r: LinkTaskRow): SyncTask => ({
  id: r.t_id!, title: r.title ?? "", description: r.description ?? "", status: (isKanboStatus(r.status) ? r.status : "todo") as KanboStatus,
  due_date: r.due_date, start_date: r.start_date, assignee_id: r.assignee_id ?? "", tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
});
const J = (v: unknown) => JSON.stringify(v);

/** The sync's acting person may still write in the workspace. */
async function actingRole(service: Tx, userId: string, ws: string): Promise<string> {
  const r = await service.query<{ r: string }>(`select public.user_ws_role($1::uuid, $2::uuid) as r`, [userId, ws]);
  return r[0]?.r ?? "none";
}
export async function readToken(service: Tx, ws: string): Promise<string | null> {
  const r = await service.query<{ t: string | null }>(`select notion_token as t from public.workspace_integrations where workspace_id = $1::uuid`, [ws]);
  return r[0]?.t ?? null;
}

interface Ctx extends MapContext { tagLabelById: Map<string, string>; tagIdByKey: Map<string, string> }
async function loadContext(tx: Tx, ws: string): Promise<Ctx> {
  const members = await tx.query<{ user_id: string; email: string }>(
    `select m.user_id::text as user_id, lower(btrim(m.email)) as email from public.workspace_members m
      where m.workspace_id = $1::uuid and m.status = 'active' and m.user_id is not null and coalesce(m.email, '') <> ''`, [ws]);
  const tags = await tx.query<{ id: string; label: string }>(`select id::text as id, label from public.tags where workspace_id = $1::uuid`, [ws]);
  const memberByEmail = new Map<string, string>(), emailByMember = new Map<string, string>();
  for (const m of members) { memberByEmail.set(m.email, m.user_id); emailByMember.set(m.user_id, m.email); }
  const tagLabelById = new Map<string, string>(), tagIdByKey = new Map<string, string>();
  for (const t of tags) { tagLabelById.set(t.id, t.label); if (!tagIdByKey.has(tagKey(t.label))) tagIdByKey.set(tagKey(t.label), t.id); }
  return { memberByEmail, emailByMember, tagLabelById, tagIdByKey };
}

/** Tag labels → tag ids in the workspace, creating the missing ones (as the person). */
async function tagIds(tx: Tx, userId: string, ws: string, ctx: Ctx, values: TagValue[]): Promise<string[]> {
  const missing = new Map<string, TagValue>();
  for (const v of values) { const k = tagKey(v.name); if (k && !ctx.tagIdByKey.has(k) && !missing.has(k)) missing.set(k, v); }
  if (missing.size) {
    const made = await tx.query<{ id: string; label: string }>(
      `insert into public.tags (user_id, label, color, workspace_id)
       select $1::uuid, x.label, x.color, $2::uuid from jsonb_to_recordset($3::jsonb) as x(label text, color text)
       returning id::text as id, label`,
      [userId, ws, J([...missing.values()].map((v) => ({ label: oneLine(v.name, LIMITS.tagLabel), color: tagColour(v.color) })))]);
    for (const t of made) { ctx.tagLabelById.set(t.id, t.label); ctx.tagIdByKey.set(tagKey(t.label), t.id); }
  }
  const out: string[] = [];
  for (const v of values) { const id = ctx.tagIdByKey.get(tagKey(v.name)); if (id && !out.includes(id)) out.push(id); }
  return out.slice(0, LIMITS.tags);
}

/** What a pulled patch did: the task's new updated_at, or why nothing was written. */
type PatchOutcome = { ok: true; at: string } | { ok: false; why: "changed" | "refused" };

/**
 * A pulled patch → one UPDATE (as the person), only while the task is exactly as it was read
 * (`readAt`, its updated_at as text): a Kanbo edit made since then is never overwritten with values
 * planned from the older copy (tags included: those Kanbo can't name are kept from that copy).
 * "changed": edited (or archived, or moved) meanwhile: the caller leaves the link alone so the next
 * run merges again. "refused": RLS said no.
 */
async function applyPatch(tx: Tx, userId: string, ws: string, ctx: Ctx, task: SyncTask, readAt: string, p: PullPatch): Promise<PatchOutcome> {
  const params: unknown[] = [task.id, ws, readAt];
  const sets: string[] = [];
  const add = (col: string, v: unknown, cast = "") => { params.push(v); sets.push(`${col} = $${params.length}${cast}`); };
  if (p.title !== undefined) add("title", p.title);
  if (p.description !== undefined) add("description", p.description);
  if (p.status !== undefined) {
    add("status", p.status);
    // the app's rule: done stamps completed_at today; reopening clears it
    sets.push(`completed_at = case when $${params.length} = 'done' then current_date when status = 'done' then null else completed_at end`);
  }
  if (p.due_date !== undefined) add("due_date", p.due_date, "::date");
  if (p.start_date !== undefined) add("start_date", p.start_date, "::date");
  if (p.assignee_id !== undefined) add("assignee_id", p.assignee_id);
  if (p.tags !== undefined) {
    const ids = await tagIds(tx, userId, ws, ctx, p.tags);
    // tags Kanbo can't name (not this workspace's) are kept
    const keep = task.tags.filter((id) => !ctx.tagLabelById.has(id));
    add("tags", J([...ids, ...keep].slice(0, LIMITS.tags)));
    sets[sets.length - 1] = `tags = array(select jsonb_array_elements_text($${params.length}::jsonb))`;
  }
  if (!sets.length) return { ok: true, at: readAt };
  const r = await tx.query<{ u: string }>(
    `update public.tasks set ${sets.join(", ")}
      where id = $1::uuid and workspace_id = $2::uuid and archived_at is null and updated_at = $3::timestamptz
      returning updated_at::text as u`, params);
  if (r[0]) return { ok: true, at: r[0].u };
  const now = await tx.query<{ u: string }>(`select updated_at::text as u from public.tasks where id = $1::uuid`, [task.id]);
  return { ok: false, why: now[0] && now[0].u !== readAt ? "changed" : "refused" };
}

/** The task as it is now, locked until the transaction ends (null: gone, archived, moved, or not the person's to change). */
async function lockTask(tx: Tx, taskId: string, ws: string): Promise<Pick<LinkTaskRow, "t_id" | "title" | "description" | "status" | "due_date" | "start_date"
  | "assignee_id" | "tags" | "archived" | "t_ws" | "t_project" | "updated_at" | "updated_us"> | null> {
  const r = await tx.query<LinkTaskRow>(
    `select ${TASK_COLS} from public.tasks t where t.id = $1::uuid and t.workspace_id = $2::uuid and t.archived_at is null for update of t`, [taskId, ws]);
  return r[0] ?? null;
}

/** Archive a task and its sub-tasks (the app's rule), as the person. */
async function archiveTask(tx: Tx, taskId: string, ws: string): Promise<string | null> {
  const r = await tx.query<{ u: string }>(
    `with recursive d(id) as (select $1::uuid union select c.id from public.tasks c join d on c.parent_id = d.id)
     update public.tasks t set archived_at = now() where t.id in (select id from d) and t.archived_at is null and t.workspace_id = $2::uuid
     returning t.id::text as id, t.updated_at::text as u`, [taskId, ws]);
  return r.find((x) => (x as unknown as { id: string }).id === taskId)?.u ?? null;
}

interface LinkTouch { id: string; s: string | null; e: string | null }
async function touchLinks(service: Tx, touches: LinkTouch[]) {
  if (!touches.length) return;
  await service.query(
    `update public.notion_links l set last_synced_at = coalesce(x.s::timestamptz, l.last_synced_at),
            notion_last_edited = greatest(l.notion_last_edited, x.e::timestamptz)
       from jsonb_to_recordset($1::jsonb) as x(id uuid, s text, e text) where l.id = x.id`, [J(touches)]);
}
async function cachePages(service: Tx, ws: string, pages: NPage[]) {
  if (!pages.length) return;
  const rows = pages.map((p) => ({ id: p.id, ...pageMeta(p) }));
  await service.query(
    `insert into public.notion_page_cache (workspace_id, notion_page_id, title, icon, url, last_edited_time, archived, fetched_at)
     select $1::uuid, x.id, x.title, x.icon, x.url, x.last_edited_time::timestamptz, coalesce(x.archived, false), now()
       from jsonb_to_recordset($2::jsonb) as x(id text, title text, icon text, url text, last_edited_time text, archived boolean)
     on conflict (workspace_id, notion_page_id) do update set title = excluded.title, icon = excluded.icon, url = excluded.url,
       last_edited_time = excluded.last_edited_time, archived = excluded.archived, fetched_at = now()`, [ws, J(rows)]);
}

/** The baselines of these pages' links in the workspace (by link id). */
async function loadBaselines(service: Tx, ws: string, by: { pages: string[] } | { links: string[] }): Promise<Map<string, Baseline>> {
  const out = new Map<string, Baseline>();
  const ids = "pages" in by ? by.pages : by.links;
  if (!ids.length) return out;
  const r = await service.query<{ id: string; synced: unknown }>(
    `select s.link_id::text as id, s.synced from public.notion_link_state s join public.notion_links l on l.id = s.link_id
      where l.workspace_id = $1::uuid and ${"pages" in by ? "l.notion_page_id" : "l.id::text"} in (select jsonb_array_elements_text($2::jsonb))`,
    [ws, J(ids)]);
  for (const x of r) {
    let raw = x.synced;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { raw = null; } }
    const b = readBaseline(raw);
    if (b) out.set(x.id, b);
  }
  return out;
}
async function saveBaselines(service: Tx, items: { id: string; b: Baseline }[]) {
  if (!items.length) return;
  await service.query(
    `insert into public.notion_link_state (link_id, synced, updated_at)
     select x.id, x.b, now() from jsonb_to_recordset($1::jsonb) as x(id uuid, b jsonb)
     on conflict (link_id) do update set synced = excluded.synced, updated_at = now()`, [J(items)]);
}

export const LEASE_SEC = 180;
/** One import or sync run per database at a time: a lease row in rate_limits.
 *  Returns its release, or null when someone else holds it. Fails open (with
 *  a warning) if the limiter can't be reached, like the rate limits. */
export async function takeLease(deps: Pick<SyncDeps, "db" | "log">, ws: string, databaseId: string): Promise<(() => Promise<void>) | null> {
  const key = `kanbo:notion:lease:${ws}:${parseNotionId(databaseId) ?? databaseId}`.slice(0, 200);
  let at: string;
  try {
    const r = await deps.db.service.query<{ at: string }>(
      `insert into public.rate_limits as rl (key, last_at, count) values ($1, now(), 1)
       on conflict (key) do update set last_at = now(), count = 1 where rl.last_at <= now() - make_interval(secs => $2::int)
       returning rl.last_at::text as at`, [key, LEASE_SEC]);
    if (!r[0]) return null;
    at = r[0].at;
  } catch (e) {
    deps.log("warn", "notion lease unavailable (carrying on)", { error: String((e as Error)?.message ?? e).slice(0, 120) });
    return async () => {};
  }
  return async () => {
    try { await deps.db.service.query(`delete from public.rate_limits where key = $1 and last_at = $2::timestamptz`, [key, at]); } catch { /* it expires */ }
  };
}

/* ------------------------------------------------------------ a run */

interface Run {
  deps: SyncDeps;
  api: NotionApi;
  scope: UserScope & { workspaceId: string };
  projectId: string;
  databaseId: string;
  syncId: string | null;
  mapping: NotionFieldMapping;
  direction: Direction;
  /** import without a sync: pages already in the project are skipped, never updated */
  createOnly: boolean;
  ctx: Ctx;
  stats: SyncStats;
  notes: string[];
  seen: Map<string, NPage>;
  maxEdited: number | null;
  /** an incremental run: pages created before this (ms) were all seen by an earlier run */
  knownBefore: number | null;
  deadline: number;
  maxRequests: number;
}
const note = (run: Run, s: string) => { if (run.notes.length < 20 && !run.notes.includes(s)) run.notes.push(s); };
const timeLeft = (run: Run) => run.deadline - run.deps.now();
const canAsk = (run: Run, reserveMs = 3000) => run.api.calls < run.maxRequests && timeLeft(run) > reserveMs;

/** Settle a linked task with its page on Kanbo's side, as the person: plan
 *  the merge, apply the fields that come in. Returns the link's bookkeeping
 *  (s: the task's updated_at to remember, null = keep the old one because
 *  fields wait to go to Notion), or why nothing was written ("changed": the
 *  task was edited since `row` was read; "refused": RLS said no). */
type Settled = { kind: "ok"; s: string | null; base: Baseline } | { kind: "changed" | "refused" };
async function settleIn(tx: Tx, run: Run, row: LinkTaskRow, page: NPage, f: PageFields, base: Baseline | null): Promise<Settled> {
  const task = asTask(row);
  const plan = planSync(task, f, run.mapping, run.ctx, base, {
    notionLater: ms(page.last_edited_time) * 1000 > Number(row.updated_us), twoWay: run.direction === "two_way",
  });
  let at = row.updated_at;
  if (plan.pull.length) {
    const { patch, changed } = pullPatch(f, task, run.mapping, run.ctx, plan.pull);
    if (changed.length) {
      const out = await applyPatch(tx, run.scope.userId, run.scope.workspaceId, run.ctx, task, row.updated_at, patch);
      if (!out.ok) return { kind: out.why };
      at = out.at;
      run.stats.updated++;
    }
  }
  return { kind: "ok", s: plan.push.length ? null : at, base: nextBaseline(base, plan, plan.pull, []) };
}

/** One query response: create the new pages' tasks, merge the changed ones. */
async function pullBatch(run: Run, pages: NPage[]) {
  const { deps, scope } = run;
  const ws = scope.workspaceId;
  // ids in the one spelling the database accepts (Notion sends it already; never trust it), each page once
  const uniq = new Map<string, NPage>();
  for (const p of pages) {
    if (!p || typeof p.id !== "string" || p.archived || p.in_trash || !Number.isFinite(ms(p.last_edited_time))) continue;
    const id = parseNotionId(p.id);
    if (id && !uniq.has(id)) uniq.set(id, { ...p, id });
  }
  const live = [...uniq.values()];
  run.stats.skipped += pages.length - live.length;
  for (const p of live) {
    run.seen.set(p.id, p);
    const t = ms(p.last_edited_time);
    if (run.maxEdited == null || t > run.maxEdited) run.maxEdited = t;
  }
  if (!live.length) return;
  const ids = live.map((p) => p.id);
  const bases = run.createOnly ? new Map<string, Baseline>() : await loadBaselines(deps.db.service, ws, { pages: ids });

  const linkTouches: LinkTouch[] = [];
  const adopted: (LinkTouch & { task: string })[] = [];
  const newLinks: { task_id: string; page_id: string; s: string; e: string }[] = [];
  const newBases = new Map<string, Baseline>();   // task id → baseline (new tasks)
  const baseSaves: { id: string; b: Baseline }[] = [];
  const adoptedBases = new Map<string, Baseline>();   // link id → baseline (taken over)
  const cached: NPage[] = [];

  await deps.db.withUser(scope, async (tx) => {
    let rows: LinkTaskRow[] = [];
    let existing = new Set<string>();
    let plain = new Map<string, LinkTaskRow>();
    let known = new Set<string>();
    if (run.syncId) {
      // lock the tasks these pages are linked to (by this sync, or by this database's importer) until
      // the batch commits: each is merged with the copy read below, and no edit lands in between
      await tx.query(
        `select t.id from public.tasks t
          where t.workspace_id = $1::uuid and t.archived_at is null
            and t.id in (select l.task_id from public.notion_links l
                          where l.workspace_id = $1::uuid and l.notion_page_id in (select jsonb_array_elements_text($2::jsonb))
                            and (l.sync_id = $3::uuid or (l.sync_id is null and l.notion_database_id = public.notion_norm_id($4))))
          order by t.id for update of t`, [ws, J(ids), run.syncId, run.databaseId]);
      rows = await tx.query<LinkTaskRow>(
        `select ${LINK_COLS}, ${TASK_COLS}, (l.last_synced_at is null or t.updated_at > l.last_synced_at) as k_changed
           from public.notion_links l left join public.tasks t on t.id = l.task_id
          where l.sync_id = $1::uuid and l.notion_page_id in (select jsonb_array_elements_text($2::jsonb))`, [run.syncId, J(ids)]);
      // pages this database's importer already linked (plainly) to a task in the project — a one-off import,
      // or a sync that was removed — are taken over rather than imported twice. Only importer-made links
      // carry the database's id; a link someone added by hand never does, and is never taken over.
      const free = rows.length === ids.length ? [] : await tx.query<LinkTaskRow>(
        `select distinct on (l.notion_page_id) ${LINK_COLS}, ${TASK_COLS}
           from public.notion_links l join public.tasks t on t.id = l.task_id
          where l.workspace_id = $1::uuid and l.sync_id is null and l.notion_database_id = public.notion_norm_id($4)
            and t.project_id = $2 and t.archived_at is null
            and l.notion_page_id in (select jsonb_array_elements_text($3::jsonb))
            and not exists (select 1 from public.notion_links o where o.task_id = l.task_id and o.kind = 'synced' and o.id <> l.id)
          order by l.notion_page_id, l.created_at`, [ws, run.projectId, J(ids), run.databaseId]);
      plain = new Map(free.map((r) => [r.notion_page_id, r]));
      if (run.knownBefore != null && rows.length < ids.length) {
        const c = await tx.query<{ p: string }>(
          `select notion_page_id as p from public.notion_page_cache where workspace_id = $1::uuid and notion_page_id in (select jsonb_array_elements_text($2::jsonb))`, [ws, J(ids)]);
        known = new Set(c.map((x) => x.p));
      }
    } else {
      const got = await tx.query<{ p: string }>(
        `select l.notion_page_id as p from public.notion_links l join public.tasks t on t.id = l.task_id
          where l.workspace_id = $1::uuid and t.project_id = $2 and l.notion_page_id in (select jsonb_array_elements_text($3::jsonb))`,
        [ws, run.projectId, J(ids)]);
      existing = new Set(got.map((g) => g.p));
    }
    const byPage = new Map(rows.map((r) => [r.notion_page_id, r]));
    const takenTasks = new Set<string>();

    const creates: { id: string; page: NPage; row: Record<string, unknown> }[] = [];
    for (const page of live) {
      const f = readPage(page, run.mapping);
      const row = byPage.get(page.id);
      if (!row) {
        if (existing.has(page.id)) { run.stats.skipped++; continue; }
        const own = plain.get(page.id);
        if (own?.t_id && own.t_ws === ws) {
          // one task, one synced page: a second page on the same task waits (its plain link stays)
          if (takenTasks.has(own.t_id)) { run.stats.skipped++; note(run, `“${oneLine(f.title, 60)}” is linked to a task that already syncs with another page, so it was left out.`); continue; }
          takenTasks.add(own.t_id);
          // take the importer's link over, merged with the baseline the import left
          const r = await settleIn(tx, run, own, page, f, bases.get(own.link_id) ?? null);
          if (r.kind !== "ok") { run.stats.skipped++; continue; }   // its plain link stays; the next run tries again
          adopted.push({ id: own.link_id, s: r.s, e: page.last_edited_time, task: own.t_id });
          adoptedBases.set(own.link_id, r.base);
          cached.push(page);
          continue;
        }
        // a page this workspace has seen before, older than the last full read, that lost its link:
        // its task was deleted (or unlinked) in Kanbo, so don't bring it back. A page moved into the
        // database from elsewhere was never seen, and is imported.
        if (run.knownBefore != null && known.has(page.id) && ms(page.created_time) < run.knownBefore) { run.stats.skipped++; continue; }
        const nt = taskFromPage(f, run.mapping, run.ctx);
        creates.push({ id: deps.newId(), page, row: { ...nt, tagValues: nt.tags } });
        continue;
      }
      if (run.createOnly) { run.stats.skipped++; continue; }
      if (!row.t_id || row.archived || row.t_ws !== ws) { run.stats.skipped++; continue; }
      const notionNewer = row.notion_ms == null || ms(page.last_edited_time) > Number(row.notion_ms);
      if (!row.k_changed && !notionNewer) continue;   // nobody touched either side since the last sync (our own write coming back)
      const base = bases.get(row.link_id) ?? null;
      const r = await settleIn(tx, run, row, page, f, base);
      if (r.kind !== "ok") {
        // "changed" (edited in Kanbo since it was read): link and baseline stay as they were, so the next run merges again
        run.stats.skipped++;
        if (r.kind === "refused") note(run, `Kanbo couldn't update “${oneLine(row.title, 60)}”.`);
        continue;
      }
      linkTouches.push({ id: row.link_id, s: r.s, e: page.last_edited_time });
      if (!sameBaseline(base, r.base)) baseSaves.push({ id: row.link_id, b: r.base });
      cached.push(page);
    }

    if (creates.length) {
      type NewRow = ReturnType<typeof taskFromPage> & { tagValues: TagValue[] };
      // every missing tag in one statement, then each row's ids from the context
      await tagIds(tx, scope.userId, ws, run.ctx, creates.flatMap((c) => (c.row as NewRow).tagValues));
      const rowsIn = [];
      for (const [n, c] of creates.entries()) {
        const r = c.row as NewRow;
        rowsIn.push({
          id: c.id, n, title: r.title, description: r.description, status: r.status, assignee_id: r.assignee_id,
          due_date: r.due_date, start_date: r.start_date, tags: await tagIds(tx, scope.userId, ws, run.ctx, r.tagValues),
        });
      }
      const made = await tx.query<{ id: string; u: string }>(
        `insert into public.tasks (id, user_id, title, description, status, priority, project_id, assignee_id, workspace_id,
                                   due_date, start_date, completed_at, tags, plan_today, position)
         select x.id, $1::uuid, x.title, x.description, x.status, 'medium', $2, x.assignee_id, $3::uuid,
                x.due_date::date, x.start_date::date, case when x.status = 'done' then current_date end,
                array(select jsonb_array_elements_text(x.tags)), false, extract(epoch from clock_timestamp()) * 1000 + x.n
           from jsonb_to_recordset($4::jsonb) as x(id uuid, n int, title text, description text, status text, assignee_id text,
                                                  due_date text, start_date text, tags jsonb)
         returning id::text as id, updated_at::text as u`, [scope.userId, run.projectId, ws, J(rowsIn)]);
      const madeAt = new Map(made.map((m) => [m.id, m.u]));
      for (const [i, c] of creates.entries()) {
        const u = madeAt.get(c.id);
        if (!u) continue;
        newLinks.push({ task_id: c.id, page_id: c.page.id, s: u, e: c.page.last_edited_time });
        const r = rowsIn[i];
        // the task was made from the page: what Kanbo now holds is what both sides agree on
        newBases.set(c.id, baselineOf({
          id: c.id, title: r.title, description: r.description, status: r.status, due_date: r.due_date, start_date: r.start_date,
          assignee_id: r.assignee_id, tags: r.tags,
        }, run.mapping, run.ctx));
        cached.push(c.page);
      }
      run.stats.created += madeAt.size;
    }
  });

  // bookkeeping (service): links, their baselines and the page cache
  if (newLinks.length) {
    const made = await deps.db.service.query<{ id: string; task_id: string }>(
      `insert into public.notion_links (workspace_id, task_id, notion_page_id, notion_database_id, sync_id, kind,
                                        last_synced_at, notion_last_edited, created_by)
       select $1::uuid, x.task_id, x.page_id, public.notion_norm_id($2), $3::uuid, $4, x.s::timestamptz, x.e::timestamptz, $5::uuid
         from jsonb_to_recordset($6::jsonb) as x(task_id uuid, page_id text, s text, e text)
       on conflict do nothing
       returning id::text as id, task_id::text as task_id`,
      [ws, run.databaseId, run.syncId, run.syncId ? "synced" : "reference", scope.userId, J(newLinks)]);
    for (const l of made) { const b = newBases.get(l.task_id); if (b) baseSaves.push({ id: l.id, b }); }
  }
  if (adopted.length) {
    // one synced page per task, one task per page: a link that would break either (someone else got
    // there first) stays as it is, and the run carries on
    try {
      const took = await deps.db.service.query<{ id: string }>(
        `update public.notion_links l set kind = 'synced', sync_id = $1::uuid, notion_database_id = public.notion_norm_id($2),
                last_synced_at = x.s::timestamptz, notion_last_edited = x.e::timestamptz
           from jsonb_to_recordset($3::jsonb) as x(id uuid, s text, e text)
          where l.id = x.id and l.sync_id is null
            and not exists (select 1 from public.notion_links o where o.task_id = l.task_id and o.kind = 'synced' and o.id <> l.id)
            and not exists (select 1 from public.notion_links o where o.sync_id = $1::uuid and o.notion_page_id = l.notion_page_id)
          returning l.id::text as id`, [run.syncId, run.databaseId, J(adopted.map(({ id, s, e }) => ({ id, s, e })))]);
      for (const t of took) { const b = adoptedBases.get(t.id); if (b) baseSaves.push({ id: t.id, b }); }
      if (took.length < adopted.length) note(run, "Some pages already linked to tasks couldn't be taken over by the sync. Their tasks keep a plain link.");
    } catch (e) {
      deps.log("warn", "notion take-over failed", { error: String((e as Error)?.message ?? e).slice(0, 200) });
      note(run, "Some pages already linked to tasks couldn't be taken over by the sync. Their tasks keep a plain link.");
    }
  }
  await touchLinks(deps.db.service, linkTouches);
  await saveBaselines(deps.db.service, baseSaves);
  await cachePages(deps.db.service, ws, cached);
}

/** Read the database from the cursor (or from the start), as far as the run's budget allows.
 *  `maxNew`: stop once this many tasks were made (pages already there don't count).
 *  `byCreated`: a one-off import reads oldest-created first (from `after`, when it
 *  carries on); `reached` follows the newest created_time read so far, which is
 *  where the next import carries on from (it survives a run that throws). */
async function pullAll(run: Run, cursor: SyncCursor, opts: { maxNew?: number; byCreated?: { after: string | null; reached: string | null } } = {}):
  Promise<{ cursor: SyncCursor; done: boolean }> {
  const since = cursor.since;
  let next = cursor.next;
  const made0 = run.stats.created;
  const maxNew = opts.maxNew ?? Infinity;
  const by = opts.byCreated;
  const after = by?.after ?? null;
  let retriedCursor = false;
  while (canAsk(run) && run.stats.created - made0 < maxNew) {
    const body: Record<string, unknown> = by
      ? {
        page_size: 100,
        sorts: [{ timestamp: "created_time", direction: "ascending" }],
        ...(after ? { filter: { timestamp: "created_time", created_time: { on_or_after: after } } } : {}),
        ...(next ? { start_cursor: next } : {}),
      }
      : {
        page_size: 100,
        sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
        ...(since ? { filter: { timestamp: "last_edited_time", last_edited_time: { on_or_after: new Date(ms(since) - OVERLAP_MS).toISOString() } } } : {}),
        ...(next ? { start_cursor: next } : {}),
      };
    let res;
    try {
      res = await run.api.query(run.databaseId, body);
    } catch (e) {
      // a stale cursor from an earlier run: start that query again
      if (isNotionError(e) && e.kind === "validation" && next && !retriedCursor) { next = null; retriedCursor = true; continue; }
      if (isNotionError(e) && e.kind === "timeout") break;
      throw e;
    }
    const results = Array.isArray(res?.results) ? res.results : [];
    await pullBatch(run, results);
    // every page up to the newest created here has been read (oldest-created first)
    if (by) {
      for (const p of results) {
        const c = ms(p?.created_time);
        if (Number.isFinite(c) && (by.reached == null || c > ms(by.reached))) by.reached = new Date(c).toISOString();
      }
    }
    if (!res.has_more || !res.next_cursor) {
      const newest = run.maxEdited != null ? new Date(run.maxEdited).toISOString() : since;
      return { cursor: { since: newest && since && ms(since) > ms(newest) ? since : newest, next: null }, done: true };
    }
    next = res.next_cursor;
  }
  return { cursor: { since, next }, done: false };
}

/** Kanbo → Notion: the linked tasks changed since their last sync, merged with their page field by field.
 *  Each task is read again (and locked) after its page is fetched, so the merge, what comes in and what
 *  goes out are all planned from the task as it is then, never from the copy read before the request. */
async function pushChanged(run: Run, limit: number) {
  const { deps, scope } = run;
  const ws = scope.workspaceId;
  const rows = await deps.db.withUser({ ...scope, readOnly: true }, (tx) => tx.query<LinkTaskRow>(
    `select ${LINK_COLS}, ${TASK_COLS} from public.notion_links l join public.tasks t on t.id = l.task_id
      where l.sync_id = $1::uuid and t.workspace_id = $2::uuid and t.archived_at is null
        and t.updated_at > coalesce(l.last_synced_at, '-infinity'::timestamptz)
      order by t.updated_at asc, t.id limit $3`, [run.syncId, ws, limit]));
  if (!rows.length) return;
  // after this run's pull wrote them
  const bases = await loadBaselines(deps.db.service, ws, { links: rows.map((r) => r.link_id) });
  let usersLoaded = false;
  const loadUsers = async () => {
    if (usersLoaded) return;
    usersLoaded = true;
    const map = new Map<string, string>();
    let cursor: string | null = null;
    for (let i = 0; i < 5 && canAsk(run); i++) {
      const res = await run.api.users(cursor);
      for (const u of res.results ?? []) {
        const email = u?.person?.email;
        if (u?.type === "person" && typeof email === "string" && email.includes("@")) map.set(email.trim().toLowerCase(), u.id);
      }
      if (!res.has_more || !res.next_cursor) break;
      cursor = res.next_cursor;
    }
    run.ctx.notionUserByEmail = map;
  };

  for (const read of rows) {
    if (!canAsk(run, 4000)) break;
    let row = read;
    let task = asTask(row);
    let page = run.seen.get(row.notion_page_id);
    try {
      if (!page) page = await run.api.page(row.notion_page_id);
    } catch (e) {
      if (isNotionError(e) && e.kind === "timeout") break;
      if (isNotionError(e) && (e.kind === "rate_limited" || e.kind === "invalid_token")) throw e;
      note(run, `Kanbo couldn't read the Notion page for “${oneLine(task.title, 60)}”. It may have been deleted or unshared.`);
      run.stats.skipped++;
      await touchLinks(deps.db.service, [{ id: row.link_id, s: row.updated_at, e: null }]);
      continue;
    }
    if (page.archived || page.in_trash) {
      await deps.db.withUser(scope, (tx) => archiveTask(tx, task.id, ws));
      await touchLinks(deps.db.service, [{ id: row.link_id, s: null, e: page.last_edited_time }]);
      await cachePages(deps.db.service, ws, [page]);
      run.stats.updated++;
      continue;
    }
    const f = readPage(page, run.mapping);
    const base = bases.get(row.link_id) ?? null;
    const p = page;
    // The task may have been edited while its page was fetched: lock it, read it again and plan the
    // merge from that copy, in the transaction that writes what comes in (no Notion request inside it).
    const settled = await deps.db.withUser(scope, async (tx) => {
      const now = await lockTask(tx, read.t_id!, ws);
      if (!now) return { kind: "gone" as const };
      const cur: LinkTaskRow = { ...read, ...now };
      const t = asTask(cur);
      const plan = planSync(t, f, run.mapping, run.ctx, base, { notionLater: ms(p.last_edited_time) * 1000 > Number(cur.updated_us), twoWay: true });
      let at = cur.updated_at;
      let pulled: SyncField[] = [];
      let refused = false;
      // fields Notion changed since the last sync (that this run's query didn't bring in) come in
      if (plan.pull.length) {
        const { patch, changed } = pullPatch(f, t, run.mapping, run.ctx, plan.pull);
        if (!changed.length) pulled = plan.pull;
        else {
          const out = await applyPatch(tx, scope.userId, ws, run.ctx, t, cur.updated_at, patch);
          if (out.ok) { at = out.at; pulled = plan.pull; run.stats.updated++; }
          else if (out.why === "changed") return { kind: "changed" as const };
          else refused = true;
        }
      }
      return { kind: "ok" as const, cur, plan, at, pulled, refused };
    });
    // edited again under us (the lock makes this a backstop): the link and its baseline stay as they
    // were, so the next run merges again
    if (settled.kind === "changed") { run.stats.skipped++; continue; }
    // archived, moved or deleted meanwhile (or not the person's to change): not fetched again until it changes
    if (settled.kind === "gone") {
      run.stats.skipped++;
      await touchLinks(deps.db.service, [{ id: row.link_id, s: row.updated_at, e: null }]);
      continue;
    }
    row = settled.cur;
    task = asTask(row);
    const plan = settled.plan;
    const at: string = settled.at;
    const pulled: SyncField[] = settled.pulled;
    if (settled.refused) note(run, `Kanbo couldn't update “${oneLine(task.title, 60)}”.`);
    let pushed: SyncField[] = [];
    let edited: string | null = page.last_edited_time;
    let retry = false;              // Notion stopped us part-way: last_synced_at stays, so the next run tries again
    let stopRun: unknown = null;    // a 429 or a revoked token stops the run, after this task's bookkeeping
    // fields Kanbo changed go out: only those
    if (plan.push.length) {
      let ready = true;
      if (plan.push.includes("assignee") && task.assignee_id && !usersLoaded) {
        try { await loadUsers(); } catch (e) {
          if (isNotionError(e) && e.kind === "timeout") { retry = true; ready = false; }
          else note(run, "Kanbo couldn't read your Notion workspace's people, so assignees weren't sent.");
        }
      }
      const { properties, changed } = ready ? pushProperties(task, f, run.mapping, run.ctx, plan.push) : { properties: {}, changed: [] as SyncField[] };
      if (changed.length) {
        try {
          const updated = await run.api.updatePage(row.notion_page_id, properties);
          edited = updated?.last_edited_time ?? page.last_edited_time;
          await cachePages(deps.db.service, ws, [updated?.id ? updated : page]);
          pushed = changed;
          run.stats.pushed++;
        } catch (e) {
          if (isNotionError(e) && e.kind === "timeout") retry = true;
          else if (isNotionError(e) && (e.kind === "rate_limited" || e.kind === "invalid_token")) { retry = true; stopRun = e; }
          else {
            if (isNotionError(e) && e.kind === "archived") {
              await deps.db.withUser(scope, (tx) => archiveTask(tx, task.id, ws));
              run.stats.updated++;
            } else {
              note(run, `“${oneLine(task.title, 60)}” couldn't be updated in Notion: ${syncErrorText(e, "page").replace(/\.$/, "")}.`);
              run.stats.skipped++;
            }
            // don't try the same change again every run
            edited = null;
          }
        }
      }
    }
    await touchLinks(deps.db.service, [{ id: row.link_id, s: retry ? null : at, e: edited }]);
    const b = nextBaseline(base, plan, pulled, pushed);
    if (!sameBaseline(base, b)) await saveBaselines(deps.db.service, [{ id: row.link_id, b }]);
    if (stopRun) throw stopRun;
    if (retry) break;
  }
}

/** Pages archived in Notion drop out of database queries: check a few linked pages a run. */
async function sweepArchived(run: Run, limit: number) {
  const { deps, scope } = run;
  const ws = scope.workspaceId;
  const rows = await deps.db.withUser({ ...scope, readOnly: true }, (tx) => tx.query<{ link_id: string; notion_page_id: string; task_id: string }>(
    `select l.id::text as link_id, l.notion_page_id, l.task_id::text as task_id
       from public.notion_links l left join public.notion_page_cache c on c.workspace_id = l.workspace_id and c.notion_page_id = l.notion_page_id
      where l.sync_id = $1::uuid
      order by c.fetched_at asc nulls first, l.id limit $2`, [run.syncId, limit + run.seen.size]));
  let n = 0;
  for (const r of rows) {
    if (n >= limit || !canAsk(run, 4000)) break;
    if (run.seen.has(r.notion_page_id)) continue;
    n++;
    let page: NPage;
    try { page = await run.api.page(r.notion_page_id); } catch (e) {
      if (isNotionError(e) && (e.kind === "rate_limited" || e.kind === "invalid_token")) throw e;
      if (isNotionError(e) && e.kind === "timeout") break;
      // gone or unshared: look at it again later, after the others
      await deps.db.service.query(`update public.notion_page_cache set fetched_at = now() where workspace_id = $1::uuid and notion_page_id = $2`, [ws, r.notion_page_id]);
      continue;
    }
    await cachePages(deps.db.service, ws, [page]);
    if (page.archived || page.in_trash) {
      const u = await deps.db.withUser(scope, (tx) => archiveTask(tx, r.task_id, ws));
      if (u) run.stats.updated++;
    }
  }
}

/* ------------------------------------------------------------ syncs */

export interface SyncRow {
  id: string; workspace_id: string; project_id: string; database_id: string; database_title: string | null;
  mapping: unknown; direction: string; last_cursor: string | null; created_by: string | null;
}
const SYNC_COLS = `id::text as id, workspace_id::text as workspace_id, project_id::text as project_id, database_id, database_title,
  mapping, direction, last_cursor, created_by::text as created_by`;

/** Take a sync for a run: nobody else runs it until `leaseSec` has passed. Null when it's running / disabled. */
export async function claimSync(service: Tx, syncId: string, leaseSec: number): Promise<SyncRow | null> {
  const r = await service.query<SyncRow>(
    `update public.notion_syncs set last_run_at = now()
      where id = $1::uuid and enabled and (last_run_at is null or last_run_at < now() - make_interval(secs => $2::int))
      returning ${SYNC_COLS}`, [syncId, leaseSec]);
  return r[0] ?? null;
}

/** The syncs due a scheduled run (every 10 minutes: not run in the last 9). */
export async function dueSyncs(service: Tx, limit = 25): Promise<string[]> {
  const r = await service.query<{ id: string }>(
    `select s.id::text as id from public.notion_syncs s join public.workspace_integrations i on i.workspace_id = s.workspace_id
      where s.enabled and i.notion_token is not null and (s.last_run_at is null or s.last_run_at < now() - interval '9 minutes')
      order by s.last_run_at asc nulls first limit $1`, [limit]);
  return r.map((x) => x.id);
}

async function record(service: Tx, syncId: string, cursor: SyncCursor | null, stats: SyncStats, error: string | null, success: boolean) {
  await service.query(
    `update public.notion_syncs set last_cursor = coalesce($2, last_cursor), stats = $3::jsonb,
            last_success_at = case when $4::boolean then now() else last_success_at end,
            last_error = $5::text, last_error_at = case when $5::text is null then null else now() end
      where id = $1::uuid`,
    [syncId, cursor ? formatCursor(cursor) : null, J(stats), success, error ? error.slice(0, 1000) : null]);
}

export interface RunResult {
  stats: SyncStats; error: string | null; fatal: boolean;
  /** the database was being imported (or synced) by someone else: nothing ran, nothing recorded */
  busy?: boolean;
}

/** One run of a claimed sync. Never throws: the outcome is recorded on the sync and returned. */
export async function runSync(deps: SyncDeps, sync: SyncRow, opts: { deadline: number; maxRequests?: number; pushLimit?: number; sweep?: number }): Promise<RunResult> {
  const stats: SyncStats = { created: 0, updated: 0, pushed: 0, skipped: 0 };
  const release = await takeLease(deps, sync.workspace_id, sync.database_id);
  if (!release) return { stats, error: null, fatal: false, busy: true };
  try {
    return await runLeased(deps, sync, opts, stats);
  } finally {
    await release();
  }
}

async function runLeased(deps: SyncDeps, sync: SyncRow, opts: { deadline: number; maxRequests?: number; pushLimit?: number; sweep?: number }, stats: SyncStats): Promise<RunResult> {
  let cursor: SyncCursor | null = null;
  let run: Run | null = null;
  let fatal: string | null = null;
  try {
    const ws = sync.workspace_id;
    if (!sync.created_by) throw new SyncStop(SYNC_TEXT.noUser);
    if (!["owner", "admin", "member"].includes(await actingRole(deps.db.service, sync.created_by, ws))) throw new SyncStop(SYNC_TEXT.noUser);
    const mapping = readMapping(sync.mapping);
    if (!mapping) throw new SyncStop(SYNC_TEXT.badMapping);
    const token = await readToken(deps.db.service, ws);
    if (!token) throw new SyncStop(SYNC_TEXT.notConnected);
    const scope = { userId: sync.created_by, workspaceId: ws };
    const ctx = await deps.db.withUser({ ...scope, readOnly: true }, async (tx) => {
      const p = await tx.query<{ ws: string | null; archived: boolean }>(
        `select workspace_id::text as ws, archived_at is not null as archived from public.projects where id = $1::uuid`, [sync.project_id]);
      if (!p[0] || p[0].ws !== ws || p[0].archived) throw new SyncStop(SYNC_TEXT.projectGone);
      return loadContext(tx, ws);
    });
    run = {
      deps, api: deps.notion(token, opts.deadline), scope, projectId: sync.project_id, databaseId: sync.database_id, syncId: sync.id,
      mapping, direction: sync.direction === "from_notion" ? "from_notion" : "two_way", createOnly: false, ctx,
      stats, notes: [], seen: new Map(), maxEdited: null, knownBefore: null, deadline: opts.deadline, maxRequests: opts.maxRequests ?? 90,
    };
    const start = parseCursor(sync.last_cursor);
    if (start.since) run.knownBefore = ms(start.since) - OVERLAP_MS;
    const pulled = await pullAll(run, start);
    cursor = pulled.cursor;
    if (run.direction === "two_way") await pushChanged(run, opts.pushLimit ?? 40);
    if ((opts.sweep ?? 5) > 0 && canAsk(run, 6000)) await sweepArchived(run, opts.sweep ?? 5);
  } catch (e) {
    fatal = syncErrorText(e);
    if (!(e instanceof SyncStop) && !isNotionError(e)) deps.log("error", "notion sync failed", { sync: sync.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  stats.at = new Date(deps.now()).toISOString();
  const notes = run?.notes ?? [];
  const error = fatal ?? (notes.length ? (notes.length === 1 ? notes[0] : `${notes[0]} (and ${notes.length - 1} more)`) : null);
  try {
    await record(deps.db.service, sync.id, cursor, stats, error, !fatal);
  } catch (e) {
    deps.log("error", "notion sync bookkeeping failed", { sync: sync.id, error: String((e as Error)?.message ?? e).slice(0, 300) });
  }
  return { stats, error, fatal: !!fatal };
}

/* ------------------------------------------------------------ import */

export interface ImportInput {
  userId: string;
  workspaceId: string;
  databaseId: string;
  mapping: unknown;
  projectId: string | null;
  newProject: { name: string; emoji: string; color: string } | null;
  keepInSync: boolean;
  direction: Direction;
  /** a one-off import carrying on: pages created before this were read last time */
  resume?: string | null;
}
export interface ImportOutcome {
  projectId: string; syncId: string | null; created: number; skipped: number; errors: string[]; partial: boolean;
  /** a one-off import that stopped part-way: send it back to carry on ("Import the rest") */
  resume: string | null;
}
/** A one-off import makes at most this many tasks a request (pages already there don't count). */
export const IMPORT_MAX_PAGES = 1000;

/** Import a database into a project (as the caller), optionally keeping it in sync. */
export async function importDatabase(deps: SyncDeps, api: NotionApi, input: ImportInput, deadline: number): Promise<ImportOutcome> {
  const ws = input.workspaceId;
  const scope = { userId: input.userId, workspaceId: ws };
  const db = await api.database(input.databaseId);
  const schema = schemaOf(db);
  const checked = checkMapping(input.mapping, schema);
  if (!checked.ok) throw new NotionActionError(400, "invalid", checked.error);
  const mapping = checked.mapping;
  const databaseId = parseNotionId(String(db.id ?? "")) ?? input.databaseId;

  // one import (or sync run) of a database at a time: a double submit or two admins can't both import it
  const release = await takeLease(deps, ws, databaseId);
  if (!release) throw new NotionActionError(409, "rate_limited", SYNC_TEXT.busy, 60);
  try {
    return await importLeased(deps, api, input, { scope, schema, mapping, databaseId }, deadline);
  } finally {
    await release();
  }
}

async function importLeased(deps: SyncDeps, api: NotionApi, input: ImportInput,
  c: { scope: UserScope & { workspaceId: string }; schema: ReturnType<typeof schemaOf>; mapping: NotionFieldMapping; databaseId: string },
  deadline: number): Promise<ImportOutcome> {
  const { scope, schema, mapping, databaseId } = c;
  const ws = scope.workspaceId;
  // the project (and the sync), as the caller
  const { projectId, syncId } = await deps.db.withUser(scope, async (tx) => {
    if (input.keepInSync) {
      const s = await tx.query<{ id: string }>(`select id::text as id from public.notion_syncs where workspace_id = $1::uuid and database_id = public.notion_norm_id($2)`, [ws, databaseId]);
      if (s.length) throw new NotionActionError(409, "invalid", "This database already syncs with a project here. Use Sync now on it, or remove that sync first.");
    }
    let pid = input.projectId;
    if (input.newProject) {
      const made = await tx.query<{ id: string }>(
        `insert into public.projects (user_id, owner_id, name, emoji, color, workspace_id) values ($1::uuid, $1::uuid, $2, $3, $4, $5::uuid) returning id::text as id`,
        [input.userId, input.newProject.name, input.newProject.emoji, input.newProject.color, ws]);
      pid = made[0]?.id ?? null;
      if (!pid) throw new NotionActionError(403, "not_allowed", "You can't add projects to this workspace.");
    } else {
      const p = await tx.query<{ ws: string | null; archived: boolean }>(
        `select workspace_id::text as ws, archived_at is not null as archived from public.projects where id = $1::uuid`, [pid]);
      if (!p[0] || p[0].ws !== ws) throw new NotionActionError(404, "not_found", "That project isn't in this workspace.");
      if (p[0].archived) throw new NotionActionError(400, "invalid", "That project is archived. Restore it, or import into another project.");
    }
    let sid: string | null = null;
    if (input.keepInSync) {
      const s = await tx.query<{ s: { id?: string } }>(`select public.notion_save_sync($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, true) as s`,
        [ws, pid, databaseId, schema.title, J(mapping), input.direction]);
      sid = typeof s[0]?.s?.id === "string" ? s[0].s.id : null;
    }
    return { projectId: pid as string, syncId: sid };
  });
  // the import is this sync's first run
  if (syncId) await deps.db.service.query(`update public.notion_syncs set last_run_at = now() where id = $1::uuid`, [syncId]);

  const ctx = await deps.db.withUser({ ...scope, readOnly: true }, (tx) => loadContext(tx, ws));
  const stats: SyncStats = { created: 0, updated: 0, pushed: 0, skipped: 0 };
  const run: Run = {
    deps, api, scope, projectId, databaseId, syncId, mapping, direction: input.direction, createOnly: !syncId, ctx, stats,
    notes: [], seen: new Map(), maxEdited: null, knownBefore: null, deadline, maxRequests: 200,
  };
  let done = false, cursor: SyncCursor = { since: null, next: null };
  let stopped: string | null = null;
  // a one-off import reads oldest-created first, so it can carry on where it stopped; an import that
  // keeps in sync reads the way the sync does (by edit time), and the sync carries on its query
  const byCreated = syncId ? undefined : { after: input.resume ?? null, reached: input.resume ?? null };
  try {
    const r = await pullAll(run, cursor, { maxNew: IMPORT_MAX_PAGES, byCreated });
    done = r.done; cursor = r.cursor;
  } catch (e) {
    stopped = syncErrorText(e);
    if (!isNotionError(e)) deps.log("error", "notion import failed part-way", { error: String((e as Error)?.message ?? e).slice(0, 300) });
    if (!stats.created && !syncId) throw new NotionActionError(isNotionError(e) && e.kind === "rate_limited" ? 429 : 502, "notion_error", stopped);
  }
  const errors = [...run.notes];
  if (stopped) errors.unshift(`The import stopped part-way: ${stopped}`);
  else if (!done) errors.unshift(syncId
    ? "That's a big database: Kanbo brought in the first part, and the sync brings in the rest over the next runs."
    : "That's a big database: Kanbo brought in the first part. Choose Import the rest to carry on from where it stopped.");
  if (syncId) {
    stats.at = new Date(deps.now()).toISOString();
    // done: carry on from the newest page; not done: the sync continues this same query
    await record(deps.db.service, syncId, done ? cursor : { since: null, next: cursor.next }, stats, stopped, !stopped);
  }
  const partial = !done;
  return {
    projectId, syncId, created: stats.created, skipped: stats.skipped, errors: errors.slice(0, 20), partial,
    resume: partial && byCreated ? byCreated.reached : null,
  };
}
