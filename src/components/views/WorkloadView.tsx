/* ============================================================
   KANBO — Team › Workload: each person's load, week by week, against
   their weekly capacity (hours, set per person on this device).
   People are rows and weeks are columns; bars read ink when there's
   room, amber from 90% and red over capacity, with a tick where the
   capacity sits. Pick a week to list its work; open a person to see
   their tasks and set their capacity.
   Hours come from the shared load model (lib/radar): a task's estimate,
   else its planned block, else 1h — the same numbers Pulse shows.
   ============================================================ */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { Avatar, Button, Collapse, EmptyState, Icon, IconButton, Meter, StatusGlyph } from "../primitives";
import { getMember, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";
import { addDays, fmtDayMonth, fmtHours, round1, startOfWeekMon } from "./reportingUtils";
import { DEFAULT_CAPACITY, capacityOf, loadForWeek, loadTone, readCapacities, writeCapacities, type PersonLoad } from "../../lib/radar";

export { readCapacities };

/** A field that edits a local draft and saves once — on blur or Enter; Escape
 *  reverts. Saving on every keystroke sent ~25 UPDATEs per name, and a
 *  realtime reload in between could revert the field mid-word.
 *  Only a value the user actually typed is ever saved: focusing a field and
 *  leaving it never writes, so a teammate's change that arrives meanwhile
 *  shows up and is kept. */
function DraftInput({ value, onCommit, label, style, type = "text", placeholder, required = false, min, max, title, className }: {
  value: string | number | undefined;
  /** save the typed value. Return false to reject it (the field shows the
   *  saved value again), or a string to show the value as it was stored. */
  onCommit: (v: string) => void | string | false;
  label: string;
  style?: CSSProperties;
  type?: "text" | "number";
  placeholder?: string;
  /** an empty value reverts instead of saving (names can't be blank) */
  required?: boolean;
  min?: number;
  max?: number;
  title?: string;
  className?: string;
}) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);
  // true once the user has typed; until then the field keeps following `value`
  const dirty = useRef(false);
  const cancelled = useRef(false);
  // follow outside changes (another tab, a teammate) — but never over unsaved typing
  useEffect(() => { if (!dirty.current) setDraft(external); }, [external]);
  const commit = () => {
    const typed = dirty.current, escaped = cancelled.current;
    dirty.current = false; cancelled.current = false;
    if (!typed || escaped) { setDraft(external); return; }
    const v = type === "text" ? draft.trim() : draft;
    if ((required && !v) || v === external) { setDraft(external); return; }
    const shown = onCommit(v);
    setDraft(shown === false ? external : typeof shown === "string" ? shown : v);
  };
  return (
    <input type={type} value={draft} min={min} max={max} title={title} placeholder={placeholder} aria-label={label} style={style} className={className}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
  );
}

/* ---------------- WORKLOAD ---------------- */
export const DEFAULT_CAP = DEFAULT_CAPACITY;   // weekly capacity (hours) unless set per person
const MIN_CAP = 1, MAX_CAP = 168;
const HEAVY = 12;         // tasks in one week that signal overload even without estimates
const WEEKS = 4;          // week columns (fewer on narrow screens)
const MAX_OFFSET = 12;

/* Radar's "Rebalance" opens Workload with that person's week already open. */
const FOCUS_KEY = "kanbo-workload-focus";
/** Open this person's row the next time Workload shows (Radar › Rebalance). */
export function focusWorkloadMember(id: string): void {
  try { sessionStorage.setItem(FOCUS_KEY, id); } catch { /* private mode */ }
}
function peekWorkloadFocus(): string | null {
  try { return sessionStorage.getItem(FOCUS_KEY); } catch { return null; }
}

const weekWord = (offset: number) => (offset === 0 ? "This week" : offset === 1 ? "Next week" : `In ${offset} weeks`);
const fmtDay = fmtDayMonth;

export function WorkloadView({ tasks, members, onOpen, personal, onNewWorkspace }: {
  tasks: Task[];
  /** `guest: true` for guests (external, view-and-comment): their work shows, but they
   *  carry no team capacity and are never the one suggested to take more on */
  members: { id: string; name: string; guest?: boolean }[];
  onOpen: (id: string) => void;
  /** the Personal workspace: Workload is for teams, so it explains itself instead */
  personal?: boolean;
  onNewWorkspace?: () => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);       // the first week column
  const [pick, setPick] = useState(0);                    // the week (column) whose work is listed
  // read while rendering (an initializer may run twice), cleared once mounted so it's used once
  const [focusId] = useState(peekWorkloadFocus);
  useEffect(() => { try { sessionStorage.removeItem(FOCUS_KEY); } catch { /* private mode */ } }, []);
  const [expanded, setExpanded] = useState<string | null>(focusId);
  const [caps, setCaps] = useState<Record<string, number>>(readCapacities);
  const capOf = (id: string) => capacityOf(caps, id);
  const setCap = (id: string, hours: number) => setCaps((cur) => {
    const next = { ...cur };
    const h = round1(hours);
    if (!(h > 0) || h === DEFAULT_CAP) delete next[id]; else next[id] = h;
    writeCapacities(next);
    return next;
  });
  // Radar › Rebalance lands here: that person's row is open, in view, and has keyboard focus
  const focusRow = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusId) return;
    const row = focusRow.current;
    row?.querySelector<HTMLElement>(".kload-who")?.focus({ preventScroll: true });
    row?.scrollIntoView?.({ block: "center" });
  }, [focusId]);

  // the day moves with the live clock (KANBO_TODAY is updated in place at midnight)
  const todayKey = KANBO_TODAY.getTime();
  const weeks = useMemo(() => {
    const today = new Date(todayKey);
    const base = startOfWeekMon(today);
    return Array.from({ length: WEEKS }, (_, i) => {
      const offset = weekOffset + i;
      const start = addDays(base, offset * 7);
      return { offset, start, ...loadForWeek(tasks, start, today) };
    });
  }, [tasks, weekOffset, todayKey]);
  const focus = weeks[Math.min(pick, WEEKS - 1)];

  const isMember = (id: string) => members.some((m) => m.id === id);
  const isGuest = (id: string) => members.some((m) => m.id === id && m.guest);
  /** a teammate who carries capacity (not a guest, not someone who's left) */
  const isTeammate = (id: string) => isMember(id) && !isGuest(id);
  function nameOf(id: string): string {
    if (!id) return "Unassigned";
    const m = members.find((x) => x.id === id);
    if (m) return m.name;
    const known = getMember(id)?.name;
    return known ? `${known} (former member)` : "(former member)";
  }
  const empty = (id: string): PersonLoad => ({ id, hours: 0, items: [], undated: 0 });
  // members always show; "Unassigned" and people who've left only when they carry work in view
  const ids = new Set<string>(members.map((m) => m.id));
  weeks.forEach((w) => w.rows.forEach((r) => { if (r.items.length > 0) ids.add(r.id); }));
  // teammates first, then guests, then unassigned work and people who've left
  const rank = (id: string) => (isTeammate(id) ? 0 : isMember(id) ? 1 : 2);
  const rows = [...ids].map((id) => ({ id, focus: focus.rows.get(id) ?? empty(id) }))
    .sort((a, b) => rank(a.id) - rank(b.id)
      || (b.focus.hours - a.focus.hours) || (b.focus.items.length - a.focus.items.length) || nameOf(a.id).localeCompare(nameOf(b.id)));

  // compare the hours as shown (1 decimal), so "40h / 40h" is never flagged over capacity
  const isOver = (r: PersonLoad) => round1(r.hours) > capOf(r.id);
  const overloaded = rows.filter((r) => isTeammate(r.id) && (isOver(r.focus) || r.focus.items.length >= HEAVY));
  const orphaned = rows.filter((r) => !isMember(r.id)).reduce((a, r) => a + r.focus.items.length, 0);
  // rebalance hint: the busiest person + a teammate (never a guest) who clearly has room
  const freeest = rows.filter((r) => isTeammate(r.id)).sort((a, b) => (a.focus.hours / capOf(a.id) - b.focus.hours / capOf(b.id)) || (a.focus.items.length - b.focus.items.length))[0];
  const rebalance = overloaded.length && freeest && freeest.id !== overloaded[0].id && freeest.focus.hours < capOf(freeest.id) * 0.6 && freeest.focus.items.length < HEAVY
    ? { from: nameOf(overloaded[0].id), to: nameOf(freeest.id) }
    : null;
  const inView = weeks.reduce((a, w) => a + [...w.rows.values()].reduce((x, r) => x + r.items.length, 0), 0);
  const noEstimates = inView > 0 && weeks.every((w) => w.estimated === 0);
  // nothing dated in these weeks (day one of a rollout): say what makes Workload work, not a grid of zeros alone
  const nothingDated = inView === 0 && members.length > 0;
  const undatedAll = weeks[0]?.undated ?? 0;
  const someUnestimated = !noEstimates && focus && [...focus.rows.values()].some((r) => r.items.some((i) => !i.estimated));
  const thatWeek = focus.offset === 0 ? "this week" : "that week";
  const shift = (by: number) => { setWeekOffset((w) => Math.min(MAX_OFFSET, Math.max(0, w + by))); setPick(0); };

  if (personal) {
    return (
      <div className="kload" data-personal="">
        <style>{WORKLOAD_CSS}</style>
        <EmptyState art="chart" size="lg" title="Workload is for teams"
          body="In a team workspace, Workload shows who has room each week, from everyone's estimates and capacity."
          action={onNewWorkspace ? <Button variant="primary" icon="plus" onClick={onNewWorkspace}>New workspace</Button> : undefined} />
      </div>
    );
  }

  return (
    <div className="kload">
      <style>{WORKLOAD_CSS}</style>
      <div className="kload-bar">
        <div className="kload-nav">
          <IconButton icon="chevronLeft" label="Earlier week" size="sm" variant="secondary" onClick={() => shift(-1)} disabled={weekOffset === 0} />
          <IconButton icon="chevronRight" label="Later week" size="sm" variant="secondary" onClick={() => shift(1)} disabled={weekOffset >= MAX_OFFSET} />
          <div className="kload-range" aria-live="polite">
            <span className="kload-range-title">{weekWord(focus.offset)}</span>
            <span className="kload-range-dates">{fmtDay(focus.start)} – {fmtDay(addDays(focus.start, 6))}</span>
          </div>
          {weekOffset > 0 && <Button size="sm" variant="ghost" onClick={() => { setWeekOffset(0); setPick(0); }}>Back to this week</Button>}
        </div>
        <div className="kload-legend" aria-hidden="true">
          <span><i data-tone="ink" />Room</span>
          <span><i data-tone="warn" />Near capacity</span>
          <span><i data-tone="signal" />Over</span>
          <span><i data-tone="tick" />Capacity</span>
        </div>
      </div>

      {nothingDated && (
        <p className="kload-notice" data-tone="info">
          <Icon name="calendar" size={16} sw={1.75} />
          <span>
            <strong>No dated work {weekOffset === 0 ? "in the next four weeks" : "in these weeks"}.</strong>{" "}
            Give tasks a due date (and an estimate like ~2h) and Workload shows who has room.
            {undatedAll > 0 && <> {undatedAll} open task{undatedAll === 1 ? " has" : "s have"} no dates yet.</>}
          </span>
        </p>
      )}
      {noEstimates && (
        <p className="kload-notice" data-tone="info">
          <Icon name="clock" size={16} sw={1.75} />
          <span>Add estimates (~2h) to tasks to see real load — until then Kanbo counts 1h per task.</span>
        </p>
      )}
      {overloaded.length > 0 && (
        <p className="kload-notice" data-tone="signal">
          <Icon name="zap" size={16} sw={1.75} />
          <span>
            <strong>{overloaded.length} {overloaded.length === 1 ? "person looks" : "people look"} overloaded.</strong>{" "}
            {overloaded.map((r) => nameOf(r.id)).slice(0, 3).join(", ")}{overloaded.length > 3 ? ` +${overloaded.length - 3} more` : ""} {overloaded.length === 1 ? "is" : "are"} over capacity or carrying a lot of work {thatWeek}.
            {rebalance && <> Consider moving a task or two from <strong>{rebalance.from}</strong> to <strong>{rebalance.to}</strong>, who has room.</>}
          </span>
        </p>
      )}
      {orphaned > 0 && (
        <p className="kload-notice" data-tone="quiet">
          <Icon name="user" size={16} sw={1.75} />
          <span>{orphaned} task{orphaned === 1 ? " is" : "s are"} unassigned or assigned to someone no longer in this workspace — reassign {orphaned === 1 ? "it" : "them"} below.</span>
        </p>
      )}

      {rows.length === 0 ? (
        <EmptyState art="chart" title="No workload yet" body="Assign tasks and give them an hours estimate to see who has room." />
      ) : (
        <div className="kload-table" role="table" aria-label={`Workload, ${fmtDay(weeks[0].start)} to ${fmtDay(addDays(weeks[WEEKS - 1].start, 6))}`}>
          <div className="kload-row kload-head" role="row">
            <span className="kload-person" role="columnheader">Person</span>
            {weeks.map((w, i) => (
              <span key={w.offset} className="kload-cell" data-col={i} role="columnheader">
                <button type="button" className="kload-week" aria-pressed={i === pick} onClick={() => setPick(i)}
                  title={`List ${weekWord(w.offset).toLowerCase()}'s work`}>
                  <span>{weekWord(w.offset)}</span>
                  <span className="kload-week-dates">{fmtDay(w.start)} – {fmtDay(addDays(w.start, 6))}</span>
                </button>
              </span>
            ))}
          </div>
          {rows.map((row) => {
            const r = row.focus;
            const member = isMember(r.id);
            const guest = member && isGuest(r.id);
            const teammate = member && !guest;   // carries capacity
            const cap = capOf(r.id);
            const name = nameOf(r.id);
            const open = expanded === r.id;
            const panelId = `workload-${r.id || "unassigned"}`;
            const overdueN = r.items.filter((i) => i.overdue).length;
            return (
              <div key={r.id || "unassigned"} className="kload-group" data-open={open || undefined} ref={r.id === focusId ? focusRow : undefined}>
                <div className="kload-row" role="row">
                  <span className="kload-person" role="rowheader">
                    <button type="button" className="kload-who" onClick={() => setExpanded((e) => e === r.id ? null : r.id)} aria-expanded={open} aria-controls={panelId}>
                      {getMember(r.id) ? <Avatar id={r.id} size={28} /> : <span className="kload-ghost" aria-hidden="true" />}
                      <span className="kload-name">
                        <span className="truncate" data-member={member || undefined}>{name}</span>
                        {teammate && <span className="kload-cap">{fmtHours(cap)} a week</span>}
                        {guest && <span className="kload-sub">Guest</span>}
                      </span>
                      <Icon name="chevronDown" size={16} sw={1.75} className="kload-chev" />
                    </button>
                  </span>
                  {weeks.map((w, i) => {
                    const load = w.rows.get(r.id) ?? empty(r.id);
                    const over = teammate && isOver(load);
                    const heavy = teammate && !over && load.items.length >= HEAVY;
                    const tone = !teammate ? "ink" : heavy ? "warn" : loadTone(load.hours, cap);
                    const none = load.items.length === 0;
                    const state = over ? ", over capacity" : heavy ? ", heavy load" : tone === "warn" ? ", near capacity" : "";
                    return (
                      <span key={w.offset} className="kload-cell" data-col={i} data-picked={i === pick || undefined} role="cell">
                        <span className="kload-figures" data-tone={none ? "none" : tone}>
                          {none ? (teammate ? `0h / ${fmtHours(cap)}` : "—") : `${fmtHours(load.hours)}${teammate ? ` / ${fmtHours(cap)}` : ""} · ${load.items.length} task${load.items.length === 1 ? "" : "s"}`}
                          {state && <span className="sr-only">{state}</span>}
                        </span>
                        {/* the figures carry it for screen readers: a progressbar's percentage (of 125% of capacity) would only confuse */}
                        {teammate && (
                          <span className="kload-meter" aria-hidden="true">
                            <Meter value={load.hours} max={cap * 1.25} marker={cap} height={6} tone={tone}
                              label={`${name}, ${weekWord(w.offset).toLowerCase()}: ${fmtHours(load.hours)} of ${fmtHours(cap)}`} />
                          </span>
                        )}
                        {i === pick && over && <span className="kload-flag" data-tone="signal">Over by {fmtHours(round1(load.hours) - cap)}</span>}
                        {i === pick && heavy && <span className="kload-flag" data-tone="warn">Heavy load — {load.items.length} tasks</span>}
                      </span>
                    );
                  })}
                </div>
                <Collapse open={open}>
                  <div className="kload-detail-row" role="row">
                    <div id={panelId} className="kload-detail" role="cell" aria-colspan={WEEKS + 1}>
                      <p className="kload-detail-head">{weekWord(focus.offset)} · {fmtDay(focus.start)} – {fmtDay(addDays(focus.start, 6))}{overdueN > 0 && <span className="kload-late"> · {overdueN} overdue</span>}</p>
                      {r.items.length === 0 && <p className="kload-muted">Nothing due {thatWeek}.</p>}
                      {r.items.map(({ task: t, hours, overdue, estimated }) => {
                        const effort = t.effortHours ?? 0;
                        const partial = effort > 0 && round1(hours) !== round1(effort);
                        return (
                          <button key={t.id} type="button" className="kload-task" onClick={() => onOpen(t.id)} aria-label={`Open task ${t.title}`}>
                            <StatusGlyph status={t.status} size={14} />
                            <span className="kload-task-title truncate">{t.title}</span>
                            {t.dueDate && <span className="kload-task-due" data-late={overdue || undefined}>{overdue ? "Overdue · " : "Due "}{fmtDay(new Date(t.dueDate + "T00:00:00"))}</span>}
                            <span className="kload-task-hours" title={partial ? "This week's share of the estimate" : !estimated ? "No estimate — counted as 1h" : undefined}>
                              {!estimated ? "~1h" : partial ? `${fmtHours(hours)} of ${fmtHours(effort)}` : fmtHours(hours)}
                            </span>
                          </button>
                        );
                      })}
                      {r.undated > 0 && <p className="kload-muted">+ {r.undated} open task{r.undated === 1 ? "" : "s"} with no dates (not counted).</p>}
                      {teammate && (
                        <label className="kload-capedit">
                          Weekly capacity
                          <DraftInput type="number" min={MIN_CAP} max={MAX_CAP} value={cap} label={`Weekly capacity for ${name}, in hours`} title={`Between ${MIN_CAP} and ${MAX_CAP} hours`}
                            onCommit={(v) => {
                              // out of range (or cleared) → the box shows the capacity actually in use again
                              const h = Number(v);
                              if (v.trim() === "" || !(h >= MIN_CAP && h <= MAX_CAP)) return false;
                              setCap(r.id, h);
                              return String(round1(h));
                            }} className="kload-capinput" />
                          h <span className="kload-muted-inline">· {MIN_CAP}–{MAX_CAP}h · saved on this device</span>
                        </label>
                      )}
                      {guest && <p className="kload-muted">Guests don't carry team capacity.</p>}
                    </div>
                  </div>
                </Collapse>
              </div>
            );
          })}
        </div>
      )}
      <p className="kload-foot">
        Hours due each week against capacity ({DEFAULT_CAP}h unless you set one). Work with a start and due date is spread across the working days between them{focus.offset === 0 ? "; late work counts in full this week" : ""}.{someUnestimated ? " Tasks without an estimate count as 1h." : ""}
        {focus.undated > 0 && <> {focus.undated} open task{focus.undated === 1 ? " has" : "s have"} no start or due date, so {focus.undated === 1 ? "it isn't" : "they aren't"} counted.</>}
      </p>
    </div>
  );
}

const WORKLOAD_CSS = `
.kload { flex: 1; min-width: 0; overflow-y: auto; padding: 0 var(--gutter, 32px) 48px; container-type: inline-size; }
.kload[data-personal] { display: grid; place-items: center; }
/* 48px, the same in-page bar as Pulse and People */
.kload-bar { display: flex; align-items: center; gap: 8px 16px; flex-wrap: wrap; min-height: 48px; padding: 0; }
.kload-nav { display: flex; align-items: center; gap: 6px; }
.kload-range { display: flex; align-items: baseline; gap: 8px; margin-left: 6px; }
.kload-range-title { font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kload-range-dates { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kload-legend { display: flex; align-items: center; gap: 14px; margin-left: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-legend span { display: inline-flex; align-items: center; gap: 6px; }
.kload-legend i { width: 12px; height: 6px; border-radius: 999px; background: var(--ink-3); }
.kload-legend i[data-tone="warn"] { background: var(--warn-fill, var(--st-review)); }
.kload-legend i[data-tone="signal"] { background: var(--signal, var(--st-blocked)); }
.kload-legend i[data-tone="tick"] { width: 1.5px; height: 10px; border-radius: 1px; background: var(--ink-2); }
.kload-notice { display: flex; align-items: flex-start; gap: 10px; margin: 0 0 12px; padding: 10px 12px; border-radius: var(--r-md, 8px);
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); background: var(--fill-1); }
.kload-notice svg { flex-shrink: 0; margin-top: 2px; color: var(--ink-3); }
.kload-notice[data-tone="signal"] { background: var(--signal-tint, color-mix(in oklch, var(--st-blocked) 8%, transparent)); }
.kload-notice[data-tone="signal"] svg, .kload-notice[data-tone="signal"] strong:first-child { color: var(--signal, var(--st-blocked)); }
.kload-notice[data-tone="quiet"] { background: transparent; padding: 0 0 0 2px; color: var(--ink-3); }
.kload-notice strong { font-weight: 600; color: var(--ink); }
.kload-table { display: flex; flex-direction: column; }
.kload-row { display: grid; grid-template-columns: minmax(180px, 240px) repeat(${WEEKS}, minmax(0, 1fr)); gap: 0 24px; align-items: center; }
.kload-head { min-height: 44px; border-bottom: 1px solid var(--hairline); font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-head .kload-person { padding-left: 8px; }
.kload-week { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: calc(100% + 16px); margin: 0 -8px; padding: 6px 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-3); font: 600 12px/16px var(--font-ui, var(--font-display)); text-align: left; cursor: pointer;
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease); }
.kload-week:hover { background: var(--fill-1); color: var(--ink-2); }
.kload-week { position: relative; }
/* the picked week's underline spans exactly its column (the hover box overhangs it by 8px each side) */
.kload-week[aria-pressed="true"] { color: var(--ink); }
.kload-week[aria-pressed="true"]::after { content: ""; position: absolute; left: 8px; right: 8px; bottom: 0; height: 2px; border-radius: 2px; background: var(--accent); }
.kload-week-dates { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kload-group { border-bottom: 1px solid var(--hairline); }
.kload-group > .kload-row { min-height: 64px; padding: 10px 0; }
.kload-person { min-width: 0; }
.kload-who { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 40px; padding: 4px 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; transition: background var(--d-1, 90ms) var(--ease); }
.kload-who:hover { background: var(--fill-1); }
.kload-ghost { width: 28px; height: 28px; flex-shrink: 0; border-radius: 999px; border: 1.5px dashed var(--hairline-strong); }
.kload-name { display: flex; flex-direction: column; min-width: 0; flex: 1; }
.kload-name > span:first-child { font: 500 14px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-name > span[data-member] { color: var(--ink); }
.kload-cap { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kload-sub { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-chev { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); transition: transform var(--d-2, 160ms) var(--ease); }
.kload-group[data-open] .kload-chev { transform: rotate(180deg); }
.kload-cell { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.kload-cell[data-picked] .kload-figures[data-tone]:not([data-tone="none"]) { color: var(--ink); }
.kload-figures { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kload-figures[data-tone="none"] { color: var(--ink-4); }
.kload-figures[data-tone="signal"], .kload-cell[data-picked] .kload-figures[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kload-meter { display: flex; }
.kload-cell .kmeter-wrap { width: 100%; }
.kload-flag { font: 500 12px/16px var(--font-ui, var(--font-display)); }
.kload-flag[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kload-flag[data-tone="warn"] { color: var(--warn, var(--st-review)); }
.kload-detail-row { display: block; }
.kload-detail { display: flex; flex-direction: column; gap: 2px; margin: -2px 0 0; padding: 0 0 16px 46px; max-width: 760px; }
.kload-detail-head { margin: 0 0 6px 8px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-late { color: var(--signal, var(--st-blocked)); }
.kload-muted { margin: 2px 8px; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kload-muted-inline { font-size: 12px; color: var(--ink-3); }
.kload-task { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink-2); font: 500 13px/20px var(--font-ui, var(--font-display)); text-align: left; cursor: pointer; }
.kload-task:hover { background: var(--fill-1); color: var(--ink); }
.kload-task-title { flex: 1; min-width: 0; }
.kload-task-due, .kload-task-hours { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
.kload-task-due[data-late] { color: var(--signal, var(--st-blocked)); }
.kload-task-hours { min-width: 72px; text-align: right; }
.kload-capedit { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 10px 0 0; padding: 12px 8px 0; border-top: 1px solid var(--hairline);
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kload-capinput { width: 72px; height: var(--h-sm, 28px); padding: 0 8px; border-radius: var(--r-sm, 6px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink); font: 500 12px/1 var(--font-mono); font-variant-numeric: tabular-nums; }
.kload-capinput:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kload-foot { max-width: 720px; margin: 16px 0 0; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); }
@container (max-width: 1000px) {
  .kload-row { grid-template-columns: minmax(160px, 220px) repeat(3, minmax(0, 1fr)); }
  .kload-cell[data-col="3"] { display: none; }
}
@container (max-width: 760px) {
  .kload-row { grid-template-columns: minmax(140px, 200px) repeat(2, minmax(0, 1fr)); gap: 0 16px; }
  .kload-cell[data-col="2"] { display: none; }
  .kload-legend { display: none; }
}
@container (max-width: 520px) {
  .kload-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr); }
  .kload-cell[data-col="1"] { display: none; }
  .kload-detail { padding-left: 0; }
  .kload-task-due { display: none; }
}
@media (max-width: 859px) { .kload { padding: 0 16px 32px; } }
`;
