/* ============================================================
   KANBO — Notion: connection, import + sync, page links. [0046 contract → a3]
   The integration token is server-only (workspace_integrations.notion_token);
   members see notion_status(). Notion itself is only ever called by the
   "notion" edge function (verify_jwt ON).

   Contract (database 0046):
     rpc notion_status(p_ws) → status JSON | null (not a member)
     rpc notion_connect(p_ws, p_token, p_workspace_name?, p_bot_id?) → status   (owner/admin;
         the notion function calls it as the user after checking the token with Notion)
     rpc notion_disconnect(p_ws) → status   (owner/admin; switches every sync off)
     rpc notion_save_sync(p_ws, p_project, p_database_id, p_database_title, p_mapping,
                          p_direction 'two_way'|'from_notion', p_enabled) → sync JSON (owner/admin)
     rpc notion_set_sync_enabled(p_id, p_enabled) → sync JSON
     rpc notion_delete_sync(p_id) → true   (its tasks keep their page as a plain link)
     rpc notion_link_page(p_task, p_page_id) → link JSON (people who can edit the task)
     rpc notion_unlink_page(p_link) → true (a synced link needs an owner/admin)
     select notion_syncs / notion_links / notion_page_cache (members; realtime for the first two)
     errors: 'not allowed' | 'invalid token' | 'notion not connected' | 'invalid database' |
             'invalid direction' | 'invalid mapping' | 'invalid project' | 'sync not found' |
             'task not found' | 'notion links need a team task' | 'invalid page' |
             'too many links' | 'link not found'

   Edge function "notion" (POST /functions/v1/notion, the user's JWT) — a3
   defines the actions (see api-contracts.md): connect, test, databases,
   schema, preview, import, sync_now, page (fetch + cache a page's title /
   icon), link_page. Cron: { mode: "sync" } with x-cron-secret.

   Demo mode (no Supabase): an in-memory Notion workspace ("Foundrise",
   connected in ws-foundrise) with a 'Content calendar' database to import,
   two syncs (one failing, to show how errors read) and page links on the
   seeded tasks t-1 / t-4. Every failure is a NotionError: `reason` for the
   code and a sentence (British English) to show as `message`.
   ============================================================ */
import type {
  NotionDatabaseSchema, NotionDatabaseSummary, NotionFailure, NotionImportRequest, NotionImportResult, NotionLink,
  NotionPageMeta, NotionPreviewRow, NotionStatus, NotionSync, NotionSyncDirection, NotionSyncStats,
} from "../data/types";
import {
  NOTION_INTEGRATIONS_URL, NOTION_TOKEN_RE, notionPageUrl, parseNotionId, type NotionFieldMapping,
} from "../../supabase/functions/_shared/notion.ts";
import { guessStatus, suggestMapping } from "../../supabase/functions/_shared/notionMap.ts";
import { supabase } from "./supabase";

export { NOTION_INTEGRATIONS_URL, NOTION_TOKEN_RE, notionPageUrl, parseNotionId };

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pickG = (r: Record<string, unknown>) => (snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

/** notion_status() JSON → NotionStatus; null for null / malformed (not a member). */
export function parseNotionStatus(raw: unknown): NotionStatus | null {
  const r = obj(raw);
  if (!r || typeof r.connected !== "boolean") return null;
  const g = pickG(r);
  const n = Number(g("sync_count", "syncCount"));
  return {
    connected: r.connected,
    workspaceName: str(g("workspace_name", "workspaceName")),
    botId: str(g("bot_id", "botId")),
    tokenHint: str(g("token_hint", "tokenHint")),
    connectedAt: str(g("connected_at", "connectedAt")),
    connectedByName: str(g("connected_by_name", "connectedByName")),
    canManage: g("can_manage", "canManage") === true,
    canLink: g("can_link", "canLink") === true,
    syncCount: Number.isFinite(n) ? n : 0,
  };
}

/** A notion_syncs row / sync JSON → NotionSync; null if malformed. */
export function parseNotionSync(raw: unknown): NotionSync | null {
  const r = obj(raw);
  if (!r) return null;
  const g = pickG(r);
  const id = str(r.id), ws = str(g("workspace_id", "workspaceId")), project = str(g("project_id", "projectId")), db = str(g("database_id", "databaseId"));
  const mapping = obj(r.mapping);
  if (!id || !ws || !project || !db || !mapping || typeof mapping.title !== "string") return null;
  const dir = r.direction === "from_notion" ? "from_notion" : "two_way";
  return {
    id,
    workspaceId: ws,
    projectId: project,
    databaseId: db,
    databaseTitle: str(g("database_title", "databaseTitle")),
    mapping: mapping as unknown as NotionFieldMapping,
    direction: dir as NotionSyncDirection,
    enabled: r.enabled === true,
    lastRunAt: str(g("last_run_at", "lastRunAt")),
    lastSuccessAt: str(g("last_success_at", "lastSuccessAt")),
    lastError: str(g("last_error", "lastError")),
    lastErrorAt: str(g("last_error_at", "lastErrorAt")),
    stats: (obj(r.stats) ?? {}) as NotionSyncStats,
    createdBy: str(g("created_by", "createdBy")),
    createdByName: str(g("created_by_name", "createdByName")),
    createdAt: str(g("created_at", "createdAt")) ?? "",
    updatedAt: str(g("updated_at", "updatedAt")) ?? "",
  };
}

/** notion_page_cache row / link.page JSON → NotionPageMeta. */
export function parseNotionPageMeta(raw: unknown): NotionPageMeta | null {
  const r = obj(raw);
  if (!r) return null;
  const g = pickG(r);
  return {
    title: str(r.title),
    icon: str(r.icon),
    url: str(r.url),
    lastEditedTime: str(g("last_edited_time", "lastEditedTime")),
    archived: r.archived === true,
    fetchedAt: str(g("fetched_at", "fetchedAt")),
  };
}

/** A notion_links row / link JSON → NotionLink; null if malformed. */
export function parseNotionLink(raw: unknown): NotionLink | null {
  const r = obj(raw);
  if (!r) return null;
  const g = pickG(r);
  const id = str(r.id), ws = str(g("workspace_id", "workspaceId")), task = str(g("task_id", "taskId"));
  const page = str(g("notion_page_id", "pageId"));
  if (!id || !ws || !task || !page) return null;
  return {
    id,
    workspaceId: ws,
    taskId: task,
    pageId: page,
    databaseId: str(g("notion_database_id", "databaseId")),
    syncId: str(g("sync_id", "syncId")),
    kind: r.kind === "synced" ? "synced" : "reference",
    lastSyncedAt: str(g("last_synced_at", "lastSyncedAt")),
    notionLastEdited: str(g("notion_last_edited", "notionLastEdited")),
    createdBy: str(g("created_by", "createdBy")),
    createdAt: str(g("created_at", "createdAt")) ?? "",
    page: parseNotionPageMeta(r.page),
  };
}

/** A database / function / network error → why (the messages 0046 raises). */
export function notionFailure(e: unknown): NotionFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/not connected/i.test(msg)) return "not_connected";
  if (/not allowed|not authorized/i.test(msg)) return "not_allowed";
  if (/invalid token/i.test(msg)) return "invalid_token";
  if (/rate.?limit/i.test(msg)) return "rate_limited";
  if (/not found/i.test(msg)) return "not_found";
  if (/^invalid|team task|too many links/i.test(msg)) return "invalid";
  return "error";
}

/* ============================================================ the calls (a3) */

/** A refused or failed Notion call: `reason` for the code, `message` is a sentence to show. */
export class NotionError extends Error {
  readonly reason: NotionFailure;
  readonly retryAfter?: number;
  constructor(reason: NotionFailure, message: string, retryAfter?: number) {
    super(message);
    this.name = "NotionError";
    this.reason = reason;
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

export const NOTION_COPY = {
  unavailable: "Notion isn't switched on for Kanbo yet.",
  offline: "You're offline. Try again when you're back online.",
  network: "Couldn't reach Kanbo. Check your connection and try again.",
  invalidToken: "That doesn't look like a Notion integration secret. It starts with ntn_ or secret_.",
  notAllowed: "Only workspace owners and admins can change the Notion connection.",
  notConnected: "Notion isn't connected to this workspace.",
  invalidLink: "That isn't a link to a Notion page. Copy it from Notion with Share › Copy link.",
  teamOnly: "Notion pages can only be linked to team tasks.",
  tooManyLinks: "A task can have up to 20 Notion pages.",
  notFound: "That isn't there any more.",
  rateLimited: "That's a lot of requests in a short time. Try again in a minute.",
  failed: "Something went wrong. Try again.",
} as const;

/** What the wizard first proposes (people confirm it): the same guess the server would make. */
export function suggestNotionMapping(schema: NotionDatabaseSchema): NotionFieldMapping {
  return suggestMapping(schema);
}
export { guessStatus as guessKanboStatus };

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;
const errText = (e: unknown) => String((e as { message?: unknown })?.message ?? e ?? "");
const isNetworkError = (e: unknown) => isOffline() || e instanceof TypeError || /failed to fetch|network|load failed|fetch failed/i.test(errText(e));
/** 0046 isn't run yet (the functions / tables are missing): don't keep asking this session. */
let schemaMissing = false;
const isMissing = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  return code === "42883" || code === "42P01" || code === "PGRST202" || code === "PGRST205" || /could not find the function|does not exist|schema cache/i.test(errText(e));
};

/** A database error → NotionError with a sentence. */
function rpcError(e: unknown): NotionError {
  if (e instanceof NotionError) return e;
  if (isMissing(e)) { schemaMissing = true; return new NotionError("unavailable", NOTION_COPY.unavailable); }
  if (isNetworkError(e)) return new NotionError("network", isOffline() ? NOTION_COPY.offline : NOTION_COPY.network);
  const reason = notionFailure(e);
  const msg = errText(e).toLowerCase();
  switch (reason) {
    case "not_connected": return new NotionError(reason, NOTION_COPY.notConnected);
    case "not_allowed": return new NotionError(reason, NOTION_COPY.notAllowed);
    case "invalid_token": return new NotionError(reason, NOTION_COPY.invalidToken);
    case "not_found": return new NotionError(reason, NOTION_COPY.notFound);
    case "invalid": return new NotionError(reason, msg.includes("team task") ? NOTION_COPY.teamOnly : msg.includes("too many links") ? NOTION_COPY.tooManyLinks : msg.includes("invalid page") ? NOTION_COPY.invalidLink : NOTION_COPY.failed);
    default: return new NotionError("error", NOTION_COPY.failed);
  }
}

const FAILURES: readonly NotionFailure[] = ["not_connected", "not_allowed", "invalid_token", "not_shared", "rate_limited", "notion_error", "invalid", "not_found", "unavailable", "network", "error"];
const isFailure = (v: unknown): v is NotionFailure => typeof v === "string" && (FAILURES as readonly string[]).includes(v);

/** A failed functions.invoke → NotionError (the function's own sentence when it sent one). */
async function invokeError(error: unknown): Promise<NotionError> {
  const name = String((error as { name?: unknown })?.name ?? "");
  if (name === "FunctionsFetchError" || isNetworkError(error)) return new NotionError("network", isOffline() ? NOTION_COPY.offline : NOTION_COPY.network);
  if (name === "FunctionsRelayError") return new NotionError("unavailable", NOTION_COPY.unavailable);
  const ctx = (error as { context?: { status?: number; json?: () => Promise<unknown>; clone?: () => { json: () => Promise<unknown> } } })?.context;
  const status = typeof ctx?.status === "number" ? ctx.status : undefined;
  let body: Record<string, unknown> = {};
  try {
    const raw = await (ctx?.clone ? ctx.clone().json() : ctx?.json?.());
    if (raw && typeof raw === "object") body = raw as Record<string, unknown>;
  } catch { /* not JSON */ }
  const retryAfter = typeof body.retryAfter === "number" && body.retryAfter > 0 ? body.retryAfter : undefined;
  const sentence = typeof body.error === "string" && /^[A-Z].{3,300}[.]$/.test(body.error) ? body.error : null;
  if (isFailure(body.reason)) return new NotionError(body.reason, sentence ?? NOTION_COPY.failed, retryAfter);
  if (status === 404) return new NotionError("unavailable", NOTION_COPY.unavailable);   // the function isn't deployed
  if (status === 401 || status === 403) return new NotionError("not_allowed", NOTION_COPY.notAllowed);
  if (status === 429) return new NotionError("rate_limited", NOTION_COPY.rateLimited, retryAfter);
  return new NotionError("error", NOTION_COPY.failed);
}

async function invoke<T extends Record<string, unknown>>(body: Record<string, unknown>, timeout = 30_000): Promise<T> {
  if (!supabase) throw new NotionError("unavailable", NOTION_COPY.unavailable);
  if (isOffline()) throw new NotionError("network", NOTION_COPY.offline);
  let res: { data: unknown; error: unknown };
  try { res = await supabase.functions.invoke("notion", { body, timeout }); } catch (e) { throw await invokeError(e); }
  if (res.error) throw await invokeError(res.error);
  const d = (res.data ?? {}) as Record<string, unknown>;
  if (d.ok !== true) throw new NotionError("error", NOTION_COPY.failed);
  return d as T;
}

async function rpc(fn: string, args: Record<string, unknown>): Promise<unknown> {
  if (!supabase) throw new NotionError("unavailable", NOTION_COPY.unavailable);
  if (schemaMissing) throw new NotionError("unavailable", NOTION_COPY.unavailable);
  if (isOffline()) throw new NotionError("network", NOTION_COPY.offline);
  let res: { data: unknown; error: unknown };
  try { res = await supabase.rpc(fn, args); } catch (e) { throw rpcError(e); }
  if (res.error) throw rpcError(res.error);
  return res.data;
}

/* ------------------------------------------------------------ demo mode: a workspace with Notion */

let DEMO_DELAY_MS = 420;
const iso = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const DEMO_DBS: NotionDatabaseSummary[] = [
  { id: "c0a7e1d2-5b6f-4a3e-9c1d-000000000001", title: "Content calendar", icon: "🗓️", url: "https://www.notion.so/c0a7e1d25b6f4a3e9c1d000000000001", lastEditedTime: iso(35) },
  { id: "c0a7e1d2-5b6f-4a3e-9c1d-000000000002", title: "Product roadmap", icon: "🧭", url: "https://www.notion.so/c0a7e1d25b6f4a3e9c1d000000000002", lastEditedTime: iso(180) },
  { id: "c0a7e1d2-5b6f-4a3e-9c1d-000000000003", title: "Bug tracker", icon: "🐞", url: "https://www.notion.so/c0a7e1d25b6f4a3e9c1d000000000003", lastEditedTime: iso(60 * 26) },
  { id: "c0a7e1d2-5b6f-4a3e-9c1d-000000000004", title: "Hiring pipeline", icon: "👥", url: "https://www.notion.so/c0a7e1d25b6f4a3e9c1d000000000004", lastEditedTime: iso(60 * 72) },
  { id: "c0a7e1d2-5b6f-4a3e-9c1d-000000000005", title: "Meeting notes", icon: "📝", url: "https://www.notion.so/c0a7e1d25b6f4a3e9c1d000000000005", lastEditedTime: iso(60 * 24 * 9) },
];
const [CONTENT, ROADMAP, BUGS] = DEMO_DBS;
const CONTENT_SCHEMA: NotionDatabaseSchema = {
  id: CONTENT.id, title: CONTENT.title,
  properties: [
    { id: "title", name: "Name", type: "title" },
    { id: "chan", name: "Channels", type: "multi_select", options: ["Blog", "LinkedIn", "Newsletter", "Instagram"] },
    { id: "own", name: "Owner", type: "people" },
    { id: "pub", name: "Publish date", type: "date" },
    Object.assign({ id: "st", name: "Status", type: "status" as const, options: ["Idea", "Drafting", "Scheduled", "Published"] },
      { groups: { Idea: "To-do", Drafting: "In progress", Scheduled: "In progress", Published: "Complete" } }),
    { id: "sum", name: "Summary", type: "rich_text" },
    { id: "wc", name: "Word count", type: "number" },
  ],
};
const simpleSchema = (db: NotionDatabaseSummary, extra: NotionDatabaseSchema["properties"]): NotionDatabaseSchema =>
  ({ id: db.id, title: db.title, properties: [{ id: "title", name: "Name", type: "title" }, ...extra] });
const DEMO_SCHEMAS: Record<string, NotionDatabaseSchema> = {
  [CONTENT.id]: CONTENT_SCHEMA,
  [ROADMAP.id]: simpleSchema(ROADMAP, [{ id: "q", name: "Quarter", type: "select", options: ["Q3", "Q4", "Later"] }, { id: "s", name: "Stage", type: "status", options: ["Not started", "In progress", "Shipped"] }, { id: "l", name: "Lead", type: "people" }, { id: "t", name: "Target date", type: "date" }]),
  [BUGS.id]: simpleSchema(BUGS, [{ id: "s", name: "State", type: "select", options: ["New", "Fixing", "In review", "Fixed", "Won't fix"] }, { id: "a", name: "Assignee", type: "people" }, { id: "sev", name: "Severity", type: "select", options: ["P1", "P2", "P3"] }, { id: "d", name: "Details", type: "rich_text" }]),
  [DEMO_DBS[3].id]: simpleSchema(DEMO_DBS[3], [{ id: "s", name: "Stage", type: "status", options: ["Applied", "Interviewing", "Offer", "Hired"] }, { id: "r", name: "Role", type: "select", options: ["Engineering", "Design"] }, { id: "o", name: "Hiring manager", type: "people" }]),
  [DEMO_DBS[4].id]: simpleSchema(DEMO_DBS[4], [{ id: "d", name: "Date", type: "date" }, { id: "a", name: "Attendees", type: "people" }, { id: "t", name: "Type", type: "multi_select", options: ["1:1", "Planning", "Retro"] }]),
};
const row = (pageId: string, values: Record<string, string | string[] | null>): NotionPreviewRow => ({ pageId, values });
const CONTENT_ROWS: NotionPreviewRow[] = [
  row("p1", { Name: "Launch week recap", Status: "Published", "Publish date": "2026-09-29", Owner: ["Maya Lin"], Channels: ["Blog", "LinkedIn"], Summary: "What shipped, who it's for and what's next.", "Word count": "1200" }),
  row("p2", { Name: "Autumn newsletter", Status: "Drafting", "Publish date": "2026-10-08 → 2026-10-10", Owner: ["Sana Rao"], Channels: ["Newsletter"], Summary: "Highlights from the quarter and two customer stories.", "Word count": "900" }),
  row("p3", { Name: "Customer story: Reco HQ", Status: "Idea", "Publish date": null, Owner: ["Theo Vance"], Channels: ["Blog"], Summary: null, "Word count": null }),
  row("p4", { Name: "Behind the design system", Status: "Scheduled", "Publish date": "2026-10-14", Owner: ["Sana Rao"], Channels: ["Blog", "Instagram"], Summary: "How the Paper & Navy palette came together.", "Word count": "1500" }),
  row("p5", { Name: "Hiring: senior engineer", Status: "Drafting", "Publish date": "2026-10-20", Owner: ["Daniel Okai"], Channels: ["LinkedIn"], Summary: "The role, the team and how we work.", "Word count": "600" }),
];
const DEMO_COUNTS: Record<string, number> = { [CONTENT.id]: 14, [ROADMAP.id]: 23, [BUGS.id]: 41, [DEMO_DBS[3].id]: 9, [DEMO_DBS[4].id]: 37 };

interface DemoSpace { status: NotionStatus; syncs: NotionSync[] }
const demo = new Map<string, DemoSpace>();
let demoSeq = 0;
function demoSpace(ws: string): DemoSpace {
  let s = demo.get(ws);
  if (s) return s;
  const connected = ws === "ws-foundrise";
  s = {
    status: {
      connected, workspaceName: connected ? "Foundrise" : null, botId: connected ? "demo-bot" : null, tokenHint: connected ? "…f3Qa" : null,
      connectedAt: connected ? iso(60 * 24 * 12) : null, connectedByName: connected ? "Daniel Okai" : null, canManage: true, canLink: true, syncCount: 0,
    },
    syncs: [],
  };
  if (connected) {
    const base = { workspaceId: ws, createdBy: "m-self", createdByName: "Daniel Okai", createdAt: iso(60 * 24 * 12), updatedAt: iso(60 * 24 * 12), lastCursor: null };
    s.syncs.push({
      ...base, id: "demo-sync-roadmap", projectId: "p-launch", databaseId: ROADMAP.id, databaseTitle: ROADMAP.title,
      mapping: { title: "Name", status: { property: "Stage", values: { "Not started": "todo", "In progress": "progress", Shipped: "done" } }, assignee: { property: "Lead" }, due: { property: "Target date" } },
      direction: "two_way", enabled: true, lastRunAt: iso(6), lastSuccessAt: iso(6), lastError: null, lastErrorAt: null,
      stats: { created: 0, updated: 2, pushed: 1, skipped: 0, at: iso(6) },
    });
    s.syncs.push({
      ...base, id: "demo-sync-bugs", projectId: "p-infra", databaseId: BUGS.id, databaseTitle: BUGS.title,
      mapping: { title: "Name", status: { property: "State", values: { New: "todo", Fixing: "progress", "In review": "review", Fixed: "done" } }, assignee: { property: "Assignee" } },
      direction: "from_notion", enabled: true, lastRunAt: iso(4), lastSuccessAt: iso(60 * 26), lastErrorAt: iso(4),
      lastError: "Kanbo can't see this Notion database any more. In Notion, open it and add your Kanbo integration under ••• › Connections.",
      stats: { created: 0, updated: 0, pushed: 0, skipped: 0, at: iso(4) },
    });
    s.status.syncCount = s.syncs.length;
  }
  demo.set(ws, s);
  return s;
}
const demoFind = (syncId: string): { space: DemoSpace; sync: NotionSync } | null => {
  for (const space of demo.values()) { const sync = space.syncs.find((x) => x.id === syncId); if (sync) return { space, sync }; }
  return null;
};

/* demo page links: a couple on the seeded tasks, more as people paste links */
const demoLinks = new Map<string, NotionLink[]>();
const demoPage = (title: string, icon: string, id: string, editedMinutesAgo: number): NotionPageMeta =>
  ({ title, icon, url: notionPageUrl(id), lastEditedTime: iso(editedMinutesAgo), archived: false, fetchedAt: iso(1) });
function demoTaskLinks(taskId: string, ws: string): NotionLink[] {
  let list = demoLinks.get(taskId);
  if (list) return list;
  list = [];
  const link = (pageId: string, page: NotionPageMeta, kind: "synced" | "reference" = "reference", databaseId: string | null = null): NotionLink => ({
    id: `demo-link-${++demoSeq}`, workspaceId: ws, taskId, pageId, databaseId, syncId: kind === "synced" ? "demo-sync-roadmap" : null, kind,
    lastSyncedAt: kind === "synced" ? iso(6) : null, notionLastEdited: page.lastEditedTime, createdBy: "m-self", createdAt: iso(60 * 30), page,
  });
  if (taskId === "t-1") {
    list.push(link("7a1b2c3d-0000-4000-8000-000000000001", demoPage("Q3 launch: narrative notes", "📝", "7a1b2c3d-0000-4000-8000-000000000001", 120)));
    list.push(link("7a1b2c3d-0000-4000-8000-000000000002", demoPage("Launch plan", "🧭", "7a1b2c3d-0000-4000-8000-000000000002", 60 * 30), "synced", ROADMAP.id));
  } else if (taskId === "t-4") {
    list.push(link("7a1b2c3d-0000-4000-8000-000000000003", demoPage("Design tokens v2 spec", "🎨", "7a1b2c3d-0000-4000-8000-000000000003", 60 * 5)));
  }
  demoLinks.set(taskId, list);
  return list;
}
/** "…/acme/Launch-brief-89ab…" → "Launch brief". */
function titleFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop() ?? "";
    const words = decodeURIComponent(last).replace(/-?[0-9a-f]{32}$/i, "").replace(/-/g, " ").trim();
    return words || "Untitled page";
  } catch { return "Untitled page"; }
}

/* change listeners (realtime in Supabase mode; the demo calls them itself) */
const linkListeners = new Map<string, Set<() => void>>();
const syncListeners = new Map<string, Set<() => void>>();
const tell = (m: Map<string, Set<() => void>>, key: string) => m.get(key)?.forEach((fn) => { try { fn(); } catch { /* a listener's problem */ } });
function listen(m: Map<string, Set<() => void>>, key: string, fn: () => void): () => void {
  let set = m.get(key);
  if (!set) { set = new Set(); m.set(key, set); }
  set.add(fn);
  return () => { set!.delete(fn); if (!set!.size) m.delete(key); };
}
let channelSeq = 0;

/* ------------------------------------------------------------ connection */

/** The workspace's Notion status (null: Personal, or not a member). Throws NotionError when it can't be read. */
export async function loadNotionStatus(workspaceId: string | null): Promise<NotionStatus | null> {
  if (!workspaceId) return null;
  if (!supabase) return { ...demoSpace(workspaceId).status };
  return parseNotionStatus(await rpc("notion_status", { p_ws: workspaceId }));
}

/** Checks the token with Notion (edge function), then stores it (owner/admin). */
export async function connectNotion(workspaceId: string, token: string): Promise<NotionStatus> {
  const t = String(token ?? "").trim();
  if (!NOTION_TOKEN_RE.test(t)) throw new NotionError("invalid_token", NOTION_COPY.invalidToken);
  if (!supabase) {
    await wait(DEMO_DELAY_MS * 2);
    const s = demoSpace(workspaceId);
    s.status = { ...s.status, connected: true, workspaceName: "Foundrise", botId: "demo-bot", tokenHint: "…" + t.slice(-4), connectedAt: new Date().toISOString(), connectedByName: "Daniel Okai" };
    tell(syncListeners, workspaceId);
    return { ...s.status };
  }
  const d = await invoke<{ status: unknown }>({ action: "connect", workspaceId, token: t }, 30_000);
  const status = parseNotionStatus(d.status);
  if (!status) throw new NotionError("error", NOTION_COPY.failed);
  return status;
}

export async function disconnectNotion(workspaceId: string): Promise<NotionStatus> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s = demoSpace(workspaceId);
    s.status = { ...s.status, connected: false, workspaceName: null, botId: null, tokenHint: null, connectedAt: null, connectedByName: null };
    s.syncs = s.syncs.map((x) => ({ ...x, enabled: false }));
    tell(syncListeners, workspaceId);
    return { ...s.status };
  }
  const status = parseNotionStatus(await rpc("notion_disconnect", { p_ws: workspaceId }));
  if (!status) throw new NotionError("error", NOTION_COPY.failed);
  return status;
}

/** Re-checks the stored token with Notion. Never throws. */
export async function testNotion(workspaceId: string): Promise<{ ok: true; workspaceName: string | null } | { ok: false; reason: NotionFailure; message: string }> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s = demoSpace(workspaceId);
    return s.status.connected ? { ok: true, workspaceName: s.status.workspaceName } : { ok: false, reason: "not_connected", message: NOTION_COPY.notConnected };
  }
  try {
    const d = await invoke<{ workspaceName?: unknown }>({ action: "test", workspaceId }, 25_000);
    return { ok: true, workspaceName: str(d.workspaceName) };
  } catch (e) {
    const n = e instanceof NotionError ? e : new NotionError("error", NOTION_COPY.failed);
    return { ok: false, reason: n.reason, message: n.message };
  }
}

/* ------------------------------------------------------------ the Import wizard */

export async function listNotionDatabases(workspaceId: string, query?: string): Promise<NotionDatabaseSummary[]> {
  const q = String(query ?? "").trim().slice(0, 100);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (!demoSpace(workspaceId).status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    return DEMO_DBS.filter((d) => d.title.toLowerCase().includes(q.toLowerCase())).map((d) => ({ ...d }));
  }
  const d = await invoke<{ databases?: unknown }>({ action: "databases", workspaceId, ...(q ? { query: q } : {}) });
  return (Array.isArray(d.databases) ? d.databases : []).map((x) => obj(x)).filter((x): x is Record<string, unknown> => !!x && !!str(x.id))
    .map((x) => ({ id: String(x.id), title: str(x.title) ?? "Untitled database", icon: str(x.icon), url: str(x.url), lastEditedTime: str(x.lastEditedTime) }));
}

export async function getNotionDatabaseSchema(workspaceId: string, databaseId: string): Promise<NotionDatabaseSchema> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const s = DEMO_SCHEMAS[databaseId];
    if (!s) throw new NotionError("not_shared", "Kanbo can't see that database. In Notion, open it and add your Kanbo integration under ••• › Connections.");
    return structuredClone(s);
  }
  const d = await invoke<{ schema?: unknown }>({ action: "schema", workspaceId, databaseId });
  const s = obj(d.schema);
  if (!s || !Array.isArray(s.properties)) throw new NotionError("error", NOTION_COPY.failed);
  return s as unknown as NotionDatabaseSchema;
}

/** The first five pages, as display text, for the mapping step. */
export async function previewNotionDatabase(workspaceId: string, databaseId: string): Promise<NotionPreviewRow[]> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (databaseId === CONTENT.id) return structuredClone(CONTENT_ROWS);
    const s = DEMO_SCHEMAS[databaseId];
    return Array.from({ length: 5 }, (_, i) => row(`d${i}`, Object.fromEntries((s?.properties ?? []).map((p) => [p.name,
      p.type === "title" ? `${s!.title.replace(/s$/, "")} ${i + 1}` : p.options?.length ? p.options[i % p.options.length] : null]))));
  }
  const d = await invoke<{ rows?: unknown }>({ action: "preview", workspaceId, databaseId });
  return (Array.isArray(d.rows) ? d.rows : []).map((x) => obj(x)).filter((x): x is Record<string, unknown> => !!x && !!str(x.pageId) && !!obj(x.values))
    .map((x) => ({ pageId: String(x.pageId), values: x.values as NotionPreviewRow["values"] }));
}

/** The import's answer; `partial` when a big database will finish on later runs (or another import). */
export interface NotionImportSummary extends NotionImportResult { partial?: boolean }

export async function importNotionDatabase(req: NotionImportRequest): Promise<NotionImportSummary> {
  if (!req.projectId && !req.newProject?.name?.trim()) throw new NotionError("invalid", "Choose a project to import into.");
  if (!supabase) {
    await wait(DEMO_DELAY_MS * 3);
    const space = demoSpace(req.workspaceId);
    if (!space.status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    if (req.keepInSync && space.syncs.some((x) => x.databaseId === req.databaseId)) {
      throw new NotionError("invalid", "This database already syncs with a project here. Use Sync now on it, or remove that sync first.");
    }
    const projectId = req.projectId ?? `p-notion-${++demoSeq}`;
    const db = DEMO_DBS.find((x) => x.id === req.databaseId);
    const created = DEMO_COUNTS[req.databaseId] ?? 12;
    let syncId: string | null = null;
    if (req.keepInSync) {
      syncId = `demo-sync-${++demoSeq}`;
      const now = new Date().toISOString();
      space.syncs.push({
        id: syncId, workspaceId: req.workspaceId, projectId, databaseId: req.databaseId, databaseTitle: db?.title ?? "Notion database",
        mapping: req.mapping, direction: req.direction, enabled: true, lastRunAt: now, lastSuccessAt: now, lastError: null, lastErrorAt: null,
        stats: { created, updated: 0, pushed: 0, skipped: 0, at: now }, createdBy: "m-self", createdByName: "Daniel Okai", createdAt: now, updatedAt: now,
      });
      space.status = { ...space.status, syncCount: space.syncs.length };
      tell(syncListeners, req.workspaceId);
    }
    return { projectId, syncId, created, skipped: 0, errors: [], partial: false };
  }
  const d = await invoke<{ result?: unknown }>({
    action: "import", workspaceId: req.workspaceId, databaseId: req.databaseId, mapping: req.mapping, projectId: req.projectId,
    newProject: req.projectId ? null : req.newProject ?? null, keepInSync: req.keepInSync, direction: req.direction,
  }, 90_000);
  const r = obj(d.result);
  if (!r || !str(r.projectId)) throw new NotionError("error", NOTION_COPY.failed);
  return {
    projectId: String(r.projectId), syncId: str(r.syncId), created: Number(r.created) || 0, skipped: Number(r.skipped) || 0,
    errors: Array.isArray(r.errors) ? r.errors.filter((x): x is string => typeof x === "string").slice(0, 20) : [], partial: r.partial === true,
  };
}

/* ------------------------------------------------------------ syncs */

export async function listNotionSyncs(workspaceId: string): Promise<NotionSync[]> {
  if (!supabase) return demoSpace(workspaceId).syncs.map((x) => ({ ...x, stats: { ...x.stats } }));
  if (schemaMissing) throw new NotionError("unavailable", NOTION_COPY.unavailable);
  const [syncs, people] = await Promise.all([
    supabase.from("notion_syncs").select("*").eq("workspace_id", workspaceId).order("created_at", { ascending: true }),
    supabase.from("workspace_members").select("user_id,name").eq("workspace_id", workspaceId),
  ]);
  if (syncs.error) throw rpcError(syncs.error);
  const names = new Map<string, string>();
  for (const m of (people.data as { user_id: string | null; name: string | null }[] | null) ?? []) if (m.user_id && m.name) names.set(m.user_id, m.name);
  return ((syncs.data as Record<string, unknown>[] | null) ?? [])
    .map((r) => parseNotionSync({ ...r, created_by_name: r.created_by_name ?? (typeof r.created_by === "string" ? names.get(r.created_by) ?? null : null) }))
    .filter((x): x is NotionSync => !!x);
}

export async function setNotionSyncEnabled(syncId: string, enabled: boolean): Promise<NotionSync> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    const f = demoFind(syncId);
    if (!f) throw new NotionError("not_found", NOTION_COPY.notFound);
    if (enabled && !f.space.status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    f.sync.enabled = enabled;
    f.sync.updatedAt = new Date().toISOString();
    tell(syncListeners, f.sync.workspaceId);
    return { ...f.sync };
  }
  const s = parseNotionSync(await rpc("notion_set_sync_enabled", { p_id: syncId, p_enabled: enabled }));
  if (!s) throw new NotionError("error", NOTION_COPY.failed);
  return s;
}

/** Owner/admin: save a sync again as yourself (it then acts as you), e.g. when
 *  the person who set it up has left. Keeps its database, project, mapping and direction. */
export async function takeOverNotionSync(sync: NotionSync): Promise<NotionSync> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    const f = demoFind(sync.id);
    if (!f) throw new NotionError("not_found", NOTION_COPY.notFound);
    if (!f.space.status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    Object.assign(f.sync, { createdBy: "m-self", createdByName: "Daniel Okai", lastError: null, lastErrorAt: null, enabled: true, updatedAt: new Date().toISOString() });
    tell(syncListeners, f.sync.workspaceId);
    return { ...f.sync };
  }
  const s = parseNotionSync(await rpc("notion_save_sync", {
    p_ws: sync.workspaceId, p_project: sync.projectId, p_database_id: sync.databaseId, p_database_title: sync.databaseTitle,
    p_mapping: sync.mapping, p_direction: sync.direction, p_enabled: true,
  }));
  if (!s) throw new NotionError("error", NOTION_COPY.failed);
  return s;
}

export async function deleteNotionSync(syncId: string): Promise<void> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    const f = demoFind(syncId);
    if (!f) return;
    f.space.syncs = f.space.syncs.filter((x) => x.id !== syncId);
    f.space.status = { ...f.space.status, syncCount: f.space.syncs.length };
    tell(syncListeners, f.sync.workspaceId);
    return;
  }
  await rpc("notion_delete_sync", { p_id: syncId });
}

/** Run one sync now (owner/admin), instead of waiting for the 10-minute schedule.
 *  Throws NotionError when the run couldn't go ahead or stopped (the sync keeps the reason too). */
export async function runNotionSyncNow(syncId: string): Promise<NotionSyncStats> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS * 3);
    const f = demoFind(syncId);
    if (!f) throw new NotionError("not_found", NOTION_COPY.notFound);
    if (!f.space.status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    const now = new Date().toISOString();
    f.sync.lastRunAt = now;
    if (f.sync.lastError) {
      f.sync.lastErrorAt = now;
      f.sync.stats = { created: 0, updated: 0, pushed: 0, skipped: 0, at: now };
      tell(syncListeners, f.sync.workspaceId);
      throw new NotionError("not_shared", f.sync.lastError);
    }
    f.sync.lastSuccessAt = now;
    f.sync.stats = { created: 0, updated: 1, pushed: f.sync.direction === "two_way" ? 1 : 0, skipped: 0, at: now };
    tell(syncListeners, f.sync.workspaceId);
    return { ...f.sync.stats };
  }
  const d = await invoke<{ stats?: unknown; error?: unknown; fatal?: unknown }>({ action: "sync_now", syncId }, 70_000);
  if (d.fatal === true) throw new NotionError("notion_error", str(d.error) ?? NOTION_COPY.failed);
  return (obj(d.stats) ?? {}) as NotionSyncStats;
}

/** Told when a workspace's syncs change (realtime; the demo tells it itself). */
export function subscribeNotionSyncs(workspaceId: string, onChange: () => void): () => void {
  const off = listen(syncListeners, workspaceId, onChange);
  if (!supabase || schemaMissing) return off;
  const client = supabase;
  const ch = client.channel(`notion-syncs-${workspaceId}-${++channelSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "notion_syncs", filter: `workspace_id=eq.${workspaceId}` }, () => onChange())
    .subscribe();
  return () => { off(); void client.removeChannel(ch); };
}

/* ------------------------------------------------------------ page links */

export async function listTaskNotionLinks(taskId: string, workspaceId?: string | null): Promise<NotionLink[]> {
  if (!supabase) return workspaceId ? demoTaskLinks(taskId, workspaceId).map((l) => ({ ...l })) : [];
  if (schemaMissing) return [];
  const { data, error } = await supabase.from("notion_links").select("*").eq("task_id", taskId).order("created_at", { ascending: true });
  if (error) { if (isMissing(error)) { schemaMissing = true; return []; } throw rpcError(error); }
  const rows = (data as Record<string, unknown>[] | null) ?? [];
  if (!rows.length) return [];
  const ws = String(rows[0].workspace_id);
  const ids = rows.map((r) => String(r.notion_page_id));
  const cache = await supabase.from("notion_page_cache").select("*").eq("workspace_id", ws).in("notion_page_id", ids);
  const pages = new Map<string, unknown>();
  for (const c of (cache.data as Record<string, unknown>[] | null) ?? []) pages.set(String(c.notion_page_id), c);
  return rows.map((r) => parseNotionLink({ ...r, page: pages.get(String(r.notion_page_id)) ?? null })).filter((x): x is NotionLink => !!x);
}

/** Link a pasted Notion page URL to a team task; the function fetches its title and icon. */
export async function linkNotionPage(taskId: string, urlOrId: string, workspaceId?: string | null): Promise<NotionLink> {
  const pageId = parseNotionId(String(urlOrId ?? ""));
  if (!pageId) throw new NotionError("invalid", NOTION_COPY.invalidLink);
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    if (!workspaceId) throw new NotionError("invalid", NOTION_COPY.teamOnly);
    if (!demoSpace(workspaceId).status.connected) throw new NotionError("not_connected", NOTION_COPY.notConnected);
    const list = demoTaskLinks(taskId, workspaceId);
    const had = list.find((l) => l.pageId === pageId);
    if (had) return { ...had };
    if (list.length >= 20) throw new NotionError("invalid", NOTION_COPY.tooManyLinks);
    const isUrl = /^https?:/i.test(urlOrId.trim());
    const link: NotionLink = {
      id: `demo-link-${++demoSeq}`, workspaceId, taskId, pageId, databaseId: null, syncId: null, kind: "reference", lastSyncedAt: null, notionLastEdited: null,
      createdBy: "m-self", createdAt: new Date().toISOString(),
      page: { title: isUrl ? titleFromUrl(urlOrId.trim()) : "Untitled page", icon: "📄", url: notionPageUrl(pageId), lastEditedTime: iso(60 * 3), archived: false, fetchedAt: new Date().toISOString() },
    };
    list.push(link);
    tell(linkListeners, taskId);
    return { ...link };
  }
  const d = await invoke<{ link?: unknown }>({ action: "link_page", taskId, url: String(urlOrId).trim() }, 25_000);
  const link = parseNotionLink(d.link);
  if (!link) throw new NotionError("error", NOTION_COPY.failed);
  return link;
}

export async function unlinkNotionPage(linkId: string): Promise<void> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    for (const [taskId, list] of demoLinks) {
      const i = list.findIndex((l) => l.id === linkId);
      if (i >= 0) { list.splice(i, 1); tell(linkListeners, taskId); return; }
    }
    return;
  }
  await rpc("notion_unlink_page", { p_link: linkId });
}

/** A linked page's title / icon fresh from Notion (cached on the server for an hour; `force` skips that). */
export async function refreshNotionPage(workspaceId: string, pageId: string, force = false): Promise<NotionPageMeta | null> {
  if (!supabase) return null;
  const d = await invoke<{ page?: unknown }>({ action: "page", workspaceId, pageId, ...(force ? { force: true } : {}) }, 25_000);
  return parseNotionPageMeta(d.page);
}

/** Told when a task's links change (realtime; the demo tells it itself). */
export function subscribeTaskNotionLinks(taskId: string, onChange: () => void): () => void {
  const off = listen(linkListeners, taskId, onChange);
  if (!supabase || schemaMissing) return off;
  const client = supabase;
  const ch = client.channel(`notion-links-${taskId}-${++channelSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "notion_links", filter: `task_id=eq.${taskId}` }, () => onChange())
    .subscribe();
  return () => { off(); void client.removeChannel(ch); };
}

/** Tests: forget the demo state (and, optionally, make the demo answer at once). */
export function resetNotionDemo(opts: { demoDelayMs?: number } = {}) {
  demo.clear(); demoLinks.clear(); demoSeq = 0; schemaMissing = false;
  if (opts.demoDelayMs !== undefined) DEMO_DELAY_MS = opts.demoDelayMs;
}
