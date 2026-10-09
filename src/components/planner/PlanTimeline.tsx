/* ============================================================
   KANBO — the planner's mini timeline: one lane per section, each task
   a bar in the project's colour (packed into as few rows as fit), the
   milestones as diamonds, Monday ticks, and the deadline as a line.
   Bars that run past the deadline read in the signal colour. It's a
   preview: the list under it is the thing you edit (and what assistive
   tech reads), so the figure is one image with a summary for a name.
   Clicking a bar takes you to its row.
   ============================================================ */
import type { CSSProperties } from "react";
import { projectIdentity, spectrumColor } from "../primitives";
import { addWorkingDays, planDayLabel, planTimeline } from "../../lib/projectPlanner";
import type { PlanDraft } from "../../data/types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function PlanTimeline({ draft, onPick }: { draft: PlanDraft; onPick?: (taskKey: string) => void }) {
  const tl = planTimeline(draft);
  if (!tl.lanes.length) return null;
  const titleOf = new Map(draft.tasks.map((t) => [t.key, t.title]));
  const pct = (day: number) => `${(day / tl.days) * 100}%`;
  const id = projectIdentity({ id: "plan-preview", color: spectrumColor(draft.hue) });
  const end = addWorkingDays(draft.startDate, tl.end);
  const late = tl.lanes.reduce((n, l) => n + l.bars.filter((b) => b.late).length, 0);
  const summary = [
    `Timeline: ${plural(tl.lanes.length, "section")} from ${planDayLabel(draft.startDate)} to ${planDayLabel(end)}`,
    draft.deadline ? `deadline ${planDayLabel(draft.deadline)}` : null,
    late ? `${plural(late, "task")} after the deadline` : null,
  ].filter(Boolean).join("; ") + ".";

  return (
    <figure className="kpl-tl kp" style={id.style as CSSProperties} role="img" aria-label={summary}>
      <div className="kpl-tl-grid" aria-hidden="true">
        <div className="kpl-tl-scale">
          {tl.ticks.map((t) => (
            <span key={t.day} className="kpl-tl-tick" style={{ left: pct(t.day) }}>{t.label}</span>
          ))}
          {tl.deadline != null && (
            <span className="kpl-tl-dlabel" style={{ left: pct(tl.deadline + 1) }}>Deadline</span>
          )}
        </div>
        {tl.lanes.map((lane) => (
          <div key={lane.key} className="kpl-tl-lane">
            <span className="kpl-tl-name">{lane.name}</span>
            <div className="kpl-tl-track" style={{ "--rows": lane.rows } as CSSProperties}>
              {tl.ticks.filter((t) => t.day > 0).map((t) => <span key={t.day} className="kpl-tl-rule" style={{ left: pct(t.day) }} />)}
              {lane.bars.map((b) => {
                const label = `${titleOf.get(b.key) ?? ""} · ${planDayLabel(addWorkingDays(draft.startDate, b.start))}${b.due !== b.start ? ` – ${planDayLabel(addWorkingDays(draft.startDate, b.due))}` : ""}`;
                const style: CSSProperties = b.milestone
                  ? { left: `calc(${pct(b.due + 0.5)} - 5px)`, top: `calc(${b.row} * var(--kpl-tl-row) + 2px)` }
                  : { left: pct(b.start), width: `max(4px, calc(${pct(b.due - b.start + 1)} - 2px))`, top: `calc(${b.row} * var(--kpl-tl-row) + 3px)` };
                return (
                  <span key={b.key} className={b.milestone ? "kpl-tl-ms" : "kpl-tl-bar"} data-late={b.late || undefined} title={label} style={style}
                    onClick={onPick ? () => onPick(b.key) : undefined} />
                );
              })}
              {tl.deadline != null && <span className="kpl-tl-dline" style={{ left: pct(tl.deadline + 1) }} />}
            </div>
          </div>
        ))}
      </div>
    </figure>
  );
}
