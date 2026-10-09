/* ============================================================
   KANBO — drag to plan: the keyboard (and screen reader) way to do
   what a drag does. Loaded on first use (./lazy.ts), never in the
   first download.

   ScheduleMenu  "Schedule…": a start time from a list of quarter
                 hours (↑/↓ 15 minutes, Shift or PgUp/PgDn an hour,
                 Home/End, or type "14" / "1430"), each one saying
                 what it runs into ("overlaps Standup") or that it's
                 past; on Today also the length (←/→ by 15 minutes),
                 in My week also the day (←/→) and "Any time".
                 Enter (or a click on a time) schedules it.
   MoveToMenu    "Move to…": every place mounted right now that takes
                 tasks (Today's list, this week's days, the sidebar's
                 projects, the Team place's people…), from lib/dnd's
                 registry; choosing one runs that place's own drop
                 handler (dropOnTarget), so the result — and its toast
                 with Undo — is the same as a drag's.
   Both are portalled Popovers (global tokens only in their CSS).
   ============================================================ */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import { Popover } from "../primitives/Popover";
import { Button, Icon } from "../primitives";
import { dropOnTarget, useDropTargets, type DropTargetKind, type DropTargetRef, type TaskDragPayload } from "../../lib/dnd";
import { fmtDuration, slotMinutes } from "../views/planCanvas";
import { hhmm } from "./weekSlots";
import type { IconName } from "../../data/types";

const MENU_CSS = `
.ksch { display: flex; flex-direction: column; gap: 8px; padding: 6px 4px 4px; width: 288px; max-width: 100%; }
.ksch-head { display: flex; flex-direction: column; gap: 2px; padding: 0 6px; }
.ksch-head b { font: 600 13px/18px var(--font-ui); color: var(--ink); }
.ksch-head span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-ui); color: var(--ink-3); }
.ksch-days { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 4px; }
.ksch-day { height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: var(--fill-1); cursor: pointer;
  font: 500 12px/16px var(--font-ui); color: var(--ink-2); }
.ksch-day:hover { background: var(--fill-2); color: var(--ink); }
.ksch-day[aria-checked="true"] { background: var(--accent-tint, var(--accent-dim)); color: var(--accent-text, var(--accent)); box-shadow: inset 0 0 0 1px var(--accent-line, var(--accent)); }
.ksch-list { max-height: 232px; overflow-y: auto; overscroll-behavior: contain; margin: 0; padding: 2px; border-radius: var(--r-md, 8px);
  box-shadow: inset 0 0 0 1px var(--hairline); outline: none; }
.ksch-list:focus-visible { box-shadow: inset 0 0 0 2px var(--accent); }
.ksch-opt { display: flex; align-items: center; gap: 10px; height: 30px; padding: 0 8px; border-radius: var(--r-sm, 6px); cursor: pointer; }
.ksch-opt:hover { background: var(--fill-1); }
.ksch-opt[aria-selected="true"] { background: var(--accent-tint, var(--accent-dim)); }
.ksch-time { flex-shrink: 0; width: 88px; font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.ksch-opt[aria-selected="true"] .ksch-time { color: var(--accent-text, var(--accent)); font-weight: 600; }
.ksch-note { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 12px/16px var(--font-ui); color: var(--ink-3); }
.ksch-note[data-tone="clash"] { color: var(--warn, var(--ink-2)); }
.ksch-opt[data-past="true"] .ksch-time { color: var(--ink-3); }
.ksch-len { display: flex; align-items: center; gap: 6px; padding: 0 6px; font: 500 12px/16px var(--font-ui); color: var(--ink-3); }
.ksch-len [role="spinbutton"] { min-width: 52px; height: 28px; padding: 0 8px; border-radius: var(--r-sm, 6px); text-align: center; outline: none;
  font: 600 12px/28px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); background: var(--fill-1); }
.ksch-len [role="spinbutton"]:focus-visible { box-shadow: 0 0 0 2px var(--accent); }
.ksch-foot { display: flex; align-items: center; gap: 8px; padding: 6px 4px 0 6px; border-top: 1px solid var(--hairline); }
.ksch-keys { flex: 1; min-width: 0; font: 500 11px/16px var(--font-mono); color: var(--ink-4); }
.kmove-label { padding: 8px 8px 4px; font: 600 11px/16px var(--font-ui); letter-spacing: 0.02em; color: var(--ink-3); }
.kmove-label:first-child { padding-top: 4px; }
.kmove-item { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; padding: 0 10px 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; cursor: pointer; text-align: left; font: 500 13px/20px var(--font-ui); color: var(--ink-2); }
.kmove-item:hover, .kmove-item:focus-visible { background: var(--fill-1); color: var(--ink); outline: none; }
.kmove-item > svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kmove-item > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kmove-filter { display: block; width: calc(100% - 8px); height: 32px; margin: 2px 4px 4px; padding: 0 10px; border: 0; border-radius: var(--r-sm, 6px);
  background: var(--field-bg, var(--fill-1)); box-shadow: inset 0 0 0 1px var(--field-border, var(--hairline-strong)); font: 500 13px/20px var(--font-ui); color: var(--ink); }
.kmove-filter:focus { outline: 2px solid var(--accent); outline-offset: 0; }
.kmove-empty { padding: 8px 10px; font: 400 13px/20px var(--font-ui); color: var(--ink-3); }
@media (pointer: coarse) { .ksch-opt { height: 40px; } .ksch-day { height: 36px; } .ksch-keys { display: none; } }
`;

/* ============================== Schedule… ============================== */

export interface ScheduleBusy { start: number; end: number; title: string }
export interface ScheduleDay { date: string; label: string }
export interface SchedulePick { date?: string; minute: number | null; dur?: number }

export interface ScheduleMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** the task's title (the dialog is "Schedule “…”") */
  title: string;
  /** My week: the days to choose from (←/→ moves between them); omitted: today only */
  days?: ScheduleDay[];
  /** where the picker starts: the day, the start time (null = no time yet), the length */
  value: SchedulePick;
  /** My week: "Any time" (a day without a time) */
  allowNoTime?: boolean;
  /** Today: the block's length, ←/→ by 15 minutes */
  withDuration?: boolean;
  /** the stretch of the day on offer (minutes), on the quarter hour by default */
  from?: number;
  to?: number;
  step?: number;
  /** what's on a day already (meetings, other blocks), for "overlaps Standup" */
  busy?: (date: string | undefined) => ScheduleBusy[];
  /** now: earlier times today say "past" (still allowed) */
  nowMin?: number;
  today?: string;
  onPick: (v: SchedulePick) => void;
  /** the button's word (default "Schedule") */
  pickLabel?: string;
}

const clampN = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function ScheduleMenu({
  open, anchorRef, onClose, title, days, value, allowNoTime = false, withDuration = false, from = 7 * 60, to = 22 * 60, step = 15,
  busy, nowMin, today, onPick, pickLabel = "Schedule",
}: ScheduleMenuProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const listRef = useRef<HTMLDivElement>(null);
  const [date, setDate] = useState<string | undefined>(value.date ?? days?.[0]?.date);
  const [dur, setDur] = useState(() => clampN(Math.round((value.dur ?? 30) / step) * step || step, step, Math.max(step, to - from)));
  const slots = useMemo(() => slotMinutes(from, to, withDuration ? dur : step, step), [from, to, dur, step, withDuration]);
  const options = useMemo<(number | null)[]>(() => (allowNoTime ? [null, ...slots] : slots), [allowNoTime, slots]);
  const nearest = (m: number | null | undefined): number | null => {
    if (m == null) {
      if (allowNoTime) return null;
      const soon = date && today && date === today && nowMin != null ? Math.ceil(nowMin / step) * step : from;
      return slots.find((s) => s >= soon) ?? slots[slots.length - 1] ?? null;
    }
    if (!slots.length) return null;
    const snapped = Math.round(m / step) * step;
    return clampN(snapped, slots[0], slots[slots.length - 1]);
  };
  const [minute, setMinute] = useState<number | null>(() => nearest(value.minute));
  // a longer block has fewer starts left in the day: keep the choice inside them
  useEffect(() => { setMinute((m) => (m == null ? m : nearest(m))); }, [slots]); // eslint-disable-line react-hooks/exhaustive-deps

  const busyNow = useMemo(() => busy?.(date) ?? [], [busy, date]);
  const describe = (m: number | null) => {
    if (m == null) return { text: "No time, just the day", tone: undefined as string | undefined, label: "Any time" };
    const end = m + (withDuration ? dur : step);
    const hit = busyNow.filter((b) => b.start < end && b.end > m).map((b) => b.title);
    const past = !!today && date === today && nowMin != null && end <= nowMin;
    const range = withDuration ? `${hhmm(m)}–${hhmm(end)}` : hhmm(m);
    const text = hit.length ? `${hit[0]}${hit.length > 1 ? ` +${hit.length - 1}` : ""}` : past ? "Past" : "";
    const label = `${range}${hit.length ? `, overlaps ${hit.join(", ")}` : past ? ", earlier today" : ", free"}`;
    return { text, tone: hit.length ? "clash" : undefined, label, past, range };
  };

  // the chosen time stays in view as it moves
  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }, [minute, open]);

  // type a time: "9" → 09:00, "14" → 14:00, "143" / "1430" → 14:30
  const typed = useRef({ text: "", at: 0 });
  const typeAhead = (k: string) => {
    const now = Date.now();
    const t = (now - typed.current.at < 900 ? typed.current.text : "") + k;
    typed.current = { text: t, at: now };
    const h = t.length <= 2 ? +t : +t.slice(0, t.length - 2);
    const mm = t.length <= 2 ? 0 : +t.slice(-2).padEnd(2, "0");
    if (!Number.isFinite(h) || h > 23) return;
    const want = h * 60 + Math.min(59, mm);
    const best = options.filter((o): o is number => o != null).reduce<number | null>((b, o) => (b == null || Math.abs(o - want) < Math.abs(b - want) ? o : b), null);
    if (best != null) setMinute(best);
  };

  const pick = (m: number | null = minute) => {
    if (m == null && !allowNoTime) return;
    onClose();
    onPick({ ...(date ? { date } : {}), minute: m, ...(withDuration ? { dur } : {}) });
  };
  const moveBy = (n: number) => {
    const i = options.indexOf(minute);
    const next = options[clampN((i < 0 ? 0 : i) + n, 0, options.length - 1)];
    if (next !== undefined) setMinute(next);
  };
  const moveDay = (n: number) => {
    if (!days?.length) return;
    const i = Math.max(0, days.findIndex((d) => d.date === date));
    setDate(days[clampN(i + n, 0, days.length - 1)].date);
  };
  const lengthBy = (n: number) => setDur((d) => clampN(d + n * step, step, Math.max(step, Math.min(8 * 60, to - from))));

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const hour = Math.max(1, Math.round(60 / step));
    switch (e.key) {
      case "ArrowDown": moveBy(e.shiftKey ? hour : 1); break;
      case "ArrowUp": moveBy(e.shiftKey ? -hour : -1); break;
      case "PageDown": moveBy(hour); break;
      case "PageUp": moveBy(-hour); break;
      case "Home": setMinute(options[0] ?? null); break;
      case "End": setMinute(options[options.length - 1] ?? null); break;
      case "ArrowRight": if (withDuration) lengthBy(1); else moveDay(1); break;
      case "ArrowLeft": if (withDuration) lengthBy(-1); else moveDay(-1); break;
      case "Enter": case " ": pick(); break;
      default:
        if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) { typeAhead(e.key); break; }
        return;
    }
    e.preventDefault();
  };
  const onDayKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    moveDay(e.key === "ArrowRight" ? 1 : -1);
    requestAnimationFrame(() => (e.currentTarget?.querySelector?.('[aria-checked="true"]') as HTMLElement | null)?.focus());
  };

  const optId = (m: number | null) => `${uid}-o-${m ?? "any"}`;
  const keys = withDuration ? "↑↓ time · ←→ length" : days?.length ? "↑↓ time · ←→ day" : "↑↓ time · ⇧↑↓ hour";
  const chosen = describe(minute);
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} role="dialog" label={`Schedule “${title}”`} minWidth={288} initialFocus={listRef}>
      <style>{MENU_CSS}</style>
      <div className="ksch">
        <div className="ksch-head">
          <b>{pickLabel === "Schedule" ? "Schedule" : pickLabel}</b>
          <span title={title}>{title}</span>
        </div>
        {days && days.length > 1 && (
          <div className="ksch-days" role="radiogroup" aria-label="Day" onKeyDown={onDayKey}>
            {days.map((d) => (
              <button key={d.date} type="button" role="radio" aria-checked={d.date === date} tabIndex={d.date === date ? 0 : -1}
                className="ksch-day" onClick={() => setDate(d.date)}>{d.label}</button>
            ))}
          </div>
        )}
        <div ref={listRef} className="ksch-list" role="listbox" tabIndex={0} aria-label="Start time" aria-activedescendant={optId(minute)} onKeyDown={onKey}>
          {options.map((m) => {
            const d = describe(m);
            return (
              <div key={m ?? "any"} id={optId(m)} role="option" aria-selected={m === minute} aria-label={d.label} className="ksch-opt"
                data-past={d.past || undefined} onClick={() => { setMinute(m); pick(m); }}>
                <span className="ksch-time" aria-hidden="true">{m == null ? "Any time" : d.range}</span>
                <span className="ksch-note" aria-hidden="true" data-tone={d.tone}>{d.text}</span>
              </div>
            );
          })}
        </div>
        {withDuration && (
          <div className="ksch-len">
            <span id={`${uid}-len`}>Length</span>
            <button type="button" className="kibtn" data-size="sm" tabIndex={-1} aria-label="Shorter by 15 minutes" onClick={() => lengthBy(-1)}><Icon name="chevronLeft" size={14} sw={2} /></button>
            <div role="spinbutton" tabIndex={0} aria-labelledby={`${uid}-len`} aria-valuenow={dur} aria-valuemin={step} aria-valuemax={8 * 60}
              aria-valuetext={fmtDuration(dur)} onKeyDown={(e) => {
                if (e.key === "ArrowUp" || e.key === "ArrowRight") { e.preventDefault(); lengthBy(1); }
                else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { e.preventDefault(); lengthBy(-1); }
                else if (e.key === "Enter") { e.preventDefault(); pick(); }
              }}>{fmtDuration(dur)}</div>
            <button type="button" className="kibtn" data-size="sm" tabIndex={-1} aria-label="Longer by 15 minutes" onClick={() => lengthBy(1)}><Icon name="chevronRight" size={14} sw={2} /></button>
          </div>
        )}
        <div className="ksch-foot">
          <span className="ksch-keys" aria-hidden="true">{keys}</span>
          <Button size="sm" variant="primary" kbd="⏎" onClick={() => pick()} disabled={minute == null && !allowNoTime}
            aria-label={`${pickLabel}: ${minute == null ? "any time" : chosen.range}`}>{pickLabel}</Button>
        </div>
      </div>
    </Popover>
  );
}

/* ============================== Move to… ============================== */

const GROUPS: { kinds: DropTargetKind[]; label: string; icon: IconName }[] = [
  { kinds: ["today-rail", "today-slot"], label: "Today", icon: "sun" },
  { kinds: ["week-day", "week-slot"], label: "This week", icon: "calendar" },
  { kinds: ["project"], label: "Projects", icon: "folder" },
  { kinds: ["section"], label: "Sections", icon: "list" },
  { kinds: ["board-column"], label: "Columns", icon: "board" },
  { kinds: ["person"], label: "People", icon: "user" },
];
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export interface MoveToMenuProps {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** what would be dragged: the task(s), and where from */
  payload: TaskDragPayload;
  /** the menu's name: `Move “Write brief” to` */
  label: string;
  /** only these kinds (default: every place that takes tasks) */
  kinds?: DropTargetKind[];
  /** leave a target out (e.g. the place the task is already in) */
  exclude?: (t: DropTargetRef) => boolean;
  /** after a choice: whether the place took it */
  onDone?: (t: DropTargetRef, ok: boolean) => void;
}

export function MoveToMenu({ open, anchorRef, onClose, payload, label, kinds, exclude, onDone }: MoveToMenuProps) {
  const all = useDropTargets(kinds);
  const [q, setQ] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const targets = exclude ? all.filter((t) => !exclude(t)) : all;
  const shown = q.trim() ? targets.filter((t) => fold(t.label ?? t.id).includes(fold(q.trim()))) : targets;
  const choose = (t: DropTargetRef) => {
    const ok = dropOnTarget(payload, t);
    onClose();
    onDone?.(t, ok);
  };
  return (
    <Popover open={open} anchorRef={anchorRef} onClose={onClose} label={label} minWidth={240} maxHeight={420}
      initialFocus={targets.length > 8 ? filterRef : undefined}>
      <style>{MENU_CSS}</style>
      {targets.length > 8 && (
        <input ref={filterRef} className="kmove-filter" type="search" placeholder="Find a place" aria-label="Find a place" value={q}
          onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) { e.preventDefault(); choose(shown[0]); } }} />
      )}
      {GROUPS.map((g) => {
        const items = shown.filter((t) => g.kinds.includes(t.kind));
        if (!items.length) return null;
        return [
          <div key={g.label + "-label"} className="kmove-label" role="presentation">{g.label}</div>,
          ...items.map((t) => (
            <button key={t.kind + t.id} type="button" role="menuitem" className="kmove-item" onClick={() => choose(t)}>
              <Icon name={g.icon} size={16} sw={1.75} /><span>{t.label ?? t.id}</span>
            </button>
          )),
        ];
      })}
      {shown.length === 0 && <div className="kmove-empty" role="presentation">{targets.length ? "No place matches." : "Nowhere to move it from here."}</div>}
    </Popover>
  );
}
