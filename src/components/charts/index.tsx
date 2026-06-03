/* ============================================================
   KORA — lightweight SVG charts (Ring, Sparkline, Bars, Heatmap)
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
