/* ============================================================
   KANBO — Deep Work focus mode (full-screen takeover)
   ============================================================ */
import { Icon, StatusDot, AiScore } from "../primitives";
import type { Task } from "../../data/types";
import type { FocusTimer } from "../../hooks/useFocusTimer";

export function FocusMode({ focus, tasks, onClose, onOpenTask }: {
  focus: FocusTimer;
  tasks: Task[];
  onClose: () => void;
  onOpenTask: (id: string) => void;
}) {
  const { running, seconds, setRunning, reset, targetMin, setTargetMin, taskId, setTaskId, pomodoro, setPomodoro, phase, cyclesToday, focusMinToday } = focus;
  const task = tasks.find((t) => t.id === taskId);
  const total = targetMin * 60;
  const pct = Math.min(100, (seconds / total) * 100);
  const mm = String(Math.floor(seconds / 60)).padStart(2, "0");
  const ss = String(seconds % 60).padStart(2, "0");
  const candidates = tasks.filter((t) => t.status !== "done").sort((a, b) => b.aiScore - a.aiScore).slice(0, 5);
  const onBreak = pomodoro && phase === "break";
  const ringColor = onBreak ? "var(--st-progress)" : "var(--accent)";

  const size = 320, stroke = 6, r = (size - stroke) / 2, c = 2 * Math.PI * r;

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 120, background: "var(--bg-deep)", display: "flex", flexDirection: "column", animation: "fadeIn .35s var(--ease)" }}>
      {/* atmosphere */}
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(700px 500px at 50% 38%, var(--accent-glow), transparent 62%)", opacity: running ? 0.7 : 0.3, transition: "opacity 1s", pointerEvents: "none" }} />
      <div className="app-grid" style={{ opacity: 0.5 }} />

      {/* top bar */}
      <div style={{ display: "flex", alignItems: "center", padding: "20px 24px", position: "relative", zIndex: 2 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
          <Icon name="clock" size={17} style={{ color: "var(--accent)" }} />
          <span className="kicker" style={{ color: "var(--accent)" }}>Deep Work · Focus mode</span>
        </span>
        {(cyclesToday > 0 || focusMinToday > 0) && (
          <span className="mono" style={{ marginLeft: "auto", marginRight: 14, fontSize: 12, color: "var(--ink-4)" }}>
            Today: {cyclesToday} 🍅 · {Math.floor(focusMinToday / 60) ? `${Math.floor(focusMinToday / 60)}h ` : ""}{focusMinToday % 60}m focus
          </span>
        )}
        <button className="btn btn-ghost" onClick={onClose} style={{ marginLeft: (cyclesToday > 0 || focusMinToday > 0) ? 0 : "auto" }}><Icon name="x" size={16} /> Exit</button>
      </div>

      {/* center */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative", zIndex: 2, gap: 4 }}>
        <div style={{ position: "relative", width: size, height: size }}>
          <svg width={size} height={size} style={{ transform: "rotate(-90deg)" }}>
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--hairline-strong)" strokeWidth={stroke} />
            <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={ringColor} strokeWidth={stroke} strokeLinecap="round"
              strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} style={{ transition: "stroke-dashoffset 1s linear", filter: `drop-shadow(0 0 10px ${ringColor})` }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
            <div style={{ textAlign: "center" }}>
              <div className="mono tnum" style={{ fontSize: 76, fontWeight: 500, lineHeight: 1, letterSpacing: "-0.03em", color: "var(--ink)" }}>{mm}:{ss}</div>
              <div className="kicker" style={{ marginTop: 10, color: running ? ringColor : "var(--ink-4)" }}>{pomodoro ? (onBreak ? "Break" : "Focus") : (running ? "In flow" : "Ready")} · {targetMin}m{pomodoro && cyclesToday > 0 ? ` · ${cyclesToday}🍅 today` : " goal"}</div>
            </div>
          </div>
        </div>

        {/* current task */}
        {task ? (
          <button onClick={() => onOpenTask(task.id)} className="glass clickable" style={{ marginTop: 28, padding: "13px 18px", borderRadius: 14, display: "flex", alignItems: "center", gap: 12, maxWidth: 460 }}>
            <StatusDot status={task.status} size={9} glow />
            <span style={{ fontSize: 14.5, fontWeight: 500 }} className="truncate">{task.title}</span>
            <AiScore score={task.aiScore} reason={task.aiReason} />
          </button>
        ) : (
          <div style={{ marginTop: 28, fontSize: 13.5, color: "var(--ink-4)" }}>Pick a task to focus on below</div>
        )}

        {/* controls */}
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 26 }}>
          <button className="btn-icon" onClick={reset} style={{ width: 44, height: 44, borderRadius: 14 }} title="Reset"><Icon name="refresh" size={18} /></button>
          <button onClick={() => setRunning((v) => !v)} className="btn btn-accent" style={{ width: 64, height: 64, borderRadius: 20, justifyContent: "center", padding: 0 }}>
            <Icon name={running ? "pause" : "play"} size={26} fill="currentColor" />
          </button>
          <div style={{ display: "flex", gap: 6 }}>
            {[25, 50, 90].map((m) => (
              <button key={m} onClick={() => setTargetMin(m)} className="btn-icon" style={{ width: 44, height: 44, borderRadius: 14, fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, border: targetMin === m ? "1px solid var(--accent)" : "1px solid var(--hairline)", color: targetMin === m ? "var(--accent)" : "var(--ink-3)" }}>{m}</button>
            ))}
          </div>
          <button onClick={() => setPomodoro(!pomodoro)} className="btn-icon" title="Pomodoro mode — auto work/break cycles"
            style={{ width: 44, height: 44, borderRadius: 14, fontSize: 18, border: pomodoro ? "1px solid var(--accent)" : "1px solid var(--hairline)", background: pomodoro ? "var(--accent-dim)" : undefined }}>🍅</button>
        </div>
      </div>

      {/* task picker */}
      <div style={{ position: "relative", zIndex: 2, padding: "0 24px 28px", maxWidth: 720, width: "100%", margin: "0 auto" }}>
        <div className="kicker" style={{ marginBottom: 10, display: "flex", alignItems: "center", gap: 7 }}><Icon name="sparkles" size={13} style={{ color: "var(--accent)" }} /> Suggested focus</div>
        <div style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {candidates.map((t) => (
            <button key={t.id} onClick={() => setTaskId(t.id)} className="glass" style={{ padding: "9px 13px", borderRadius: 11, display: "flex", alignItems: "center", gap: 9, flexShrink: 0, cursor: "pointer", border: t.id === taskId ? "1px solid var(--accent)" : "1px solid var(--hairline)" }}>
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
