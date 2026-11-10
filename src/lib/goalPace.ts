/* ============================================================
   KANBO — where a goal should be today, and the status that would
   say so. Kanbo tells, you decide: the pace suggests On track, At
   risk or Off track (or Achieved), the goal's owner accepts it in
   one tap or keeps their own call, and nothing here ever changes a
   status by itself.
   · the pace runs from the goal's start (its period's first day, else
     the day it was made) to its due date (else its period's last day);
   · linear: evenly along the way; back-loaded: slow, then fast (most of
     it lands late, like presales); off: no pace line;
   · within 5% of where it should be is on pace; behind by up to 20% is
     at risk, further is off track; past its date unfinished is off track.
   Pure: no React, no I/O.
   ============================================================ */
import type { Goal, GoalPaceMode, GoalStatus } from "../data/types";
import type { GoalPace } from "./group";

export type PaceState = "early" | "ahead" | "on" | "behind" | "late" | "done";

export interface PaceRead {
  mode: Exclude<GoalPaceMode, "off">;
  /** where it should be today, 0–100 */
  expected: number;
  /** where it is, 0–100 */
  actual: number;
  /** actual − expected, in points of the goal */
  gap: number;
  state: PaceState;
  /** "Behind pace by 12%", "On pace", "Ahead of pace", "Past due at 40%", "Starts 1 Jan" */
  line: string;
  /** the status the pace would give it; null before it starts */
  suggest: GoalStatus | null;
}

/** On pace within this many points either side. */
export const ON_PACE = 5;
/** Behind by more than this is off track (up to it, at risk). */
export const OFF_TRACK_GAP = 20;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayNo = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / 86_400_000; };
const shortDay = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

/** The goal's pace window: from its period's start (else the day it was made, in local
 *  time) to its due date (else its period's end). Null when either end is missing. */
export function paceWindow(g: Pick<Goal, "periodStart" | "periodEnd" | "due" | "createdAt">): { start: string; end: string } | null {
  const made = g.createdAt ? localIso(new Date(g.createdAt)) : undefined;
  const start = g.periodStart || made;
  const end = g.due || g.periodEnd || undefined;
  if (!start || !end || dayNo(end) <= dayNo(start)) return null;
  return { start, end };
}

/** How much of the way the goal should be by `t` (0–1 of its window). */
export const paceCurve = (mode: Exclude<GoalPaceMode, "off">, t: number): number => {
  const x = Math.max(0, Math.min(1, t));
  return mode === "backloaded" ? x * x : x;
};

/** The pace read for a goal at `pct` today, or null (pace off, or no start or due date). */
export function goalPace(g: Pick<Goal, "pace" | "periodStart" | "periodEnd" | "due" | "createdAt">, pct: number, today: Date): PaceRead | null {
  const mode = g.pace ?? "linear";
  if (mode === "off") return null;
  const win = paceWindow(g);
  if (!win) return null;
  const now = dayNo(localIso(today)), s = dayNo(win.start), e = dayNo(win.end);
  const actual = Math.max(0, Math.min(100, Math.round(pct)));
  const expected = Math.round(paceCurve(mode, (now - s) / (e - s)) * 100);
  const gap = actual - expected;
  const read = (state: PaceState, line: string, suggest: GoalStatus | null): PaceRead => ({ mode, expected, actual, gap, state, line, suggest });
  if (actual >= 100) return read("done", "Target reached", "done");
  if (now < s) return read("early", `Starts ${shortDay(win.start)}`, null);
  if (now > e) return read("late", `Past due at ${actual}%`, "off_track");
  if (gap >= ON_PACE) return read("ahead", "Ahead of pace", "on_track");
  if (gap > -ON_PACE) return read("on", "On pace", "on_track");
  return read("behind", `Behind pace by ${-gap}%`, -gap > OFF_TRACK_GAP ? "off_track" : "at_risk");
}

/** Does the goal's status say something different from its pace? (An achieved goal is
 *  the owner's call and is left alone; so is a goal with no suggestion yet.) */
export function paceDisagrees(status: GoalStatus, read: PaceRead | null): read is PaceRead & { suggest: GoalStatus } {
  return !!read && read.suggest !== null && status !== "done" && read.suggest !== status;
}

/** The Group page's hook (lib/group GoalPace): behind when the pace says at risk or worse. */
export const groupGoalPace: GoalPace = (goal, progress, today) => {
  const read = goalPace(goal, progress.pct, today);
  if (!read || read.state === "early" || read.state === "done") return null;
  return { behind: read.state === "behind" || read.state === "late", line: read.line };
};
