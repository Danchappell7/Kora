/* ============================================================
   KANBO — Home dashboard
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, StatusDot, AiScore } from "../primitives";
import { Sparkline } from "../charts";
import { getProject, projectProgress, dueState, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project, IconName } from "../../data/types";
import type { Route } from "../../app-types";

/* First-run getting-started checklist — tracks real progress, dismissible. */
function GettingStarted({ steps }: { steps: { label: string; done: boolean; action: () => void; cta: string }[] }) {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem("kanbo-gs-dismissed") === "1"; } catch { return false; } });
  const doneN = steps.filter((s) => s.done).length;
  if (dismissed || doneN === steps.length) return null;
  const dismiss = () => { try { localStorage.setItem("kanbo-gs-dismissed", "1"); } catch { /* private mode */ } setDismissed(true); };
  return (
    <div className="glass anim-fadeup" style={{ padding: 18, borderRadius: 16, marginBottom: 18, border: "1px solid color-mix(in oklch, var(--accent) 30%, transparent)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
        <Icon name="sparkles" size={16} style={{ color: "var(--accent)" }} />
        <span style={{ fontSize: 14.5, fontWeight: 600 }}>Getting started</span>
        <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{doneN}/{steps.length}</span>
        <button onClick={dismiss} aria-label="Dismiss getting started" style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", display: "inline-flex" }}><Icon name="x" size={15} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
        {steps.map((s) => (
          <button key={s.label} onClick={s.done ? undefined : s.action} disabled={s.done} style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 13px", borderRadius: 12, border: "1px solid var(--hairline)", background: s.done ? "var(--surface-2)" : "var(--surface)", cursor: s.done ? "default" : "pointer", textAlign: "left" }}>
            <span style={{ width: 22, height: 22, borderRadius: 99, flexShrink: 0, display: "grid", placeItems: "center", background: s.done ? "var(--st-done)" : "var(--accent-dim)", color: s.done ? "var(--bg-deep)" : "var(--accent)" }}>
              {s.done ? <Icon name="check" size={13} sw={3} /> : <Icon name="arrowRight" size={13} />}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13.5, fontWeight: 500, textDecoration: s.done ? "line-through" : "none", color: s.done ? "var(--ink-4)" : "var(--ink)" }}>{s.label}</span>
              {!s.done && <span style={{ display: "block", fontSize: 11.5, color: "var(--accent)" }}>{s.cta}</span>}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function StatTile({ kicker, value, icon, accent, delta, sub }: {
  kicker: string; value: string | number; icon: IconName; accent?: boolean; delta?: string; sub?: string;
}) {
  return (
    <div className="glass anim-fadeup" style={{ padding: 18, borderRadius: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span className="kicker">{kicker}</span>
        <span style={{ marginLeft: "auto", color: accent ? "var(--accent)" : "var(--ink-4)" }}><Icon name={icon} size={16} /></span>
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="mono tnum" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1, color: accent ? "var(--accent)" : "var(--ink)" }}>{value}</span>
        {delta && <span className="mono" style={{ fontSize: 12, color: delta.startsWith("+") ? "var(--st-done)" : "var(--ink-4)" }}>{delta}</span>}
      </div>
      {sub && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{sub}</span>}
    </div>
  );
}

export function HomeView({ tasks, projects, userName, onOpen, setRoute, openFocus, onNewProject, onNewTask, onAutoPrioritize, aiBusy, calendarConnected, hasTeam }: {
  tasks: Task[]; projects: Project[]; userName?: string; onOpen: (id: string) => void; setRoute: (r: Route) => void; openFocus: () => void; onNewProject: () => void; onNewTask: () => void; onAutoPrioritize: () => void; aiBusy?: boolean; calendarConnected?: boolean; hasTeam?: boolean;
}) {
  const open = tasks.filter((t) => t.status !== "done");
  const counts = {
    todo: tasks.filter((t) => t.status === "todo").length,
    progress: tasks.filter((t) => t.status === "progress").length,
    review: tasks.filter((t) => t.status === "review").length,
    blocked: tasks.filter((t) => t.status === "blocked").length,
    done: tasks.filter((t) => t.status === "done").length,
  };
  const today = open.filter((t) => dueState(t.dueDate, t.status) === "today" || dueState(t.dueDate, t.status) === "overdue")
    .sort((a, b) => b.aiScore - a.aiScore);

  // real "this week" metrics from completedAt
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(todayMid); d.setDate(d.getDate() - (6 - i)); return d; });
  const weekData = last7.map((d) => { const iso = toLocalISO(d); return tasks.filter((t) => t.completedAt === iso).length; });
  const doneThisWeek = weekData.reduce((a, b) => a + b, 0);
  const completionRate = tasks.length ? Math.round((counts.done / tasks.length) * 100) : 0;
  const inProgressProjects = new Set(tasks.filter((t) => t.status === "progress").map((t) => t.projectId)).size;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = userName?.trim().split(/\s+/)[0] || "there";
  const dateLabel = `${KANBO_TODAY.toLocaleDateString(undefined, { weekday: "short" })} · ${KANBO_TODAY.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;

  if (tasks.length === 0) {
    const starters: { icon: IconName; title: string; body: string; onClick: () => void; primary?: boolean }[] = [
      { icon: "plus", title: "Add your first task", body: "Capture something on your plate — Kanbo sorts out the rest.", onClick: onNewTask, primary: true },
      { icon: "calendarPlus", title: "Plan your day", body: "Auto-plan lays your tasks around your meetings.", onClick: () => setRoute({ view: "plan" }) },
      { icon: "layers", title: "Create a project", body: "Group related work and track progress in one place.", onClick: onNewProject },
      { icon: "clock", title: "Start a focus block", body: "Put the timer on and do one thing properly.", onClick: openFocus },
    ];
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", display: "grid", placeItems: "center" }}>
        <div className="anim-fadeup" style={{ width: "100%", maxWidth: 720, textAlign: "center" }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--accent-dim)", color: "var(--accent)", marginBottom: 16 }}><Icon name="sparkles" size={24} /></div>
          <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em", marginBottom: 8 }}>Welcome to Kanbo{firstName !== "there" ? `, ${firstName}` : ""} 👋</h2>
          <p style={{ fontSize: 15, lineHeight: 1.55, color: "var(--ink-3)", margin: "0 auto 28px", maxWidth: 460 }}>
            Your workspace is a clean slate. Pick a starting point — or just type a task in the capture bar up top.
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, textAlign: "left" }}>
            {starters.map((s) => (
              <button key={s.title} onClick={s.onClick} className="glass lift" style={{
                display: "flex", alignItems: "flex-start", gap: 13, padding: 18, borderRadius: 16, cursor: "pointer", textAlign: "left",
                border: s.primary ? "1px solid color-mix(in oklch, var(--accent) 45%, transparent)" : "1px solid var(--hairline)",
                boxShadow: s.primary ? "0 0 0 1px color-mix(in oklch, var(--accent) 30%, transparent), 0 12px 30px -14px var(--accent-glow)" : undefined,
              }}>
                <span style={{ display: "grid", placeItems: "center", width: 38, height: 38, borderRadius: 11, flexShrink: 0, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name={s.icon} size={18} /></span>
                <span>
                  <span style={{ display: "block", fontSize: 14.5, fontWeight: 600, marginBottom: 3 }}>{s.title}</span>
                  <span style={{ display: "block", fontSize: 12.5, lineHeight: 1.5, color: "var(--ink-4)" }}>{s.body}</span>
                </span>
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12.5, color: "var(--ink-4)", marginTop: 22 }}>
            Tip: try typing <span className="mono" style={{ color: "var(--ink-3)" }}>“Draft deck 90m deep work today”</span> in the bar at the top.
          </p>
        </div>
      </div>
    );
  }

  const gsSteps = [
    { label: "Add your first task", done: tasks.length > 0, action: onNewTask, cta: "Capture one" },
    { label: "Plan your day", done: tasks.some((t) => t.scheduled != null || t.planToday), action: () => setRoute({ view: "plan" }), cta: "Open Plan my day" },
    { label: "Connect your calendar", done: !!calendarConnected, action: () => setRoute({ view: "calendar" }), cta: "Connect Google" },
    { label: "Invite your team", done: !!hasTeam, action: () => setRoute({ view: "team" }), cta: "Create a workspace" },
  ];
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px" }}>
      <GettingStarted steps={gsSteps} />
      {/* AI daily brief */}
      <div className="glass anim-fadeup" style={{ padding: 22, borderRadius: 18, marginBottom: 22, overflow: "hidden", position: "relative" }}>
        <div style={{ position: "absolute", top: -40, right: -20, width: 220, height: 220, background: "radial-gradient(circle, var(--accent-glow), transparent 70%)", opacity: 0.5, pointerEvents: "none" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 14 }}>
          <span style={{ display: "grid", placeItems: "center", width: 28, height: 28, borderRadius: 9, background: "var(--accent-dim)", color: "var(--accent)" }}><Icon name="sparkles" size={16} /></span>
          <span className="kicker" style={{ color: "var(--accent)" }}>Kanbo · Daily brief</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>{dateLabel}</span>
        </div>
        <p style={{ margin: "0 0 18px", fontSize: 19, lineHeight: 1.5, letterSpacing: "-0.01em", maxWidth: 720 }}>
          {greeting}, {firstName}. {today.length > 0
            ? <>You have <strong>{today.length} {today.length === 1 ? "task" : "tasks"}</strong> due today</>
            : <>Nothing's due today</>}
          {counts.progress > 0 && <>, <strong>{counts.progress}</strong> in progress</>}
          {counts.blocked > 0
            ? <>, and <strong style={{ color: "var(--st-blocked)" }}>{counts.blocked} blocked</strong>.</>
            : <>.</>}
          {" "}{today.length > 0
            ? "Start with the highest-priority items below."
            : "A good moment to plan ahead or clear your backlog."}
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn btn-accent" onClick={onAutoPrioritize} disabled={aiBusy} style={{ opacity: aiBusy ? 0.6 : 1 }}><Icon name="sparkles" size={15} /> {aiBusy ? "Prioritizing…" : "Auto-prioritize my day"}</button>
          <button className="btn btn-ghost" onClick={openFocus}><Icon name="play" size={14} fill="currentColor" /> Start focus block</button>
          <button className="btn btn-ghost" onClick={() => setRoute({ view: "tasks" })}>Review all tasks <Icon name="arrowRight" size={14} /></button>
        </div>
      </div>

      {/* stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 14, marginBottom: 26 }}>
        <StatTile kicker="Due today" value={today.length} icon="clock" accent sub={today.length > 0 ? "Sorted by priority" : "Nothing due today"} />
        <StatTile kicker="In progress" value={counts.progress} icon="refresh" sub={counts.progress > 0 ? `Across ${inProgressProjects} project${inProgressProjects === 1 ? "" : "s"}` : "Nothing in progress"} />
        <StatTile kicker="Blocked" value={counts.blocked} icon="lock" sub={counts.blocked > 0 ? "Waiting on a dependency" : "Nothing blocked"} />
        <StatTile kicker="Done this week" value={doneThisWeek} icon="check" sub="Completed in last 7 days" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginBottom: 26 }}>
        {/* focus queue */}
        <div className="glass anim-fadeup" style={{ padding: 4, borderRadius: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "15px 16px 12px" }}>
            <Icon name="zap" size={16} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 14.5, fontWeight: 600 }}>Today's focus queue</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>AI ORDER</span>
          </div>
          <div>
            {today.length === 0 && (
              <div style={{ padding: "20px 16px", borderTop: "1px solid var(--hairline)", fontSize: 13, color: "var(--ink-4)" }}>
                Nothing due today — you're clear. Plan ahead or pull from your backlog.
              </div>
            )}
            {today.slice(0, 4).map((t, i) => {
              const proj = getProject(t.projectId);
              return (
                <button key={t.id} onClick={() => onOpen(t.id)} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", padding: "11px 16px", border: "none", borderTop: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", textAlign: "left" }}>
                  <span className="mono tnum" style={{ fontSize: 13, color: "var(--ink-4)", width: 16 }}>{i + 1}</span>
                  <StatusDot status={t.status} size={8} />
                  <span style={{ flex: 1, fontSize: 13.5, color: "var(--ink)" }} className="truncate">{t.title}</span>
                  {proj && <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />}
                  <AiScore score={t.aiScore} reason={t.aiReason} />
                  <Avatar id={t.assigneeId} size={22} />
                </button>
              );
            })}
          </div>
        </div>

        {/* this week — completions */}
        <div className="glass anim-fadeup" style={{ padding: 18, borderRadius: 16, display: "flex", flexDirection: "column" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 4 }}>
            <span className="kicker">This week</span>
            <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-4)" }}>COMPLETED</span>
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 2 }}>
            <span className="mono tnum" style={{ fontSize: 38, fontWeight: 600, color: "var(--accent)" }}>{doneThisWeek}</span>
            <span style={{ fontSize: 13, color: "var(--ink-4)" }}>task{doneThisWeek === 1 ? "" : "s"} done</span>
          </div>
          <Sparkline data={weekData} h={64} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
            {last7.map((d, i) => <span key={i} className="kicker" style={{ fontSize: 9.5 }}>{d.toLocaleDateString(undefined, { weekday: "narrow" })}</span>)}
          </div>
          <div className="divider" style={{ margin: "14px 0 12px" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Icon name="target" size={15} style={{ color: "var(--accent)" }} />
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{completionRate}% completion rate</span>
            <button className="btn btn-ghost" style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 12 }} onClick={() => setRoute({ view: "analytics" })}>Details</button>
          </div>
        </div>
      </div>

      {/* projects */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, fontWeight: 600 }}>Active projects</h2>
        <button onClick={onNewProject} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "6px 11px", fontSize: 12.5 }}><Icon name="plus" size={14} /> New project</button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 14 }}>
        {projects.filter((p) => p.workspaceId !== null || p.id === "p-personal").slice(0, 6).map((p) => {
          const ptasks = tasks.filter((t) => t.projectId === p.id);
          const prog = projectProgress(tasks, p.id);
          return (
            <button key={p.id} onClick={() => setRoute({ view: "project", projectId: p.id })} className="glass anim-fadeup clickable lift" style={{ padding: 16, borderRadius: 16, textAlign: "left" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 11, marginBottom: 16 }}>
                <span style={{ width: 38, height: 38, borderRadius: 11, display: "grid", placeItems: "center", fontSize: 19, background: `color-mix(in oklch, ${p.color} 18%, transparent)`, border: `1px solid color-mix(in oklch, ${p.color} 32%, transparent)` }}>{p.emoji}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 14.5, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-4)" }}>{ptasks.length} tasks</div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11.5, color: "var(--ink-4)", marginBottom: 7 }}>
                <span className="kicker">Progress</span><span className="mono tnum" style={{ color: prog > 0 ? "var(--accent)" : "var(--ink-4)" }}>{prog}%</span>
              </div>
              <div style={{ height: 6, borderRadius: 99, background: "var(--surface-2)", overflow: "hidden" }}>
                <div style={{ width: prog + "%", height: "100%", borderRadius: 99, background: p.color, boxShadow: prog > 0 ? `0 0 10px color-mix(in oklch, ${p.color} 70%, transparent)` : "none", transition: "width .9s var(--ease)" }} />
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
