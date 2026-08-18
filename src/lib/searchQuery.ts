/* ============================================================
   KANBO — one search predicate, shared by the Search view (results)
   and the sidebar (saved-search live counts) so they never disagree.
   ============================================================ */
import { getProject, getMember, dueState } from "../data/data";
import type { Task } from "../data/types";

export interface Query { text: string; status: string; priority: string; assignee: string; projectId: string; tag: string; due: string }
export const EMPTY_QUERY: Query = { text: "", status: "all", priority: "all", assignee: "all", projectId: "all", tag: "all", due: "all" };

/** Coerce a stored/partial query (e.g. a saved search's JSON) into a full Query. */
export function toQuery(partial: Record<string, unknown> | undefined | null): Query {
  const p = (partial ?? {}) as Partial<Record<keyof Query, string>>;
  return { ...EMPTY_QUERY, ...p };
}

export function taskMatchesQuery(t: Task, q: Query): boolean {
  if (t.archivedAt) return false;
  const text = q.text.trim().toLowerCase();
  if (text) {
    const hay = [t.title, t.description, getProject(t.projectId)?.name, getMember(t.assigneeId)?.name, ...(t.tags || [])].join(" ").toLowerCase();
    if (!hay.includes(text)) return false;
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
