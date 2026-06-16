/* ============================================================
   KANBO — mobile bottom tab bar (phone navigation)
   Sits in the main column below the scrolling view, so it never
   overlaps content. Secondary destinations live in the drawer.
   ============================================================ */
import { Icon } from "./primitives";
import type { Route } from "../app-types";
import type { IconName } from "../data/types";

const TABS: { id: Route["view"]; icon: IconName; label: string }[] = [
  { id: "plan", icon: "calendarPlus", label: "Plan" },
  { id: "home", icon: "home", label: "Home" },
  { id: "inbox", icon: "inbox", label: "Inbox" },
  { id: "tasks", icon: "tasks", label: "Tasks" },
  { id: "calendar", icon: "calendar", label: "Calendar" },
];

export function MobileNav({ route, setRoute, inboxCount }: {
  route: Route;
  setRoute: (r: Route) => void;
  inboxCount: number;
}) {
  return (
    <nav className="kanbo-safe-bottom" aria-label="Primary" style={{
      flexShrink: 0, display: "flex", paddingTop: 6,
      borderTop: "1px solid var(--hairline)",
      background: "color-mix(in oklch, var(--bg-deep) 82%, transparent)",
      backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)",
      position: "relative", zIndex: 6,
    }}>
      {TABS.map((t) => {
        const active = route.view === t.id;
        return (
          <button key={t.id} onClick={() => setRoute({ view: t.id })} aria-label={t.label} aria-current={active ? "page" : undefined}
            style={{
              flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
              padding: "5px 0 7px", minHeight: 52, border: "none", background: "transparent", cursor: "pointer",
              color: active ? "var(--accent)" : "var(--ink-4)", fontFamily: "var(--font-display)",
            }}>
            <span style={{ position: "relative", display: "grid", placeItems: "center" }}>
              <Icon name={t.icon} size={21} style={{ filter: active ? "drop-shadow(0 0 8px var(--accent-glow))" : undefined }} />
              {t.id === "inbox" && inboxCount > 0 && (
                <span className="mono" style={{ position: "absolute", top: -5, right: -8, minWidth: 15, height: 15, padding: "0 4px", borderRadius: 99, background: "var(--accent)", color: "var(--on-accent)", fontSize: 9.5, fontWeight: 700, display: "grid", placeItems: "center", lineHeight: 1 }}>
                  {inboxCount > 9 ? "9+" : inboxCount}
                </span>
              )}
            </span>
            <span style={{ fontSize: 10.5, fontWeight: active ? 600 : 500 }}>{t.label}</span>
          </button>
        );
      })}
    </nav>
  );
}
