/* ============================================================
   KANBO — Today › Day: the brief, the Daybeam, the suggested plan
   and the day canvas.
   One Sora sentence reads you your day (each figure is a button), the
   Daybeam shows its shape, and Kanbo's suggested plan sits on the
   canvas as dashed ghosts. "Plan my day" (P) asks Kanbo to order the
   work, then makes the ghosts solid — with one Undo. The canvas, the
   drag engine and the Unplanned rail live in PlanView.
   ============================================================ */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { PlanView, useDayClock, dayEventsFor } from "./PlanView";
import { Daybeam, type BeamSegment } from "./Daybeam";
import { Button, Icon, Kbd, StatusGlyph } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useToast } from "../Toast";
import { getProject } from "../../data/data";
import type { CaptureOptions } from "../../data/data";
import type { Task, ExternalEvent } from "../../data/types";
import {
  composeBrief, ghostCandidates, ghostPlan, freeMinutes, plannedMinutes, placesHint, WORK_START, WORK_END, type BriefPart,
} from "../../lib/brief";
import { readBig3 } from "../../lib/rituals";
import { durOf, fmtDuration, fmtTime, isPlaced, ghostPrefsKey, readGhostPrefs, writeGhostPrefs, type GhostPrefs } from "./planCanvas";

export interface TodayViewProps {
  tasks: Task[];
  allTasks: Task[];
  events: ExternalEvent[];
  calendarConnected: boolean;
  currentUserId: string;
  userName?: string;
  captureDefaults: CaptureOptions;
  /** App applies the plan-state guard inside */
  onUpdate: (id: string, patch: Partial<Task>) => void;
  onCreate: (t: Task) => void;
  onOpen: (id: string) => void;
  onRank: () => Promise<"ai" | "heuristic" | "none">;
  ranking: boolean;
  onStartFocus: (taskId?: string) => void;
  onShutdown: () => void;
  onExtractFromMeeting?: (meetingTitle: string) => void;
  onConnectCalendar?: () => void;
  setup: { label: string; done: boolean; action: () => void }[];
  showSuggestions: boolean;
  riskCount?: number;
  onOpenRisks?: () => void;
  readOnly?: boolean;
  /* ---- optional extras (P02 may pass them; Today works without) ---- */
  /** "Open My tasks" from the empty rail */
  onOpenMyTasks?: () => void;
  /** workspace people and projects, for @mentions and #projects while capturing */
  members?: { id: string; name: string }[];
  projects?: { id: string; name: string }[];
  /** the first load: a skeleton instead of an empty day */
  loading?: boolean;
}

// works outside the providers in isolated renders; in the app it's always there
function useOptionalToast() { try { return useToast(); } catch { return null; } }

const isEditable = (el: EventTarget | null) => {
  const n = el as HTMLElement | null;
  return !!n && typeof n.closest === "function" && (!!n.isContentEditable || !!n.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
};

const SETUP_HIDDEN_KEY = "kanbo-setup-hidden";
type RankSource = Awaited<ReturnType<TodayViewProps["onRank"]>>;

const TODAY_CSS = `
.ktoday-lede { flex: none; padding: 24px var(--kp-gutter, 32px) 0; }
.ktoday-brief { margin: 0; max-width: 740px; font: 500 28px/36px var(--font-head); letter-spacing: -0.02em; color: var(--ink); text-wrap: pretty; }
.ktoday-fig { border-radius: 4px; cursor: pointer; outline: none;
  text-decoration: underline dotted var(--ink-4); text-decoration-thickness: 1px; text-underline-offset: 4px;
  -webkit-box-decoration-break: clone; box-decoration-break: clone;
  transition: color var(--d-1, 90ms) var(--ease); }
.ktoday-fig:hover, .ktoday-fig[aria-pressed="true"] { color: var(--accent-text, var(--accent)); text-decoration-color: currentColor; }
.ktoday-fig:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.ktoday-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 16px; min-height: 40px; margin-top: 20px; }
/* what Plan my day will do, and under it the one quiet switch for the suggestions (H's mouse path) */
.ktoday-hint { display: inline-flex; flex-direction: column; align-items: flex-start; justify-content: center; min-height: 40px;
  font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); white-space: nowrap; }
.ktoday-toggle { display: inline-flex; align-items: center; gap: 6px; margin: 0 -4px; padding: 0 4px; min-height: 20px; border: 0; border-radius: var(--r-xs, 4px);
  background: none; cursor: pointer; font: inherit; color: var(--ink-3); transition: color var(--d-1, 90ms) var(--ease); }
.ktoday-toggle > span { text-decoration: underline dotted var(--ink-4); text-decoration-thickness: 1px; text-underline-offset: 3px; }
.ktoday-toggle:hover { color: var(--accent-text, var(--accent)); }
.ktoday-toggle:hover > span { text-decoration-color: currentColor; }
.ktoday-toggle .kkbd { height: 16px; min-width: 16px; padding: 0 4px; }
@media (hover: none) { .ktoday-toggle .kkbd { display: none; } }
/* the button holds its idle and busy labels in one cell, so it keeps its width while
   Kanbo orders the day and nothing beside it jumps to a new line */
.ktoday-hero-label { display: inline-grid; }
.ktoday-hero-label > span { grid-area: 1 / 1; text-align: start; }
.ktoday-hero-label > [aria-hidden="true"] { visibility: hidden; }
.ktoday-beam { flex: 1 1 200px; min-width: 200px; max-width: 420px; margin-left: auto; }
.ktoday-setup { display: flex; margin-top: 12px; }
.ktoday-setup .kpill svg { margin-right: -2px; }
.ktoday-steps { padding: 6px 6px 4px; min-width: 268px; }
.ktoday-steps h3 { margin: 0 0 4px; padding: 0 4px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.ktoday-steps ul { margin: 0; padding: 0; list-style: none; }
.ktoday-step { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 4px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.ktoday-step[data-done="true"] > span:not(.kglyph) { color: var(--ink-3); text-decoration: line-through; text-decoration-color: var(--ink-4); }
.ktoday-step > span:not(.kglyph) { flex: 1; min-width: 0; }
.ktoday-link { flex-shrink: 0; height: 28px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px); background: none; cursor: pointer;
  font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--accent-text, var(--accent)); }
.ktoday-link:hover { background: var(--fill-1); }
.ktoday-steps-foot { display: flex; justify-content: flex-end; margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--hairline); }
.ktoday-steps-foot .ktoday-link { color: var(--ink-3); font-weight: 500; }
.ktoday-skel { display: block; border-radius: var(--r-sm, 6px); background: var(--fill-2, var(--surface-2)); }
/* the skeleton keeps the day's own geometry: the rail beside the canvas while they fit
   side by side (PlanView stacks them under 920px), under it otherwise */
.ktoday-skeleton { --kp-gutter: var(--gutter, 32px); flex: 1; min-height: 0; display: flex; container-type: inline-size; overflow: hidden; }
.ktoday-skeleton-main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.ktoday-skeleton-grid { position: relative; flex: 1; min-height: 540px; margin: 32px var(--kp-gutter) 0; overflow: hidden; }
.ktoday-skeleton-grid > div { position: absolute; left: 0; right: 0; display: flex; align-items: center; gap: 12px; }
.ktoday-skeleton-grid > div > .ktoday-skel { margin-left: 8px; flex-shrink: 0; }
.ktoday-skeleton-rule { flex: 1; height: 1px; background: var(--hairline); }
.ktoday-skeleton-rail { width: var(--rail-w, 360px); flex: none; padding: 20px; border-left: 1px solid var(--hairline); }
.ktoday-skeleton-row { display: flex; align-items: flex-start; gap: 10px; margin-top: 16px; }
@container (max-width: 919px) {
  .ktoday-skeleton-rail { display: none; }
}
@media (max-width: 859px) {
  .ktoday-lede { padding-top: 16px; }
  .ktoday-brief { font-size: 22px; line-height: 30px; }
  .ktoday-actions { margin-top: 16px; }
  .ktoday-actions > .kbtn { flex: 1 1 100%; height: var(--h-touch, 44px); }
  .ktoday-actions > .kbtn .kkbd { display: none; } /* no keyboard to press it on */
  .ktoday-hero-label > span { text-align: center; }
  .ktoday-hint { flex: 1; min-height: 0; }
  .ktoday-beam { flex: 1 1 100%; max-width: none; margin-left: 0; }
  .ktoday-skeleton .ktoday-actions > .skel { flex: 1 1 100%; height: var(--h-touch, 44px) !important; }
  .ktoday-skeleton { --kp-gutter: var(--gutter, 16px); }
}
`;

const FIGURE_TITLE: Record<Exclude<BriefPart, string>["kind"], string> = {
  free: "Show the free time on your day", due: "Show what's due today", overdue: "Show what's overdue",
  task: "Open this task", risks: "See the risks",
};

/** A live figure in the brief. A span with the button role rather than a
 *  <button>, so a long one (a task's title) wraps with the sentence around it. */
function Figure({ kind, pressed, onActivate, children }: {
  kind: Exclude<BriefPart, string>["kind"]; pressed?: boolean; onActivate: () => void; children: ReactNode;
}) {
  return (
    <span role="button" tabIndex={0} className="ktoday-fig" data-kind={kind} aria-pressed={pressed} title={FIGURE_TITLE[kind]}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); onActivate(); }
        else if (e.key === " ") e.preventDefault(); // Space acts on release, like a button
      }}
      onKeyUp={(e) => { if (e.key === " ") { e.preventDefault(); onActivate(); } }}>
      {children}
    </span>
  );
}

/** "2 of 4 set up": the getting-started steps, tucked into a chip until they're done or hidden. */
function SetupChip({ steps }: { steps: TodayViewProps["setup"] }) {
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem(SETUP_HIDDEN_KEY) === "1"; } catch { return false; } });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const done = steps.filter((s) => s.done).length;
  if (hidden || steps.length === 0 || done === steps.length) return null;
  const hide = () => { try { localStorage.setItem(SETUP_HIDDEN_KEY, "1"); } catch { /* private mode */ } setOpen(false); setHidden(true); };
  return (
    <div className="ktoday-setup">
      <button ref={ref} type="button" className="kpill" data-tone="accent" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {done} of {steps.length} set up <Icon name="chevronDown" size={12} sw={2} />
      </button>
      <Popover open={open} anchorRef={ref} onClose={() => setOpen(false)} role="dialog" label="Getting set up" minWidth={280}>
        <div className="ktoday-steps">
          <h3>Getting set up</h3>
          <ul>
            {steps.map((s) => (
              <li key={s.label} className="ktoday-step" data-done={s.done || undefined}>
                <StatusGlyph status={s.done ? "done" : "todo"} readOnly />
                <span>{s.label}</span>
                {!s.done && <button type="button" className="ktoday-link" onClick={() => { setOpen(false); s.action(); }} aria-label={`${s.label}: set it up`}>Set up</button>}
              </li>
            ))}
          </ul>
          <div className="ktoday-steps-foot"><button type="button" className="ktoday-link" onClick={hide}>Hide</button></div>
        </div>
      </Popover>
    </div>
  );
}

/** The day's shape before its data: the brief, the action row and the canvas grid on
 *  the left, the rail's capture field and a few rows beside them (under them in one
 *  column), laid out as the day will be so nothing jumps when it arrives. */
function TodaySkeleton() {
  return (
    <div className="ktoday-skeleton" aria-busy="true" aria-label="Loading your day">
      <style>{TODAY_CSS}</style>
      <div className="ktoday-skeleton-main" aria-hidden="true">
        <div className="ktoday-lede">
          <span className="ktoday-skel skel" style={{ width: "min(640px, 92%)", height: 28, marginTop: 4 }} />
          <span className="ktoday-skel skel" style={{ width: "min(420px, 64%)", height: 28, marginTop: 8 }} />
          <div className="ktoday-actions">
            <span className="ktoday-skel skel" style={{ width: 212, height: 40, borderRadius: "var(--r-md, 8px)" }} />
            <span className="ktoday-skel ktoday-beam" style={{ height: 10, borderRadius: 999 }} />
          </div>
        </div>
        <div className="ktoday-skeleton-grid">
          {Array.from({ length: 9 }, (_, i) => (
            <div key={i} style={{ top: i * 60 }}>
              <span className="ktoday-skel" style={{ width: 36, height: 10 }} />
              <span className="ktoday-skeleton-rule" />
            </div>
          ))}
        </div>
      </div>
      <div className="ktoday-skeleton-rail" aria-hidden="true">
        <span className="ktoday-skel skel" style={{ height: 40, borderRadius: "var(--r-md, 8px)" }} />
        <span className="ktoday-skel" style={{ width: 96, height: 14, marginTop: 28 }} />
        {[72, 58, 66].map((w, i) => (
          <div key={i} className="ktoday-skeleton-row">
            <span className="ktoday-skel" style={{ width: 16, height: 16, borderRadius: 999 }} />
            <span style={{ flex: 1 }}>
              <span className="ktoday-skel" style={{ width: `${w}%`, height: 12 }} />
              <span className="ktoday-skel" style={{ width: "40%", height: 10, marginTop: 8 }} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function TodayView(props: TodayViewProps) {
  if (props.loading) return <TodaySkeleton />;
  return <TodayDay {...props} />;
}

function TodayDay({
  tasks, allTasks, events, calendarConnected, currentUserId, userName, captureDefaults, onUpdate, onCreate, onOpen,
  onRank, ranking, onStartFocus, onShutdown, onExtractFromMeeting, onConnectCalendar, setup, showSuggestions,
  riskCount, onOpenRisks, readOnly = false, onOpenMyTasks, members, projects,
}: TodayViewProps) {
  const toast = useOptionalToast();
  const { nowMin, day } = useDayClock();
  const me = currentUserId;
  const dayEvents = useMemo(
    () => dayEventsFor(calendarConnected, events),
    // `day` re-reads "today's" events after midnight
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [calendarConnected, events, day],
  );

  /* ----- what you've waved away today ----- */
  const prefsKey = ghostPrefsKey(me);
  const [prefs, setPrefsState] = useState<GhostPrefs>(() => readGhostPrefs(prefsKey, day));
  useEffect(() => { setPrefsState(readGhostPrefs(prefsKey, day)); }, [prefsKey, day]);
  const prefsRef = useRef(prefs); prefsRef.current = prefs;
  const setPrefs = useCallback((next: GhostPrefs) => { prefsRef.current = next; setPrefsState(next); writeGhostPrefs(prefsKey, next); }, [prefsKey]);
  const skip = useCallback((id: string) => {
    const p = prefsRef.current;
    if (!p.skipped.includes(id)) setPrefs({ ...p, skipped: [...p.skipped, id] });
  }, [setPrefs]);
  const unskip = useCallback((ids: string[]) => {
    const p = prefsRef.current;
    if (ids.some((id) => p.skipped.includes(id))) setPrefs({ ...p, skipped: p.skipped.filter((id) => !ids.includes(id)) });
  }, [setPrefs]);
  const unskipOne = useCallback((id: string) => unskip([id]), [unskip]);
  // Waving a task away lasts until you bring it back: put it (back) on today's
  // list — an Undo, "On Today" in the panel, Inbox's "Add to Today" — or onto the
  // day itself, and it's a candidate again.
  const planWas = useRef<Map<string, boolean> | null>(null);
  useEffect(() => {
    const was = planWas.current;
    planWas.current = new Map(tasks.map((t) => [t.id, !!t.planToday]));
    if (!was || prefsRef.current.skipped.length === 0) return;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    unskip(prefsRef.current.skipped.filter((id) => {
      const t = byId.get(id);
      return !!t && (isPlaced(t) || (!!t.planToday && was.get(id) === false));
    }));
  }, [tasks, unskip]);
  const ghostsOff = !showSuggestions || prefs.hidden;

  /* ----- the plan, the brief and the beam ----- */
  const plan = useMemo(() => ghostPlan(tasks, dayEvents, nowMin, { today: day, me, skip: prefs.skipped }), [tasks, dayEvents, nowMin, day, me, prefs.skipped]);
  const ghosts = readOnly || ghostsOff ? [] : plan.suggestions;
  // today's work you've waved away ("Not now", "Not today"): Plan my day leaves it be
  const setAside = useMemo(() => {
    if (!prefs.skipped.length) return 0;
    const skipped = new Set(prefs.skipped);
    return ghostCandidates(tasks, { today: day, me }).filter((t) => skipped.has(t.id)).length;
  }, [tasks, day, me, prefs.skipped]);
  const brief = useMemo(() => composeBrief({ tasks, events: dayEvents, nowMin, today: day, userName, riskCount, allTasks, me }),
    [tasks, dayEvents, nowMin, day, userName, riskCount, allTasks, me]);
  const planned = plannedMinutes(tasks);
  const free = freeMinutes(tasks, dayEvents, nowMin);
  const placedOpen = tasks.filter((t) => isPlaced(t) && t.status !== "done" && !t.archivedAt);
  const segments: BeamSegment[] = [
    ...dayEvents.map((e) => ({ start: e.start, end: e.end, title: e.title, kind: e.kind === "break" ? "break" as const : "meeting" as const })),
    ...placedOpen.map((t) => ({ start: t.scheduled!, end: t.scheduled! + durOf(t), title: t.title, kind: "task" as const, color: getProject(t.projectId)?.color })),
    ...ghosts.map((g) => ({ start: g.start, end: g.end, title: tasks.find((t) => t.id === g.id)?.title ?? "", kind: "suggestion" as const })),
  ];
  const big3 = useMemo(() => readBig3(me), [me, day]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ----- Plan my day ----- */
  // Re-plan (when nothing's left to place): the blocks still ahead, except any
  // pinned to a time, are laid out afresh around what's changed. A day whose only
  // blocks are under way or behind you still reads as planned (Re-plan then just
  // re-orders and says nothing needed moving); only an empty day has nothing to do.
  // Once the working day is over there's nothing more to plan for today: the
  // brief counts what you finished, and the one action left is to close the day.
  const replannable = placedOpen.filter((t) => t.scheduled! > nowMin && !t.dueTime);
  const evening = nowMin >= WORK_END;
  const mode: "plan" | "replan" | "none" | "evening" = evening ? "evening"
    : plan.suggestions.length > 0 || (plan.unplaced.length > 0 && replannable.length === 0) ? "plan"
    : placedOpen.length > 0 ? "replan" : "none";
  const tomorrowsPlan = `Tomorrow's plan starts at ${fmtTime(WORK_START)}`;
  const [ordering, setOrdering] = useState(false);
  const [landing, setLanding] = useState<Record<string, number> | undefined>();
  const [srMsg, setSrMsg] = useState("");
  const say = useCallback((m: string) => setSrMsg((p) => (p === m ? m + "​" : m)), []);
  const live = useRef({ tasks, dayEvents, day, me, mode, replannable });
  live.current = { tasks, dayEvents, day, me, mode, replannable };
  const busyRef = useRef(false);
  const landTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(landTimer.current), []);

  // P (or the button) asks Kanbo to order the work first. The plan is laid once React
  // has rendered what the ranking changed: its updates were queued ahead of this
  // request, so the render that carries the request carries the new scores too.
  const [commitReq, setCommitReq] = useState<{ source: RankSource } | null>(null);
  const notice = useCallback((msg: string) => { if (toast) toast.toast(msg); say(msg); }, [toast, say]);
  const planMyDay = useCallback(async () => {
    if (readOnly || busyRef.current) return;
    if (live.current.mode === "evening") { notice(`The working day's done. ${tomorrowsPlan}.`); return; }
    if (live.current.mode === "none") return;
    busyRef.current = true; setOrdering(true);
    let source: RankSource = "none";
    try { source = await onRank(); } catch { /* ordering is a nicety: plan with the scores we have */ }
    setCommitReq({ source });
  }, [readOnly, onRank, notice, tomorrowsPlan]);

  const commitPlan = (source: RankSource) => {
    busyRef.current = false; setOrdering(false);
    // plan from the latest tasks and the clock as it is now
    const { tasks: cur, dayEvents: evs, day: today, me: who, mode: m, replannable: again } = live.current;
    const d = new Date(), now = d.getHours() * 60 + d.getMinutes();
    // the working day ended while Kanbo was ordering it: plan nothing (a Re-plan
    // now would find no room and take every block ahead off the day)
    if (m === "evening" || now >= WORK_END) { notice(`The working day's done. ${tomorrowsPlan}.`); return; }
    const lift = new Set(m === "replan" ? again.map((t) => t.id) : []);
    const pool = lift.size ? cur.map((t) => (lift.has(t.id) ? { ...t, scheduled: null } : t)) : cur;
    // a block being re-laid is always a candidate, even one waved away earlier
    const next = ghostPlan(pool, evs, now, { today, me: who, skip: prefsRef.current.skipped.filter((id) => !lift.has(id)) });
    const byId = new Map(cur.map((t) => [t.id, t]));
    const moves = next.suggestions.filter((s) => byId.get(s.id)?.scheduled !== s.start || !byId.get(s.id)?.planToday);
    // A block that was lifted to be re-laid and no longer fits comes off the day,
    // back to Unplanned: left where it was, it would sit under whatever took its time.
    const bumped = next.unplaced.filter((t) => lift.has(t.id)).map((t) => t.id);
    const before = new Map([...moves.map((s) => s.id), ...bumped].map((id) => {
      const t = byId.get(id)!;
      return [id, { scheduled: t.scheduled ?? null, planToday: !!t.planToday }] as const;
    }));
    moves.forEach((s) => onUpdate(s.id, { scheduled: s.start, planToday: true }));
    bumped.forEach((id) => onUpdate(id, { scheduled: null }));

    const n = moves.length, off = bumped.length, left = next.unplaced.length - off;
    const mins = moves.reduce((a, s) => a + (s.end - s.start), 0);
    // a non-breaking hyphen: the toast wraps before "(on‑device", never inside it
    const onDevice = source === "heuristic" ? " (on‑device ordering)" : "";
    if (n > 0 || off > 0) {
      if (n > 0) {
        setLanding(Object.fromEntries(moves.map((s, i) => [s.id, i])));
        window.clearTimeout(landTimer.current);
        landTimer.current = window.setTimeout(() => setLanding(undefined), 240 + 40 * n + 80);
      }
      const bits: string[] = [];
      if (n > 0) bits.push(`${lift.size ? "Re-planned" : "Planned"} ${n} task${n === 1 ? "" : "s"} · ${fmtDuration(mins)}`);
      if (off > 0) bits.push(n > 0 ? `${off} back to Unplanned` : `Moved ${off} task${off === 1 ? "" : "s"} back to Unplanned`);
      if (left > 0) bits.push(`${left} for tomorrow`);
      const msg = bits.join(" · ") + onDevice;
      const undo = () => before.forEach((p, id) => onUpdate(id, p));
      if (toast) toast.action(msg, "Undo", undo, { ms: 10000 });
      say(msg);
    } else {
      notice(left > 0
        ? `Your day's full — ${left} task${left === 1 ? "" : "s"} moved to tomorrow's suggestions.`
        : "Your day is planned — nothing needed moving.");
    }
  };
  const commitRef = useRef(commitPlan); commitRef.current = commitPlan;
  useEffect(() => {
    if (!commitReq) return;
    setCommitReq(null);
    commitRef.current(commitReq.source);
  }, [commitReq]);

  const toggleSuggestions = useCallback(() => {
    // switched off for good in Settings: H can't bring them back, so say where they live
    if (!showSuggestions) { notice("Suggestions are switched off in Settings › Appearance."); return; }
    // nothing is suggested once the working day is over
    if (live.current.mode === "evening") { notice(`The working day's done. ${tomorrowsPlan}.`); return; }
    const p = prefsRef.current;
    setPrefs({ ...p, hidden: !p.hidden });
    notice(p.hidden ? "Suggestions are back." : "Suggestions hidden for today. Press H or choose Show suggestions to bring them back.");
  }, [showSuggestions, setPrefs, notice, tomorrowsPlan]);

  // P plans the day; H hides (or brings back) the suggestions. Never while typing,
  // with a modifier held, over a dialog, or when something else took the key ("g p").
  const keys = useRef({ planMyDay, toggleSuggestions });
  keys.current = { planMyDay, toggleSuggestions };
  useEffect(() => {
    if (readOnly) return;
    const h = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k !== "p" && k !== "h") return;
      if (isEditable(e.target) || document.querySelector('[aria-modal="true"]')) return;
      e.preventDefault();
      if (k === "p") void keys.current.planMyDay();
      else keys.current.toggleSuggestions();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [readOnly]);

  /* ----- the brief's figures ----- */
  const [railFocus, setRailFocus] = useState<"due" | "overdue" | null>(null);
  const [freePulse, setFreePulse] = useState(0);
  const onFigure = (p: Exclude<BriefPart, string>) => {
    if (p.kind === "free") setFreePulse((n) => n + 1);
    else if (p.kind === "due" || p.kind === "overdue") { const k = p.kind; setRailFocus((f) => (f === k ? null : k)); }
    else if (p.kind === "task" && p.taskId) onOpen(p.taskId);
    else if (p.kind === "risks") onOpenRisks?.();
  };

  const busy = ordering || ranking;
  const wontFit = plan.unplaced.length;
  const hidden = showSuggestions && prefs.hidden;
  const hint = mode === "evening" ? tomorrowsPlan
    : mode === "plan" ? (!showSuggestions ? "Plan my day places tasks in your free time"
      // there may be free time, just not enough of it in one piece for what's left
      : plan.suggestions.length === 0 ? `${wontFit} ${wontFit === 1 ? "task won't" : "tasks won't"} fit today`
      // (hidden or not, this is what P will do)
      : placesHint(plan.suggestions.length, plan.suggestions.reduce((a, s) => a + s.end - s.start, 0)))
    : mode === "replan" ? "Your day is planned"
    : setAside > 0 ? `Nothing to place · ${setAside} set aside for today`
    : "Nothing to place yet";
  // H's mouse path, under the hint while there are suggestions to hide or show
  const toggle = mode === "plan" && showSuggestions && plan.suggestions.length > 0;
  const idleLabel = mode === "replan" ? "Re-plan" : "Plan my day";
  const busyLabel = mode === "replan" ? "Re-planning…" : "Ordering your day…";

  const lede = (drop: { start: number; end: number } | null) => (
    <section className="ktoday-lede" aria-label="Your day in brief">
      <style>{TODAY_CSS}</style>
      <p className="ktoday-brief">
        {brief.parts.map((p, i) => typeof p === "string" ? <Fragment key={i}>{p}</Fragment>
          : p.kind === "risks" && !onOpenRisks ? <Fragment key={i}>{p.text}</Fragment>
          : (
            <Figure key={i} kind={p.kind} onActivate={() => onFigure(p)}
              pressed={p.kind === "due" || p.kind === "overdue" ? railFocus === p.kind : undefined}>
              {p.text}
            </Figure>
          ))}
      </p>
      <div className="ktoday-actions">
        {!readOnly && (mode === "evening" ? (
          // the working day's over: closing it is what's left (the rail's own link steps aside)
          <Button variant="secondary" size="lg" icon="sunset" onClick={onShutdown}>Shut down my day</Button>
        ) : (
          <Button variant={mode === "plan" ? "hero" : "secondary"} size="lg" kbd="P" loading={busy} disabled={!busy && mode === "none"}
            icon={mode === "replan" ? "refresh" : "kanbo"} aria-keyshortcuts="P" onClick={() => void planMyDay()}>
            <span className="ktoday-hero-label">
              <span aria-hidden={busy || undefined}>{idleLabel}</span>
              <span aria-hidden={!busy || undefined}>{busyLabel}</span>
            </span>
          </Button>
        ))}
        {!readOnly && hint && (
          <span className="ktoday-hint">
            <span>{hint}</span>
            {toggle && (
              <button type="button" className="ktoday-toggle" aria-keyshortcuts="H" onClick={toggleSuggestions}
                aria-label={hidden ? "Show suggestions" : "Hide suggestions for today"}>
                <span>{hidden ? "Show suggestions" : "Hide suggestions"}</span><Kbd>H</Kbd>
              </button>
            )}
          </span>
        )}
        <div className="ktoday-beam">
          {/* the working day, unless something's planned outside it */}
          <Daybeam segments={segments} nowMin={nowMin} planned={planned} free={free} drop={drop}
            compact={!segments.some((s) => s.start < 8 * 60 || s.end > 18 * 60)} />
        </div>
      </div>
      {!readOnly && <SetupChip steps={setup} />}
      <div role="status" aria-live="polite" className="sr-only">{srMsg}</div>
    </section>
  );

  return (
    <PlanView tasks={tasks} onUpdate={onUpdate} onCreate={onCreate} onOpen={onOpen} externalEvents={events}
      calendarConnected={calendarConnected} currentUserId={currentUserId} captureDefaults={captureDefaults}
      lede={lede} events={dayEvents} nowMin={nowMin} ghosts={ghosts} tomorrowIds={ghostsOff ? [] : plan.unplaced.map((t) => t.id)}
      skipped={prefs.skipped} onSkip={skip} onUnskip={unskipOne} landing={landing} readOnly={readOnly}
      onStartFocus={onStartFocus} onExtractFromMeeting={onExtractFromMeeting} onConnectCalendar={onConnectCalendar}
      railFocus={railFocus} onRailFocus={setRailFocus} freePulse={freePulse} big3={big3}
      onOpenMyTasks={onOpenMyTasks} onShutdown={evening ? undefined : onShutdown} members={members} projects={projects} />
  );
}
