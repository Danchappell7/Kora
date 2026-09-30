/* ============================================================
   KANBO — brand marks
   KanboLogo: the lockup mark, an exact match to KANBO Brand Assets /
   logo / kanbo-icon-gradient.svg (the bars themselves are the gradient,
   no square). The square + white treatment is reserved for the favicon
   and app icon.
   KanboGlyph: the three-block board glyph (columns at 60% · 100% · 40%,
   hung from the top like a board). It is Kanbo's AI mark (AiMark) and
   the Projects icon; never a generic sparkle.
   ============================================================ */
import { useId, type CSSProperties } from "react";

const MARK_W = 48, MARK_H = 56; // brand mark aspect ratio

export function KanboLogo({ size = 28, glow = false, style }: {
  size?: number;        // rendered HEIGHT in px; width follows the brand 48:56 ratio
  glow?: boolean;
  style?: CSSProperties;
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

/** The three-block board glyph. `gradient` paints it in the brand gradient
 *  (through a per-instance useId() gradient, so two marks never share, or
 *  lose, a definition); otherwise it takes the text colour. `thinking`
 *  animates the columns (only while a request is in flight; kanbo.css holds
 *  it still under reduced motion). Decorative unless `title` names it. */
export function KanboGlyph({ size = 16, gradient = false, thinking, title, className, style }: {
  size?: number;
  gradient?: boolean;
  thinking?: boolean;
  title?: string;
  className?: string;
  style?: CSSProperties;
}) {
  const gid = "kg" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const fill = gradient ? `url(#${gid})` : "currentColor";
  return (
    <svg className={"kaimark" + (className ? ` ${className}` : "")} data-thinking={thinking || undefined}
      width={size} height={size} viewBox="0 0 16 16" focusable="false" style={style}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true as const })}>
      {gradient && (
        <defs>
          <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="1" x2="16" y2="15">
            <stop offset="0" stopColor="#5B7CFA" />
            <stop offset="0.52" stopColor="#8B5CF6" />
            <stop offset="1" stopColor="#C24BE0" />
          </linearGradient>
        </defs>
      )}
      <rect x={0.5} y={1} width={4} height={8.4} rx={1.5} fill={fill} />
      <rect x={6} y={1} width={4} height={14} rx={1.5} fill={fill} />
      <rect x={11.5} y={1} width={4} height={5.6} rx={1.5} fill={fill} />
    </svg>
  );
}
