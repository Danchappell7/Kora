/* ============================================================
   KANBO — the business's goals in the Team place (Pulse, under the
   Radar): this quarter's company goals (and any still open from
   before it), the ones behind pace first, each opening the goal
   panel, with a sentence about the same goals the card lists. "All
   goals" goes to Projects › Goals.
   ============================================================ */
import type { MouseEvent as ReactMouseEvent } from "react";
import { Meter, ProjectTile } from "../primitives";
import type { Goal } from "../../data/types";
import { goalsInQuarter, goalsSummary, type GoalRead } from "../../lib/goalFlow";
import { periodRange, quarterOf } from "../../lib/goalPeriods";
import { pathOf } from "../../lib/nav";
import { goalTile } from "./GoalParts";
import "./goals.css";

const SHOW = 5;

export function TeamGoals({ goals, reads, today, onOpenGoal, onOpenGoals }: {
  /** the workspace's goals you can see */
  goals: Goal[];
  reads: Map<string, GoalRead>;
  today: Date;
  onOpenGoal: (id: string) => void;
  onOpenGoals: () => void;
}) {
  const q = periodRange(quarterOf(today))!;
  const live = goalsInQuarter(goals.filter((g) => !g.archivedAt), reads, q, today);
  if (!live.length) return null;
  const top = live.filter((g) => !g.parentId || !live.some((p) => p.id === g.parentId));
  const rows = top.map((g) => reads.get(g.id)).filter((r): r is GoalRead => !!r)
    .sort((a, b) => Number(b.standing === "behind") - Number(a.standing === "behind") || (a.pace?.gap ?? 0) - (b.pace?.gap ?? 0));
  // (the sentence counts what the card lists: "2 of 3 goals on pace" over three rows, not six)
  const summary = goalsSummary(rows);
  const toAll = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault(); onOpenGoals();
  };
  return (
    <section className="kgt" aria-label="Goals this quarter">
      <h2 className="kgt-head">Goals this quarter<a href={pathOf({ view: "goals" })} onClick={toAll}>All goals</a></h2>
      <p className="kgt-sum">{summary.plain}</p>
      <ul className="kgt-list">
        {rows.slice(0, SHOW).map((r) => (
          <li key={r.goal.id} className="kgt-row">
            <ProjectTile project={goalTile(r.goal)} size={20} />
            <span style={{ minWidth: 0 }}>
              <button type="button" className="kgt-open" onClick={() => onOpenGoal(r.goal.id)}>{r.goal.name}</button>
              {r.pace && <span className="kgt-say" data-state={r.pace.state}>{r.pace.line}</span>}
            </span>
            <Meter value={r.pct} height={4} tone={r.standing === "behind" ? "warn" : "accent"} marker={r.pace && r.pace.state !== "early" ? r.pace.expected : undefined} label={`${r.goal.name} progress`} />
          </li>
        ))}
      </ul>
    </section>
  );
}
