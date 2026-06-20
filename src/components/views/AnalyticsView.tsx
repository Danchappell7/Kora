/* ============================================================
   KANBO — Analytics dashboard (data-driven, no placeholder claims)
   ============================================================ */
import { useState, type ReactNode, type CSSProperties } from "react";
import { Icon, StatusDot, PriorityFlag } from "../primitives";
import { Bars, Ring, type BarDatum } from "../charts";
import { StatTile } from "./HomeView";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, toLocalISO, getProject, getMember } from "../../data/data";
import type { Task, Priority, Status, CustomFieldDef } from "../../data/types";

type Dim = "status" | "priority" | "project" | "assignee" | string; // string = custom field id

export function AnalyticsView({ tasks, members = [], customFields = [] }: { tasks: Task[]; members?: { id: string; name: string }[]; customFields?: CustomFieldDef[] }) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [dim, setDim] = useState<Dim>("status");
  const [scope, setScope] = useState<"all" | "open" | "done">("all");
  const [billRate, setBillRate] = useState<number>(() => { try { return Number(localStorage.getItem("kanbo-bill-rate")) || 0; } catch { return 0; } });
  const setRate = (n: number) => { setBillRate(n); try { localStorage.setItem("kanbo-bill-rate", String(n)); } catch { /* private mode */ } };

  // ---- per-member output (team workload) ----
  const memberStats = members.map((m) => {
    const mine = tasks.filter((t) => t.assigneeId === m.id);
    const mdone = mine.filter((t) => t.status === "done").length;
    const mhours = mine.reduce((a, t) => a + (t.loggedHours || 0), 0);
    return { id: m.id, name: m.name, done: mdone, open: mine.length - mdone, hours: mhours, total: mine.length };
  }).sort((a, b) => b.done - a.done || b.total - a.total);
  const maxMemberDone = Math.max(...memberStats.map((s) => s.total), 1);

  // ---- billable hours (logged time by project = client) ----
  const billableTasks = tasks.filter((t) => (t.loggedHours || 0) > 0);
  const billByProject = (() => {
    const map = new Map<string, { hours: number; n: number }>();
    billableTasks.forEach((t) => { const cur = map.get(t.projectId) || { hours: 0, n: 0 }; cur.hours += t.loggedHours || 0; cur.n += 1; map.set(t.projectId, cur); });
    return [...map.entries()].map(([pid, v]) => ({ pid, name: getProject(pid)?.name ?? "—", hours: v.hours, n: v.n })).sort((a, b) => b.hours - a.hours);
  })();
  const billableHours = billableTasks.reduce((a, t) => a + (t.loggedHours || 0), 0);
  const exportBillable = () => {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const head = ["Project", "Task", "Assignee", "Hours"].concat(billRate > 0 ? ["Amount (GBP)"] : []);
    const body = billableTasks
      .sort((a, b) => a.projectId.localeCompare(b.projectId))
      .map((t) => [getProject(t.projectId)?.name ?? "—", t.title, getMember(t.assigneeId)?.name ?? "", (t.loggedHours || 0).toString()].concat(billRate > 0 ? [((t.loggedHours || 0) * billRate).toFixed(2)] : []).map(esc).join(","));
    const totalRow = ["", "", "TOTAL", billableHours.toString()].concat(billRate > 0 ? [(billableHours * billRate).toFixed(2)] : []).map(esc).join(",");
    const csv = [head.map(esc).join(","), ...body, totalRow].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a"); a.href = url; a.download = `kanbo-billable-${toLocalISO(KANBO_TODAY)}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.length - done;
  const completion = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const finishedEarly = tasks.filter((t) => t.status === "done" && t.completedAt && t.dueDate && t.completedAt < t.dueDate).length;
  // on-time completion rate (of done tasks that had a due date)
  const doneWithDue = tasks.filter((t) => t.status === "done" && t.dueDate && t.completedAt);
  const onTimeCount = doneWithDue.filter((t) => t.completedAt!.slice(0, 10) <= t.dueDate!).length;
  const onTimePct = doneWithDue.length ? Math.round((onTimeCount / doneWithDue.length) * 100) : null;
  // focus minutes logged today (from the Pomodoro/Deep-work tracker)
  const focusToday = (() => { try { const v = JSON.parse(localStorage.getItem("kanbo-focus-stat") || "{}"); const d = new Date(); return v && v.date === `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}` ? (v.min as number) : 0; } catch { return 0; } })();
  // estimate vs actual (tasks that have both an estimate and logged time)
  const tracked = tasks.filter((t) => t.effortHours != null && t.loggedHours != null);
  const totalEst = tracked.reduce((a, t) => a + (t.effortHours || 0), 0);
  const totalAct = tracked.reduce((a, t) => a + (t.loggedHours || 0), 0);
  const overruns = [...tracked].map((t) => ({ t, diff: (t.loggedHours || 0) - (t.effortHours || 0) })).filter((x) => x.diff !== 0).sort((a, b) => b.diff - a.diff).slice(0, 5);

  // real completions per day over the last 7 days
  const todayMid = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const last7 = Array.from({ length: 7 }, (_, i) => { const d = new Date(todayMid); d.setDate(d.getDate() - (6 - i)); return d; });
  const weekBars: BarDatum[] = last7.map((d, i) => {
    const iso = toLocalISO(d);
    return { label: d.toLocaleDateString(undefined, { weekday: "short" }), value: tasks.filter((t) => t.completedAt === iso).length, highlight: i === 6 };
  });
  const doneThisWeek = weekBars.reduce((a, b) => a + b.value, 0);

  const statusBreak = STATUS_ORDER.map((s) => ({ s, n: tasks.filter((t) => t.status === s).length }));
  const totalS = statusBreak.reduce((a, b) => a + b.n, 0);
  const priorityBreak = (["urgent", "high", "medium", "low"] as Priority[]).map((p) => ({ p, n: tasks.filter((t) => t.priority === p).length }));

  // configurable breakdown
  const pool = tasks.filter((t) => scope === "all" ? true : scope === "open" ? t.status !== "done" : t.status === "done");
  const dimKey = (t: Task): string => {
    if (dim === "status") return t.status;
    if (dim === "priority") return t.priority;
    if (dim === "project") return t.projectId;
    if (dim === "assignee") return t.assigneeId;
    const v = (t.custom ?? {})[dim];
    return v == null || v === "" ? "—" : String(v);
  };
  const dimLabel = (k: string): string => {
    if (k === "—") return "Empty";
    if (dim === "status") return STATUS_META[k as Status]?.label ?? k;
    if (dim === "priority") return PRIORITY_META[k as Priority]?.label ?? k;
    if (dim === "project") return getProject(k)?.name ?? "—";
    if (dim === "assignee") return getMember(k)?.name ?? "—";
    return k;
  };
  const counts = new Map<string, number>();
  pool.forEach((t) => { const k = dimKey(t); counts.set(k, (counts.get(k) ?? 0) + 1); });
  const breakdown = [...counts.entries()].map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 12);
  const breakdownMax = Math.max(...breakdown.map((b) => b.n), 1);
  const selStyleA: CSSProperties = { height: 30, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12.5, outline: "none" };

  const Card = ({ children, style }: { children: ReactNode; style?: CSSProperties }) =>
    <div className="glass anim-fadeup" style={{ padding: 20, borderRadius: 16, ...style }}>{children}</div>;

  if (tasks.length === 0) {
    return (
      <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 40px", display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", color: "var(--ink-4)", maxWidth: 420 }}>
          <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name="chart" size={24} style={{ color: "var(--ink-4)" }} /></div>
          <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>No analytics yet</p>
          <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>Create and complete a few tasks and your completion rate, throughput, and breakdowns will appear here.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: isMobile ? "16px 14px 32px" : "24px 24px 40px" }}>
      {/* insight — derived from real data */}
      <div className="glass anim-fadeup" style={{ padding: 18, borderRadius: 16, marginBottom: 18, display: "flex", alignItems: "center", gap: 13 }}>
        <span style={{ display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 9, background: "var(--accent-dim)", color: "var(--accent)", flexShrink: 0 }}><Icon name="sparkles" size={17} /></span>
        <p style={{ margin: 0, fontSize: 14.5, lineHeight: 1.5, color: "var(--ink-2)" }}>
          You've completed <strong style={{ color: "var(--ink)" }}>{done}</strong> of <strong style={{ color: "var(--ink)" }}>{tasks.length}</strong> tasks (<strong style={{ color: "var(--accent)" }}>{completion}%</strong>)
          {finishedEarly > 0 && <>, with <strong style={{ color: "var(--st-done)" }}>{finishedEarly}</strong> finished before the due date</>}.
          {" "}{open > 0 ? <><strong>{open}</strong> still open.</> : <>Everything's done — nice work.</>}
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr 1fr" : "repeat(4,1fr)", gap: isMobile ? 10 : 14, marginBottom: 16 }}>
        <StatTile kicker="Completion rate" value={completion + "%"} icon="target" accent sub="of all tasks" />
        <StatTile kicker="Done this week" value={doneThisWeek} icon="check" sub="last 7 days" />
        <StatTile kicker="Finished early" value={finishedEarly} icon="trendingUp" sub="before due date" />
        <StatTile kicker="Open tasks" value={open} icon="clock" accent sub="not yet done" />
        <StatTile kicker="On-time rate" value={onTimePct == null ? "—" : onTimePct + "%"} icon="check" sub="done by due date" />
        <StatTile kicker="Focus today" value={focusToday >= 60 ? `${Math.floor(focusToday / 60)}h ${focusToday % 60}m` : `${focusToday}m`} icon="zap" accent sub="deep-work logged" />
      </div>

      {/* configurable breakdown */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 16 }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Breakdown</h3>
          <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
            <select value={dim} onChange={(e) => setDim(e.target.value)} style={selStyleA} aria-label="Group by">
              <option value="status">By status</option>
              <option value="priority">By priority</option>
              <option value="project">By project</option>
              <option value="assignee">By assignee</option>
              {customFields.filter((f) => f.type === "dropdown" || f.type === "people" || f.type === "text").map((f) => <option key={f.id} value={f.id}>By {f.name}</option>)}
            </select>
            <select value={scope} onChange={(e) => setScope(e.target.value as "all" | "open" | "done")} style={selStyleA} aria-label="Scope">
              <option value="all">All tasks</option>
              <option value="open">Open only</option>
              <option value="done">Completed only</option>
            </select>
          </div>
        </div>
        {breakdown.length === 0 ? (
          <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No tasks in this scope.</p>
        ) : breakdown.map((b) => (
          <div key={b.k} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0" }}>
            <span className="truncate" style={{ width: 130, flexShrink: 0, fontSize: 12.5, color: "var(--ink-2)" }}>{dimLabel(b.k)}</span>
            <div style={{ flex: 1, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
              <div style={{ width: `${(b.n / breakdownMax) * 100}%`, height: "100%", borderRadius: 6, background: "var(--accent)", minWidth: 4, transition: "width .6s var(--ease)" }} />
            </div>
            <span className="mono tnum" style={{ width: 30, textAlign: "right", fontSize: 12.5, color: "var(--ink-3)", flexShrink: 0 }}>{b.n}</span>
          </div>
        ))}
      </Card>

      {tracked.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Estimate vs actual</h3>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-4)" }}>{tracked.length} tracked task{tracked.length === 1 ? "" : "s"}</span>
          </div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: overruns.length ? 18 : 0 }}>
            <div><div className="kicker">Estimated</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{Math.round(totalEst * 10) / 10}h</div></div>
            <div><div className="kicker">Logged</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: totalAct > totalEst ? "var(--prio-urgent)" : "var(--st-done)" }}>{Math.round(totalAct * 10) / 10}h</div></div>
            <div><div className="kicker">Variance</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: totalAct > totalEst ? "var(--prio-urgent)" : "var(--st-done)" }}>{totalAct - totalEst > 0 ? "+" : ""}{Math.round((totalAct - totalEst) * 10) / 10}h</div></div>
          </div>
          {overruns.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="kicker" style={{ marginBottom: 2 }}>Biggest differences</div>
              {overruns.map(({ t, diff }) => (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 12.5 }}>
                  <span className="truncate" style={{ flex: 1, color: "var(--ink-2)" }}>{t.title}</span>
                  <span className="mono" style={{ color: "var(--ink-4)" }}>{t.effortHours}h → {t.loggedHours}h</span>
                  <span className="mono" style={{ width: 52, textAlign: "right", color: diff > 0 ? "var(--prio-urgent)" : "var(--st-done)" }}>{diff > 0 ? "+" : ""}{Math.round(diff * 10) / 10}h</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {/* per-member output (team workload) */}
      {memberStats.length > 1 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16 }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Team output</h3>
            <span style={{ marginLeft: "auto", fontSize: 12.5, color: "var(--ink-4)" }}>{memberStats.length} members · completed / open</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {memberStats.map((s) => (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <span className="truncate" style={{ width: 130, flexShrink: 0, fontSize: 13, color: "var(--ink-2)" }}>{s.name}</span>
                <div style={{ flex: 1, display: "flex", height: 10, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }} title={`${s.done} done · ${s.open} open`}>
                  <div style={{ width: `${(s.done / maxMemberDone) * 100}%`, background: "var(--st-done)", transition: "width .6s var(--ease)" }} />
                  <div style={{ width: `${(s.open / maxMemberDone) * 100}%`, background: "color-mix(in oklch, var(--accent) 55%, transparent)", transition: "width .6s var(--ease)" }} />
                </div>
                <span className="mono tnum" style={{ width: 96, textAlign: "right", flexShrink: 0, fontSize: 12, color: "var(--ink-3)" }}>
                  <span style={{ color: "var(--st-done)" }}>{s.done}</span> / {s.open}{s.hours > 0 ? <span style={{ color: "var(--ink-4)" }}> · {Math.round(s.hours * 10) / 10}h</span> : null}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 14, marginTop: 12, fontSize: 11, color: "var(--ink-4)" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: "var(--st-done)" }} /> Completed</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 9, height: 9, borderRadius: 3, background: "color-mix(in oklch, var(--accent) 55%, transparent)" }} /> Open</span>
            <span>· logged hours where tracked</span>
          </div>
        </Card>
      )}

      {/* billable hours report */}
      {billableTasks.length > 0 && (
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <h3 style={{ fontSize: 14.5, fontWeight: 600 }}>Billable hours</h3>
            <span style={{ fontSize: 12.5, color: "var(--ink-4)" }}>logged time by project</span>
            <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: "var(--ink-4)" }}>
                £/hr
                <input type="number" min={0} value={billRate || ""} onChange={(e) => setRate(Number(e.target.value) || 0)} placeholder="0" aria-label="Hourly rate"
                  style={{ width: 64, height: 30, padding: "0 8px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink)", fontFamily: "var(--font-mono)", fontSize: 12.5, outline: "none" }} />
              </label>
              <button onClick={exportBillable} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}><Icon name="arrowUpRight" size={14} /> Export CSV</button>
            </div>
          </div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 16 }}>
            <div><div className="kicker">Total hours</div><div className="mono" style={{ fontSize: 22, fontWeight: 600, color: "var(--accent)" }}>{Math.round(billableHours * 10) / 10}h</div></div>
            {billRate > 0 && <div><div className="kicker">Amount</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>£{(billableHours * billRate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div></div>}
            <div><div className="kicker">Tasks</div><div className="mono" style={{ fontSize: 22, fontWeight: 600 }}>{billableTasks.length}</div></div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {billByProject.map((r) => (
              <div key={r.pid} style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13 }}>
                <span className="truncate" style={{ flex: 1, color: "var(--ink-2)" }}>{r.name}</span>
                <span className="mono" style={{ color: "var(--ink-4)", fontSize: 12 }}>{r.n} task{r.n === 1 ? "" : "s"}</span>
                <span className="mono tnum" style={{ width: 56, textAlign: "right", color: "var(--ink)" }}>{Math.round(r.hours * 10) / 10}h</span>
                {billRate > 0 && <span className="mono tnum" style={{ width: 80, textAlign: "right", color: "var(--ink-3)" }}>£{(r.hours * billRate).toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>}
              </div>
            ))}
          </div>
        </Card>
      )}

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1.5fr 1fr", gap: 16, marginBottom: 16 }}>
        <Card>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 18 }}>Completed — last 7 days</h3>
          <Bars data={weekBars} h={150} />
        </Card>
        <Card style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, alignSelf: "flex-start", marginBottom: 4 }}>Completion rate</h3>
          <Ring value={completion} size={150} stroke={13} label={completion + "%"} sub={`${done}/${tasks.length}`} />
          <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 8 }}>
            <Icon name="check" size={15} style={{ color: "var(--st-done)" }} />
            <span style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{done} task{done === 1 ? "" : "s"} completed</span>
          </div>
        </Card>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
        {/* status breakdown */}
        <Card>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 16 }}>By status</h3>
          <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", marginBottom: 16, background: "var(--surface-2)" }}>
            {statusBreak.map((b) => b.n > 0 && <div key={b.s} title={STATUS_META[b.s].label} style={{ width: (b.n / totalS * 100) + "%", background: STATUS_META[b.s].color }} />)}
          </div>
          {statusBreak.map((b) => (
            <div key={b.s} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0" }}>
              <StatusDot status={b.s} size={8} />
              <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{STATUS_META[b.s].label}</span>
              <span className="mono tnum" style={{ fontSize: 13, color: "var(--ink-3)" }}>{b.n}</span>
            </div>
          ))}
        </Card>
        {/* priority breakdown */}
        <Card>
          <h3 style={{ fontSize: 14.5, fontWeight: 600, marginBottom: 16 }}>By priority</h3>
          <div style={{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", marginBottom: 16, background: "var(--surface-2)" }}>
            {priorityBreak.map((b) => b.n > 0 && <div key={b.p} title={PRIORITY_META[b.p].label} style={{ width: (b.n / tasks.length * 100) + "%", background: PRIORITY_META[b.p].color }} />)}
          </div>
          {priorityBreak.map((b) => (
            <div key={b.p} style={{ display: "flex", alignItems: "center", gap: 9, padding: "6px 0" }}>
              <PriorityFlag priority={b.p} size={13} />
              <span style={{ flex: 1, fontSize: 13, color: "var(--ink-2)" }}>{PRIORITY_META[b.p].label}</span>
              <span className="mono tnum" style={{ fontSize: 13, color: "var(--ink-3)" }}>{b.n}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}
