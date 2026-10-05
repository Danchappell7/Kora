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

   Package a3 implements the async functions (real + demo fakes with a
   'Content calendar' database) and the panel / chip; parsers are final.
   ============================================================ */
import type {
  NotionDatabaseSchema, NotionDatabaseSummary, NotionFailure, NotionImportRequest, NotionImportResult, NotionLink,
  NotionPageMeta, NotionPreviewRow, NotionStatus, NotionSync, NotionSyncDirection, NotionSyncStats,
} from "../data/types";
import {
  NOTION_INTEGRATIONS_URL, NOTION_TOKEN_RE, notionPageUrl, parseNotionId, type NotionFieldMapping,
} from "../../supabase/functions/_shared/notion.ts";

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

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package a3)`));

export function loadNotionStatus(_workspaceId: string | null): Promise<NotionStatus | null> { return notBuilt("loadNotionStatus"); }
/** Checks the token with Notion (edge function), then stores it (owner/admin). */
export function connectNotion(_workspaceId: string, _token: string): Promise<NotionStatus> { return notBuilt("connectNotion"); }
export function disconnectNotion(_workspaceId: string): Promise<NotionStatus> { return notBuilt("disconnectNotion"); }
/** Re-checks the stored token with Notion. */
export function testNotion(_workspaceId: string): Promise<{ ok: true; workspaceName: string | null } | { ok: false; reason: NotionFailure; message: string }> { return notBuilt("testNotion"); }
export function listNotionDatabases(_workspaceId: string, _query?: string): Promise<NotionDatabaseSummary[]> { return notBuilt("listNotionDatabases"); }
export function getNotionDatabaseSchema(_workspaceId: string, _databaseId: string): Promise<NotionDatabaseSchema> { return notBuilt("getNotionDatabaseSchema"); }
/** The first five pages, as display text, for the mapping step. */
export function previewNotionDatabase(_workspaceId: string, _databaseId: string): Promise<NotionPreviewRow[]> { return notBuilt("previewNotionDatabase"); }
export function importNotionDatabase(_req: NotionImportRequest): Promise<NotionImportResult> { return notBuilt("importNotionDatabase"); }
export function listNotionSyncs(_workspaceId: string): Promise<NotionSync[]> { return notBuilt("listNotionSyncs"); }
export function setNotionSyncEnabled(_syncId: string, _enabled: boolean): Promise<NotionSync> { return notBuilt("setNotionSyncEnabled"); }
export function deleteNotionSync(_syncId: string): Promise<void> { return notBuilt("deleteNotionSync"); }
/** Run one sync now (owner/admin), instead of waiting for the 10-minute schedule. */
export function runNotionSyncNow(_syncId: string): Promise<NotionSyncStats> { return notBuilt("runNotionSyncNow"); }
export function listTaskNotionLinks(_taskId: string): Promise<NotionLink[]> { return notBuilt("listTaskNotionLinks"); }
/** Link a pasted Notion page URL to a team task; the function fetches its title and icon. */
export function linkNotionPage(_taskId: string, _urlOrId: string): Promise<NotionLink> { return notBuilt("linkNotionPage"); }
export function unlinkNotionPage(_linkId: string): Promise<void> { return notBuilt("unlinkNotionPage"); }
