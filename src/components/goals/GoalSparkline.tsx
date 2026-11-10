/* ============================================================
   KANBO — a goal's check-ins against its pace line: one small chart
   in the goal panel. The pace line (dashed) runs from the start of the
   goal's window to its end, the way its pace mode says (steady or
   back-loaded); each check-in is a point at the % it put the goal at;
   today is a quiet vertical line, and where the goal stands now ends
   the line. Hover a point for its value and when. The check-in history
   under it is the same data as a list.
   ============================================================ */
import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Goal, GoalCheckin } from "../../data/types";
import { goalValuePct } from "../../lib/goalProgress";
import { paceCurve, paceWindow } from "../../lib/goalPace";
import { fmtGoalValue, daysAgo } from "./GoalParts";
import "./goals.css";

const W = 400, H = 104;
const PAD = { left: 4, right: 44, top: 14, bottom: 20 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY = 86_400_000;
const pad2 = (n: number) => String(n).padStart(2, "0");
const localIso = (d: Date) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayNo = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split("-").map(Number); return Date.UTC(y, m - 1, d) / DAY; };
const shortDay = (iso: string) => { const [, m, d] = iso.slice(0, 10).split("-").map(Number); return `${d} ${MONTHS[m - 1]}`; };

interface Point { x: number; y: number; pct: number; label: string; when: string; now?: boolean }

export function GoalSparkline({ goal, checkins, pct, today }: {
  goal: Goal;
  /** this goal's, newest first */
  checkins: GoalCheckin[];
  /** where the goal stands now, 0–100 */
  pct: number;
  today: Date;
}) {
  const [hot, setHot] = useState<number | null>(null);
  const win = paceWindow(goal);
  // pace off: the check-ins still draw over the goal's window, with no line to hold them to
  const paced = goal.pace !== "off";
  const mode = goal.pace === "backloaded" ? "backloaded" : "linear";
  const model = useMemo(() => {
    if (!win) return null;
    const s = dayNo(win.start), e = dayNo(win.end), t = dayNo(localIso(today));
    const span = Math.max(1, e - s);
    const iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
    const xOf = (day: number) => PAD.left + (Math.max(0, Math.min(span, day - s)) / span) * iw;
    const yOf = (p: number) => PAD.top + (1 - Math.max(0, Math.min(100, p)) / 100) * ih;
    // the pace line: 24 steps along its curve (a straight line when steady)
    const steps = mode === "backloaded" ? 24 : 1;
    const pace = Array.from({ length: steps + 1 }, (_, i) => `${i ? "L" : "M"}${xOf(s + (span * i) / steps).toFixed(1)},${yOf(paceCurve(mode, i / steps) * 100).toFixed(1)}`).join(" ");
    // oldest first; a check-in from before the window sits at its start
    const pts: Point[] = [...checkins].reverse().map((c) => {
      const p = Math.round(goalValuePct({ ...goal, current: c.value }));
      return { x: xOf(dayNo(localIso(new Date(c.createdAt)))), y: yOf(p), pct: p, label: fmtGoalValue(c.value, goal.unit), when: daysAgo(c.createdAt, today) };
    });
    // where it stands today ends the line (a goal read from a project or key results has only this)
    const last = checkins[0];
    if (!last || localIso(new Date(last.createdAt)) !== localIso(today) || Math.round(pct) !== pts[pts.length - 1]?.pct) {
      if (t >= s) pts.push({ x: xOf(t), y: yOf(pct), pct: Math.round(pct), label: `${Math.round(pct)}%`, when: "now", now: true });
    }
    const expected = Math.round(paceCurve(mode, (t - s) / span) * 100);
    return { pace, pts, todayX: t >= s && t <= e ? xOf(t) : null, expected, xOf, yOf, start: win.start, end: win.end };
  }, [win?.start, win?.end, mode, checkins, goal, pct, today]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!model) return null;
  const { pts } = model;
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
  const lastPt = pts[pts.length - 1];
  const from = `${checkins.length} ${checkins.length === 1 ? "check-in" : "check-ins"}`;
  const summary = paced ? `${goal.name}: ${Math.round(pct)}% now, ${model.expected}% expected by today on the pace line, from ${from}.` : `${goal.name}: ${Math.round(pct)}% now, from ${from}.`;
  const onMove = (e: ReactMouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (!r.width || !pts.length) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0;
    pts.forEach((p, i) => { if (Math.abs(p.x - x) < Math.abs(pts[best].x - x)) best = i; });
    setHot(best);
  };
  const tip = hot != null ? pts[hot] : null;
  return (
    <figure className="kgs">
      <svg className="kgs-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={summary} onMouseMove={onMove} onMouseLeave={() => setHot(null)}>
        <line className="kgs-grid" x1={PAD.left} x2={W - PAD.right} y1={model.yOf(0)} y2={model.yOf(0)} />
        <line className="kgs-grid" x1={PAD.left} x2={W - PAD.right} y1={model.yOf(100)} y2={model.yOf(100)} />
        {paced && <path className="kgs-pace" d={model.pace} />}
        {model.todayX != null && (
          <>
            <line className="kgs-today" x1={model.todayX} x2={model.todayX} y1={PAD.top - 6} y2={H - PAD.bottom} />
            <text className="kgs-label" x={model.todayX} y={PAD.top - 8} textAnchor="middle">Today</text>
          </>
        )}
        {pts.length > 1 && <path className="kgs-line" d={line} />}
        {pts.map((p, i) => <circle key={i} className="kgs-dot" cx={p.x} cy={p.y} r={4} data-hot={hot === i || undefined} />)}
        {lastPt && <text className="kgs-value" x={Math.min(lastPt.x + 8, W - 4)} y={lastPt.y + 4}>{lastPt.pct}%</text>}
        <text className="kgs-label" x={PAD.left} y={H - 4}>{shortDay(model.start)}</text>
        <text className="kgs-label" x={W - PAD.right} y={H - 4} textAnchor="end">{shortDay(model.end)}</text>
      </svg>
      {tip && (
        <span className="kgs-tip" role="presentation" style={{ left: `${(tip.x / W) * 100}%`, top: `${(tip.y / H) * 100}%` }}>
          {tip.now ? `${tip.pct}% today` : `${tip.label} · ${tip.pct}%`}<span>{tip.now ? (paced ? `${model.expected}% expected by now` : "Where it stands") : `Checked in ${tip.when}`}</span>
        </span>
      )}
      <figcaption className="kgs-legend">
        <span className="kgs-key"><i aria-hidden="true" />Check-ins</span>
        {paced && <span className="kgs-key" data-kind="pace"><i aria-hidden="true" />{mode === "backloaded" ? "Back-loaded pace" : "Steady pace"}: {model.expected}% by today</span>}
      </figcaption>
    </figure>
  );
}
