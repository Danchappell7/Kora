/* ============================================================
   KANBO — bespoke empty-state illustrations.
   On-brand gradient line art (derived from the current accent, so it
   follows the Appearance setting) with a soft halo and two sparkles.
   Purely decorative: aria-hidden, and the float is off under
   prefers-reduced-motion.
   ============================================================ */
import { useId, type CSSProperties, type ReactNode } from "react";

export type EmptyArtKind =
  | "tasks" | "layers" | "calendar" | "folder" | "chart" | "trendingUp"
  | "inbox" | "users" | "target" | "briefcase" | "search";

const SURFACE: CSSProperties = { fill: "var(--surface-raised)" };
const TINT: CSSProperties = { fill: "var(--accent-dim)" };
const DOT: CSSProperties = { fill: "var(--ink-4)", opacity: 0.45 };

function Sparkle({ x, y, s = 1, fill }: { x: number; y: number; s?: number; fill: string }) {
  return <path d="M0 -4L1 -1L4 0L1 1L0 4L-1 1L-4 0L-1 -1Z" transform={`translate(${x} ${y}) scale(${s})`} style={{ fill, opacity: 0.85 }} />;
}

export function EmptyArt({ kind, size = 132 }: { kind: EmptyArtKind | string; size?: number }) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const gid = `ka${uid}`;
  const g = `url(#${gid})`;
  const line = { stroke: g, strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
  const faint = { ...line, opacity: 0.45 };

  const art: Record<EmptyArtKind, ReactNode> = {
    tasks: (<>
      <rect x="34" y="14" width="56" height="40" rx="8" {...faint} style={{ fill: "var(--surface-2)" }} />
      <rect x="42" y="26" width="58" height="44" rx="8" {...line} style={SURFACE} />
      <circle cx="56" cy="40" r="6.5" {...line} style={TINT} />
      <path d="M52.8 40.3l2.3 2.3 4.2-4.4" {...line} />
      <line x1="68" y1="40" x2="90" y2="40" {...line} />
      <line x1="53" y1="54" x2="88" y2="54" {...faint} />
      <line x1="53" y1="61" x2="76" y2="61" {...faint} />
    </>),
    layers: (<>
      <line x1="24" y1="76" x2="108" y2="76" {...faint} />
      <rect x="28" y="20" width="46" height="11" rx="5.5" {...line} style={TINT} />
      <rect x="46" y="39" width="54" height="11" rx="5.5" {...line} style={SURFACE} />
      <rect x="36" y="58" width="34" height="11" rx="5.5" {...line} style={TINT} />
      <path d="M100 58l5 5-5 5-5-5z" {...line} style={{ fill: g }} />
    </>),
    calendar: (<>
      <rect x="36" y="18" width="60" height="56" rx="9" {...line} style={SURFACE} />
      <line x1="36" y1="32" x2="96" y2="32" {...line} />
      <line x1="50" y1="12" x2="50" y2="23" {...line} />
      <line x1="82" y1="12" x2="82" y2="23" {...line} />
      {[48, 60, 72, 84].flatMap((x) => [44, 54, 64].map((y) => (x === 72 && y === 54 ? null : <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" style={DOT} />)))}
      <circle cx="72" cy="54" r="6" style={{ fill: g }} />
    </>),
    folder: (<>
      <rect x="54" y="12" width="32" height="30" rx="4" {...line} style={{ fill: "var(--surface-2)" }} />
      <line x1="61" y1="21" x2="79" y2="21" {...faint} />
      <line x1="61" y1="28" x2="74" y2="28" {...faint} />
      <path d="M30 34a6 6 0 0 1 6-6h14l6 7h40a6 6 0 0 1 6 6v29a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z" {...line} style={SURFACE} />
      <line x1="30" y1="46" x2="102" y2="46" {...faint} />
    </>),
    chart: (<>
      <path d="M30 18v56h76" {...faint} />
      <rect x="40" y="54" width="11" height="20" rx="3" {...line} style={TINT} />
      <rect x="57" y="40" width="11" height="34" rx="3" {...line} style={SURFACE} />
      <rect x="74" y="47" width="11" height="27" rx="3" {...line} style={TINT} />
      <rect x="91" y="28" width="11" height="46" rx="3" {...line} style={{ fill: g, opacity: 0.9 }} />
    </>),
    trendingUp: (<>
      <path d="M30 18v56h76" {...faint} />
      <path d="M36 64l16-14 12 8 16-20 18-11" {...line} strokeWidth={2.8} />
      {[[36, 64], [52, 50], [64, 58], [80, 38]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.2" {...line} style={SURFACE} />)}
      <path d="M88 26h10v10" {...line} strokeWidth={2.8} />
    </>),
    inbox: (<>
      <path d="M30 52l10-22h52l10 22v16a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z" {...line} style={SURFACE} />
      <path d="M30 52h22l4 8h20l4-8h22" {...line} />
      <circle cx="66" cy="17" r="10" style={{ fill: g }} />
      <path d="M61.5 17.2l3.2 3.2 5.8-6" fill="none" stroke="var(--on-accent)" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </>),
    users: (<>
      <circle cx="80" cy="33" r="9" {...faint} />
      <path d="M64 70a16 16 0 0 1 32 0" {...faint} />
      <circle cx="56" cy="37" r="11" {...line} style={SURFACE} />
      <path d="M35 74a21 21 0 0 1 42 0z" {...line} style={SURFACE} />
      <circle cx="98" cy="62" r="9" style={{ fill: g }} />
      <path d="M98 57.5v9M93.5 62h9" fill="none" stroke="var(--on-accent)" strokeWidth={2.4} strokeLinecap="round" />
    </>),
    target: (<>
      <circle cx="60" cy="50" r="27" {...faint} />
      <circle cx="60" cy="50" r="18" {...line} style={SURFACE} />
      <circle cx="60" cy="50" r="8" {...line} style={TINT} />
      <circle cx="60" cy="50" r="2.4" style={{ fill: g }} />
      <path d="M60 50L95 17" {...line} />
      <path d="M86 15l9 2-2 9" {...line} />
    </>),
    briefcase: (<>
      <path d="M54 30v-6a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v6" {...line} />
      <rect x="32" y="30" width="68" height="44" rx="8" {...line} style={SURFACE} />
      <path d="M32 48h68" {...faint} />
      <rect x="60" y="44" width="12" height="9" rx="2.5" style={{ fill: g }} />
    </>),
    search: (<>
      <rect x="26" y="20" width="46" height="8" rx="4" {...faint} />
      <rect x="26" y="36" width="34" height="8" rx="4" {...faint} />
      <rect x="26" y="52" width="40" height="8" rx="4" {...faint} />
      <circle cx="78" cy="44" r="17" {...line} style={SURFACE} />
      <line x1="90.5" y1="56.5" x2="104" y2="70" {...line} strokeWidth={4.2} />
      <path d="M71 44h14" {...line} opacity={0.6} />
    </>),
  };

  return (
    <svg className="kempty-art" width={size} height={Math.round((size * 96) / 132)} viewBox="0 0 132 96" aria-hidden="true" style={{ display: "block", margin: "0 auto", overflow: "visible" }}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" style={{ stopColor: "color-mix(in oklch, var(--accent), #5b8cff 40%)" }} />
          <stop offset="0.55" style={{ stopColor: "var(--accent)" }} />
          <stop offset="1" style={{ stopColor: "color-mix(in oklch, var(--accent), #e05cc8 45%)" }} />
        </linearGradient>
      </defs>
      <ellipse cx="66" cy="88" rx="40" ry="4.5" style={{ fill: "var(--accent-dim)" }} />
      <Sparkle x={20} y={24} s={1.1} fill={g} />
      <Sparkle x={114} y={34} s={0.8} fill={g} />
      {art[(kind in art ? kind : "tasks") as EmptyArtKind]}
    </svg>
  );
}
