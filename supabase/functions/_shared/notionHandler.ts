// ============================================================
// KANBO — Notion: the edge function's request handling (0046).       [a3]
//
// Pure (the database, Notion, the clock and the JWT check are passed in), so
// vitest and the PGlite replay run the real thing. notion/index.ts wires it.
//
//   POST /functions/v1/notion   (verify_jwt ON: the app sends the person's JWT)
//   body { action, …fields }
//   200  { ok: true, … }
//   4xx/5xx { error: "<sentence>", reason: NotionFailure, retryAfter? }
//
//   action       who                 body → answer
//   connect      owner/admin         { workspaceId, token } → { status }   (checks the token with Notion first)
//   test         owner/admin         { workspaceId } → { workspaceName }
//   databases    owner/admin         { workspaceId, query? } → { databases }
//   schema       owner/admin         { workspaceId, databaseId } → { schema }
//   preview      owner/admin         { workspaceId, databaseId } → { rows }   (5 pages)
//   import       owner/admin         NotionImportRequest → { result }
//   sync_now     owner/admin         { syncId } → { stats, error, fatal }
//   page         members             { workspaceId, pageId, force? } → { page }   (a linked page's title / icon)
//   link_page    can edit the task   { taskId, url } → { link }
//   cron         x-cron-secret       { mode: "sync" } → { due, ran, results }
//
// Who may do what is decided by the database, as the caller: notion_status()
// (can_manage / can_link), the definer functions' own checks and RLS. The
// integration token is read with the service connection only after that,
// and never leaves the server. Limits (rate_limits via api_rate_hit, fail
// open): 60 requests a minute per person; connect 10 / 10 min and import
// 10 / 10 min per workspace; links 30 a minute and page refreshes 60 a
// minute per person; Sync now 5 per 5 minutes per sync.
// ============================================================
import { parseNotionId, NOTION_TOKEN_RE } from "./notion.ts";
import { isNotionError, type NotionApiError } from "./notionApi.ts";
import { oneLine, pageMeta, previewRow, schemaOf, summariseDatabase, type NDatabase, type NPage, type PageMeta } from "./notionMap.ts";
import {
  claimSync, dueSyncs, importDatabase, NotionActionError, readToken, runSync, type SyncDeps,
} from "./notionSync.ts";

export interface HandlerDeps extends SyncDeps {
  /** the caller's user id from their JWT (null: not signed in) */
  authUser: (jwt: string) => Promise<string | null>;
  /** CRON_SECRET ("" = the scheduled run is off) */
  cronSecret: string;
}

export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const MAX_BODY = 64_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COLOUR = /^(oklch\(\s*[0-9.]+%?\s+[0-9.]+\s+[0-9.]+(\s*\/\s*[0-9.]+%?)?\s*\)|#[0-9a-f]{3,8})$/i;
const CACHE_FRESH_MS = 60 * 60_000;

const json = (b: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const refuse = (status: number, reason: string, error: string, retryAfter?: number) =>
  json({ error, reason, ...(retryAfter ? { retryAfter } : {}) }, status, retryAfter ? { "Retry-After": String(retryAfter) } : {});

/** Constant-time string comparison. */
export function safeEq(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}

const TEXT = {
  notMember: "You're not in this workspace.",
  manageOnly: "Only workspace owners and admins can do that.",
  notConnected: "Notion isn't connected to this workspace.",
  unavailable: "Notion isn't switched on for Kanbo yet.",
  notResponding: "Notion isn't responding. Try again in a moment.",
  slowDown: "Notion asked Kanbo to slow down. Try again in a minute.",
  tooMany: "That's a lot of requests in a short time. Try again in a minute.",
  savedTokenRefused: "Notion no longer accepts the saved secret. An owner or admin can paste a new one in Settings.",
  dbNotShared: "Kanbo can't see that database. In Notion, open it and add your Kanbo integration under ••• › Connections.",
  pageNotShared: "Kanbo can't see that page yet. In Notion, open it and add your Kanbo integration under ••• › Connections.",
  wrong: "Something went wrong. Try again.",
} as const;

/** A database / RPC failure → an answer (the sentences 0046 raises). */
function dbFailure(e: unknown, deps: HandlerDeps, where: string): Response {
  if (e instanceof NotionActionError) return refuse(e.status, e.reason, e.message, e.retryAfter);
  if (isNotionError(e)) return notionFailure(e, "database");
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? "");
  if (code === "42883" || code === "42P01" || /does not exist/i.test(msg)) return refuse(503, "unavailable", TEXT.unavailable);
  if (/notion not connected/i.test(msg)) return refuse(409, "not_connected", TEXT.notConnected);
  if (/not allowed|not authorized/i.test(msg)) return refuse(403, "not_allowed", TEXT.manageOnly);
  if (/invalid token/i.test(msg)) return refuse(400, "invalid_token", "That doesn't look like a Notion integration secret. It starts with ntn_ or secret_.");
  if (/invalid project/i.test(msg)) return refuse(400, "invalid", "That project isn't in this workspace.");
  if (/invalid (mapping|database|direction)/i.test(msg)) return refuse(400, "invalid", "That database or mapping can't be saved. Check the fields and try again.");
  if (/team task/i.test(msg)) return refuse(400, "invalid", "Notion pages can only be linked to team tasks.");
  if (/too many links/i.test(msg)) return refuse(400, "invalid", "A task can have up to 20 Notion pages.");
  if (/invalid page/i.test(msg)) return refuse(400, "invalid", "That isn't a link to a Notion page.");
  if (/task not found/i.test(msg)) return refuse(404, "not_found", "That task isn't there any more, or you can't change it.");
  if (/sync not found/i.test(msg)) return refuse(404, "not_found", "That sync isn't there any more.");
  if (code === "42501" || /row-level security|permission denied/i.test(msg)) return refuse(403, "not_allowed", "You can't make that change in this workspace.");
  deps.log("error", `notion ${where} failed`, { code, error: msg.slice(0, 300) });
  return refuse(500, "error", TEXT.wrong);
}

/** A Notion failure → an answer. */
function notionFailure(e: NotionApiError, what: "database" | "page" | "token"): Response {
  switch (e.kind) {
    case "invalid_token": return what === "token"
      ? refuse(400, "invalid_token", "Notion didn't accept that secret. Copy the Internal Integration Secret again from your integration's page.")
      : refuse(409, "invalid_token", TEXT.savedTokenRefused);
    case "not_shared": return refuse(404, "not_shared", what === "page" ? TEXT.pageNotShared : TEXT.dbNotShared);
    case "rate_limited": return refuse(429, "rate_limited", TEXT.slowDown, e.retryAfter ?? 60);
    case "archived": return refuse(400, "notion_error", "That's archived in Notion.");
    case "validation": return refuse(400, "notion_error", what === "page" ? "That isn't a Notion page Kanbo can link." : "Notion turned that request down.");
    default: return refuse(502, "notion_error", TEXT.notResponding);
  }
}

async function hit(deps: HandlerDeps, key: string, windowSec: number, max: number): Promise<{ allowed: boolean; retryAfter: number }> {
  try {
    const r = await deps.db.service.query<{ allowed: boolean; retry_after: number }>(
      `select allowed, retry_after from public.api_rate_hit($1, $2, $3)`, [key, windowSec, max]);
    return { allowed: r[0]?.allowed !== false, retryAfter: Number(r[0]?.retry_after ?? 0) || 0 };
  } catch (e) {
    deps.log("warn", "notion rate limit unavailable (allowing)", { error: String((e as Error)?.message ?? e).slice(0, 120) });
    return { allowed: true, retryAfter: 0 };
  }
}

interface Status { connected: boolean; can_manage: boolean; can_link: boolean; workspace_name: string | null }
async function statusAs(deps: HandlerDeps, userId: string, ws: string): Promise<Status | null> {
  const r = await deps.db.withUser({ userId, workspaceId: ws, readOnly: true }, (tx) =>
    tx.query<{ s: Status | null }>(`select public.notion_status($1::uuid) as s`, [ws]));
  const s = r[0]?.s;
  return s && typeof s === "object" ? s : null;
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const graphemes = (s: string) => {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<unknown> } }).Segmenter;
  return Seg ? [...new Seg(undefined, { granularity: "grapheme" }).segment(s)].length : [...s].length;
};

/** A page's (or a database's) meta from Notion. */
async function fetchMeta(deps: HandlerDeps, token: string, pageId: string): Promise<PageMeta> {
  const api = deps.notion(token, deps.now() + 20_000);
  let obj: NPage | NDatabase;
  try {
    obj = await api.page(pageId);
  } catch (e) {
    // a database pasted as a page
    if (isNotionError(e) && (e.kind === "not_shared" || e.kind === "validation")) {
      try { obj = await api.database(pageId); } catch { throw e; }
    } else throw e;
  }
  return pageMeta(obj);
}

/** Keep a linked page's meta for every member (notion_page_cache: service only). */
async function storeMeta(deps: HandlerDeps, ws: string, pageId: string, meta: PageMeta) {
  await deps.db.service.query(
    `insert into public.notion_page_cache (workspace_id, notion_page_id, title, icon, url, last_edited_time, archived, fetched_at)
     values ($1::uuid, $2, $3, $4, $5, $6::timestamptz, $7, now())
     on conflict (workspace_id, notion_page_id) do update set title = excluded.title, icon = excluded.icon, url = excluded.url,
       last_edited_time = excluded.last_edited_time, archived = excluded.archived, fetched_at = now()`,
    [ws, pageId, meta.title, meta.icon, meta.url, meta.last_edited_time, meta.archived]);
}

/* ------------------------------------------------------------ the scheduled run */

export async function runCron(deps: HandlerDeps, budgetMs = 50_000): Promise<Response> {
  const end = deps.now() + budgetMs;
  const ids = await dueSyncs(deps.db.service);
  const results: { id: string; created: number; updated: number; pushed: number; skipped: number; failed: boolean }[] = [];
  for (const id of ids) {
    if (deps.now() > end - 8_000) break;
    const row = await claimSync(deps.db.service, id, 540);
    if (!row) continue;
    const r = await runSync(deps, row, { deadline: Math.min(end, deps.now() + 30_000) });
    results.push({ id, created: r.stats.created, updated: r.stats.updated, pushed: r.stats.pushed, skipped: r.stats.skipped, failed: !!r.error });
  }
  // tidy old limiter rows. (Cached pages stay: a cached page with no link is how a sync knows a
  // task was deleted in Kanbo and mustn't come back.)
  try {
    await deps.db.service.query(`delete from public.rate_limits where key like 'kanbo:notion:%' and last_at < now() - interval '1 day'`);
  } catch { /* best effort */ }
  return json({ ok: true, due: ids.length, ran: results.length, results });
}

/* ------------------------------------------------------------ requests */

export async function handleNotionRequest(req: Request, deps: HandlerDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return refuse(405, "invalid", "Method not allowed.");
  try {
    if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return refuse(413, "invalid", "That request is too big.");
    const raw = await req.text();
    if (raw.length > MAX_BODY) return refuse(413, "invalid", "That request is too big.");
    let b: Record<string, unknown>;
    try {
      const v = JSON.parse(raw || "{}");
      if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
      b = v as Record<string, unknown>;
    } catch { return refuse(400, "invalid", "That request wasn't understood."); }

    // ---- the scheduler ----
    const secret = req.headers.get("x-cron-secret");
    if (secret !== null) {
      if (!deps.cronSecret || !safeEq(secret, deps.cronSecret)) return json({ error: "unauthorized" }, 401);
      if (b.mode !== "sync") return refuse(400, "invalid", "That request wasn't understood.");
      return await runCron(deps);
    }

    // ---- who's asking ----
    const jwt = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
    const userId = jwt ? await deps.authUser(jwt) : null;
    if (!userId || !UUID.test(userId)) return refuse(401, "not_allowed", "Sign in to use Notion.");
    // suspended / unapproved people stop here (RLS and the definer functions refuse them too)
    const canAct = await deps.db.service.query<{ ok: boolean }>(`select public.user_can_act($1::uuid) as ok`, [userId]);
    if (canAct[0]?.ok !== true) return refuse(403, "not_allowed", "Your account can't use Notion right now.");
    const lim = await hit(deps, `kanbo:notion:u:${userId}`, 60, 60);
    if (!lim.allowed) return refuse(429, "rate_limited", TEXT.tooMany, lim.retryAfter);

    const action = typeof b.action === "string" ? b.action : "";
    switch (action) {
      case "connect": case "test": case "databases": case "schema": case "preview": case "import":
        return await manageAction(deps, userId, action, b);
      case "sync_now": return await syncNow(deps, userId, b);
      case "page": return await refreshPage(deps, userId, b);
      case "link_page": return await linkPage(deps, userId, b);
      default: return refuse(400, "invalid", "That request wasn't understood.");
    }
  } catch (e) {
    return dbFailure(e, deps, "request");
  }
}

/** Owner/admin actions on a workspace's connection. */
async function manageAction(deps: HandlerDeps, userId: string, action: string, b: Record<string, unknown>): Promise<Response> {
  const ws = str(b.workspaceId, 40);
  if (!UUID.test(ws)) return refuse(400, "invalid", "Notion is for team workspaces.");
  let st: Status | null;
  try { st = await statusAs(deps, userId, ws); } catch (e) { return dbFailure(e, deps, "status"); }
  if (!st) return refuse(403, "not_allowed", TEXT.notMember);
  if (!st.can_manage) return refuse(403, "not_allowed", action === "connect" ? "Only workspace owners and admins can connect Notion." : TEXT.manageOnly);

  if (action === "connect") {
    const token = str(b.token, 300);
    if (!NOTION_TOKEN_RE.test(token)) return refuse(400, "invalid_token", "That doesn't look like a Notion integration secret. It starts with ntn_ or secret_.");
    const lim = await hit(deps, `kanbo:notion:connect:${ws}`, 600, 10);
    if (!lim.allowed) return refuse(429, "rate_limited", TEXT.tooMany, lim.retryAfter);
    let bot;
    try { bot = await deps.notion(token, deps.now() + 20_000).me(); } catch (e) { return isNotionError(e) ? notionFailure(e, "token") : refuse(502, "notion_error", TEXT.notResponding); }
    const name = oneLine(typeof bot?.bot?.workspace_name === "string" ? bot.bot.workspace_name : "", 200) || null;
    const botId = typeof bot?.id === "string" ? bot.id.slice(0, 100) : null;
    try {
      const r = await deps.db.withUser({ userId, workspaceId: ws }, (tx) =>
        tx.query<{ s: unknown }>(`select public.notion_connect($1::uuid, $2, $3, $4) as s`, [ws, token, name, botId]));
      return json({ ok: true, status: r[0]?.s ?? null });
    } catch (e) { return dbFailure(e, deps, "connect"); }
  }

  const token = await readToken(deps.db.service, ws);
  if (!token) return refuse(409, "not_connected", TEXT.notConnected);

  if (action === "test") {
    try {
      const bot = await deps.notion(token, deps.now() + 20_000).me();
      return json({ ok: true, workspaceName: oneLine(typeof bot?.bot?.workspace_name === "string" ? bot.bot.workspace_name : "", 200) || st.workspace_name || null });
    } catch (e) { return isNotionError(e) ? notionFailure(e, "database") : dbFailure(e, deps, "test"); }
  }

  if (action === "databases") {
    const query = str(b.query, 100);
    try {
      const api = deps.notion(token, deps.now() + 25_000);
      const out: ReturnType<typeof summariseDatabase>[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 2; i++) {
        const res = await api.searchDatabases(query, cursor);
        for (const d of res.results ?? []) if (d && typeof d.id === "string" && !d.archived && !d.in_trash) out.push(summariseDatabase(d));
        if (!res.has_more || !res.next_cursor) break;
        cursor = res.next_cursor;
      }
      return json({ ok: true, databases: out });
    } catch (e) { return isNotionError(e) ? notionFailure(e, "database") : dbFailure(e, deps, "databases"); }
  }

  const databaseId = parseNotionId(str(b.databaseId, 2000));
  if (!databaseId) return refuse(400, "invalid", "Choose a Notion database.");

  if (action === "schema") {
    try {
      const db = await deps.notion(token, deps.now() + 20_000).database(databaseId);
      return json({ ok: true, schema: schemaOf(db) });
    } catch (e) { return isNotionError(e) ? notionFailure(e, "database") : dbFailure(e, deps, "schema"); }
  }

  if (action === "preview") {
    try {
      const res = await deps.notion(token, deps.now() + 20_000).query(databaseId, { page_size: 5 });
      return json({ ok: true, rows: (res.results ?? []).filter((p) => p && typeof p.id === "string").slice(0, 5).map(previewRow) });
    } catch (e) { return isNotionError(e) ? notionFailure(e, "database") : dbFailure(e, deps, "preview"); }
  }

  // ---- import ----
  const projectId = b.projectId == null || b.projectId === "" ? null : str(b.projectId, 40);
  if (projectId !== null && !UUID.test(projectId)) return refuse(400, "invalid", "Choose a project to import into.");
  let newProject: { name: string; emoji: string; color: string } | null = null;
  if (!projectId) {
    const np = b.newProject as Record<string, unknown> | null | undefined;
    const name = np && typeof np === "object" ? oneLine(String(np.name ?? ""), 80) : "";
    const emoji = np && typeof np === "object" ? String(np.emoji ?? "").trim() : "";
    const color = np && typeof np === "object" ? String(np.color ?? "").trim() : "";
    if (!name) return refuse(400, "invalid", "Give the new project a name.");
    if (emoji.length > 32 || graphemes(emoji) > 2) return refuse(400, "invalid", "Choose one emoji for the project's icon.");
    if (!COLOUR.test(color) || color.length > 60) return refuse(400, "invalid", "Choose a colour for the project.");
    newProject = { name, emoji, color };
  }
  const direction = b.direction === "from_notion" ? "from_notion" : b.direction === "two_way" || b.direction == null ? "two_way" : null;
  if (!direction) return refuse(400, "invalid", "Choose which way the sync goes.");
  if (b.mapping == null || typeof b.mapping !== "object" || JSON.stringify(b.mapping).length > 16_000) return refuse(400, "invalid", "Choose which Notion fields to bring in.");
  const lim = await hit(deps, `kanbo:notion:import:${ws}`, 600, 10);
  if (!lim.allowed) return refuse(429, "rate_limited", "That's a lot of imports in a short time. Try again in a few minutes.", lim.retryAfter);
  try {
    const result = await importDatabase(deps, deps.notion(token, deps.now() + 50_000), {
      userId, workspaceId: ws, databaseId, mapping: b.mapping, projectId, newProject, keepInSync: b.keepInSync === true, direction,
    }, deps.now() + 50_000);
    return json({ ok: true, result });
  } catch (e) { return dbFailure(e, deps, "import"); }
}

async function syncNow(deps: HandlerDeps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const syncId = str(b.syncId, 40);
  if (!UUID.test(syncId)) return refuse(400, "invalid", "Choose a sync.");
  try {
    // members can read syncs: this also says whether the caller is in its workspace
    const rows = await deps.db.withUser({ userId, readOnly: true }, (tx) =>
      tx.query<{ ws: string; enabled: boolean }>(`select workspace_id::text as ws, enabled from public.notion_syncs where id = $1::uuid`, [syncId]));
    if (!rows[0]) return refuse(404, "not_found", "That sync isn't there any more.");
    const st = await statusAs(deps, userId, rows[0].ws);
    if (!st?.can_manage) return refuse(403, "not_allowed", TEXT.manageOnly);
    if (!st.connected) return refuse(409, "not_connected", TEXT.notConnected);
    if (!rows[0].enabled) return refuse(409, "invalid", "Switch the sync on first.");
    const lim = await hit(deps, `kanbo:notion:sync:${syncId}`, 300, 5);
    if (!lim.allowed) return refuse(429, "rate_limited", "This sync has run a lot just now. Try again in a few minutes.", lim.retryAfter);
    const row = await claimSync(deps.db.service, syncId, 60);
    if (!row) return refuse(409, "rate_limited", "This sync is running or ran a moment ago. Try again in a minute.", 60);
    const r = await runSync(deps, row, { deadline: deps.now() + 45_000 });
    return json({ ok: true, stats: r.stats, error: r.error, fatal: r.fatal });
  } catch (e) { return dbFailure(e, deps, "sync_now"); }
}

async function refreshPage(deps: HandlerDeps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const ws = str(b.workspaceId, 40);
  const pageId = parseNotionId(str(b.pageId, 2000));
  if (!UUID.test(ws) || !pageId) return refuse(400, "invalid", "That isn't a Notion page.");
  try {
    const st = await statusAs(deps, userId, ws);
    if (!st) return refuse(403, "not_allowed", TEXT.notMember);
    // only pages linked in this workspace (members read links and the cache)
    const got = await deps.db.withUser({ userId, workspaceId: ws, readOnly: true }, async (tx) => {
      const linked = await tx.query(`select 1 from public.notion_links where workspace_id = $1::uuid and notion_page_id = $2 limit 1`, [ws, pageId]);
      const cache = await tx.query<Record<string, unknown> & { fresh: boolean }>(
        `select title, icon, url, last_edited_time, archived, fetched_at, fetched_at > now() - make_interval(secs => $3::int) as fresh
           from public.notion_page_cache where workspace_id = $1::uuid and notion_page_id = $2`, [ws, pageId, CACHE_FRESH_MS / 1000]);
      return { linked: linked.length > 0, cache: cache[0] ?? null };
    });
    if (!got.linked) return refuse(404, "not_found", "That page isn't linked in this workspace.");
    const cached = got.cache ? (({ fresh: _f, ...rest }) => rest)(got.cache) : null;
    if (got.cache?.fresh && b.force !== true) return json({ ok: true, page: cached });
    const lim = await hit(deps, `kanbo:notion:page:u:${userId}`, 60, 60);
    const token = st.connected ? await readToken(deps.db.service, ws) : null;
    if (!lim.allowed || !token) return cached ? json({ ok: true, page: cached }) : refuse(st.connected ? 429 : 409, st.connected ? "rate_limited" : "not_connected", st.connected ? TEXT.tooMany : TEXT.notConnected);
    try {
      const meta = await fetchMeta(deps, token, pageId);
      await storeMeta(deps, ws, pageId, meta);
      return json({ ok: true, page: { ...meta, fetched_at: new Date(deps.now()).toISOString() } });
    } catch (e) {
      if (cached) return json({ ok: true, page: cached });
      return isNotionError(e) ? notionFailure(e, "page") : dbFailure(e, deps, "page");
    }
  } catch (e) { return dbFailure(e, deps, "page"); }
}

async function linkPage(deps: HandlerDeps, userId: string, b: Record<string, unknown>): Promise<Response> {
  const taskId = str(b.taskId, 40);
  if (!UUID.test(taskId)) return refuse(400, "invalid", "Choose a task.");
  const url = str(b.url, 2000);
  const pageId = parseNotionId(url);
  if (!pageId) return refuse(400, "invalid", "That isn't a link to a Notion page. Copy it from Notion with Share › Copy link.");
  try {
    const t = await deps.db.withUser({ userId, readOnly: true }, (tx) =>
      tx.query<{ ws: string | null }>(`select workspace_id::text as ws from public.tasks where id = $1::uuid`, [taskId]));
    if (!t[0]) return refuse(404, "not_found", "That task isn't there any more, or you can't change it.");
    const ws = t[0].ws;
    if (!ws) return refuse(400, "invalid", "Notion pages can only be linked to team tasks.");
    const st = await statusAs(deps, userId, ws);
    if (!st) return refuse(404, "not_found", "That task isn't there any more, or you can't change it.");
    if (!st.connected) return refuse(409, "not_connected", TEXT.notConnected);
    if (!st.can_link) return refuse(403, "not_allowed", "Guests can't link Notion pages.");
    const lim = await hit(deps, `kanbo:notion:link:u:${userId}`, 60, 30);
    if (!lim.allowed) return refuse(429, "rate_limited", TEXT.tooMany, lim.retryAfter);
    const token = await readToken(deps.db.service, ws);
    if (!token) return refuse(409, "not_connected", TEXT.notConnected);
    // the integration must be able to see it (or nobody would get its title)
    let meta: PageMeta;
    try { meta = await fetchMeta(deps, token, pageId); } catch (e) {
      return isNotionError(e) ? notionFailure(e, "page") : dbFailure(e, deps, "link_page");
    }
    const r = await deps.db.withUser({ userId, workspaceId: ws }, (tx) =>
      tx.query<{ l: Record<string, unknown> }>(`select public.notion_link_page($1::uuid, $2) as l`, [taskId, pageId]));
    const link = r[0]?.l ?? null;
    if (link) await storeMeta(deps, ws, pageId, meta);
    return json({ ok: true, link: link ? { ...link, page: { ...meta, fetched_at: new Date(deps.now()).toISOString() } } : null });
  } catch (e) { return dbFailure(e, deps, "link_page"); }
}
