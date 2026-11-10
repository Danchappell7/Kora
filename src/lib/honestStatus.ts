/* ============================================================
   KANBO — honest status: the lead's call and Kanbo's read, as one.
   A project has two ways of saying how it's going: what its lead
   posted (the latest update, or the status set by hand before the
   first one) and what Kanbo sees in the work (reportingUtils
   projectHealth: overdue and blocked tasks, sub-tasks included).
   · mergedStatus: ONE pill for both. It wears the lead's words ("No
     update" when nobody's said anything); when the pill reads better
     than the work ("On track" with 4 overdue and 2 blocked, or no
     update while the work is at risk) it's a mismatch, marked on the
     pill and sorted first, and "Lead says / Kanbo sees" explains it on
     hover or focus.
   · pillCounts: a roll-up's counts from those same pills, so a header
     never says "1 off track" over rows that say otherwise.
   · honestQuestion: the composer's one calm question when a lead
     picks On track while Kanbo sees overdue or blocked work. It never
     blocks the post.
   On hold (an update, or set by hand in About) is the lead's to call:
   it never reads as a mismatch, and stays until it's taken off.
   Pure: no React, no I/O.
   ============================================================ */
import type { Project, StatusKind, StatusUpdate } from "../data/types";
import type { HealthKind } from "../components/views/reportingUtils";

export type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";

export const STATUS_WORDS: Record<StatusKind, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", on_hold: "On hold" };
export const STATUS_TONES: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal", on_hold: "neutral" };
export const HEALTH_WORDS: Record<HealthKind, string> = { complete: "Complete", on_track: "On track", at_risk: "At risk", off_track: "Off track" };
export const HEALTH_TONES: Record<HealthKind, Tone> = { complete: "ok", on_track: "ok", at_risk: "warn", off_track: "signal" };
const BADNESS: Record<string, number> = { complete: 0, on_track: 0, at_risk: 1, off_track: 2 };
const KINDS = new Set<string>(["on_track", "at_risk", "off_track", "on_hold"]);

/** What Kanbo counts in the work (statusFacts or projectHealth). */
export interface KanboRead { health: HealthKind | null; overdue: number; blocked: number }

/** "4 overdue and 2 blocked" · "1 overdue" · "2 blocked" ("" when neither). */
export function kanboCounts(r: Pick<KanboRead, "overdue" | "blocked">): string {
  const bits = [r.overdue ? `${r.overdue} overdue` : "", r.blocked ? `${r.blocked} blocked` : ""].filter(Boolean);
  return bits.join(" and ");
}

/** "Kanbo sees 4 overdue and 2 blocked" (or that nothing's overdue or blocked, every task's done, or there are none). */
export function kanboSees(r: KanboRead): string {
  if (!r.health) return "Kanbo sees no tasks yet";
  if (r.health === "complete") return "Kanbo sees every task done";
  const n = kanboCounts(r);
  return n ? `Kanbo sees ${n}` : "Kanbo sees nothing overdue or blocked";
}

/** Is the lead's call rosier than the work? (On hold never is: pausing is the lead's call.) */
export function rosier(lead: StatusKind | null | undefined, kanbo: HealthKind | null | undefined): boolean {
  if (!lead || !kanbo || lead === "on_hold") return false;
  return BADNESS[kanbo] > BADNESS[lead];
}

/** The composer's question, when the lead picks On track and Kanbo sees overdue or blocked work
 *  ("Kanbo sees 4 overdue and 2 blocked. Keep On track, or add a plan to recover?"); null otherwise. */
export function honestQuestion(kind: StatusKind, r: KanboRead): string | null {
  if (kind !== "on_track" || !rosier(kind, r.health)) return null;
  const n = kanboCounts(r);
  return n ? `Kanbo sees ${n}. Keep On track, or add a plan to recover?` : null;
}

/** The lead's call: the latest update's, else the status set by hand. A hand-set On hold stays
 *  until it's taken off, whatever's posted meanwhile. */
export function leadCall(project: Pick<Project, "status">, latest?: Pick<StatusUpdate, "status">): StatusKind | null {
  if (project.status === "on_hold") return "on_hold";
  if (latest && KINDS.has(latest.status)) return latest.status;
  return project.status && KINDS.has(project.status) ? (project.status as StatusKind) : null;
}

export interface MergedStatus {
  /** the pill's words: the lead's call, else "No update" */
  label: string;
  tone: Tone;
  lead: StatusKind | null;
  kanbo: HealthKind | null;
  /** the pill reads better than the work: the lead's call is rosier, or nothing's been said while Kanbo sees trouble */
  mismatch: boolean;
  /** Kanbo's read's tone (the mismatch mark) */
  kanboTone: Tone;
  /** "Lead says On track" · "No update yet" · "Set by hand: On hold" */
  says: string;
  /** "Kanbo sees 4 overdue and 2 blocked" */
  sees: string;
  /** sorts mismatches first, then the worse off */
  rank: number;
}

/** The lead's call and Kanbo's read as one pill (see the file note). */
export function mergedStatus(project: Pick<Project, "status">, latest: Pick<StatusUpdate, "status"> | undefined, read: KanboRead): MergedStatus {
  const lead = leadCall(project, latest);
  const kanbo = read.health;
  // (nobody's said anything: the pill says so, and trouble in the work still gets the mark)
  const mismatch = lead ? rosier(lead, kanbo) : !!kanbo && BADNESS[kanbo] > 0;
  const fromHand = !!lead && (project.status === "on_hold" || !latest);
  const label = lead ? STATUS_WORDS[lead] : "No update";
  const tone: Tone = lead ? STATUS_TONES[lead] : "neutral";
  const says = !lead ? "No update yet" : fromHand ? `Set by hand: ${STATUS_WORDS[lead]}` : `Lead says ${STATUS_WORDS[lead]}`;
  const worst = Math.max(lead && lead !== "on_hold" ? BADNESS[lead] : 0, kanbo ? BADNESS[kanbo] : 0);
  return {
    label, tone, lead, kanbo, mismatch,
    kanboTone: kanbo ? HEALTH_TONES[kanbo] : "neutral",
    says, sees: kanboSees(read),
    rank: (mismatch ? 0 : 10) + (2 - worst),
  };
}

/** A roll-up's counts, from the pills its rows wear: how many say Off track, At risk and On hold, how many
 *  have no update, and how many Kanbo marks (the pill reads better than the work). */
export function pillCounts(rows: readonly { status: MergedStatus }[]): { off: number; risk: number; hold: number; none: number; marked: number } {
  const n = (f: (m: MergedStatus) => boolean) => rows.filter((r) => f(r.status)).length;
  return {
    off: n((m) => m.lead === "off_track"), risk: n((m) => m.lead === "at_risk"), hold: n((m) => m.lead === "on_hold"),
    none: n((m) => !m.lead), marked: n((m) => m.mismatch),
  };
}
