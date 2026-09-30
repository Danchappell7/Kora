/* ============================================================
   KANBO — PageHeader: one 56px row per page (title and meta on
   the left; page actions, "Search or ask Kanbo" and the New task
   split button on the right), an optional 2px momentum line and
   an optional 44px tabs row. There is no separate top bar.
   Phones get a 52px row (44px once the page scrolls) with search
   and the account button; the switcher and tabs scroll sideways
   in a 40px row underneath.
   `Topbar` stays exported as a thin alias for the old call sites.
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { Icon, Avatar, KanboLogo, Segmented, Button, IconButton, Kbd, Tabs, type TabItem } from "./primitives";
import { Popover } from "./primitives/Popover";
import { getMember } from "../data/data";
import type { IconName } from "../data/types";

/* The header's layout lives beside it (like the Sidebar's). Tokens that are
   new in Paper & Navy are read with a fallback, so it renders correctly
   before and after the token pass. */
const HEADER_CSS = `
.kph { position: sticky; top: 0; z-index: var(--z-header, 10); flex-shrink: 0; min-width: 0; background: transparent; transition: background-color var(--d-2, 160ms) var(--ease); }
.kph[data-stuck="true"] { background: var(--bg); }
.kph-row { display: flex; align-items: center; gap: 12px; min-width: 0; height: var(--header-h, 56px); padding: 0 var(--gutter, 32px); }
.kph:not([data-mobile]):not([data-tabs]):not([data-momentum]) > .kph-row { box-shadow: inset 0 -1px 0 var(--hairline); }
.kph-lead { display: flex; align-items: center; gap: 12px; flex: 1 1 auto; min-width: 0; }
.kph-leading { display: inline-flex; align-items: center; flex-shrink: 0; }
.kph .kph-title {
  flex: 0 1 auto; min-width: 0; margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-wrap: nowrap;
  font: 600 20px/28px var(--font-head); letter-spacing: -0.012em; color: var(--ink);
}
/* the title keeps its room and a long meta gives way (it starts from zero and
   takes what's left); beside a title add-on it sizes to its text instead */
.kph-meta { flex: 1 1 0%; min-width: 0; padding-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kph[data-addon] .kph-meta { flex: 0 1 auto; }
.kph-addon { display: flex; align-items: center; gap: 8px; flex-shrink: 0; min-width: 0; }
.kph-end { display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
.kph-actions { display: flex; align-items: center; gap: 8px; }
.kph-sep { flex-shrink: 0; width: 1px; height: 16px; margin: 0 4px; background: var(--hairline-strong); }

/* Search or ask Kanbo: a quiet 240px field that opens the palette */
.kph-search {
  display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; width: 240px; height: var(--h-md, 32px); padding: 0 6px 0 10px;
  border: 0; border-radius: var(--r-sm, 6px); background: var(--fill-1); color: var(--ink-4); cursor: pointer; text-align: left;
  font: 500 13px/20px var(--font-ui, var(--font-display));
  transition: background-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.kph-search:hover { background: var(--fill-2); color: var(--ink-3); }
.kph-search > svg { color: var(--icon-quiet, var(--ink-4)); }
.kph-search-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kph .kph-search-ico { display: none; }
/* below 1280 the field folds into an icon when the row is busy (a switcher,
   page actions or a title add-on); below 1024 it always does */
@media (max-width: 1279px) {
  .kph[data-busy] .kph-search { display: none; }
  .kph[data-busy] .kph-search-ico { display: inline-grid; }
}
@media (max-width: 1023px) {
  .kph .kph-search { display: none; }
  .kph .kph-search-ico { display: inline-grid; }
}

/* New task: a primary split button */
.kph-create { display: inline-flex; align-items: stretch; flex-shrink: 0; }
.kph .kph-create-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
.kph .kph-create-more {
  width: 28px; padding: 0; border-top-left-radius: 0; border-bottom-left-radius: 0;
  box-shadow: inset 1px 0 0 color-mix(in oklch, var(--on-accent) 26%, transparent);
}
.kph .kph-create-more svg { transition: transform var(--d-2, 160ms) var(--ease); }
.kph .kph-create-more[aria-expanded="true"] svg { transform: rotate(180deg); }

/* momentum: 2px, the day's done share in the brand gradient */
.kph-momentum { position: relative; height: 2px; overflow: hidden; background: var(--fill-1); }
.kph-momentum-fill {
  position: absolute; inset: 0 auto 0 0; max-width: 100%; border-radius: 0 2px 2px 0;
  background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%));
  transition: width var(--d-3, 240ms) var(--ease);
}
.kph-tabs > .ktabs { padding: 0 var(--gutter, 32px); }

/* tooltips hang below the header's icon buttons (above, they'd leave the window) */
.kph [data-tip]::after { top: calc(100% + 8px); bottom: auto; }

/* ---- phone ---- */
.kph-sentinel { flex-shrink: 0; height: 8px; margin-bottom: -8px; pointer-events: none; }
.kph[data-mobile] > .kph-row { height: 52px; gap: 10px; padding: 0 16px; transition: height var(--d-2, 160ms) var(--ease); }
.kph[data-mobile] .kph-lead { gap: 10px; }
.kph[data-mobile] .kph-title { font-size: 18px; line-height: 24px; letter-spacing: -0.01em; transition: font-size var(--d-2, 160ms) var(--ease); }
.kph[data-mobile] .kph-meta { padding-top: 1px; font-size: 11px; }
.kph[data-mobile][data-stuck="true"] > .kph-row { height: 44px; }
.kph[data-mobile][data-stuck="true"] .kph-title { font-size: 16px; }
.kph[data-mobile] .kph-end { gap: 4px; margin-right: -6px; }
.kph-glyph { display: inline-flex; flex-shrink: 0; }
.kph-me {
  position: relative; display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; padding: 0;
  border: 0; border-radius: 50%; background: transparent; color: var(--ink-3); cursor: pointer;
}
.kph-me-fallback { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--fill-2); }
.kph[data-mobile] :is(.kibtn, .kph-me)::before {
  content: ""; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; translate: -50% -50%;
}
.kph-sub {
  display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px;
  overflow-x: auto; overflow-y: hidden; scrollbar-width: none; overscroll-behavior-x: contain;
}
.kph-sub::-webkit-scrollbar { display: none; }
.kph-sub > * { flex-shrink: 0; }
.kph[data-mobile] .kph-tabs > .ktabs { height: 40px; padding: 0 16px; }
.kph[data-mobile]:not([data-tabs]) > :last-child { box-shadow: inset 0 -1px 0 var(--hairline); }
.kph[data-mobile][data-momentum]:not([data-tabs]) > .kph-momentum:last-child { box-shadow: none; }

@media (prefers-reduced-motion: reduce) {
  .kph, .kph-row, .kph-title, .kph-momentum-fill, .kph .kph-create-more svg { transition: none !important; }
}
`;

/* ---------------- menu item (shared with the Sidebar's account menu) ---------------- */

const MENU_ITEM: CSSProperties = {
  display: "flex", alignItems: "center", gap: 10, width: "100%", height: 32, padding: "0 8px",
  border: 0, borderRadius: "var(--r-sm, 6px)", background: "transparent", cursor: "pointer", textAlign: "left",
  color: "var(--ink)", font: "500 13px/20px var(--font-ui, var(--font-display))", whiteSpace: "nowrap",
};

/** One row of a chrome menu (inside a Popover): a 16px quiet icon, the label
 *  and an optional shortcut. Popover supplies the hover and focus styles. */
export function MenuItem({ icon, label, kbd, onClick }: {
  icon?: IconName;
  label: string;
  /** a shortcut hint, shown on the right (visual only) */
  kbd?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" style={MENU_ITEM} onClick={onClick}>
      {icon && <Icon name={icon} size={16} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />}
      <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{label}</span>
      {kbd && <span aria-hidden="true" style={{ display: "inline-flex" }}><Kbd>{kbd}</Kbd></span>}
    </button>
  );
}

/** A hairline between groups of menu items. */
export function MenuSeparator() {
  return <div role="separator" style={{ height: 1, margin: "4px 0", background: "var(--hairline)" }} />;
}

/* ---------------- PageHeader ---------------- */

export interface PageHeaderProps {
  title: string;
  meta?: string;
  leading?: ReactNode;
  titleAddon?: ReactNode;
  switcher?: { items: { id: string; label: string }[]; value: string; onChange: (id: string) => void; label: string };
  actions?: ReactNode;
  tabs?: TabItem[];
  tabValue?: string;
  onTab?: (id: string) => void;
  tabsLabel?: string;
  tabsTrailing?: ReactNode;
  /** 0..1: the 2px progress line under the header (Today) */
  momentum?: number | null;
  /** the momentum line's accessible name, e.g. "Today's work done, 2 of 7" */
  momentumLabel?: string;
  onSearch: () => void;
  /** null hides New task (guests). Menu items without a handler are left out. */
  create: { onNewTask: () => void; onQuickCapture?: () => void; onPasteNotes?: () => void; onImport?: () => void; onNewProject?: () => void } | null;
  isMobile?: boolean;
  onOpenSettings?: () => void;
  userId?: string;
  /** phone: a menu button before the title (the old drawer trigger; the bottom bar's More replaces it) */
  onMenu?: () => void;
}

/** Sets data-stuck once the page has scrolled 8px, from a sentinel placed
 *  just above the sticky header (an IntersectionObserver, no scroll listener). */
function useStuck(sentinel: RefObject<HTMLElement>): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([entry]) => setStuck(!entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, [sentinel]);
  return stuck;
}

function Momentum({ value, label }: { value: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
  return (
    <div className="kph-momentum" role="progressbar" aria-label={label ?? "Today's work done"}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="kph-momentum-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** "+ New task" with a chevron that opens every other way to create. */
function CreateSplit({ create }: { create: NonNullable<PageHeaderProps["create"]> }) {
  const [open, setOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // (closing hands focus back to the chevron before a dialog the item opens
  // takes it, so that dialog returns focus there when it closes)
  const pick = (run?: () => void) => () => { setOpen(false); run?.(); };
  return (
    <div className="kph-create" role="group" aria-label="Create">
      <Button variant="primary" icon="plus" className="kph-create-main" aria-keyshortcuts="C" onClick={create.onNewTask}>New task</Button>
      <Button ref={moreRef} variant="primary" icon="chevronDown" className="kph-create-more"
        aria-label="More ways to create" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((v) => !v)} />
      <Popover open={open} anchorRef={moreRef} onClose={() => setOpen(false)} align="end" label="Create" minWidth={232} style={{ padding: 4 }}>
        <MenuItem icon="plus" label="New task" kbd="C" onClick={pick(create.onNewTask)} />
        {create.onQuickCapture && <MenuItem icon="zap" label="Quick capture" kbd="Q" onClick={pick(create.onQuickCapture)} />}
        {create.onPasteNotes && <MenuItem icon="notes" label="Paste notes → tasks" onClick={pick(create.onPasteNotes)} />}
        {create.onImport && <MenuItem icon="layers" label="Import tasks…" onClick={pick(create.onImport)} />}
        {create.onNewProject && (
          <>
            <MenuSeparator />
            <MenuItem icon="kanbo" label="New project" onClick={pick(create.onNewProject)} />
          </>
        )}
      </Popover>
    </div>
  );
}

export function PageHeader({ title, meta, leading, titleAddon, switcher, actions, tabs, tabValue, onTab, tabsLabel, tabsTrailing, momentum, momentumLabel, onSearch, create, isMobile, onOpenSettings, userId, onMenu }: PageHeaderProps) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const stuck = useStuck(sentinelRef);
  const hasTabs = !!tabs && tabs.length > 0;
  const hasMomentum = momentum != null;
  const segmented = switcher && (
    <Segmented options={switcher.items.map((i) => ({ value: i.id, label: i.label }))} value={switcher.value} onChange={switcher.onChange} ariaLabel={switcher.label} />
  );
  const tabsRow = (trailing: ReactNode) => hasTabs && (
    <div className="kph-tabs">
      <Tabs items={tabs!} value={tabValue ?? ""} onChange={onTab ?? (() => {})} label={tabsLabel ?? title} mode="nav" trailing={trailing} />
    </div>
  );
  const searchLabel = "Search or ask Kanbo";

  if (isMobile) {
    const sub = segmented || titleAddon || (actions && !hasTabs);
    return (
      <>
        <div ref={sentinelRef} className="kph-sentinel" aria-hidden="true" />
        <header className="kph" data-mobile="" data-stuck={stuck || undefined} data-tabs={hasTabs || undefined} data-momentum={hasMomentum || undefined}>
          <div className="kph-row">
            {onMenu && <IconButton icon="menu" label="Open menu" onClick={onMenu} style={{ marginLeft: -6 }} />}
            <div className="kph-lead">
              {leading ? <span className="kph-leading">{leading}</span> : <span className="kph-glyph" aria-hidden="true"><KanboLogo size={20} /></span>}
              <h1 className="kph-title">{title}</h1>
              {meta && <span className="kph-meta">{meta}</span>}
            </div>
            <div className="kph-end">
              <IconButton icon="search" label={searchLabel} onClick={onSearch} />
              {onOpenSettings && (
                <button type="button" className="kph-me" aria-label="Settings" onClick={onOpenSettings}>
                  {userId && getMember(userId)
                    ? <Avatar id={userId} size={28} />
                    : <span className="kph-me-fallback"><Icon name="user" size={16} sw={1.75} /></span>}
                </button>
              )}
            </div>
          </div>
          {hasMomentum && <Momentum value={momentum!} label={momentumLabel} />}
          {sub && (
            <div className="kph-sub">
              {segmented}
              {titleAddon}
              {!hasTabs && actions}
            </div>
          )}
          {tabsRow(hasTabs && (tabsTrailing || actions) ? <>{tabsTrailing}{actions}</> : null)}
        </header>
        <style>{HEADER_CSS}</style>
      </>
    );
  }

  const busy = !!(segmented || actions || titleAddon);
  return (
    <>
      <div ref={sentinelRef} className="kph-sentinel" aria-hidden="true" />
      <header className="kph" data-stuck={stuck || undefined} data-busy={busy || undefined} data-addon={titleAddon ? "" : undefined} data-tabs={hasTabs || undefined} data-momentum={hasMomentum || undefined}>
        <div className="kph-row">
          <div className="kph-lead">
            {leading && <span className="kph-leading">{leading}</span>}
            <h1 className="kph-title" title={title}>{title}</h1>
            {meta && <span className="kph-meta">{meta}</span>}
            {titleAddon && <div className="kph-addon">{titleAddon}</div>}
          </div>
          <div className="kph-end">
            {segmented}
            {actions && <div className="kph-actions">{actions}</div>}
            {(segmented || actions) && <span className="kph-sep" aria-hidden="true" />}
            <button type="button" className="kph-search" aria-label={searchLabel} aria-keyshortcuts="Meta+K Control+K" onClick={onSearch}>
              <Icon name="search" size={14} sw={1.75} />
              <span className="kph-search-text">{searchLabel}</span>
              <span aria-hidden="true" style={{ display: "inline-flex" }}><Kbd>⌘K</Kbd></span>
            </button>
            <IconButton icon="search" label={searchLabel} className="kph-search-ico" aria-keyshortcuts="Meta+K Control+K" onClick={onSearch} />
            {create && <CreateSplit create={create} />}
          </div>
        </div>
        {hasMomentum && <Momentum value={momentum!} label={momentumLabel} />}
        {tabsRow(tabsTrailing)}
      </header>
      <style>{HEADER_CSS}</style>
    </>
  );
}

/* ---------------- Topbar (legacy alias) ---------------- */

/** The old top bar's props, drawn by PageHeader. The bell (now the Inbox
 *  badge), the theme button (now in the sidebar footer) and the breadcrumb
 *  kicker are gone: those props are still accepted and ignored. A caller
 *  that passes `onMenu` is on a phone. */
export function Topbar({ title, subtitle, children, onNewTask, onNewProject, onCommand, onMenu, canCreateProject = true }: {
  title?: string;
  subtitle?: string;
  /** (ignored) */
  breadcrumb?: string;
  /** drawn with the page actions */
  children?: ReactNode;
  /** without it there's no New task (guests) */
  onNewTask?: () => void;
  onNewProject?: () => void;
  onCommand: () => void;
  /** (ignored: the Inbox badge replaced the bell) */
  onBell?: () => void;
  onMenu?: () => void;
  /** (ignored: the theme button lives in the sidebar footer) */
  theme?: "light" | "dark";
  toggleTheme?: () => void;
  hasUnread?: boolean;
  unreadCount?: number;
  /** false hides "New project" (guests can view and comment, not create) */
  canCreateProject?: boolean;
}) {
  return (
    <PageHeader title={title ?? ""} meta={subtitle} actions={children} onSearch={onCommand}
      create={onNewTask ? { onNewTask, onNewProject: canCreateProject ? onNewProject : undefined } : null}
      isMobile={!!onMenu} onMenu={onMenu} />
  );
}
