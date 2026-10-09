/* ============================================================
   KANBO — Sidebar: workspace switcher, the five places (nav.ts),
   pinned and recent projects, the Focus pill and the account row.
   232px on --bg-deep; one scrolling column over a fixed footer.
   ============================================================ */
import { useState, useMemo, useEffect, useRef, useId } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Icon, Avatar, KanboLogo, Collapse, IconButton, Kbd, ProjectTile, SectionLabel, projectIdentity } from "./primitives";
import { Popover } from "./primitives/Popover";
import { MenuItem, MenuSeparator } from "./Topbar";
import { trialDaysLeft, BILLING_ENABLED } from "../lib/billing";
import { useToast } from "./Toast";
import type { Task, Project, Member, Workspace, Subscription, IconName, SavedSearch, Role } from "../data/types";
import type { Route } from "../app-types";
import { navItems, placeOf, type NavItem } from "../lib/nav";
import { canDeleteProject, canArchiveProject } from "../lib/permissions";
import { getMember } from "../data/data";
import { BREAK_MIN, type FocusTimer } from "../hooks/useFocusTimer";
import { InstallPrompt } from "./integrations/InstallPrompt";
import { prefetchProps } from "../lazyViews";

/* Sidebar-only rules, kept beside the component so the column's layout
   lives in one place. Tokens that are new in Paper & Navy are read with a
   fallback. Hover-revealed row actions also appear for KEYBOARD focus in
   their row (:has(:focus-visible)) and are always visible on touch screens.
   Not :focus-within on the row: Chrome focuses a button on mouse click, so
   the project or list you just opened would keep its actions stuck on
   screen (the rule kanbo.css follows for tag chips and saved lists). The
   :has() rules are separate, so a browser without :has() drops only them;
   there, tabbing onto an action still shows the group (.kproj-acts:focus-within). */
const SIDEBAR_CSS = `
.kskip:not(:focus) { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.kskip:focus { position: absolute; left: 12px; top: 10px; z-index: 30; padding: 8px 12px; border-radius: var(--r-md, 8px); background: var(--surface-raised); color: var(--ink); box-shadow: var(--e2, var(--shadow-lg)); font: 600 13px/20px var(--font-ui, var(--font-display)); text-decoration: none; }
main[tabindex="-1"]:focus { outline: none; }

.ksb {
  position: relative; z-index: 5; display: flex; flex-direction: column; flex-shrink: 0;
  width: var(--sidebar-w, 232px); height: 100%; background: var(--bg-deep); box-shadow: inset -1px 0 0 var(--hairline);
  color: var(--ink); font-family: var(--font-ui, var(--font-display));
}
.ksb-scroll { flex: 1 1 auto; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 12px 10px 16px; }

/* workspace switcher (44px) */
.ksb-ws {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 44px; padding: 0 8px 0 6px;
  border: 0; border-radius: var(--r-md, 8px); background: transparent; color: var(--ink); cursor: pointer; text-align: left;
  transition: background-color var(--d-1, 90ms) var(--ease);
}
.ksb-ws:hover, .ksb-ws[aria-expanded="true"] { background: var(--fill-1); }
.ksb-ws-mark { display: grid; place-items: center; flex-shrink: 0; width: 24px; height: 24px; border-radius: var(--r-sm, 6px); overflow: hidden; }
.ksb-ws-mark img { width: 100%; height: 100%; object-fit: cover; }
.ksb-ws-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 14px/20px var(--font-ui, var(--font-display)); }
.ksb-ws-chev { color: var(--icon-quiet, var(--ink-4)); transition: transform var(--d-2, 160ms) var(--ease); }
.ksb-ws[aria-expanded="true"] .ksb-ws-chev { transform: rotate(180deg); }
.ksb-wsi {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-2); cursor: pointer; text-align: left; font: 500 13px/20px var(--font-ui, var(--font-display));
}
.ksb-wsi[aria-current="true"] { color: var(--ink); font-weight: 600; }
.ksb-wsi img { width: 16px; height: 16px; border-radius: var(--r-xs, 4px); object-fit: cover; flex-shrink: 0; }
.ksb-wsi > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.ksb-wsi > svg.ksb-tick { color: var(--accent-text, var(--accent)); }
.ksb-menu-head { padding: 6px 8px 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* phone drawer only: search sits under the switcher (the header has it on desktop) */
.ksb-search {
  display: none; align-items: center; gap: 8px; width: 100%; height: 40px; margin-top: 8px; padding: 0 10px;
  border: 0; border-radius: var(--r-md, 8px); background: var(--fill-1); color: var(--ink-3); cursor: pointer; text-align: left;
  font: 500 14px/20px var(--font-ui, var(--font-display)); transition: background-color var(--d-1, 90ms) var(--ease);
}
/* (--ink-3, not the header field's --ink-4: on --fill-1 over the sidebar's
   deeper tint, --ink-4 falls just short of 4.5:1 in Paper) */
.ksb-search:hover, .ksb-search:active { background: var(--fill-2); }
.ksb-search > svg { color: var(--icon-quiet, var(--ink-4)); }

/* places */
.ksb-nav { display: flex; flex-direction: column; gap: 2px; margin-top: 8px; }
.ksb .ksection { min-height: 0; padding: 16px 8px 4px; }
.ksb .ksection-action { margin: -6px -4px -6px auto; }
.ksb .knav {
  position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px;
  border: 0; border-radius: var(--r-sm, 6px); background: transparent; box-shadow: none; cursor: pointer; text-align: left;
  font: 500 14px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
  transition: background-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.ksb .knav:hover { background: var(--fill-1); color: var(--ink); }
.ksb .knav-ico { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); transition: color var(--d-1, 90ms) var(--ease); }
.ksb .knav:hover .knav-ico { color: var(--ink-3); }
.ksb .knav[data-active="true"], .ksb .kproj[data-active="true"] {
  background: var(--surface-raised); color: var(--ink); font-weight: 600;
  box-shadow: var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06));
}
[data-theme="dark"] .ksb .knav[data-active="true"], [data-theme="dark"] .ksb .kproj[data-active="true"] { background: var(--surface-2); }
.ksb .knav[data-active="true"] .knav-ico { color: var(--accent-text, var(--accent)); }
.ksb .knav[data-nested] { height: 28px; gap: 8px; padding-left: 32px; font-size: 13px; }
.knav-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.knav-count { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.knav-count[data-tone="signal"] { color: var(--signal, var(--st-blocked)); font-weight: 600; }
.knav-pill {
  display: inline-grid; place-items: center; flex-shrink: 0; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: var(--accent-fill, var(--accent)); color: var(--on-accent); font: 500 11px/1 var(--font-mono); font-variant-numeric: tabular-nums;
}

/* saved views (nested under My tasks) */
.ksaved-row { position: relative; }
.ksb .ksaved-del {
  position: absolute; right: 2px; top: 50%; translate: 0 -50%; display: grid; place-items: center; width: 24px; height: 24px; padding: 0;
  border: 0; border-radius: var(--r-xs, 4px); background: var(--fill-2); color: var(--ink-3); cursor: pointer;
}
.ksb .ksaved-del:hover { color: var(--signal, var(--st-blocked)); background: color-mix(in oklch, var(--signal, var(--st-blocked)) 12%, transparent); }
/* the × itself is revealed by kanbo.css (hover / keyboard focus); its count
   badge steps aside so the two never overlap */
.ksaved-row:hover .knav-badge { visibility: hidden; }
.ksaved-row:has(:focus-visible) .knav-badge { visibility: hidden; }
/* …and a long name ends before it rather than under it */
.ksb .ksaved-row:hover > .knav { padding-right: 30px; }
.ksb .ksaved-row:has(:focus-visible) > .knav { padding-right: 30px; }

/* projects */
.ksb-projects { margin-top: 4px; }
.ksb .kproj {
  display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px 0 6px;
  border: 0; border-radius: var(--r-sm, 6px); background: transparent; box-shadow: none; cursor: pointer; text-align: left;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2);
  transition: background-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.ksb .kproj:hover { color: var(--ink); }
.kproj-list { display: flex; flex-direction: column; gap: 2px; }
.kproj-item { position: relative; display: flex; align-items: center; border-radius: var(--r-sm, 6px); }
.kproj-item > .kproj { flex: 1; min-width: 0; }
.kproj-item:hover > .kproj { padding-right: var(--kacts, 86px); }
.kproj-item:has(:focus-visible, .kproj-acts:focus-within) > .kproj { padding-right: var(--kacts, 86px); }
/* keep the row highlighted while the pointer is on its actions */
.ksb .kproj-item:hover > .kproj:not([data-active="true"]) { background: var(--fill-1); }
.kproj-name { flex: 1; min-width: 0; }
.kproj-n { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kproj-pinmark { display: inline-flex; color: var(--accent-text, var(--accent)); flex-shrink: 0; }
/* the open project: its colour as a 2px bar on the inside left edge (its tile
   is centred on the nav icons' 16px column) */
.ksb .kproj.kp[data-active="true"] { box-shadow: inset 2px 0 0 var(--p-fill), var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06)); }
.kproj-item:hover .kproj-n, .kproj-item:hover .kproj-pinmark { visibility: hidden; }
.kproj-item:has(:focus-visible, .kproj-acts:focus-within) :is(.kproj-n, .kproj-pinmark) { visibility: hidden; }
.kproj-acts { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); display: flex; align-items: center; gap: 1px; opacity: 0; pointer-events: none; transition: opacity var(--d-2, 160ms) var(--ease); }
.kproj-item:hover .kproj-acts, .kproj-acts:focus-within { opacity: 1; pointer-events: auto; }
.kproj-item:has(:focus-visible) .kproj-acts { opacity: 1; pointer-events: auto; }
.kproj-act { display: grid; place-items: center; width: 24px; height: 24px; padding: 0; border: none; border-radius: var(--r-xs, 4px); background: transparent; color: var(--ink-3); cursor: pointer; transition: color var(--d-1, 90ms), background-color var(--d-1, 90ms); }
.kproj-act:hover { color: var(--ink); background: var(--fill-2, color-mix(in oklch, var(--ink) 8%, transparent)); }
.kproj-act[data-on="true"] { color: var(--accent-text, var(--accent)); }
.kproj-act[data-kind="delete"]:hover { color: var(--signal, var(--st-blocked)); background: color-mix(in oklch, var(--signal, var(--st-blocked)) 12%, transparent); }
.ksb-quiet {
  display: flex; align-items: center; gap: 8px; width: 100%; height: 28px; padding: 0 8px 0 10px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-3); cursor: pointer; text-align: left; font: 600 12px/16px var(--font-ui, var(--font-display));
  transition: background-color var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease);
}
.ksb-quiet:hover { background: var(--fill-1); color: var(--ink-2); }
.ksb-quiet[aria-current="page"] { background: var(--fill-1); color: var(--ink); font-weight: 600; }
.ksb-quiet > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.ksb-all { margin-top: 2px; padding-left: 12px; color: var(--accent-text, var(--accent)); }
.ksb-all:hover { color: var(--accent-text, var(--accent)); }
.ksb-all > svg { color: currentColor; transition: translate var(--d-1, 90ms) var(--ease); }
.ksb-all:hover > svg { translate: 2px 0; }
.ksb-empty { margin: 0; padding: 4px 8px 8px 12px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.ksb-link { padding: 0; border: 0; background: none; font: inherit; color: var(--accent-text, var(--accent)); cursor: pointer; text-decoration: underline; text-decoration-color: color-mix(in oklch, currentColor 40%, transparent); text-underline-offset: 3px; }
.ksb-link:hover { text-decoration-color: currentColor; }
.ksb-arch-row { display: flex; align-items: center; gap: 10px; height: 28px; padding: 0 2px 0 8px; }
.ksb-arch-row > .kptile { opacity: 0.7; }
.ksb-arch-row > span:nth-child(2) { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }

/* footer: billing, the Focus pill, the account row */
.ksb-foot { flex-shrink: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; padding: 8px 10px 12px; box-shadow: inset 0 1px 0 var(--hairline); }
.ksb-bill {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 6px 10px; border-radius: var(--r-md, 8px);
  border: 1px solid var(--hairline); background: var(--surface); cursor: pointer; text-align: left; color: var(--ink);
}
.ksb-bill[data-trial="true"] { background: var(--bg-selected, var(--accent-dim)); border-color: transparent; }
.ksb-bill:hover { border-color: var(--hairline-strong); }
.ksb-focus {
  position: relative; display: flex; align-items: center; gap: 2px; height: 36px; padding: 0 4px 0 0;
  border-radius: var(--r-md, 8px); background: var(--surface-raised); box-shadow: var(--e1, 0 0 0 1px var(--hairline), 0 1px 2px oklch(0.2 0.03 268 / 0.06));
}
[data-theme="dark"] .ksb-focus { background: var(--surface); }
.ksb-focus-main {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: 100%; padding: 0 6px 0 10px;
  border: 0; border-radius: var(--r-md, 8px); background: transparent; color: var(--ink); cursor: pointer; text-align: left;
  font: 600 13px/20px var(--font-ui, var(--font-display)); transition: background-color var(--d-1, 90ms) var(--ease);
}
.ksb-focus[data-idle] .ksb-focus-main { padding-right: 6px; }
.ksb-focus-main:hover { background: var(--fill-1); }
.ksb-focus-main > svg { flex-shrink: 0; }
.ksb-focus-play { color: var(--accent-text, var(--accent)); }
.ksb-focus-time { flex-shrink: 0; font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.ksb-focus[data-paused] .ksb-focus-time { color: var(--ink-3); }
.ksb-focus-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 500; color: var(--ink-2); }
.ksb-me { display: flex; align-items: center; gap: 2px; height: 36px; }
.ksb-me-btn {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 6px;
  border: 0; border-radius: var(--r-sm, 6px); background: transparent; color: var(--ink); cursor: pointer; text-align: left;
  font: 500 13px/20px var(--font-ui, var(--font-display)); transition: background-color var(--d-1, 90ms) var(--ease);
}
.ksb-me-btn:hover, .ksb-me-btn[aria-expanded="true"] { background: var(--fill-1); }
.ksb-me-btn:disabled { cursor: default; background: transparent; }
.ksb-me-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ksb-me-fallback { display: grid; place-items: center; width: 24px; height: 24px; flex-shrink: 0; border-radius: 50%; background: var(--fill-2); color: var(--ink-3); }
.ksb-acct-head { padding: 6px 8px 8px; margin-bottom: 4px; box-shadow: inset 0 -1px 0 var(--hairline); }
.ksb-acct-head b { display: block; font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.ksb-acct-head span { display: block; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ksb [data-tip]::after { z-index: 40; }
/* The scrolling column clips anything that leaves it, and its only tooltip
   buttons (New project, Restore) sit at its right edge: their tooltips grow
   leftwards from that edge instead of centring on the button. */
.ksb-scroll [data-tip]::after { left: auto; right: 0; transform: translate(0, 2px); }
.ksb-scroll [data-tip]:hover::after { transform: none; }

/* the phone drawer: a 300px sheet with touch-sized rows */
@media (max-width: 860px) {
  .ksb { width: min(300px, 86vw); }
  .kskip { display: none; }   /* the drawer opens on the switcher, not a skip link */
  .ksb-search { display: flex; }
  .ksb .knav { height: 40px; font-size: 15px; }
  .ksb .knav[data-nested] { height: 36px; font-size: 14px; }
  .ksb .kproj { height: 36px; font-size: 14px; }
  .ksb-quiet { height: 36px; }
  .ksb-foot { padding-bottom: max(12px, env(safe-area-inset-bottom, 0px)); }
}

@media (hover: none), (pointer: coarse) {
  /* no hover on touch: the actions sit in the row, always reachable */
  .kproj-acts { position: static; transform: none; opacity: 1; pointer-events: auto; padding-right: 2px; }
  .kproj-item:hover > .kproj { padding-right: 8px; }
  .kproj-item:has(:focus-visible, .kproj-acts:focus-within) > .kproj { padding-right: 8px; }
  .kproj-item .kproj-n, .kproj-item .kproj-pinmark { display: none; }
  .kproj-act { width: 32px; height: 32px; }
  /* …except the one-tap Archive: permanently shown beside Delete on a phone
     it's an easy mis-tap that hides the project for the whole team. On touch,
     archiving goes through the project's own Archive action (which confirms
     first) or Delete's "Archive instead". */
  .kproj-act[data-kind="archive"] { display: none; }
  .ksaved-del { opacity: 1; }
  .ksb .ksaved-del { width: 32px; height: 32px; }
  .ksaved-row .knav-badge { visibility: hidden; }
  /* (as specific as the hover rules above, and later, so a tap's sticky hover can't undo it) */
  .ksb .ksaved-row > .knav[data-nested] { min-height: 32px; padding-right: 38px; }
}

@media (prefers-reduced-motion: reduce) {
  .ksb-ws-chev, .ksb-all > svg { transition: none !important; }
  .ksb-all:hover > svg { translate: none; }
}
`;

/** Most projects the sidebar lists (pinned first, then the most recently opened). */
const MAX_PROJECTS = 8;
/** Saved views nested under My tasks; the rest are a "More…" away. */
const MAX_SAVED = 3;

function StarGlyph({ filled, size = 14 }: { filled?: boolean; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
      fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth={2} strokeLinejoin="round">
      <path d="M12 3.6l2.55 5.2 5.75.84-4.16 4.05.98 5.72L12 16.72l-5.12 2.69.98-5.72-4.16-4.05 5.75-.84z" />
    </svg>
  );
}

/** Focus the element with this id, or the first <main>, for the skip link. */
function focusMain(): boolean {
  const m = (document.getElementById("main") ?? document.querySelector("main")) as HTMLElement | null;
  if (!m) return false;
  if (!m.hasAttribute("tabindex")) m.setAttribute("tabindex", "-1");
  m.focus();
  return true;
}

const recentKey = (userId: string) => `kanbo-recent-projects:${userId}`;
function readRecent(userId: string): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(recentKey(userId)) || "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch { return []; }
}

/* ---------------- Focus pill ---------------- */

/** A 16px ring filled (in the brand gradient) as the interval runs. */
function FocusRing({ progress }: { progress: number }) {
  const gid = "kfr" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const r = 6.25, c = 2 * Math.PI * r;
  const p = Math.min(1, Math.max(0, progress));
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="1" y1="1" x2="15" y2="15">
          <stop offset="0" stopColor="#5B7CFA" />
          <stop offset="0.52" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#C24BE0" />
        </linearGradient>
      </defs>
      <circle cx={8} cy={8} r={r} fill="none" strokeWidth={2} style={{ stroke: "var(--track, var(--fill-2))" }} />
      <circle cx={8} cy={8} r={r} fill="none" strokeWidth={2} strokeLinecap="round" stroke={`url(#${gid})`}
        strokeDasharray={c} strokeDashoffset={c * (1 - p)} transform="rotate(-90 8 8)" />
    </svg>
  );
}

/** Idle: "Focus" with its F key. Running or paused: the ring, mm:ss, the task,
 *  and pause / end. Clicking the pill opens Focus mode. */
function FocusPill({ focus, onOpen, taskTitle }: { focus: FocusTimer; onOpen: () => void; taskTitle?: string }) {
  const toast = useToast();
  const { running, setRunning, seconds, endSession, focusMinToday, phase, targetMin } = focus;
  const active = running || seconds > 0;
  const banked = focusMinToday > 0
    ? `${Math.floor(focusMinToday / 60) ? `${Math.floor(focusMinToday / 60)}h ` : ""}${focusMinToday % 60}m banked today`
    : "";

  if (!active) {
    return (
      <div className="ksb-focus" data-idle="">
        <button type="button" className="ksb-focus-main" onClick={onOpen} aria-keyshortcuts="F"
          title={banked ? `Start a focus session · ${banked}` : "Start a focus session"}>
          <Icon name="play" size={14} fill="currentColor" className="ksb-focus-play" />
          <span style={{ flex: 1 }}>Focus</span>
          <span aria-hidden="true"><Kbd>F</Kbd></span>
        </button>
      </div>
    );
  }

  const onBreak = phase === "break";
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const target = (onBreak ? BREAK_MIN : targetMin || 25) * 60;
  const label = onBreak ? "Break" : taskTitle || "Focus";
  // break time is never banked (endSession returns 0), so ending a break says
  // so instead of implying the session was too short, as FocusMode does
  const end = () => {
    const m = endSession();
    if (m > 0) toast.success(`Banked ${m}m of deep work`);
    else toast.toast(onBreak ? "Break ended" : "Too short to bank");
  };
  return (
    <div className="ksb-focus" data-paused={!running || undefined}>
      <button type="button" className="ksb-focus-main" onClick={onOpen} aria-keyshortcuts="F" title="Open focus mode">
        <FocusRing progress={seconds / target} />
        <span className="ksb-focus-time">{mm}:{ss}</span>
        <span className="ksb-focus-title">{label}</span>
        <span className="sr-only">{running ? ", running. Open focus mode" : ", paused. Open focus mode"}</span>
      </button>
      <IconButton size="sm" icon={running ? "pause" : "play"} label={running ? "Pause focus" : "Resume focus"} onClick={() => setRunning((v) => !v)} />
      <IconButton size="sm" icon="check" label="End focus session" onClick={end} />
    </div>
  );
}

/* ---------------- place rows ---------------- */

/** A place's icon: nav.ts names them; Projects wears the Kanbo mark. */
const PLACE_ICON: Partial<Record<NavItem["id"], IconName>> = { projects: "kanbo" };

export function Sidebar({ route, setRoute, workspace, setWorkspace, workspaces, focus, openFocus, tasks, projects, inboxCount, currentUserId, currentUser, onSignOut, onOpenSettings, onNewProject, onDeleteProject, onArchiveProject, onRestoreProject, onNewWorkspace, subscription, onUpgrade, onManageBilling, savedSearches = [], savedSearchCounts, onDeleteSavedSearch, myRole, guardRoute = true, theme, onToggleTheme, teamBadge, onOpenSearch, onOpenShortcuts }: {
  route: Route;
  setRoute: (r: Route) => void;
  workspace: string | null;
  setWorkspace: (id: string | null) => void;
  workspaces: Workspace[];
  onNewWorkspace: () => void;
  focus: FocusTimer;
  openFocus: () => void;
  tasks: Task[];
  projects: Project[];
  inboxCount: number;
  currentUserId: string;
  currentUser?: Member;
  onSignOut?: () => void;
  onOpenSettings?: () => void;
  onNewProject: () => void;
  onDeleteProject: (id: string) => void;
  onArchiveProject?: (id: string) => void;
  onRestoreProject?: (id: string) => void;
  subscription?: Subscription | null;
  onUpgrade: () => void;
  onManageBilling: () => void;
  /** (ignored: the smart lists moved into My tasks and ⌘K) */
  smartCounts?: Record<string, number>;
  savedSearches?: SavedSearch[];
  savedSearchCounts?: Record<string, number>;
  /** may return a promise — a rejection shows an error toast and brings the list back */
  onDeleteSavedSearch?: (id: string) => void | Promise<unknown>;
  /** the caller's role in the active workspace; gates project archive/delete (mirrors 0041) */
  myRole?: Role | null;
  /**
   * The Sidebar keeps the open project valid: it follows a project opened from
   * another workspace (palette, search) by switching to that workspace, and
   * leaves a project that was archived, deleted or left behind by a workspace
   * change. Pass false only if App takes over that job — never run both, or
   * every redirect fires (and toasts) twice.
   */
  guardRoute?: boolean;
  /** with onToggleTheme: the footer's sun / moon button */
  theme?: "light" | "dark";
  onToggleTheme?: () => void;
  /** Radar's risk count, shown on Team (team workspaces) */
  teamBadge?: number;
  /** opens the palette: the drawer's search row and saved views' "More…" */
  onOpenSearch?: () => void;
  /** the account menu's "Keyboard shortcuts" (Settings › Shortcuts) */
  onOpenShortcuts?: () => void;
}) {
  const toast = useToast();
  const uid = useId();
  const projectsLabelId = `${uid}-projects`;
  const [wsOpen, setWsOpen] = useState(false);
  const wsBtnRef = useRef<HTMLButtonElement>(null);
  const wsCurrentRef = useRef<HTMLButtonElement>(null);
  const [acctOpen, setAcctOpen] = useState(false);
  const acctRef = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState<Set<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("kanbo-pinned-projects") || "[]")); } catch { return new Set(); } });
  const togglePin = (id: string) => setPinned((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); try { localStorage.setItem("kanbo-pinned-projects", JSON.stringify([...n])); } catch { /* private mode */ } return n; });
  const [archivedOpen, setArchivedOpen] = useState(false);
  const visibleProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && !p.archivedAt);
  const archivedProjects = projects.filter((p) => (p.workspaceId ?? null) === workspace && p.archivedAt);
  const activeWs: Workspace = workspaces.find((w) => w.id === workspace) || workspaces[0] || { id: null, name: "Personal", kind: "personal" };
  const guest = myRole === "guest";
  const ctx = { personal: activeWs.kind === "personal", guest, admin: myRole === "owner" || myRole === "admin" };
  const place = placeOf(route);
  const activeProjectId = route.view === "project" ? route.projectId : undefined;

  // the projects you open, most recent first: they fill the list after the pinned ones
  const [recent, setRecent] = useState<string[]>(() => readRecent(currentUserId));
  useEffect(() => {
    if (!activeProjectId || activeProjectId.startsWith("tmp-")) return;
    setRecent((prev) => {
      if (prev[0] === activeProjectId) return prev;
      const next = [activeProjectId, ...prev.filter((x) => x !== activeProjectId)].slice(0, 24);
      try { localStorage.setItem(recentKey(currentUserId), JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
  }, [activeProjectId, currentUserId]);

  // Pinned first (stable), then the rest in their own order. Past eight, the
  // most recently opened make the cut, but rows keep their places: opening a
  // project never reshuffles the list under the pointer. The open project is
  // always listed.
  const listedProjects = useMemo(() => {
    const ordered = [...visibleProjects].sort((a, b) => (pinned.has(b.id) ? 1 : 0) - (pinned.has(a.id) ? 1 : 0));
    if (ordered.length <= MAX_PROJECTS) return ordered;
    const order = activeProjectId ? [activeProjectId, ...recent.filter((x) => x !== activeProjectId)] : recent;
    const rank = new Map(order.map((id, i) => [id, i]));
    const keep: string[] = ordered.filter((p) => pinned.has(p.id)).slice(0, MAX_PROJECTS).map((p) => p.id);
    const rest = ordered.filter((p) => !pinned.has(p.id))
      .sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    for (const p of rest) { if (keep.length >= MAX_PROJECTS) break; keep.push(p.id); }
    if (activeProjectId && !keep.includes(activeProjectId) && ordered.some((p) => p.id === activeProjectId)) keep[keep.length - 1] = activeProjectId;
    const kept = new Set(keep);
    return ordered.filter((p) => kept.has(p.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, workspace, pinned, recent, activeProjectId]);

  // Badges count what the matching page shows as rows: open tasks, with a
  // sub-task counted only when its parent isn't in the same list (otherwise
  // it nests under the parent). "Mine" = assignee OR collaborator, exactly
  // like the My tasks view. One O(n) pass; the memo only pays off when the
  // caller passes a stable `tasks` array (App currently rebuilds it per render).
  const { projectOpen, myOpen } = useMemo(() => {
    const idsByProject = new Map<string, Set<string>>();
    const mineIds = new Set<string>();
    for (const t of tasks) {
      let set = idsByProject.get(t.projectId);
      if (!set) idsByProject.set(t.projectId, (set = new Set()));
      set.add(t.id);
      if (t.assigneeId === currentUserId || (t.collaborators ?? []).includes(currentUserId)) mineIds.add(t.id);
    }
    const perProject = new Map<string, number>();
    let mine = 0;
    for (const t of tasks) {
      if (t.status === "done" || t.archivedAt) continue;
      if (!t.parentId || !idsByProject.get(t.projectId)?.has(t.parentId)) perProject.set(t.projectId, (perProject.get(t.projectId) ?? 0) + 1);
      if (mineIds.has(t.id) && (!t.parentId || !mineIds.has(t.parentId))) mine += 1;
    }
    return { projectOpen: perProject, myOpen: mine };
  }, [tasks, currentUserId]);
  // delete follows 0041's DELETE policy (owner/admin/project owner); archive and
  // restore are plain updates any writer may make, so members can undo their own archive
  const canDelete = (p: Project) => canDeleteProject(p, { currentUserId, myRole, workspaceOwnerId: activeWs.ownerId });
  const canArchive = (p: Project) => canArchiveProject(p, { myRole });

  // switching workspace never strands you on a project from the old one
  // (its header would read "0 tasks" and quick-add would file into it)
  const switchWorkspace = (id: string | null) => {
    setWsOpen(false);
    if (id === workspace) return;
    setWorkspace(id);
    if (route.view === "project") {
      const p = projects.find((x) => x.id === route.projectId);
      if (!p || (p.workspaceId ?? null) !== id) setRoute({ view: "plan" });
    }
  };
  // the workspace menu: ↑/↓ move between its rows (Popover moves focus in and
  // closes on Escape; Tab closes it too, carrying on from the switcher)
  const onWsKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("button"));
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Tab") {
      e.preventDefault();
      setWsOpen(false);
      wsBtnRef.current?.focus();
    }
  };

  // …and neither does a teammate archiving or deleting the project you're in,
  // nor a workspace change made elsewhere. Opening a project that lives in
  // another workspace (the palette and Search list every workspace) follows it
  // there instead of bouncing you to Today. `seenProjectId` tells "you navigated
  // to a project" apart from "the workspace changed under an open project".
  const lastProject = useRef<{ id: string; name: string } | null>(null);
  const seenProjectId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!guardRoute) return;
    const id = route.view === "project" ? route.projectId : undefined;
    const navigated = id !== seenProjectId.current;
    seenProjectId.current = id;
    if (!id) return;
    if (id.startsWith("tmp-")) return; // still being created — the id is about to change
    const p = projects.find((x) => x.id === id);
    if (p && !p.archivedAt) {
      lastProject.current = { id, name: p.name };
      if ((p.workspaceId ?? null) === workspace) return;
      if (navigated) { setWorkspace(p.workspaceId ?? null); return; }
    }
    const name = p?.name ?? (lastProject.current?.id === id ? lastProject.current.name : null);
    if (!p) {
      // only trust "it's gone" when the rest of this workspace's projects are
      // still here — a failed refetch returns an empty list, not a deletion
      const siblings = projects.some((x) => x.id !== "p-personal" && (x.workspaceId ?? null) === workspace);
      if (!siblings) return;
      setRoute({ view: "plan" });
      toast.toast(name ? `“${name}” is no longer available — it may have been deleted.` : "That project is no longer available — it may have been deleted.");
      return;
    }
    setRoute({ view: "plan" });
    if (p.archivedAt) toast.toast(canArchive(p) ? `“${p.name}” was archived. You can restore it from Archived in the sidebar.` : `“${p.name}” was archived.`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.view, route.projectId, projects, workspace, guardRoute]);

  // saved lists: hide at once, delete for real only when the Undo window closes
  const [hiddenSaved, setHiddenSaved] = useState<Set<string>>(() => new Set());
  const unhideSaved = (id: string) => setHiddenSaved((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
  const removeSaved = (s: SavedSearch, from: HTMLElement) => {
    if (!onDeleteSavedSearch) return;
    // keep keyboard focus in the list instead of dropping it to <body>
    const row = from.closest(".ksaved-row");
    const near = (row?.nextElementSibling ?? row?.previousElementSibling) as HTMLElement | null | undefined;
    const nextFocus = near?.matches("button") ? near : near?.querySelector<HTMLElement>("button");
    const hadFocus = document.activeElement === from;
    setHiddenSaved((prev) => new Set(prev).add(s.id));
    if (hadFocus) window.setTimeout(() => nextFocus?.focus(), 0);
    toast.action(`Removed “${s.name}”`, "Undo", () => unhideSaved(s.id), {
      onExpire: () => {
        let result: void | Promise<unknown>;
        try { result = onDeleteSavedSearch(s.id); } catch (e) { result = Promise.reject(e); }
        Promise.resolve(result)
          .then(() => unhideSaved(s.id))
          .catch(() => { unhideSaved(s.id); toast.error(`Couldn't remove “${s.name}”. Please try again.`); });
      },
    });
  };
  const savedAll = savedSearches.filter((s) => !hiddenSaved.has(s.id));
  const savedShown = savedAll.slice(0, MAX_SAVED);
  const savedActive = route.view === "search" && !!route.list && savedShown.some((s) => s.id === route.list);
  const openSearch = onOpenSearch ?? (() => setRoute({ view: "search" }));

  const items = navItems(ctx);
  // the most specific row is the current page: an open saved view rather than
  // My tasks, an open project's own row rather than Projects
  const projectActive = !!activeProjectId && listedProjects.some((p) => p.id === activeProjectId);
  const isActive = (n: NavItem) => (n.id === "insights" ? place === "team" : n.id === place)
    && !(n.id === "tasks" && savedActive) && !(n.id === "projects" && projectActive);
  const navRow = (n: NavItem) => {
    const active = isActive(n);
    let trailing: JSX.Element | null = null;
    let name: string | undefined;
    if (n.id === "inbox" && inboxCount > 0) {
      trailing = <span className="knav-pill" aria-hidden="true">{inboxCount > 99 ? "99+" : inboxCount}</span>;
      name = `${n.label}, ${inboxCount} unread`;
    } else if (n.id === "tasks" && myOpen > 0) {
      trailing = <span className="knav-count" aria-hidden="true">{myOpen}</span>;
      name = `${n.label}, ${myOpen} open`;
    } else if (n.id === "team" && !ctx.personal && teamBadge && teamBadge > 0) {
      trailing = <span className="knav-count" data-tone="signal" aria-hidden="true">{teamBadge}</span>;
      name = `${n.label}, ${teamBadge} at risk`;
    }
    return (
      <button key={n.id} type="button" className="knav" data-active={active || undefined} aria-current={active ? "page" : undefined}
        aria-label={name} onClick={() => setRoute(n.route)} {...prefetchProps(n.route)}>
        <Icon name={PLACE_ICON[n.id] ?? n.icon} size={16} sw={1.75} className="knav-ico" />
        <span className="knav-label">{n.label}</span>
        {trailing}
      </button>
    );
  };
  const savedRows = (
    <>
      {savedShown.map((s) => {
        const active = route.view === "search" && route.list === s.id;
        const count = savedSearchCounts?.[s.id];
        return (
          <div key={s.id} className="ksaved-row">
            <button type="button" className="knav" data-nested="" data-active={active || undefined} aria-current={active ? "page" : undefined}
              aria-label={count != null ? `${s.name}, ${count} ${count === 1 ? "task" : "tasks"}` : undefined}
              onClick={() => setRoute({ view: "search", list: s.id })} {...prefetchProps({ view: "search", list: s.id })}>
              <Icon name="filter" size={14} sw={1.75} className="knav-ico" />
              <span className="knav-label">{s.name}</span>
              {count != null && <span className="knav-count knav-badge" aria-hidden="true">{count}</span>}
            </button>
            {onDeleteSavedSearch && (
              <button type="button" onClick={(e) => { e.stopPropagation(); removeSaved(s, e.currentTarget); }} aria-label={`Remove saved list ${s.name}`} title="Remove saved list"
                className="ksaved-del">
                <Icon name="x" size={12} sw={2} />
              </button>
            )}
          </div>
        );
      })}
      {savedAll.length > MAX_SAVED && (
        <button type="button" className="knav" data-nested="" onClick={openSearch} aria-label={`More saved views, ${savedAll.length - MAX_SAVED} more`}>
          <Icon name="more" size={14} sw={1.75} className="knav-ico" />
          <span className="knav-label">More…</span>
          <span className="knav-count" aria-hidden="true">{savedAll.length - MAX_SAVED}</span>
        </button>
      )}
    </>
  );

  const openTaskTitle = focus.taskId ? tasks.find((t) => t.id === focus.taskId)?.title : undefined;
  const displayName = currentUser?.name || "You";
  const hasAcctMenu = !!(onOpenSettings || onOpenShortcuts || onSignOut);
  const acct = (run?: () => void) => () => { setAcctOpen(false); run?.(); };

  return (
    <aside aria-label="Sidebar" className="ksb">
      <style>{SIDEBAR_CSS}</style>
      <a href="#main" className="kskip" onClick={(e) => { if (focusMain()) e.preventDefault(); }}>Skip to main content</a>

      <div className="ksb-scroll">
        {/* workspace */}
        <button ref={wsBtnRef} type="button" className="ksb-ws" onClick={() => setWsOpen((v) => !v)} aria-expanded={wsOpen} aria-haspopup="dialog"
          aria-label={`Switch workspace, current: ${activeWs.name}`}>
          <span className="ksb-ws-mark" aria-hidden="true">
            {activeWs.logoUrl ? <img src={activeWs.logoUrl} alt="" /> : <KanboLogo size={20} />}
          </span>
          <span className="ksb-ws-name">{activeWs.name}</span>
          <Icon name="chevronDown" size={14} sw={1.75} className="ksb-ws-chev" />
        </button>
        <Popover open={wsOpen} anchorRef={wsBtnRef} onClose={() => setWsOpen(false)} role="dialog" label="Workspaces" minWidth={212}
          initialFocus={wsCurrentRef} style={{ padding: 4 }}>
          <div onKeyDown={onWsKey}>
            <div className="ksb-menu-head" aria-hidden="true">Workspaces</div>
            {workspaces.map((w) => {
              const current = w.id === workspace;
              return (
                <button key={w.id ?? "personal"} ref={current ? wsCurrentRef : undefined} type="button" className="ksb-wsi"
                  onClick={() => switchWorkspace(w.id)} aria-current={current ? "true" : undefined}>
                  {w.logoUrl ? <img src={w.logoUrl} alt="" /> : <Icon name={w.kind === "personal" ? "user" : "briefcase"} size={16} sw={1.75} />}
                  <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{w.name}</span>
                  {current && <Icon name="check" size={14} sw={2} className="ksb-tick" />}
                </button>
              );
            })}
            <MenuSeparator />
            <button type="button" className="ksb-wsi" onClick={() => { setWsOpen(false); onNewWorkspace(); }}>
              <Icon name="plus" size={16} sw={1.75} />
              <span style={{ flex: 1 }}>New workspace…</span>
            </button>
          </div>
        </Popover>

        {onOpenSearch && (
          <button type="button" className="ksb-search" onClick={onOpenSearch}>
            <Icon name="search" size={16} sw={1.75} />
            <span style={{ flex: 1 }}>Search or ask Kanbo</span>
          </button>
        )}

        {/* places */}
        <nav aria-label="Main" className="ksb-nav">
          {items.filter((n) => n.group === "me").map((n) => (
            n.id === "tasks" ? <div key={n.id} style={{ display: "contents" }}>{navRow(n)}{savedRows}</div> : navRow(n)
          ))}
          {ctx.personal ? <div aria-hidden="true" style={{ height: 12 }} /> : <SectionLabel>Team</SectionLabel>}
          {items.filter((n) => n.group === "team").map(navRow)}
        </nav>

        {/* projects */}
        <div className="ksb-projects">
          <SectionLabel id={projectsLabelId}
            action={!guest && <IconButton size="sm" icon="plus" label="New project" onClick={onNewProject} />}>
            Projects
          </SectionLabel>
          {visibleProjects.length === 0 ? (
            <p className="ksb-empty">
              {guest ? "No projects yet" : <>No projects yet · <button type="button" className="ksb-link" onClick={onNewProject}>Create one</button></>}
            </p>
          ) : (
            <div role="list" aria-labelledby={projectsLabelId} className="kproj-list">
              {listedProjects.map((p) => {
                const active = activeProjectId === p.id;
                const count = projectOpen.get(p.id) ?? 0;
                const deletable = canDelete(p);
                const archivable = !!onArchiveProject && canArchive(p);
                const isPinned = pinned.has(p.id);
                // room the name leaves for the action group when it's revealed
                const reserve = (1 + (archivable ? 1 : 0) + (deletable ? 1 : 0)) * 25 + 8;
                return (
                  <div key={p.id} role="listitem" className="kproj-item" style={{ "--kacts": `${reserve}px` } as CSSProperties}>
                    <button type="button" onClick={() => setRoute({ view: "project", projectId: p.id })} {...prefetchProps({ view: "project", projectId: p.id })} className="kproj kp" style={projectIdentity(p).style} data-active={active || undefined} aria-current={active ? "page" : undefined}>
                      <ProjectTile project={p} size={20} />
                      <span className="truncate kproj-name">{p.name}</span>
                      {isPinned && <span className="kproj-pinmark" aria-hidden="true"><StarGlyph filled size={11} /></span>}
                      {isPinned && <span className="sr-only">, pinned</span>}
                      {count > 0 && <span className="kproj-n">{count}<span className="sr-only"> open {count === 1 ? "task" : "tasks"}</span></span>}
                    </button>
                    <div className="kproj-acts">
                      <button type="button" className="kproj-act" data-on={isPinned} aria-pressed={isPinned}
                        aria-label={`Pin project ${p.name}`} title={isPinned ? "Unpin" : "Pin to top"}
                        onClick={(e) => { e.stopPropagation(); togglePin(p.id); }}>
                        <StarGlyph filled={isPinned} />
                      </button>
                      {archivable && (
                        <button type="button" className="kproj-act" data-kind="archive" aria-label={`Archive project ${p.name}`} title="Archive project"
                          onClick={(e) => { e.stopPropagation(); onArchiveProject!(p.id); }}>
                          <Icon name="archive" size={14} sw={1.75} />
                        </button>
                      )}
                      {deletable && (
                        <button type="button" className="kproj-act" data-kind="delete" aria-label={`Delete project ${p.name}`} title="Delete project"
                          onClick={(e) => { e.stopPropagation(); onDeleteProject(p.id); }}>
                          <Icon name="trash" size={14} sw={1.75} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {visibleProjects.length > 0 && (
            <button type="button" className="ksb-quiet ksb-all" onClick={() => setRoute({ view: "projects" })} {...prefetchProps({ view: "projects" })}>
              <span>All projects</span>
              <Icon name="arrowRight" size={14} sw={2} />
              {visibleProjects.length > listedProjects.length && (
                <span className="mono" style={{ marginLeft: "auto", fontSize: 11, fontWeight: 500, color: "var(--ink-3)" }}>{visibleProjects.length}</span>
              )}
            </button>
          )}

          {/* archived projects */}
          {archivedProjects.length > 0 && (
            <div style={{ marginTop: 2 }}>
              <button type="button" className="ksb-quiet" onClick={() => setArchivedOpen((v) => !v)} aria-expanded={archivedOpen}>
                <Icon name="chevronRight" size={14} sw={1.75} style={{ transform: archivedOpen ? "rotate(90deg)" : "none", transition: "transform var(--d-2, 160ms) var(--ease)" }} />
                <span style={{ flex: 1 }}>Archived</span>
                <span className="mono" style={{ fontSize: 11, fontWeight: 500 }}>{archivedProjects.length}</span>
              </button>
              <Collapse open={archivedOpen}>{archivedProjects.map((p) => (
                <div key={p.id} className="ksb-arch-row">
                  <ProjectTile project={p} size={16} />
                  <span>{p.name}</span>
                  {onRestoreProject && canArchive(p) && (
                    <IconButton size="sm" icon="refresh" label={`Restore project ${p.name}`} onClick={(e) => { e.stopPropagation(); onRestoreProject(p.id); }} />
                  )}
                </div>
              ))}</Collapse>
            </div>
          )}

          {/* 0047: deleted tasks and projects wait here for 30 days */}
          <button type="button" className="ksb-quiet" onClick={() => setRoute({ view: "bin" })} {...prefetchProps({ view: "bin" })} aria-current={route.view === "bin" ? "page" : undefined}>
            <Icon name="trash" size={14} sw={1.75} />
            <span style={{ flex: 1 }}>Recycle bin</span>
          </button>
        </div>
      </div>

      <div className="ksb-foot">
        {/* the one-time "Install Kanbo" card: nothing unless the browser offers an
            install and it hasn't been dismissed on this device */}
        <InstallPrompt variant="nudge" />
        {/* billing */}
        {BILLING_ENABLED && subscription && (
          <button type="button" className="ksb-bill" data-trial={subscription.status === "trialing" || undefined}
            onClick={subscription.status === "active" ? onManageBilling : onUpgrade}>
            <Icon name="sparkles" size={16} sw={1.75} style={{ color: "var(--accent-text, var(--accent))", flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", font: "600 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink)" }}>
                {subscription.status === "active" ? (subscription.plan === "team" ? "Team plan" : "Personal plan")
                  : subscription.status === "trialing" ? "Free trial" : "Inactive"}
              </span>
              <span style={{ display: "block", font: "500 12px/16px var(--font-ui, var(--font-display))", color: "var(--ink-3)" }}>
                {subscription.status === "active" ? "Manage billing"
                  : subscription.status === "trialing" ? `${trialDaysLeft(subscription)} day${trialDaysLeft(subscription) === 1 ? "" : "s"} left · Upgrade` : "Reactivate"}
              </span>
            </span>
          </button>
        )}

        <FocusPill focus={focus} onOpen={openFocus} taskTitle={openTaskTitle} />

        {/* you */}
        <div className="ksb-me">
          <button ref={acctRef} type="button" className="ksb-me-btn" disabled={!hasAcctMenu}
            aria-label={hasAcctMenu ? `${displayName}, account` : undefined}
            aria-haspopup={hasAcctMenu ? "menu" : undefined} aria-expanded={hasAcctMenu ? acctOpen : undefined}
            onClick={() => setAcctOpen((v) => !v)}>
            {getMember(currentUserId)
              ? <Avatar id={currentUserId} size={24} />
              : <span className="ksb-me-fallback" aria-hidden="true"><Icon name="user" size={14} sw={1.75} /></span>}
            <span className="ksb-me-name">{displayName}</span>
          </button>
          {theme && onToggleTheme && (
            <IconButton size="sm" icon={theme === "dark" ? "sun" : "moon"} label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={onToggleTheme} />
          )}
          {onOpenSettings && <IconButton size="sm" icon="settings" label="Settings" onClick={onOpenSettings} />}
        </div>
        <Popover open={acctOpen} anchorRef={acctRef} onClose={() => setAcctOpen(false)} side="top" label="Account" minWidth={212} style={{ padding: 4 }}>
          {/* (a menu may own only its items, so this card is visual: the
              trigger names the person, and Settings › Account has the email) */}
          <div className="ksb-acct-head" role="none" aria-hidden="true">
            <b className="truncate">{displayName}{currentUser?.pronouns && <span style={{ display: "inline", fontWeight: 500 }}> · {currentUser.pronouns}</span>}</b>
            {currentUser?.email && <span>{currentUser.email}</span>}
          </div>
          {onOpenSettings && <MenuItem icon="settings" label="Settings" kbd="⌘," onClick={acct(onOpenSettings)} />}
          {onOpenShortcuts && <MenuItem icon="keyboard" label="Keyboard shortcuts" kbd="?" onClick={acct(onOpenShortcuts)} />}
          {onSignOut && (
            <>
              {(onOpenSettings || onOpenShortcuts) && <MenuSeparator />}
              <MenuItem icon="logout" label="Sign out" onClick={acct(() => { toast.flush(); onSignOut(); })} />
            </>
          )}
        </Popover>
      </div>
    </aside>
  );
}
