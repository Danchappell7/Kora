/* ============================================================
   KANBO — lightweight SVG charts (Ring, Sparkline, Bars, Heatmap)
   ============================================================ */

export function Ring({ value, size = 96, stroke = 9, color = "var(--accent)", label, sub }: {
  value: number; size?: number; stroke?: number; color?: string; label?: string; sub?: string;
}) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const off = c * (1 - value / 100);
  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline-strong)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={off} style={{ transition: "stroke-dashoffset 1s var(--ease)", filter: `drop-shadow(0 0 6px ${color})` }} />
      </svg>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", textAlign: "center" }}>
        <div>
          <div className="mono tnum" style={{ fontSize: size * 0.26, fontWeight: 600, lineHeight: 1 }}>{label}</div>
          {sub && <div className="kicker" style={{ marginTop: 3 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

export function Sparkline({ data, w = 220, h = 56, color = "var(--accent)", fill = true }: {
  data: number[]; w?: number; h?: number; color?: string; fill?: boolean;
}) {
  if (data.length < 2) return <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }} />;
  const max = Math.max(...data, 1), min = Math.min(...data, 0);
  const pts = data.map((v, i) => [(i / (data.length - 1)) * w, h - ((v - min) / (max - min || 1)) * (h - 8) - 4]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = d + ` L${w} ${h} L0 ${h} Z`;
  const gid = "spk" + Math.random().toString(36).slice(2, 7);
  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block" }}>
      <defs><linearGradient id={gid} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} stopOpacity="0.28" /><stop offset="1" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      {fill && <path d={area} fill={`url(#${gid})`} />}
      <path d={d} fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      {pts.length > 0 && <circle cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r="3.2" fill={color} style={{ filter: `drop-shadow(0 0 5px ${color})` }} />}
    </svg>
  );
}

export interface BarDatum { label: string; value: number; highlight?: boolean; }
export function Bars({ data, h = 130, color = "var(--accent)" }: { data: BarDatum[]; h?: number; color?: string }) {
  const max = Math.max(...data.map((d) => d.value), 1);
  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 10, height: h }}>
      {data.map((d, i) => (
        <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 8, height: "100%", justifyContent: "flex-end" }}>
          <div className="mono tnum" style={{ fontSize: 11, color: "var(--ink-3)" }}>{d.value}</div>
          <div style={{ width: "100%", maxWidth: 30, height: `${(d.value / max) * 100}%`, minHeight: 4, borderRadius: 7, background: d.highlight ? color : "var(--surface-2)", border: d.highlight ? "none" : "1px solid var(--hairline-strong)", boxShadow: d.highlight ? `0 0 16px ${color}` : "none", transition: "height .8s var(--ease)" }} />
          <span className="kicker" style={{ fontSize: 9.5 }}>{d.label}</span>
        </div>
      ))}
    </div>
  );
}

/* Multi-series line chart with gridlines + axis labels (trends over time). */
export interface LineSeries { label: string; color: string; values: number[]; }
export function LineChart({ series, labels, h = 170, yMax }: { series: LineSeries[]; labels: string[]; h?: number; yMax?: number }) {
  const w = 560, padL = 30, padB = 22, padT = 8, padR = 8;
  const n = labels.length;
  const max = Math.max(yMax ?? 0, ...series.flatMap((s) => s.values), 1);
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * (w - padL - padR));
  const y = (v: number) => padT + (1 - v / max) * (h - padT - padB);
  const ticks = 4;
  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ display: "block", overflow: "visible" }}>
        {Array.from({ length: ticks + 1 }, (_, t) => {
          const v = (max / ticks) * t, yy = y(v);
          return (
            <g key={t}>
              <line x1={padL} y1={yy} x2={w - padR} y2={yy} stroke="var(--hairline)" strokeWidth="1" />
              <text x={padL - 5} y={yy + 3} textAnchor="end" fontSize="9" fill="var(--ink-4)" className="mono">{Math.round(v)}</text>
            </g>
          );
        })}
        {labels.map((lb, i) => ((n <= 8 || i % 2 === 0) && (
          <text key={i} x={x(i)} y={h - 6} textAnchor="middle" fontSize="9" fill="var(--ink-4)">{lb}</text>
        )))}
        {series.map((s) => {
          const d = s.values.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
          return (
            <g key={s.label}>
              <path d={d} fill="none" stroke={s.color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r="2.6" fill={s.color} />)}
            </g>
          );
        })}
      </svg>
      <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap" }}>
        {series.map((s) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
            <span style={{ width: 14, height: 3, borderRadius: 2, background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* Two-or-more series grouped bars (e.g. created vs completed per week). */
export function GroupedBars({ groups, series, h = 150 }: { groups: string[]; series: { label: string; color: string; values: number[] }[]; h?: number }) {
  const max = Math.max(...series.flatMap((s) => s.values), 1);
  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: h }}>
        {groups.map((g, gi) => (
          <div key={gi} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: "100%", justifyContent: "flex-end" }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: "100%", width: "100%", justifyContent: "center" }}>
              {series.map((s) => (
                <div key={s.label} title={`${s.label}: ${s.values[gi]}`} style={{ width: 10, maxWidth: 14, height: `${(s.values[gi] / max) * 100}%`, minHeight: s.values[gi] > 0 ? 3 : 0, borderRadius: 4, background: s.color, transition: "height .7s var(--ease)" }} />
              ))}
            </div>
            <span className="kicker" style={{ fontSize: 9 }}>{g}</span>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 16, marginTop: 10, flexWrap: "wrap" }}>
        {series.map((s) => (
          <span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-3)" }}>
            <span style={{ width: 10, height: 10, borderRadius: 3, background: s.color }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/* GitHub-style focus heatmap (weeks x days) */
export function Heatmap({ weeks = 14 }: { weeks?: number }) {
  const cells: { w: number; d: number; v: number }[] = [];
  for (let w = 0; w < weeks; w++) for (let d = 0; d < 7; d++) {
    const v = Math.max(0, Math.round((Math.sin(w * 1.3 + d) + Math.cos(d * 2 + w * 0.5) + 2) / 4 * 4) - (Math.random() > 0.7 ? 2 : 0));
    cells.push({ w, d, v: Math.min(4, Math.max(0, v)) });
  }
  const shade = (v: number) => v === 0 ? "var(--surface-2)" : `color-mix(in oklch, var(--accent) ${18 + v * 20}%, transparent)`;
  return (
    <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks}, 1fr)`, gap: 4 }}>
      {Array.from({ length: weeks }, (_, w) => (
        <div key={w} style={{ display: "grid", gridTemplateRows: "repeat(7,1fr)", gap: 4 }}>
          {Array.from({ length: 7 }, (_, d) => {
            const c = cells.find((x) => x.w === w && x.d === d)!;
            return <div key={d} title={`${c.v} sessions`} style={{ aspectRatio: "1", borderRadius: 3, background: shade(c.v), boxShadow: c.v >= 3 ? "0 0 8px var(--accent-glow)" : "none" }} />;
          })}
        </div>
      ))}
    </div>
  );
}
