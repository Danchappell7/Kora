/* ============================================================
   KANBO — universal search: server + local, merged (0048).  [0048 contract → u2]
   • searchAll: rpc search_all(q, filters, lim) — SECURITY INVOKER, so it
     only ever returns rows the caller can read. Typed ranked hits per kind
     (task, comment, doc, project, person) with highlighted snippets
     (U+E000…U+E001 → splitHighlights). Abortable (a newer keystroke wins).
   • localSearch: the same kinds from what the app already holds (tasks,
     comments loaded for open tasks, projects, people; docs by title, and
     by their text when it's on hand) — instant, and the whole answer
     offline, in demo mode, or before 0048 ("unavailable"). It follows the
     server's rules: every word must match; task filters narrow tasks,
     a project narrows everything, an author narrows comments; no words
     and only task filters lists those tasks; nothing at all lists nothing.
     Every match of a kind is ranked (title > body, open before done,
     newest) before the per-kind cap, so a title hit is never crowded out.
   • mergeSearchHits: local first (instant), then the server's, de-duplicated
     by kind+id (the server's snippet wins), ranked: exact title > prefix >
     words in title > body; then open work before finished, the server's
     own rank, recency; a per-kind cap.
   • recent searches: the last 8, per person, in localStorage.
   ⌘K uses all of it debounced (~120 ms); SearchView the full version.
   ============================================================ */
import type { Comment, Member, Project, SearchFilters, SearchHit, SearchHitKind, Task } from "../data/types";
import { supabase } from "./supabase";
import { parseSearchHit, searchFiltersToRpc, SEARCH_LIMIT_MAX, SEARCH_QUERY_MAX } from "./searchRows";
import { foldText, searchTerms } from "./searchQuery";
import { taskMatchesText } from "./search/taskText";
import { allTermsIn, makeSnippet, matchRanges } from "./search/highlight";

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
const KIND_ORDER: Record<SearchHitKind, number> = { task: 0, comment: 1, doc: 2, project: 3, person: 4 };

/** Do these filters narrow tasks on their own (so "no words" still lists something)? — search_all's task_filtered */
export function filtersNarrowTasks(f: SearchFilters): boolean {
  return !!(f.projectId || f.assigneeId || f.statuses || f.excludeDone || f.dueFrom || f.dueTo);
}

/** An Error that searchFailure() reads as "unavailable" (no server: demo mode). */
const noServer = () => new Error("Could not find the function public.search_all: no server in demo mode");

/** The server's hits (empty text + no task filters → []). Rejects with an Error whose searchFailure() is the reason. */
export async function searchAll(text: string, filters: SearchFilters, opts?: { limit?: number; signal?: AbortSignal }): Promise<SearchHit[]> {
  const q = (text ?? "").trim().slice(0, SEARCH_QUERY_MAX);
  if (!searchTerms(q).length && !filtersNarrowTasks(filters)) return [];
  if (opts?.signal?.aborted) throw abortError();
  if (!supabase) throw noServer();
  const lim = Math.min(Math.max(Math.round(opts?.limit ?? SEARCH_VIEW_LIMIT), 1), SEARCH_LIMIT_MAX);
  let req = supabase.rpc("search_all", { q, filters: searchFiltersToRpc(filters), lim });
  if (opts?.signal) req = req.abortSignal(opts.signal);
  const { data, error } = await req;
  if (opts?.signal?.aborted) throw abortError();
  if (error) throw error;
  return (Array.isArray(data) ? data : []).map(parseSearchHit).filter((h): h is SearchHit => !!h);
}
const abortError = () => { const e = new Error("The search was cancelled"); e.name = "AbortError"; return e; };
/** a newer keystroke cancelled it (not a failure to show) */
export const isAbort = (e: unknown): boolean => !!e && typeof e === "object" && (e as { name?: string }).name === "AbortError";

/* ------------------------------------------------------------------ local */

export interface LocalSearchInput {
  text: string;
  filters: SearchFilters;
  tasks: Task[];
  projects: Project[];
  members: Member[];
  /** comments the app has loaded (by task) */
  comments?: Comment[];
  /** docs the app knows about (titles only; `text` = the doc's plain text when it's on hand, e.g. in demo mode) */
  docs?: { id: string; projectId: string; title: string; workspaceId: string | null; text?: string; icon?: string | null; archived?: boolean; updatedAt?: string | null; updatedBy?: string | null }[];
  currentUserId: string;
  /** per kind (default SEARCH_LIMIT_MAX) */
  limit?: number;
}

const inScope = (ws: string | null | undefined, f: SearchFilters) =>
  f.workspaceId === undefined || (f.workspaceId === null ? !ws : ws === f.workspaceId);

/** Does a task pass the filters (not the words)? The rules search_all applies to tasks. */
export function taskPassesFilters(t: Task, f: SearchFilters, projectById: (id: string) => Project | undefined): boolean {
  if (!inScope(t.workspaceId, f)) return false;
  if (!f.includeArchived && (t.archivedAt || projectById(t.projectId)?.archivedAt)) return false;
  if (f.projectId && t.projectId !== f.projectId) return false;
  if (f.assigneeId && t.assigneeId !== f.assigneeId && !(t.collaborators ?? []).includes(f.assigneeId)) return false;
  if (f.statuses && !f.statuses.includes(t.status)) return false;
  if (f.excludeDone && t.status === "done") return false;
  if ((f.dueFrom || f.dueTo) && !t.dueDate) return false;
  const due = (t.dueDate ?? "").slice(0, 10);
  if (f.dueFrom && due < f.dueFrom) return false;
  if (f.dueTo && due > f.dueTo) return false;
  return true;
}

/** the start of a body, one line, about 160 characters */
const excerpt = (body: string): string => { const one = body.replace(/\s+/g, " ").trim(); return one.length > 160 ? one.slice(0, 159).trimEnd() + "…" : one; };

const taskHit = (t: Task, snippet: string | null): SearchHit => ({
  kind: "task", id: t.id, title: t.title, snippet, rank: 0, taskId: t.id, projectId: t.projectId, workspaceId: t.workspaceId ?? null,
  updatedAt: t.completedAt ?? t.createdAt ?? null, source: "local",
  task: { status: t.status, priority: t.priority, dueDate: t.dueDate ?? null, assigneeId: t.assigneeId || null, parentId: t.parentId ?? null, archived: !!t.archivedAt },
});

/** The same search over what's on hand (source "local"). */
export function localSearch(input: LocalSearchInput): SearchHit[] {
  const f = input.filters ?? {};
  const text = (input.text ?? "").slice(0, SEARCH_QUERY_MAX);
  const terms = searchTerms(text);
  const narrows = filtersNarrowTasks(f);
  // "comments by Theo" with no words: Theo's comments on hand, newest first (search_all needs words for comments)
  const authorOnly = !terms.length && !!f.authorId;
  if (!terms.length && !narrows && !authorOnly) return [];
  const kinds = new Set<SearchHitKind>(f.kinds ?? ["task", "comment", "doc", "project", "person"]);
  const cap = Math.max(1, input.limit ?? SEARCH_LIMIT_MAX);
  const projects = new Map(input.projects.map((p) => [p.id, p]));
  const projectById = (id: string) => projects.get(id);
  const archivedProject = (id: string | null | undefined) => !!(id && projects.get(id)?.archivedAt);
  const out: SearchHit[] = [];

  if (kinds.has("task") && (terms.length || narrows)) {
    const found: Task[] = [];
    for (const t of input.tasks) {
      if (!taskPassesFilters(t, f, projectById)) continue;
      if (terms.length && !taskMatchesText(t, text)) continue;
      found.push(t);
    }
    // every match ranked first, then capped: a title hit is never crowded out by earlier weaker ones
    // (words: title > description/project/people, open before done, newest; no words: soonest due first, as the server lists them)
    const ranked = terms.length
      ? rankByTitle(found, (t) => t.title, (t) => (t.status === "done" ? 1 : 0), (t) => t.completedAt ?? t.createdAt ?? null, text)
      : found.map((t, i) => ({ t, i })).sort((a, b) => cmp(a.t.dueDate ?? "9999", b.t.dueDate ?? "9999") || a.i - b.i).map((x) => x.t);
    out.push(...ranked.slice(0, cap).map((t) => taskHit(t, terms.length ? makeSnippet(t.description, terms) : null)));
  }
  if (!terms.length && !authorOnly) return out;

  const tasksById = new Map(input.tasks.map((t) => [t.id, t]));
  if (kinds.has("comment") && input.comments?.length) {
    const hits: SearchHit[] = [];
    for (const c of input.comments) {
      const t = tasksById.get(c.taskId);
      if (!t) continue;
      if (!inScope(t.workspaceId, f)) continue;
      if (!f.includeArchived && (t.archivedAt || archivedProject(t.projectId))) continue;
      if (f.projectId && t.projectId !== f.projectId) continue;
      if (f.authorId && c.authorId !== f.authorId) continue;
      if (terms.length && !allTermsIn(terms, [c.body])) continue;
      hits.push({
        kind: "comment", id: c.id, title: t.title, snippet: terms.length ? makeSnippet(c.body, terms) : excerpt(c.body), rank: 0, taskId: t.id, projectId: t.projectId,
        workspaceId: t.workspaceId ?? null, updatedAt: c.createdAt, source: "local",
        comment: { authorId: c.authorId, authorName: c.authorName, taskStatus: t.status },
      });
    }
    hits.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    out.push(...hits.slice(0, cap));
  }
  if (!terms.length) return out;
  if (kinds.has("doc") && input.docs?.length) {
    const hits: SearchHit[] = [];
    const matched = input.docs.filter((d) => inScope(d.workspaceId, f) && (f.includeArchived || !(d.archived || archivedProject(d.projectId)))
      && (!f.projectId || d.projectId === f.projectId) && allTermsIn(terms, [d.title, d.text]));
    for (const d of rankByTitle(matched, (x) => x.title, (x) => (x.archived ? 1 : 0), (x) => x.updatedAt ?? null, text).slice(0, cap)) {
      hits.push({
        kind: "doc", id: d.id, title: d.title, snippet: makeSnippet(d.text, terms), rank: 0, taskId: null, projectId: d.projectId,
        workspaceId: d.workspaceId, updatedAt: d.updatedAt ?? null, source: "local",
        doc: { icon: d.icon ?? null, projectName: projects.get(d.projectId)?.name ?? null, updatedBy: d.updatedBy ?? null, archived: !!d.archived },
      });
    }
    out.push(...hits);
  }
  if (kinds.has("project")) {
    const hits: SearchHit[] = [];
    const matched = input.projects.filter((p) => inScope(p.workspaceId, f) && (f.includeArchived || !p.archivedAt)
      && (!f.projectId || p.id === f.projectId) && allTermsIn(terms, [p.name, p.description]));
    for (const p of rankByTitle(matched, (x) => x.name, (x) => (x.archivedAt ? 1 : 0), () => null, text).slice(0, cap)) {
      hits.push({
        kind: "project", id: p.id, title: p.name, snippet: makeSnippet(p.description, terms), rank: 0, taskId: null, projectId: p.id,
        workspaceId: p.workspaceId ?? null, updatedAt: null, source: "local",
        project: { emoji: p.emoji || null, color: p.color || null, status: p.status ?? null, ownerId: p.ownerId ?? null, archived: !!p.archivedAt },
      });
    }
    out.push(...hits);
  }
  // people: the whole text in a name, or the start of an email — never in Personal (as the server has it)
  if (kinds.has("person") && f.workspaceId !== null) {
    const q = foldText(text.replace(/["“”]/g, "").trim());
    const hits: SearchHit[] = [];
    if (q) {
      for (const m of input.members) {
        const name = foldText(m.name || ""), email = foldText(m.email || "");
        if (!name.includes(q) && !email.startsWith(q)) continue;
        hits.push({
          kind: "person", id: m.id, title: m.name || m.email, snippet: m.email || null, rank: name.startsWith(q) ? 1 : 0.5, taskId: null, projectId: null,
          workspaceId: null, updatedAt: null, source: "local",
          person: { email: m.email || "", role: null, title: null, avatarUrl: m.avatarUrl ?? null },
        });
      }
    }
    hits.sort((a, b) => b.rank - a.rank || a.title.localeCompare(b.title));
    out.push(...hits.slice(0, cap));
  }
  return out;
}

/* ------------------------------------------------------------------ merge + rank */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
/** Every match, best first: how well the title matches the words (titleTier), then live before finished or
 *  archived, then newest; the order given breaks ties. (Ranked before any cap is applied.) */
function rankByTitle<T>(items: T[], title: (x: T) => string, settled: (x: T) => number, when: (x: T) => string | null, text: string): T[] {
  return items
    .map((x, i) => ({ x, i, tier: titleTier(title(x), text), settled: settled(x), when: when(x) ?? "" }))
    .sort((a, b) => b.tier - a.tier || a.settled - b.settled || cmp(b.when, a.when) || a.i - b.i)
    .map((r) => r.x);
}

/** How well the title matches the words: 4 exact · 3 starts with them · 2 has every word · 1 has some · 0 body only. */
export function titleTier(title: string, text: string): number {
  const terms = searchTerms(text);
  if (!terms.length || !title) return 0;
  const t = foldText(title).trim().replace(/\s+/g, " ");
  const whole = terms.join(" ");
  if (t === whole) return 4;
  if (t.startsWith(whole)) return 3;
  if (terms.every((x) => t.includes(x))) return 2;
  return terms.some((x) => t.includes(x)) ? 1 : 0;
}

/** Local first, then the server's, de-duplicated and ranked; per-kind cap. `keepOrder` (⌘K): rows the device
 *  found keep their order when the server's answer arrives (its rank only places the rows it alone found),
 *  so nothing jumps under the cursor — a better title match still rises. */
export function mergeSearchHits(local: SearchHit[], server: SearchHit[], opts?: { limitPerKind?: number; text?: string; keepOrder?: boolean }): SearchHit[] {
  const cap = opts?.limitPerKind ?? SEARCH_VIEW_LIMIT;
  const keepOrder = !!opts?.keepOrder;
  const text = opts?.text ?? "";
  const byKey = new Map<string, { hit: SearchHit; order: number }>();
  let order = 0;
  for (const h of local) {
    const key = `${h.kind}:${h.id}`;
    if (!byKey.has(key)) byKey.set(key, { hit: h, order: order++ });
  }
  for (const h of server) {
    const key = `${h.kind}:${h.id}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, { hit: h, order: order++ }); continue; }
    // the server's row (and snippet) wins; what only the device knows fills the gaps
    prev.hit = {
      ...prev.hit, ...h,
      snippet: h.snippet ?? prev.hit.snippet,
      updatedAt: h.updatedAt ?? prev.hit.updatedAt,
      task: h.task ?? prev.hit.task, comment: h.comment ?? prev.hit.comment, doc: h.doc ?? prev.hit.doc,
      project: h.project ?? prev.hit.project, person: h.person ?? prev.hit.person,
    };
  }
  const rows = [...byKey.values()].map((r) => ({ ...r, tier: titleTier(r.hit.title, text), done: r.hit.task?.status === "done" ? 1 : 0 }));
  const hasText = searchTerms(text).length > 0;
  rows.sort((a, b) => {
    const k = KIND_ORDER[a.hit.kind] - KIND_ORDER[b.hit.kind];
    if (k) return k;
    if (!hasText) return a.order - b.order;
    return b.tier - a.tier
      || a.done - b.done
      || (keepOrder ? a.order - b.order : 0)
      || (b.hit.rank ?? 0) - (a.hit.rank ?? 0)
      || (b.hit.updatedAt ?? "").localeCompare(a.hit.updatedAt ?? "")
      || a.order - b.order;
  });
  const counts: Partial<Record<SearchHitKind, number>> = {};
  const out: SearchHit[] = [];
  for (const r of rows) {
    const n = counts[r.hit.kind] ?? 0;
    if (n >= cap) continue;
    counts[r.hit.kind] = n + 1;
    out.push(r.hit);
  }
  return out;
}

/** Hits grouped in SEARCH_GROUPS order (empty groups left out). */
export function groupSearchHits(hits: SearchHit[]): { kind: SearchHitKind; label: string; hits: SearchHit[] }[] {
  return SEARCH_GROUPS.map((g) => ({ ...g, hits: hits.filter((h) => h.kind === g.kind) })).filter((g) => g.hits.length > 0);
}

/** Does a title contain the words? (for highlighting titles the server matched by stem only) */
export const titleHasMatch = (title: string, text: string): boolean => matchRanges(title, searchTerms(text)).length > 0;

/* ------------------------------------------------------------------ recent searches */

const recentKey = (userId: string) => `kanbo-recent-searches:${userId || "anon"}`;
const readRecent = (userId: string): string[] => {
  try {
    const raw = window.localStorage.getItem(recentKey(userId));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).slice(0, RECENT_SEARCHES_MAX) : [];
  } catch { return []; }
};
const writeRecent = (userId: string, list: string[]) => {
  try {
    if (list.length) window.localStorage.setItem(recentKey(userId), JSON.stringify(list));
    else window.localStorage.removeItem(recentKey(userId));
  } catch { /* private window / storage off: recents just don't stick */ }
};

export function recentSearches(userId: string): string[] { return readRecent(userId); }
export function rememberSearch(userId: string, text: string): void {
  const t = (text ?? "").replace(/\s+/g, " ").trim().slice(0, SEARCH_QUERY_MAX);
  if (!t || !searchTerms(t).length) return;
  const key = foldText(t);
  writeRecent(userId, [t, ...readRecent(userId).filter((x) => foldText(x) !== key)].slice(0, RECENT_SEARCHES_MAX));
}
export function forgetRecentSearches(userId: string): void { writeRecent(userId, []); }
/** Take one search off the recent list. */
export function forgetRecentSearch(userId: string, text: string): void {
  const key = foldText(text.trim());
  writeRecent(userId, readRecent(userId).filter((x) => foldText(x) !== key));
}
