/* ============================================================
   KANBO — lightweight charts (Paper & Navy).
   Bars · GroupedBars · LineChart · BarList · StackedBar · ChartLegend ·
   Sparkline · Ring · Heatmap

   The chart rules (brief §2.5):
   - data bars are filled and quiet (--ink-3); the current period is --accent;
   - the Done series and the burn-up line carry the brand gradient, drawn with
     an SVG / CSS gradient whose SVG id comes from useId (never Math.random);
   - an empty period shows as a track, never as a hollow pill;
   - gridlines are hairlines, axes are mono 11 in --ink-4;
   - tooltips look like menus (raised surface, hairline, e2).
   Everything reads new tokens with a fallback to today's, and nothing moves
   under prefers-reduced-motion.
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

/* ---------------- shared bits ---------------- */

/** The brand stops, for SVG gradients (the Done series, the burn-up line). */
const GRAD_STOPS: [string, string][] = [["0", "#5B7CFA"], ["0.52", "#8B5CF6"], ["1", "#C24BE0"]];
/** A bar's Done fill: blue at the baseline climbing to magenta at the top of the
 *  plot. Sized to the plot (not the bar), so a tall week reaches further up the
 *  gradient than a short one: the colour itself says "more momentum". */
const GRAD_UP = "linear-gradient(0deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)";
export const CHART_GRAD = "var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%))";
const INK = "var(--ink-3)";
const TRACK = "var(--track, var(--surface-2))";

const AXIS: CSSProperties = {
  font: "500 11px/16px var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--ink-4)", whiteSpace: "nowrap",
};
const svgText = { fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 500, fill: "var(--ink-4)" } as const;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
/** useId output made safe for url(#…) references */
const useSvgId = (prefix: string) => prefix + useId().replace(/[^a-zA-Z0-9_-]/g, "");

/* Charts grow in on mount (bars rise, lines draw) over 240ms. Flips on a short
   timer (not rAF) so it still resolves in a background tab — a chart is never
   left stuck at zero — and starts grown under reduced motion. */
function useGrow(): boolean {
  const [grown, setGrown] = useState(reducedMotion);
  useEffect(() => {
    if (grown) return;
    const t = window.setTimeout(() => setGrown(true), 30);
    return () => window.clearTimeout(t);
  }, [grown]);
  return grown;
}
const growTransition = (prop: string, delayMs = 0) => `${prop} var(--d-3, 240ms) var(--ease) ${delayMs}ms`;

/** The rendered width of an element (SVG charts draw at real pixels, so their
 *  mono axis labels are 11px at any card width instead of being stretched). */
function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => { const cw = el.clientWidth; if (cw > 0) setW(cw); };
    read();
    if (typeof ResizeObserver !== "function") return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/** A round axis top for counts: `ticks` equal steps, each a whole, "nice"
 *  number (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × 10ⁿ), so every gridline lands on a
 *  true label and the tallest bar fills most of the plot. */
export function niceMax(v: number, ticks = 2): number {
  const raw = Math.max(v, 1) / ticks;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].map((m) => m * mag)
    .filter((s) => Number.isInteger(s)).find((s) => s >= raw - 1e-9) ?? 10 * mag;
  return Math.max(1, step) * ticks;
}

/** Every how-many x labels to show so none collide: a mono 11 label is about
 *  6.7px a character plus breathing room. The newest (last) label always shows. */
function labelStep(labels: string[], spacing: number): number {
  const widest = Math.max(1, ...labels.map((l) => l.length)) * 6.7 + 10;
  return spacing > 0 ? Math.max(1, Math.ceil(widest / spacing)) : 1;
}
const showLabel = (i: number, n: number, step: number) => (n - 1 - i) % step === 0;

/** A menu-style tooltip, placed over a chart at `x` (px from the chart's left). */
function ChartTip({ x, width, top = 0, children }: { x: number; width: number; top?: number; children: ReactNode }) {
  // keep it inside the chart: anchor left near the start, right near the end
  const shift = x < width * 0.2 ? "0%" : x > width * 0.8 ? "-100%" : "-50%";
  return (
    <div role="presentation" style={{
      position: "absolute", left: x, top, transform: `translate(${shift}, calc(-100% - 8px))`, zIndex: 2, pointerEvents: "none",
      minWidth: 120, maxWidth: 240, padding: "8px 10px", borderRadius: "var(--r-md, 8px)",
      background: "var(--surface-raised)", boxShadow: "var(--e2, 0 0 0 1px var(--hairline-strong), var(--shadow-lg))",
      font: "500 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink)", whiteSpace: "nowrap",
    }}>
      {children}
    </div>
  );
}
/** One line inside a tooltip: swatch · label · value. */
function TipRow({ swatch, label, value }: { swatch?: string; label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
      {swatch && <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: swatch, flexShrink: 0 }} />}
      <span style={{ color: "var(--ink-3)" }}>{label}</span>
      <span style={{ marginLeft: "auto", paddingLeft: 12, font: "600 12px/16px var(--font-mono)", fontVariantNumeric: "tabular-nums" }}>{value}</span>
    </div>
  );
}
const tipTitle: CSSProperties = { ...AXIS, color: "var(--ink-3)" };

/** A chart legend: short swatches (bars) or strokes (lines), 12px labels. */
export function ChartLegend({ items }: { items: { label: string; color: string; shape?: "bar" | "line" }[] }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", flexWrap: "wrap", gap: "4px 16px", marginTop: 12 }}>
      {items.map((it) => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, font: "500 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink-3)" }}>
          <span style={it.shape === "line"
            ? { width: 14, height: 2, borderRadius: 1, background: it.color }
            : { width: 8, height: 8, borderRadius: 2, background: it.color }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ---------------- Bars: one series, one column per period ---------------- */

export interface BarDatum {
  label: string;
  value: number;
  /** the current period: drawn in the accent */
  highlight?: boolean;
  /** the period in full for the tooltip and screen readers, e.g. "Wed 30 Sep" */
  title?: string;
}

/** Columns on a faint full-height track (so an empty day reads as a track, not
 *  a gap), quiet ink fills, the current period in the accent, values on top. */
export function Bars({ data, h = 130, color = "var(--accent)", label, unit = "" }: {
  data: BarDatum[];
  h?: number;
  /** the highlighted (current) period's colour */
  color?: string;
  /** the chart's accessible name, e.g. "Completed per day, last 7 days" */
  label?: string;
  /** what a value counts, for the tooltip ("completed") */
  unit?: string;
}) {
  const grown = useGrow();
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>(360);
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length || 1;
  const gap = 8;
  const colW = (width - gap * (n - 1)) / n;
  const summary = data.map((d) => `${d.title ?? d.label} ${d.value}`).join(", ");
  const step = labelStep(data.map((d) => d.label), colW + gap);
  return (
    <div ref={ref} role="img" aria-label={label ? `${label}: ${summary}` : summary} style={{ position: "relative" }}
      onMouseLeave={() => setHover(null)}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, columnGap: gap, height: h }}>
        {data.map((d, i) => {
          const pct = (d.value / max) * 100;
          const on = hover === i;
          return (
            <div key={i} onMouseEnter={() => setHover(i)}
              style={{ display: "flex", justifyContent: "center", minWidth: 0, paddingTop: 20 }}>
              <div style={{
                position: "relative", width: "100%", maxWidth: 28, borderRadius: "var(--r-sm, 6px)",
                background: on ? "var(--fill-2)" : "var(--fill-1)", transition: "background var(--d-1, 90ms) var(--ease)",
              }}>
                <div style={{
                  position: "absolute", left: 0, right: 0, bottom: 0, borderRadius: "var(--r-sm, 6px)",
                  height: grown && d.value > 0 ? `max(${pct}%, 4px)` : 0,
                  background: d.highlight ? color : INK, transition: growTransition("height", i * 30),
                }} />
                {d.value > 0 && (
                  <span style={{
                    ...AXIS, position: "absolute", left: "50%", bottom: `calc(${grown ? pct : 0}% + 4px)`, transform: "translateX(-50%)",
                    color: d.highlight ? "var(--accent-text, var(--accent))" : "var(--ink-3)", transition: growTransition("bottom", i * 30),
                  }}>{d.value}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, columnGap: gap, marginTop: 8 }}>
        {data.map((d, i) => (
          <span key={i} style={{ ...AXIS, textAlign: "center", overflow: "visible", visibility: showLabel(i, n, step) ? undefined : "hidden", color: d.highlight ? "var(--accent-text, var(--accent))" : AXIS.color, fontWeight: d.highlight ? 600 : 500 }}>
            {d.label}
          </span>
        ))}
      </div>
      {hover != null && data[hover] && (
        <ChartTip x={hover * (colW + gap) + colW / 2} width={width} top={20 + (h - 20) * (1 - data[hover].value / max)}>
          <div style={tipTitle}>{data[hover].title ?? data[hover].label}</div>
          <TipRow label={unit ? unit[0].toUpperCase() + unit.slice(1) : "Value"} value={data[hover].value} swatch={data[hover].highlight ? color : INK} />
        </ChartTip>
      )}
    </div>
  );
}

/* ---------------- GroupedBars: two or more series per period ---------------- */

export interface BarSeries {
  label: string;
  /** a CSS colour; ignored when `grad` is set */
  color: string;
  values: number[];
  /** the Done series: the brand gradient, climbing with the value */
  grad?: boolean;
}

/** Side-by-side bars per period over hairline gridlines and a mono y axis. An
 *  empty value is a 2px track at the baseline. `current` (an index) gets a faint
 *  band and an accent label. */
export function GroupedBars({ groups, series, h = 150, current, label, titles }: {
  groups: string[];
  series: BarSeries[];
  h?: number;
  current?: number;
  /** the chart's accessible name */
  label?: string;
  /** each period in full, for the tooltip ("Week of 21 Sep") */
  titles?: string[];
}) {
  const grown = useGrow();
  const [hover, setHover] = useState<number | null>(null);
  const [ref, width] = useWidth<HTMLDivElement>(480);
  const top = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const ticks = [0, top / 2, top];
  const axisW = 28;
  const n = groups.length || 1;
  const plotW = Math.max(0, width - axisW);
  const colW = plotW / n;
  const step = labelStep(groups, colW);
  const barW = Math.max(4, Math.min(12, (colW - 12) / series.length - 3));
  const fill = (s: BarSeries) => (s.grad ? GRAD_UP : s.color);
  const summary = groups.map((g, i) => `${titles?.[i] ?? g}: ${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join(", ")}`).join("; ");
  return (
    <div>
      <div ref={ref} role="img" aria-label={label ? `${label}. ${summary}` : summary} style={{ position: "relative", height: h }}
        onMouseLeave={() => setHover(null)}>
        {/* gridlines + y axis */}
        {ticks.map((v, i) => (
          <div key={i} aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: `${(v / top) * 100}%`, display: "flex", alignItems: "center", pointerEvents: "none" }}>
            <span style={{ ...AXIS, width: axisW - 6, textAlign: "right", transform: "translateY(50%)", marginRight: 6 }}>{v}</span>
            <span style={{ flex: 1, height: 1, background: i === 0 ? "var(--hairline-strong)" : "var(--hairline)" }} />
          </div>
        ))}
        <div style={{ position: "absolute", left: axisW, right: 0, top: 0, bottom: 0, display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
          {groups.map((g, gi) => (
            <div key={gi} onMouseEnter={() => setHover(gi)}
              style={{
                position: "relative", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 3,
                borderRadius: "var(--r-sm, 6px)",
                background: hover === gi ? "var(--fill-1)" : gi === current ? "color-mix(in oklch, var(--fill-1) 60%, transparent)" : "transparent",
                transition: "background var(--d-1, 90ms) var(--ease)",
              }}>
              {series.map((s) => {
                const v = s.values[gi] ?? 0;
                const pct = (v / top) * 100;
                return (
                  <div key={s.label} style={{
                    width: barW, flexShrink: 0, borderRadius: "3px 3px 1px 1px",
                    height: v > 0 ? (grown ? `max(${pct}%, 3px)` : 0) : 2,
                    background: v > 0 ? fill(s) : TRACK,
                    backgroundSize: s.grad ? `100% ${h}px` : undefined, backgroundPosition: s.grad ? "bottom" : undefined,
                    transition: growTransition("height", gi * 24),
                  }} />
                );
              })}
            </div>
          ))}
        </div>
        {hover != null && (
          <ChartTip x={axisW + hover * colW + colW / 2} width={width} top={Math.max(0, h * (1 - Math.max(...series.map((s) => s.values[hover] ?? 0)) / top))}>
            <div style={tipTitle}>{titles?.[hover] ?? groups[hover]}</div>
            {series.map((s) => <TipRow key={s.label} swatch={s.grad ? CHART_GRAD : s.color} label={s.label} value={s.values[hover] ?? 0} />)}
          </ChartTip>
        )}
      </div>
      <div aria-hidden="true" style={{ display: "grid", gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))`, marginLeft: axisW, marginTop: 8 }}>
        {groups.map((g, i) => (
          <span key={i} style={{
            ...AXIS, textAlign: "center", overflow: "visible",
            color: i === current ? "var(--accent-text, var(--accent))" : AXIS.color, fontWeight: i === current ? 600 : 500,
            visibility: showLabel(i, n, step) ? undefined : "hidden",
          }}>{g}</span>
        ))}
      </div>
      <ChartLegend items={series.map((s) => ({ label: s.label, color: s.grad ? CHART_GRAD : s.color }))} />
    </div>
  );
}

/* ---------------- LineChart: trends over time ---------------- */

export interface LineSeries {
  label: string;
  /** a CSS colour; ignored when `grad` is set */
  color: string;
  values: number[];
  /** the Done / burn-up line: the brand gradient left to right, with a soft area under it */
  grad?: boolean;
  /** a faint fill under the line */
  area?: boolean;
}

/** Multi-series lines over hairline gridlines, drawn at real pixel width (so
 *  labels are true 11px), with a hover crosshair and a menu-style tooltip. */
export function LineChart({ series, labels, h = 170, yMax, label, titles, current }: {
  series: LineSeries[];
  labels: string[];
  h?: number;
  yMax?: number;
  /** the chart's accessible name */
  label?: string;
  /** each point in full, for the tooltip */
  titles?: string[];
  /** index of the current (partial) period: its label is in the accent */
  current?: number;
}) {
  const grown = useGrow();
  const gid = useSvgId("klg");
  const [ref, w] = useWidth<HTMLDivElement>(560);
  const [hover, setHover] = useState<number | null>(null);
  // the plot is inset by half a date label each side, so every x label centres on its point
  const padL = 44, padR = 22, padT = 12, padB = 24;
  const n = labels.length;
  const top = niceMax(Math.max(yMax ?? 0, ...series.flatMap((s) => s.values), 0));
  const x = (i: number) => padL + (n <= 1 ? (w - padL - padR) / 2 : (i / (n - 1)) * (w - padL - padR));
  const y = (v: number) => padT + (1 - v / top) * (h - padT - padB);
  const ticks = [0, top / 2, top];
  const step = labelStep(labels, (w - padL - padR) / Math.max(1, n - 1));
  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (n < 1) return;
    const r = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - r.left;
    const i = n <= 1 ? 0 : Math.round(((px - padL) / (w - padL - padR)) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };
  const summary = labels.map((l, i) => `${titles?.[i] ?? l}: ${series.map((s) => `${s.label} ${s.values[i] ?? 0}`).join(", ")}`).join("; ");
  return (
    <div>
      <div ref={ref} style={{ position: "relative" }}>
        <svg width={w} height={h} role="img" aria-label={label ? `${label}. ${summary}` : summary}
          style={{ display: "block", overflow: "visible" }} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          <defs>
            <linearGradient id={`${gid}-l`} gradientUnits="userSpaceOnUse" x1={padL} y1="0" x2={w - padR} y2="0">
              {GRAD_STOPS.map(([o, c]) => <stop key={o} offset={o} stopColor={c} />)}
            </linearGradient>
            <linearGradient id={`${gid}-a`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#8B5CF6" stopOpacity="0.16" />
              <stop offset="1" stopColor="#8B5CF6" stopOpacity="0" />
            </linearGradient>
          </defs>
          {ticks.map((v, i) => (
            <g key={i} aria-hidden="true">
              <line x1={padL - 12} x2={w - padR + 12} y1={y(v)} y2={y(v)} stroke={i === 0 ? "var(--hairline-strong)" : "var(--hairline)"} strokeWidth={1} />
              <text x={padL - 18} y={y(v) + 4} textAnchor="end" style={svgText}>{v}</text>
            </g>
          ))}
          {labels.map((lb, i) => showLabel(i, n, step) && (
            <text key={i} x={x(i)} y={h - 6} textAnchor="middle" aria-hidden="true"
              style={{ ...svgText, fill: i === current ? "var(--accent-text, var(--accent))" : svgText.fill, fontWeight: i === current ? 600 : 500 }}>{lb}</text>
          ))}
          {series.map((s) => {
            if (!s.values.length) return null;
            const pts = s.values.map((v, i) => [x(i), y(v)] as const);
            const d = pts.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
            const stroke = s.grad ? `url(#${gid}-l)` : s.color;
            const area = `${d} L${pts[pts.length - 1][0].toFixed(1)} ${y(0).toFixed(1)} L${pts[0][0].toFixed(1)} ${y(0).toFixed(1)} Z`;
            const last = pts[pts.length - 1];
            return (
              <g key={s.label} aria-hidden="true">
                {(s.area || s.grad) && <path d={area} fill={s.grad ? `url(#${gid}-a)` : s.color} fillOpacity={s.grad ? 1 : 0.08}
                  style={{ opacity: grown ? 1 : 0, transition: "opacity var(--d-3, 240ms) var(--ease)" }} />}
                <path d={d} pathLength={1} fill="none" stroke={stroke} strokeWidth={s.grad ? 2 : 1.5} strokeLinecap="round" strokeLinejoin="round"
                  style={{ strokeDasharray: 1, strokeDashoffset: grown ? 0 : 1, transition: growTransition("stroke-dashoffset") }} />
                {s.grad && <circle cx={last[0]} cy={last[1]} r={3.5} fill="#C24BE0" stroke="var(--surface-solid, var(--bg))" strokeWidth={1.5}
                  style={{ opacity: grown ? 1 : 0, transition: growTransition("opacity", 200) }} />}
              </g>
            );
          })}
          {hover != null && (
            <g aria-hidden="true">
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={y(0)} stroke="var(--hairline-strong)" strokeWidth={1} />
              {series.map((s) => (
                <circle key={s.label} cx={x(hover)} cy={y(s.values[hover] ?? 0)} r={3.5}
                  fill={s.grad ? "#8B5CF6" : s.color} stroke="var(--surface-solid, var(--bg))" strokeWidth={1.5} />
              ))}
            </g>
          )}
        </svg>
        {hover != null && (
          <ChartTip x={x(hover)} width={w} top={padT}>
            <div style={tipTitle}>{titles?.[hover] ?? labels[hover]}</div>
            {series.map((s) => <TipRow key={s.label} swatch={s.grad ? CHART_GRAD : s.color} label={s.label} value={s.values[hover] ?? 0} />)}
          </ChartTip>
        )}
      </div>
      <ChartLegend items={series.map((s) => ({ label: s.label, color: s.grad ? CHART_GRAD : s.color, shape: "line" as const }))} />
    </div>
  );
}

/* ---------------- BarList: labelled horizontal bars ---------------- */

export type BarTone = "ink" | "accent" | "warn" | "signal";
const TONE: Record<BarTone, string> = {
  ink: INK,
  accent: "var(--accent)",
  warn: "var(--warn-fill, var(--st-review))",
  signal: "var(--signal, var(--st-blocked))",
};

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
  tone?: BarTone;
  /** a mark before the label: a project dot, an avatar, a status glyph */
  lead?: ReactNode;
  /** quieter text after the value ("· 3 open") */
  meta?: ReactNode;
  /** the full label, when it may be truncated */
  title?: string;
}

/** Rows of label · bar · value. The bars are decoration (aria-hidden); each
 *  row's text carries its label and value, so a screen reader reads a list. */
export function BarList({ rows, max, labelWidth = 140, label }: { rows: BarRow[]; max?: number; labelWidth?: number; label?: string }) {
  const grown = useGrow();
  const top = Math.max(max ?? 0, ...rows.map((r) => r.value), 1);
  return (
    <ul aria-label={label} style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }}>
      {rows.map((r, i) => {
        const pct = (r.value / top) * 100;
        return (
          <li key={r.key} style={{ display: "grid", gridTemplateColumns: `minmax(0, ${labelWidth}px) minmax(24px, 1fr) auto`, alignItems: "center", gap: 12, minHeight: 28 }}>
            <span title={r.title} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, font: "500 13px/20px var(--font-ui, var(--font-display))", color: "var(--ink-2)" }}>
              {r.lead}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</span>
            </span>
            <span aria-hidden="true" style={{ position: "relative", height: 6, borderRadius: 999, background: TRACK, overflow: "hidden" }}>
              <span style={{
                position: "absolute", left: 0, top: 0, bottom: 0, borderRadius: 999, background: TONE[r.tone ?? "ink"],
                width: grown && r.value > 0 ? `max(${pct}%, 4px)` : 0, transition: growTransition("width", i * 24),
              }} />
            </span>
            <span style={{ ...AXIS, color: "var(--ink-2)", minWidth: 24, textAlign: "right" }}>
              {r.value}{r.meta != null && <span style={{ color: "var(--ink-4)" }}> {r.meta}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ---------------- StackedBar: parts of a whole ---------------- */

/** One 10px bar split into coloured parts with hairline gaps (status mix). */
export function StackedBar({ segments, height = 10, label }: {
  segments: { key: string; label: string; value: number; color: string }[];
  height?: number;
  label: string;
}) {
  const grown = useGrow();
  const total = segments.reduce((a, s) => a + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  return (
    <div role="img" aria-label={`${label}: ${shown.map((s) => `${s.label} ${s.value}`).join(", ") || "none"}`}
      style={{ display: "flex", gap: 2, height, borderRadius: 999, overflow: "hidden", background: total ? "transparent" : TRACK }}>
      {shown.map((s, i) => (
        <span key={s.key} title={`${s.label} · ${s.value}`} style={{
          flexGrow: grown ? s.value : 0, flexShrink: 0, flexBasis: 0, minWidth: 3, background: s.color,
          borderRadius: i === 0 && i === shown.length - 1 ? 999 : i === 0 ? "999px 2px 2px 999px" : i === shown.length - 1 ? "2px 999px 999px 2px" : 2,
          transition: growTransition("flex-grow"),
        }} />
      ))}
    </div>
  );
}

/* ---------------- Sparkline / Ring / Heatmap (Home, Week) ---------------- */

export function Sparkline({ data, w = 220, h = 56, color = "var(--accent)", fill = true }: {
  data: number[]; w?: number; h?: number; color?: string; fill?: boolean;
}) {
  const grown = useGrow();
  const gid = useSvgId("spk");
  if (data.length < 2) return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }} aria-hidden="true" />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / (max - min || 1)) * (h - 8) - 4]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }} aria-hidden="true">
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.2" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} pathLength={1} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
        style={{ strokeDasharray: 1, strokeDashoffset: grown ? 0 : 1, transition: growTransition("stroke-dashoffset") }} />
      {pts.length > 0 && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3" fill={color} />}
    </svg>
  );
}

export function Ring({ value, size = 96, stroke = 9, color = "var(--accent)", label, sub }: {
  value: number; size?: number; stroke?: number; color?: string; label?: string; sub?: string;
}) {
  const grown = useGrow();
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
  const off = grown ? c * (1 - v / 100) : c;
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={TRACK} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} style={{ transition: growTransition("stroke-dashoffset") }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div className="mono tnum" style={{ fontSize: Math.max(11, size * 0.24), fontWeight: 600, lineHeight: 1, color: "var(--ink)" }}>{label}</div>
          {sub && <div style={{ ...AXIS, marginTop: 4, color: "var(--ink-3)" }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

/* A focus heatmap (weeks × days). Illustrative only: nothing in the app feeds it yet. */
export function Heatmap({ weeks = 14 }: { weeks?: number }) {
  const [cells] = useState(() => {
    const out: number[][] = [];
    for (let w = 0; w < weeks; w++) {
      out.push(Array.from({ length: 7 }, (_, d) => {
        const v = Math.round((Math.sin(w * 1.3 + d) + Math.cos(d * 2 + w * 0.5) + 2) / 4 * 4) - (Math.random() > 0.7 ? 2 : 0);
        return Math.min(4, Math.max(0, v));
      }));
    }
    return out;
  });
  const shade = (v: number) => (v === 0 ? "var(--fill-1)" : `color-mix(in oklch, var(--accent) ${18 + v * 20}%, transparent)`);
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks}, 1fr)`, gap: 4 }} aria-hidden="true">
      {cells.map((col, w) => (
        <div key={w} style={{ display: "grid", gridTemplateRows: "repeat(7,1fr)", gap: 4 }}>
          {col.map((v, d) => <div key={d} title={`${v} sessions`} style={{ aspectRatio: "1", borderRadius: 3, background: shade(v) }} />)}
        </div>
      ))}
    </div>
  );
}
