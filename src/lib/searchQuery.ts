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
 *  switch only widens a search, so on its own it doesn't count as a search. */
export function isQueryActive(q: Query): boolean {
  return q.text.trim() !== "" || STRING_KEYS.some((k) => k !== "text" && q[k] !== "all");
}

/** Same search? (text compared trimmed; a missing includeArchived is false) */
export function queriesEqual(a: Query, b: Query): boolean {
  return a.text.trim() === b.text.trim()
    && STRING_KEYS.every((k) => k === "text" || a[k] === b[k])
    && !!a.includeArchived === !!b.includeArchived;
}

/** Lower-case and strip accents, so "cafe" finds "Café" and "zoe" finds "Zoë". */
export function foldText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
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

/** Everything a text search looks through. Fields are joined with a newline so
 *  a quoted phrase can't match across two fields. */
function haystack(t: Task): string {
  return foldText([
    t.title, t.description, getProject(t.projectId)?.name, getMember(t.assigneeId)?.name,
    ...(t.collaborators ?? []).map((id) => getMember(id)?.name),
    ...(t.tags || []),
  ].filter(Boolean).join("\n"));
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
  if (terms.length) {
    const hay = haystack(t);
    if (!terms.every((term) => hay.includes(term))) return false;
  }
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
  const title = foldText(t.title || "");
  return (terms.every((term) => title.includes(term)) ? 0 : 2) + (t.status === "done" ? 1 : 0);
}
