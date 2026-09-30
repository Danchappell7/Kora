/* ============================================================
   KANBO — Smart Lists
   Pinned, always-current saved views shown in the sidebar. Each is a
   Search-view preset (so clicking one opens the full filtered results) and
   its live count runs that same preset through the Search predicate — one
   source of truth, so the sidebar badge and the results always agree.

   Every list is personal: it covers tasks assigned to you or that you
   collaborate on. A team-wide "Overdue" in a 40-person workspace is noise
   in everyone's sidebar; the team-wide versions are Search's "All …" chips.
   Tasks in archived projects are left out (see taskMatchesQuery).
   ============================================================ */
import { taskMatchesQuery, toQuery, type Query } from "./searchQuery";
import type { Task, IconName } from "../data/types";

export interface SmartList {
  id: string;
  label: string;
  icon: IconName;
  /** one-line scope note, shown in Search while the list is open */
  description: string;
  match: (t: Task, currentUserId: string) => boolean;
  preset: Record<string, string>; // maps onto SearchView's Query fields
}

/** placeholder for the signed-in user inside a preset */
const ME = "@me";

function resolvePreset(preset: Record<string, string>, currentUserId: string): Record<string, string> {
  const q: Record<string, string> = {};
  for (const [k, v] of Object.entries(preset)) q[k] = v === ME ? currentUserId : v;
  return q;
}

/** The list's count predicate IS the Search predicate over its preset. The
 *  resolved query is cached per user, since this runs once per task. */
function presetMatcher(preset: Record<string, string>): SmartList["match"] {
  let forUser: string | null = null;
  let query: Query | null = null;
  return (t, currentUserId) => {
    if (!currentUserId) return false; // no user yet: nothing is "mine"
    if (query === null || forUser !== currentUserId) { forUser = currentUserId; query = toQuery(resolvePreset(preset, currentUserId)); }
    return taskMatchesQuery(t, query);
  };
}

const smartList = (id: string, label: string, icon: IconName, description: string, preset: Record<string, string>): SmartList =>
  ({ id, label, icon, description, preset, match: presetMatcher(preset) });

export const SMART_LISTS: SmartList[] = [
  smartList("mine", "Assigned to me", "user", "Open tasks assigned to you or where you're a collaborator",
    { assignee: ME, status: "open" }),
  smartList("today", "Due today", "calendar", "Assigned to you or where you're a collaborator",
    { assignee: ME, due: "today" }),
  smartList("overdue", "Overdue", "clock", "Assigned to you or where you're a collaborator",
    { assignee: ME, due: "overdue" }),
  smartList("week", "Due this week", "calendarPlus", "Open, due in the next 7 days · assigned to you or where you're a collaborator",
    { assignee: ME, due: "week", status: "open" }),
];

export const smartListById = (id?: string) => SMART_LISTS.find((s) => s.id === id);

/** Resolve a list's preset into a concrete Search query (expands the @me token). */
export function smartListQuery(id: string | undefined, currentUserId: string): Record<string, string> | undefined {
  const list = smartListById(id);
  if (!list) return undefined;
  return resolvePreset(list.preset, currentUserId);
}
