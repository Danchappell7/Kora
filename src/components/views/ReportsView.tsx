/* ============================================================
   KANBO — Insights › Trends (Team › Insights › Trends, /team/insights/trends).
   Where Overview is the snapshot, Trends is movement: the weekly summary
   first (Kanbo's, or built on this device), then throughput, the burn-up,
   cycle time, the age of open work, every project side by side and
   Time & billing. Each card leads with one plain sentence; every number
   is derived from real task data (created/completed dates), nothing mocked.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button, EmptyState, ProjectDot } from "../primitives";
import { BarList, GroupedBars, LineChart } from "../charts";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { KANBO_TODAY, toLocalISO, todayISO, getProject, getMember } from "../../data/data";
import { store } from "../../data/store";
import { loadAppearance } from "../../lib/appearance";
import type { AiOutcome } from "../../lib/askTypes";
import type { Task } from "../../data/types";
import {
  cycleHistogram, daysBetween, downloadCsv, fmtDayMonth, fmtHours, localDay, median, round1, scopeTasks,
  weeklyFacts, weeklySummaryText, weeklyThroughput,
} from "./reportingUtils";
import { InsightsBar, InsightsCard, InsightsStyles, InsightsSummary, useInsightsScope, type InsightsNavProps, type WrittenSummary } from "./InsightsSummary";

const AGE_BUCKETS = [
  { label: "Under 1 week", lo: 0, hi: 7, tone: "ink" as const },
  { label: "1–2 weeks", lo: 7, hi: 14, tone: "ink" as const },
  { label: "2–4 weeks", lo: 14, hi: 28, tone: "warn" as const },
  { label: "Over 4 weeks", lo: 28, hi: Infinity, tone: "signal" as const },
];
const days = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;
const money = (n: number) => `£${n.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));
/** markdown bullets (the summary) as print HTML: every line escaped first */
function summaryHtml(md: string): string {
  const out: string[] = [];
  let list: string[] = [];
  const inline = (s: string) => esc(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  const flush = () => { if (list.length) { out.push(`<ul>${list.join("")}</ul>`); list = []; } };
  md.split("\n").forEach((line) => {
    const b = line.match(/^\s*[-*]\s+(.*)$/);
    if (b) { list.push(`<li>${inline(b[1])}</li>`); return; }
    flush();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  });
  flush();
  return out.join("");
}

export function ReportsView({ tasks, projects, members = [], onOpen, ...nav }: {
  tasks: Task[];
  projects: { id: string; name: string }[];
  members?: { id: string; name: string }[];
  /** open a task's detail (makes the "Oldest open" rows clickable) */
  onOpen?: (id: string) => void;
} & InsightsNavProps) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const { scope, setScope, showScope, filterMine, who } = useInsightsScope(nav);
  const rateId = useId();
  const [weeks, setWeeks] = useState<number>(8);
  const [projectSel, setProjectId] = useState<string>("all");
  const [assigneeSel, setAssignee] = useState<string>("all");
  const [summary, setSummary] = useState<WrittenSummary | null>(null);
  const [includeSummary, setIncludeSummary] = useState(true);
  const [billRate, setBillRate] = useState<number>(() => { try { return Number(localStorage.getItem("kanbo-bill-rate")) || 0; } catch { return 0; } });
  const setRate = (n: number) => { setBillRate(n); try { localStorage.setItem("kanbo-bill-rate", String(n)); } catch { /* private mode */ } };
  // a filter from another workspace (the lists change on a workspace switch)
  // would show "All projects" in the select but zero everywhere — ignore it
  // straight away, and clear it so it doesn't come back later.
  const projectId = projectSel === "all" || projects.some((p) => p.id === projectSel) ? projectSel : "all";
  // Me scope already narrows to you, so the person filter steps aside
  const assignee = filterMine ? "all" : assigneeSel === "all" || members.some((m) => m.id === assigneeSel) ? assigneeSel : "all";
  useEffect(() => { if (projectSel !== projectId) setProjectId(projectId); }, [projectSel, projectId]);
  useEffect(() => { if (!filterMine && assigneeSel !== assignee) setAssignee(assignee); }, [assigneeSel, assignee, filterMine]);

  // the week buckets, ages and overdue counts read today's date, so the memos
  // below recompute when the day changes (a Trends tab left open overnight)
  const today = todayISO();

  const personOf = (t: Task, id: string) => t.assigneeId === id || (t.collaborators ?? []).includes(id);
  // the scope and the filters: Me/Team, then project + person
  const inScope = useMemo(() => (filterMine ? scopeTasks(tasks, "me", nav.currentUserId) : tasks).filter((t) => !t.archivedAt), [tasks, filterMine, nav.currentUserId]);
  const scoped = useMemo(() => inScope.filter((t) => {
    if (projectId !== "all" && t.projectId !== projectId) return false;
    if (assignee !== "all" && !personOf(t, assignee)) return false;
    return true;
  }), [inScope, projectId, assignee]);

  // a written summary belongs to the scope it was written for
  const scopeKey = `${scope}|${projectId}|${assignee}`;
  const lastKey = useRef(scopeKey);
  useEffect(() => { if (lastKey.current !== scopeKey) { lastKey.current = scopeKey; setSummary(null); } }, [scopeKey]);

  const report = useMemo(() => {
    // `weeks` full Monday-start weeks + the current week so far (last bucket).
    // Velocity and trend use full weeks only, so a Monday-morning check doesn't
    // read as the team slowing down.
    const tp = weeklyThroughput(scoped, weeks, KANBO_TODAY);
    const windowStart = tp.weekStarts[0];
    const labels = tp.weekStarts.map((d) => fmtDayMonth(d));
    const titles = tp.weekStarts.map((d, i) => (i === tp.weekStarts.length - 1 ? `This week so far (from ${fmtDayMonth(d)})` : `Week of ${fmtDayMonth(d)}`));
    const inWindow = (iso?: string) => { const d = localDay(iso); return !!d && d >= windowStart; };

    // cycle time (created → completed) for tasks completed within the window
    const cycles = scoped
      .filter((t) => t.status === "done" && t.createdAt && inWindow(t.completedAt))
      .map((t) => daysBetween(t.createdAt!, t.completedAt!));
    const avgCycle = cycles.length ? round1(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;
    const medCycle = cycles.length ? median(cycles) : null;

    // on-time rate within the window (a timestamp is read as the viewer's own day)
    const doneDue = scoped.filter((t) => t.status === "done" && t.dueDate && inWindow(t.completedAt));
    const onTime = doneDue.filter((t) => { const d = localDay(t.completedAt), due = localDay(t.dueDate); return !!d && !!due && d <= due; }).length;
    const onTimePct = doneDue.length ? Math.round((onTime / doneDue.length) * 100) : null;

    // aging of open tasks (by days since created)
    const open = scoped.filter((t) => t.status !== "done");
    const todayIso = toLocalISO(KANBO_TODAY);
    const ageOf = (t: Task) => (t.createdAt ? daysBetween(t.createdAt, todayIso) : 0);
    const ageBuckets = AGE_BUCKETS.map((b) => ({ ...b, n: open.filter((t) => { const a = ageOf(t); return a >= b.lo && a < b.hi; }).length }));
    const oldestOpen = [...open].filter((t) => t.createdAt).sort((a, b) => ageOf(b) - ageOf(a)).slice(0, 5);

    return { ...tp, labels, titles, windowStart, cycles, avgCycle, medCycle, onTimePct, ageBuckets, oldestOpen, ageOf, openCount: open.length };
  }, [scoped, weeks, today]);

  // per-project comparison table (respects the scope and person filter, ignores the project filter)
  const projComparison = useMemo(() => {
    const base = inScope.filter((t) => assignee === "all" || personOf(t, assignee));
    const byProj = new Map<string, Task[]>();
    base.forEach((t) => { const a = byProj.get(t.projectId) ?? []; a.push(t); byProj.set(t.projectId, a); });
    const todayIso = toLocalISO(KANBO_TODAY);
    return [...byProj.entries()].map(([pid, ts]) => {
      const done = ts.filter((t) => t.status === "done").length;
      const overdue = ts.filter((t) => t.status !== "done" && t.dueDate && t.dueDate < todayIso).length;
      const cyc = ts.filter((t) => t.status === "done" && t.completedAt && t.createdAt).map((t) => daysBetween(t.createdAt!, t.completedAt!));
      const p = getProject(pid);
      return { pid, name: p?.name ?? "—", color: p?.color ?? "", total: ts.length, done, open: ts.length - done, overdue, completion: ts.length ? Math.round((done / ts.length) * 100) : 0, avgCycle: cyc.length ? round1(cyc.reduce((a, b) => a + b, 0) / cyc.length) : null };
    }).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)); // every project — never truncated
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inScope, assignee, today]);

  // ---- the weekly summary (the past 7 days of the scoped work) ----
  const wFacts = useMemo(() => weeklyFacts(scoped, KANBO_TODAY), [scoped, today]);
  const projectName = (id: string) => getProject(id)?.name;
  // Without an aiSummary prop, ask Kanbo directly — only when there's a backend
  // and AI is on in Settings; otherwise the summary is written on-device.
  // Either way it's sent the tasks InsightsSummary picks (summaryInput), so
  // "How I got here" can say exactly what Kanbo read.
  const aiAllowed = store.configured && loadAppearance().ai !== false;
  const askStore = async (sent: Task[]): Promise<AiOutcome<string>> => {
    const text = await store.aiSummary(sent, toLocalISO(KANBO_TODAY));
    if (text) return { data: text, source: "ai" };
    const notice = store.aiNotice();
    return { data: null, source: notice && /used today|requests/i.test(notice) ? "limit" : "unavailable", detail: notice ?? undefined };
  };
  const aiSummary = nav.aiSummary ?? (aiAllowed ? askStore : undefined);

  // ---- time & billing (logged time isn't dated, so the window doesn't apply) ----
  const billable = scoped.filter((t) => (t.loggedHours || 0) > 0);
  const billableHours = billable.reduce((a, t) => a + (t.loggedHours || 0), 0);
  const billByProject = (() => {
    const map = new Map<string, { hours: number; n: number }>();
    billable.forEach((t) => { const cur = map.get(t.projectId) || { hours: 0, n: 0 }; cur.hours += t.loggedHours || 0; cur.n += 1; map.set(t.projectId, cur); });
    return [...map.entries()].map(([pid, v]) => ({ pid, name: getProject(pid)?.name ?? "—", color: getProject(pid)?.color ?? "", hours: v.hours, n: v.n })).sort((a, b) => b.hours - a.hours);
  })();
  const personName = (id: string): string => (!id ? "Unassigned" : members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "(former member)");

  const scopeLabel = [
    projectId === "all" ? "All projects" : getProject(projectId)?.name ?? "",
    filterMine ? "Your work" : assignee === "all" ? "" : members.find((m) => m.id === assignee)?.name ?? getMember(assignee)?.name ?? "",
    `last ${weeks} full weeks and this week so far`,
  ].filter(Boolean).join(" · ");

  const exportCsv = () => {
    const rows: unknown[][] = [["Week starting (Mon)", "Created", "Completed", "Cumulative created", "Cumulative completed"]];
    report.weekStarts.forEach((d, i) => rows.push([`${toLocalISO(d)}${i === report.weekStarts.length - 1 ? " (this week so far)" : ""}`, report.created[i], report.completed[i], report.cumCreated[i], report.cumCompleted[i]]));
    downloadCsv(rows, `kanbo-report-${toLocalISO(KANBO_TODAY)}.csv`);
  };
  const exportBillable = () => {
    // csvCell (via downloadCsv) neutralises formula-like titles such as =HYPERLINK(...).
    // Hours keep 2 decimals: enough for quarter-hours on an invoice, no float noise.
    const hrs = (n: number) => String(Math.round(n * 100) / 100);
    const head = ["Project", "Task", "Assignee", "Hours"].concat(billRate > 0 ? ["Amount (GBP)"] : []);
    const body = [...billable]
      .sort((a, b) => (getProject(a.projectId)?.name ?? "").localeCompare(getProject(b.projectId)?.name ?? "") || a.title.localeCompare(b.title))
      .map((t) => [getProject(t.projectId)?.name ?? "—", t.title, personName(t.assigneeId), hrs(t.loggedHours || 0)].concat(billRate > 0 ? [((t.loggedHours || 0) * billRate).toFixed(2)] : []));
    const totalRow = ["", "", "TOTAL", hrs(billableHours)].concat(billRate > 0 ? [(billableHours * billRate).toFixed(2)] : []);
    downloadCsv([head, ...body, totalRow], `kanbo-billable-${toLocalISO(KANBO_TODAY)}.csv`);
  };
  const exportPdf = () => {
    const w = window.open("", "_blank"); if (!w) return;
    // every user-controlled string (project / member names, titles, the summary)
    // is escaped before it goes into the popup's HTML
    const range = `${fmtDayMonth(wFacts.from)} – ${fmtDayMonth(wFacts.to)}`;
    const md = includeSummary ? (summary?.text ?? weeklySummaryText(wFacts, projectName)) : null;
    const summaryBlock = md
      ? `<h2>Weekly summary</h2><p class="note">${summary?.source === "ai" && summary.sent != null ? `Written by Kanbo from ${summary.sent} task${summary.sent === 1 ? "" : "s"} · ${esc(range)}` : `Built from the past 7 days' tasks · ${esc(range)}`}</p>${summaryHtml(md)}`
      : "";
    const wk = (i: number) => i === report.weekStarts.length - 1 ? "This week (so far)" : `${fmtDayMonth(report.weekStarts[i])} ${report.weekStarts[i].getFullYear()}`;
    const trendRow = report.weekStarts.map((_, i) => `<tr><td>${esc(wk(i))}</td><td>${report.created[i]}</td><td>${report.completed[i]}</td></tr>`).join("");
    const projRows = projComparison.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.total}</td><td>${p.done}</td><td>${p.open}</td><td>${p.overdue}</td><td>${p.completion}%</td><td>${p.avgCycle == null ? "—" : p.avgCycle + "d"}</td></tr>`).join("");
    const billRows = billByProject.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.n}</td><td>${esc(fmtHours(r.hours))}</td>${billRate > 0 ? `<td>${esc(money(r.hours * billRate))}</td>` : ""}</tr>`).join("");
    const billBlock = billable.length
      ? `<h2>Time &amp; billing</h2><p class="note">${esc(fmtHours(billableHours))} logged across ${billable.length} task${billable.length === 1 ? "" : "s"}${billRate > 0 ? ` · ${esc(money(billableHours * billRate))} at £${billRate}/hr` : ""}</p><table><thead><tr><th>Project</th><th>Tasks</th><th>Hours</th>${billRate > 0 ? "<th>Amount</th>" : ""}</tr></thead><tbody>${billRows}</tbody></table>`
      : "";
    w.document.write(`<!doctype html><html lang="en-GB"><head><meta charset="utf-8"><title>Kanbo report</title><style>body{font-family:-apple-system,"Segoe UI",system-ui,sans-serif;color:#1b1d26;padding:40px;max-width:880px;margin:0 auto;font-size:13px;line-height:1.5}h1{font-size:22px;margin:0 0 4px;letter-spacing:-.01em}h2{font-size:15px;margin:28px 0 4px}.sub,.note{color:#5d6070;font-size:12px;margin:0 0 12px}ul{margin:4px 0 0;padding-left:20px}li{margin:3px 0}.kpis{display:flex;gap:28px;flex-wrap:wrap;margin:20px 0 4px}.kpi span{display:block;color:#5d6070;font-size:12px}.kpi b{display:block;font-size:18px;font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:7px 8px;border-bottom:1px solid #e6e7ec}th{color:#5d6070;font-weight:600}@media print{.noprint{display:none}body{padding:0}}</style></head><body>
      <h1>Kanbo report</h1><p class="sub">${esc(scopeLabel)} · generated ${esc(new Date().toLocaleDateString("en-GB"))}</p>
      ${summaryBlock}
      <div class="kpis">
        <div class="kpi"><span>Velocity (full weeks)</span><b>${report.velocity}/wk</b></div>
        <div class="kpi"><span>Completed</span><b>${report.totalDone}</b></div>
        <div class="kpi"><span>Created</span><b>${report.totalCreated}</b></div>
        <div class="kpi"><span>Average cycle</span><b>${report.avgCycle == null ? "—" : report.avgCycle + "d"}</b></div>
        <div class="kpi"><span>On time</span><b>${report.onTimePct == null ? "—" : report.onTimePct + "%"}</b></div>
      </div>
      <h2>Weekly throughput</h2><table><thead><tr><th>Week starting (Mon)</th><th>Created</th><th>Completed</th></tr></thead><tbody>${trendRow}</tbody></table>
      <h2>By project (${projComparison.length})</h2><table><thead><tr><th>Project</th><th>Total</th><th>Done</th><th>Open</th><th>Overdue</th><th>Completion</th><th>Avg cycle</th></tr></thead><tbody>${projRows}</tbody></table>
      ${billBlock}
      <p class="noprint" style="margin-top:24px;color:#5d6070;font-size:12px">Use your browser's Print dialog to save as PDF.</p></body></html>`);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 250);
  };

  const bar = (
    <InsightsBar view="trends" onOpenTrends={nav.onOpenTrends} onOpenOverview={nav.onOpenOverview}
      scope={scope} onScope={setScope} showScope={showScope} onAsk={nav.onAsk} compact={isMobile} />
  );

  if (inScope.length === 0) {
    const otherwise = filterMine && tasks.length > 0;
    return (
      <div className="kin">
        <InsightsStyles />
        <div className="kin-page">
          {bar}
          <EmptyState art="trendingUp" size="lg"
            title={otherwise ? "Nothing's assigned to you here yet." : nav.personal ? "Insights appear once you finish a few tasks." : "Insights appear once your team finishes a few tasks."}
            body={otherwise ? "Switch to Team to see how everyone's work is trending." : "Throughput, cycle time and the age of open work build up here week by week."}
            action={otherwise ? <Button variant="secondary" size="sm" onClick={() => setScope("team")}>Show the team</Button> : undefined} />
        </div>
      </div>
    );
  }

  const current = report.weekStarts.length - 1;
  const trend = report.trend > 0.2 ? <>, <b data-tone="ok">{report.trend} a week faster</b> than earlier in the window</>
    : report.trend < -0.2 ? <>, <b data-tone="signal">{Math.abs(report.trend)} a week slower</b> than earlier in the window</>
    : <>, holding steady</>;
  const ageMax = Math.max(...report.ageBuckets.map((b) => b.n), 1);
  const showPerson = !filterMine && members.length > 1;

  return (
    <div className="kin">
      <InsightsStyles />
      <div className="kin-page">
        {bar}

        <div className="kin-filters" role="group" aria-label="Report filters">
          <select className="kin-select" value={weeks} onChange={(e) => setWeeks(Number(e.target.value))} aria-label="Time window">
            <option value={4}>Last 4 weeks</option>
            <option value={8}>Last 8 weeks</option>
            <option value={12}>Last 12 weeks</option>
          </select>
          <select className="kin-select" value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
            <option value="all">All projects</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          {showPerson && (
            <select className="kin-select" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
              <option value="all">Everyone</option>
              {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          )}
          <div className="kin-filters-end">
            <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={exportCsv} aria-label="Export as CSV">CSV</Button>
            <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={exportPdf} aria-label="Export as PDF">PDF</Button>
          </div>
        </div>

        <InsightsSummary facts={wFacts} tasks={scoped} projectName={projectName} value={summary} onValue={setSummary} aiSummary={aiSummary}
          include={includeSummary} onInclude={setIncludeSummary} who={who} resetKey={scopeKey} />

        <div className="kin-grid">
          <InsightsCard title="Throughput" meta="Created and completed per week"
            lead={report.velocity > 0
              ? <>Averaging <b>{report.velocity}</b> completed a week{trend}.</>
              : report.completed[current] > 0
                ? <><b>{report.completed[current]}</b> completed so far this week; nothing in the {weeks} full weeks before.</>
                : <>Nothing was completed in the last {weeks} full weeks.</>}>
            <GroupedBars groups={report.labels} titles={report.titles} current={current} h={168}
              label="Tasks created and completed per week, Monday to Sunday; the last week is this week so far"
              series={[
                { label: "Created", color: "var(--ink-3)", values: report.created },
                { label: "Completed", color: "var(--accent)", values: report.completed, grad: true },
              ]} />
          </InsightsCard>

          <InsightsCard title="Burn-up" meta="All-time scope vs done"
            lead={<>
              {report.totalCreated ? <><b>{report.totalCreated}</b> added</> : "Nothing added"} and {report.totalDone ? <><b>{report.totalDone}</b> finished</> : "nothing finished"} since {fmtDayMonth(report.windowStart)}.
            </>}>
            <LineChart labels={report.labels} titles={report.titles} current={current} h={168}
              label="Cumulative tasks created and completed"
              series={[
                { label: "Scope", color: "var(--ink-3)", values: report.cumCreated },
                { label: "Completed", color: "var(--accent)", values: report.cumCompleted, grad: true },
              ]} />
          </InsightsCard>

          <InsightsCard title="Cycle time" meta="Created → done"
            lead={report.avgCycle == null ? undefined : (
              <>
                Tasks take <b>{days(report.avgCycle)}</b> on average from created to done (median <b>{days(report.medCycle ?? 0)}</b>)
                {report.onTimePct != null ? <>, and <b>{report.onTimePct}%</b> landed on time.</> : "."}
              </>
            )}>
            {report.cycles.length === 0
              ? <p className="kin-empty">Nothing with a creation date finished in this window yet.</p>
              : <BarList label="Finished tasks by cycle time" labelWidth={110}
                  rows={cycleHistogram(report.cycles).map((b) => ({ key: b.label, label: b.label, value: b.n }))} />}
          </InsightsCard>

          <InsightsCard title="Open work by age" meta="Since created"
            lead={report.openCount > 0 ? <><b>{report.openCount}</b> {report.openCount === 1 ? "task is" : "tasks are"} open.</> : undefined}>
            {report.openCount === 0 ? (
              <p className="kin-empty">Nothing open in this view. All caught up.</p>
            ) : (
              <>
                <BarList label="Open tasks by age" labelWidth={110} max={ageMax}
                  rows={report.ageBuckets.map((b) => ({ key: b.label, label: b.label, value: b.n, tone: b.n ? b.tone : "ink" }))} />
                {report.oldestOpen.length > 0 && (
                  <div>
                    <p className="kin-sub">Oldest open</p>
                    {report.oldestOpen.map((t) => {
                      const age = report.ageOf(t);
                      const p = getProject(t.projectId);
                      const cells = (
                        <>
                          <span className="kin-row-title">{t.title}</span>
                          {p && <span className="kin-row-side"><ProjectDot color={p.color} /><span className="kin-mono" style={{ color: "var(--ink-4)" }}>{p.name}</span></span>}
                          <span className="kin-mono" style={{ width: 40, textAlign: "right", color: age >= 28 ? "var(--signal, var(--st-blocked))" : "var(--ink-3)" }}>{age}d</span>
                        </>
                      );
                      return onOpen ? (
                        <button key={t.id} type="button" className="kin-row" onClick={() => onOpen(t.id)} aria-label={`Open task ${t.title}, ${age} days old`}>{cells}</button>
                      ) : <div key={t.id} className="kin-row">{cells}</div>;
                    })}
                  </div>
                )}
              </>
            )}
          </InsightsCard>

          {projComparison.length > 0 && (
            <InsightsCard wide title="By project" meta={`${projComparison.length} project${projComparison.length === 1 ? "" : "s"}`}>
              <div className="kin-table-wrap">
                <table className="kin-table">
                  <thead>
                    <tr>
                      <th scope="col">Project</th>
                      <th scope="col" className="kin-narrow-hide">Total</th>
                      <th scope="col">Done</th>
                      <th scope="col" className="kin-narrow-hide">Open</th>
                      <th scope="col">Overdue</th>
                      <th scope="col">Completion</th>
                      <th scope="col" className="kin-narrow-hide">Avg cycle</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projComparison.map((p) => (
                      <tr key={p.pid}>
                        <td className="kin-td-name" title={p.name}><span><ProjectDot color={p.color} /><span>{p.name}</span></span></td>
                        <td className="kin-narrow-hide">{p.total}</td>
                        <td>{p.done}</td>
                        <td className="kin-narrow-hide">{p.open}</td>
                        <td style={{ color: p.overdue ? "var(--signal, var(--st-blocked))" : "var(--ink-4)" }}>{p.overdue}</td>
                        <td>
                          <span className="kin-td-meter">
                            <span aria-hidden="true" style={{ position: "relative", width: 48, height: 4, borderRadius: 999, background: "var(--track, var(--surface-2))", overflow: "hidden" }}>
                              <span style={{ position: "absolute", inset: 0, width: `${p.completion}%`, borderRadius: 999, background: "var(--grad, linear-gradient(90deg, #5B7CFA 0%, #8B5CF6 52%, #C24BE0 100%))" }} />
                            </span>
                            <span style={{ minWidth: 32, color: "var(--ink-2)" }}>{p.completion}%</span>
                          </span>
                        </td>
                        <td className="kin-narrow-hide">{p.avgCycle == null ? "—" : `${p.avgCycle}d`}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </InsightsCard>
          )}

          <InsightsCard wide title="Time & billing" meta="All logged time"
            actions={(
              <>
                <span className="kin-rate">
                  <label htmlFor={rateId}>Hourly rate</label>
                  <span className="kin-rate-field">
                    <span aria-hidden="true">£</span>
                    <input id={rateId} type="number" min={0} inputMode="decimal" value={billRate || ""} placeholder="0"
                      onChange={(e) => setRate(Number(e.target.value) || 0)} />
                  </span>
                </span>
                <Button variant="ghost" size="sm" icon="arrowUpRight" onClick={exportBillable} disabled={billable.length === 0} aria-label="Export time as CSV">CSV</Button>
              </>
            )}
            lead={billable.length > 0 ? (
              <>
                <b>{fmtHours(billableHours)}</b> logged across <b>{billable.length}</b> task{billable.length === 1 ? "" : "s"}
                {billByProject.length === 1 ? ` in ${billByProject[0].name}` : ""}
                {billRate > 0 ? <>. At £{billRate} an hour, that's <b>{money(billableHours * billRate)}</b>.</> : "."}
              </>
            ) : undefined}>
            {billable.length === 0 ? (
              <p className="kin-empty">No time logged yet. Log time on a task and it lands here, ready to invoice.</p>
            ) : billByProject.length > 1 && (
              <ul style={{ listStyle: "none", margin: 0, padding: 0 }} aria-label="Logged time by project">
                {billByProject.map((r) => (
                  <li key={r.pid} className="kin-row">
                    <ProjectDot color={r.color} />
                    <span className="kin-row-title">{r.name}</span>
                    <span className="kin-mono" style={{ color: "var(--ink-4)" }}>{r.n} task{r.n === 1 ? "" : "s"}</span>
                    <span className="kin-mono" style={{ width: 56, textAlign: "right", color: "var(--ink)" }}>{fmtHours(r.hours)}</span>
                    {billRate > 0 && <span className="kin-mono" style={{ width: 88, textAlign: "right", color: "var(--ink-2)" }}>{money(r.hours * billRate)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </InsightsCard>
        </div>
      </div>
    </div>
  );
}
