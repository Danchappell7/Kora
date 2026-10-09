/* ============================================================
   KANBO — two glyphs the first run needs that the shared Icon set
   doesn't have (a question mark for Help, a compass for the tour).
   Drawn on the same 24px lucide-style grid with round caps, so at
   16px with a 1.75 stroke they sit beside the kit's icons unnoticed.
   ============================================================ */
import type { CSSProperties } from "react";

interface GlyphProps { size?: number; sw?: number; className?: string; style?: CSSProperties }

const svgProps = (size: number, sw: number) => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: sw,
  strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, focusable: "false" as const,
});

/** A question mark in a circle: the Help (?) menu. */
export function HelpGlyph({ size = 16, sw = 1.75, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size, sw)} className={className} style={{ flexShrink: 0, ...style }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M9.6 9.3a2.5 2.5 0 0 1 4.85.85c0 1.65-2.45 2.35-2.45 3.6" />
      <path d="M12 17h.01" />
    </svg>
  );
}

/** A compass: the guided tour. */
export function CompassGlyph({ size = 16, sw = 1.75, className, style }: GlyphProps) {
  return (
    <svg {...svgProps(size, sw)} className={className} style={{ flexShrink: 0, ...style }}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.6 8.4 13.6 13.6 8.4 15.6 10.4 10.4z" />
    </svg>
  );
}
