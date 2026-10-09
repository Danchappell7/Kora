/* ============================================================
   KANBO — search_all filters: the app's camelCase ⇄ the RPC's snake_case.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { SearchFilters, SearchHitKind, Status } from "../data/types";
import { bool, isObj, str } from "./rowUtils";

export const HIT_KINDS: readonly SearchHitKind[] = ["task", "comment", "doc", "project", "person"];
export const STATUSES: readonly Status[] = ["todo", "progress", "review", "blocked", "done"];

/** stored / camelCase filters → SearchFilters (unknown fields dropped) */
export function parseSearchFilters(raw: unknown): SearchFilters {
  const f: SearchFilters = {};
  if (!isObj(raw)) return f;
  if (Array.isArray(raw.kinds)) f.kinds = raw.kinds.filter((k): k is SearchHitKind => (HIT_KINDS as readonly unknown[]).includes(k));
  if ("workspaceId" in raw) f.workspaceId = str(raw.workspaceId);
  if (str(raw.projectId)) f.projectId = raw.projectId as string;
  if (str(raw.assigneeId)) f.assigneeId = raw.assigneeId as string;
  if (Array.isArray(raw.statuses)) f.statuses = raw.statuses.filter((s): s is Status => (STATUSES as readonly unknown[]).includes(s));
  if (raw.excludeDone !== undefined) f.excludeDone = bool(raw.excludeDone);
  if (typeof raw.dueFrom === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueFrom)) f.dueFrom = raw.dueFrom;
  if (typeof raw.dueTo === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw.dueTo)) f.dueTo = raw.dueTo;
  if (str(raw.authorId)) f.authorId = raw.authorId as string;
  if (raw.includeArchived !== undefined) f.includeArchived = bool(raw.includeArchived);
  return f;
}

/** SearchFilters → search_all's filters jsonb (snake_case; workspaceId null → Personal, undefined → everywhere). */
export function searchFiltersToRpc(f: SearchFilters): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (f.kinds) out.kinds = f.kinds;
  if (f.workspaceId !== undefined) out.workspace_id = f.workspaceId;
  if (f.projectId) out.project_id = f.projectId;
  if (f.assigneeId) out.assignee_id = f.assigneeId;
  if (f.statuses) out.statuses = f.statuses;
  if (f.excludeDone) out.exclude_done = true;
  if (f.dueFrom) out.due_from = f.dueFrom;
  if (f.dueTo) out.due_to = f.dueTo;
  if (f.authorId) out.author_id = f.authorId;
  if (f.includeArchived) out.include_archived = true;
  return out;
}
