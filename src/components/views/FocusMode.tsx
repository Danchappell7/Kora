/* ============================================================
   KANBO — Deep Work focus mode (full-screen takeover)
   ============================================================ */
import { useEffect, useRef, useState } from "react";
import { Icon, StatusDot, AiScore } from "../primitives";
import type { Task } from "../../data/types";
import type { FocusTimer } from "../../hooks/useFocusTimer";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const fmtBanked = (m: number) => `${Math.floor(m / 60) ? `${Math.floor(m / 60)}h ` : ""}${m % 60}m`;

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
  // surface today's time-blocked work first (ties Focus to Plan-my-day), then
  // fill with the highest-priority remaining tasks.
  const open = tasks.filter((t) => t.status !== "done" && !t.archivedAt && !t.parentId);
  const todaysPlanned = open.filter((t) => t.planToday && t.scheduled != null).sort((a, b) => (a.scheduled! - b.scheduled!));
  const rest = open.filter((t) => !todaysPlanned.some((p) => p.id === t.id)).sort((a, b) => b.aiScore - a.aiScore);
  const candidates = [...todaysPlanned, ...rest].slice(0, 6);
  const pickerLabel = todaysPlanned.length > 0 ? "On your day" : "Suggested focus";
  const ringColor = onBreak ? "var(--st-progress)" : "var(--accent)";
  const state = pomodoro
    ? (onBreak ? "Break" : "Focus")
    : justDone ? "Done" : running ? "In flow" : seconds > 0 ? "Paused" : "Ready";
  const detail = justDone && notice ? (notice.min > 0 ? `${notice.min}m banked` : "block complete") : `${targetMin}m${pomodoro && cyclesToday > 0 ? ` · ${cyclesToday}🍅 today` : " goal"}`;
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

  const size = 320, stroke = 6, r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const enter = reduceMotion ? undefined : "anim-scalein";

  return (
    <div ref={trapRef} role="dialog" aria-modal="true" aria-label="Focus mode" style={{ position: "fixed", inset: 0, zIndex: 120, background: "var(--bg-deep)", display: "flex", flexDirection: "column" }}>
      {/* atmosphere */}
      <div aria-hidden="true" style={{ position: "absolute", inset: 0, background: "radial-gradient(700px 500px at 50% 38%, var(--accent-glow), transparent 62%)", opacity: running ? 0.7 : 0.3, transition: reduceMotion ? undefined : "opacity 1s", pointerEvents: "none" }} />
      <div aria-hidden="true" className="app-grid" style={{ opacity: 0.5 }} />
      <div role="status" aria-live="polite" className="sr-only">{announcement}</div>

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, padding: "20px 24px", position: "relative", zIndex: 2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
          <Icon name="clock" size={17} style={{ color: "var(--accent)" }} />
          <span className="kicker" style={{ color: "var(--accent)" }}>Deep Work · Focus mode</span>
        </span>
        <span role="status" aria-live="polite" className="mono" style={{ marginLeft: "auto", fontSize: 12, color: flash ? "var(--accent)" : "var(--ink-4)", fontWeight: flash ? 600 : 400 }}>
          {flash || ((cyclesToday > 0 || focusMinToday > 0) ? `Today: ${cyclesToday} 🍅 · ${fmtBanked(focusMinToday)} focus` : "")}
        </span>
        {seconds > 0 && <button type="button" className="btn btn-ghost" onClick={end} title="Stop and bank this session" style={{ marginLeft: 6, color: "var(--accent)" }}><Icon name="check" size={16} /> End session</button>}
        <button type="button" className="btn btn-ghost" onClick={onClose}><Icon name="x" size={16} /> Exit</button>
      </div>

      {/* center */}
      <div className={enter} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 2, gap: 4, minHeight: 0 }}>
        <div style={{ position: "relative", width: size, height: size, maxWidth: "80vw", maxHeight: "80vw" }}>
          <svg aria-hidden="true" viewBox={`0 0 ${size} ${size}`} width="100%" height="100%" style={{ transform: "rotate(-90deg)" }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline-strong)" strokeWidth={stroke} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={{ transition: reduceMotion ? undefined : "stroke-dashoffset 1s linear", filter: `drop-shadow(0 0 10px ${ringColor})` }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <div role="timer" aria-label={`${Math.floor(seconds / 60)} minutes ${seconds % 60} seconds of ${targetMin}`} className="mono tnum" style={{ fontSize: "clamp(48px, 17vw, 76px)", fontWeight: 500, lineHeight: 1, letterSpacing: "-0.03em", color: "var(--ink)" }}>{mm}:{ss}</div>
              <div className="kicker" style={{ marginTop: 10, color: running || justDone ? ringColor : "var(--ink-4)" }}>{state} · {detail}</div>
            </div>
          </div>
        </div>

        {/* current task */}
        {task ? (
          <button type="button" onClick={() => onOpenTask(task.id)} aria-label={`Open “${task.title}”`} className="glass clickable" style={{ marginTop: 28, padding: "13px 18px", borderRadius: 14, display: "flex", alignItems: "center", gap: 12, maxWidth: "min(460px, calc(100vw - 48px))" }}>
            <StatusDot status={task.status} size={9} glow />
            <span style={{ fontSize: 14.5, fontWeight: 500 }} className="truncate">{task.title}</span>
            <AiScore score={task.aiScore} reason={task.aiReason} />
          </button>
        ) : (
          <div style={{ marginTop: 28, fontSize: 13.5, color: "var(--ink-4)" }}>Pick a task to focus on below</div>
        )}

        {/* controls */}
        <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", justifyContent: "center", gap: 12, marginTop: 26 }}>
          <button type="button" className="btn-icon" onClick={reset} style={{ width: 44, height: 44, borderRadius: 14 }} title="Reset" aria-label="Reset timer"><Icon name="refresh" size={18} /></button>
          <button ref={playRef} type="button" data-autofocus onClick={() => setRunning((v) => !v)} className="btn btn-accent"
            aria-label={running ? "Pause focus timer" : seconds > 0 ? "Resume focus timer" : onBreak ? "Start break" : "Start focus timer"}
            style={{ width: 64, height: 64, borderRadius: 20, justifyContent: "center", padding: 0 }}>
            <Icon name={running ? "pause" : "play"} size={26} fill="currentColor" />
          </button>
          <div role="group" aria-label="Session length" style={{ display: "flex", gap: 6 }}>
            {[25, 50, 90].map((m) => (
              <button type="button" key={m} onClick={() => setTargetMin(m)} className="btn-icon" aria-label={`${m}-minute ${onBreak ? "break" : "session"}`} aria-pressed={targetMin === m}
                style={{ width: 44, height: 44, borderRadius: 14, fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, border: targetMin === m ? "1px solid var(--accent)" : "1px solid var(--hairline)", color: targetMin === m ? "var(--accent)" : "var(--ink-3)" }}>{m}</button>
            ))}
          </div>
          <button type="button" onClick={() => setPomodoro(!pomodoro)} className="btn-icon" title="Pomodoro mode — auto work/break cycles" aria-label="Pomodoro mode" aria-pressed={pomodoro}
            style={{ width: 44, height: 44, borderRadius: 14, fontSize: 18, border: pomodoro ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: pomodoro ? "var(--accent-dim)" : undefined }}>🍅</button>
        </div>
        {notifyPermission === "default" && (
          <button type="button" className="btn btn-ghost" onClick={requestNotify} style={{ marginTop: 16, padding: "5px 11px", fontSize: 12.5, color: "var(--ink-3)" }}>
            <Icon name="bell" size={13} /> Notify me when time's up
          </button>
        )}
      </div>

      {/* task picker */}
      <div style={{ position: "relative", zIndex: 2, padding: "0 24px 28px", maxWidth: 720, width: "100%", margin: "0 auto" }}>
        <div className="kicker" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 7 }}><Icon name={todaysPlanned.length > 0 ? "calendarPlus" : "sparkles"} size={13} style={{ color: "var(--accent)" }} /> {pickerLabel}</div>
        <div role="group" aria-label={pickerLabel} style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {candidates.map((t) => (
            <button type="button" key={t.id} onClick={() => setTaskId(t.id)} aria-pressed={t.id === taskId} aria-label={`Focus on “${t.title}”, ${t.focusMin} minutes`} className="glass" style={{ padding: "9px 13px", borderRadius: 11, display: "flex", alignItems: "center", gap: 9, flexShrink: 0, maxWidth: 280, cursor: "pointer", border: t.id === taskId ? "1px solid var(--accent)" : "1px solid var(--hairline)" }}>
              <StatusDot status={t.status} size={7} />
              <span style={{ fontSize: 13 }} className="truncate">{t.title}</span>
              <span className="mono" style={{ fontSize: 11, color: "var(--ink-4)" }}>{t.focusMin}m</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
