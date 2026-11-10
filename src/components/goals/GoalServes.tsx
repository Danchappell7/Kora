/* ============================================================
   KANBO — "Serves: Q4 · Grow weekly actives to 5,000": the goal a
   project or task moves, as a chip on the project header, the
   project directory (cards and table) and the task panel. One chip,
   then "+1" for the rest (their names on hover), so a header never
   fills up with goals; the task panel lists them all. A chip wears
   the goal's identity and a pip for its pace, and opens the goal.
   ============================================================ */
import type { MouseEvent as ReactMouseEvent } from "react";
import { ProjectTile } from "../primitives";
import type { Goal } from "../../data/types";
import { servesLabel, type GoalRead } from "../../lib/goalFlow";
import { goalTile } from "./GoalParts";
import "./goals.css";

function Chip({ goal, read, today, onOpen, compact = false }: { goal: Goal; read?: GoalRead; today: Date; onOpen: (id: string) => void; compact?: boolean }) {
  const label = servesLabel(goal, today);
  const pace = read?.pace?.line;
  const click = (e: ReactMouseEvent<HTMLButtonElement>) => { e.stopPropagation(); e.preventDefault(); onOpen(goal.id); };
  return (
    <button type="button" className="kgf-chip" data-state={read?.pace?.state} data-compact={compact || undefined} onClick={click}
      aria-label={`Serves ${label}${pace ? `, ${pace.toLowerCase()}` : ""}. Open the goal`} title={pace ? `${goal.name}: ${pace}` : goal.name}>
      <ProjectTile project={goalTile(goal)} size={16} />
      {!compact && <span className="kgf-chip-text">{label}</span>}
      <span className="kgf-pip" data-none={!read?.pace || undefined} aria-hidden="true" />
    </button>
  );
}

/** The project header's, a directory card's and a table row's: "Serves" and one chip (+n). */
export function GoalServes({ goals, reads, today, onOpen, lead = true, compact = false }: {
  goals: Goal[];
  reads: Map<string, GoalRead>;
  today: Date;
  onOpen: (id: string) => void;
  /** say "Serves" before the chip (default) */
  lead?: boolean;
  /** a phone's project header: the goal's tile and pace pip only (its name on hover, and to a screen reader) */
  compact?: boolean;
}) {
  if (!goals.length) return null;
  const [first, ...rest] = goals;
  return (
    <span className="kgf-serves">
      {lead && !compact && <span className="kgf-lead">Serves</span>}
      <Chip goal={first} read={reads.get(first.id)} today={today} onOpen={onOpen} compact={compact} />
      {rest.length > 0 && <span className="kgf-more" title={rest.map((g) => g.name).join(", ")} aria-label={`and ${rest.length} more: ${rest.map((g) => g.name).join(", ")}`}>+{rest.length}</span>}
    </span>
  );
}

/** The task panel's row: "Serves" and every goal the task moves (its own, then its project's). */
export function GoalServesRow({ goals, reads, today, onOpen }: { goals: Goal[]; reads: Map<string, GoalRead>; today: Date; onOpen: (id: string) => void }) {
  if (!goals.length) return null;
  return (
    <div className="ktd-prop">
      <dt>Serves</dt>
      <dd>
        <span className="kgf-list">
          {goals.map((g) => <Chip key={g.id} goal={g} read={reads.get(g.id)} today={today} onOpen={onOpen} />)}
        </span>
      </dd>
    </div>
  );
}
