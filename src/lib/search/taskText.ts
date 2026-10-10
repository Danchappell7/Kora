/* ============================================================
   KANBO — does a task contain the words? The Search page's own rule
   (lib/searchQuery: title, description, tags, and its project's and
   people's names; accents folded; "phrases" kept whole), reached
   through taskMatchesQuery so the shell's copy of searchQuery grows
   by nothing. Archived tasks are matched too (filters decide whether
   they show).
   ============================================================ */
import { EMPTY_QUERY, searchTerms, taskMatchesQuery } from "../searchQuery";
import type { Task } from "../../data/types";

/** Every term of the text is in the task (text with no real term matches nothing). */
export function taskMatchesText(t: Task, text: string): boolean {
  if (!searchTerms(text).length) return false;
  // taskMatchesQuery never lists an archived task; the words are all that's asked here
  const subject = t.archivedAt ? { ...t, archivedAt: undefined } : t;
  return taskMatchesQuery(subject, { ...EMPTY_QUERY, text, includeArchived: true });
}
