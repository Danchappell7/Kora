/* ============================================================
   KANBO — brand logo mark (the kanban glyph, gradient bars)
   Exact match to KANBO Brand Assets / logo / kanbo-icon-gradient.svg
   (the lockup mark — bars themselves are the gradient, no square).
   The square+white treatment is reserved for the favicon / app icon.
   ============================================================ */
import { useId } from "react";

const MARK_W = 48, MARK_H = 56; // brand mark aspect ratio

export function KanboLogo({ size = 28, glow = false, style }: {
  size?: number;        // rendered HEIGHT in px; width follows the brand 48:56 ratio
  glow?: boolean;
  style?: React.CSSProperties;
}) {
  const gid = useId();
  const width = Math.round((size * MARK_W) / MARK_H);
  return (
    <svg
      width={width} height={size} viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg"
      aria-label="KANBO" role="img"
      style={{ display: "block", flexShrink: 0, filter: glow ? "drop-shadow(0 0 12px var(--accent-glow))" : undefined, ...style }}
    >
      <defs>
        <linearGradient id={gid} x1="2" y1="2" x2="46" y2="54" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#5B7CFA" />
          <stop offset="0.52" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#C24BE0" />
        </linearGradient>
      </defs>
      <rect x="0" y="0" width="14" height="56" rx="5" fill={`url(#${gid})`} />
      <rect x="26" y="0" width="22" height="24" rx="5" fill={`url(#${gid})`} />
      <rect x="26" y="32" width="22" height="24" rx="5" fill={`url(#${gid})`} />
    </svg>
  );
}
