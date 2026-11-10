/* ============================================================
   KANBO — the update rhythm, the app's side (0053). The maths is
   shared with daily-reminders: supabase/functions/_shared/updateRhythm.ts.
   Here: a project's rhythm and where its update stands today, from
   what's loaded (its workspace's update day, its own choice, its
   latest update, its first task), and the one label a table shows
   for it: "Update missing" (past the due day and two working days of
   follow-ups), "Due today", or how long ago the last one was.
   Before 0053 is run there's no rhythm (workspaces and projects come
   back without update_rhythm): every reader falls back to the old
   rule, an update older than 14 days is stale (statusDraft isStale),
   and the settings say they aren't switched on yet.
   Personal projects have no update day (nobody to report to).
   ============================================================ */
import type { Project, StatusUpdate, Task, Workspace } from "../data/types";
import { toLocalISO, WORKSPACES } from "../data/data";
import {
  anchorFrom, daysFrom, DEFAULT_RHYTHM, dueDayWords, effectiveRhythm, isoWeekday, parseRhythm, readsMissing, rhythmState,
  type RhythmState, type UpdateRhythm,
} from "../../supabase/functions/_shared/updateRhythm.ts";
import { supabase } from "./supabase";

export {
  anchorFrom, DEFAULT_RHYTHM, dueDayWords, effectiveRhythm, parseRhythm, readsMissing, rhythmLabel, rhythmState,
  UPDATE_CADENCES, weekdayName, rhythmRow, isoWeekday, dueOnOrAfter, isReminderDay,
} from "../../supabase/functions/_shared/updateRhythm.ts";
export type { RhythmState, UpdateCadence, UpdateRhythm } from "../../supabase/functions/_shared/updateRhythm.ts";

/* ---------- is 0053 in? ---------- */

let schema: boolean | null = null;
/** The load saw (or didn't see) update_rhythm on the workspaces and projects it read. */
export function noteRhythmSchema(on: boolean): void { schema = on; }
/** Can update days be read and set? Signed in: once 0053 is run (the load says). Demo: yes. */
export function rhythmOn(): boolean { return schema ?? !supabase; }
/** Tests: forget what the load saw. */
export function resetRhythmSchema(): void { schema = null; }

/* ---------- a project's rhythm ---------- */

/** The workspace a project belongs to, as loaded (App keeps WORKSPACES current). */
export function workspaceOf(p: Pick<Project, "workspaceId">, workspaces: readonly Workspace[] = WORKSPACES): Workspace | undefined {
  return p.workspaceId ? workspaces.find((w) => w.id === p.workspaceId) : undefined;
}

/** The update day a workspace has chosen (weekly on Friday until it chooses). */
export function workspaceRhythm(w: Workspace | undefined): UpdateRhythm {
  return parseRhythm(w?.updateRhythm) ?? DEFAULT_RHYTHM;
}

/** A project's rhythm (its own, else its workspace's), or null where there's none: Personal, or before 0053. */
export function projectRhythm(p: Project, workspaces?: readonly Workspace[]): UpdateRhythm | null {
  if (!rhythmOn() || !p.workspaceId) return null;
  return effectiveRhythm(p.updateRhythm, workspaceOf(p, workspaces)?.updateRhythm);
}

/** Has the project chosen its own update day (rather than following its workspace's)? */
export const ownRhythm = (p: Project): boolean => !!parseRhythm(p.updateRhythm);

/** Paused: archived, put on hold by hand, or its latest update says On hold. */
export function isPaused(p: Project, latest?: Pick<StatusUpdate, "status">): boolean {
  return !!p.archivedAt || p.status === "on_hold" || latest?.status === "on_hold";
}

const day = (iso?: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? null : toLocalISO(d);
};

/** The day a project's first live task was added ("YYYY-MM-DD"); a task that doesn't say counts as long ago.
 *  Null when it has no tasks. `tasks` may be just the project's, or more. */
export function startedOn(tasks: readonly Task[], projectId: string): string | null {
  let first: string | null = null;
  for (const t of tasks) {
    if (t.projectId !== projectId || t.archivedAt) continue;
    const d = day(t.createdAt) ?? "1970-01-01";
    if (!first || d < first) first = d;
  }
  return first;
}

/** Where a project's update stands today, or null when there's no rhythm (Personal, or before 0053). */
export function projectRhythmState(p: Project, tasks: readonly Task[], latest: StatusUpdate | undefined, today: Date, workspaces?: readonly Workspace[]): RhythmState | null {
  const rhythm = projectRhythm(p, workspaces);
  if (!rhythm) return null;
  return rhythmState({ rhythm, today: toLocalISO(today), lastUpdate: day(latest?.createdAt), startedOn: startedOn(tasks, p.id), paused: isPaused(p, latest) });
}

/* ---------- one label for a table ---------- */

export interface UpdateFreshness {
  /** missing: past the day and its follow-ups (or the round before lapsed too) · due: due now · ok · off: no update day */
  kind: "missing" | "due" | "ok" | "off";
  /** "Update missing" · "Due today" · "Updated 2d ago" · "No update yet" */
  text: string;
  /** "2d" style for a narrow column, where there's a figure */
  short: string;
  tone?: "warn" | "signal";
  /** what it means, in full (a tooltip, and the cell's words to a screen reader) */
  title: string;
  /** sorts the worst first: missing 0, due 1, the rest 2 */
  rank: number;
  /** read against an update day (false: before 0053, or in Personal, the 14-day rule) */
  byDay: boolean;
}

/** How a project's update reads in a table: its rhythm's word when it's due or missing,
 *  otherwise how long ago the last one was. `state` null: before 0053 (the old 14-day rule). */
export function updateFreshness(state: RhythmState | null, lastUpdateDays: number | null, stale: boolean, todayIso: string): UpdateFreshness {
  const ago = lastUpdateDays == null ? null : lastUpdateDays <= 0 ? "today" : `${lastUpdateDays}d`;
  const last = lastUpdateDays == null ? "No update posted yet" : lastUpdateDays === 0 ? "Last update today" : `Last update ${lastUpdateDays} ${lastUpdateDays === 1 ? "day" : "days"} ago`;
  if (state && readsMissing(state)) {
    const due = state.kind === "due" || state.kind === "missing" ? state.due : todayIso;
    const when = dueDayWords(due, todayIso);
    // (lapsed: the round before went without one, and this round's is due now)
    const said = state.kind === "due" ? `None came in last round, and one ${state.followUp === 0 ? "is due today" : `was due ${when}`}` : `One was due ${when}`;
    return { kind: "missing", text: "Update missing", short: "Missing", tone: "warn", rank: 0, byDay: true, title: `${last}. ${said}.` };
  }
  if (state?.kind === "due") {
    const when = dueDayWords(state.due, todayIso);
    return { kind: "due", text: state.followUp === 0 ? "Due today" : `Due ${when}`, short: state.followUp === 0 ? "Due today" : "Due", rank: 1, byDay: true,
      title: `${last}. The update is due ${when}.` };
  }
  if (!state && stale) {
    // before 0053: the old rule, an update older than 14 days is stale
    return { kind: "missing", text: "No update in 14 days", short: ago ? `${ago} · stale` : "none · stale", tone: "warn", rank: 0, byDay: false,
      title: lastUpdateDays == null ? "No status update posted yet" : `${last}: stale after 14 days` };
  }
  const next = state?.kind === "ok" && state.next ? ` Next one due ${dueDayWords(state.next, todayIso)}.` : state?.kind === "off" && state.why === "never" ? " This project has no update day." : "";
  const kind = state?.kind === "off" ? "off" : "ok";
  if (lastUpdateDays == null) return { kind, text: "No update yet", short: "none", rank: 2, byDay: !!state, title: `No status update posted yet.${next}` };
  return { kind, text: lastUpdateDays === 0 ? "Updated today" : `Updated ${ago} ago`, short: ago!, rank: 2, byDay: !!state, title: `${last}.${next}` };
}

/** Days from the latest due day to today (how late it is), for sorting. */
export const daysLate = (s: RhythmState | null, todayIso: string): number =>
  s && (s.kind === "due" || s.kind === "missing") ? daysFrom(s.due, todayIso) : -1;

/** A rhythm as it's saved: fortnightly keeps counting from its anchor while the day stays the same,
 *  and otherwise starts from the next such day. */
export function rhythmToSave(r: UpdateRhythm, today: Date): UpdateRhythm {
  if (r.cadence !== "fortnightly") return { cadence: r.cadence, weekday: r.weekday };
  return { cadence: "fortnightly", weekday: r.weekday, anchor: r.anchor && isoWeekday(r.anchor) === r.weekday ? r.anchor : anchorFrom(toLocalISO(today), r.weekday) };
}
