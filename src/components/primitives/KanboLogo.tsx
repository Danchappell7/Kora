/* ============================================================
   KANBO — brand logo mark (kanban glyph in the brand gradient)
   Matches KANBO Brand Assets / icons / favicon.svg.
   ============================================================ */
import { useId } from "react";

export function KanboLogo({ size = 32, glow = false, style }: {
  size?: number;
  glow?: boolean;
  style?: React.CSSProperties;
}) {
  const gid = useId();
  return (
    <svg
      width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg"
      aria-label="KANBO" role="img"
      style={{ display: "block", flexShrink: 0, filter: glow ? "drop-shadow(0 0 14px var(--accent-glow))" : undefined, ...style }}
    >
      <defs>
        <linearGradient id={gid} x1="6" y1="6" x2="58" y2="58" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5B7CFA" />
          <stop offset="0.52" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#C24BE0" />
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="15" fill={`url(#${gid})`} />
      <g transform="translate(21,18)" fill="#fff">
        <rect x="0" y="0" width="7" height="28" rx="2.5" />
        <rect x="13" y="0" width="11" height="12" rx="2.5" />
        <rect x="13" y="16" width="11" height="12" rx="2.5" />
      </g>
    </svg>
  );
}
