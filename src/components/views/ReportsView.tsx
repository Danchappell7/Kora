/* ============================================================
   KANBO — Reporting 2.0: trends over time.
   Where Analytics shows the current snapshot, Reports shows movement —
   weekly throughput, a created-vs-completed burnup, cycle time, the age
   of open work, and a per-project comparison. Every number is derived
   from real task data (created/completed dates); nothing is mocked.
   ============================================================ */
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, EmptyArt } from "../primitives";
import { LineChart, GroupedBars } from "../charts";
import { StatTile } from "./HomeView";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { KANBO_TODAY, toLocalISO, todayISO, getProject, getMember } from "../../data/data";
import type { Task } from "../../data/types";
import { useEntrance } from "../../hooks/useEntrance";
import { daysBetween, downloadCsv, fmtDayMonth, localDay, median, round1, weeklyThroughput } from "./reportingUtils";

/* Module scope on purpose: defined inside the view it was a new component type
   on every render, so every filter change remounted the cards and the charts
   re-animated from zero. */
function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return <div className="glass anim-fadeup" style={{ padding: 20, borderRadius: 16, ...style }}>{children}</div>;
}

export function ReportsView({ tasks, projects, members = [], onOpen }: {
  tasks: Task[];
  projects: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  /** open a task's detail (makes the "Oldest open" rows clickable) */
  onOpen?: (id: string) => void;
}) {
  const entrance = useEntrance();
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [weeks, setWeeks] = useState<number>(8);
  const [projectSel, setProjectId] = useState<string>("all");
  const [assigneeSel, setAssignee] = useState<string>("all");
  // a filter from another workspace (the lists change on a workspace switch)
  // would show "All projects" in the select but zero everywhere — ignore it
  // straight away, and clear it so it doesn't come back later.
  const projectId = projectSel === "all" || projects.some((p) => p.id === projectSel) ? projectSel : "all";
  const assignee = assigneeSel === "all" || members.some((m) => m.id === assigneeSel) ? assigneeSel : "all";
  useEffect(() => { if (projectSel !== projectId) setProjectId(projectId); }, [projectSel, projectId]);
  useEffect(() => { if (assigneeSel !== assignee) setAssignee(assignee); }, [assigneeSel, assignee]);

  // the week buckets, ages and overdue counts read today's date, so the memos
  // below recompute when the day changes (a Reports tab left open overnight)
  const today = todayISO();

  // scope the whole report by project + assignee
  const scoped = useMemo(() => tasks.filter((t) => {
    if (t.archivedAt) return false;
    if (projectId !== "all" && t.projectId !== projectId) return false;
    if (assignee !== "all" && t.assigneeId !== assignee && !(t.collaborators ?? []).includes(assignee)) return false;
    return true;
  }), [tasks, projectId, assignee]);

  const report = useMemo(() => {
    // `weeks` full Monday-start weeks + the current week so far (last bucket).
    // Velocity and trend use full weeks only, so a Monday-morning check doesn't
    // read as the team slowing down.
    const tp = weeklyThroughput(scoped, weeks, KANBO_TODAY);
    const windowStart = tp.weekStarts[0];
    // week-start dates (the last one is this week so far — the card subtitle says so;
    // a longer "This week" label squeezed the other axis labels onto two lines)
    const labels = tp.weekStarts.map((d) => fmtDayMonth(d));
    const inWindow = (iso?: string) => { const d = localDay(iso); return !!d && d >= windowStart; };

    // cycle time (created → completed) for tasks completed within the window
    const cycles = scoped
      .filter((t) => t.status === "done" && t.createdAt && inWindow(t.completedAt))
      .map((t) => daysBetween(t.createdAt!, t.completedAt!));
    const avgCycle = cycles.length ? round1(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;
    const medCycle = cycles.length ? median(cycles) : null;

    // on-time rate within the window
    const doneDue = scoped.filter((t) => t.status === "done" && t.dueDate && inWindow(t.completedAt));
    const onTime = doneDue.filter((t) => t.completedAt!.slice(0, 10) <= t.dueDate!).length;
    const onTimePct = doneDue.length ? Math.round((onTime / doneDue.length) * 100) : null;

    // aging of open tasks (by days since created)
    const open = scoped.filter((t) => t.status !== "done");
    const todayIso = toLocalISO(KANBO_TODAY);
    const ageOf = (t: Task) => t.createdAt ? daysBetween(t.createdAt, todayIso) : 0;
    const ageBuckets = [
      { label: "< 1 wk", lo: 0, hi: 7 },
      { label: "1–2 wks", lo: 7, hi: 14 },
      { label: "2–4 wks", lo: 14, hi: 28 },
      { label: "> 4 wks", lo: 28, hi: Infinity },
    ].map((b) => ({ ...b, n: open.filter((t) => { const a = ageOf(t); return a >= b.lo && a < b.hi; }).length }));
    const oldestOpen = [...open].filter((t) => t.createdAt).sort((a, b) => ageOf(b) - ageOf(a)).slice(0, 5);

    return { ...tp, labels, windowStart, avgCycle, medCycle, onTimePct, ageBuckets, oldestOpen, ageOf, openCount: open.length };
  }, [scoped, weeks, today]);

  // per-project comparison table (respects assignee filter, ignores project filter)
  const projComparison = useMemo(() => {
    const base = tasks.filter((t) => !t.archivedAt && (assignee === "all" || t.assigneeId === assignee || (t.collaborators ?? []).includes(assignee)));
    const byProj = new Map<string, Task[]>();
    base.forEach((t) => { const a = byProj.get(t.projectId) ?? []; a.push(t); byProj.set(t.projectId, a); });
    const todayIso = toLocalISO(KANBO_TODAY);
    return [...byProj.entries()].map(([pid, ts]) => {
      const done = ts.filter((t) => t.status === "done").length;
      const overdue = ts.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < todayIso).length;
      const cyc = ts.filter((t) => t.status === "done" && t.completedAt && t.createdAt).map((t) => daysBetween(t.createdAt!, t.completedAt!));
      return { pid, name: getProject(pid)?.name ?? "—", total: ts.length, done, open: ts.length - done, overdue, completion: ts.length ? Math.round((done / ts.length) * 100) : 0, avgCycle: cyc.length ? round1(cyc.reduce((a, b) => a + b, 0) / cyc.length) : null };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)); // every project — never truncated
  }, [tasks, assignee, today]);

  const selStyle: CSSProperties = { height: 32, padding: "0 10px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" };
  const weekLabel = (i: number) => {
    const d = report.weekStarts[i];
    const iso = toLocalISO(d);
    return i === report.weekStarts.length - 1 ? `${iso} (this week so far)` : iso;
  };
  const exportCsv = () => {
    const rows: unknown[][] = [["Week starting (Mon)", "Created", "Completed", "Cumulative created", "Cumulative completed"]];
    report.weekStarts.forEach((_, i) => rows.push([weekLabel(i), report.created[i], report.completed[i], report.cumCreated[i], report.cumCompleted[i]]));
    downloadCsv(rows, `kanbo-report-${toLocalISO(KANBO_TODAY)}.csv`);
  };
  const exportPdf = () => {
    const w = window.open("", "_blank"); if (!w) return;
    // escape any user-controlled text (project / member names) before it goes
    // into the popup's HTML — names can contain <, >, &, quotes.
    const h = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
    const scopeLabel = `${projectId === "all" ? "All projects" : h(getProject(projectId)?.name ?? "")}${assignee === "all" ? "" : " · " + h(members.find((m) => m.id === assignee)?.name ?? getMember(assignee)?.name ?? "")} · last ${weeks} full weeks + this week`;
    const wk = (i: number) => i === report.weekStarts.length - 1 ? "This week (so far)" : `${fmtDayMonth(report.weekStarts[i])} ${report.weekStarts[i].getFullYear()}`;
    const trendRow = report.weekStarts.map((_, i) => `<tr><td>${h(wk(i))}</td><td>${report.created[i]}</td><td>${report.completed[i]}</td></tr>`).join("");
    const projRows = projComparison.map((p) => `<tr><td>${h(p.name)}</td><td>${p.total}</td><td>${p.done}</td><td>${p.open}</td><td>${p.overdue}</td><td>${p.completion}%</td><td>${p.avgCycle == null ? "—" : p.avgCycle + "d"}</td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Kanbo report</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:880px;margin:0 auto}h1{font-size:22px;margin:0 0 2px}.sub{color:#666;font-size:13px;margin:0 0 20px}h2{font-size:15px;margin:24px 0 8px}.kpis{display:flex;gap:24px;flex-wrap:wrap;margin:8px 0 4px}.kpi b{display:block;font-size:22px}.kpi span{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.05em}table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}@media print{.noprint{display:none}}</style></head><body>
      <h1>Kanbo — activity report</h1><p class="sub">${scopeLabel} · generated ${new Date().toLocaleDateString("en-GB")}</p>
      <div class="kpis">
        <div class="kpi"><span>Velocity (full weeks)</span><b>${report.velocity}/wk</b></div>
        <div class="kpi"><span>Completed</span><b>${report.totalDone}</b></div>
        <div class="kpi"><span>Created</span><b>${report.totalCreated}</b></div>
        <div class="kpi"><span>Avg cycle</span><b>${report.avgCycle == null ? "—" : report.avgCycle + "d"}</b></div>
        <div class="kpi"><span>On-time</span><b>${report.onTimePct == null ? "—" : report.onTimePct + "%"}</b></div>
      </div>
      <h2>Weekly throughput</h2><table><thead><tr><th>Week starting (Mon)</th><th>Created</th><th>Completed</th></tr></thead><tbody>${trendRow}</tbody></table>
      <h2>By project (${projComparison.length})</h2><table><thead><tr><th>Project</th><th>Total</th><th>Done</th><th>Open</th><th>Overdue</th><th>Completion</th><th>Avg cycle</th></tr></thead><tbody>${projRows}</tbody></table>
      <p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };

  if (tasks.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ marginBottom: 14 }}><EmptyArt kind="trendingUp" /></div>
          <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>No report yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Create and complete tasks over a few weeks and your throughput, velocity, and cycle-time trends will appear here.</p>
        </div>
      </div>
    );
  }

  const trendSub = report.trend > 0.2 ? `↑ ${report.trend}/wk vs earlier` : report.trend < -0.2 ? `↓ ${Math.abs(report.trend)}/wk vs earlier` : "→ steady vs earlier";
  const sinceLabel = `since ${fmtDayMonth(report.windowStart)}`;
  const maxAge = Math.max(...report.ageBuckets.map((b) => b.n), 1);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 14px 32px" : "24px 24px 40px" }}>
      {/* filter bar */}
      <div className="glass anim-fadeup" style={{ padding: 14, borderRadius: 14, marginBottom: 16, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Icon name="filter" size={15} style={{ color: "var(--accent)" }} />
        <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} style={selStyle} aria-label="Time window">
          <option value={4}>Last 4 weeks</option>
          <option value={8}>Last 8 weeks</option>
          <option value={12}>Last 12 weeks</option>
        </select>
        <select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={selStyle} aria-label="Project">
          <option value="all">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={selStyle} aria-label="Assignee">
          <option value="all">Everyone</option>
          {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        <div style={{ marginLeft: "auto", display: "flex", gap: 7 }}>
          <button onClick={exportCsv} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> CSV</button>
          <button onClick={exportPdf} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> PDF</button>
        </div>
      </div>

      {/* KPI tiles */}
      <div className={entrance} style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5,1fr)", gap: isMobile ? 10 : 14, marginBottom: 16 }}>
        <StatTile kicker="Velocity" value={`${report.velocity}/wk`} icon="zap" accent sub={trendSub} />
        <StatTile kicker="Completed" value={report.totalDone} icon="check" sub={sinceLabel} />
        <StatTile kicker="Created" value={report.totalCreated} icon="plus" sub={sinceLabel} />
        <StatTile kicker="Avg cycle time" value={report.avgCycle == null ? "—" : `${report.avgCycle}d`} icon="clock" accent sub={report.medCycle == null ? "created → done" : `median ${report.medCycle}d`} />
        <StatTile kicker="On-time rate" value={report.onTimePct == null ? "—" : `${report.onTimePct}%`} icon="target" sub="by due date" />
      </div>

      {/* throughput + burnup */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Weekly throughput</h3>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-4)" }}>weeks start Monday · last bar is this week so far</span>
          </div>
          <GroupedBars groups={report.labels} series={[
            { label: "Created", color: "color-mix(in oklch, var(--accent) 55%, transparent)", values: report.created },
            { label: "Completed", color: "var(--st-done)", values: report.completed },
          ]} />
        </Card>
        <Card>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Cumulative burnup</h3>
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--ink-4)" }}>all-time scope vs done</span>
          </div>
          <LineChart labels={report.labels} series={[
            { label: "Scope (created)", color: "var(--accent)", values: report.cumCreated },
            { label: "Completed", color: "var(--st-done)", values: report.cumCompleted },
          ]} />
        </Card>
      </div>

      {/* aging of open work */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Open work by age</h3>
          <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-4)" }}>{report.openCount} open task{report.openCount === 1 ? "" : "s"}</span>
        </div>
        {report.openCount === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Nothing open in this scope — all caught up.</p>
        ) : (
          <>
            {report.ageBuckets.map((b) => (
              <div key={b.label} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
                <span style={{ width: 76, flexShrink: 0, fontSize: 12.5, color: "var(--ink-2)" }}>{b.label}</span>
                <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--track, var(--surface-2))", overflow: "hidden" }}>
                  <div style={{ width: `${(b.n / maxAge) * 100}%`, height: "100%", borderRadius: 6, background: b.lo >= 28 ? "var(--prio-urgent)" : b.lo >= 14 ? "var(--prio-high)" : "var(--accent)", minWidth: b.n ? 4 : 0, transition: "width .6s var(--ease)" }} />
                </div>
                <span className="mono tnum" style={{ width: 30, textAlign: "right", fontSize: 12.5, color: "var(--ink-3)", flexShrink: 0 }}>{b.n}</span>
              </div>
            ))}
            {report.oldestOpen.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="kicker" style={{ marginBottom: 2 }}>Oldest open</div>
                {report.oldestOpen.map((t) => {
                  const cells = (
                    <>
                      <span className="truncate" style={{ flex: 1, minWidth: 0, color: "var(--ink-2)" }}>{t.title}</span>
                      <span className="mono truncate" style={{ maxWidth: "38%", color: "var(--ink-4)" }}>{getProject(t.projectId)?.name ?? ""}</span>
                      <span className="mono" style={{ width: 60, flexShrink: 0, textAlign: "right", color: report.ageOf(t) >= 28 ? "var(--prio-urgent)" : "var(--ink-3)" }}>{report.ageOf(t)}d old</span>
                    </>
                  );
                  const row: CSSProperties = { display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 };
                  return onOpen ? (
                    <button key={t.id} type="button" onClick={() => onOpen(t.id)} className="lift-row" aria-label={`Open task ${t.title}, ${report.ageOf(t)} days old`}
                      style={{ ...row, width: "calc(100% + 12px)", margin: "0 -6px", padding: "4px 6px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "inherit" }}>
                      {cells}
                    </button>
                  ) : <div key={t.id} style={row}>{cells}</div>;
                })}
              </div>
            )}
          </>
        )}
      </Card>

      {/* per-project comparison */}
      {projComparison.length > 0 && (
        <Card>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>By project</h3>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-4)" }}>{projComparison.length} project{projComparison.length === 1 ? "" : "s"} · completion · cycle time · overdue</span>
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5, minWidth: 520 }}>
              <thead>
                <tr style={{ color: "var(--ink-4)" }}>
                  {["Project", "Total", "Done", "Open", "Overdue", "Completion", "Avg cycle"].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "6px 10px", fontWeight: 600, fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".04em", borderBottom: "1px solid var(--hairline)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {projComparison.map((p) => (
                  <tr key={p.pid}>
                    <td className="truncate" title={p.name} style={{ padding: "7px 10px", color: "var(--ink)", maxWidth: 180, borderBottom: "1px solid var(--hairline)" }}>{p.name}</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: "var(--ink-3)", borderBottom: "1px solid var(--hairline)" }}>{p.total}</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: "var(--st-done)", borderBottom: "1px solid var(--hairline)" }}>{p.done}</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: "var(--ink-3)", borderBottom: "1px solid var(--hairline)" }}>{p.open}</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: p.overdue ? "var(--prio-urgent)" : "var(--ink-4)", borderBottom: "1px solid var(--hairline)" }}>{p.overdue}</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: "var(--ink-2)", borderBottom: "1px solid var(--hairline)" }}>{p.completion}%</td>
                    <td className="mono tnum" style={{ textAlign: "right", padding: "7px 10px", color: "var(--ink-3)", borderBottom: "1px solid var(--hairline)" }}>{p.avgCycle == null ? "—" : p.avgCycle + "d"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
