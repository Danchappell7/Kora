/* ============================================================
   KANBO — how Kanbo counts. One progress rule and one risk
   vocabulary, so every screen tells the same story:
   · progress is the share of a project's top-level tasks that are
     done. A sub-task nests under its parent and is never counted on
     its own, so the project header, the directory, portfolios, goals
     and the Overview all read the same %;
   · "Blocked" is a status someone set. "Waiting on" is an open
     dependency. A task counts as blocked only when its status says so;
     one that's held up by unfinished work it depends on is waiting.
     Radar's risks are a few of these (blocked, or "held up": waiting
     on someone else's work and pressing), never a second count of them;
   · Radar's risks either need action (red) or are worth a look.
   Pure: no React, no I/O.
   ============================================================ */
import type { Task } from "../data/types";

export interface Progress {
  /** top-level tasks */
  total: number;
  /** of those, done */
  done: number;
  /** done as a whole % of total (0 when there are none) */
  pct: number;
}

const live = (t: Task) => !t.archivedAt;

/** Progress over a list of tasks: its live top-level tasks. */
export function progressOf(tasks: Task[]): Progress {
  let total = 0, done = 0;
  for (const t of tasks) {
    if (!live(t) || t.parentId) continue;
    total++;
    if (t.status === "done") done++;
  }
  return { total, done, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** One project's progress, picked out of any task list. */
export function projectProgressOf(tasks: Task[], projectId: string): Progress {
  return progressOf(tasks.filter((t) => t.projectId === projectId));
}

/** One project's % done. */
export const projectPct = (tasks: Task[], projectId: string): number => projectProgressOf(tasks, projectId).pct;

/** Several projects read together (a portfolio): every top-level task across
 *  them, so a big project weighs more than a small one. */
export function combinedProgress(tasks: Task[], projectIds: string[]): Progress {
  const ids = new Set(projectIds);
  return progressOf(tasks.filter((t) => ids.has(t.projectId)));
}

/* ---------------- the risk vocabulary ---------------- */

/** The words, in one place. */
export const RISK_WORDS = {
  blocked: "Blocked",
  waiting: "Waiting on",
  action: "Needs action",
  look: "Worth a look",
} as const;

type Lookup = Map<string, Task> | ((id: string) => Task | undefined);
const finder = (byId: Lookup) => (typeof byId === "function" ? byId : (id: string) => byId.get(id));

export const isOpen = (t: Task): boolean => t.status !== "done" && !t.archivedAt;

/** Blocked: open, and its status says so. */
export const isBlocked = (t: Task): boolean => isOpen(t) && t.status === "blocked";

/** The unfinished tasks this one depends on. */
export function openBlockers(t: Task, byId: Lookup): Task[] {
  const find = finder(byId);
  return (t.dependencies ?? []).map((id) => find(id)).filter((x): x is Task => !!x && isOpen(x));
}

/** Waiting on: open, not marked blocked, and something it depends on isn't done yet.
 *  Never a milestone: it waits for its work by design (Radar watches it as a milestone).
 *  Radar's "held up" risks are some of these: the pressing ones held up by someone else. */
export function isWaiting(t: Task, byId: Lookup): boolean {
  return isOpen(t) && t.status !== "blocked" && !t.isMilestone && openBlockers(t, byId).length > 0;
}

/** A list split the one way: blocked (the status) and waiting on (a dependency).
 *  `all` is where dependencies are looked up (default: the list itself). */
export function blockedAndWaiting(tasks: Task[], all: Task[] = tasks): { blocked: Task[]; waiting: Task[] } {
  const byId = new Map(all.map((t) => [t.id, t]));
  const blocked: Task[] = [], waiting: Task[] = [];
  for (const t of tasks) {
    if (isBlocked(t)) blocked.push(t);
    else if (isWaiting(t, byId)) waiting.push(t);
  }
  return { blocked, waiting };
}

/** "1 blocked" · "3 blocked" */
export const blockedText = (n: number): string => `${n} blocked`;
/** "1 waiting on other work" · "2 waiting on other work" */
export const waitingText = (n: number): string => `${n} waiting on other work`;

/** Radar's risks counted in its own words: those that need action (red) and those worth a look. */
export function riskTally(risks: { severity: "signal" | "warn" | "neutral" }[]): { all: number; action: number; look: number } {
  const action = risks.filter((r) => r.severity === "signal").length;
  return { all: risks.length, action, look: risks.length - action };
}

const NUM_WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
/** The brief's sentence: "One risk needs action" · "Four risks need action" · "12 risks need action".
 *  Radar names the same ones "Needs action". */
export function needsActionText(n: number): string {
  const count = Number.isInteger(n) && n >= 0 && n < NUM_WORDS.length ? NUM_WORDS[n] : String(n);
  return `${count} ${n === 1 ? "risk needs" : "risks need"} action`;
}
