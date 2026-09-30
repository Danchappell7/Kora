/* ============================================================
   KANBO — Radar: the ranked risks across a team's work (blocked
   chains, slipping dates, stale work, overloaded people).
   W0 stub: computeRisks finds nothing yet; P08 fills it in.
   ============================================================ */
import type { Task, WorkspaceEvent } from "../data/types";

export type RiskKind = "blocked" | "blocker_late" | "slipping" | "stale" | "unassigned_due" | "over_capacity" | "milestone_at_risk";

/** A one-click fix offered on a risk. */
export interface RiskFix {
  kind: "nudge" | "open" | "rebalance" | "firm_date" | "assign" | "check_in";
  label: string;
}

export interface Risk {
  id: string;
  kind: RiskKind;
  severity: "signal" | "warn" | "neutral";
  title: string;
  reason: string;
  taskIds: string[];
  memberId?: string;
  projectId?: string;
  fixes: RiskFix[];
}

/** Every risk, most severe first. `projectId` narrows it to one project;
 *  `capacities` are weekly hours per person (default 40). */
export function computeRisks(_input: {
  tasks: Task[];
  events?: WorkspaceEvent[];
  members: { id: string; name: string }[];
  capacities?: Record<string, number>;
  today?: string;
  projectId?: string;
}): Risk[] {
  return [];
}
