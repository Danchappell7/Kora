/* ============================================================
   KANBO — Reporting 2.0: trends over time.
   Where Analytics shows the current snapshot, Reports shows movement —
   weekly throughput, a created-vs-completed burnup, cycle time, the age
   of open work, and a per-project comparison. Every number is derived
   from real task data (created/completed dates); nothing is mocked.
   ============================================================ */
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Icon } from "../primitives";
import { LineChart, GroupedBars } from "../charts";
import { StatTile } from "./HomeView";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { KANBO_TODAY, toLocalISO, getProject, getMember } from "../../data/data";
import type { Task } from "../../data/types";

const DAY = 86400000;
const startOfWeek = (d: Date) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - x.getDay()); return x; };
const daysBetween = (a: string, b: string) => Math.max(0, Math.round((new Date(b.slice(0, 10) + "T00:00:00").getTime() - new Date(a.slice(0, 10) + "T00:00:00").getTime()) / DAY));
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function ReportsView({ tasks, projects, members = [] }: {
  tasks: Task[];
  projects: { id: string; name: string }[];
  members?: { id: string; name: string }[];
}) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [weeks, setWeeks] = useState<number>(8);
  const [projectId, setProjectId] = useState<string>("all");
  const [assignee, setAssignee] = useState<string>("all");

  // scope the whole report by project + assignee
  const scoped = useMemo(() => tasks.filter((t) => {
    if (t.archivedAt) return false;
    if (projectId !== "all" && t.projectId !== projectId) return false;
    if (assignee !== "all" && t.assigneeId !== assignee && !(t.collaborators ?? []).includes(assignee)) return false;
    return true;
  }), [tasks, projectId, assignee]);

  // weekly buckets (oldest → newest), aligned to week start
  const wkStarts = useMemo(() => {
    const thisWk = startOfWeek(KANBO_TODAY);
    return Array.from({ length: weeks }, (_, i) => { const d = new Date(thisWk); d.setDate(d.getDate() - (weeks - 1 - i) * 7); return d; });
  }, [weeks]);
  const windowStart = wkStarts[0];

  const report = useMemo(() => {
    const labels = wkStarts.map((d) => d.toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    const created = new Array(weeks).fill(0);
    const completed = new Array(weeks).fill(0);
    const bucketOf = (iso: string) => {
      const t = new Date(iso.slice(0, 10) + "T00:00:00").getTime();
      for (let i = weeks - 1; i >= 0; i--) if (t >= wkStarts[i].getTime()) return i;
      return -1;
    };
    scoped.forEach((t) => {
      if (t.createdAt) { const b = bucketOf(t.createdAt); if (b >= 0) created[b]++; }
      if (t.status === "done" && t.completedAt) { const b = bucketOf(t.completedAt); if (b >= 0) completed[b]++; }
    });
    // cumulative burnup over the window
    let cc = 0, cd = 0;
    const cumCreated = created.map((v) => (cc += v));
    const cumCompleted = completed.map((v) => (cd += v));

    // cycle time (created → completed) for tasks completed within the window
    const cycles = scoped
      .filter((t) => t.status === "done" && t.completedAt && t.createdAt && new Date(t.completedAt) >= windowStart)
      .map((t) => daysBetween(t.createdAt!, t.completedAt!));
    const avgCycle = cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 10) / 10 : null;
    const medCycle = cycles.length ? median(cycles) : null;

    // on-time rate within the window
    const doneDue = scoped.filter((t) => t.status === "done" && t.completedAt && t.dueDate && new Date(t.completedAt) >= windowStart);
    const onTime = doneDue.filter((t) => t.completedAt!.slice(0, 10) <= t.dueDate!).length;
    const onTimePct = doneDue.length ? Math.round((onTime / doneDue.length) * 100) : null;

    // velocity: avg completed/week + trend (last half vs first half)
    const totalDone = completed.reduce((a, b) => a + b, 0);
    const velocity = Math.round((totalDone / weeks) * 10) / 10;
    const half = Math.floor(weeks / 2);
    const firstHalf = completed.slice(0, half).reduce((a, b) => a + b, 0) / Math.max(half, 1);
    const lastHalf = completed.slice(weeks - half).reduce((a, b) => a + b, 0) / Math.max(half, 1);
    const trend = lastHalf - firstHalf;

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

    return { labels, created, completed, cumCreated, cumCompleted, avgCycle, medCycle, onTimePct, velocity, trend, totalDone, totalCreated: created.reduce((a, b) => a + b, 0), ageBuckets, oldestOpen, ageOf, openCount: open.length };
  }, [scoped, wkStarts, weeks, windowStart]);

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
      return { pid, name: getProject(pid)?.name ?? "—", total: ts.length, done, open: ts.length - done, overdue, completion: ts.length ? Math.round((done / ts.length) * 100) : 0, avgCycle: cyc.length ? Math.round((cyc.reduce((a, b) => a + b, 0) / cyc.length) * 10) / 10 : null };
    }).sort((a, b) => b.total - a.total).slice(0, 12);
  }, [tasks, assignee]);

  const selStyle: CSSProperties = { height: 32, padding: "0 10px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" };
  const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) =>
    <div className="glass anim-fadeup" style={{ padding: 20, borderRadius: 16, ...style }}>{children}</div>;

  const exportCsv = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = [["Week starting", "Created", "Completed", "Cumulative created", "Cumulative completed"]];
    report.labels.forEach((lb, i) => rows.push([lb, String(report.created[i]), String(report.completed[i]), String(report.cumCreated[i]), String(report.cumCompleted[i])]));
    const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `kanbo-report-${toLocalISO(KANBO_TODAY)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const exportPdf = () => {
    const w = window.open("", "_blank"); if (!w) return;
    const scopeLabel = `${projectId === "all" ? "All projects" : getProject(projectId)?.name ?? ""}${assignee === "all" ? "" : " · " + (getMember(assignee)?.name ?? "")} · last ${weeks} weeks`;
    const trendRow = report.labels.map((lb, i) => `<tr><td>${lb}</td><td>${report.created[i]}</td><td>${report.completed[i]}</td></tr>`).join("");
    const projRows = projComparison.map((p) => `<tr><td>${p.name}</td><td>${p.total}</td><td>${p.done}</td><td>${p.open}</td><td>${p.overdue}</td><td>${p.completion}%</td><td>${p.avgCycle == null ? "—" : p.avgCycle + "d"}</td></tr>`).join("");
    w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Kanbo report</title><style>body{font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a;padding:32px;max-width:880px;margin:0 auto}h1{font-size:22px;margin:0 0 2px}.sub{color:#666;font-size:13px;margin:0 0 20px}h2{font-size:15px;margin:24px 0 8px}.kpis{display:flex;gap:24px;flex-wrap:wrap;margin:8px 0 4px}.kpi b{display:block;font-size:22px}.kpi span{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:.05em}table{width:100%;border-collapse:collapse;font-size:12.5px;margin-top:6px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}th{color:#888;font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.04em}@media print{.noprint{display:none}}</style></head><body>
      <h1>Kanbo — activity report</h1><p class="sub">${scopeLabel} · generated ${new Date().toLocaleDateString()}</p>
      <div class="kpis">
        <div class="kpi"><span>Velocity</span><b>${report.velocity}/wk</b></div>
        <div class="kpi"><span>Completed</span><b>${report.totalDone}</b></div>
        <div class="kpi"><span>Created</span><b>${report.totalCreated}</b></div>
        <div class="kpi"><span>Avg cycle</span><b>${report.avgCycle == null ? "—" : report.avgCycle + "d"}</b></div>
        <div class="kpi"><span>On-time</span><b>${report.onTimePct == null ? "—" : report.onTimePct + "%"}</b></div>
      </div>
      <h2>Weekly throughput</h2><table><thead><tr><th>Week starting</th><th>Created</th><th>Completed</th></tr></thead><tbody>${trendRow}</tbody></table>
      <h2>By project</h2><table><thead><tr><th>Project</th><th>Total</th><th>Done</th><th>Open</th><th>Overdue</th><th>Completion</th><th>Avg cycle</th></tr></thead><tbody>${projRows}</tbody></table>
      <p class="noprint" style="margin-top:24px;color:#888;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };

  if (tasks.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="trendingUp" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>No report yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Create and complete tasks over a few weeks and your throughput, velocity, and cycle-time trends will appear here.</p>
        </div>
      </div>
    );
  }

  const trendArrow = report.trend > 0.2 ? { c: "var(--st-done)", s: "↑" } : report.trend < -0.2 ? { c: "var(--prio-urgent)", s: "↓" } : { c: "var(--ink-4)", s: "→" };
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
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(5,1fr)", gap: isMobile ? 10 : 14, marginBottom: 16 }}>
        <StatTile kicker="Velocity" value={`${report.velocity}/wk`} icon="zap" accent sub={`${trendArrow.s} vs earlier`} />
        <StatTile kicker="Completed" value={report.totalDone} icon="check" sub={`last ${weeks} wks`} />
        <StatTile kicker="Created" value={report.totalCreated} icon="plus" sub={`last ${weeks} wks`} />
        <StatTile kicker="Avg cycle time" value={report.avgCycle == null ? "—" : `${report.avgCycle}d`} icon="clock" accent sub={report.medCycle == null ? "created → done" : `median ${report.medCycle}d`} />
        <StatTile kicker="On-time rate" value={report.onTimePct == null ? "—" : `${report.onTimePct}%`} icon="target" sub="by due date" />
      </div>

      {/* throughput + burnup */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 16 }}>Weekly throughput</h3>
          <GroupedBars groups={report.labels} series={[
            { label: "Created", color: "color-mix(in oklch, var(--accent) 55%, transparent)", values: report.created },
            { label: "Completed", color: "var(--st-done)", values: report.completed },
          ]} />
        </Card>
        <Card>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 16 }}>Cumulative burnup</h3>
          <LineChart labels={report.labels} series={[
            { label: "Created", color: "var(--accent)", values: report.cumCreated },
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
                <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ width: `${(b.n / maxAge) * 100}%`, height: "100%", borderRadius: 6, background: b.lo >= 28 ? "var(--prio-urgent)" : b.lo >= 14 ? "#f0a93b" : "var(--accent)", minWidth: b.n ? 4 : 0, transition: "width .6s var(--ease)" }} />
                </div>
                <span className="mono tnum" style={{ width: 30, textAlign: "right", fontSize: 12.5, color: "var(--ink-3)", flexShrink: 0 }}>{b.n}</span>
              </div>
            ))}
            {report.oldestOpen.length > 0 && (
              <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 6 }}>
                <div className="kicker" style={{ marginBottom: 2 }}>Oldest open</div>
                {report.oldestOpen.map((t) => (
                  <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                    <span className="truncate" style={{ flex: 1, color: "var(--ink-2)" }}>{t.title}</span>
                    <span className="mono" style={{ color: "var(--ink-4)" }}>{getProject(t.projectId)?.name ?? ""}</span>
                    <span className="mono" style={{ width: 56, textAlign: "right", color: report.ageOf(t) >= 28 ? "var(--prio-urgent)" : "var(--ink-3)" }}>{report.ageOf(t)}d old</span>
                  </div>
                ))}
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
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-4)" }}>completion · cycle time · overdue</span>
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
                    <td className="truncate" style={{ padding: "7px 10px", color: "var(--ink)", maxWidth: 180, borderBottom: "1px solid var(--hairline)" }}>{p.name}</td>
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
