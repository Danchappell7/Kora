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

export function AnalyticsView({ tasks, customFields = [] }: { tasks: Task[]; customFields?: CustomFieldDef[] }) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const [dim, setDim] = useState<Dim>("status");
  const [scope, setScope] = useState<"all" | "open" | "done">("all");
  const done = tasks.filter((t) => t.status === "done").length;
  const open = tasks.length - done;
  const completion = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
  const finishedEarly = tasks.filter((t) => t.status === "done" && t.completedAt && t.dueDate && t.completedAt < t.dueDate).length;

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
