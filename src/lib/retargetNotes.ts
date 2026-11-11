/* ============================================================
   KANBO — what's said when a change to several tasks met App's
   retarget backstop (0058 project access, and moves between
   workspaces). Each task's note names it ("Sana can't see Payroll,
   so “Renew contract” stays with its assignee."); one is said as it
   is, several are counted by what happened to them, so a toast never
   says they came to you when they stayed where they were, nor stays
   quiet when two or more were refused.
   Pure.
   ============================================================ */

const STAYED = /stays with its assignee\.$/;

const tasks = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;

/** One sentence for the notes of one change (null: nothing to say). */
export function retargetSummary(notes: Iterable<string>): string | null {
  const list = [...new Set(notes)].filter(Boolean);
  if (!list.length) return null;
  if (list.length === 1) return list[0];
  const stayed = list.filter((n) => STAYED.test(n)).length;
  const mine = list.length - stayed;
  const parts: string[] = [];
  if (stayed) parts.push(`${tasks(stayed)} stayed with ${stayed === 1 ? "its assignee" : "their assignees"}: the person picked can't see ${stayed === 1 ? "its project" : "their projects"}`);
  if (mine) parts.push(`${tasks(mine)} ${mine === 1 ? "is" : "are"} now assigned to you: ${mine === 1 ? "its assignee" : "their assignees"} can't see where ${mine === 1 ? "it" : "they"} went`);
  return parts.join(". ") + ".";
}

/** How many of the notes say a task stayed with its assignee (so it wasn't changed). */
export const stayedCount = (notes: Iterable<string>): number => [...new Set(notes)].filter((n) => STAYED.test(n)).length;
