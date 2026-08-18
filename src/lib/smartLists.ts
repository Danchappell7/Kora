/* ============================================================
   KANBO — Smart Lists
   Pinned, always-current saved views shown in the sidebar. Each is a
   predicate over tasks (for the live count) plus a Search-view preset
   (so clicking one opens the full filtered results). One source of
   truth keeps the sidebar badge and the Search results in agreement.
   ============================================================ */
import { dueState } from "../data/data";
import type { Task, IconName } from "../data/types";

export interface SmartList {
  id: string;
  label: string;
  icon: IconName;
  match: (t: Task, currentUserId: string) => boolean;
  preset: Record<string, string>; // maps onto SearchView's Query fields
}

const withinWeek = (iso?: string) => {
  if (!iso) return false;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = (new Date(iso + "T00:00:00").getTime() - today.getTime()) / 86400000;
  return diff >= 0 && diff <= 7;
};

export const SMART_LISTS: SmartList[] = [
  { id: "mine", label: "Assigned to me", icon: "user",
    match: (t, me) => !t.archivedAt && t.status !== "done" && (t.assigneeId === me || (t.collaborators ?? []).includes(me)),
    preset: { assignee: "@me" } },
  { id: "today", label: "Due today", icon: "calendar",
    match: (t) => !t.archivedAt && dueState(t.dueDate, t.status) === "today",
    preset: { due: "today" } },
  { id: "overdue", label: "Overdue", icon: "clock",
    match: (t) => !t.archivedAt && dueState(t.dueDate, t.status) === "overdue",
    preset: { due: "overdue" } },
  { id: "week", label: "Due this week", icon: "calendarPlus",
    match: (t) => !t.archivedAt && t.status !== "done" && withinWeek(t.dueDate),
    preset: { due: "week" } },
];

export const smartListById = (id?: string) => SMART_LISTS.find((s) => s.id === id);

/** Resolve a list's preset into a concrete Search query (expands the @me token). */
export function smartListQuery(id: string | undefined, currentUserId: string): Record<string, string> | undefined {
  const list = smartListById(id);
  if (!list) return undefined;
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(list.preset)) q[k] = v === "@me" ? currentUserId : v;
  return q;
}
