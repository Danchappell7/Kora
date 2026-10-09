/* ============================================================
   KANBO — the Help (?) menu.                           [0048 → u1]
   A small "?" icon button with a menu (the primitives' Popover / menu
   pattern): Take the tour · Keyboard shortcuts (?) · Try the sample
   project / Remove the sample project · (optionally) Get set up again.
   The integrator mounts it in the sidebar's footer (desktop) and the
   account sheet (phones). Arrow keys move, Escape closes, focus returns.

   • variant "icon" (default): a 28px ghost icon button that fits the
     sidebar footer's account row beside Settings; "row": a labelled
     "Help" row for a list of rows (a drawer, a sheet).
   • The sample entry: "Try the sample project" makes "Kanbo tour" in
     Personal; once it exists, "Remove the sample project" (danger tone)
     takes it to the bin in one click. While either runs it's disabled
     and says so. `sample: null` hides it (guests).
   ============================================================ */
import { useRef, useState } from "react";
import { Icon, Kbd } from "../primitives";
import { Popover } from "../primitives/Popover";
import { TOUR_MINUTES } from "../../lib/onboarding";
import { CompassGlyph, HelpGlyph } from "./glyphs";

export interface HelpMenuProps {
  onStartTour: () => void;
  onOpenShortcuts?: () => void;
  /** the "Kanbo tour" sample project: exists → Remove; otherwise → Try it. null hides the entry (guests) */
  sample: { exists: boolean; busy?: boolean; onCreate: () => void; onRemove: () => void } | null;
  /** compact icon-only trigger (default) or a labelled row ("Help") */
  variant?: "icon" | "row";
  /** optional: the "Get set up" card was dismissed before it was finished — bring it back to Today */
  setup?: { done: number; total: number; onShow: () => void } | null;
}

export function HelpMenu({ onStartTour, onOpenShortcuts, sample, variant = "icon", setup }: HelpMenuProps) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const run = (fn: () => void) => () => { setOpen(false); fn(); };
  const busy = !!sample?.busy;

  return (
    <>
      <style>{HELP_CSS}</style>
      {variant === "row" ? (
        <button ref={btnRef} type="button" className="khelp-row" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <HelpGlyph size={16} className="khelp-row-ico" />
          <span className="khelp-row-label">Help</span>
          <Icon name="chevronRight" size={14} sw={1.75} className="khelp-row-chev" />
        </button>
      ) : (
        <button ref={btnRef} type="button" className="kibtn" data-size="sm" data-variant="ghost" aria-label="Help" data-tip="Help"
          aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          <HelpGlyph size={16} />
        </button>
      )}
      <Popover open={open} anchorRef={btnRef} onClose={() => setOpen(false)} role="menu" label="Help" side="top"
        align={variant === "row" ? "start" : "end"} minWidth={248} style={{ padding: 4 }}>
        <button type="button" role="menuitem" className="kmenu-item" onClick={run(onStartTour)}>
          <CompassGlyph size={16} className="khelp-ico" />
          <span className="khelp-label">Take the tour</span>
          <span className="khelp-aside" aria-hidden="true">{TOUR_MINUTES} min</span>
        </button>
        {onOpenShortcuts && (
          <button type="button" role="menuitem" className="kmenu-item" onClick={run(onOpenShortcuts)} aria-keyshortcuts="?">
            <Icon name="keyboard" size={16} sw={1.75} />
            <span className="khelp-label">Keyboard shortcuts</span>
            <span aria-hidden="true" className="khelp-kbd"><Kbd>?</Kbd></span>
          </button>
        )}
        {setup && setup.total > 0 && setup.done < setup.total && (
          <button type="button" role="menuitem" className="kmenu-item" onClick={run(setup.onShow)}>
            <Icon name="tasks" size={16} sw={1.75} />
            <span className="khelp-label">Get set up</span>
            <span className="khelp-aside">{setup.done} of {setup.total}</span>
          </button>
        )}
        {sample && (
          <>
            <div className="kmenu-sep" role="separator" />
            {sample.exists ? (
              <button type="button" role="menuitem" className="kmenu-item" data-tone="danger" disabled={busy} onClick={run(sample.onRemove)}>
                {busy ? <span className="kspin" aria-hidden="true" /> : <Icon name="trash" size={16} sw={1.75} />}
                <span className="khelp-label">{busy ? "Removing the sample project…" : "Remove the sample project"}</span>
              </button>
            ) : (
              <button type="button" role="menuitem" className="kmenu-item khelp-two" disabled={busy} onClick={run(sample.onCreate)}>
                {busy ? <span className="kspin" aria-hidden="true" /> : <Icon name="folder" size={16} sw={1.75} />}
                <span className="khelp-stack">
                  <span className="khelp-label">{busy ? "Making the sample project…" : "Try the sample project"}</span>
                  <span className="khelp-note">“Kanbo tour”, in Personal. Remove it here in one click.</span>
                </span>
              </button>
            )}
          </>
        )}
      </Popover>
    </>
  );
}

export const HELP_CSS = `
.khelp-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.khelp-aside { flex-shrink: 0; margin-left: auto; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.khelp-kbd { display: inline-flex; margin-left: auto; }
.kmenu-item > .khelp-ico { color: var(--icon-quiet); }
.kmenu-item.khelp-two { height: auto; min-height: 48px; padding-top: 6px; padding-bottom: 6px; align-items: flex-start; white-space: normal; }
.kmenu-item.khelp-two > svg, .kmenu-item.khelp-two > .kspin { margin-top: 2px; }
.khelp-stack { display: grid; flex: 1; min-width: 0; }
.khelp-note { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.khelp-row {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 36px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-2); cursor: pointer; text-align: left; font: 500 13px/20px var(--font-ui, var(--font-display));
  transition: background-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.khelp-row:hover, .khelp-row[aria-expanded="true"] { background: var(--fill-1); color: var(--ink); }
.khelp-row-ico { color: var(--icon-quiet); }
.khelp-row-label { flex: 1; min-width: 0; }
.khelp-row-chev { color: var(--icon-quiet); }
@media (max-width: 859px) { .khelp-row { height: 44px; font-size: 15px; } }
`;
