/* ============================================================
   KANBO — saved_views rows → SavedView; limits; errors.
   lib/rows0048 re-exports these.                   [architect: final]
   ============================================================ */
import type { SavedView, SavedViewFailure, SavedViewKind, SavedViewQuery, SavedViewType } from "../data/types";
import { bool, errText, isMissing, isNetwork, isObj, num, str, strOr } from "./rowUtils";
import { parseSearchFilters } from "./searchFilters";

export const SAVED_VIEW_LIMITS = { name: 80, emoji: 16, queryBytes: 8192, perPerson: 300 } as const;

const VIEW_KINDS: readonly SavedViewKind[] = ["my_tasks", "project", "search"];
const VIEW_TYPES: readonly SavedViewType[] = ["list", "board", "calendar", "timeline"];

export function parseSavedViewQuery(raw: unknown): SavedViewQuery {
  const q: SavedViewQuery = { v: 1 };
  if (!isObj(raw)) return q;
  if (str(raw.projectId)) q.projectId = raw.projectId as string;
  if (typeof raw.viewType === "string" && (VIEW_TYPES as readonly string[]).includes(raw.viewType)) q.viewType = raw.viewType as SavedViewType;
  if (str(raw.list)) q.list = raw.list as string;
  if (isObj(raw.filters)) {
    const f: Record<string, string | boolean> = {};
    for (const [k, v] of Object.entries(raw.filters)) if (typeof v === "string" || typeof v === "boolean") f[k] = v;
    q.filters = f;
  }
  if (isObj(raw.search)) q.search = { text: strOr(raw.search.text, ""), filters: parseSearchFilters(raw.search.filters) };
  if (str(raw.groupBy)) q.groupBy = raw.groupBy as string;
  if (str(raw.sort)) q.sort = raw.sort as string;
  if (raw.sortDir === "asc" || raw.sortDir === "desc") q.sortDir = raw.sortDir;
  return q;
}

/** A saved_views row (snake_case; camelCase also read) → SavedView, or null when it isn't one. */
export function parseSavedView(raw: unknown): SavedView | null {
  if (!isObj(raw)) return null;
  const g = (snake: string, camel: string) => (raw[snake] !== undefined ? raw[snake] : raw[camel]);
  const id = str(raw.id), userId = str(g("user_id", "userId")), name = str(raw.name);
  if (!id || !userId || !name) return null;
  const kind = typeof raw.kind === "string" && (VIEW_KINDS as readonly string[]).includes(raw.kind) ? (raw.kind as SavedViewKind) : null;
  if (!kind) return null;
  return {
    id, userId, name,
    workspaceId: str(g("workspace_id", "workspaceId")),
    emoji: str(raw.emoji),
    kind,
    query: parseSavedViewQuery(raw.query),
    pinned: bool(raw.pinned),
    position: num(raw.position),
    shared: bool(raw.shared),
    createdAt: strOr(g("created_at", "createdAt"), ""),
    updatedAt: strOr(g("updated_at", "updatedAt"), ""),
  };
}

export function savedViewFailure(e: unknown): SavedViewFailure {
  const m = errText(e);
  if (isMissing(m)) return "unavailable";
  if (/too many saved views/i.test(m)) return "too_many";
  if (/row-level security|permission denied|not authorized/i.test(m)) return "not_allowed";
  if (/saved_views_shape|check constraint|invalid/i.test(m)) return "invalid";
  if (/not found|0 rows|PGRST116/i.test(m)) return "not_found";
  if (isNetwork(m)) return "network";
  return "error";
}
