/* ============================================================
   KANBO — Shut down my day. Three short steps and a close:
   1 · what you finished, and "Your day in colour"
   2 · what's left on today, and where each one goes
   3 · anything blocking you (posted to a task only if you send it)
   then "Done for today". Personal: nothing is shared on its own, a
   teammate's due date is never changed, and no deadline moves earlier.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, Icon, ProjectDot, SectionLabel, Sheet, StatusGlyph, projectPaint } from "../primitives";
import { getMember, getProject, todayISO } from "../../data/data";
import type { Task } from "../../data/types";
import { pushUndo } from "../../lib/undoStack";
import {
  addDaysISO, beforeMove, closingLine, dayInColour, finishedToday, fmtMinutes, leftoverChoices, leftovers, markShutdownDone,
  movePatch, nextWeekISO, shortDay, shutdownSummary, type DaySegment, type LeftoverMove,
} from "../../lib/rituals";
import { copyText, prefersReducedMotion, useOptionalToast } from "./shared";

type Step = 1 | 2 | 3 | 4;
const FINISHED_SHOWN = 6;
type Choices = ReturnType<typeof leftoverChoices>;
const MOVE_LABEL: Record<LeftoverMove, string> = { tomorrow: "Tomorrow", nextweek: "Next week", someday: "Someday", drop: "Drop from today" };
const firstName = (id?: string) => (id ? getMember(id)?.name?.trim().split(/\s+/)[0] : undefined) || null;

export interface ShutdownSheetProps {
  open: boolean;
  onClose: () => void;
  /** your tasks (what "finished" and "left over" are read from) */
  tasks: Task[];
  allTasks: Task[];
  currentUserId: string;
  userName?: string;
  /** every leftover move goes through here (App applies the plan-state guard).
      Moves on a task assigned to someone else only ever carry planToday and
      scheduled; a due date is patched on your own tasks only, and only later. */
  onPatch: (id: string, patch: Partial<Task>) => void;
  /** step 3: posts "Blocked: …" on the chosen task (the first leftover unless
      you pick another). Resolving to null counts as a failed post. */
  onComment: (taskId: string, body: string) => Promise<unknown>;
  focusMinutesToday?: number;
  /** a guest in this workspace: leftovers are listed but can't be moved
      (App would refuse the writes); a blocker can still be posted */
  readOnly?: boolean;
}

export function ShutdownSheet({ open, onClose, tasks, currentUserId, userName, onPatch, onComment, focusMinutesToday = 0, readOnly = false }: ShutdownSheetProps): JSX.Element | null {
  const toast = useOptionalToast();
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const [step, setStep] = useState<Step>(1);
  const [day, setDay] = useState(todayISO);
  // what the sheet is about is fixed when it opens, so rows don't vanish as you move them
  const [finishedIds, setFinishedIds] = useState<string[]>([]);
  const [leftIds, setLeftIds] = useState<string[]>([]);
  // where each leftover can go, fixed at open (a move changes the task, not its choices)
  const [choices, setChoices] = useState<Record<string, Choices>>({});
  const [moves, setMoves] = useState<Record<string, LeftoverMove>>({});
  const originals = useRef<Record<string, Pick<Task, "dueDate" | "planToday" | "scheduled">>>({});
  const [copied, setCopied] = useState(false);
  const [blocker, setBlocker] = useState({ text: "", taskId: "", sending: false, error: "", postedOn: "" });
  const nextRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  // a fresh start each time it opens
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const today = todayISO();
      setDay(today);
      setStep(1);
      setFinishedIds(finishedToday(tasks, today).map((t) => t.id));
      const left = leftovers(tasks, today);
      setLeftIds(left.map((t) => t.id));
      setChoices(Object.fromEntries(left.map((t) => [t.id, leftoverChoices(t, currentUserId, today)])));
      setMoves({});
      originals.current = {};
      setCopied(false);
      // the task is optional: the blocker goes on the first leftover unless you pick another
      const firstOpen = left[0] ?? tasks.find((t) => t.status !== "done" && !t.archivedAt);
      setBlocker({ text: "", taskId: firstOpen?.id ?? "", sending: false, error: "", postedOn: "" });
    }
  }

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const finished = finishedIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const left = leftIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
  const colour = useMemo(() => {
    const done = finishedIds.map((id) => byId.get(id)).filter((t): t is Task => !!t);
    const projects = [...new Set(done.map((t) => t.projectId))].map((id) => getProject(id)).filter((p): p is NonNullable<typeof p> => !!p);
    return dayInColour(done, projects, focusMinutesToday);
  }, [finishedIds, byId, focusMinutesToday]);
  const moved = Object.values(moves);
  const tomorrow = addDaysISO(day, 1);
  const nextWeek = nextWeekISO(day);

  // each step lands on its heading, so a screen reader hears where it is;
  // the close lands on Done (its line is announced by the sheet's live region)
  useEffect(() => {
    if (!open || step === 1) return;
    (step === 4 ? closeRef.current : headRef.current)?.focus({ preventScroll: true });
  }, [step, open]);
  useEffect(() => { if (open && step === 4) markShutdownDone(currentUserId, day); }, [open, step, currentUserId, day]);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  /* ---------- leftovers: every move patches at once; one Undo at the end ---------- */
  // what puts a row back: on a teammate's task, only your own plan (their date was never touched)
  const restorePatch = (id: string): Partial<Task> => {
    const o = originals.current[id];
    return choices[id]?.mine ? { ...o } : { planToday: o.planToday, scheduled: o.scheduled };
  };
  const move = (t: Task, to: LeftoverMove | null) => {
    if (readOnly) return;
    if (!(t.id in originals.current)) originals.current[t.id] = beforeMove(t);
    if (to === null) {
      onPatch(t.id, restorePatch(t.id));
      setMoves((m) => { const next = { ...m }; delete next[t.id]; return next; });
      return;
    }
    // only a move this row offers (fixed at open), and never a date that isn't yours
    const c = choices[t.id];
    if (!c?.moves.includes(to)) return;
    const patch = movePatch(to, day, originals.current[t.id].dueDate);
    if (!c.mine) delete patch.dueDate;
    onPatch(t.id, patch);
    setMoves((m) => ({ ...m, [t.id]: to }));
  };
  // Tomorrow where it's offered; otherwise (a later deadline, or a teammate's task) off today's plan
  const moveAll = () => {
    for (const t of left) { const to = choices[t.id]?.all; if (to && moves[t.id] !== to) move(t, to); }
  };

  const finish = () => {
    const ids = Object.keys(moves);
    if (ids.length) {
      const before = ids.filter((id) => !!originals.current[id]).map((id) => [id, restorePatch(id)] as const);
      let undone = false;
      const revert = () => {
        if (undone) return;
        undone = true;
        for (const [id, patch] of before) onPatch(id, patch);
      };
      const remove = pushUndo(`Shut down: moved ${ids.length === 1 ? "1 task" : `${ids.length} tasks`}`, revert);
      toast?.action(`Moved ${ids.length === 1 ? "1 task" : `${ids.length} tasks`} off today`, "Undo", () => { remove(); revert(); }, { onExpire: remove });
    }
    onClose();
  };

  const postBlocker = async () => {
    const text = blocker.text.trim();
    if (!text || !blocker.taskId || blocker.sending) return;
    setBlocker((b) => ({ ...b, sending: true, error: "" }));
    let ok = false;
    try { ok = (await onComment(blocker.taskId, `Blocked: ${text}`)) !== null; } catch { ok = false; }
    if (!mounted.current) return;
    if (!ok) { setBlocker((b) => ({ ...b, sending: false, error: "Couldn't post that. Try again, or skip for now." })); return; }
    setBlocker((b) => ({ ...b, sending: false, postedOn: byId.get(b.taskId)?.title ?? "the task" }));
    setStep(4);
  };

  const copySummary = async () => {
    const ok = await copyText(shutdownSummary({ day, finished, segments: colour.segments }));
    if (!mounted.current) return;
    if (ok) setCopied(true);
    else toast?.error("Couldn't copy. Your browser blocked the clipboard.");
  };

  /* ---------- the steps ---------- */
  const first = userName?.trim().split(/\s+/)[0];
  const stepper = step < 4 && (
    <div className="kshut-steps" role="img" aria-label={`Step ${step} of 3`}>
      {[1, 2, 3].map((n) => <span key={n} data-on={n <= step || undefined} />)}
    </div>
  );
  const heading = (text: string) => <h3 ref={headRef} tabIndex={-1} className="kshut-h">{text}</h3>;

  let body: JSX.Element;
  let footer: JSX.Element;
  if (step === 1) {
    body = (
      <>
        {stepper}
        {heading("Today you finished")}
        {finished.length ? (
          <p className="kshut-count">
            <span className="kshut-num brand-grad-text">{finished.length}</span>
            <span className="kshut-unit">{finished.length === 1 ? "task" : "tasks"}{first ? `. Good work, ${first}.` : "."}</span>
          </p>
        ) : (
          <p className="kshut-none">Nothing marked done today. That happens. Let's set tomorrow up.</p>
        )}
        {finished.length > 0 && (
          <ul className="kshut-list" aria-label="Finished today">
            {finished.slice(0, FINISHED_SHOWN).map((t) => {
              const p = getProject(t.projectId);
              const min = t.dur || t.focusMin || 0;
              return (
                <li key={t.id} className="kshut-item">
                  <StatusGlyph status="done" size={14} />
                  <span className="kshut-title truncate">{t.title}</span>
                  {p && <ProjectDot color={p.color} size={8} title={p.name} />}
                  {min > 0 && <span className="kshut-min">{fmtMinutes(min)}</span>}
                </li>
              );
            })}
            {finished.length > FINISHED_SHOWN && <li className="kshut-more">and {finished.length - FINISHED_SHOWN} more</li>}
          </ul>
        )}
        {colour.total > 0 && (
          <div className="kshut-colour">
            <SectionLabel>Your day in colour</SectionLabel>
            <DayColourBar segments={colour.segments} total={colour.total} legend />
          </div>
        )}
        <p className="kshut-private"><Icon name="lock" size={12} sw={2} /> Only you see this. Nothing is shared unless you send it.</p>
      </>
    );
    footer = (
      <>
        <span className="kshut-foot-start">
          <Button variant="ghost" size="md" icon={copied ? "check" : "copy"} onClick={copySummary}>{copied ? "Copied" : "Copy summary"}</Button>
          <span className="sr-only" aria-live="polite">{copied ? "Summary copied" : ""}</span>
        </span>
        <Button ref={nextRef} variant="primary" iconRight="arrowRight" onClick={() => setStep(2)}>Next</Button>
      </>
    );
  } else if (step === 2) {
    const movable = readOnly ? [] : left.filter((t) => choices[t.id]?.all);
    const allDone = movable.length > 0 && movable.every((t) => moves[t.id] === choices[t.id].all);
    const allTomorrow = movable.every((t) => choices[t.id].all === "tomorrow");
    // some rows can't go everywhere: say why once, under the list
    const limited = !readOnly && left.some((t) => { const c = choices[t.id]; return !!c && (!c.mine || !c.moves.includes("tomorrow")); });
    body = (
      <>
        {stepper}
        {heading("Leftovers")}
        {left.length ? (
          <>
            <p className="kshut-lede">
              {readOnly ? "Still on today. You're a guest in this workspace, so they stay as they are."
                : movable.length ? "Still on today. Pick where each one goes, or move them all to tomorrow."
                : "Still on today, but their dates belong to the people they're assigned to."}
            </p>
            <SectionLabel count={left.length}
              action={movable.length > 0 && (
                <Button variant="ghost" size="sm" icon={allDone ? "check" : "arrowRight"} disabled={allDone} onClick={moveAll}>
                  {allDone ? (allTomorrow ? "All moved to tomorrow" : "All moved off today") : "Move all to tomorrow"}
                </Button>
              )}>
              Left on today
            </SectionLabel>
            <ul className="kshut-left">
              {left.map((t) => {
                const choice = moves[t.id];
                const c: Choices = readOnly ? { moves: [], all: null, mine: true } : choices[t.id] ?? { moves: [], all: null, mine: true };
                const p = getProject(t.projectId);
                const owner = c.mine ? null : firstName(t.assigneeId);
                const hint: Partial<Record<LeftoverMove, string>> = { tomorrow: shortDay(tomorrow), nextweek: shortDay(nextWeek) };
                const due = t.dueDate ? (t.dueDate === day ? "Due today" : `Due ${shortDay(t.dueDate)}`) : "No date";
                return (
                  <li key={t.id} className="kshut-lrow" data-moved={choice ? true : undefined}>
                    <div className="kshut-lhead">
                      <StatusGlyph status={t.status} size={14} />
                      <span className="kshut-title truncate">{t.title}</span>
                      {p && <ProjectDot color={p.color} size={8} title={p.name} />}
                      <span className="kshut-due">{due}</span>
                    </div>
                    {c.moves.length > 0 ? (
                      <div className="kshut-chips" role="group" aria-label={`Where “${t.title}” goes`}>
                        {c.moves.map((m) => (
                          <button key={m} type="button" className="kshut-chip" aria-pressed={choice === m}
                            onClick={() => move(t, choice === m ? null : m)}>
                            {MOVE_LABEL[m]}{hint[m] && <> <span className="kshut-chip-hint">{hint[m]}</span></>}
                          </button>
                        ))}
                        {!c.mine && <span className="kshut-owner">{owner ? `${owner}'s task: its date stays` : "Shared task: its date stays"}</span>}
                      </div>
                    ) : readOnly ? null : (
                      <p className="kshut-owner kshut-owner-only">
                        <Icon name="lock" size={12} sw={2} />
                        {owner ? `${owner}'s task, due today. Its date is theirs to move.` : "A shared task, due today. Its date stays as it is."}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
            {limited && (
              <p className="kshut-private"><Icon name="lock" size={12} sw={2} /> Due dates only move later, and only on tasks assigned to you.</p>
            )}
          </>
        ) : (
          <div className="kshut-clear">
            <span className="kshut-clear-icon" aria-hidden="true"><Icon name="check" size={16} sw={2} /></span>
            <p className="kshut-clear-title">Nothing left over</p>
            <p className="kshut-clear-body">Everything due or planned for today is done. Today's list is clear.</p>
          </div>
        )}
      </>
    );
    footer = (
      <>
        <span className="kshut-foot-start"><Button variant="ghost" icon="arrowLeft" onClick={() => setStep(1)}>Back</Button></span>
        <Button variant="primary" iconRight="arrowRight" onClick={() => setStep(3)}>Next</Button>
      </>
    );
  } else if (step === 3) {
    const openTasks = tasks.filter((t) => t.status !== "done" && !t.archivedAt);
    const leftSet = new Set(leftIds);
    const targets = [...openTasks.filter((t) => leftSet.has(t.id)), ...openTasks.filter((t) => !leftSet.has(t.id))];
    const ready = !!blocker.text.trim() && !!blocker.taskId;
    body = (
      <>
        {stepper}
        {heading("Anything blocking you?")}
        <p className="kshut-lede">Say what's in the way and it's posted as a comment on a task, so the people on it can help. Or skip.</p>
        <div className="kshut-field">
          <label htmlFor={`${uid}-what`} className="kshut-label">What's blocking you?</label>
          <textarea id={`${uid}-what`} className="kshut-text" rows={3} value={blocker.text}
            placeholder="Waiting on the brand files from Theo" disabled={blocker.sending}
            aria-describedby={blocker.error ? `${uid}-err` : undefined} aria-invalid={blocker.error ? true : undefined}
            onChange={(e) => setBlocker((b) => ({ ...b, text: e.target.value, error: "" }))}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); postBlocker(); } }} />
        </div>
        <div className="kshut-field">
          <label htmlFor={`${uid}-task`} className="kshut-label">Post it on</label>
          <select id={`${uid}-task`} className="kshut-select" value={blocker.taskId} disabled={blocker.sending || !targets.length}
            onChange={(e) => setBlocker((b) => ({ ...b, taskId: e.target.value, error: "" }))}>
            {targets.length ? targets.map((t) => <option key={t.id} value={t.id}>{t.title}</option>) : <option value="">No open tasks to post on</option>}
          </select>
        </div>
        {blocker.error && <p id={`${uid}-err`} className="kshut-error" role="alert">{blocker.error}</p>}
      </>
    );
    footer = (
      <>
        <span className="kshut-foot-start"><Button variant="ghost" icon="arrowLeft" onClick={() => setStep(2)} disabled={blocker.sending}>Back</Button></span>
        <Button variant="ghost" onClick={() => setStep(4)} disabled={blocker.sending}>Skip</Button>
        <Button variant="primary" icon="send" loading={blocker.sending} disabled={!ready} onClick={postBlocker}>Post blocker</Button>
      </>
    );
  } else {
    body = (
      <div className="kshut-close">
        <ClosingMark animate={!prefersReducedMotion()} />
        <h3 className="kshut-close-line">{closingLine(finished.length, moved)}</h3>
        <p className="kshut-close-sub">
          {blocker.postedOn ? <>Your blocker is on “{blocker.postedOn}”. </> : null}
          {first ? `See you tomorrow, ${first}.` : "See you tomorrow."}
        </p>
        {colour.total > 0 && (
          <div className="kshut-close-colour">
            <DayColourBar segments={colour.segments} total={colour.total} />
            <p className="kshut-close-cap">Your day in colour · <span className="kshut-min">{fmtMinutes(colour.total)}</span></p>
          </div>
        )}
      </div>
    );
    footer = <Button ref={closeRef} variant="primary" onClick={finish}>Done</Button>;
  }

  return (
    <Sheet open={open} onClose={finish} label="Shut down my day" title="Shut down" width={560} initialFocus={nextRef}
      footer={<div className="kshut-foot" key={step}>{footer}</div>}>
      <style>{SHUT_CSS}</style>
      <div className="kshut" data-step={step}>{body}</div>
      {/* mounted with the sheet, so the closing line is announced when it arrives */}
      <p className="sr-only" role="status">{step === 4 ? closingLine(finished.length, moved) : ""}</p>
    </Sheet>
  );
}

/* "Your day in colour": minutes split by project (project colour), focus-timer
   minutes in the brand gradient. One image to a screen reader. */
function DayColourBar({ segments, total, legend }: { segments: DaySegment[]; total: number; legend?: boolean }) {
  const label = segments.map((s) => `${s.label} ${fmtMinutes(s.minutes)}`).join(", ");
  return (
    <>
      <div className="kshut-bar" role="img" aria-label={`Your day in colour: ${label}`}>
        {segments.map((s) => (
          <span key={s.key} title={`${s.label} · ${fmtMinutes(s.minutes)}`} data-focus={s.key === "focus" || undefined}
            style={{ flexGrow: s.minutes, background: s.key === "focus" ? undefined : projectPaint(s.color ?? "").solid }} />
        ))}
      </div>
      {legend && (
        <ul className="kshut-legend" aria-hidden="true">
          {segments.map((s) => (
            <li key={s.key}>
              {s.key === "focus" ? <span className="kshut-focusdot" /> : <ProjectDot color={s.color ?? ""} size={8} />}
              <span className="truncate">{s.label}</span>
              <span className="kshut-min">{fmtMinutes(s.minutes)}</span>
            </li>
          ))}
          <li className="kshut-total"><span>Total</span><span className="kshut-min">{fmtMinutes(total)}</span></li>
        </ul>
      )}
    </>
  );
}

/* The Kanbo mark drawing itself once in the brand gradient (static under reduced motion). */
function ClosingMark({ animate }: { animate: boolean }) {
  const gid = `kshut-g${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const bars = [
    "M2 1H3A1.5 1.5 0 0 1 4.5 2.5V7.9A1.5 1.5 0 0 1 3 9.4H2A1.5 1.5 0 0 1 .5 7.9V2.5A1.5 1.5 0 0 1 2 1Z",
    "M7.5 1H8.5A1.5 1.5 0 0 1 10 2.5V13.5A1.5 1.5 0 0 1 8.5 15H7.5A1.5 1.5 0 0 1 6 13.5V2.5A1.5 1.5 0 0 1 7.5 1Z",
    "M13 1H14A1.5 1.5 0 0 1 15.5 2.5V5.1A1.5 1.5 0 0 1 14 6.6H13A1.5 1.5 0 0 1 11.5 5.1V2.5A1.5 1.5 0 0 1 13 1Z",
  ];
  return (
    <svg className="kshut-mark" data-draw={animate || undefined} width={56} height={56} viewBox="-1 -1 18 18" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={gid} gradientUnits="userSpaceOnUse" x1="0" y1="1" x2="16" y2="15">
          <stop offset="0" stopColor="#5B7CFA" />
          <stop offset="0.52" stopColor="#8B5CF6" />
          <stop offset="1" stopColor="#C24BE0" />
        </linearGradient>
      </defs>
      {bars.map((d, i) => (
        <path key={i} d={d} pathLength={1} fill={`url(#${gid})`} stroke={`url(#${gid})`} strokeWidth={0.6}
          strokeLinejoin="round" style={{ animationDelay: `${i * 80}ms, ${240 + i * 80}ms` }} />
      ))}
    </svg>
  );
}

const SHUT_CSS = `
.kshut { display: flex; flex-direction: column; gap: 16px; padding-top: 4px; }
.kshut-steps { display: flex; gap: 4px; }
.kshut-steps > span { width: 24px; height: 2px; border-radius: 2px; background: var(--hairline-strong); }
.kshut-steps > span[data-on="true"] { background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)); }
.kshut-h { margin: -4px 0 0; font: 600 15px/24px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink); }
/* focused only so a screen reader announces the step; it isn't a control */
.kshut-h:focus, .kshut-h:focus-visible { outline: none; }
.kshut-lede { margin: -8px 0 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kshut-count { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 12px; margin: -8px 0 0; }
.kshut-num { font: 600 var(--t-hero, 40px)/var(--lh-hero, 44px) var(--font-head); letter-spacing: -0.028em; font-variant-numeric: tabular-nums; }
.kshut-unit { font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kshut-none { margin: -8px 0 0; font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink-2); text-wrap: pretty; }
.kshut-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.kshut-item { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 0 4px; border-radius: var(--r-sm, 6px); }
.kshut-title { flex: 1 1 auto; min-width: 0; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.kshut-item .kshut-title { color: var(--ink-2); }
.kshut-min { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kshut-more { padding: 4px 4px 0 32px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kshut-colour { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
.kshut-bar { display: flex; gap: 2px; height: 12px; border-radius: var(--r-full, 999px); overflow: hidden; background: var(--track, var(--fill-2)); }
.kshut-bar > span { flex-basis: 0; min-width: 4px; }
.kshut-bar > span[data-focus="true"] { background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)); }
.kshut-legend { display: flex; flex-wrap: wrap; gap: 6px 16px; margin: 0; padding: 0; list-style: none; }
.kshut-legend li { display: inline-flex; align-items: center; gap: 6px; min-width: 0; max-width: 100%; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kshut-legend .kshut-total { margin-left: auto; color: var(--ink-3); }
.kshut-focusdot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 2px; background: var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%)); }
.kshut-private { display: flex; align-items: center; gap: 6px; margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kshut-private svg { color: var(--icon-quiet, var(--ink-4)); }

/* list rows sit on the sheet (e0): whitespace between them, a quiet fill once moved */
.kshut-left { display: flex; flex-direction: column; gap: 2px; margin: -8px -8px 0; padding: 0; list-style: none; }
.kshut-lrow { display: flex; flex-direction: column; gap: 8px; padding: 8px; border-radius: var(--r-sm, 6px); transition: background var(--d-2, 160ms) var(--ease); }
.kshut-lrow[data-moved="true"] { background: var(--fill-1); }
.kshut-lrow[data-moved="true"] .kshut-title { color: var(--ink-3); }
.kshut-lhead { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 24px; }
.kshut-due { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kshut-owner { display: inline-flex; align-items: center; gap: 6px; min-height: var(--h-sm, 28px); font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kshut-owner-only { margin: 0; padding-left: 24px; min-height: 0; }
.kshut-owner svg { flex-shrink: 0; color: var(--icon-quiet, var(--ink-4)); }
.kshut-chips { display: flex; flex-wrap: wrap; gap: 6px; padding-left: 24px; }
.kshut-chip {
  display: inline-flex; align-items: center; gap: 6px; height: var(--h-sm, 28px); padding: 0 10px; border-radius: var(--r-sm, 6px);
  border: 1px solid var(--hairline-strong); background: var(--surface-raised); color: var(--ink-2); cursor: pointer; white-space: nowrap;
  font: 600 12px/1 var(--font-ui, var(--font-display));
  transition: background var(--d-1, 90ms) var(--ease), color var(--d-1, 90ms) var(--ease), border-color var(--d-1, 90ms) var(--ease);
}
.kshut-chip:hover { background: linear-gradient(var(--fill-1), var(--fill-1)), var(--surface-raised); color: var(--ink); }
.kshut-chip[aria-pressed="true"] { border-color: var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent)); background: var(--bg-selected, var(--accent-dim)); color: var(--accent-text, var(--accent)); }
.kshut-chip-hint { font: 500 11px/1 var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kshut-chip[aria-pressed="true"] .kshut-chip-hint { color: inherit; }
.kshut-clear { display: flex; flex-direction: column; align-items: center; padding: 24px 16px 8px; text-align: center; }
.kshut-clear-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; color: var(--ok, var(--st-done)); background: color-mix(in oklch, var(--ok, var(--st-done)) 12%, transparent); }
.kshut-clear-title { margin: 12px 0 0; font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); }
.kshut-clear-body { margin: 4px 0 0; max-width: 360px; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }

.kshut-field { display: flex; flex-direction: column; gap: 6px; }
.kshut-label { font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.kshut-select, .kshut-text {
  box-sizing: border-box; width: 100%; margin: 0; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface-solid)); color: var(--ink); font: 500 13px/20px var(--font-ui, var(--font-display));
}
.kshut-select { height: var(--h-lg, 40px); padding: 0 10px; }
.kshut-text { min-height: 88px; padding: 10px 12px; resize: vertical; font-weight: 400; }
.kshut-text::placeholder { color: var(--ink-4); }
.kshut-select:hover, .kshut-text:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.kshut-error { margin: -8px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--st-blocked)); }

.kshut-close { display: flex; flex-direction: column; align-items: center; padding: 32px 16px 16px; text-align: center; }
.kshut-close-line { margin: 20px 0 0; max-width: 420px; font: 600 15px/24px var(--font-ui, var(--font-display)); color: var(--ink); text-wrap: balance; }
.kshut-close-sub { margin: 6px 0 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kshut-close-colour { display: flex; flex-direction: column; gap: 8px; width: 100%; max-width: 320px; margin-top: 24px; }
.kshut-close-colour .kshut-bar { height: 8px; }
.kshut-close-cap { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kshut-mark path { fill-opacity: 1; }
.kshut-mark[data-draw="true"] path {
  stroke-dasharray: 1; stroke-dashoffset: 0; fill-opacity: 1;
  animation: kshutDraw var(--d-4, 480ms) var(--ease) both, kshutFill var(--d-3, 240ms) var(--ease) both;
}
@keyframes kshutDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes kshutFill { from { fill-opacity: 0; } to { fill-opacity: 1; } }

.kshut-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; width: 100%; }
.kshut-foot-start { display: inline-flex; align-items: center; margin-right: auto; }
@media (max-width: 859px) {
  .kshut-chips, .kshut-owner-only { padding-left: 0; }
  .kshut-num { font-size: 32px; line-height: 40px; }
}
@media (prefers-reduced-motion: reduce) {
  .kshut-mark path { animation: none !important; stroke-dashoffset: 0; fill-opacity: 1; }
}
`;
