/* ============================================================
   KANBO — the Help (?) menu.                           [0048 stub → u1]
   A small "?" icon button with a menu (the primitives' Popover / menu
   pattern): Take the tour · Keyboard shortcuts (?) · Try the sample
   project / Remove the sample project · What's new (optional link).
   The integrator mounts it in the sidebar's footer (desktop) and the
   account sheet (phones). Arrow keys move, Escape closes, focus returns.
   Renders nothing until package u1 builds it.
   ============================================================ */
export interface HelpMenuProps {
  onStartTour: () => void;
  onOpenShortcuts?: () => void;
  /** the "Kanbo tour" sample project: exists → Remove; otherwise → Try it. null hides the entry (guests) */
  sample: { exists: boolean; busy?: boolean; onCreate: () => void; onRemove: () => void } | null;
  /** compact icon-only trigger (default) or a labelled row ("Help") */
  variant?: "icon" | "row";
}

export function HelpMenu(_props: HelpMenuProps) {
  return null;
}
