/* ============================================================
   KANBO — search_all rows → SearchHit; snippets → text runs; errors.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { Priority, Role, SearchFailure, SearchHit, SearchHitKind, Status } from "../data/types";
import { bool, errText, isMissing, isNetwork, isObj, num, str, strOr } from "./rowUtils";
import { HIT_KINDS, STATUSES } from "./searchFilters";

export { parseSearchFilters, searchFiltersToRpc } from "./searchFilters";
/** search_all lim is per kind, 1–50 */
export const SEARCH_LIMIT_MAX = 50;
export const SEARCH_QUERY_MAX = 200;
const PRIORITIES: readonly Priority[] = ["low", "medium", "high", "urgent"];

/** search_all's snippet markers: a match is U+E000 … U+E001 */
export const SEARCH_MARK_START = String.fromCharCode(0xe000);
export const SEARCH_MARK_END = String.fromCharCode(0xe001);
const MEMBER_ROLES: readonly Role[] = ["owner", "admin", "member", "guest"];

/** One search_all row → SearchHit (source "server"), or null. */
export function parseSearchHit(raw: unknown): SearchHit | null {
  if (!isObj(raw)) return null;
  const kind = (HIT_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as SearchHitKind) : null;
  const id = str(raw.id);
  if (!kind || !id) return null;
  const meta = isObj(raw.meta) ? raw.meta : {};
  const hit: SearchHit = {
    kind, id,
    title: strOr(raw.title, ""),
    snippet: str(raw.snippet),
    rank: num(raw.rank) ?? 0,
    taskId: str(raw.task_id),
    projectId: str(raw.project_id),
    workspaceId: str(raw.workspace_id),
    updatedAt: str(raw.updated_at),
    source: "server",
  };
  const status = (s: unknown): Status | null => ((STATUSES as readonly unknown[]).includes(s) ? (s as Status) : null);
  if (kind === "task") {
    hit.task = {
      status: status(meta.status) ?? "todo",
      priority: (PRIORITIES as readonly unknown[]).includes(meta.priority) ? (meta.priority as Priority) : "medium",
      dueDate: str(meta.due_date), assigneeId: str(meta.assignee_id), parentId: str(meta.parent_id), archived: bool(meta.archived),
    };
  } else if (kind === "comment") {
    hit.comment = { authorId: str(meta.author_id), authorName: strOr(meta.author_name, ""), taskStatus: status(meta.task_status) };
  } else if (kind === "doc") {
    hit.doc = { icon: str(meta.icon), projectName: str(meta.project_name), updatedBy: str(meta.updated_by), archived: bool(meta.archived) };
  } else if (kind === "project") {
    hit.project = { emoji: str(meta.emoji), color: str(meta.color), status: str(meta.status), ownerId: str(meta.owner_id), archived: bool(meta.archived) };
  } else {
    hit.person = {
      email: strOr(meta.email, hit.snippet ?? ""),
      role: (MEMBER_ROLES as readonly unknown[]).includes(meta.role) ? (meta.role as Role) : null,
      title: str(meta.title), avatarUrl: str(meta.avatar_url),
    };
  }
  return hit;
}

/** A snippet → text runs, hit = a match (render runs as text: <mark> for hits; never as HTML).
 *  The markers themselves never show; a stray end marker is ignored. */
export function splitHighlights(snippet: string | null | undefined): { text: string; hit: boolean }[] {
  if (!snippet) return [];
  const out: { text: string; hit: boolean }[] = [];
  let hit = false, buf = "";
  const push = () => { if (buf) { const last = out[out.length - 1]; if (last && last.hit === hit) last.text += buf; else out.push({ text: buf, hit }); } buf = ""; };
  for (const ch of snippet) {
    if (ch === SEARCH_MARK_START) { if (!hit) { push(); hit = true; } continue; }
    if (ch === SEARCH_MARK_END) { if (hit) { push(); hit = false; } continue; }
    buf += ch;
  }
  push();
  return out;
}

export function searchFailure(e: unknown): SearchFailure {
  const m = errText(e);
  if (isMissing(m)) return "unavailable";
  if (/not authorized|permission denied/i.test(m)) return "not_allowed";
  if (/invalid filters/i.test(m)) return "invalid";
  if (isNetwork(m)) return "network";
  return "error";
}
