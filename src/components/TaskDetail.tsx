/* ============================================================
   KANBO — the task panel
   480px on the right. Docked beside the list at ≥ 1280px (no scrim,
   and the list stays live), an overlay with a soft dim below that,
   and a full-screen sheet on phones.
   Header: breadcrumb · Follow · Copy link · ⋯ · Close.
   Body: title, property list, "Kanbo suggests", description,
   sub-tasks, dependencies, files and one activity timeline, with the
   composer pinned underneath. Empty sections stay out of the way.
   ============================================================ */
import { useState, useEffect, useRef, useMemo, useId, forwardRef, useImperativeHandle } from "react";
import type { ReactNode, RefObject, MutableRefObject, Dispatch, SetStateAction, KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  Icon, Avatar, AvatarStack, Check, EmojiPicker, Button, IconButton, Kbd, StatusGlyph, PriorityGlyph,
  DateChip, AiMark, Meter, Pill, ProjectChip, ProjectTile, projectIdentity, projectPaint,
} from "./primitives";
import { Popover } from "./primitives/Popover";
import { useFocusTrap, isEditableTarget } from "../hooks/useFocusTrap";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { TagPicker } from "./TagPicker";
import { useToast } from "./Toast";
import { store } from "../data/store";
import { renderRich } from "../lib/richtext";
import { saveTemplate } from "../lib/templates";
import { reportError } from "../lib/monitoring";
import { loadAppearance } from "../lib/appearance";
import {
  getProject, getMember, dueState, fmtDue, KANBO_TODAY, ENERGY, DEMO_TASK_EVENTS,
  STATUS_META, STATUS_ORDER, PRIORITY_META, nextDueDate, nextOccurrence, seriesAnchorDay,
} from "../data/data";
import { timelineStartPatch } from "./tasks/otherViewsLogic";
import { NotionLinkChip } from "./NotionLinkChip";
import type {
  Task, TagDef, Comment, Activity, WorkspaceMember, Recurrence, Status, Priority, IconName, Project,
  CustomFieldDef, CustomValue, Section, Attachment, EnergyKind,
} from "../data/types";
import {
  resolveMentions, dependencyCandidates, wouldCreateCycle, activityLine, isTextEntry,
  canDeleteAttachment, readDraft, writeDraft, stashUnsaved, dropUnsaved, takeUnsaved,
  consequenceOf, slipNote, dueMoves, eventText, buildTimeline, shortDay, dayLabel, ago, fmtHours, parseHours,
  type MentionCandidate, type UnsavedField, type HistoryEvent,
} from "./taskDetailHelpers";

const REACTION_EMOJIS = ["👍", "❤️", "🎉", "👀", "✅", "🚀"];
const RECUR_LABEL: Record<Recurrence, string> = { none: "Doesn't repeat", daily: "Daily", weekdays: "Every weekday", weekly: "Weekly", biweekly: "Every 2 weeks", monthly: "Monthly" };
const CONFLICT_MSG = "Someone else changed this while you were editing. Overwrite with your version?";
// signed download links last an hour; refresh well before they lapse
const FILES_REFRESH_MS = 45 * 60 * 1000;
const NEW_SECTION = "__new-section";

const fmtBytes = (n: number): string => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
};

/** the next few due dates of a repeating task. Every step keeps the series'
 *  day, so a task due 31 Jan previews 28 Feb · 31 Mar · 30 Apr. */
function nextOccurrences(task: Pick<Task, "dueDate" | "originalDueDate">, recurrence: Recurrence, n = 3): string[] {
  const out: string[] = [];
  const anchor = seriesAnchorDay(task);
  let cur = task.dueDate;
  for (let i = 0; i < n; i++) { cur = nextDueDate(cur, recurrence, anchor); out.push(cur); }
  return out;
}

// TaskDetail can render outside a ToastProvider (tests, embeds) — toasts are then a no-op
function useOptionalToast() {
  try { return useToast(); } catch { return null; }
}

/* ============================================================
   Styles. Scoped to the panel (ktd-*), token-driven with a fallback
   for every token that's new in Paper & Navy.
   ============================================================ */
const UI = "var(--font-ui, var(--font-display))";
const PANEL_CSS = `
.ktd-scrim { position: fixed; inset: 0; z-index: var(--z-panel, 60); background: var(--scrim-soft, oklch(0.2 0.03 268 / 0.12)); animation: fadeIn var(--d-3, 240ms) var(--ease); }
.ktd {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: var(--z-panel, 60);
  width: var(--detail-w, 480px); max-width: 100%; display: flex; flex-direction: column;
  background: var(--bg); color: var(--ink); border-left: 1px solid var(--hairline);
  box-shadow: -12px 0 32px -16px oklch(0.2 0.03 268 / 0.18);
  animation: ktdIn var(--d-3, 240ms) var(--ease); outline-offset: -3px;
}
[data-theme="dark"] .ktd { box-shadow: none; }
.ktd[data-mobile="true"] { width: 100%; border-left: 0; box-shadow: none; animation-name: ktdUp; }
@keyframes ktdIn { from { opacity: 0.35; translate: 16px 0; } }
@keyframes ktdUp { from { opacity: 0.35; translate: 0 24px; } }
.ktd-inner { flex: 1; min-height: 0; display: flex; flex-direction: column; }

/* header */
.ktd-head { display: flex; align-items: center; gap: 2px; flex-shrink: 0; height: 52px; padding: 0 12px 0 24px; border-bottom: 1px solid var(--hairline); }
.ktd[data-mobile="true"] .ktd-head { height: calc(52px + env(safe-area-inset-top, 0px)); padding: env(safe-area-inset-top, 0px) 8px 0 16px; }
/* the task's project: its colour as a 3px edge along the panel's top, and its chip (tile + name › section) */
.ktd.kp[data-project]::before { content: ""; position: absolute; top: 0; left: 0; right: 0; z-index: 2; height: 3px; background: var(--p-fill); pointer-events: none; }
.ktd[data-mobile="true"].kp[data-project]::before { top: env(safe-area-inset-top, 0px); }
.ktd-crumb { display: flex; align-items: center; gap: 4px; flex: 1; min-width: 0; margin-right: 8px; font: 500 12px/16px ${UI}; color: var(--ink-3); }
.ktd-crumb > .kpchip { flex: 0 1 auto; margin-left: -3px; }
.ktd-crumb .kpchip-sep { display: inline-flex; flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.ktd-crumb-link { min-width: 0; max-width: 60%; flex-shrink: 1; margin: 0 -4px; padding: 4px; border: 0; border-radius: var(--r-xs, 4px); background: none; font: inherit; color: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ktd-crumb-link:hover { color: var(--ink); background: var(--fill-1); }
.ktd-crumb-sep { color: var(--ink-4); flex-shrink: 0; }
.ktd-crumb-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ktd-presence { display: inline-flex; align-items: center; margin-right: 6px; }
/* side by side, rings touching: a 20px disc has no room to tuck under its neighbour's
   3px ring and keep its initials whole */
.ktd-presence > span + span { margin-left: 0; }
.ktd-presence-more { margin-left: 4px; font: 500 11px/16px var(--font-mono); color: var(--ink-3); }
.ktd-vsep { width: 1px; height: 16px; margin: 0 6px; background: var(--hairline-strong); flex-shrink: 0; }
.ktd-head [data-tip]::after { top: calc(100% + 6px); bottom: auto; }
/* the ⋯ menu opens where the header's tooltips would: hush them while it's out */
.ktd-head[data-menu-open="true"] [data-tip]::after { display: none; }
.ktd-head .ktd-tip-end[data-tip]::after, .ktd-head .ktd-tip-end[data-tip]:hover::after { left: auto; right: 0; transform: none; translate: none; }

/* ⋯ menu */
.ktd-menuwrap { position: relative; display: inline-flex; }
.ktd-menuwrap > .kibtn[aria-expanded="true"] { background: var(--fill-2); color: var(--ink); }
.ktd-menu, .ktd-pop {
  min-width: 212px; padding: 4px; border-radius: var(--r-lg, 12px);
  background: linear-gradient(var(--surface-raised), var(--surface-raised)), var(--surface-solid);
  box-shadow: var(--e2, 0 0 0 1px var(--hairline), var(--shadow-lg));
}
.ktd-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 5; animation: ktdMenuIn var(--d-2, 160ms) var(--ease); }
.ktd-menu[hidden] { display: none; }
@keyframes ktdMenuIn { from { opacity: 0.35; translate: 0 4px; } }
.ktd-mi { display: flex; align-items: center; gap: 10px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; font: 500 13px/20px ${UI}; color: var(--ink); text-align: left; cursor: pointer; white-space: nowrap; }
.ktd-mi > svg { color: var(--icon-quiet, var(--ink-4)); }
.ktd-mi:hover, .ktd-mi:focus-visible { background: var(--fill-1); }
.ktd-mi:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ktd-mi[data-tone="danger"], .ktd-mi[data-tone="danger"] > svg { color: var(--signal, var(--st-blocked)); }
.ktd-mi-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.ktd-mi-note { font: 500 12px/16px ${UI}; color: var(--ink-3); }
.ktd-mi-check { flex-shrink: 0; margin-left: 8px; color: var(--accent-text, var(--accent)) !important; }
/* a menu opened with the mouse doesn't ring its current option (the check marks it) until a key is pressed */
.ktd-pop-quiet[data-kpop-panel] .ktd-mi:focus-visible:not(:hover) { outline: none; background: transparent !important; }
.ktd-mi-ico { display: inline-grid; place-items: center; min-width: 16px; height: 20px; flex: none; }
.ktd-msep { height: 1px; margin: 4px; background: var(--hairline); }
.ktd-pop-label { padding: 8px 8px 4px; font: 600 12px/16px ${UI}; color: var(--ink-3); }
.ktd-pop-search { display: block; width: 100%; height: 32px; margin-bottom: 4px; padding: 0 10px; border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); font: 500 13px/20px ${UI}; color: var(--ink); }
.ktd-pop-search::placeholder { color: var(--ink-4); }
.ktd-pop-empty { padding: 6px 8px; font: 500 12px/16px ${UI}; color: var(--ink-3); }

/* body */
.ktd-body { position: relative; flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 24px 32px; }
.ktd[data-mobile="true"] .ktd-body { padding: 16px 16px 24px; }
.ktd-body[data-drop="true"] { outline: 2px dashed var(--accent); outline-offset: -8px; }
.ktd-parent { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; margin: -2px 0 6px -6px; padding: 2px 6px; border: 0; border-radius: var(--r-sm, 6px); background: none; font: 500 12px/20px ${UI}; color: var(--ink-3); cursor: pointer; }
.ktd-parent:hover { background: var(--fill-1); color: var(--ink-2); }
.ktd-parent b { font-weight: 600; color: var(--ink-2); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ktd-titlerow { display: flex; align-items: flex-start; gap: 12px; }
.ktd-glyph { display: flex; padding-top: 4px; flex-shrink: 0; }
.ktd-title { flex: 1; min-width: 0; margin: 0 0 0 -4px; padding: 0 4px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; resize: none; overflow: hidden; font: 600 20px/28px var(--font-head, var(--font-display)); letter-spacing: -0.012em; color: var(--ink); overflow-wrap: anywhere; }
textarea.ktd-title:hover { background: var(--fill-1); }
textarea.ktd-title:focus { background: transparent; }
.ktd-title[data-done="true"] { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); text-decoration-thickness: 1.5px; }
.ktd-reacts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 10px 0 0 32px; position: relative; }
.ktd-react { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border-radius: 999px; border: 1px solid var(--hairline); background: transparent; font: 500 13px/1 ${UI}; color: var(--ink-2); cursor: pointer; }
.ktd-react:hover { background: var(--fill-1); }
.ktd-react[aria-pressed="true"] { border-color: var(--accent-line, var(--accent)); background: var(--bg-selected, var(--accent-dim)); }
.ktd-react[data-static="true"] { cursor: default; }
.ktd-react[data-quiet="true"] { opacity: 0.6; }
.ktd-react .mono, .ktd-react-n { font: 500 11px/1 var(--font-mono); color: var(--ink-3); }
.ktd-pickfloat { position: absolute; top: calc(100% + 6px); left: 0; z-index: 6; }
.ktd-pickfloat[data-up="true"] { top: auto; bottom: calc(100% + 4px); }

/* property list */
.ktd-props { display: grid; grid-template-columns: 96px minmax(0, 1fr); column-gap: 8px; row-gap: 2px; margin: 16px 0 0; }
.ktd[data-mobile="true"] .ktd-props { grid-template-columns: 88px minmax(0, 1fr); }
.ktd-prop { display: contents; }
.ktd-props dt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/32px ${UI}; color: var(--ink-3); }
.ktd-props dt label { cursor: inherit; }
.ktd-props dd { margin: 0; min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 0 8px; min-height: 32px; }
.ktd-val {
  position: relative; display: inline-flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%;
  min-height: 32px; margin-left: -8px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: transparent;
  font: 500 13px/20px ${UI}; color: var(--ink); text-align: left; cursor: pointer;
  transition: background var(--d-1, 90ms) var(--ease);
}
.ktd-val:hover, .ktd-val[aria-expanded="true"], .ktd-val[data-open="true"] { background: var(--fill-1); }
.ktd-val[data-wide="true"] { flex: 1 1 auto; }
.ktd-val[data-wrap="true"] { flex-wrap: wrap; padding-top: 6px; padding-bottom: 6px; row-gap: 4px; column-gap: 12px; }
.ktd-val[data-empty="true"], .ktd-val[data-empty="true"] .ktd-val-text { color: var(--ink-4); }
.ktd-val[data-empty="true"]:hover .ktd-val-text { color: var(--ink-2); }
.ktd-val[data-static="true"] { cursor: default; }
.ktd-val[data-static="true"]:hover { background: transparent; }
.ktd-val[data-small="true"] { min-height: 24px; margin-left: 0; padding: 0 8px; gap: 6px; font-size: 12px; color: var(--ink-2); background: var(--fill-1); }
.ktd-val[data-small="true"]:hover { background: var(--fill-2); }
/* the real control: a transparent native select over the whole value (its own focus ring shows) */
.ktd-val > select {
  position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0; border: 0; border-radius: inherit;
  background: transparent; color: transparent; appearance: none; -webkit-appearance: none; cursor: pointer; font-size: 16px;
  background-image: none !important; padding-right: 0 !important;   /* the row draws its own chevron */
}
.ktd-val > select option { color: var(--ink); background: var(--surface-solid, var(--bg)); }
.ktd-val-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ktd-val-sub { font: 500 12px/16px ${UI}; color: var(--ink-3); white-space: nowrap; }
.ktd-chev { color: var(--icon-quiet, var(--ink-4)); opacity: 0; transition: opacity var(--d-1, 90ms) var(--ease); }
.ktd-val:hover .ktd-chev, .ktd-val:focus-within .ktd-chev, .ktd-val[aria-expanded="true"] .ktd-chev, .ktd-val[data-open="true"] .ktd-chev { opacity: 1; }
.ktd-input {
  width: 100%; min-width: 0; height: 32px; margin-left: -8px; padding: 0 8px; border: 1px solid transparent; border-radius: var(--r-sm, 6px);
  background: transparent; font: 500 13px/20px ${UI}; color: var(--ink); transition: background var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease);
}
.ktd-input[data-mono="true"] { font: 500 12px/20px var(--font-mono); font-variant-numeric: tabular-nums; }
.ktd-input[data-narrow="true"] { width: 112px; flex: none; }
.ktd-input[data-narrow="xs"] { width: 80px; flex: none; }
.ktd-input::placeholder { color: var(--ink-4); font-family: ${UI}; font-size: 13px; }
.ktd-input:hover { background: var(--fill-1); }
.ktd-input:focus { background: var(--field-bg, var(--surface)); border-color: var(--field-border-hover, var(--hairline-strong)); }
.ktd-input[type="number"] { -moz-appearance: textfield; appearance: textfield; }
.ktd-input::-webkit-outer-spin-button, .ktd-input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.ktd-note { font: 500 12px/16px ${UI}; color: var(--ink-3); }
.ktd-note[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.ktd-note[data-row="true"] { flex-basis: 100%; padding: 0 0 6px; }
.ktd-props .kdate-wrap { margin-left: -10px; }
.ktd-props .kdate-wrap[data-static="true"] { margin-left: 0; }
.ktd-props .kdate[data-static="true"] { font-size: 12px; line-height: 32px; }
.ktd-props .kdate:not([data-static="true"]):not([data-tone="overdue"]):not([data-tone="now"]):not([data-empty="true"]) { color: var(--ink); }
.ktd-tag { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/20px ${UI}; color: var(--ink-2); white-space: nowrap; }
.ktd-tag > i { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
.ktd-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 4px 0; }
.ktd-chip { height: 24px; padding: 0 8px; border-radius: var(--r-sm, 6px); border: 1px solid var(--hairline-strong); background: transparent; font: 500 12px/1 ${UI}; color: var(--ink-2); cursor: pointer; }
.ktd-chip[aria-pressed="true"] { border-color: var(--accent-line, var(--accent)); background: var(--bg-selected, var(--accent-dim)); color: var(--ink); }
.ktd-del { opacity: 0; margin-left: auto; transition: opacity var(--d-1, 90ms) var(--ease); }
.ktd-prop:hover .ktd-del, .ktd-del:focus-visible { opacity: 1; }
.ktd-more { display: inline-flex; align-items: center; gap: 6px; height: 28px; margin: 4px 0 0 -8px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: none; font: 600 12px/16px ${UI}; color: var(--ink-3); cursor: pointer; }
.ktd-more:hover { background: var(--fill-1); color: var(--ink-2); }
.ktd-form { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 8px; }
.ktd-field-sm { height: 28px; padding: 0 8px; border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); font: 500 13px/20px ${UI}; color: var(--ink); }
.ktd-field-sm::placeholder { color: var(--ink-4); }

/* Kanbo suggests */
.ktd-suggest { display: flex; align-items: center; gap: 10px; margin-top: 16px; padding: 10px 12px; border-radius: var(--r-md, 8px); background: var(--bg-deep); border: 1px solid var(--hairline); }
.ktd-suggest > p { flex: 1; min-width: 0; margin: 0; font: 500 13px/20px ${UI}; color: var(--ink-2); text-wrap: pretty; }
.ktd-suggest .kbtn { flex-shrink: 0; margin: -4px -6px -4px 0; color: var(--accent-text, var(--accent)); }

/* description */
.ktd-desc { position: relative; margin-top: 20px; }
.ktd-desc-view { display: block; width: calc(100% + 16px); max-width: var(--read-max, 720px); margin: 0 -8px; padding: 4px 8px; border: 0; background: none; text-align: left; border-radius: var(--r-sm, 6px); font: 400 15px/24px ${UI}; color: var(--ink-2); overflow-wrap: anywhere; }
.ktd-desc-view[data-editable="true"] { cursor: text; }
.ktd-desc-view[data-editable="true"]:hover { background: var(--fill-1); }
.ktd-desc-view[data-empty="true"] { color: var(--ink-4); }
.ktd-desc-view a { color: var(--accent-text, var(--accent)); text-underline-offset: 2px; }
.ktd-desc-edit { position: absolute; top: 2px; right: -4px; opacity: 0; transition: opacity var(--d-1, 90ms) var(--ease); }
/* the Edit button has its own gutter, so it never sits on the text (on touch it's always shown) */
.ktd-desc[data-edit="true"] .ktd-desc-view { padding-right: 56px; }
.ktd-desc:hover .ktd-desc-edit, .ktd-desc:focus-within .ktd-desc-edit { opacity: 1; }
.ktd-mdbar { display: flex; gap: 2px; margin-bottom: 6px; }
.ktd-md { display: inline-grid; place-items: center; min-width: 28px; height: 28px; padding: 0 6px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; font: 600 13px/1 ${UI}; color: var(--ink-3); cursor: pointer; }
.ktd-md:hover { background: var(--fill-1); color: var(--ink); }
.ktd-textarea { display: block; width: 100%; resize: vertical; padding: 8px 10px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); font: 400 15px/24px ${UI}; color: var(--ink); }
.ktd-textarea:focus { border-color: var(--accent); }
.ktd-textarea::placeholder { color: var(--ink-4); }

/* sections */
.ktd-sec { margin-top: 24px; }
.ktd-sec > .ksection { margin-bottom: 2px; }
.ktd-sec .kmeter-wrap { flex: none; }
.ktd-row { position: relative; display: flex; align-items: center; gap: 10px; min-height: 32px; margin: 0 -8px; padding: 0 8px; border-radius: var(--r-sm, 6px); font: 500 14px/20px ${UI}; color: var(--ink); }
.ktd-row[data-link="true"]:hover { background: var(--fill-1); }
.ktd-row > .kcheck, .ktd-row > .kglyph, .ktd-row > button:not(.ktd-row-title), .ktd-row > input { position: relative; z-index: 1; }
.ktd-row-title { flex: 1; min-width: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.ktd-row-title { cursor: pointer; }
button.ktd-row-title::after { content: ""; position: absolute; inset: 0; border-radius: inherit; }
button.ktd-row-title:focus-visible { outline: none; }
button.ktd-row-title:focus-visible::after { outline: 2px solid var(--accent); outline-offset: -2px; }
.ktd-row[data-done="true"] .ktd-row-title { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.ktd-row-meta { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.ktd-row-meta[data-tone="overdue"] { color: var(--signal, var(--st-blocked)); }
.ktd-row-meta[data-tone="today"] { color: var(--accent-text, var(--accent)); }
.ktd-row-go { color: var(--icon-quiet, var(--ink-4)); opacity: 0; transition: opacity var(--d-1, 90ms) var(--ease); }
.ktd-row:hover .ktd-row-go, .ktd-row:focus-within .ktd-row-go, .ktd-row:hover .ktd-del, .ktd-row:focus-within .ktd-del { opacity: 1; }
.ktd-add-input { flex: 1; min-width: 0; height: 32px; padding: 0; border: 0; background: transparent; font: 500 14px/20px ${UI}; color: var(--ink); }
.ktd-add-input::placeholder { color: var(--ink-4); }
.ktd-quiet { color: var(--icon-quiet, var(--ink-4)); flex-shrink: 0; }
.ktd-lock { color: var(--signal, var(--st-blocked)); flex-shrink: 0; }
.ktd-combo { position: relative; margin-top: 4px; }
.ktd-combo-list { position: absolute; top: calc(100% + 4px); left: 0; right: 0; z-index: 5; max-height: 232px; overflow-y: auto; }
.ktd-files { display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); gap: 8px; margin: 4px 0 8px; }
.ktd-thumb { position: relative; aspect-ratio: 1; border-radius: var(--r-md, 8px); overflow: hidden; background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); }
.ktd-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.ktd-thumb .kibtn { position: absolute; top: 4px; right: 4px; background: var(--surface-raised); box-shadow: var(--e1, var(--shadow)); opacity: 0; }
.ktd-thumb:hover .kibtn, .ktd-thumb:focus-within .kibtn { opacity: 1; }
.ktd-file-link { color: var(--ink); text-decoration: none; }
.ktd-file-link:hover { text-decoration: underline; text-underline-offset: 2px; }
.ktd-ai-note { margin: 2px 0 6px; font: 500 12px/16px ${UI}; color: var(--ink-3); }

/* activity */
.ktd-tl { display: grid; gap: 14px; margin-top: 8px; }
.ktd-c { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; }
.ktd-c[data-depth="1"] { margin-left: 12px; padding-left: 22px; border-left: 2px solid var(--hairline); grid-template-columns: 20px minmax(0, 1fr); }
.ktd-c-head { display: flex; align-items: baseline; gap: 6px; min-width: 0; font: 600 13px/20px ${UI}; color: var(--ink); }
.ktd-c-head b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.ktd-time { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-4); }
.ktd-c-body { margin-top: 2px; font: 400 14px/22px ${UI}; color: var(--ink); overflow-wrap: anywhere; }
.ktd-c-body a { color: var(--accent-text, var(--accent)); }
.ktd-c-foot { position: relative; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin-top: 4px; }
.ktd-c-foot > .ktd-react + .ktd-c-tools, .ktd-c-foot > .ktd-react { margin-left: 0; }
.ktd-c-tools { display: inline-flex; flex-wrap: wrap; gap: 0; margin-left: -6px; opacity: 0; transition: opacity var(--d-1, 90ms) var(--ease); }
.ktd-c:hover .ktd-c-tools, .ktd-c:focus-within .ktd-c-tools { opacity: 1; }
.ktd-act { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; border: 0; border-radius: var(--r-sm, 6px); background: transparent; font: 500 12px/1 ${UI}; color: var(--ink-3); cursor: pointer; }
.ktd-act:hover { background: var(--fill-1); color: var(--ink); }
.ktd-act[data-tone="danger"]:hover { color: var(--signal, var(--st-blocked)); }
.ktd-sys { display: grid; grid-template-columns: 24px minmax(0, 1fr); column-gap: 10px; align-items: start; font: 500 12px/18px ${UI}; color: var(--ink-3); }
.ktd-sys > svg { justify-self: center; margin-top: 2px; color: var(--icon-quiet, var(--ink-4)); }
.ktd-sys b { font-weight: 600; color: var(--ink-2); }

/* composer */
.ktd-compose { flex-shrink: 0; padding: 12px 16px 16px; border-top: 1px solid var(--hairline); background: var(--bg); }
.ktd[data-mobile="true"] .ktd-compose { padding-bottom: max(12px, env(safe-area-inset-bottom, 0px)); }
.ktd-replying { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; font: 500 12px/16px ${UI}; color: var(--ink-3); }
.ktd-replying b { color: var(--ink-2); font-weight: 600; }
.ktd-field { position: relative; display: flex; align-items: flex-end; gap: 6px; min-height: 40px; padding: 4px 4px 4px 12px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); transition: border-color var(--d-1, 90ms) var(--ease); }
.ktd-field:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.ktd-field:focus-within { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.ktd-field textarea { flex: 1; min-width: 0; min-height: 30px; max-height: 150px; padding: 5px 0; border: 0; background: transparent; resize: none; font: 400 14px/20px ${UI}; color: var(--ink); }
.ktd-field textarea::placeholder { color: var(--ink-4); }
.ktd-field .kkbd { align-self: center; margin-right: 2px; }
.ktd-send[data-ready="true"] { background: var(--accent-fill, var(--accent)); color: var(--on-accent); }
.ktd-send[data-ready="true"]:hover:not(:disabled) { background: var(--accent-hover, var(--accent-strong)); color: var(--on-accent); }
.ktd-mention { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 6; }
.ktd-mention[data-down="true"] { bottom: auto; top: calc(100% + 6px); }
.ktd-mention .ktd-pop-note { padding: 6px 8px 4px; margin-top: 4px; border-top: 1px solid var(--hairline); font: 500 12px/16px ${UI}; color: var(--ink-3); }

@media (hover: none) {
  .ktd-desc-edit, .ktd-c-tools, .ktd-del, .ktd-row-go, .ktd-thumb .kibtn { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ktd, .ktd-scrim, .ktd-menu { animation: none !important; }
}
`;

/* ============================================================
   Small building blocks
   ============================================================ */

/**
 * A text input that keeps what you type locally and saves once — on blur,
 * Enter, or when the panel closes — instead of writing on every keystroke
 * (which raced, and re-synced every teammate per character).
 *
 * Like the title, it remembers the live value it was loaded from (its base):
 * while you're not in it — or you're in it but haven't typed — it follows the
 * live value; only a real change is saved, so tabbing through never writes a
 * stale value back over a teammate's; and if the value changed underneath
 * your edit you're asked before overwriting it. `onCommit` returning false
 * rejects the text (unreadable), and the live value comes back.
 */
function BufferedInput({ value, onCommit, onKeyDown, ...rest }: { value: string; onCommit: (v: string) => void | false } & Omit<React.InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onBlur" | "onFocus">) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const draftRef = useRef(value);
  const baseRef = useRef(value);
  const liveRef = useRef(value);
  liveRef.current = value;
  const sync = (v: string) => { setDraft(v); draftRef.current = v; baseRef.current = v; };
  useEffect(() => { if (!editing.current || draftRef.current === baseRef.current) sync(value); }, [value]);
  const commit = () => {
    const mine = draftRef.current, base = baseRef.current, live = liveRef.current;
    if (mine === base) { if (live !== base) sync(live); return; }   // untouched — never writes
    if (mine === live) { baseRef.current = mine; return; }
    if (live !== base && !window.confirm(CONFLICT_MSG)) { sync(live); return; }  // keep theirs
    if (onCommit(mine) === false) { sync(live); return; }
    baseRef.current = mine;
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => { if (editing.current) commitRef.current(); }, []);
  return (
    <input {...rest} value={draft}
      onFocus={() => { editing.current = true; if (draftRef.current === baseRef.current && liveRef.current !== baseRef.current) sync(liveRef.current); }}
      onChange={(e) => { setDraft(e.target.value); draftRef.current = e.target.value; }}
      onBlur={() => { editing.current = false; commit(); }}
      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } onKeyDown?.(e); }} />
  );
}
const numOrUndef = (s: string): number | undefined => { if (s.trim() === "") return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; };

/** the panel's popovers wear the same surface as its ⋯ menu (Paper & Navy's Menu) */
const POP_STYLE: React.CSSProperties = {
  padding: 4, border: 0, borderRadius: "var(--r-lg, 12px)",
  background: "linear-gradient(var(--surface-raised), var(--surface-raised)), var(--surface-solid)",
  boxShadow: "var(--e2, 0 0 0 1px var(--hairline), var(--shadow-lg))",
};

interface PropOption { value: string; label: string; icon?: ReactNode; sepBefore?: boolean }
interface PropSelectHandle { open: () => void }
// keys that open a closed select-only combobox (the ARIA pattern), instead of
// silently changing its value the way a native <select> does on some platforms
const OPEN_KEYS = new Set([" ", "Enter", "ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown", "F4"]);
const isTypeahead = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
  e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey;
/** the next option (after `from`) whose label starts with `ch` */
const seekOption = (labels: string[], ch: string, from = -1) => {
  const c = ch.toLowerCase();
  for (let k = 1; k <= labels.length; k++) {
    const i = (from + k) % labels.length;
    if (labels[i].toLowerCase().startsWith(c)) return i;
  }
  return -1;
};

/**
 * A property value. The row shows the glyph and words; a transparent native
 * <select> covers it and stays the real control: its <label>, its value and
 * change event, a screen reader's own "open" command, and the platform picker
 * on phones and touch screens. With a mouse or keyboard it opens the Paper &
 * Navy menu instead of the OS list: each option with its glyph, and a check on
 * the current one. ↑/↓/Home/End move, a letter jumps, Enter picks, Esc closes.
 */
const PropSelect = forwardRef<PropSelectHandle, {
  id: string;
  /** the accessible name, when no <label for> names it */
  label?: string;
  /** the menu's name (defaults to `label`) */
  menuLabel?: string;
  value: string;
  options: PropOption[];
  onChange: (v: string) => void;
  text: ReactNode;
  leading?: ReactNode;
  empty?: boolean;
  wide?: boolean;
  small?: boolean;
  title?: string;
  /** use the platform's own picker (phones, touch screens) */
  native?: boolean;
}>(function PropSelect({ id, label, menuLabel, value, options, onChange, text, leading, empty, wide, small, title, native }, ref) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const seekRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  // a letter typed on the closed control: the menu opens on the first match
  const [seek, setSeek] = useState(-1);
  // opened with the mouse: no keyboard ring on the current option until a key is pressed
  const [quiet, setQuiet] = useState(false);
  const labels = options.map((o) => o.label);
  const show = (at = -1, pointer = false) => {
    const el = selectRef.current;
    if (!el) return;
    if (native) {
      el.scrollIntoView?.({ block: "nearest" });
      el.focus({ preventScroll: true });
      try { (el as HTMLSelectElement & { showPicker?: () => void }).showPicker?.(); } catch { /* focus is enough */ }
      return;
    }
    setSeek(at); setQuiet(pointer); setOpen(true);
  };
  useImperativeHandle(ref, () => ({ open: () => show() }));
  const pick = (v: string) => { setOpen(false); if (v !== value) onChange(v); };
  const known = options.some((o) => o.value === value);
  return (
    <span className="ktd-val" data-wide={wide || undefined} data-empty={empty || undefined} data-small={small || undefined} data-open={open || undefined} title={title}>
      <span aria-hidden="true" style={{ display: "contents" }}>
        {leading}
        <span className="ktd-val-text">{text}</span>
        {!small && <Icon name="chevronDown" size={14} sw={1.75} className="ktd-chev" />}
      </span>
      <select ref={selectRef} id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}
        aria-expanded={native ? undefined : open}
        onMouseDown={native ? undefined : (e) => {
          if (e.button !== 0) return;
          // hold back the OS list (it would open on mousedown) and show ours
          e.preventDefault(); e.currentTarget.focus({ preventScroll: true }); show(-1, true);
        }}
        onKeyDown={native ? undefined : (e) => {
          if (OPEN_KEYS.has(e.key) || (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp"))) { e.preventDefault(); show(); }
          else if (isTypeahead(e)) { e.preventDefault(); show(seekOption(labels, e.key)); }
        }}>
        {/* a value outside the list (none yet) reads as nothing chosen, not as the first option */}
        {!known && <option value={value} disabled hidden>—</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {open && (
        <Popover open anchorRef={selectRef} onClose={() => setOpen(false)} role="listbox" label={menuLabel ?? label} minWidth={212} maxHeight={336}
          initialFocus={seek >= 0 ? seekRef : undefined} className={quiet ? "ktd-pop ktd-pop-quiet" : "ktd-pop"} style={POP_STYLE}>
          <div onKeyDown={(e) => {
              if (quiet) setQuiet(false);
              if (!isTypeahead(e)) return;
              const items = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'));
              const i = seekOption(labels, e.key, items.indexOf(document.activeElement as HTMLButtonElement));
              if (i >= 0) { e.preventDefault(); items[i]?.focus(); }
            }}>
            {options.map((o, i) => [
              o.sepBefore ? <div key={`${o.value}-sep`} role="presentation" className="ktd-msep" /> : null,
              <button key={o.value} ref={i === seek ? seekRef : undefined} type="button" role="option" aria-selected={o.value === value}
                className="ktd-mi" onClick={() => pick(o.value)}>
                {o.icon && <span className="ktd-mi-ico" aria-hidden="true">{o.icon}</span>}
                <span className="ktd-mi-name">{o.label}</span>
                {o.value === value && <Icon name="check" size={16} sw={2} className="ktd-mi-check" />}
              </button>,
            ])}
          </div>
        </Popover>
      )}
    </span>
  );
});

type MdKind = "bold" | "italic" | "code" | "link" | "bullet";
function applyMd(el: HTMLTextAreaElement, value: string, setValue: (v: string) => void, kind: MdKind) {
  const start = el.selectionStart ?? value.length, end = el.selectionEnd ?? value.length;
  const sel = value.slice(start, end);
  let insert = sel;
  if (kind === "bold") insert = `**${sel || "bold"}**`;
  else if (kind === "italic") insert = `*${sel || "italic"}*`;
  else if (kind === "code") insert = `\`${sel || "code"}\``;
  else if (kind === "link") insert = `[${sel || "text"}](url)`;
  else if (kind === "bullet") insert = (sel || "item").split("\n").map((l) => `- ${l}`).join("\n");
  setValue(value.slice(0, start) + insert + value.slice(end));
  requestAnimationFrame(() => { el.focus(); const p = start + insert.length; try { el.setSelectionRange(p, p); } catch { /* ignore */ } });
}
function MdToolbar({ getEl, value, setValue }: { getEl: () => HTMLTextAreaElement | null; value: string; setValue: (v: string) => void }) {
  const tbtn = (label: ReactNode, kind: MdKind, title: string, style?: React.CSSProperties) => (
    <button type="button" className="ktd-md" title={title} aria-label={title} style={style}
      onMouseDown={(e) => { e.preventDefault(); const el = getEl(); if (el) applyMd(el, value, setValue, kind); }}>{label}</button>
  );
  return (
    <div className="ktd-mdbar" role="group" aria-label="Formatting">
      {tbtn("B", "bold", "Bold", { fontWeight: 700 })}
      {tbtn("I", "italic", "Italic", { fontStyle: "italic", fontFamily: "Georgia, serif" })}
      {tbtn(<Icon name="link" size={14} sw={1.75} />, "link", "Link")}
      {tbtn(<Icon name="list" size={14} sw={1.75} />, "bullet", "Bullet list")}
      {tbtn(<span className="mono" style={{ fontSize: 11 }}>{"<>"}</span>, "code", "Code")}
    </div>
  );
}

/** the look of a square check, without the button (read-only views) */
function StaticCheck({ done, label }: { done: boolean; label: string }) {
  return (
    <span role="img" aria-label={`${label}: ${done ? "done" : "not done"}`} style={{
      width: 16, height: 16, borderRadius: "var(--r-xs, 4px)", flexShrink: 0, display: "grid", placeItems: "center",
      border: `1.5px solid ${done ? "var(--accent)" : "var(--control-border, var(--hairline-strong))"}`,
      background: done ? "var(--accent)" : "transparent", color: "var(--on-accent)",
    }}>{done && <Icon name="check" size={11} sw={3} />}</span>
  );
}

/** Roving arrow keys over a popover's items (and its search field). */
function moveFocus(e: ReactKeyboardEvent<HTMLElement>, selector: string) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
  const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector));
  if (!items.length) return;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1
    : e.key === "ArrowDown" ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
  e.preventDefault();
  items[n].focus();
}

/* ---------- the header's ⋯ menu ---------- */
interface MenuAction {
  id: string;
  label: string;
  /** the accessible name, when it says more than the label ("Delete “Brief”") */
  name?: string;
  icon: IconName;
  run: () => void;
  title?: string;
  tone?: "danger";
  sepBefore?: boolean;
}

/** Always mounted (hidden while closed), so it opens instantly and sits in the
 *  panel's own stacking order. Arrow keys move, Escape closes it (only it),
 *  a click anywhere else closes it. The header owns `open`, so it can hush its
 *  tooltips while the menu is out. */
function ActionsMenu({ actions, open, setOpen }: { actions: MenuAction[]; open: boolean; setOpen: Dispatch<SetStateAction<boolean>> }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open, setOpen]);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) btnRef.current?.focus({ preventScroll: true }); };
  return (
    <span className="ktd-menuwrap">
      <IconButton ref={btnRef} icon="more" label="More actions" size="sm" aria-haspopup="menu" aria-expanded={open} aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => { if (e.key === "ArrowDown" && !open) { e.preventDefault(); setOpen(true); } }} />
      <div ref={menuRef} id={menuId} role="menu" aria-label="Task actions" className="ktd-menu" hidden={!open}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
          if (e.key === "Tab") { close(false); return; }
          moveFocus(e, '[role="menuitem"]');
        }}>
        {actions.map((a) => [
          a.sepBefore ? <div key={`${a.id}-sep`} className="ktd-msep" role="separator" /> : null,
          <button key={a.id} type="button" role="menuitem" tabIndex={-1} className="ktd-mi" data-tone={a.tone} title={a.title} aria-label={a.name}
            onClick={() => { close(true); a.run(); }}>
            <Icon name={a.icon} size={16} sw={1.75} /><span className="ktd-mi-name">{a.label}</span>
          </button>,
        ])}
      </div>
    </span>
  );
}

/* ---------- people ---------- */
interface Person { id: string; name: string }

function AssigneeMenu({ anchorRef, onClose, people, currentUserId, assigneeId, collaborators, onAssign, onToggleCollaborator }: {
  anchorRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  people: Person[];
  currentUserId: string;
  assigneeId: string;
  collaborators: string[];
  onAssign: (id: string) => void;
  onToggleCollaborator?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const collabId = useId();
  const needle = q.trim().toLowerCase();
  const match = (p: Person) => !needle || p.name.toLowerCase().includes(needle);
  const shown = people.filter(match);
  const others = onToggleCollaborator ? people.filter((p) => p.id !== assigneeId && match(p)) : [];
  const nameOf = (p: Person) => (p.id === currentUserId ? `${p.name} (you)` : p.name);
  return (
    <Popover open anchorRef={anchorRef} onClose={onClose} role="dialog" label="Assignee" minWidth={264} maxHeight={380}
      initialFocus={searchRef} className="ktd-pop" style={{ ...POP_STYLE, width: 280 }}>
      <div onKeyDown={(e) => moveFocus(e, 'input, [role="option"], [data-collab]')}>
        {people.length > 1 && (
          <input ref={searchRef} className="ktd-pop-search" value={q} onChange={(e) => setQ(e.target.value)}
            placeholder="Find someone…" aria-label="Find someone" autoComplete="off" spellCheck={false} />
        )}
        <div role="listbox" aria-label="Assignee">
          {shown.map((p) => (
            <button key={p.id} type="button" role="option" aria-selected={p.id === assigneeId} className="ktd-mi"
              onClick={() => { if (p.id !== assigneeId) onAssign(p.id); onClose(); }}>
              <Avatar id={p.id} size={20} /><span className="ktd-mi-name">{nameOf(p)}</span>
              {p.id === assigneeId && <Icon name="check" size={16} sw={2} className="ktd-mi-check" />}
            </button>
          ))}
          {shown.length === 0 && <div className="ktd-pop-empty">No one matches “{q.trim()}”.</div>}
        </div>
        {others.length > 0 && (
          <>
            <div className="ktd-msep" role="separator" />
            <div className="ktd-pop-label" id={collabId}>Also working on it</div>
            <div role="group" aria-labelledby={collabId}>
              {others.map((p) => {
                const on = collaborators.includes(p.id);
                return (
                  <button key={p.id} type="button" data-collab="" aria-pressed={on} className="ktd-mi" onClick={() => onToggleCollaborator?.(p.id)}>
                    <Avatar id={p.id} size={20} /><span className="ktd-mi-name">{p.name}</span>
                    {on && <Icon name="check" size={16} sw={2} className="ktd-mi-check" />}
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </Popover>
  );
}

/* ---------- custom fields ---------- */
const customIsEmpty = (f: CustomFieldDef, v: CustomValue | undefined) =>
  v == null || v === "" || (Array.isArray(v) && v.length === 0) || (f.type === "checkbox" && !v);

function formatCustomValue(f: CustomFieldDef, v: CustomValue | undefined, people: Person[]): string | null {
  if (v == null || v === "" || (Array.isArray(v) && v.length === 0)) return f.type === "checkbox" ? "No" : null;
  if (f.type === "checkbox") return v ? "Yes" : "No";
  if (f.type === "multiselect") return Array.isArray(v) ? v.join(", ") : String(v);
  if (f.type === "currency") return typeof v === "number" ? `£${v.toLocaleString("en-GB", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}` : `£${v}`;
  if (f.type === "date") return typeof v === "string" ? dayLabel(v) : String(v);
  if (f.type === "people") return people.find((p) => p.id === v)?.name || getMember(String(v))?.name || "Someone";
  return String(v);
}

function CustomFieldRow({ task, field: f, people, onSet, onDelete, readOnly, nativePick }: {
  task: Task;
  field: CustomFieldDef;
  people: Person[];
  onSet: (fid: string, v: CustomValue) => void;
  onDelete?: (f: CustomFieldDef) => void;
  readOnly: boolean;
  nativePick?: boolean;
}) {
  const uid = useId();
  const id = `${uid}-cf`;
  const v = task.custom?.[f.id];
  const text = formatCustomValue(f, v, people);
  const labelled = f.type === "text" || f.type === "number" || f.type === "currency" || f.type === "dropdown" || f.type === "people";
  let value: ReactNode;
  if (readOnly) {
    value = <span className="ktd-val" data-static="true" data-empty={text == null || undefined}><span className="ktd-val-text">{text ?? "—"}</span></span>;
  } else if (f.type === "text") {
    value = <BufferedInput id={id} aria-label={f.name} className="ktd-input" placeholder="Empty" value={(v as string) ?? ""} onCommit={(s) => onSet(f.id, s)} />;
  } else if (f.type === "number" || f.type === "currency") {
    value = (
      <span style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, minWidth: 0 }}>
        {f.type === "currency" && <span className="ktd-note" aria-hidden="true">£</span>}
        <BufferedInput id={id} aria-label={f.type === "currency" ? `${f.name} (£)` : f.name} type="number" inputMode="decimal" className="ktd-input" data-mono="true"
          style={f.type === "currency" ? { marginLeft: 0 } : undefined} placeholder="Empty"
          value={v == null ? "" : String(v)} onCommit={(s) => onSet(f.id, numOrUndef(s) ?? null)} />
      </span>
    );
  } else if (f.type === "dropdown" || f.type === "people") {
    const opts: PropOption[] = f.type === "dropdown"
      ? f.options.map((o, i) => ({ value: o, label: o, sepBefore: i === 0 }))
      : people.map((p, i) => ({ value: p.id, label: p.name, icon: <Avatar id={p.id} size={20} />, sepBefore: i === 0 }));
    value = (
      <PropSelect id={id} menuLabel={f.name} native={nativePick} value={(v as string) ?? ""} wide empty={!v}
        text={text ?? "Empty"} leading={f.type === "people" && v ? <Avatar id={String(v)} size={20} /> : undefined}
        options={[{ value: "", label: "None" }, ...opts]} onChange={(s) => onSet(f.id, s || null)} />
    );
  } else if (f.type === "multiselect") {
    const arr = Array.isArray(v) ? (v as string[]) : [];
    value = (
      <div role="group" aria-label={f.name} className="ktd-chips">
        {f.options.map((o) => {
          const on = arr.includes(o);
          return <button key={o} type="button" className="ktd-chip" aria-pressed={on} onClick={() => onSet(f.id, on ? arr.filter((x) => x !== o) : [...arr, o])}>{o}</button>;
        })}
      </div>
    );
  } else if (f.type === "date") {
    value = <DateChip value={(v as string) || undefined} onChange={(d) => onSet(f.id, d ?? null)} label={f.name} size="md" tone="plain" placeholder="Add date" />;
  } else {
    value = <span className="ktd-val" data-static="true"><Check done={!!v} size={16} name={f.name} onToggle={() => onSet(f.id, !v)} /></span>;
  }
  return (
    <div className="ktd-prop">
      <dt title={f.name}>{labelled && !readOnly ? <label htmlFor={id}>{f.name}</label> : f.name}</dt>
      <dd>
        {value}
        {onDelete && !readOnly && (
          <IconButton className="ktd-del" icon="x" size="sm" tone="danger" label={`Delete field “${f.name}”`} onClick={() => onDelete(f)} />
        )}
      </dd>
    </div>
  );
}

function AddCustomField({ projectId, onCreate }: { projectId: string; onCreate: (projectId: string, name: string, type: CustomFieldDef["type"], options: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomFieldDef["type"]>("text");
  const [opts, setOpts] = useState("");
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const withOptions = type === "dropdown" || type === "multiselect";
  const add = () => {
    const n = name.trim(); if (!n) return;
    onCreate(projectId, n, type, withOptions ? opts.split(",").map((o) => o.trim()).filter(Boolean) : []);
    setName(""); setOpts(""); setType("text"); setAdding(false);
  };
  const cancel = () => { setAdding(false); requestAnimationFrame(() => addBtnRef.current?.focus()); };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); add(); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel(); }
  };
  if (!adding) {
    return <Button ref={addBtnRef} variant="ghost" size="sm" icon="plus" onClick={() => setAdding(true)} style={{ marginLeft: -10, marginTop: 4, color: "var(--ink-3)" }}>Add custom field</Button>;
  }
  return (
    <div className="ktd-form" role="group" aria-label="New custom field">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus aria-label="New field name" className="ktd-field-sm" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={onKey} placeholder="Field name" style={{ width: 140 }} />
      <select aria-label="New field type" className="ktd-field-sm" value={type} onChange={(e) => setType(e.target.value as CustomFieldDef["type"])} onKeyDown={onKey}>
        <option value="text">Text</option><option value="number">Number</option><option value="currency">Currency (£)</option><option value="dropdown">Dropdown</option><option value="multiselect">Multi-select</option><option value="date">Date</option><option value="people">People</option><option value="checkbox">Checkbox</option>
      </select>
      {withOptions && <input aria-label="Options, separated by commas" className="ktd-field-sm" value={opts} onChange={(e) => setOpts(e.target.value)} onKeyDown={onKey} placeholder="Option A, Option B" style={{ flex: "1 1 160px" }} />}
      <Button variant="primary" size="sm" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" size="sm" onClick={cancel}>Cancel</Button>
    </div>
  );
}

/* ============================================================
   The panel
   ============================================================ */
export interface TaskDetailProps {
  taskId: string;
  tasks: Task[];
  /** open another task in this panel (used to drill into a sub-task) */
  onOpenTask?: (id: string) => void;
  tags: Record<string, TagDef>;
  activity: Activity[];
  members: WorkspaceMember[];
  currentUserId: string;
  onClose: () => void;
  onToggle: (id: string) => void;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onDelete: (id: string) => void;
  onDuplicate?: (id: string) => void;
  onArchive?: (id: string) => void;
  onUnarchive?: (id: string) => void;
  onAddDependency?: (taskId: string, dependsOn: string) => void;
  onRemoveDependency?: (taskId: string, dependsOn: string) => void;
  onToggleSubtask: (taskId: string, subId: string) => void;
  onAddSubtask: (taskId: string, title: string) => void;
  projects?: Project[];
  onToggleFollow?: (id: string) => void;
  onToggleTaskReaction?: (id: string, emoji: string) => void;
  onToggleCollaborator?: (id: string, memberId: string) => void;
  customFields?: CustomFieldDef[];
  onCreateCustomField?: (projectId: string, name: string, type: CustomFieldDef["type"], options: string[]) => void;
  onDeleteCustomField?: (id: string) => void;
  sections?: Section[];
  /** may return the new section's (temporary) id, which the task is then filed under straight away */
  onCreateSection?: (projectId: string, name: string) => string | void | undefined;
  onCreateTag: (label: string, color: string) => void;
  onDeleteTag: (id: string) => void;
  onAddComment: (taskId: string, body: string, mentions?: string[], parentId?: string) => Promise<Comment | null>;
  onConvertComment?: (body: string, projectId: string) => void;
  onFocus: (id: string) => void;
  /** view + comment only (workspace guests): fields, dates, sub-tasks,
   *  dependencies, files and delete become read-only; comments, replies,
   *  comment reactions and Follow stay usable. */
  readOnly?: boolean;
  /** ≥ 1280px: the panel sits beside the content (no scrim, no focus trap,
   *  aria-modal false) and the page behind stays usable. Esc still closes. */
  docked?: boolean;
  /** "Start 90m focus" (falls back to onFocus) */
  onStartFocus?: (id: string) => void;
  /** the breadcrumb's project: the panel closes and this opens the project */
  onOpenProject?: (projectId: string) => void;
  /** Settings › "Use Kanbo AI". Off: nothing in the panel calls the AI service ("Break it
   *  down" isn't offered). Default: the saved setting. */
  ai?: boolean;
}

/** A task opened from inside the panel (a sub-task, a blocker, the parent)
 *  replaces the row you were on, so focus stays in the panel, and closing it
 *  later still goes back to where you first came in from. App keys the
 *  panel's error boundary by task, which mounts a whole new panel for it, so
 *  this lives out here where it outlasts the panel that set it. It clears
 *  itself a frame later in case the host never opens that task. */
let drill: { id: string; back: HTMLElement | null } | null = null;
function markDrillIn(id: string, back: HTMLElement | null) {
  const d = { id, back };
  drill = d;
  requestAnimationFrame(() => { if (drill === d) drill = null; });
}

export function TaskDetail(props: TaskDetailProps) {
  const { taskId, tasks, onClose, docked = false } = props;
  const task = tasks.find((t) => t.id === taskId);
  const isMobile = useMediaQuery("(max-width: 859px)");
  const isDocked = docked && !isMobile;
  const trapRef = useFocusTrap<HTMLDivElement>(!isDocked, onClose);
  // the freshest task list, readable from the panel's unmount cleanup (which
  // runs after this component has re-rendered with the new list)
  const liveTasksRef = useRef(tasks);
  liveTasksRef.current = tasks;
  // docked there's no trap to hand focus back on close: remember where it came
  // from. Not when this panel is only making way for a task opened from inside
  // it: the next panel keeps focus.
  const returnTo = useRef<HTMLElement | null>(drill?.id === taskId ? drill.back : null);
  const dockedRef = useRef(isDocked);
  dockedRef.current = isDocked;
  useEffect(() => () => {
    const back = returnTo.current, a = document.activeElement;
    if (dockedRef.current && !drill && back?.isConnected && (!a || a === document.body)) back.focus({ preventScroll: true });
  }, []);

  // if the open task disappears (deleted here or by a realtime sync), close the
  // panel cleanly instead of leaving a blank ghost mounted
  const exists = !!task;
  useEffect(() => {
    if (!exists) onClose();
  }, [exists, onClose]);

  if (!task) return null;
  const proj = props.projects?.find((p) => p.id === task.projectId) ?? getProject(task.projectId);
  return (
    <>
      <style>{PANEL_CSS}</style>
      {!isDocked && !isMobile && <div className="ktd-scrim" aria-hidden="true" onClick={onClose} />}
      {/* no outline override: when Escape parks focus on the panel itself,
          keyboard users see the global focus ring (drawn just inside the edge) */}
      <div ref={trapRef} role="dialog" aria-modal={!isDocked} aria-label={`Task: ${task.title}`} tabIndex={-1}
        className={proj ? "ktd kp" : "ktd"} style={proj ? projectIdentity(proj).style : undefined} data-project={proj ? proj.id : undefined}
        data-docked={isDocked || undefined} data-mobile={isMobile || undefined}
        onFocusCapture={(e) => { const from = e.relatedTarget; if (from instanceof HTMLElement && !e.currentTarget.contains(from)) returnTo.current = from; }}
        onKeyDown={isDocked ? (e) => {
          // docked there's no focus trap to close it: an Escape nothing inside took closes the panel
          if (e.key !== "Escape" || e.defaultPrevented || e.nativeEvent.isComposing) return;
          e.preventDefault(); e.stopPropagation(); onClose();
        } : undefined}>
        {/* keyed by task: switching task (sub-task, dependency) starts from a
            clean slate — no reply target, draft or in-flight upload leaks
            across — and the old task's unsaved title/description are saved */}
        <TaskPanel key={task.id} {...props} task={task} panelRef={trapRef} liveTasksRef={liveTasksRef} returnTo={returnTo} docked={isDocked} isMobile={isMobile} />
      </div>
    </>
  );
}

function TaskPanel({ task, panelRef, liveTasksRef, returnTo, isMobile, docked, taskId, tasks, tags, activity, members, currentUserId, onClose, onToggle, onPatch, onDelete, onDuplicate, onArchive, onUnarchive, onAddDependency, onRemoveDependency, onToggleSubtask, onAddSubtask, onCreateTag, onDeleteTag, onAddComment, onFocus, onStartFocus, onOpenTask, onOpenProject, projects = [], onToggleFollow, onToggleTaskReaction, onToggleCollaborator, customFields = [], onCreateCustomField, onDeleteCustomField, sections = [], onCreateSection, onConvertComment, readOnly = false, ai }: TaskDetailProps & {
  task: Task;
  panelRef: RefObject<HTMLDivElement>;
  liveTasksRef: MutableRefObject<Task[]>;
  /** where focus came into the panel from (docked close hands it back) */
  returnTo: MutableRefObject<HTMLElement | null>;
  isMobile: boolean;
  docked: boolean;
}) {
  const toast = useOptionalToast();
  const uid = useId();
  // phones and touch screens keep the platform's own pickers for property values
  const coarse = useMediaQuery("(pointer: coarse)");
  const nativePick = isMobile || coarse;
  const [newSub, setNewSub] = useState("");
  const [aiSubBusy, setAiSubBusy] = useState(false);
  const [aiSubNote, setAiSubNote] = useState<string | null>(null);
  // the unsent comment survives switching task or closing the panel
  const [comment, setCommentState] = useState(() => readDraft(currentUserId, taskId));
  const [picked, setPicked] = useState<MentionCandidate[]>([]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIdx, setMentionIdx] = useState(0);
  const [descMentionQuery, setDescMentionQuery] = useState<string | null>(null);
  const [descMentionIdx, setDescMentionIdx] = useState(0);
  const [copied, setCopied] = useState(false);
  const [reactPickerFor, setReactPickerFor] = useState<string | null>(null);
  const [depPickerOpen, setDepPickerOpen] = useState(false);
  const [depQuery, setDepQuery] = useState("");
  const [depIdx, setDepIdx] = useState(0);
  const [reactsOpen, setReactsOpen] = useState(false);
  const [reactMoreOpen, setReactMoreOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [tagsOpen, setTagsOpen] = useState(false);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionName, setSectionName] = useState("");
  const [startError, setStartError] = useState(false);
  useEffect(() => { setStartError(false); }, [task.dueDate]);   // a new due date may make room for it
  const [dragOver, setDragOver] = useState(false);
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const depAddRef = useRef<HTMLButtonElement>(null);
  const depListRef = useRef<HTMLDivElement>(null);
  const descEditBtnRef = useRef<HTMLButtonElement>(null);
  const statusMenu = useRef<PropSelectHandle>(null);
  const projectMenu = useRef<PropSelectHandle>(null);
  const assigneeBtnRef = useRef<HTMLButtonElement>(null);
  const tagsBtnRef = useRef<HTMLButtonElement>(null);
  const reactsRef = useRef<HTMLDivElement>(null);
  // Escape / ⌘↵ in the description hands focus to its Edit button once the
  // editor has closed, so keyboard users land somewhere sensible
  const refocusDescEdit = useRef(false);
  const [thread, setThread] = useState<Comment[]>([]);
  const [editingComment, setEditingComment] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [eventsLoaded, setEventsLoaded] = useState(false);
  const [viewers, setViewers] = useState<{ id: string; name: string }[]>([]);
  const [posting, setPosting] = useState(false);
  // Title + description edit buffers. Each remembers the server value it was
  // loaded from (its base): only a real change is saved, a teammate's newer
  // text shows up live while you're not editing, and if it changed underneath
  // you while you were, you're asked before overwriting it.
  const [titleBuf, setTitleBuf] = useState(task.title);
  const [titleFocused, setTitleFocused] = useState(false);
  const titleBase = useRef(task.title);
  const [desc, setDesc] = useState(task.description ?? "");
  const [descEditing, setDescEditing] = useState(false);
  const descBase = useRef(task.description ?? "");
  const descFocused = useRef(false);
  const [files, setFiles] = useState<Attachment[]>([]);
  const filesLoadedAt = useRef(0);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  // keep the buffers in step with teammates' edits while you aren't editing
  useEffect(() => {
    if (!titleFocused) { setTitleBuf(task.title); titleBase.current = task.title; }
  }, [task.title, titleFocused]);
  useEffect(() => {
    if (!descEditing) { const d = task.description ?? ""; setDesc(d); descBase.current = d; }
  }, [task.description, descEditing]);

  // load the comment thread + change history for this task
  useEffect(() => {
    let cancelled = false;
    // merge, not replace: a live comment may arrive via the realtime channel
    // before this initial query resolves — keep any such rows not already in cs.
    store.listComments(taskId).then((cs) => { if (!cancelled) setThread((prev) => { const ids = new Set(cs.map((c) => c.id)); return [...cs, ...prev.filter((p) => !ids.has(p.id))]; }); }).catch(reportError);
    // (demo mode keeps its history in the seed)
    store.listTaskEvents(taskId)
      .then((es) => (es.length || store.configured ? es : DEMO_TASK_EVENTS.filter((e) => e.taskId === taskId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
      .then((es) => { if (!cancelled) { setEvents(es); setEventsLoaded(true); } })
      .catch((err) => { reportError(err); if (!cancelled) setEventsLoaded(true); });
    return () => { cancelled = true; };
  }, [taskId]);

  // attachments — and re-list before their signed links lapse (an hour), and
  // when you come back to the tab, so links keep working and teammates' new
  // files appear
  useEffect(() => {
    let cancelled = false;
    const load = () => store.listAttachments(taskId)
      .then((fs) => { if (!cancelled) { setFiles([...fs]); filesLoadedAt.current = Date.now(); } })
      .catch(reportError);
    load();
    const iv = window.setInterval(load, FILES_REFRESH_MS);
    const onVis = () => { if (document.visibilityState === "visible" && Date.now() - filesLoadedAt.current > 10 * 60 * 1000) load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { cancelled = true; window.clearInterval(iv); document.removeEventListener("visibilitychange", onVis); };
  }, [taskId]);

  // drilling into another task removes the row you clicked — park focus on the
  // panel rather than letting it fall to the page behind. Docked, the list
  // beside it keeps focus when you open a task from there.
  useEffect(() => {
    const drilled = drill?.id === task.id;
    if (drilled) drill = null;
    const a = document.activeElement;
    if ((!docked || drilled) && (!a || a === document.body)) panelRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelRef]);
  const openTask = (id: string) => { markDrillIn(id, returnTo.current); onOpenTask?.(id); };

  // live presence — who else is viewing this task right now. Depends on the
  // viewer's name string, not the members array (whose identity changes on
  // every realtime reload and used to tear the channel down each time).
  // Re-opening a task hands back the same-topic channel if the old one is still
  // leaving, and that one never joins. So: a short delay covers the quick case
  // (StrictMode, a fast close/re-open), and if no presence sync has arrived a
  // few seconds after subscribing we drop that channel and join again (by then
  // the old one has gone), backing off — however slow the network is.
  const meName = useMemo(() => members.find((m) => m.userId === currentUserId)?.name || "Someone", [members, currentUserId]);
  useEffect(() => {
    if (!store.configured) return;
    let unsub: (() => void) | null = null;
    let stopped = false, synced = false, tries = 0, timer = 0;
    const join = () => {
      if (stopped) return;
      unsub?.();
      synced = false;
      unsub = store.subscribeToTaskPresence(taskId, { id: currentUserId, name: meName }, (people) => {
        synced = true;
        if (!stopped) setViewers(people.filter((p) => p.id !== currentUserId));
      });
      const wait = 3000 * 2 ** tries;
      tries += 1;
      if (tries < 4) timer = window.setTimeout(() => { if (!synced) join(); }, wait);
    };
    timer = window.setTimeout(join, 250);
    return () => { stopped = true; window.clearTimeout(timer); setViewers([]); unsub?.(); };
  }, [taskId, currentUserId, meName]);

  // live comments — append comments posted while the panel is open, including
  // your own from another device (one sent from here is already in the thread:
  // sendComment and this both de-duplicate by id), and take edits and
  // reactions as they change
  useEffect(() => {
    const here = (c: Comment) => !c.taskId || c.taskId === taskId;
    const unsub = store.subscribeToTaskComments(taskId,
      (c) => { if (here(c)) setThread((t) => t.some((x) => x.id === c.id) ? t : [...t, c]); },
      (c) => { if (here(c)) setThread((t) => t.map((x) => x.id === c.id ? c : x)); });
    return unsub;
  }, [taskId]);

  // auto-grow the title textarea to fit long titles instead of clipping them
  useEffect(() => {
    const el = titleRef.current;
    if (el) { el.style.height = "auto"; if (el.scrollHeight) el.style.height = el.scrollHeight + "px"; }
  }, [titleBuf]);
  // …and the comment box, up to about seven lines
  useEffect(() => {
    const el = commentRef.current;
    if (!el) return;
    el.style.height = "auto";
    if (!el.scrollHeight) return;
    el.style.height = Math.min(el.scrollHeight, 150) + "px";
    el.style.overflowY = el.scrollHeight > 150 ? "auto" : "hidden";
  }, [comment]);

  /* ---------- saving the title / description ---------- */
  const serverTask = () => liveTasksRef.current.find((t) => t.id === task.id);
  // Put your text back in the editor, based on the current server value so
  // saving it doesn't ask again. If the panel has closed meanwhile, "restore"
  // means save it.
  const restoreMine = (field: UnsavedField, mine: string) => {
    const cur = serverTask(); if (!cur) return;
    if (!alive.current) { onPatch(task.id, field === "title" ? { title: mine } : { description: mine }); return; }
    if (field === "title") {
      titleBase.current = cur.title;
      setTitleBuf(mine);
      requestAnimationFrame(() => titleRef.current?.focus());
    } else {
      descBase.current = cur.description ?? "";
      setDesc(mine);
      setDescEditing(true);
    }
  };
  // You chose to keep a teammate's newer text. Yours isn't thrown away: the
  // toast can put it back (and it's copied to the clipboard where the browser
  // allows — it often doesn't when the window isn't focused).
  const keepTheirs = (field: UnsavedField, mine: string) => {
    dropUnsaved(currentUserId, task.id, field);
    try { navigator.clipboard?.writeText(mine)?.catch(() => {}); } catch { /* no clipboard */ }
    toast?.action(`Kept their version of the ${field}.`, "Restore mine", () => restoreMine(field, mine), 20000);
  };
  // "hidden" (tab switched away) and "unload" (page closing) never prompt: a
  // conflict waits for you to come back. In both, what you typed is also kept
  // in this tab's storage and offered back next time you open the task if it
  // didn't reach the server.
  type FlushMode = "blur" | "hidden" | "unload";
  const commitTitle = (mode: FlushMode = "blur") => {
    if (readOnly) return;
    const cur = serverTask(); if (!cur) return;          // deleted meanwhile
    const v = titleBuf.replace(/\s*\n+\s*/g, " ").trim(), base = titleBase.current;
    if (!v || v === base.trim()) return;                  // unchanged (an emptied title just reverts)
    if (v === cur.title) { titleBase.current = v; return; }
    if (mode !== "blur") stashUnsaved(currentUserId, task.id, "title", v);
    if (cur.title !== base) {
      if (mode !== "blur") return;
      if (!window.confirm(CONFLICT_MSG)) { titleBase.current = cur.title; keepTheirs("title", v); return; }
    }
    titleBase.current = v;
    if (mode === "blur") dropUnsaved(currentUserId, task.id, "title");
    onPatch(task.id, { title: v });
  };
  const commitDesc = (mode: FlushMode = "blur") => {
    if (readOnly) return;
    const cur = serverTask(); if (!cur) return;
    const v = desc, base = descBase.current, server = cur.description ?? "";
    if (v === base) return;
    if (v === server) { descBase.current = v; return; }
    if (mode !== "blur") stashUnsaved(currentUserId, task.id, "description", v);
    if (server !== base) {
      if (mode !== "blur") return;
      if (!window.confirm(CONFLICT_MSG)) { descBase.current = server; keepTheirs("description", v); if (alive.current) setDesc(server); return; }
    }
    descBase.current = v;
    if (mode === "blur") dropUnsaved(currentUserId, task.id, "description");
    onPatch(task.id, { description: v });
  };
  // every close path saves: unmount (close button, backdrop, Esc, opening
  // another task), and a best-effort save when the tab is hidden or unloads
  const flushRef = useRef<(mode: FlushMode) => void>(() => {});
  flushRef.current = (mode) => { commitTitle(mode); commitDesc(mode); };
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === "hidden") flushRef.current("hidden"); };
    const onPageHide = () => flushRef.current("unload");
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", onPageHide);
      flushRef.current("blur");
    };
  }, []);
  // text you'd typed when the page last closed (or the tab was hidden) that
  // never reached the server — offer it back
  useEffect(() => {
    if (readOnly) return;
    (["title", "description"] as const).forEach((field) => {
      const text = takeUnsaved(currentUserId, task.id, field);
      const cur = serverTask();
      if (text == null || !cur || text === (field === "title" ? cur.title : cur.description ?? "")) return;
      toast?.action(`Your last change to this task's ${field} may not have been saved.`, "Restore", () => restoreMine(field, text), 20000);
    });
    // once per task (the panel is keyed by task)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // leave the field you're typing in (its blur saves it) but keep the panel open
  // (focus parks on the panel, which shows the focus ring; Tab carries on
  // from the field you left)
  const stepOut = () => panelRef.current?.focus({ preventScroll: true });
  // …except the description, whose Edit button takes focus once it's back
  useEffect(() => {
    if (descEditing || !refocusDescEdit.current) return;
    refocusDescEdit.current = false;
    if (document.activeElement === panelRef.current) descEditBtnRef.current?.focus();
  }, [descEditing, panelRef]);
  const startDescEdit = () => {
    if (readOnly) return;
    descBase.current = task.description ?? "";
    setDesc(task.description ?? "");
    setDescEditing(true);
  };

  /* ---------- derived ---------- */
  const proj = projects.find((p) => p.id === task.projectId) ?? getProject(task.projectId);
  const dependents = tasks.filter((t) => t.dependencies?.includes(task.id));
  const children = tasks.filter((t) => t.parentId === task.id);
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : undefined;
  const following = (task.followers ?? []).includes(currentUserId);
  const taskReactions = task.reactions ?? {};
  const replyingToComment = replyingTo ? thread.find((c) => c.id === replyingTo) : null;
  const done = task.status === "done";
  // Only people who belong to THIS task's workspace can be assigned/collaborate.
  // A personal-project task (no workspace) is therefore just you — never members
  // pulled in from your other team workspaces.
  const taskWs = task.workspaceId ?? null;
  const activeMembers = members.filter((m) => m.status === "active" && m.userId && (m.workspaceId ?? null) === taskWs);
  const assignable: Person[] = activeMembers.length > 0
    ? activeMembers.map((m) => ({ id: m.userId!, name: m.name || m.email }))
    : [{ id: currentUserId, name: getMember(currentUserId)?.name || "You" }];
  const nameOf = (id: string) => assignable.find((p) => p.id === id)?.name ?? getMember(id)?.name;
  const assigneeName = nameOf(task.assigneeId) || "Unassigned";
  const projectTaskCount = tasks.filter((t) => t.projectId === task.projectId).length;
  const ids = {
    status: `${uid}-status`, priority: `${uid}-priority`, project: `${uid}-project`, section: `${uid}-section`, sectionNew: `${uid}-section-new`,
    assignee: `${uid}-assignee`, assigneeVal: `${uid}-assignee-val`, tags: `${uid}-tags`, tagsVal: `${uid}-tags-val`, repeat: `${uid}-repeat`,
    estimate: `${uid}-estimate`, energy: `${uid}-energy`, logged: `${uid}-logged`, milestone: `${uid}-milestone`, startErr: `${uid}-start-err`,
    desc: `${uid}-desc`, mentions: `${uid}-mentions`, descMentions: `${uid}-desc-mentions`, deps: `${uid}-deps`,
  };
  const moves = useMemo(() => dueMoves(events), [events]);
  const slip = eventsLoaded ? slipNote(task, moves) : null;
  const blockedSince = events.find((e) => e.field === "status" && e.newValue === "blocked")?.createdAt;   // newest first
  const consequence = consequenceOf(task, tasks, KANBO_TODAY, { nameOf, blockedSince });
  const blocked = task.status === "blocked" || consequence?.kind === "blocked";
  const timeline = buildTimeline(thread, eventsLoaded ? events : [], activity, task.id);

  // deleting a tag removes it from every task that has it — TagPicker asks
  // first, and says how many tasks that is
  const tagUsage = (id: string) => tasks.filter((t) => t.tags.includes(id)).length;
  // a start date can't come after the due date (the timeline's rule)
  const setStart = (iso: string) => {
    if (!iso) { setStartError(false); if (task.startDate) onPatch(task.id, { startDate: undefined }); return; }
    const r = timelineStartPatch(task, iso);
    setStartError(!r.ok && r.reason === "after-due");
    if (r.ok) onPatch(task.id, r.patch);
  };
  const setDue = (date: string | undefined, time?: string) => {
    const patch: Partial<Task> = {};
    if ((date || undefined) !== task.dueDate) patch.dueDate = date || undefined;
    const t = date ? time || undefined : undefined;
    if (t !== task.dueTime) patch.dueTime = t;
    if (Object.keys(patch).length) onPatch(task.id, patch);
  };
  const toggleTag = (id: string) => {
    const next = task.tags.includes(id) ? task.tags.filter((x) => x !== id) : [...task.tags, id];
    onPatch(task.id, { tags: next });
  };
  const setCustom = (fid: string, v: CustomValue) => onPatch(task.id, { custom: { ...(task.custom ?? {}), [fid]: v } });
  const removeCustomField = (f: CustomFieldDef) => {
    if (!onDeleteCustomField) return;
    const n = projectTaskCount;
    const scope = n > 1 ? `all ${n} tasks in this project` : "all tasks in this project";
    if (!window.confirm(`Delete field “${f.name}” from ${scope}? Its values will be lost. This can't be undone.`)) return;
    onDeleteCustomField(f.id);
  };
  // a section you just created is picked for this task once it arrives
  const pendingSection = useRef<{ name: string; before: Set<string> } | null>(null);
  useEffect(() => {
    const p = pendingSection.current;
    if (!p) return;
    const hit = sections.find((s) => !p.before.has(s.id) && s.name.trim().toLowerCase() === p.name);
    if (!hit) return;
    pendingSection.current = null;
    onPatch(task.id, { sectionId: hit.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);
  const createSection = () => {
    const n = sectionName.trim();
    if (!n || !onCreateSection) return;
    const existing = sections.find((s) => s.name.trim().toLowerCase() === n.toLowerCase());
    if (existing) onPatch(task.id, { sectionId: existing.id });
    else {
      pendingSection.current = { name: n.toLowerCase(), before: new Set(sections.map((s) => s.id)) };
      const made = onCreateSection(task.projectId, n);
      if (typeof made === "string" && made) { pendingSection.current = null; onPatch(task.id, { sectionId: made }); }
    }
    setSectionName(""); setAddingSection(false);
  };
  const addSub = () => { const v = newSub.trim(); if (v) { onAddSubtask(task.id, v); setNewSub(""); } };
  // AI switched off in Settings: the panel sends nothing to the AI service
  const aiAllowed = ai ?? loadAppearance().ai !== false;
  const aiBreakdown = async () => {
    if (!aiAllowed) return;
    const forTask = task.id;
    setAiSubBusy(true);
    let subs: string[] = [];
    try { subs = await store.aiBreakdown(task.title, desc); } catch (err) { reportError(err, { op: "aiBreakdown" }); }
    // you asked for this task's sub-tasks, so they're added even if you've moved on
    if (subs.length) subs.forEach((s) => onAddSubtask(forTask, s));
    if (!alive.current) return;
    setAiSubBusy(false);
    // the server's reason (daily limit, awaiting approval) when it gave one — shown a little longer
    const why = subs.length ? null : store.aiNotice();
    if (!subs.length) { setAiSubNote(why ?? "Kanbo couldn't break this down just now. Add sub-tasks by hand."); window.setTimeout(() => { if (alive.current) setAiSubNote(null); }, why ? 6000 : 3000); }
  };

  // @mention autocomplete — suggest teammates as you type "@…". Picks are
  // remembered by id, so the right person is notified even when names clash.
  const mentionable = assignable.filter((m) => m.id !== currentUserId);
  const mentionNames = mentionable.map((m) => m.name);
  const mentionMatches = mentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
    : [];
  const mentionActive = Math.min(mentionIdx, Math.max(0, mentionMatches.length - 1));
  const setComment = (v: string) => { setCommentState(v); writeDraft(currentUserId, task.id, v); };
  const onCommentChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setComment(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setMentionQuery(m ? m[1].toLowerCase() : null);
    setMentionIdx(0);
  };
  const pickMention = (who: MentionCandidate) => {
    const el = commentRef.current;
    const caret = el?.selectionStart ?? comment.length;
    const before = comment.slice(0, caret).replace(/(^|\s)@[\w'’.-]*$/, `$1@${who.name} `);
    const next = before + comment.slice(caret);
    setComment(next);
    setPicked((p) => p.some((x) => x.id === who.id) ? p : [...p, who]);
    setMentionQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };
  // @mention autocomplete for the description editor (mirrors the comment one)
  const descMatches = descMentionQuery !== null
    ? mentionable.filter((m) => m.name.toLowerCase().includes(descMentionQuery)).slice(0, 6)
    : [];
  const descActive = Math.min(descMentionIdx, Math.max(0, descMatches.length - 1));
  const onDescChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setDesc(val);
    const caret = e.target.selectionStart ?? val.length;
    const m = val.slice(0, caret).match(/(?:^|\s)@([\w'’.-]*)$/);
    setDescMentionQuery(m ? m[1].toLowerCase() : null);
    setDescMentionIdx(0);
  };
  const pickDescMention = (name: string) => {
    const el = descRef.current;
    const caret = el?.selectionStart ?? desc.length;
    const before = desc.slice(0, caret).replace(/(^|\s)@[\w'’.-]*$/, `$1@${name} `);
    const next = before + desc.slice(caret);
    setDesc(next);
    setDescMentionQuery(null);
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(before.length, before.length); } });
  };

  const sendComment = async () => {
    const v = comment.trim();
    if (!v || posting) return;
    const forTask = task.id;
    const mentions = resolveMentions(v, picked, mentionable);
    // only reply to a comment that's really in this task's thread
    const parentId = replyingTo && thread.some((c) => c.id === replyingTo) ? replyingTo : undefined;
    setPosting(true);
    let c: Comment | null = null;
    try { c = await onAddComment(forTask, v, mentions, parentId); }
    catch (err) { reportError(err, { op: "addComment" }); toast?.error("Couldn't post the comment."); }
    if (!alive.current) {
      // the panel moved on while this posted — just don't restore the sent text as a draft
      if (c && readDraft(currentUserId, forTask).trim() === v) writeDraft(currentUserId, forTask, "");
      return;
    }
    setPosting(false);
    if (c && (!c.taskId || c.taskId === forTask)) {
      setThread((t) => t.some((x) => x.id === c.id) ? t : [...t, c]);
      // clear the box — unless you kept typing while it posted
      setCommentState((cur) => { const next = cur.trim() === v ? "" : cur; writeDraft(currentUserId, forTask, next); return next; });
      setPicked([]); setMentionQuery(null); setReplyingTo(null);
    }
  };
  const toggleReaction = (c: Comment, emoji: string) => {
    const reactions: Record<string, string[]> = { ...(c.reactions || {}) };
    const list = reactions[emoji] || [];
    reactions[emoji] = list.includes(currentUserId) ? list.filter((x) => x !== currentUserId) : [...list, currentUserId];
    if (reactions[emoji].length === 0) delete reactions[emoji];
    setThread((t) => t.map((x) => x.id === c.id ? { ...x, reactions } : x));
    store.toggleReaction(c.id, emoji, currentUserId).catch(reportError);
  };
  // leaving a comment edit hands focus back to that comment's Edit button
  // (or parks it on the panel if the comment has gone)
  const endCommentEdit = (id: string) => {
    setEditingComment(null);
    requestAnimationFrame(() => {
      if (!alive.current) return;
      const btn = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[data-edit-comment]") ?? []).find((b) => b.dataset.editComment === id);
      if (btn) btn.focus(); else stepOut();
    });
  };
  const saveCommentEdit = (c: Comment) => {
    const v = editDraft.trim();
    endCommentEdit(c.id);
    if (!v || v === c.body) return;
    setThread((t) => t.map((x) => x.id === c.id ? { ...x, body: v } : x));
    store.updateComment(c.id, v).catch(reportError);
  };
  const removeComment = (c: Comment) => {
    if (!window.confirm("Delete this comment?")) return;
    // drop the comment AND its replies locally, mirroring the DB's parent_id
    // ON DELETE CASCADE so no orphaned reply lingers in the panel.
    const removedIds = new Set([c.id, ...thread.filter((x) => x.parentId === c.id).map((x) => x.id)]);
    setThread((t) => t.filter((x) => !removedIds.has(x.id)));
    if (replyingTo && removedIds.has(replyingTo)) setReplyingTo(null);
    if (editingComment && removedIds.has(editingComment)) setEditingComment(null);
    onPatch(task.id, { comments: Math.max(0, (task.comments || 0) - removedIds.size) });
    store.deleteComment(c.id).catch(reportError);
  };
  const del = () => {
    const n = children.length;
    const msg = n ? `Delete “${task.title}” and its ${n} sub-task${n === 1 ? "" : "s"}?` : `Delete “${task.title}”?`;
    if (!window.confirm(msg)) return;
    onClose(); onDelete(task.id);
  };
  const copyLink = () => {
    const url = `${location.origin}/?task=${task.id}`;
    const ok = () => {
      if (!alive.current) return;
      setCopied(true); window.setTimeout(() => { if (alive.current) setCopied(false); }, 1500);
      toast?.success("Link copied");
    };
    const fallback = () => { window.prompt("Copy this link to the task", url); };
    try {
      const p = navigator.clipboard?.writeText(url);
      if (p) p.then(ok, fallback); else fallback();
    } catch { fallback(); }
  };
  const saveAsTemplate = () => {
    saveTemplate({ name: task.title, title: task.title, priority: task.priority, tags: task.tags, focusMin: task.focusMin, recurrence: task.recurrence ?? "none", description: desc });
    toast?.success("Saved as a template");
  };
  const onPickFiles = async (list: FileList | File[] | null) => {
    if (readOnly || !list || list.length === 0) return;
    const forTask = task.id;
    setUploading(true);
    for (const f of Array.from(list)) {
      if (f.size > 25 * 1024 * 1024) { window.alert(`"${f.name}" is over 25 MB.`); continue; }
      try {
        const a = await store.uploadAttachment(forTask, f, currentUserId);
        // the panel may have moved on to another task while this uploaded
        if (alive.current && a.taskId === forTask) setFiles((xs) => xs.some((x) => x.id === a.id) ? xs : [...xs, a]);
      } catch (e) { reportError(e, { op: "uploadAttachment" }); window.alert("Couldn't upload " + f.name); }
    }
    if (!alive.current) return;
    setUploading(false);
    if (fileRef.current) fileRef.current.value = "";
  };
  const canRemoveFile = (a: Attachment) => !readOnly && canDeleteAttachment(a, currentUserId, !store.configured);
  const removeFile = async (a: Attachment) => {
    if (!canRemoveFile(a)) return;
    if (!window.confirm(`Delete “${a.name}” from this task? This can't be undone.`)) return;
    setFiles((xs) => xs.filter((x) => x.id !== a.id));
    try { await store.deleteAttachment(a); }
    catch (e) {
      reportError(e, { op: "deleteAttachment" });
      if (alive.current) setFiles((xs) => xs.some((x) => x.id === a.id) ? xs : [...xs, a]);
      toast?.error(`Couldn't delete “${a.name}”.`);
    }
  };

  /* ---------- dependency picker (combobox) ---------- */
  const depCandidates = depPickerOpen ? dependencyCandidates(task, tasks, depQuery, 8) : [];
  const depActive = Math.min(depIdx, Math.max(0, depCandidates.length - 1));
  const closeDepPicker = (refocus: boolean) => {
    setDepPickerOpen(false); setDepQuery(""); setDepIdx(0);
    if (refocus) requestAnimationFrame(() => depAddRef.current?.focus());
  };
  const addDependency = (c: Task) => {
    if (!onAddDependency) return;
    // re-checked here against the live list: a loop makes both tasks blocked forever
    if (wouldCreateCycle(tasks, task.id, c.id)) { toast?.error(`“${c.title}” already depends on this task.`); return; }
    onAddDependency(task.id, c.id);
    closeDepPicker(true);
  };

  /* ---------- Escape ----------
     Escape belongs to the innermost thing: a menu or picker closes first; in
     a text field it finishes editing (saving via blur) and keeps the panel
     open; only then does it close the panel. preventDefault in the capture
     phase marks it handled for the focus trap (which listens on the document);
     the bubble phase then does the work and stops the event before it reaches
     the trap or App's window-level Escape handler. Docked, there's no trap:
     the frame (TaskDetail) closes the panel on an Escape nothing else took. */
  // (the edit box itself, not the id: the comment may have been deleted under it)
  const commentEditOpen = () => !!editRef.current?.isConnected;
  const hasOpenLayer = () => reactPickerFor !== null || reactMoreOpen || depPickerOpen || mentionMatches.length > 0 || descMatches.length > 0 || commentEditOpen();
  const onEscCapture = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape" || e.nativeEvent.isComposing) return;
    if (hasOpenLayer() || isEditableTarget(e.target)) e.preventDefault();
  };
  const onEscKey = (e: React.KeyboardEvent) => {
    if (e.key !== "Escape") return;
    if (e.nativeEvent.isComposing) { e.stopPropagation(); return; }   // Esc cancels IME composition, nothing more
    if (reactPickerFor !== null || reactMoreOpen) { setReactPickerFor(null); setReactMoreOpen(false); e.stopPropagation(); return; }
    if (depPickerOpen) { closeDepPicker(true); e.stopPropagation(); return; }
    if (mentionMatches.length > 0 || descMatches.length > 0) { setMentionQuery(null); setDescMentionQuery(null); e.stopPropagation(); return; }
    // a comment edit is open but you're elsewhere — take you back to it rather than lose it
    if (commentEditOpen() && e.target !== editRef.current) { editRef.current?.focus(); e.stopPropagation(); return; }
    if (isTextEntry(e.target)) {
      e.stopPropagation();
      if (e.target === descRef.current) refocusDescEdit.current = true;
      stepOut();
      return;
    }
    // a select / checkbox already saved its value — nothing to lose, so close
    if (isEditableTarget(e.target)) { e.stopPropagation(); onClose(); }
  };

  const listOption = (active: boolean): React.CSSProperties => ({ background: active ? "var(--fill-1)" : undefined });
  const totalReacts = Object.values(taskReactions).reduce((n, u) => n + (u?.length ?? 0), 0);
  const chosenCollaborators = (task.collaborators ?? []).filter((id) => id !== task.assigneeId);
  const section = sections.find((s) => s.id === task.sectionId);
  // a project that doesn't use sections doesn't get a "No section" on every task
  const hasSections = sections.length > 0 || !!task.sectionId;

  /* ---------- which optional fields show ---------- */
  const hasRepeat = !!task.recurrence && task.recurrence !== "none";
  const showStart = !!task.startDate || startError;
  const showLogged = task.loggedHours != null;
  const showMilestone = !!task.isMilestone;
  const filledFields = customFields.filter((f) => !customIsEmpty(f, task.custom?.[f.id]));
  const emptyFields = customFields.filter((f) => customIsEmpty(f, task.custom?.[f.id]));
  const hiddenCount = readOnly ? 0 : [!showStart, !hasRepeat, !showLogged, !showMilestone].filter(Boolean).length + emptyFields.length;
  const canAddField = !!onCreateCustomField && !readOnly;
  const showAll = moreOpen && !readOnly;

  /* ---------- header actions ---------- */
  const actions: MenuAction[] = [
    ...(onDuplicate && !readOnly ? [{ id: "duplicate", label: "Duplicate", name: "Duplicate task", icon: "copy" as IconName, title: "Duplicate task", run: () => { onDuplicate(task.id); onClose(); } }] : []),
    ...(!readOnly && projects.length > 1 ? [{ id: "move", label: "Move to project…", icon: "arrowRight" as IconName, run: () => projectMenu.current?.open() }] : []),
    { id: "template", label: "Save as template", icon: "briefcase", run: saveAsTemplate },
    ...(!readOnly ? [{ id: "attach", label: "Attach file", icon: "folder" as IconName, run: () => fileRef.current?.click() }] : []),
    ...(onToggleTaskReaction && !readOnly ? [{ id: "react", label: "Add reaction", icon: "message" as IconName, run: () => { setReactsOpen(true); requestAnimationFrame(() => reactsRef.current?.querySelector<HTMLElement>("button")?.focus()); } }] : []),
    ...(!readOnly && task.archivedAt && onUnarchive ? [{ id: "unarchive", label: "Unarchive", name: `Unarchive “${task.title}”`, icon: "refresh" as IconName, title: "Unarchive task", sepBefore: true, run: () => { onUnarchive(task.id); onClose(); } }] : []),
    ...(!readOnly && !task.archivedAt && onArchive ? [{ id: "archive", label: "Archive", name: `Archive “${task.title}”`, icon: "archive" as IconName, title: "Archive task", sepBefore: true, run: () => { onArchive(task.id); onClose(); } }] : []),
    ...(!readOnly ? [{ id: "delete", label: "Delete", name: `Delete “${task.title}”`, icon: "trash" as IconName, title: "Delete task", tone: "danger" as const, sepBefore: !(task.archivedAt ? onUnarchive : onArchive), run: del }] : []),
  ];

  /* ---------- pieces ---------- */
  const statusOptions: PropOption[] = STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label, icon: <StatusGlyph status={s} size={16} readOnly /> }));
  const priorityOptions: PropOption[] = (Object.keys(PRIORITY_META) as Priority[]).map((p) => ({ value: p, label: PRIORITY_META[p].label, icon: <PriorityGlyph priority={p} /> }));
  const projectOptions: PropOption[] = [
    ...projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectTile project={p} size={16} /> })),
    ...(!projects.some((p) => p.id === task.projectId) ? [{ value: task.projectId, label: proj?.name || "Project", icon: proj ? <ProjectTile project={proj} size={16} /> : undefined }] : []),
  ];
  const sectionOptions: PropOption[] = [
    { value: "", label: "No section" },
    ...sections.map((s, i) => ({ value: s.id, label: s.name, sepBefore: i === 0 })),
    ...(task.sectionId && !section ? [{ value: task.sectionId, label: "(section)" }] : []),
    ...(onCreateSection ? [{ value: NEW_SECTION, label: "New section…", icon: <Icon name="plus" size={16} sw={1.75} />, sepBefore: true }] : []),
  ];
  // energy is always set (the store derives one from the tags when there's
  // none), so there's no "none" to offer: it would come back on reload
  const energyOptions: PropOption[] = (Object.keys(ENERGY) as EnergyKind[]).map((k) => ({ value: k, label: ENERGY[k].label, icon: <Icon name={ENERGY[k].icon} size={16} sw={1.75} /> }));
  const repeatOptions: PropOption[] = (Object.keys(RECUR_LABEL) as Recurrence[]).map((r) => ({ value: r, label: RECUR_LABEL[r], sepBefore: r === "daily" }));
  const energy = task.energy;
  const est = task.effortHours;
  const logged = task.loggedHours;
  const overEstimate = est != null && logged != null && logged > est;

  const tagList = task.tags.filter((id) => tags[id]);
  const tagsValue = tagList.length
    ? tagList.map((id) => (
      <span key={id} className="ktd-tag"><i style={{ background: projectPaint(tags[id].color).solid }} />{tags[id].label}</span>
    ))
    : null;

  const readValue = (text: ReactNode, empty = false, leading?: ReactNode) => (
    <span className="ktd-val" data-static="true" data-empty={empty || undefined}>
      {leading && <span aria-hidden="true" style={{ display: "contents" }}>{leading}</span>}
      <span className="ktd-val-text">{text}</span>
    </span>
  );

  const startRow = (
    <div className="ktd-prop" key="start">
      <dt>Start date</dt>
      <dd>
        <DateChip value={task.startDate} onChange={(d) => setStart(d ?? "")} label="Start date" size="md" tone="plain" placeholder="Add start date" readOnly={readOnly} />
        {startError && <span id={ids.startErr} role="alert" className="ktd-note" data-tone="signal" data-row="true">The start date can't be after the due date.</span>}
      </dd>
    </div>
  );
  const repeatRow = (
    <div className="ktd-prop" key="repeat">
      <dt>{readOnly ? "Repeats" : <label htmlFor={ids.repeat}>Repeats</label>}</dt>
      <dd>
        {readOnly ? readValue(RECUR_LABEL[task.recurrence || "none"], !hasRepeat) : (
          <PropSelect id={ids.repeat} menuLabel="Repeats" native={nativePick} value={task.recurrence || "none"} empty={!hasRepeat} text={RECUR_LABEL[task.recurrence || "none"]}
            leading={hasRepeat ? <Icon name="refresh" size={14} sw={1.75} className="ktd-quiet" /> : undefined}
            options={repeatOptions} onChange={(v) => onPatch(task.id, { recurrence: v as Recurrence })} />
        )}
        {!readOnly && hasRepeat && task.dueDate && (
          <Button variant="ghost" size="sm" iconRight="arrowRight" title="Move this task to its next occurrence without completing it" style={{ color: "var(--ink-3)" }}
            onClick={() => {
              // same maths as completing it: the start date moves with it and a month-end series keeps its day
              const n = nextOccurrence(task, task.id);
              onPatch(task.id, { dueDate: n.dueDate, startDate: n.startDate, originalDueDate: n.originalDueDate });
            }}>Skip to next</Button>
        )}
        {hasRepeat && task.dueDate && (
          <span className="ktd-note" data-row="true">Next: {nextOccurrences(task, task.recurrence!, 3).map((d) => shortDay(d)).join(" · ")}</span>
        )}
      </dd>
    </div>
  );
  const loggedRow = (
    <div className="ktd-prop" key="logged">
      <dt>{readOnly ? "Logged" : <label htmlFor={ids.logged}>Logged</label>}</dt>
      <dd>
        {readOnly ? readValue(logged == null ? "—" : fmtHours(logged), logged == null) : (
          <>
            <BufferedInput id={ids.logged} className="ktd-input" data-mono="true" data-narrow="xs" placeholder="0h" value={fmtHours(logged)}
              onCommit={(s) => { const h = parseHours(s); if (h === null || h === logged) return false; onPatch(task.id, { loggedHours: h }); }} />
            {[0.5, 1].map((h) => (
              <Button key={h} variant="ghost" size="sm" title={h === 1 ? "Log an hour" : "Log 30 minutes"} style={{ color: "var(--ink-3)", padding: "0 8px" }}
                onClick={() => onPatch(task.id, { loggedHours: Math.round(((logged ?? 0) + h) * 2) / 2 })}>+{fmtHours(h)}</Button>
            ))}
          </>
        )}
        {est != null && logged != null && est > 0 && (
          <Meter value={logged} max={est} width={56} height={4} tone={overEstimate ? "signal" : "grad"} label={`${fmtHours(logged)} logged of ${fmtHours(est)} estimated`} />
        )}
        {overEstimate && <span className="ktd-note" data-tone="signal">Over estimate</span>}
      </dd>
    </div>
  );
  const milestoneRow = (
    <div className="ktd-prop" key="milestone">
      <dt id={ids.milestone}>Milestone</dt>
      <dd>
        {readOnly ? readValue(task.isMilestone ? "Yes" : "No", !task.isMilestone) : (
          <span className="ktd-val" data-static="true" style={{ gap: 10 }}>
            <Check done={!!task.isMilestone} size={16} name="Milestone" onToggle={() => onPatch(task.id, { isMilestone: !task.isMilestone })} />
            <span className="ktd-val-sub">Shows as a diamond in lists and on the timeline</span>
          </span>
        )}
      </dd>
    </div>
  );
  const fieldRow = (f: CustomFieldDef) => (
    <CustomFieldRow key={f.id} task={task} field={f} people={assignable} onSet={setCustom} readOnly={readOnly} nativePick={nativePick}
      onDelete={onDeleteCustomField && !readOnly ? removeCustomField : undefined} />
  );

  /* ---------- dependencies ---------- */
  const deps = task.dependencies.map((id) => tasks.find((t) => t.id === id)).filter((t): t is Task => !!t);
  const canAddDep = !!onAddDependency && !readOnly;
  const depPicker = canAddDep && depPickerOpen && (
    <div className="ktd-combo">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus value={depQuery} className="ktd-field-sm" style={{ width: "100%", height: 32 }}
        role="combobox" aria-expanded={depCandidates.length > 0} aria-controls={ids.deps} aria-autocomplete="list"
        aria-activedescendant={depCandidates.length > 0 ? `${ids.deps}-${depActive}` : undefined}
        aria-label="Search for a task this one is blocked by"
        onChange={(e) => { setDepQuery(e.target.value); setDepIdx(0); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && depCandidates.length) { e.preventDefault(); setDepIdx((depActive + 1) % depCandidates.length); }
          else if (e.key === "ArrowUp" && depCandidates.length) { e.preventDefault(); setDepIdx((depActive - 1 + depCandidates.length) % depCandidates.length); }
          else if (e.key === "Enter") { e.preventDefault(); const c = depCandidates[depActive]; if (c) addDependency(c); }
          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeDepPicker(true); }
        }}
        onBlur={(e) => { if (depListRef.current?.contains(e.relatedTarget as Node)) return; closeDepPicker(false); }}
        placeholder="Find a task this one waits on…" />
      {(depCandidates.length > 0 || depQuery.trim()) && (
        <div ref={depListRef} className="ktd-combo-list ktd-pop">
          <div role="listbox" id={ids.deps} aria-label="Open tasks in this workspace">
            {depCandidates.map((c, i) => (
              <button key={c.id} type="button" role="option" id={`${ids.deps}-${i}`} aria-selected={i === depActive} tabIndex={-1} className="ktd-mi"
                onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setDepIdx(i)} onClick={() => addDependency(c)}
                style={listOption(i === depActive)}>
                <StatusGlyph status={c.status} size={14} readOnly /> <span className="ktd-mi-name">{c.title}</span>
              </button>
            ))}
          </div>
          {depCandidates.length === 0 && <div className="ktd-pop-empty">No open tasks in this workspace match “{depQuery.trim()}”.</div>}
        </div>
      )}
    </div>
  );
  const addDepButton = (
    <Button ref={depAddRef} variant="ghost" size="sm" icon="plus" onClick={() => { setDepQuery(""); setDepIdx(0); setDepPickerOpen(true); }} style={{ marginLeft: -10, color: "var(--ink-3)" }}>Add dependency</Button>
  );
  const depRow = (t: Task, kind: "blocker" | "dependent") => {
    const tdone = t.status === "done";
    return (
      <div key={t.id} className="ktd-row" data-link={onOpenTask ? "true" : undefined} data-done={tdone || undefined}>
        <StatusGlyph status={t.status} size={14} readOnly />
        {onOpenTask
          ? <button type="button" className="ktd-row-title" onClick={() => openTask(t.id)}>{t.title}</button>
          : <span className="ktd-row-title">{t.title}</span>}
        {kind === "blocker" && !tdone && <Icon name="lock" size={14} sw={1.75} className="ktd-lock" aria-label="Still open" />}
        <Avatar id={t.assigneeId} size={20} />
        {kind === "blocker" && onRemoveDependency && !readOnly && (
          <IconButton className="ktd-del" icon="x" size="sm" tone="danger" label={`Remove dependency on “${t.title}”`} onClick={() => onRemoveDependency(task.id, t.id)} />
        )}
      </div>
    );
  };

  /* ---------- sub-tasks ---------- */
  const subTotal = children.length + (task.subtasks?.length ?? 0);
  const subDone = children.filter((c) => c.status === "done").length + (task.subtasks ?? []).filter((s) => s.done).length;

  /* ---------- files ---------- */
  const isImg = (a: Attachment) => a.mime?.startsWith("image/") || /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(a.name);
  const images = files.filter(isImg);
  const otherFiles = files.filter((a) => !isImg(a));

  /* ---------- activity ---------- */
  const eventIcon = (field: string): IconName => field === "due" ? "calendar" : field === "assignee" ? "user" : field === "priority" ? "flag" : field === "status" ? "circle" : "dot";
  const activityIcon = (a: Activity): IconName => a.kind === "mention" ? "message" : a.kind === "assigned" ? "user" : a.kind === "completed" ? "check" : a.kind === "created" ? "plus" : a.kind === "reopened" ? "refresh" : a.kind === "deleted" ? "trash" : "bell";
  const stamp = (at: string) => {
    const d = new Date(at);
    return <time className="ktd-time" dateTime={at} title={Number.isNaN(d.getTime()) ? undefined : d.toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })}>{ago(at)}</time>;
  };

  return (
    <div className="ktd-inner" onKeyDownCapture={onEscCapture} onKeyDown={onEscKey}>
      {/* ================= header ================= */}
      <div className="ktd-head" data-menu-open={actionsOpen || undefined}>
        <nav className="ktd-crumb" aria-label="Where this task lives">
          {proj && <ProjectChip project={proj} size="md" title={onOpenProject ? `Open ${proj.name}` : undefined}
            onClick={onOpenProject ? () => { onClose(); onOpenProject(proj.id); } : undefined} />}
          {proj && section && <><span className="kpchip-sep" aria-hidden="true"><Icon name="chevronRight" size={12} /></span><span className="ktd-crumb-text">{section.name}</span></>}
        </nav>
        {readOnly && <Pill tone="neutral" icon="lock" title="Guests can view this task and comment on it">View and comment</Pill>}
        {viewers.length > 0 && (
          <span className="ktd-presence" role="img" title={`Also viewing: ${viewers.map((v) => v.name).join(", ")}`} aria-label={`Also viewing: ${viewers.map((v) => v.name).join(", ")}`}>
            {viewers.slice(0, 3).map((v) => <span key={v.id} style={{ display: "inline-flex", borderRadius: 99, boxShadow: "0 0 0 2px var(--bg), 0 0 0 3px var(--accent)" }}><Avatar id={v.id} size={20} /></span>)}
            {viewers.length > 3 && <span className="ktd-presence-more">+{viewers.length - 3}</span>}
          </span>
        )}
        {onToggleFollow && <IconButton icon="bell" size="sm" label="Follow task" pressed={following} onClick={() => onToggleFollow(task.id)} />}
        <IconButton icon={copied ? "check" : "link"} size="sm" label="Copy link to task" onClick={copyLink} />
        <ActionsMenu actions={actions} open={actionsOpen} setOpen={setActionsOpen} />
        <span className="ktd-vsep" aria-hidden="true" />
        <IconButton icon="x" size="sm" label="Close task" className="ktd-tip-end" onClick={onClose} />
      </div>
      {!readOnly && <input ref={fileRef} type="file" multiple onChange={(e) => onPickFiles(e.target.files)} hidden />}

      {/* ================= body ================= */}
      <div className="ktd-body" data-drop={dragOver || undefined}
        onDragOver={(e) => { if (!readOnly && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragOver(true); } }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver(false); }}
        onDrop={(e) => { if (!readOnly && e.dataTransfer.files?.length) { e.preventDefault(); setDragOver(false); onPickFiles(e.dataTransfer.files); } }}>

        {parent && (
          <button type="button" className="ktd-parent" onClick={() => openTask(parent.id)}>
            <Icon name="arrowLeft" size={14} sw={1.75} /> Sub-task of <b>{parent.title}</b>
          </button>
        )}

        {/* title: the status glyph is the checkbox */}
        <div className="ktd-titlerow">
          <span className="ktd-glyph">
            {readOnly
              ? <StatusGlyph status={task.status} size={20} label={task.title} readOnly />
              : <StatusGlyph status={task.status} size={20} label={task.title} celebrateKey={task.id} onToggle={() => onToggle(task.id)} onPick={() => statusMenu.current?.open()} />}
          </span>
          {readOnly ? (
            <h2 className="ktd-title" data-done={done || undefined}>{task.title}</h2>
          ) : (
            <textarea
              ref={titleRef}
              className="ktd-title"
              data-done={done || undefined}
              aria-label="Task title"
              value={titleBuf}
              onChange={(e) => setTitleBuf(e.target.value)}
              onFocus={() => setTitleFocused(true)}
              onBlur={() => { commitTitle(); setTitleFocused(false); }}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); stepOut(); } }}
              rows={1}
            />
          )}
        </div>

        {/* task reactions: shown once there are some, or when asked for from ⋯ */}
        {onToggleTaskReaction && !readOnly && (totalReacts > 0 || reactsOpen) && (
          <div ref={reactsRef} className="ktd-reacts" role="group" aria-label="Reactions">
            {(reactsOpen ? [...new Set([...REACTION_EMOJIS, ...Object.keys(taskReactions)])] : Object.keys(taskReactions).filter((k) => taskReactions[k]?.length)).map((emoji) => {
              const uids = taskReactions[emoji] ?? [];
              const mine = uids.includes(currentUserId);
              return (
                <button key={emoji} type="button" className="ktd-react" aria-pressed={mine} data-quiet={!uids.length || undefined}
                  title={uids.length ? `${uids.length} reacted` : "React"} onClick={() => onToggleTaskReaction(task.id, emoji)}>
                  {emoji}{uids.length > 0 && <span className="ktd-react-n">{uids.length}</span>}
                </button>
              );
            })}
            <button type="button" className="ktd-react" title="More reactions" aria-label="More reactions" aria-expanded={reactMoreOpen} onClick={() => setReactMoreOpen((v) => !v)}>
              <Icon name="plus" size={14} sw={1.75} />
            </button>
            {reactMoreOpen && (
              <>
                <div onClick={() => setReactMoreOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 5 }} />
                <div className="ktd-pickfloat"><EmojiPicker height={180} onPick={(e) => { onToggleTaskReaction(task.id, e); setReactMoreOpen(false); setReactsOpen(false); }} /></div>
              </>
            )}
          </div>
        )}
        {readOnly && totalReacts > 0 && (
          <div className="ktd-reacts">
            {Object.entries(taskReactions).filter(([, u]) => u?.length).map(([emoji, u]) => (
              <span key={emoji} className="ktd-react" data-static="true" title={`${u.length} reacted`}>{emoji}<span className="ktd-react-n">{u.length}</span></span>
            ))}
          </div>
        )}

        {/* ================= properties ================= */}
        <dl className="ktd-props">
          <div className="ktd-prop">
            <dt>{readOnly ? "Status" : <label htmlFor={ids.status}>Status</label>}</dt>
            <dd>
              {readOnly ? readValue(STATUS_META[task.status]?.label ?? task.status, false, <StatusGlyph status={task.status} size={14} readOnly />) : (
                <PropSelect ref={statusMenu} id={ids.status} menuLabel="Status" native={nativePick} value={task.status} wide text={STATUS_META[task.status]?.label ?? task.status}
                  leading={<StatusGlyph status={task.status} size={14} readOnly />} options={statusOptions}
                  onChange={(v) => {
                    const s = v as Status;
                    // completing goes the same way as the checkbox: blocker warning,
                    // Undo toast, and a single next occurrence for repeating tasks
                    if (s === "done" && task.status !== "done") { onToggle(task.id); return; }
                    onPatch(task.id, { status: s, completedAt: undefined });
                  }} />
              )}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt id={ids.assignee}>Assignee</dt>
            <dd>
              {readOnly ? readValue(
                <>{assigneeName}{chosenCollaborators.length > 0 && <span className="ktd-val-sub"> + {chosenCollaborators.map((id) => nameOf(id)?.split(/\s+/)[0] ?? "someone").join(", ")}</span>}</>,
                false, <Avatar id={task.assigneeId} size={20} />,
              ) : (
                <>
                  <button ref={assigneeBtnRef} type="button" className="ktd-val" data-wide="true" aria-haspopup="dialog" aria-expanded={assigneeOpen}
                    aria-labelledby={`${ids.assignee} ${ids.assigneeVal}`} onClick={() => setAssigneeOpen((o) => !o)}>
                    <Avatar id={task.assigneeId} size={20} />
                    <span className="ktd-val-text" id={ids.assigneeVal}>
                      {task.assigneeId === currentUserId ? `${assigneeName} (you)` : assigneeName}
                      {chosenCollaborators.length === 1 && <span className="ktd-val-sub"> + {nameOf(chosenCollaborators[0])?.split(/\s+/)[0] ?? "1 more"}</span>}
                      {chosenCollaborators.length > 1 && <span className="sr-only">, with {chosenCollaborators.map((id) => nameOf(id) ?? "someone").join(", ")}</span>}
                    </span>
                    {chosenCollaborators.length > 1 && (
                      <span aria-hidden="true" title={chosenCollaborators.map((id) => nameOf(id) ?? "Someone").join(", ")} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                        <AvatarStack ids={chosenCollaborators.slice(0, 3)} size={20} />
                        <span className="ktd-val-sub mono">+{chosenCollaborators.length}</span>
                      </span>
                    )}
                    <Icon name="chevronDown" size={14} sw={1.75} className="ktd-chev" />
                  </button>
                  {assigneeOpen && (
                    <AssigneeMenu anchorRef={assigneeBtnRef} onClose={() => setAssigneeOpen(false)} people={assignable} currentUserId={currentUserId}
                      assigneeId={task.assigneeId} collaborators={chosenCollaborators}
                      onAssign={(id) => onPatch(task.id, { assigneeId: id })}
                      onToggleCollaborator={onToggleCollaborator && assignable.length > 1 ? (id) => onToggleCollaborator(task.id, id) : undefined} />
                  )}
                </>
              )}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt>Due</dt>
            <dd>
              <DateChip value={task.dueDate} time={task.dueTime} onChange={setDue} label="Due date" withTime size="md" status={task.status}
                placeholder={readOnly ? "No due date" : "Add due date"} readOnly={readOnly} />
              {slip && <span className="ktd-note">{slip}</span>}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt>{readOnly ? "Priority" : <label htmlFor={ids.priority}>Priority</label>}</dt>
            <dd>
              {readOnly ? readValue(PRIORITY_META[task.priority]?.label ?? task.priority, false, <PriorityGlyph priority={task.priority} />) : (
                <PropSelect id={ids.priority} menuLabel="Priority" native={nativePick} value={task.priority} wide text={PRIORITY_META[task.priority]?.label ?? task.priority}
                  leading={<PriorityGlyph priority={task.priority} />} options={priorityOptions}
                  onChange={(v) => onPatch(task.id, { priority: v as Priority })} />
              )}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt>{readOnly ? "Project" : <label htmlFor={ids.project}>Project</label>}</dt>
            <dd style={{ flexWrap: "nowrap" }}>
              {readOnly ? readValue(<>{proj?.name || "Project"}{section && <span className="ktd-val-sub"> / {section.name}</span>}</>, false, proj ? <ProjectTile project={proj} size={16} /> : undefined) : (
                <>
                  <PropSelect ref={projectMenu} id={ids.project} menuLabel="Project" native={nativePick} value={task.projectId} text={proj?.name || "Project"}
                    leading={proj ? <ProjectTile project={proj} size={16} /> : undefined} options={projectOptions}
                    onChange={(v) => onPatch(task.id, { projectId: v })} />
                  {hasSections && !addingSection && (
                    <>
                      <span className="ktd-crumb-sep" aria-hidden="true">/</span>
                      <PropSelect id={ids.section} label="Section" native={nativePick} value={task.sectionId ?? ""} empty={!section} text={section?.name ?? "No section"} title="Section"
                        options={sectionOptions}
                        onChange={(v) => {
                          if (v === NEW_SECTION) { setAddingSection(true); return; }
                          onPatch(task.id, { sectionId: v || undefined });
                        }} />
                    </>
                  )}
                  {addingSection && (
                    <>
                      <span className="ktd-crumb-sep" aria-hidden="true">/</span>
                      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                      <input autoFocus id={ids.sectionNew} className="ktd-field-sm" aria-label="New section name" placeholder="New section" value={sectionName}
                        onChange={(e) => setSectionName(e.target.value)} style={{ width: 150, marginLeft: 0 }}
                        onBlur={() => { if (!sectionName.trim()) setAddingSection(false); }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); createSection(); }
                          else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setSectionName(""); setAddingSection(false); }
                        }} />
                    </>
                  )}
                </>
              )}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt>{readOnly ? "Estimate" : <label htmlFor={ids.estimate}>Estimate</label>}</dt>
            <dd>
              {readOnly ? readValue(est == null ? "—" : fmtHours(est), est == null) : (
                <BufferedInput id={ids.estimate} className="ktd-input" data-mono="true" data-narrow="true" placeholder="Add estimate" value={fmtHours(est)}
                  onCommit={(s) => { const h = parseHours(s); if (h === null || h === est) return false; onPatch(task.id, { effortHours: h }); }} />
              )}
              {(energy || (est != null && !readOnly)) && (readOnly
                ? <span className="ktd-note">{energy ? ENERGY[energy].label : ""}</span>
                : <PropSelect id={ids.energy} label="Energy" native={nativePick} small value={energy ?? ""} empty={!energy} title="Energy this needs"
                    text={energy ? ENERGY[energy].label : "Energy"} leading={energy ? <Icon name={ENERGY[energy].icon} size={12} sw={2} /> : undefined}
                    options={energyOptions} onChange={(v) => onPatch(task.id, { energy: v as EnergyKind })} />)}
            </dd>
          </div>

          <div className="ktd-prop">
            <dt id={ids.tags}>Tags</dt>
            <dd>
              {readOnly ? (
                tagsValue ? <span className="ktd-val" data-static="true" data-wrap="true">{tagsValue}</span> : readValue("No tags", true)
              ) : (
                <>
                  <button ref={tagsBtnRef} type="button" className="ktd-val" data-wide="true" data-wrap={tagList.length > 1 || undefined} data-empty={!tagList.length || undefined}
                    aria-haspopup="dialog" aria-expanded={tagsOpen} aria-labelledby={`${ids.tags} ${ids.tagsVal}`} onClick={() => setTagsOpen((o) => !o)}>
                    <span id={ids.tagsVal} style={{ display: "contents" }}>{tagsValue ?? <span className="ktd-val-text">Add tags</span>}</span>
                    <Icon name="plus" size={14} sw={1.75} className="ktd-chev" />
                  </button>
                  {tagsOpen && (
                    <Popover open anchorRef={tagsBtnRef} onClose={() => setTagsOpen(false)} role="dialog" label="Tags" minWidth={280} className="ktd-pop" style={{ ...POP_STYLE, padding: 12, width: 320 }}>
                      <TagPicker tags={tags} selected={task.tags} onToggle={toggleTag} onCreate={onCreateTag} onDelete={onDeleteTag} usage={tagUsage} ownerKey={task.id} small />
                    </Popover>
                  )}
                </>
              )}
            </dd>
          </div>

          {/* optional: filled ones always show; empty ones fold into "+ n more fields" */}
          {(showStart || showAll) && startRow}
          {(hasRepeat || showAll) && repeatRow}
          {(showLogged || showAll) && loggedRow}
          {(showMilestone || showAll) && milestoneRow}
          {filledFields.map(fieldRow)}
          {showAll && emptyFields.map(fieldRow)}
        </dl>
        {!readOnly && (hiddenCount > 0 || canAddField) && (
          <button type="button" className="ktd-more" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
            <Icon name={moreOpen ? "chevronDown" : "plus"} size={14} sw={1.75} />
            {moreOpen ? "Fewer fields" : hiddenCount > 0 ? `${hiddenCount} more field${hiddenCount === 1 ? "" : "s"}` : "More fields"}
          </button>
        )}
        {showAll && canAddField && <div><AddCustomField projectId={task.projectId} onCreate={onCreateCustomField!} /></div>}

        {/* ================= Kanbo suggests (deterministic, never model-written) ================= */}
        {consequence && (
          <div className="ktd-suggest" data-kind={consequence.kind}>
            <AiMark size={14} title="Kanbo suggests" />
            <p>{consequence.text}</p>
            {/* blocked, the only way forward is the blocker; focus is for work you can do */}
            {consequence.blockerId && onOpenTask
              ? <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={() => openTask(consequence.blockerId!)}>Open blocker</Button>
              : !readOnly && !done && !blocked && <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={() => (onStartFocus ?? onFocus)(task.id)}>Start {task.focusMin}m focus</Button>}
          </div>
        )}

        {/* ================= description ================= */}
        {(!readOnly || desc) && (
          <div className="ktd-desc" data-edit={(!readOnly && !descEditing && !!desc) || undefined}>
            <h3 className="sr-only" id={ids.desc}>Description</h3>
            {!readOnly && !descEditing && desc && (
              <Button ref={descEditBtnRef} variant="ghost" size="sm" className="ktd-desc-edit" aria-label="Edit description" onClick={startDescEdit}>Edit</Button>
            )}
            {descEditing && !readOnly ? (
              <div style={{ position: "relative" }}>
                <MdToolbar getEl={() => descRef.current} value={desc} setValue={setDesc} />
                {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                <textarea autoFocus ref={descRef} className="ktd-textarea"
                  aria-labelledby={ids.desc}
                  aria-autocomplete="list"
                  aria-controls={descMatches.length > 0 ? ids.descMentions : undefined}
                  aria-activedescendant={descMatches.length > 0 ? `${ids.descMentions}-${descActive}` : undefined}
                  value={desc}
                  onChange={onDescChange}
                  onFocus={() => { descFocused.current = true; }}
                  onKeyDown={(e) => {
                    if (descMatches.length > 0) {
                      if (e.key === "ArrowDown") { e.preventDefault(); setDescMentionIdx((descActive + 1) % descMatches.length); return; }
                      if (e.key === "ArrowUp") { e.preventDefault(); setDescMentionIdx((descActive - 1 + descMatches.length) % descMatches.length); return; }
                      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickDescMention(descMatches[descActive].name); return; }
                      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDescMentionQuery(null); return; }
                    }
                    // ⌘/Ctrl+Enter finishes editing
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); refocusDescEdit.current = true; stepOut(); }
                  }}
                  onBlur={() => {
                    descFocused.current = false;
                    commitDesc();
                    setDescMentionQuery(null);
                    // swap back to the rendered view a beat later, so the click that
                    // blurred us lands where you aimed before the layout shifts
                    window.setTimeout(() => { if (alive.current && !descFocused.current) setDescEditing(false); }, 120);
                  }}
                  placeholder="Add details…  **bold**, *italic*, - bullets, [links](url)"
                  rows={Math.max(3, Math.min(12, (desc.match(/\n/g)?.length ?? 0) + 2))}
                />
                {descMatches.length > 0 && (
                  <div className="ktd-mention ktd-pop" data-down="true">
                    <div role="listbox" id={ids.descMentions} aria-label="Teammates">
                      {descMatches.map((m, i) => (
                        <button key={m.id} type="button" role="option" id={`${ids.descMentions}-${i}`} aria-selected={i === descActive} tabIndex={-1} className="ktd-mi"
                          onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setDescMentionIdx(i)} onClick={() => pickDescMention(m.name)}
                          style={listOption(i === descActive)}>
                          <Avatar id={m.id} size={20} /><span className="ktd-mi-name">{m.name}</span>
                        </button>
                      ))}
                    </div>
                    <div className="ktd-pop-note">Names here don't notify anyone. @mention them in a comment to ping them.</div>
                  </div>
                )}
              </div>
            ) : !desc ? (
              <button ref={descEditBtnRef} type="button" className="ktd-desc-view" data-editable="true" data-empty="true" aria-label="Edit description" onClick={startDescEdit}>Add details…</button>
            ) : (
              <div className="ktd-desc-view" data-editable={!readOnly || undefined}
                onClick={(e) => { if (readOnly || (e.target as HTMLElement).closest("a")) return; startDescEdit(); }}>
                {renderRich(desc, mentionNames)}
              </div>
            )}
          </div>
        )}

        {/* ================= sub-tasks ================= */}
        {(subTotal > 0 || !readOnly) && (
          <section className="ktd-sec" aria-labelledby={`${uid}-subs`}>
            <div className="ksection">
              <h3 className="ksection-title" id={`${uid}-subs`}>
                Sub-tasks{subTotal > 0 && <span className="ksection-count">{subDone}/{subTotal}</span>}
              </h3>
              {subTotal > 0 && <Meter value={subDone} max={subTotal} width={56} height={4} label={`${subDone} of ${subTotal} sub-tasks done`} />}
              {!readOnly && aiAllowed && (
                <div className="ksection-action">
                  <Button variant="ghost" size="sm" onClick={aiBreakdown} disabled={aiSubBusy} aria-busy={aiSubBusy || undefined} title="Let Kanbo break this into sub-tasks" style={{ color: "var(--ink-2)" }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><AiMark size={14} thinking={aiSubBusy} />{aiSubBusy ? "Breaking it down…" : "Break it down"}</span>
                  </Button>
                </div>
              )}
            </div>
            {aiSubNote && <p className="ktd-ai-note" role="status">{aiSubNote}</p>}
            {children.map((c) => {
              const cdone = c.status === "done";
              const cds = dueState(c.dueDate, c.status);
              return (
                <div key={c.id} className="ktd-row" data-link={onOpenTask ? "true" : undefined} data-done={cdone || undefined}>
                  {readOnly ? <StaticCheck done={cdone} label={c.title} /> : <Check done={cdone} size={16} celebrateKey={c.id} label={c.title} onToggle={() => onToggle(c.id)} />}
                  {onOpenTask
                    ? <button type="button" className="ktd-row-title" onClick={() => openTask(c.id)}>{c.title}</button>
                    : <span className="ktd-row-title">{c.title}</span>}
                  {c.priority === "urgent" && <PriorityGlyph priority="urgent" />}
                  {c.dueDate && <span className="ktd-row-meta" data-tone={cds === "overdue" || cds === "today" ? cds : undefined}>{fmtDue(c.dueDate)}</span>}
                  <Avatar id={c.assigneeId} size={20} />
                  {onOpenTask && <Icon name="chevronRight" size={14} sw={1.75} className="ktd-row-go" />}
                </div>
              );
            })}
            {/* legacy lightweight checklist items, if any */}
            {task.subtasks?.map((s) => (
              <div key={s.id} className="ktd-row" data-done={s.done || undefined}>
                {readOnly ? <StaticCheck done={s.done} label={s.title} /> : <Check done={s.done} size={16} label={s.title} onToggle={() => onToggleSubtask(task.id, s.id)} />}
                <span className="ktd-row-title">{s.title}</span>
              </div>
            ))}
            {!readOnly && (
              <div className="ktd-row">
                <Icon name="plus" size={16} sw={1.75} className="ktd-quiet" />
                <input className="ktd-add-input" data-focus-ring="inline" value={newSub} onChange={(e) => setNewSub(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); addSub(); } }}
                  placeholder="Add sub-task…" aria-label="Add a sub-task" />
                {newSub.trim() && <Button variant="ghost" size="sm" onClick={addSub}>Add</Button>}
              </div>
            )}
          </section>
        )}

        {/* ================= dependencies ================= */}
        {deps.length > 0 && (
          <section className="ktd-sec" aria-labelledby={`${uid}-blockedby`}>
            <div className="ksection">
              <h3 className="ksection-title" id={`${uid}-blockedby`}>Blocked by<span className="ksection-count">{deps.length}</span></h3>
            </div>
            {deps.map((b) => depRow(b, "blocker"))}
            {canAddDep && (depPicker || addDepButton)}
          </section>
        )}
        {dependents.length > 0 && (
          <section className="ktd-sec" aria-labelledby={`${uid}-blocking`}>
            <div className="ksection">
              <h3 className="ksection-title" id={`${uid}-blocking`}>Blocking<span className="ksection-count">{dependents.length}</span></h3>
            </div>
            {dependents.map((d) => depRow(d, "dependent"))}
          </section>
        )}
        {/* nothing blocks it yet: just the way to say so */}
        {deps.length === 0 && canAddDep && <div style={{ marginTop: dependents.length ? 8 : 12 }}>{depPicker || addDepButton}</div>}

        {/* ================= files (hidden while there are none) ================= */}
        {(files.length > 0 || uploading) && (
          <section className="ktd-sec" aria-labelledby={`${uid}-files`}>
            <div className="ksection">
              <h3 className="ksection-title" id={`${uid}-files`}>Files{files.length > 0 && <span className="ksection-count">{files.length}</span>}</h3>
              {!readOnly && (
                <div className="ksection-action">
                  <Button variant="ghost" size="sm" icon="plus" loading={uploading} onClick={() => fileRef.current?.click()} style={{ color: "var(--ink-2)" }}>{uploading ? "Uploading…" : "Attach"}</Button>
                </div>
              )}
            </div>
            {images.length > 0 && (
              <div className="ktd-files">
                {images.map((a) => (
                  <div key={a.id} className="ktd-thumb">
                    <a href={a.url} target="_blank" rel="noreferrer" title={a.name}><img src={a.url} alt={a.name} loading="lazy" /></a>
                    {canRemoveFile(a) && <IconButton icon="x" size="sm" tone="danger" label={`Delete ${a.name}`} onClick={() => removeFile(a)} />}
                  </div>
                ))}
              </div>
            )}
            {otherFiles.map((a) => (
              <div key={a.id} className="ktd-row">
                <Icon name="folder" size={16} sw={1.75} className="ktd-quiet" />
                <a href={a.url} target="_blank" rel="noreferrer" className="ktd-row-title ktd-file-link" title={a.name}>{a.name}</a>
                <span className="ktd-row-meta">{fmtBytes(a.size)}</span>
                {canRemoveFile(a) && <IconButton className="ktd-del" icon="x" size="sm" tone="danger" label={`Delete ${a.name}`} onClick={() => removeFile(a)} />}
              </div>
            ))}
          </section>
        )}

        {/* ================= Notion: pages linked to this task (team tasks, once Notion is connected; guests read-only) ================= */}
        <NotionLinkChip taskId={task.id} workspaceId={taskWs ?? projects.find((p) => p.id === task.projectId)?.workspaceId ?? null} canEdit={!readOnly} />

        {/* ================= activity: comments, history and notifications, oldest first ================= */}
        {timeline.length > 0 && (
          <section className="ktd-sec" aria-labelledby={`${uid}-activity`}>
            <div className="ksection">
              <h3 className="ksection-title" id={`${uid}-activity`}>Activity{thread.length > 0 && <span className="ksection-count" title="Comments">{thread.length}</span>}</h3>
            </div>
            <div className="ktd-tl">
              {timeline.map((item) => {
                if (item.kind === "event") {
                  const e = item.event;
                  return (
                    <div key={item.id} className="ktd-sys">
                      <Icon name={eventIcon(e.field)} size={14} sw={1.75} />
                      <span><b>{e.actorName}</b> {eventText(e, nameOf)} <span aria-hidden="true">·</span> {stamp(e.createdAt)}</span>
                    </div>
                  );
                }
                if (item.kind === "activity") {
                  const a = item.activity;
                  return (
                    <div key={item.id} className="ktd-sys">
                      <Icon name={activityIcon(a)} size={14} sw={1.75} />
                      <span><span>{activityLine(a, mentionNames)}</span> <span aria-hidden="true">·</span> {stamp(a.createdAt)}</span>
                    </div>
                  );
                }
                const c = item.comment;
                const reacts = Object.entries(c.reactions || {}).filter(([, u]) => u?.length);
                return (
                  <div key={item.id} className="ktd-c" data-depth={item.depth}>
                    <Avatar id={c.authorId} size={item.depth ? 20 : 24} />
                    <div style={{ minWidth: 0 }}>
                      <div className="ktd-c-head"><b>{c.authorName || "You"}</b>{stamp(c.createdAt)}</div>
                      {editingComment === c.id ? (
                        <div style={{ marginTop: 4 }}>
                          {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
                          <textarea autoFocus ref={editRef} className="ktd-textarea" value={editDraft} onChange={(e) => setEditDraft(e.target.value)} aria-label="Edit comment"
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) saveCommentEdit(c);
                              else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endCommentEdit(c.id); }
                            }}
                            rows={Math.max(2, Math.min(8, (editDraft.match(/\n/g)?.length ?? 0) + 1))}
                            style={{ fontSize: 14, lineHeight: "22px" }} />
                          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                            <Button variant="primary" size="sm" kbd="⌘↵" onClick={() => saveCommentEdit(c)}>Save</Button>
                            <Button variant="ghost" size="sm" onClick={() => endCommentEdit(c.id)}>Cancel</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="ktd-c-body">{renderRich(c.body, mentionNames)}</div>
                      )}
                      {editingComment !== c.id && (
                        <div className="ktd-c-foot">
                          {reacts.map(([emoji, uids]) => (
                            <button key={emoji} type="button" className="ktd-react" onClick={() => toggleReaction(c, emoji)} title={`${uids.length}`} aria-pressed={uids.includes(currentUserId)}>
                              {emoji} <span className="ktd-react-n">{uids.length}</span>
                            </button>
                          ))}
                          <span className="ktd-c-tools">
                            <button type="button" className="ktd-act" onClick={() => { setReplyingTo(c.parentId ?? c.id); commentRef.current?.focus(); }} aria-label={`Reply to ${c.authorName || "comment"}`}>Reply</button>
                            <button type="button" className="ktd-act" onClick={() => setReactPickerFor((v) => v === c.id ? null : c.id)} aria-expanded={reactPickerFor === c.id}
                              aria-label={c.authorName ? `Add reaction to ${c.authorName}’s comment` : "Add reaction to this comment"}>React</button>
                            {onConvertComment && !readOnly && c.body.trim() && (
                              <button type="button" className="ktd-act" onClick={() => onConvertComment(c.body.trim(), task.projectId)} title="Turn this comment into a task">Make a task</button>
                            )}
                            {c.authorId === currentUserId && (
                              <>
                                <button type="button" className="ktd-act" data-edit-comment={c.id} onClick={() => { setEditDraft(c.body); setEditingComment(c.id); }}>Edit</button>
                                <button type="button" className="ktd-act" data-tone="danger" onClick={() => removeComment(c)}>Delete</button>
                              </>
                            )}
                          </span>
                          {reactPickerFor === c.id && (
                            <>
                              <div onClick={() => setReactPickerFor(null)} style={{ position: "fixed", inset: 0, zIndex: 5 }} />
                              <div className="ktd-pickfloat" data-up="true"><EmojiPicker height={170} onPick={(e) => { toggleReaction(c, e); setReactPickerFor(null); }} /></div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        )}
      </div>

      {/* ================= composer ================= */}
      <div className="ktd-compose">
        {replyingToComment && (
          <div className="ktd-replying">
            <Icon name="arrowRight" size={14} sw={1.75} style={{ color: "var(--accent-text, var(--accent))" }} />
            <span className="truncate" style={{ flex: 1 }}>Replying to <b>{replyingToComment.authorName || "comment"}</b></span>
            <IconButton icon="x" size="sm" label="Cancel reply" onClick={() => setReplyingTo(null)} />
          </div>
        )}
        <div className="ktd-field">
          {mentionMatches.length > 0 && (
            <div className="ktd-mention ktd-pop">
              <div className="ktd-pop-label">Mention</div>
              <div role="listbox" id={ids.mentions} aria-label="Teammates to mention">
                {mentionMatches.map((m, i) => (
                  <button key={m.id} type="button" role="option" id={`${ids.mentions}-${i}`} aria-selected={i === mentionActive} tabIndex={-1} className="ktd-mi"
                    onMouseDown={(e) => e.preventDefault()} onMouseEnter={() => setMentionIdx(i)} onClick={() => pickMention(m)}
                    style={listOption(i === mentionActive)}>
                    <Avatar id={m.id} size={20} /> {m.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <textarea ref={commentRef} value={comment} onChange={onCommentChange} rows={1} onBlur={() => setMentionQuery(null)} data-focus-ring="none"
            aria-label="Add a comment"
            aria-autocomplete="list"
            aria-controls={mentionMatches.length > 0 ? ids.mentions : undefined}
            aria-activedescendant={mentionMatches.length > 0 ? `${ids.mentions}-${mentionActive}` : undefined}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onKeyDown={(e) => {
              if (mentionMatches.length > 0) {
                if (e.key === "ArrowDown") { e.preventDefault(); setMentionIdx((mentionActive + 1) % mentionMatches.length); return; }
                if (e.key === "ArrowUp") { e.preventDefault(); setMentionIdx((mentionActive - 1 + mentionMatches.length) % mentionMatches.length); return; }
                if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mentionMatches[mentionActive]); return; }
              }
              if (e.key === "Escape" && mentionQuery !== null) { e.preventDefault(); e.stopPropagation(); setMentionQuery(null); return; }
              // ⌘/Ctrl+Enter sends; Enter is a new line (and IME composition is left alone)
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); sendComment(); }
            }}
            placeholder="Comment… @ to mention" />
          {comment.trim() && !isMobile && <Kbd>⌘↵</Kbd>}
          <IconButton icon="send" size="sm" label="Send comment" className="ktd-send" data-ready={comment.trim() && !posting ? "true" : undefined}
            onClick={sendComment} disabled={!comment.trim() || posting} aria-busy={posting || undefined} />
        </div>
      </div>
    </div>
  );
}
