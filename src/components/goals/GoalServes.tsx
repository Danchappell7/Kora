/* ============================================================
   KANBO — "Serves: Q4 · Grow weekly actives to 5,000": the goal a
   project or task moves, as a chip on the project header, the
   project directory (cards and table) and the task panel. One chip,
   then "+1" for the rest (a little menu of them, by tap or key), so a
   header never fills up with goals; the task panel lists them all. A
   chip wears the goal's identity and a pip for its pace, and opens
   the goal.
   ============================================================ */
import { useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ProjectTile } from "../primitives";
import { Popover } from "../primitives/Popover";
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
      {rest.length > 0 && <MoreGoals goals={rest} today={today} onOpen={onOpen} />}
    </span>
  );
}

/** "+2": the other goals, in a little menu (inside a clickable card, so its clicks stay its own). */
function MoreGoals({ goals, today, onOpen }: { goals: Goal[]; today: Date; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const names = goals.map((g) => g.name).join(", ");
  const stop = (e: ReactMouseEvent) => { e.stopPropagation(); e.preventDefault(); };
  return (
    <>
      <button ref={ref} type="button" className="kgf-more" aria-haspopup="menu" aria-expanded={open} title={names}
        aria-label={`${goals.length} more ${goals.length === 1 ? "goal" : "goals"}: ${names}`} onClick={(e) => { stop(e); setOpen((v) => !v); }}>+{goals.length}</button>
      <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} role="menu" label="More goals it serves" minWidth={220}
        className="kpj-pop" style={{ borderRadius: "var(--r-lg, 12px)", border: "none", background: "var(--surface-raised)", boxShadow: "var(--e2, 0 0 0 1px var(--hairline), var(--shadow-lg))", padding: 4 }}>
        {goals.map((g) => (
          <button key={g.id} type="button" role="menuitem" className="kpj-menu-item" onClick={(e) => { stop(e); setOpen(false); onOpen(g.id); }}>
            <ProjectTile project={goalTile(g)} size={16} />{servesLabel(g, today)}
          </button>
        ))}
      </Popover>
    </>
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
