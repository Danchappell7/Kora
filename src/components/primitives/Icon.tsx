/* ============================================================
   KANBO — Icon (lucide-style stroke set: 24px grid, round caps and
   joins; the kit draws them at 16px with a 1.75 stroke)
   ============================================================ */
import type { CSSProperties } from "react";
import type { IconName } from "../../data/types";

const ICONS: Record<IconName, string> = {
  home: "M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5",
  inbox: "M3 13h4l2 3h6l2-3h4M3 13l3-8h12l3 8v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  archive: "M3 4h18v4H3zM5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M9 12h6",
  tasks: "M9 11l3 3 8-8M3 12l3 3 8-8",
  calendar: "M3 5h18v16H3zM3 9h18M8 3v4M16 3v4",
  users: "M16 19c0-2.8-2.2-5-5-5s-5 2.2-5 5M11 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M18 19c0-2 -1-3.4-2.5-4.2M16 5.2A3 3 0 0 1 18 11",
  chart: "M4 20V10M10 20V4M16 20v-7M22 20H2",
  plus: "M12 5v14M5 12h14",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M13.7 21a2 2 0 0 1-3.4 0",
  logout: "M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9",
  chevronDown: "M6 9l6 6 6-6",
  chevronRight: "M9 6l6 6-6 6",
  chevronLeft: "M15 6l-6 6 6 6",
  list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  board: "M4 4h6v16H4zM14 4h6v10h-6z",
  timeline: "M3 6h10M3 12h14M3 18h7M17 4v4M21 10v4M13 16v4",
  flag: "M5 21V4M5 4h11l-2 4 2 4H5",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  sparkles: "M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6zM19 14l.8 2.2L22 17l-2.2.8L19 20l-.8-2.2L16 17l2.2-.8z",
  play: "M7 4v16l13-8z",
  pause: "M8 5h3v14H8zM13 5h3v14h-3z",
  x: "M6 6l12 12M18 6L6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  arrowUpRight: "M7 17L17 7M8 7h9v9",
  target: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01",
  briefcase: "M3 8h18v12H3zM8 8V6a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM5 21c0-3.9 3.1-7 7-7s7 3.1 7 7",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v3M12 20v3M4 12H1M23 12h-3M5.6 5.6l-2-2M20.4 20.4l-2-2M18.4 5.6l2-2M3.6 20.4l2-2",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  command: "M6 4a3 3 0 0 1 3 3v10a3 3 0 1 1-3-3h12a3 3 0 1 1-3 3V7a3 3 0 1 1 3 3H6",
  filter: "M3 5h18l-7 8v6l-4-2v-4z",
  sort: "M3 7h12M3 12h8M3 17h5M17 5v14M17 19l3-3M17 19l-3-3",
  link: "M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1",
  zap: "M13 2L4 14h7l-1 8 9-12h-7z",
  trendingUp: "M3 17l6-6 4 4 8-8M21 7v5h-5",
  check: "M5 12l5 5L20 7",
  message: "M21 12a8 8 0 0 1-11.3 7.3L4 21l1.7-5.7A8 8 0 1 1 21 12z",
  folder: "M3 7h6l2 2h10v10H3z",
  dot: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  settings: "M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 0 0-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 0 0-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 0 0-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 0 0-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 0 0 1.066-2.573c-.94-1.543.826-3.31 2.37-2.37 1 .608 2.296.07 2.572-1.065zM9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM13 13h7v7h-7zM4 13h7v7H4z",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  arrowLeft: "M19 12H5M11 18l-6-6 6-6",
  refresh: "M21 12a9 9 0 1 1-3-6.7M21 4v5h-5",
  calendarPlus: "M3 5h18v16H3zM3 9h18M8 3v4M16 3v4M12 13v4M10 15h4",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  trash: "M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6",
  menu: "M3 6h18M3 12h18M3 18h18",
  /* Paper & Navy additions, drawn on the same 24px grid (round caps and joins) */
  pulse: "M3 12h3.5l2.5-6.5 5 13 2.5-6.5H21",
  radar: "M20.2 8.3A9 9 0 1 1 15.7 3.8M16.4 9.8A5 5 0 1 1 14.2 7.6M12 12l6.4-6.4M12 12h.01",
  // the brand's three-block board glyph: columns at 60% · 100% · 40%, hung from the top
  kanbo: "M4.25 3h1.5A1.25 1.25 0 0 1 7 4.25v8.05a1.25 1.25 0 0 1-1.25 1.25h-1.5A1.25 1.25 0 0 1 3 12.3V4.25A1.25 1.25 0 0 1 4.25 3zM11.25 3h1.5A1.25 1.25 0 0 1 14 4.25v14.5A1.25 1.25 0 0 1 12.75 20h-1.5A1.25 1.25 0 0 1 10 18.75V4.25A1.25 1.25 0 0 1 11.25 3zM18.25 3h1.5A1.25 1.25 0 0 1 21 4.25v4.3a1.25 1.25 0 0 1-1.25 1.25h-1.5A1.25 1.25 0 0 1 17 8.55v-4.3A1.25 1.25 0 0 1 18.25 3z",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  keyboard: "M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM6.5 9h.01M10 9h.01M14 9h.01M17.5 9h.01M6.5 12.5h.01M17.5 12.5h.01M8.5 15.5h7",
  copy: "M10 8h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2zM16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3",
  send: "M21.4 2.6L10.6 13.4M21.4 2.6l-6.6 18.3a.6.6 0 0 1-1.1.05L10.6 13.4 3.05 10.3a.6.6 0 0 1 .05-1.1z",
  sliders: "M20 5h-7M9 5H4M20 12h-9M7 12H4M20 19h-5M11 19H4M13 3v4M7 10v4M15 17v4",
  hourglass: "M5 22h14M5 2h14M17 22v-4.2a2 2 0 0 0-.6-1.4L12 12l-4.4 4.4a2 2 0 0 0-.6 1.4V22M7 2v4.2a2 2 0 0 0 .6 1.4L12 12l4.4-4.4a2 2 0 0 0 .6-1.4V2",
  sunset: "M12 10V3M8.5 6.5L12 10l3.5-3.5M4.9 11.9l1.4 1.4M19.1 11.9l-1.4 1.4M2 18h2M20 18h2M16 18a4 4 0 0 0-8 0M22 21H2",
  notes: "M6 4h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 2v4M12 2v4M16 2v4M8 11h8M8 15h8M8 19h5",
};

interface IconProps {
  name: IconName;
  size?: number;
  sw?: number;
  style?: CSSProperties;
  className?: string;
  fill?: string;
  /** Only for an icon that carries meaning on its own (no visible text or
   *  labelled control around it): it's then exposed as an image with this
   *  name. Without it the icon is decorative and hidden from assistive tech,
   *  so the button or text beside it provides the name. */
  "aria-label"?: string;
}

export function Icon({ name, size = 18, sw = 1.7, style, className, fill, "aria-label": label }: IconProps) {
  const d = ICONS[name];
  // focusable=false: old Edge/IE put every inline <svg> in the Tab order
  const a11y = label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || "none"}
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      {...a11y} focusable="false"
      className={className} style={{ flexShrink: 0, ...style }}>
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}
