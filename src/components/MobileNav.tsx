/* ============================================================
   KANBO — phone bottom bar: Today · My tasks · [+] · Inbox · More.
   Sits in the main column below the scrolling view, so it never
   overlaps content. More opens the sidebar drawer (projects, Team,
   Search, Settings, the workspace switcher). 56px plus the safe
   area, on --bg-deep, with no blur.
   ============================================================ */
import { Icon } from "./primitives";
import type { Route } from "../app-types";
import { PLACES, placeOf, type PlaceId } from "../lib/nav";

const MOBILE_CSS = `
.kmnav {
  position: relative; z-index: 6; flex-shrink: 0; display: flex; align-items: stretch;
  padding: 0 4px env(safe-area-inset-bottom, 0px); background: var(--bg-deep); box-shadow: inset 0 1px 0 var(--hairline);
}
.kmnav-slot {
  position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  height: 56px; padding: 0; border: 0; background: transparent; cursor: pointer; color: var(--ink-3);
  font: 500 11px/16px var(--font-ui, var(--font-display)); -webkit-tap-highlight-color: transparent;
  transition: color var(--d-1, 90ms) var(--ease);
}
.kmnav-slot[data-active="true"] { color: var(--accent-text, var(--accent)); font-weight: 600; }
.kmnav-slot:active:not([data-active="true"]) { color: var(--ink); }
.kmnav-slot:focus-visible { outline-offset: -4px; border-radius: var(--r-md, 8px); }
.kmnav-ico { position: relative; display: grid; place-items: center; width: 24px; height: 24px; }
.kmnav-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kmnav-badge {
  position: absolute; top: -5px; left: 14px; display: inline-grid; place-items: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 999px; background: var(--accent-fill, var(--accent)); color: var(--on-accent);
  font: 500 11px/1 var(--font-mono); font-variant-numeric: tabular-nums; box-shadow: 0 0 0 2px var(--bg-deep);
}
/* a plain primary fill: the glow belongs to the one hero action on the page */
.kmnav-plus {
  display: grid; place-items: center; width: 48px; height: 40px; border-radius: var(--r-md, 8px);
  background: var(--accent-fill, var(--accent)); color: var(--on-accent);
  transition: background-color var(--d-1, 90ms) var(--ease), transform var(--d-1, 90ms) var(--ease);
}
.kmnav-slot:active .kmnav-plus { background: var(--accent-hover, var(--accent-strong)); transform: translateY(0.5px); }
@media (prefers-reduced-motion: reduce) { .kmnav-slot:active .kmnav-plus { transform: none; } }
`;

const place = (id: PlaceId) => PLACES.find((p) => p.id === id)!;

export function MobileNav({ route, setRoute, inboxCount, onCapture, onMore, moreOpen = false }: {
  route: Route;
  setRoute: (r: Route) => void;
  inboxCount: number;
  /** the centre +: quick capture (hidden without it, e.g. for guests) */
  onCapture?: () => void;
  /** More: opens the sidebar drawer (hidden without it) */
  onMore?: () => void;
  /** the drawer More opens is open (More's aria-expanded) */
  moreOpen?: boolean;
  /** a Personal workspace (no team). The bar's slots are the same either way;
   *  the drawer's Team group reads Insights. */
  personal?: boolean;
}) {
  const here = placeOf(route);
  const slot = (id: "today" | "tasks" | "inbox") => {
    const { icon, label, route: to } = place(id);
    const active = here === id;
    const unread = id === "inbox" && inboxCount > 0;
    return (
      <button key={id} type="button" className="kmnav-slot" data-active={active || undefined} aria-current={active ? "page" : undefined}
        aria-label={unread ? `${label}, ${inboxCount} unread` : label} onClick={() => setRoute(to)}>
        <span className="kmnav-ico">
          <Icon name={icon} size={22} sw={1.75} />
          {unread && <span className="kmnav-badge" aria-hidden="true">{inboxCount > 99 ? "99+" : inboxCount}</span>}
        </span>
        <span className="kmnav-label" aria-hidden="true">{label}</span>
      </button>
    );
  };
  // Projects and Team live behind More: say so, to the eye and to screen
  // readers ("current"), while you're in one of them
  const inMore = here === "projects" || here === "team";
  return (
    <nav className="kmnav" aria-label="Primary">
      <style>{MOBILE_CSS}</style>
      {slot("today")}
      {slot("tasks")}
      {onCapture && (
        <button type="button" className="kmnav-slot" aria-label="Quick capture" aria-keyshortcuts="Q" onClick={onCapture}>
          <span className="kmnav-plus"><Icon name="plus" size={22} sw={2} /></span>
        </button>
      )}
      {slot("inbox")}
      {onMore && (
        <button type="button" className="kmnav-slot" data-active={inMore || undefined} aria-current={inMore ? "true" : undefined}
          aria-label="More" aria-haspopup="dialog" aria-expanded={moreOpen} onClick={onMore}>
          <span className="kmnav-ico"><Icon name="menu" size={22} sw={1.75} /></span>
          <span className="kmnav-label" aria-hidden="true">More</span>
        </button>
      )}
    </nav>
  );
}
