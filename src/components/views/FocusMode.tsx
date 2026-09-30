/* ============================================================
   KANBO — Deep Work focus mode (full-screen takeover).
   One ring, one number, one task. The ring fills with the brand
   gradient as the block runs (focus is one of the gradient's five
   uses); the page behind is the canvas at 96%, never blurred, and
   opaque behind the timer itself.
   ============================================================ */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Icon, IconButton, SectionLabel, StatusGlyph } from "../primitives";
import type { Task } from "../../data/types";
import type { FocusTimer } from "../../hooks/useFocusTimer";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { fmtDuration } from "./planCanvas";

const fmtBanked = (m: number) => fmtDuration(m);

const FOCUS_CSS = `
/* the canvas at 96% (never blurred), and fully opaque in the middle, where the
   timer and its controls sit: the page recedes at the edges, nothing reads through */
.kfocus { position: fixed; inset: 0; z-index: 120; display: flex; flex-direction: column;
  background: radial-gradient(closest-side at 50% 50%, var(--bg) 62%, transparent),
    color-mix(in oklch, var(--bg) 96%, transparent);
  --kf-ui: var(--font-ui, var(--font-display)); }
.kfocus-top { position: relative; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-height: 56px; padding: 12px var(--gutter, 32px); }
.kfocus-label { display: inline-flex; align-items: center; gap: 8px; font: 600 12px/16px var(--kf-ui); color: var(--ink-3); }
.kfocus-label svg { color: var(--accent-text, var(--accent)); }
.kfocus-today { margin-left: auto; font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kfocus-today[data-flash="true"] { color: var(--accent-text, var(--accent)); }
.kfocus-centre { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 24px; padding: 0 16px; }
.kfocus-ring { position: relative; width: 240px; height: 240px; max-width: 70vw; max-height: 70vw; }
.kfocus-ring svg { display: block; width: 100%; height: 100%; transform: rotate(-90deg); }
.kfocus-ring-arc { transition: stroke-dashoffset 1s linear; }
.kfocus-read { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; }
.kfocus-time { font: 500 40px/44px var(--font-mono); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; color: var(--ink); }
.kfocus-state { margin-top: 8px; font: 600 12px/16px var(--kf-ui); color: var(--ink-3); }
.kfocus-state[data-live="true"] { color: var(--accent-text, var(--accent)); }
.kfocus-task { display: inline-flex; align-items: center; gap: 10px; max-width: min(560px, calc(100vw - 48px)); padding: 6px 12px; margin: 0;
  border: 0; border-radius: var(--r-md, 8px); background: transparent; cursor: pointer; color: var(--ink); text-align: left; }
.kfocus-task:hover { background: var(--fill-1); }
.kfocus-task span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 600 20px/28px var(--font-head); letter-spacing: -0.012em; }
.kfocus-pick-hint { font: 400 15px/24px var(--kf-ui); color: var(--ink-3); }
.kfocus-controls { display: flex; align-items: center; flex-wrap: wrap; justify-content: center; gap: 12px; }
.kfocus-lengths { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--r-sm, 6px); background: var(--fill-1); }
.kfocus-lengths button { min-width: 44px; height: 36px; padding: 0 10px; border: 0; border-radius: calc(var(--r-sm, 6px) - 2px); background: transparent; cursor: pointer;
  font: 500 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kfocus-lengths button:hover { color: var(--ink); }
.kfocus-lengths button[aria-pressed="true"] { background: var(--surface-raised); color: var(--ink); box-shadow: var(--e1, var(--shadow)); }
.kfocus-play.kbtn { min-width: 132px; }
.kfocus-picker { width: 100%; max-width: 720px; margin: 0 auto; padding: 0 var(--gutter, 32px) 28px; }
.kfocus-chips { display: flex; gap: 8px; overflow-x: auto; padding: 2px 2px 4px; }
.kfocus-chip { display: inline-flex; align-items: center; gap: 8px; flex-shrink: 0; max-width: 280px; height: 40px; padding: 0 12px;
  border: 0; border-radius: var(--r-md, 8px); background: var(--surface-raised); box-shadow: var(--e1, var(--shadow)); cursor: pointer; color: var(--ink); }
.kfocus-chip:hover { box-shadow: var(--e2, var(--shadow-lg)); }
.kfocus-chip[aria-pressed="true"] { box-shadow: 0 0 0 1.5px var(--accent), var(--e1, var(--shadow)); }
.kfocus-chip b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 500 13px/20px var(--kf-ui); }
.kfocus-chip small { flex-shrink: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .kfocus-ring-arc { transition: none; } }
@media (max-width: 859px) {
  /* a phone is all middle */
  .kfocus { background: var(--bg); }
  .kfocus-top { padding: 8px 16px; }
  .kfocus-picker { padding: 0 16px 20px; }
  /* reset · play · Pomodoro on one row, the lengths centred under them */
  .kfocus-lengths { order: 1; }
}
`;

export function FocusMode({ focus, tasks, onClose, onOpenTask }: {
  focus: FocusTimer;
  tasks: Task[];
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { running, seconds, setRunning, reset, endSession, targetMin, setTargetMin, taskId, setTaskId, pomodoro, setPomodoro, phase, cyclesToday, focusMinToday, notice, notifyPermission, requestNotify } = focus;
  const trapRef = useFocusTrap<HTMLDivElement>(true, onClose);
  const playRef = useRef<HTMLButtonElement>(null);
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const gid = "kfr" + useId().replace(/[^a-zA-Z0-9]/g, "");
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef(0);
  // land keyboard focus on the main control (the trap keeps Tab inside the takeover)
  useEffect(() => { playRef.current?.focus(); }, []);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const task = tasks.find((t) => t.id === taskId);
  const total = Math.max(1, targetMin) * 60;
  const onBreak = pomodoro && phase === "break";
  // a block that just completed shows a full ring until the next one starts
  const justDone = !running && seconds === 0 && notice?.kind === "goal";
  const pct = justDone ? 100 : Math.min(100, (seconds / total) * 100);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  // surface today's time-blocked work first (ties Focus to Today's plan), then
  // fill with the highest-priority remaining tasks.
  const open = tasks.filter((t) => t.status !== "done" && !t.archivedAt && !t.parentId);
  const todaysPlanned = open.filter((t) => t.planToday && t.scheduled != null).sort((a, b) => (a.scheduled! - b.scheduled!));
  const rest = open.filter((t) => !todaysPlanned.some((p) => p.id === t.id)).sort((a, b) => b.aiScore - a.aiScore);
  const candidates = [...todaysPlanned, ...rest].slice(0, 6);
  const pickerLabel = todaysPlanned.length > 0 ? "On your day" : "Suggested focus";
  const state = pomodoro
    ? (onBreak ? "Break" : "Focus")
    : justDone ? "Done" : running ? "In flow" : seconds > 0 ? "Paused" : "Ready";
  const detail = justDone && notice ? (notice.min > 0 ? `${notice.min}m banked` : "block complete") : `${targetMin}m${pomodoro && cyclesToday > 0 ? ` · ${cyclesToday} cycle${cyclesToday === 1 ? "" : "s"} today` : " goal"}`;
  const announcement = notice
    ? notice.kind === "goal" ? `Focus block complete.${notice.min > 0 ? ` ${notice.min} minutes banked.` : ""}`
      : notice.kind === "break" ? `Focus interval complete. Time for a ${targetMin}-minute break.`
      : "Break's over. Press play when you're ready for the next focus block."
    : "";

  const end = () => {
    const m = endSession();
    setFlash(m > 0 ? `Banked ${m}m of deep work` : onBreak ? "Break ended" : "Too short to bank");
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), 3200);
  };

  const size = 240, stroke = 6, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const today = (cyclesToday > 0 || focusMinToday > 0)
    ? `Today: ${fmtBanked(focusMinToday)} focus${cyclesToday > 0 ? ` · ${cyclesToday} cycle${cyclesToday === 1 ? "" : "s"}` : ""}` : "";
  const playLabel = running ? "Pause focus timer" : seconds > 0 ? "Resume focus timer" : onBreak ? "Start break" : "Start focus timer";

  return (
    <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Focus mode" className="kfocus">
      <style>{FOCUS_CSS}</style>
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      {/* top bar */}
      <div className="kfocus-top">
        <span className="kfocus-label"><Icon name="clock" size={16} sw={1.75} /> Deep Work · Focus mode</span>
        <span role="status" aria-live="polite" className="kfocus-today" data-flash={!!flash || undefined}>{flash || today}</span>
        {seconds > 0 && <Button variant="ghost" size="sm" icon="check" onClick={end} title="Stop and bank this session">End session</Button>}
        <Button variant="ghost" size="sm" icon="x" onClick={onClose}>Exit</Button>
      </div>

      {/* centre */}
      <div className="kfocus-centre">
        <div className="kfocus-ring">
          <svg aria-hidden="true" viewBox={`0 0 ${size} ${size}`}>
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="var(--brand-blue, #5B7CFA)" />
                <stop offset="0.52" stopColor="var(--brand-violet, #8B5CF6)" />
                <stop offset="1" stopColor="var(--brand-magenta, #C24BE0)" />
              </linearGradient>
            </defs>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--track, var(--surface-2))" strokeWidth={stroke} />
            <circle className="kfocus-ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none"
              stroke={onBreak ? "var(--st-progress-fill, var(--st-progress))" : `url(#${gid})`} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={reduceMotion ? { transition: "none" } : undefined} />
          </svg>
          <div className="kfocus-read">
            <div>
              <div role="timer" aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds of ${targetMin}`} className="kfocus-time">{mm}:{ss}</div>
              <div className="kfocus-state" data-live={running || justDone || undefined}>{state} · {detail}</div>
            </div>
          </div>
        </div>

        {/* the task */}
        {task ? (
          <button type="button" className="kfocus-task" onClick={() => onOpenTask(task.id)} aria-label={`Open “${task.title}”`}>
            <StatusGlyph status={task.status} readOnly />
            <span>{task.title}</span>
          </button>
        ) : (
          <p className="kfocus-pick-hint" style={{ margin: 0 }}>Pick a task to focus on below</p>
        )}

        {/* controls */}
        <div className="kfocus-controls">
          <IconButton icon="refresh" label="Reset timer" size="lg" variant="secondary" onClick={reset} />
          <Button ref={playRef} data-autofocus variant="hero" size="lg" className="kfocus-play" icon={running ? "pause" : "play"}
            aria-label={playLabel} onClick={() => setRunning((v) => !v)}>
            {running ? "Pause" : seconds > 0 ? "Resume" : onBreak ? "Start break" : "Start"}
          </Button>
          <div role="group" aria-label="Session length" className="kfocus-lengths">
            {[25, 50, 90].map((m) => (
              <button type="button" key={m} onClick={() => setTargetMin(m)} aria-label={`${m}-minute ${onBreak ? "break" : "session"}`} aria-pressed={targetMin === m}
                // a length you've already passed finishes this interval now (the time spent is banked, never lost)
                title={seconds > 0 && seconds >= m * 60 && targetMin !== m ? (onBreak ? `Already past ${m}m: ends the break now` : `Already past ${m}m: finishes the block and banks your time`) : undefined}>{m}m</button>
            ))}
          </div>
          <IconButton icon="hourglass" label="Pomodoro mode" size="lg" variant="secondary" pressed={pomodoro} onClick={() => setPomodoro(!pomodoro)} />
        </div>
        {notifyPermission === "default" && (
          <Button variant="ghost" size="sm" icon="bell" onClick={requestNotify}>Notify me when time's up</Button>
        )}
      </div>

      {/* task picker */}
      {candidates.length > 0 && (
        <div className="kfocus-picker">
          <SectionLabel id={gid + "-pick"}>{pickerLabel}</SectionLabel>
          <div role="group" aria-labelledby={gid + "-pick"} className="kfocus-chips">
            {candidates.map((t) => (
              <button type="button" key={t.id} className="kfocus-chip" onClick={() => setTaskId(t.id)} aria-pressed={t.id === taskId}
                aria-label={`Focus on “${t.title}”, ${t.focusMin} minutes`}>
                <StatusGlyph status={t.status} size={14} readOnly />
                <b>{t.title}</b>
                <small>{fmtDuration(t.focusMin)}</small>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
