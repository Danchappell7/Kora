/* ============================================================
   KANBO — one search predicate, shared by the Search view (results)
   and the sidebar (saved-search live counts) so they never disagree.
   ============================================================ */
import { getProject, getMember, dueState } from "../data/data";
import type { Task } from "../data/types";

export interface Query {
  text: string; status: string; priority: string; assignee: string; projectId: string; tag: string; due: string;
  /** include tasks whose project is archived (hidden by default everywhere) */
  includeArchived?: boolean;
}
export const EMPTY_QUERY: Query = { text: "", status: "all", priority: "all", assignee: "all", projectId: "all", tag: "all", due: "all", includeArchived: false };

/** the string-valued fields (everything except the includeArchived switch) */
const STRING_KEYS = ["text", "status", "priority", "assignee", "projectId", "tag", "due"] as const;

/** Coerce a stored/partial query (e.g. a saved search's JSON) into a full Query.
 *  Only string field values are accepted; anything else (null, number, a
 *  migrated/garbage row) falls back to the EMPTY default so the predicate can
 *  never throw on q.<field>.trim(). includeArchived accepts true / "true". */
export function toQuery(partial: Record<string, unknown> | undefined | null): Query {
  const p = (partial ?? {}) as Record<string, unknown>;
  const out: Query = { ...EMPTY_QUERY };
  STRING_KEYS.forEach((k) => { if (typeof p[k] === "string") out[k] = p[k] as string; });
  out.includeArchived = p.includeArchived === true || p.includeArchived === "true";
  return out;
}

/** True when the query narrows anything (text or any filter). The archived
 *  switch only widens a search, so on its own it doesn't count as a search.
 *  Text counts only once it holds a real term: a lone `"` (the first thing
 *  typed when starting a phrase) matches nothing yet, so it isn't a search. */
export function isQueryActive(q: Query): boolean {
  return hasSearchText(q.text) || STRING_KEYS.some((k) => k !== "text" && q[k] !== "all");
}

/** Does this search text contain at least one term (not just spaces/quotes)? */
export function hasSearchText(text: string): boolean {
  return searchTerms(text).length > 0;
}

/** Same search? (text compared trimmed; a missing includeArchived is false) */
export function queriesEqual(a: Query, b: Query): boolean {
  return a.text.trim() === b.text.trim()
    && STRING_KEYS.every((k) => k === "text" || a[k] === b[k])
    && !!a.includeArchived === !!b.includeArchived;
}

/** Lower-case and strip accents, so "cafe" finds "Café" and "zoe" finds "Zoë".
 *  Curly apostrophes (iOS smart punctuation) fold to a straight one, so
 *  "sarah's" typed on a laptop finds "Sarah’s review" typed on a phone.
 *  Plain-ASCII text (most of it) skips the Unicode work entirely. */
const NON_ASCII = /[^\x00-\x7f]/;
export function foldText(s: string): string {
  if (!NON_ASCII.test(s)) return s.toLowerCase();
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019\u201b\u2032]/g, "'").toLowerCase();
}

/** Split search text into terms. Words match in any order (every term must
 *  appear); "double-quoted phrases" stay together. Curly quotes from phone
 *  keyboards count as quotes, and a stray unmatched quote is ignored. */
let lastText: string | null = null;
let lastTerms: string[] = [];
export function searchTerms(text: string): string[] {
  // the predicate runs once per task with the same text — parse it once
  if (text === lastText) return lastTerms;
  const s = foldText(text.replace(/[“”„‟″]/g, '"'));
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const term = (m[1] !== undefined ? m[1].trim().replace(/\s+/g, " ") : m[2].replace(/"/g, ""));
    if (term) out.push(term);
  }
  lastText = text; lastTerms = out;
  return out;
}

/* Everything a text search looks through: the task's own title, description
   and tags, plus its project's, assignee's and collaborators' names. A term
   never contains a newline, so testing each field separately is the same as
   searching the fields joined with "\n" (a phrase can't span two fields).

   The task's own fields are folded once per task object and cached: edits
   replace the Task object, and the cached source values are re-checked too,
   so a stale fold can never be used. Names are short and folded on demand,
   so renaming a project or member takes effect immediately. */
interface FoldedTask { title: string; description: string; tagsKey: string; foldedTitle: string; own: string }
const foldCache = new WeakMap<Task, FoldedTask>();
function foldedTask(t: Task): FoldedTask {
  const title = t.title || "", description = t.description || "", tagsKey = (t.tags || []).join("\n");
  const hit = foldCache.get(t);
  if (hit && hit.title === title && hit.description === description && hit.tagsKey === tagsKey) return hit;
  const foldedTitle = foldText(title);
  const entry: FoldedTask = { title, description, tagsKey, foldedTitle, own: [foldedTitle, foldText(description), foldText(tagsKey)].join("\n") };
  foldCache.set(t, entry);
  return entry;
}
function nameFields(t: Task): string[] {
  return [getProject(t.projectId)?.name, getMember(t.assigneeId)?.name, ...(t.collaborators ?? []).map((id) => getMember(id)?.name)]
    .filter((n): n is string => !!n).map(foldText);
}
function matchesTerms(t: Task, terms: string[]): boolean {
  const own = foldedTask(t).own;
  let names: string[] | null = null;
  return terms.every((term) => {
    if (own.includes(term)) return true;
    if (!names) names = nameFields(t);
    return names.some((n) => n.includes(term));
  });
}

/** Is this task in a project that has been archived? */
export function inArchivedProject(t: Task): boolean {
  return !!getProject(t.projectId)?.archivedAt;
}

export function taskMatchesQuery(t: Task, q: Query): boolean {
  if (t.archivedAt) return false;
  // an archived project is "hidden but kept": its tasks stay out of search
  // results, smart-list badges and saved-search counts unless asked for.
  if (!q.includeArchived && inArchivedProject(t)) return false;
  const terms = searchTerms(q.text);
  if (terms.length && !matchesTerms(t, terms)) return false;
  if (q.status === "open") { if (t.status === "done") return false; }
  else if (q.status !== "all" && t.status !== q.status) return false;
  if (q.priority !== "all" && t.priority !== q.priority) return false;
  if (q.assignee !== "all" && t.assigneeId !== q.assignee && !(t.collaborators ?? []).includes(q.assignee)) return false;
  if (q.projectId !== "all" && t.projectId !== q.projectId) return false;
  if (q.tag !== "all" && !(t.tags || []).includes(q.tag)) return false;
  if (q.due === "has" && !t.dueDate) return false;
  if (q.due === "overdue" && dueState(t.dueDate, t.status) !== "overdue") return false;
  if (q.due === "today" && dueState(t.dueDate, t.status) !== "today") return false;
  if (q.due === "week") {
    if (!t.dueDate) return false;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = (new Date(t.dueDate + "T00:00:00").getTime() - today.getTime()) / 86400000;
    if (!(diff >= 0 && diff <= 7)) return false;
  }
  if (q.due === "none" && t.dueDate) return false;
  return true;
}

/** Relevance for ordering text-search results (lower sorts first): tasks whose
 *  title contains every term lead, and open work sits above finished work.
 *  Without search text every task ranks equally (original order is kept). */
export function searchRank(t: Task, q: Query): number {
  const terms = searchTerms(q.text);
  if (!terms.length) return 0;
  const title = foldedTask(t).foldedTitle;
  return (terms.every((term) => title.includes(term)) ? 0 : 2) + (t.status === "done" ? 1 : 0);
}
