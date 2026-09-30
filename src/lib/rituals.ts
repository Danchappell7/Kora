/* ============================================================
   KANBO — rituals: the week's Big 3, the end-of-day shut down,
   today's leftovers and "Your day in colour".
   Personal, per device: nothing here is shared or synced.
   ============================================================ */
import { todayISO, KANBO_TODAY } from "../data/data";
import type { Task, Project } from "../data/types";

const BIG3_KEY = "kanbo-big3";
const SHUTDOWN_KEY = "kanbo-shutdown";

/** The ISO 8601 week a day falls in, e.g. "2026-W40" (weeks start on Monday;
 *  week 1 is the one holding the year's first Thursday). */
export function isoWeek(d: Date = KANBO_TODAY): string {
  const day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dow = day.getUTCDay() || 7;                 // Mon 1 … Sun 7
  day.setUTCDate(day.getUTCDate() + 4 - dow);       // that week's Thursday decides the year
  const year = day.getUTCFullYear();
  const week = Math.ceil(((day.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** This week's (or `week`'s) Big 3 task ids, in order. [] when none are set. */
export function readBig3(userId: string, week: string = isoWeek()): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(`${BIG3_KEY}:${userId}:${week}`) || "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 3) : [];
  } catch { return []; }
}

/** Save the week's Big 3 (at most three; duplicates dropped). An empty list clears it. */
export function writeBig3(userId: string, ids: string[], week: string = isoWeek()): void {
  const key = `${BIG3_KEY}:${userId}:${week}`;
  const keep = [...new Set(ids)].slice(0, 3);
  try {
    if (keep.length) localStorage.setItem(key, JSON.stringify(keep));
    else localStorage.removeItem(key);
  } catch { /* private mode */ }
}

/** Has this person shut down their day (default: today)? */
export function shutdownDone(userId: string, day: string = todayISO()): boolean {
  try { return localStorage.getItem(`${SHUTDOWN_KEY}:${userId}:${day}`) === "1"; } catch { return false; }
}

/** Record that the day was shut down (the last step of the Shut down sheet). */
export function markShutdownDone(userId: string, day: string = todayISO()): void {
  try { localStorage.setItem(`${SHUTDOWN_KEY}:${userId}:${day}`, "1"); } catch { /* private mode */ }
}

/** What's left of today: open tasks that were due today, or planned or
 *  scheduled for today. Archived tasks are left out. */
export function leftovers(tasks: Task[], today: string = todayISO()): Task[] {
  return tasks.filter((t) => t.status !== "done" && !t.archivedAt
    && (t.dueDate === today || !!t.planToday || t.scheduled != null));
}

export interface DaySegment {
  /** a project id, or "focus" for focus-timer minutes */
  key: string;
  label: string;
  minutes: number;
  /** the project's colour; absent for focus (drawn with the brand gradient) */
  color?: string;
}

/** "Your day in colour": the minutes behind today's finished tasks, split by
 *  project (each task counts its duration, else its focus estimate), largest
 *  first, with focus-timer minutes as a last "Focus" segment. Pass the tasks
 *  finished today. */
export function dayInColour(tasks: Task[], projects: Pick<Project, "id" | "name" | "color">[], focusMinutes = 0): { segments: DaySegment[]; total: number } {
  const byProject = new Map<string, number>();
  for (const t of tasks) {
    const min = t.dur || t.focusMin || 0;
    if (min > 0) byProject.set(t.projectId, (byProject.get(t.projectId) ?? 0) + min);
  }
  const segments: DaySegment[] = [...byProject].map(([id, minutes]) => {
    const p = projects.find((x) => x.id === id);
    return { key: id, label: p?.name ?? "Other", minutes, color: p?.color };
  }).sort((a, b) => b.minutes - a.minutes || a.label.localeCompare(b.label));
  if (focusMinutes > 0) segments.push({ key: "focus", label: "Focus", minutes: Math.round(focusMinutes) });
  return { segments, total: segments.reduce((n, s) => n + s.minutes, 0) };
}
