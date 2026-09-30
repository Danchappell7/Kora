/* ============================================================
   KANBO — the Daybeam: the shape of the whole day in one 10px bar.
   Meetings in quiet ink, planned work in its project's colour, Kanbo's
   suggestions as dashed accent, the past dimmed, and a gradient dot
   for now. Decorative for pointer users (each segment has a tooltip);
   one summary label for everyone else. While a task is dragged over
   it, the beam is a drop target too (Today's canvas does the maths:
   the bar carries its span in data attributes).
   ============================================================ */
import { projectPaint } from "../primitives";
import { DAY_START, DAY_END } from "../../data/data";
import { fmtDuration, fmtTime, fmtTimeRange } from "./planCanvas";

export interface BeamSegment {
  start: number;
  end: number;
  title: string;
  kind: "meeting" | "break" | "task" | "suggestion";
  /** a task's project colour (any CSS colour; painted at the identity lightness) */
  color?: string;
}

const COMPACT = { from: 8 * 60, to: 18 * 60 };

const BEAM_CSS = `
.kbeam { container-type: inline-size; min-width: 0; }
.kbeam-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
.kbeam-bar { position: relative; flex: 1; min-width: 96px; height: 16px; display: flex; align-items: center; }
.kbeam-track { position: relative; flex: 1; height: 10px; border-radius: 999px; overflow: hidden;
  background: var(--fill-1, color-mix(in oklch, var(--ink) 6%, transparent));
  transition: box-shadow var(--d-1, 90ms) var(--ease); }
.kbeam-seg { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 2px; }
.kbeam-seg[data-kind="meeting"] { background: color-mix(in oklch, var(--ink-3) 55%, transparent); }
.kbeam-seg[data-kind="break"] { background: color-mix(in oklch, var(--ink-3) 22%, transparent); }
.kbeam-seg[data-kind="suggestion"] { background: var(--accent-tint, var(--accent-dim));
  outline: 1px dashed var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent)); outline-offset: -1px; }
.kbeam-past { position: absolute; top: 0; bottom: 0; left: 0; background: var(--bg); opacity: 0.4; pointer-events: none; }
.kbeam-now { position: absolute; top: 0; width: 2px; height: 16px; margin-left: -1px; border-radius: 1px; background: var(--accent); pointer-events: none; }
.kbeam-now::after { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px 0 0 -3px; border-radius: 50%;
  background: var(--grad, linear-gradient(90deg, #5B7CFA, #8B5CF6 52%, #C24BE0)); box-shadow: 0 0 0 1.5px var(--bg); }
/* a task held over the beam: where it would land */
.kbeam[data-drop="true"] .kbeam-track { box-shadow: 0 0 0 1.5px var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent)); }
.kbeam-drop { position: absolute; top: 1px; bottom: 1px; z-index: 1; border-radius: 3px; pointer-events: none;
  background: var(--accent); box-shadow: 0 0 0 1.5px var(--bg); }
/* the figures are data (mono); the words around them stay in the sentence's font */
.kbeam-cap { flex-shrink: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.kbeam-cap b { font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); }
/* short of room: the bar takes the row, its two figures sit under either end */
@container (max-width: 400px) {
  .kbeam-row { flex-wrap: wrap; row-gap: 6px; justify-content: space-between; }
  .kbeam-bar { order: -1; flex: 1 1 100%; }
}
@media (prefers-reduced-motion: reduce) { .kbeam-track { transition: none; } }
`;

/** One summary sentence for assistive tech. */
function summary(segs: BeamSegment[], from: number, to: number, nowMin: number, planned: number, free: number): string {
  const n = (k: BeamSegment["kind"]) => segs.filter((s) => s.kind === k).length;
  const bits = [planned > 0 ? `${fmtDuration(planned)} planned` : "nothing planned yet", free > 0 ? `${fmtDuration(free)} free` : "no free time left"];
  const m = n("meeting"), g = n("suggestion");
  if (m) bits.push(`${m} meeting${m === 1 ? "" : "s"}`);
  if (g) bits.push(`${g} suggestion${g === 1 ? "" : "s"}`);
  const now = nowMin >= from && nowMin <= to ? `. Now ${fmtTime(nowMin)}` : "";
  return `Your day, ${fmtTime(from)} to ${fmtTime(to)}: ${bits.join(", ")}${now}.`;
}

export function Daybeam({ segments, nowMin, planned, free, compact, caption = true, drop }: {
  segments: BeamSegment[];
  nowMin: number;
  /** minutes planned / free, for the caption ("1h 30m planned · 3h 55m free") */
  planned: number;
  free: number;
  /** the working day (08:00–18:00) instead of the whole canvas (DAY_START–DAY_END) */
  compact?: boolean;
  caption?: boolean;
  /** a task held over the beam: the slot it would land in */
  drop?: { start: number; end: number } | null;
}) {
  const from = compact ? COMPACT.from : DAY_START;
  const to = compact ? COMPACT.to : DAY_END;
  const span = to - from;
  const pct = (m: number) => `${((Math.min(to, Math.max(from, m)) - from) / span) * 100}%`;
  const visible = segments
    .filter((s) => s.end > from && s.start < to && s.end > s.start)
    // meetings under planned work under suggestions, so the loudest thing wins where they touch
    .sort((a, b) => order[a.kind] - order[b.kind] || a.start - b.start);
  const nowIn = nowMin > from && nowMin < to;
  return (
    <div className="kbeam" data-drop={drop ? true : undefined}>
      <style>{BEAM_CSS}</style>
      <div className="kbeam-row">
        {caption && (
          <span className="kbeam-cap" aria-hidden="true">
            {planned > 0 ? <><b>{fmtDuration(planned)}</b> planned</> : "Nothing planned"}
          </span>
        )}
        <div className="kbeam-bar" role="img" aria-label={summary(segments, from, to, nowMin, planned, free)}
          data-daybeam="" data-from={from} data-to={to}>
          <div className="kbeam-track">
            {visible.map((s, i) => (
              <span key={`${s.kind}-${s.start}-${i}`} className="kbeam-seg" data-kind={s.kind}
                title={`${fmtTimeRange(s.start, s.end)} · ${s.title}${s.kind === "suggestion" ? " (suggested)" : ""}`}
                style={{
                  left: pct(s.start),
                  // a hair of daylight between neighbouring blocks
                  width: `calc(${pct(s.end)} - ${pct(s.start)} - 1px)`,
                  ...(s.kind === "task" ? { background: projectPaint(s.color ?? "").solid } : null),
                }} />
            ))}
            {nowMin > from && <span className="kbeam-past" style={{ width: pct(nowMin) }} />}
          </div>
          {drop && (
            <span className="kbeam-drop" aria-hidden="true"
              style={{ left: pct(drop.start), width: `max(4px, calc(${pct(drop.end)} - ${pct(drop.start)}))` }} />
          )}
          {nowIn && <span className="kbeam-now" style={{ left: pct(nowMin) }} />}
        </div>
        {caption && (
          <span className="kbeam-cap" aria-hidden="true">
            {free > 0 ? <><b>{fmtDuration(free)}</b> free</> : "No free time left"}
          </span>
        )}
      </div>
    </div>
  );
}

const order: Record<BeamSegment["kind"], number> = { break: 0, meeting: 1, task: 2, suggestion: 3 };
