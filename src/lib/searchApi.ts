/* ============================================================
   KANBO — universal search: server + local, merged (0048).  [0048 contract → u2]
   • searchAll: rpc search_all(q, filters, lim) — SECURITY INVOKER, so it
     only ever returns rows the caller can read. Typed ranked hits per kind
     (task, comment, doc, project, person) with highlighted snippets
     (U+E000…U+E001 → splitHighlights). Abortable (a newer keystroke wins).
   • localSearch: the same kinds from what the app already holds (tasks,
     comments loaded for open tasks, projects, people; docs by title) —
     instant, and the whole answer offline, in demo mode, or before 0048
     ("unavailable").
   • mergeSearchHits: local first (instant), then the server's, de-duplicated
     by kind+id (the server's snippet wins), ranked: exact title > prefix >
     words in title > body; then recency; a per-kind cap.
   • recent searches: the last 8, per person, in localStorage.
   ⌘K uses all of it debounced (~120 ms); SearchView the full version.
   ============================================================ */
import type { Comment, Member, Project, SearchFilters, SearchHit, SearchHitKind, Task } from "../data/types";

export {
  parseSearchHit, searchFiltersToRpc, splitHighlights, searchFailure, parseSearchFilters,
  SEARCH_MARK_START, SEARCH_MARK_END, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX,
} from "./searchRows";

/** search_all's lim (per kind) for ⌘K and the full view */
export const SEARCH_PALETTE_LIMIT = 5;
export const SEARCH_VIEW_LIMIT = 20;
/** ⌘K waits this long after typing stops before asking the server */
export const SEARCH_DEBOUNCE_MS = 120;
export const RECENT_SEARCHES_MAX = 8;
/** the order the groups show in */
export const SEARCH_GROUPS: readonly { kind: SearchHitKind; label: string }[] = [
  { kind: "task", label: "Tasks" },
  { kind: "comment", label: "Comments" },
  { kind: "doc", label: "Docs" },
  { kind: "project", label: "Projects" },
  { kind: "person", label: "People" },
];

const notBuilt = (fn: string) => Promise.reject(new Error(`${fn}: not built yet (package u2)`));

/** The server's hits (empty text + no task filters → []). Rejects with an Error whose searchFailure() is the reason. */
export function searchAll(_text: string, _filters: SearchFilters, _opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchHit[]> {
  return notBuilt("searchAll");
}

export interface LocalSearchInput {
  text: string;
  filters: SearchFilters;
  tasks: Task[];
  projects: Project[];
  members: Member[];
  /** comments the app has loaded (by task) */
  comments?: Comment[];
  /** docs the app knows about (titles only) */
  docs?: { id: string; projectId: string; title: string; workspaceId: string | null }[];
  currentUserId: string;
  limit?: number;
}
/** The same search over what's on hand (source "local"). */
export function localSearch(_input: LocalSearchInput): SearchHit[] { return []; }

/** Local first, then the server's, de-duplicated and ranked; per-kind cap. */
export function mergeSearchHits(local: SearchHit[], server: SearchHit[], _opts?: { limitPerKind?: number; text?: string }): SearchHit[] {
  return [...server, ...local];
}

/** Hits grouped in SEARCH_GROUPS order (empty groups left out). */
export function groupSearchHits(hits: SearchHit[]): { kind: SearchHitKind; label: string; hits: SearchHit[] }[] {
  return SEARCH_GROUPS.map((g) => ({ ...g, hits: hits.filter((h) => h.kind === g.kind) })).filter((g) => g.hits.length > 0);
}

export function recentSearches(_userId: string): string[] { return []; }
export function rememberSearch(_userId: string, _text: string): void { /* u2 */ }
export function forgetRecentSearches(_userId: string): void { /* u2 */ }
