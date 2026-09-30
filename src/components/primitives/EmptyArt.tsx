/* ============================================================
   KANBO — empty-state illustrations.
   Quiet line art: every stroke in --icon-quiet on raised surfaces, and
   ONE element per drawing in the accent (it follows the Appearance
   setting), the thing the empty state is about. Static (no float) and
   purely decorative (aria-hidden). Drawn on a 132×96 board, shown at
   96px wide by default.
   ============================================================ */
import type { CSSProperties, ReactNode } from "react";

export type EmptyArtKind =
  | "tasks" | "layers" | "calendar" | "folder" | "chart" | "trendingUp"
  | "inbox" | "users" | "target" | "briefcase" | "search";

const RAISED: CSSProperties = { fill: "var(--surface-raised)" };
const WELL: CSSProperties = { fill: "var(--fill-1)" };
const DOT: CSSProperties = { fill: "var(--icon-quiet)" };
const ACCENT_FILL: CSSProperties = { fill: "var(--accent)" };

const line = { stroke: "var(--icon-quiet)", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, fill: "none" };
const faint = { ...line, opacity: 0.5 };
const accent = { ...line, stroke: "var(--accent)" };
/** a mark knocked out of an accent fill */
const knock = { fill: "none", stroke: "var(--on-accent)", strokeWidth: 2.2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };

const ART: Record<EmptyArtKind, ReactNode> = {
  tasks: (<>
    <rect x="34" y="14" width="56" height="40" rx="8" {...faint} style={WELL} />
    <rect x="42" y="26" width="58" height="44" rx="8" {...line} style={RAISED} />
    <circle cx="56" cy="40" r="6.5" style={ACCENT_FILL} />
    <path d="M53 40.3l2.2 2.2 4-4.2" {...knock} />
    <line x1="68" y1="40" x2="90" y2="40" {...line} />
    <line x1="53" y1="54" x2="88" y2="54" {...faint} />
    <line x1="53" y1="61" x2="76" y2="61" {...faint} />
  </>),
  layers: (<>
    <line x1="24" y1="76" x2="108" y2="76" {...faint} />
    <rect x="28" y="20" width="46" height="11" rx="5.5" {...line} style={RAISED} />
    <rect x="46" y="39" width="54" height="11" rx="5.5" {...accent} style={RAISED} />
    <rect x="36" y="58" width="34" height="11" rx="5.5" {...line} style={RAISED} />
  </>),
  calendar: (<>
    <rect x="36" y="18" width="60" height="56" rx="9" {...line} style={RAISED} />
    <line x1="36" y1="32" x2="96" y2="32" {...line} />
    <line x1="50" y1="12" x2="50" y2="23" {...line} />
    <line x1="82" y1="12" x2="82" y2="23" {...line} />
    {[48, 60, 72, 84].flatMap((x) => [44, 54, 64].map((y) => (x === 72 && y === 54 ? null : <circle key={`${x}-${y}`} cx={x} cy={y} r="1.9" style={DOT} opacity={0.6} />)))}
    <circle cx="72" cy="54" r="6" style={ACCENT_FILL} />
  </>),
  folder: (<>
    <rect x="54" y="12" width="32" height="30" rx="4" {...faint} style={WELL} />
    <line x1="61" y1="21" x2="79" y2="21" {...accent} />
    <line x1="61" y1="28" x2="74" y2="28" {...faint} />
    <path d="M30 34a6 6 0 0 1 6-6h14l6 7h40a6 6 0 0 1 6 6v29a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z" {...line} style={RAISED} />
    <line x1="30" y1="46" x2="102" y2="46" {...faint} />
  </>),
  chart: (<>
    <path d="M30 18v56h76" {...faint} />
    <rect x="40" y="54" width="11" height="20" rx="3" {...line} style={RAISED} />
    <rect x="57" y="40" width="11" height="34" rx="3" {...line} style={RAISED} />
    <rect x="74" y="47" width="11" height="27" rx="3" {...line} style={RAISED} />
    <rect x="91" y="28" width="11" height="46" rx="3" style={ACCENT_FILL} />
  </>),
  trendingUp: (<>
    <path d="M30 18v56h76" {...faint} />
    <path d="M36 64l16-14 12 8 16-20 18-11" {...accent} strokeWidth={2.6} />
    {[[36, 64], [52, 50], [64, 58], [80, 38]].map(([x, y]) => <circle key={x} cx={x} cy={y} r="3.2" {...line} style={RAISED} />)}
    <path d="M88 26h10v10" {...accent} strokeWidth={2.6} />
  </>),
  inbox: (<>
    <path d="M30 52l10-22h52l10 22v16a6 6 0 0 1-6 6H36a6 6 0 0 1-6-6z" {...line} style={RAISED} />
    <path d="M30 52h22l4 8h20l4-8h22" {...line} />
    <circle cx="66" cy="17" r="10" style={ACCENT_FILL} />
    <path d="M61.5 17.2l3.2 3.2 5.8-6" {...knock} />
  </>),
  users: (<>
    <circle cx="80" cy="33" r="9" {...faint} />
    <path d="M64 70a16 16 0 0 1 32 0" {...faint} />
    <circle cx="56" cy="37" r="11" {...line} style={RAISED} />
    <path d="M35 74a21 21 0 0 1 42 0z" {...line} style={RAISED} />
    <circle cx="98" cy="62" r="9" style={ACCENT_FILL} />
    <path d="M98 57.5v9M93.5 62h9" {...knock} />
  </>),
  target: (<>
    <circle cx="60" cy="50" r="27" {...faint} />
    <circle cx="60" cy="50" r="18" {...line} style={RAISED} />
    <circle cx="60" cy="50" r="8" {...line} style={WELL} />
    <path d="M60 50L95 17M86 15l9 2-2 9" {...accent} />
    <circle cx="60" cy="50" r="2.6" style={ACCENT_FILL} />
  </>),
  briefcase: (<>
    <path d="M54 30v-6a4 4 0 0 1 4-4h16a4 4 0 0 1 4 4v6" {...line} />
    <rect x="32" y="30" width="68" height="44" rx="8" {...line} style={RAISED} />
    <path d="M32 48h68" {...faint} />
    <rect x="60" y="44" width="12" height="9" rx="2.5" style={ACCENT_FILL} />
  </>),
  search: (<>
    <rect x="26" y="20" width="46" height="8" rx="4" {...faint} style={WELL} />
    <rect x="26" y="36" width="34" height="8" rx="4" {...faint} style={WELL} />
    <rect x="26" y="52" width="40" height="8" rx="4" {...faint} style={WELL} />
    <circle cx="78" cy="44" r="17" {...accent} style={RAISED} />
    <line x1="90.5" y1="56.5" x2="104" y2="70" {...line} strokeWidth={4} />
    <path d="M71 44h14" {...faint} />
  </>),
};

export function EmptyArt({ kind, size = 96 }: { kind: EmptyArtKind | string; size?: number }) {
  return (
    <svg className="kempty-art" width={size} height={Math.round((size * 96) / 132)} viewBox="0 0 132 96" aria-hidden="true" focusable="false"
      style={{ display: "block", margin: "0 auto", overflow: "visible" }}>
      <ellipse cx="66" cy="88" rx="40" ry="4" style={WELL} />
      {ART[(kind in ART ? kind : "tasks") as EmptyArtKind]}
    </svg>
  );
}
