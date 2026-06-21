/* ============================================================
   KANBO — Icon (lucide-style stroke set)
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
};

interface IconProps {
  name: IconName;
  size?: number;
  sw?: number;
  style?: CSSProperties;
  className?: string;
  fill?: string;
}

export function Icon({ name, size = 18, sw = 1.7, style, className, fill }: IconProps) {
  const d = ICONS[name];
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={fill || "none"}
      stroke="currentColor" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={{ flexShrink: 0, ...style }}>
      {d.split("M").filter(Boolean).map((seg, i) => <path key={i} d={"M" + seg} />)}
    </svg>
  );
}
