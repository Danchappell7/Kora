/* ============================================================
   KANBO — Today › Overview (the classic Home dashboard, kept for one
   release behind ⌘K and g h). Its parts now live elsewhere — the brief
   and figures on Today, the focus queue in the rail's Smart order, the
   sparkline on Week — so it keeps its shape and takes the new tokens.
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, AiScore, CountUp, AiMark, Button, KanboLogo, Meter, ProjectDot, SectionLabel, StatusGlyph } from "../primitives";
import { Sparkline } from "../charts";
import { getProject, projectProgress, dueState, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project, IconName } from "../../data/types";
import type { Route } from "../../app-types";
import { dayLong } from "./planCanvas";
import { useMediaQuery } from "../../hooks/useMediaQuery";

const kbdStyle = { fontSize: 11, padding: "1px 6px", borderRadius: "var(--r-xs, 4px)", background: "var(--fill-1, var(--surface-2))", border: "1px solid var(--hairline)", color: "var(--ink-3)" } as const;

/* a card: white work on the tinted frame (no glass) */
const card = { background: "var(--surface)", borderRadius: "var(--r-lg, 12px)", boxShadow: "var(--e1, var(--shadow))" } as const;

/* First-run getting-started checklist — tracks real progress, dismissible. */
function GettingStarted({ steps }: { steps: { label: string; done: boolean; action: () => void; cta: string }[] }) {
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem("kanbo-gs-dismissed") === "1"; } catch { return false; } });
  const doneN = steps.filter((s) => s.done).length;
  if (dismissed || doneN === steps.length) return null;
  const dismiss = () => { try { localStorage.setItem("kanbo-gs-dismissed", "1"); } catch { /* private mode */ } setDismissed(true); };
  return (
    <div className="anim-fadeup" style={{ ...card, padding: "16px 20px", marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>Getting started</span>
        <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-3)" }}>{doneN} of {steps.length}</span>
        <button type="button" className="kibtn" data-size="sm" onClick={dismiss} aria-label="Dismiss getting started" title="Dismiss" style={{ marginLeft: "auto" }}><Icon name="x" size={16} sw={1.75} /></button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 8 }}>
        {steps.map((s) => (
          <button key={s.label} type="button" onClick={s.done ? undefined : s.action} disabled={s.done} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: "var(--r-md, 8px)", border: "1px solid var(--hairline)", background: s.done ? "var(--fill-1, var(--surface-2))" : "var(--surface-raised)", cursor: s.done ? "default" : "pointer", textAlign: "left", font: "inherit", color: "inherit" }}>
            <StatusGlyph status={s.done ? "done" : "todo"} readOnly />
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, textDecoration: s.done ? "line-through" : "none", textDecorationColor: "var(--ink-4)", color: s.done ? "var(--ink-3)" : "var(--ink)" }}>{s.label}</span>
              {!s.done && <span style={{ display: "block", fontSize: 12, color: "var(--accent-text, var(--accent))" }}>{s.cta}</span>}
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
    <div className="anim-fadeup" style={{ ...card, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 8 }}>
      <SectionLabel action={<span style={{ color: accent ? "var(--accent-text, var(--accent))" : "var(--icon-quiet, var(--ink-4))", display: "inline-flex" }}><Icon name={icon} size={16} sw={1.75} /></span>}>{kicker}</SectionLabel>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
        <span className="tnum" style={{ fontFamily: "var(--font-head)", fontSize: 28, lineHeight: "36px", fontWeight: 500, letterSpacing: "-0.02em", color: "var(--ink)" }}><CountUp value={value} /></span>
        {delta && <span className="mono" style={{ fontSize: 12, color: delta.startsWith("+") ? "var(--ok, var(--st-done))" : "var(--ink-3)" }}>{delta}</span>}
      </div>
      {sub && <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{sub}</span>}
    </div>
  );
}

export function HomeView({ tasks, myTasks = tasks, projects, userName, onOpen, setRoute, openFocus, onNewProject, onNewTask, onAutoPrioritize, aiBusy, calendarConnected, hasTeam, canCreateProject = true }: {
  /** everything in the workspace — project cards, the clean-slate check and the "first task" step */
  tasks: Task[];
  /** the viewer's own work (assigned to them or collaborating) — the brief, stat tiles, focus queue and weekly chart.
      Defaults to `tasks`, so a caller that doesn't split them sees the old behaviour. */
  myTasks?: Task[];
  projects: Project[]; userName?: string; onOpen: (id: string) => void; setRoute: (r: Route) => void; openFocus: () => void; onNewProject: () => void; onNewTask: () => void; onAutoPrioritize: () => void; aiBusy?: boolean; calendarConnected?: boolean; hasTeam?: boolean;
  /** false for a guest in this workspace — they can't create projects, so no "New project" / "Create a project" CTA */
  canCreateProject?: boolean;
}) {
  // phones and tablets have no q key to press — point them at a button instead
  const touchOnly = useMediaQuery("(hover: none)");
  // the brief and its widgets are personal: in a team workspace they count only the viewer's work, never every teammate's
  const open = myTasks.filter((t) => t.status !== "done");
  const counts = {
    todo: myTasks.filter((t) => t.status === "todo").length,
    progress: myTasks.filter((t) => t.status === "progress").length,
    review: myTasks.filter((t) => t.status === "review").length,
    blocked: myTasks.filter((t) => t.status === "blocked").length,
    done: myTasks.filter((t) => t.status === "done").length,
  };
  // "due today" means due today; anything past due is counted (and labelled) separately
  const dueToday = open.filter((t) => dueState(t.dueDate, t.status) === "today");
  const overdue = open.filter((t) => dueState(t.dueDate, t.status) === "overdue");
  // the focus queue works through both, highest priority first
  const today = [...dueToday, ...overdue].sort((a, b) => b.aiScore - a.aiScore);
  const overdueIds = new Set(overdue.map((t) => t.id));
  const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

  // real "this week" metrics from completedAt
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(todayMid); d.setDate(d.getDate() - (6 - i)); return d; });
  const weekData = last7.map((d) => { const iso = toLocalISO(d); return myTasks.filter((t) => t.completedAt === iso).length; });
  const doneThisWeek = weekData.reduce((a, b) => a + b, 0);
  const completionRate = myTasks.length ? Math.round((counts.done / myTasks.length) * 100) : 0;
  const inProgressProjects = new Set(myTasks.filter((t) => t.status === "progress").map((t) => t.projectId)).size;

  const hour = new Date().getHours();
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = userName?.trim().split(/\s+/)[0] || "there";
  const dateLabel = dayLong(KANBO_TODAY);

  if (tasks.length === 0) {
    const starters: { icon: IconName; title: string; body: string; onClick: () => void; primary?: boolean }[] = [
      { icon: "plus", title: "Add your first task", body: "Capture something on your plate — Kanbo sorts out the rest.", onClick: onNewTask, primary: true },
      { icon: "calendarPlus", title: "Plan your day", body: "Auto-plan lays your tasks around your meetings.", onClick: () => setRoute({ view: "plan" }) },
      ...(canCreateProject ? [{ icon: "layers" as IconName, title: "Create a project", body: "Group related work and track progress in one place.", onClick: onNewProject }] : []),
      { icon: "clock", title: "Start a focus block", body: "Put the timer on and do one thing properly.", onClick: openFocus },
    ];
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", display: "grid", placeItems: "center" }}>
        <div className="anim-fadeup" style={{ width: "100%", maxWidth: 720, textAlign: "center" }}>
          <div style={{ display: "inline-flex", marginBottom: 20 }}><KanboLogo size={40} /></div>
          <h2 style={{ fontFamily: "var(--font-head)", fontSize: 28, lineHeight: "36px", fontWeight: 500, letterSpacing: "-0.02em", margin: "0 0 8px" }}>Welcome to Kanbo{firstName !== "there" ? `, ${firstName}` : ""}</h2>
          <p style={{ fontSize: 15, lineHeight: "24px", color: "var(--ink-3)", margin: "0 auto 28px", maxWidth: 460 }}>
            {touchOnly
              ? <>Your workspace is a clean slate. Pick a starting point below — <strong style={{ fontWeight: 600, color: "var(--ink-2)" }}>Add your first task</strong> is the quickest way in.</>
              : <>Your workspace is a clean slate. Pick a starting point below, or press <kbd className="mono" style={kbdStyle}>q</kbd> to capture a task.</>}
          </p>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14, textAlign: "left" }}>
            {starters.map((s) => (
              <button key={s.title} type="button" onClick={s.onClick} style={{
                ...card, display: "flex", alignItems: "flex-start", gap: 12, padding: 16, cursor: "pointer", textAlign: "left", border: 0, font: "inherit", color: "inherit",
                boxShadow: s.primary ? "0 0 0 1px var(--accent-line, color-mix(in oklch, var(--accent) 45%, transparent)), var(--e1, var(--shadow))" : card.boxShadow,
              }}>
                <span style={{ display: "grid", placeItems: "center", width: 32, height: 32, borderRadius: "var(--r-md, 8px)", flexShrink: 0, background: "var(--accent-tint, var(--accent-dim))", color: "var(--accent-text, var(--accent))" }}><Icon name={s.icon} size={16} sw={1.75} /></span>
                <span>
                  <span style={{ display: "block", fontSize: 14, fontWeight: 600, marginBottom: 2 }}>{s.title}</span>
                  <span style={{ display: "block", fontSize: 13, lineHeight: "20px", color: "var(--ink-3)" }}>{s.body}</span>
                </span>
              </button>
            ))}
          </div>
          <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 24 }}>
            {touchOnly
              ? <>Tip: write tasks the way you'd say them — try</>
              : <>Tip: press <kbd className="mono" style={kbdStyle}>q</kbd> anywhere to capture — try</>} <span className="mono" style={{ color: "var(--ink-3)" }}>“Pay invoice tomorrow 30m !high”</span>.
          </p>
        </div>
      </div>
    );
  }

  const gsSteps = [
    { label: "Add your first task", done: tasks.length > 0, action: onNewTask, cta: "Capture one" },
    { label: "Plan your day", done: myTasks.some((t) => t.scheduled != null || t.planToday), action: () => setRoute({ view: "plan" }), cta: "Open Plan my day" },
    { label: "Connect your calendar", done: !!calendarConnected, action: () => setRoute({ view: "calendar" }), cta: "Connect Google" },
    { label: "Invite your team", done: !!hasTeam, action: () => setRoute({ view: "team" }), cta: "Create a workspace" },
  ];
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px var(--gutter, 32px) 48px" }}>
      <GettingStarted steps={gsSteps} />
      {/* AI daily brief */}
      <div className="anim-fadeup" style={{ ...card, padding: "20px 24px", marginBottom: 24 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
          <AiMark size={16} />
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)" }}>Kanbo's daily brief</span>
          <span className="mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--ink-3)" }}>{dateLabel}</span>
        </div>
        <p style={{ margin: "0 0 20px", fontFamily: "var(--font-head)", fontSize: 20, lineHeight: "28px", fontWeight: 500, letterSpacing: "-0.012em", maxWidth: 720 }}>
          {greeting}, {firstName}. {dueToday.length > 0
            ? <>You have <strong style={{ fontWeight: 600 }}>{plural(dueToday.length, "task")}</strong> due today</>
            : <>Nothing's due today</>}
          {overdue.length > 0 && <>{dueToday.length > 0 ? " and " : ", but "}<strong style={{ fontWeight: 600, color: "var(--signal, var(--prio-urgent))" }}>{overdue.length} overdue</strong></>}
          {counts.progress > 0 && <>, <strong style={{ fontWeight: 600 }}>{counts.progress}</strong> in progress</>}
          {counts.blocked > 0
            ? <>, and <strong style={{ fontWeight: 600, color: "var(--signal, var(--st-blocked))" }}>{counts.blocked} blocked</strong>.</>
            : <>.</>}
          {" "}{overdue.length > 0 && dueToday.length === 0
            ? `Start by clearing ${overdue.length === 1 ? "the overdue one" : "the overdue ones"}.`
            : today.length > 0
              ? "Start with the highest-priority items below."
              : "A good moment to plan ahead or clear your backlog."}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <Button variant="primary" icon="kanbo" onClick={onAutoPrioritize} loading={aiBusy}>{aiBusy ? "Prioritising…" : "Auto-prioritise my day"}</Button>
          <Button variant="ghost" icon="play" onClick={openFocus}>Start focus block</Button>
          <Button variant="ghost" iconRight="arrowRight" onClick={() => setRoute({ view: "tasks" })}>Review all tasks</Button>
        </div>
      </div>

      {/* stat tiles */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))", gap: 16, marginBottom: 24 }}>
        <StatTile kicker="Due today" value={dueToday.length} icon="clock" accent sub={overdue.length > 0 ? `Plus ${overdue.length} overdue` : dueToday.length > 0 ? "Sorted by priority" : "Nothing due today"} />
        <StatTile kicker="In progress" value={counts.progress} icon="refresh" sub={counts.progress > 0 ? `Across ${inProgressProjects} project${inProgressProjects === 1 ? "" : "s"}` : "Nothing in progress"} />
        <StatTile kicker="Blocked" value={counts.blocked} icon="lock" sub={counts.blocked > 0 ? "Waiting on a dependency" : "Nothing blocked"} />
        <StatTile kicker="Done this week" value={doneThisWeek} icon="check" sub="Completed in last 7 days" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16, marginBottom: 32 }}>
        {/* focus queue */}
        <div className="anim-fadeup" style={{ ...card, padding: 4 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 16px 10px" }}>
            <span style={{ fontSize: 14, fontWeight: 600 }}>Today's focus queue</span>
            <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 500, color: "var(--ink-3)" }}><AiMark size={12} /> Kanbo's order</span>
          </div>
          <div>
            {today.length === 0 && (
              <div style={{ padding: "20px 16px", borderTop: "1px solid var(--hairline)", fontSize: 13, color: "var(--ink-3)" }}>
                Nothing due or overdue — you're clear. Plan ahead or pull from your backlog.
              </div>
            )}
            {today.slice(0, 4).map((t, i) => {
              const proj = getProject(t.projectId);
              return (
                <button key={t.id} type="button" onClick={() => onOpen(t.id)} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 12, width: "100%", minHeight: 44, padding: "0 16px", border: "none", borderTop: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", textAlign: "left", font: "inherit" }}>
                  <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-3)", width: 12 }}>{i + 1}</span>
                  <StatusGlyph status={t.status} size={14} readOnly />
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500, color: "var(--ink)" }} className="truncate">{t.title}</span>
                  {overdueIds.has(t.id) && <span className="mono" style={{ fontSize: 11, fontWeight: 500, color: "var(--signal, var(--prio-urgent))", flexShrink: 0 }}>Overdue</span>}
                  {proj && <ProjectDot color={proj.color} title={proj.name} />}
                  <AiScore score={t.aiScore} reason={t.aiReason} />
                  <Avatar id={t.assigneeId} size={22} />
                </button>
              );
            })}
          </div>
        </div>

        {/* this week — completions */}
        <div className="anim-fadeup" style={{ ...card, padding: "16px 20px", display: "flex", flexDirection: "column" }}>
          <SectionLabel action={<span style={{ fontSize: 12, fontWeight: 500, color: "var(--ink-3)" }}>Completed</span>}>This week</SectionLabel>
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
            <span className="tnum" style={{ fontFamily: "var(--font-head)", fontSize: 28, lineHeight: "36px", fontWeight: 500, letterSpacing: "-0.02em", color: "var(--ink)" }}>{doneThisWeek}</span>
            <span style={{ fontSize: 13, color: "var(--ink-3)" }}>task{doneThisWeek === 1 ? "" : "s"} done</span>
          </div>
          <Sparkline data={weekData} h={56} />
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8 }}>
            {last7.map((d, i) => <span key={i} className="mono" style={{ fontSize: 11, color: "var(--ink-3)" }}>{["S", "M", "T", "W", "T", "F", "S"][d.getDay()]}</span>)}
          </div>
          <div style={{ height: 1, background: "var(--hairline)", margin: "16px 0 12px" }} />
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <Meter value={completionRate} tone="grad" width={64} label="Completion rate" />
            <span style={{ fontSize: 13, color: "var(--ink-2)" }}>{completionRate}% completion rate</span>
            <Button variant="ghost" size="sm" style={{ marginLeft: "auto" }} onClick={() => setRoute({ view: "analytics" })}>Details</Button>
          </div>
        </div>
      </div>

      {/* projects */}
      <div style={{ display: "flex", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, margin: 0 }}>Active projects</h2>
        {canCreateProject && <Button variant="ghost" size="sm" icon="plus" style={{ marginLeft: "auto" }} onClick={onNewProject}>New project</Button>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: 16 }}>
        {projects.filter((p) => p.workspaceId !== null || p.id === "p-personal").slice(0, 6).map((p) => {
          const ptasks = tasks.filter((t) => t.projectId === p.id);
          const prog = projectProgress(tasks, p.id);
          return (
            <button key={p.id} type="button" onClick={() => setRoute({ view: "project", projectId: p.id })} className="anim-fadeup clickable" style={{ ...card, padding: 16, textAlign: "left", border: 0, font: "inherit", color: "inherit", cursor: "pointer" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
                <ProjectDot color={p.color} size={12} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="truncate" style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                  <div style={{ fontSize: 12, color: "var(--ink-3)" }}>{ptasks.length} tasks</div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-3)" }}>Progress</span>
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-2)" }}>{prog}%</span>
              </div>
              <Meter value={prog} tone="grad" height={4} label={`${p.name} progress`} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
