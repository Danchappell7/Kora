/* ============================================================
   KANBO — Insights › Overview (Team › Insights, /team/insights).
   One KPI sentence instead of a wall of tiles (every figure stated
   once), then four cards in pairs: Completed (last 7 days), Breakdown,
   Team output (or, for you alone, By project) and Estimate vs actual.
   Every number is derived from real task data; nothing is mocked.
   ============================================================ */
import { useMemo, useState, type ReactNode } from "react";
import { Avatar, Button, EmptyState, PriorityGlyph, ProjectDot, StatusGlyph } from "../primitives";
import { Bars, BarList, StackedBar, shares, type BarDatum, type BarRow } from "../charts";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { focusKeys, todayKey } from "../../hooks/useFocusTimer";
import { STATUS_META, STATUS_ORDER, PRIORITY_META, KANBO_TODAY, todayISO, getProject, getMember } from "../../data/data";
import type { Task, Priority, Status, CustomFieldDef } from "../../data/types";
import { addDays, fmtDay, fmtHours, kpiSentence, localDay, overviewFacts, scopeTasks } from "./reportingUtils";
import { Figures, InsightsBar, InsightsCard, InsightsStyles, useInsightsScope, type InsightsNavProps } from "./InsightsSummary";

type Dim = "status" | "priority" | "project" | "assignee" | string; // string = "cf:<type>:<name>" custom-field group
const BUILTIN_DIMS = ["status", "priority", "project", "assignee"];
const BREAKDOWN_ROWS = 12;
const PEOPLE_ROWS = 10;
const PROJECT_ROWS = 8;
const PRIORITY_ORDER: Priority[] = ["urgent", "high", "medium", "low"];
const statusFill = (s: Status) => `var(--st-${s}-fill, var(--st-${s}))`;

/** A task row that opens the task when the view is given `onOpen`; a plain row otherwise. */
function TaskRow({ task, onOpen, children }: { task: Task; onOpen?: (id: string) => void; children: ReactNode }) {
  if (!onOpen) return <div className="kin-row">{children}</div>;
  return (
    <button type="button" className="kin-row" onClick={() => onOpen(task.id)} aria-label={`Open task ${task.title}`}>
      {children}
    </button>
  );
}

/** Custom fields that can be charted, grouped by name + type so a "Reviewer"
 *  field defined in several projects is one breakdown, not several. */
interface FieldGroup { key: string; name: string; type: CustomFieldDef["type"]; byProject: Map<string, string> }

/** Minutes of focus you've banked today (the focus timer keeps a per-person total). */
function focusMinutesToday(userId?: string): number {
  const keys = [userId ? focusKeys(userId).stat : "", focusKeys().stat, "kanbo-focus-stat"].filter(Boolean);
  for (const k of keys) {
    try {
      const v = JSON.parse(localStorage.getItem(k) || "null");
      if (v && v.date === todayKey() && Number(v.min) > 0) return Number(v.min);
    } catch { /* private mode, or not ours */ }
  }
  return 0;
}

export function AnalyticsView({ tasks, members = [], customFields = [], projects, onOpen, ...nav }: {
  tasks: Task[];
  members?: { id: string; name: string }[];
  customFields?: CustomFieldDef[];
  /** projects in the active workspace — scopes the custom-field list (defaults to the projects the tasks belong to) */
  projects?: { id: string }[];
  /** open a task's detail (makes the "Biggest differences" rows clickable) */
  onOpen?: (id: string) => void;
} & InsightsNavProps) {
  const isMobile = useMediaQuery("(max-width: 860px)");
  const { scope, setScope, showScope, filterMine, who } = useInsightsScope(nav);
  const [dim, setDim] = useState<Dim>("status");
  const [state, setState] = useState<"all" | "open" | "done">("all");
  // the day's buckets read today's date: recompute when it changes (a tab left open overnight)
  const today = todayISO();

  const scoped = useMemo(() => (filterMine ? scopeTasks(tasks, "me", nav.currentUserId) : tasks), [tasks, filterMine, nav.currentUserId]);

  // names for people ids: active members first, then anyone we still know about
  const personName = (id: string): string => {
    if (!id) return "Unassigned";
    return members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "(former member)";
  };

  // ---- the KPI sentence ----
  const facts = useMemo(() => overviewFacts(scoped, KANBO_TODAY), [scoped, today]);
  const kpi = kpiSentence(facts, who, who === "you" ? focusMinutesToday(nav.currentUserId) : 0);

  // ---- completed per day, the last 7 days (today last, in the accent) ----
  const week: BarDatum[] = useMemo(() => {
    const end = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
    const days = Array.from({ length: 7 }, (_, i) => addDays(end, i - 6));
    const counts = days.map(() => 0);
    for (const t of scoped) {
      if (t.status !== "done") continue;
      const d = localDay(t.completedAt);
      if (!d) continue;
      const i = days.findIndex((x) => x.getTime() === d.getTime());
      if (i >= 0) counts[i]++;
    }
    return days.map((d, i) => ({ label: fmtDay(d).slice(0, 3), value: counts[i], highlight: i === 6, title: i === 6 ? `Today, ${fmtDay(d)}` : fmtDay(d) }));
  }, [scoped, today]);

  // ---- configurable breakdown — custom fields only from this workspace's projects ----
  const wsProjectIds = new Set(projects ? projects.map((p) => p.id) : tasks.map((t) => t.projectId));
  const fieldGroups = new Map<string, FieldGroup>();
  customFields
    .filter((f) => wsProjectIds.has(f.projectId) && (f.type === "dropdown" || f.type === "people" || f.type === "text" || f.type === "multiselect"))
    .forEach((f) => {
      const key = `cf:${f.type}:${f.name.trim().toLowerCase()}`;
      const g = fieldGroups.get(key) ?? { key, name: f.name.trim() || "Field", type: f.type, byProject: new Map<string, string>() };
      if (!g.byProject.has(f.projectId)) g.byProject.set(f.projectId, f.id);
      fieldGroups.set(key, g);
    });
  // a remembered choice that no longer exists here (e.g. after a workspace switch) falls back to status
  const activeDim: Dim = BUILTIN_DIMS.includes(dim) || fieldGroups.has(dim) ? dim : "status";
  const group = fieldGroups.get(activeDim);
  const pool = scoped.filter((t) => (state === "all" ? true : state === "open" ? t.status !== "done" : t.status === "done") && (!group || group.byProject.has(t.projectId)));
  const dimKeys = (t: Task): string[] => {
    if (activeDim === "status") return [t.status];
    if (activeDim === "priority") return [t.priority];
    if (activeDim === "project") return [t.projectId];
    if (activeDim === "assignee") return [t.assigneeId || ""];
    const fid = group?.byProject.get(t.projectId);
    const v = fid ? (t.custom ?? {})[fid] : null;
    const vals = (Array.isArray(v) ? v : [v]).filter((x) => x != null && x !== "").map(String);
    return vals.length ? [...new Set(vals)] : ["—"];
  };
  const dimLabel = (k: string): string => {
    if (k === "—") return "Empty";
    if (activeDim === "status") return STATUS_META[k as Status]?.label ?? k;
    if (activeDim === "priority") return PRIORITY_META[k as Priority]?.label ?? k;
    if (activeDim === "project") return getProject(k)?.name ?? "—";
    if (activeDim === "assignee" || group?.type === "people") return personName(k);
    return k;
  };
  const dimLead = (k: string): ReactNode => {
    if (activeDim === "priority" && PRIORITY_META[k as Priority]) return <PriorityGlyph priority={k as Priority} />;
    if (activeDim === "project") return <ProjectDot color={getProject(k)?.color ?? ""} />;
    if ((activeDim === "assignee" || group?.type === "people") && k && getMember(k)) return <Avatar id={k} size={20} />;
    return null;
  };
  const counts = new Map<string, number>();
  pool.forEach((t) => dimKeys(t).forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1)));
  const breakdownAll = [...counts.entries()].map(([k, n]) => ({ k, n }))
    .sort((a, b) => activeDim === "priority"
      ? PRIORITY_ORDER.indexOf(a.k as Priority) - PRIORITY_ORDER.indexOf(b.k as Priority)
      : b.n - a.n);
  const breakdown = breakdownAll.slice(0, BREAKDOWN_ROWS);
  const statusCounts = STATUS_ORDER.map((s) => ({ s, n: counts.get(s) ?? 0 }));
  // the legend gives each status's share, not its count: the KPI sentence
  // already states the blocked figure, and each number is stated once
  const statusShares = shares(statusCounts.map((b) => b.n));
  const shareText = (i: number) => (statusCounts[i].n > 0 && statusShares[i] === 0 ? "<1%" : `${statusShares[i]}%`);

  // ---- who carried the work (team) / where your work went (you) ----
  const people = members.map((m) => {
    const mine = scoped.filter((t) => t.assigneeId === m.id);
    const done = mine.filter((t) => t.status === "done").length;
    return { id: m.id, name: m.name, done, open: mine.length - done };
  }).sort((a, b) => b.done - a.done || b.open - a.open || a.name.localeCompare(b.name));
  const showPeople = who === "team" && members.length > 1;
  const projectsDone = (() => {
    const map = new Map<string, { done: number; open: number }>();
    scoped.forEach((t) => { const c = map.get(t.projectId) ?? { done: 0, open: 0 }; if (t.status === "done") c.done++; else c.open++; map.set(t.projectId, c); });
    return [...map.entries()].map(([pid, c]) => ({ pid, name: getProject(pid)?.name ?? "—", color: getProject(pid)?.color ?? "", ...c }))
      .sort((a, b) => b.done - a.done || b.open - a.open || a.name.localeCompare(b.name));
  })();

  // ---- estimate vs actual (tasks that have both an estimate and logged time) ----
  const tracked = scoped.filter((t) => t.effortHours != null && t.loggedHours != null);
  const totalEst = tracked.reduce((a, t) => a + (t.effortHours || 0), 0);
  const totalAct = tracked.reduce((a, t) => a + (t.loggedHours || 0), 0);
  const variance = Math.round((totalAct - totalEst) * 10) / 10;
  const overruns = [...tracked].map((t) => ({ t, diff: (t.loggedHours || 0) - (t.effortHours || 0) })).filter((x) => x.diff !== 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || b.diff - a.diff).slice(0, 5);

  const bar = (
    <InsightsBar view="overview" onOpenTrends={nav.onOpenTrends} onOpenOverview={nav.onOpenOverview}
      scope={scope} onScope={setScope} showScope={showScope} onAsk={nav.onAsk} compact={isMobile} />
  );

  if (scoped.length === 0) {
    const otherwise = filterMine && tasks.length > 0;
    return (
      <div className="kin">
        <InsightsStyles />
        <div className="kin-page">
          {bar}
          <EmptyState art="chart" size="lg"
            title={otherwise ? "Nothing's assigned to you here yet." : nav.personal ? "Insights appear once you finish a few tasks." : "Insights appear once your team finishes a few tasks."}
            body={otherwise ? "Switch to Team to see how everyone's work is going." : "Completion, on-time rate and who's carrying what show up here as work gets done."}
            action={otherwise ? <Button variant="secondary" size="sm" onClick={() => setScope("team")}>Show the team</Button> : undefined} />
        </div>
      </div>
    );
  }

  const selects = (
    <>
      <select className="kin-select" value={activeDim} onChange={(e) => setDim(e.target.value)} aria-label="Group by">
        <option value="status">By status</option>
        <option value="priority">By priority</option>
        <option value="project">By project</option>
        <option value="assignee">By assignee</option>
        {[...fieldGroups.values()].sort((a, b) => a.name.localeCompare(b.name)).map((g) => <option key={g.key} value={g.key}>By {g.name}</option>)}
      </select>
      <select className="kin-select" value={state} onChange={(e) => setState(e.target.value as "all" | "open" | "done")} aria-label="Show">
        <option value="all">All tasks</option>
        <option value="open">Open only</option>
        <option value="done">Completed only</option>
      </select>
    </>
  );

  const breakdownRows: BarRow[] = breakdown.map((b) => ({
    key: b.k, label: dimLabel(b.k), title: dimLabel(b.k), value: b.n, lead: dimLead(b.k),
    tone: activeDim === "priority" && b.k === "urgent" ? "signal" : "ink",
  }));

  return (
    <div className="kin">
      <InsightsStyles />
      <div className="kin-page">
        {bar}
        <p className="kin-kpi"><Figures phrase={kpi} /></p>

        <div className="kin-grid">
          <InsightsCard title="Completed" meta="Last 7 days">
            <Bars data={week} h={172} label="Tasks completed per day, last 7 days" unit="completed" />
          </InsightsCard>

          <InsightsCard title="Breakdown" meta={pool.length ? `${pool.length} ${pool.length === 1 ? "task" : "tasks"}` : undefined} actions={selects}>
            {pool.length === 0 ? (
              <p className="kin-empty">No tasks in this view.</p>
            ) : activeDim === "status" ? (
              <>
                {/* the bar's accessible name carries each count and share; the legend repeats it for the eye */}
                <StackedBar label={`${pool.length} ${pool.length === 1 ? "task" : "tasks"} by status`}
                  segments={statusCounts.map((b) => ({ key: b.s, label: STATUS_META[b.s].label, value: b.n, color: statusFill(b.s) }))} />
                <ul className="kin-legend" aria-hidden="true">
                  {statusCounts.map((b, i) => (
                    <li key={b.s} data-empty={b.n === 0 || undefined}>
                      <span style={{ display: "inline-flex" }}><StatusGlyph status={b.s} size={14} /></span>
                      {STATUS_META[b.s].label}
                      <span className="kin-mono">{shareText(i)}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <BarList rows={breakdownRows} label={`Tasks by ${group?.name ?? activeDim}`} />
            )}
            {(breakdownAll.length > BREAKDOWN_ROWS || group) && pool.length > 0 && (
              <p className="kin-foot">
                {breakdownAll.length > BREAKDOWN_ROWS && <>Showing the top {BREAKDOWN_ROWS} of {breakdownAll.length}. </>}
                {group && <>Counts tasks in the {group.byProject.size} project{group.byProject.size === 1 ? "" : "s"} that use “{group.name}”.</>}
              </p>
            )}
          </InsightsCard>

          {showPeople ? (
            <InsightsCard title="Team output" meta="Completed · all time">
              <BarList label="Tasks completed per person" labelWidth={160}
                rows={people.slice(0, PEOPLE_ROWS).map((p, i) => ({
                  key: p.id, label: p.name, title: p.name, value: p.done, meta: `done · ${p.open} open`,
                  tone: i === 0 && p.done > 0 ? "accent" : "ink", lead: getMember(p.id) ? <Avatar id={p.id} size={20} /> : undefined,
                }))} />
              {people.length > PEOPLE_ROWS && <p className="kin-foot">Showing the top {PEOPLE_ROWS} of {people.length} people.</p>}
            </InsightsCard>
          ) : (
            <InsightsCard title="By project" meta="Completed · all time">
              <BarList label="Tasks completed per project" labelWidth={160}
                rows={projectsDone.slice(0, PROJECT_ROWS).map((p, i) => ({
                  key: p.pid, label: p.name, title: p.name, value: p.done, meta: `done · ${p.open} open`,
                  tone: i === 0 && p.done > 0 ? "accent" : "ink", lead: <ProjectDot color={p.color} />,
                }))} />
              {projectsDone.length > PROJECT_ROWS && <p className="kin-foot">Showing the top {PROJECT_ROWS} of {projectsDone.length} projects.</p>}
            </InsightsCard>
          )}

          <InsightsCard title="Estimate vs actual" meta={tracked.length ? `${tracked.length} tracked` : undefined}
            lead={tracked.length > 0 ? (
              <>
                Logged <b>{fmtHours(totalAct)}</b> against <b>{fmtHours(totalEst)}</b> estimated{variance === 0 ? ", spot on." : <>: <b data-tone={variance > 0 ? "signal" : "ok"}>{fmtHours(Math.abs(variance))} {variance > 0 ? "over" : "under"}</b>.</>}
              </>
            ) : undefined}>
            {tracked.length === 0 ? (
              <p className="kin-empty">Add an estimate and log time on a task, and Kanbo compares the two here.</p>
            ) : overruns.length > 0 ? (
              <div>
                <p className="kin-sub" style={{ marginTop: 0 }}>Biggest differences</p>
                {overruns.map(({ t, diff }) => (
                  <TaskRow key={t.id} task={t} onOpen={onOpen}>
                    <span className="kin-row-title">{t.title}</span>
                    <span className="kin-mono">{fmtHours(t.effortHours || 0)} → {fmtHours(t.loggedHours || 0)}</span>
                    <span className="kin-mono" style={{ width: 52, textAlign: "right", color: diff > 0 ? "var(--signal, var(--st-blocked))" : "var(--ok, var(--st-done))" }}>
                      {diff > 0 ? "+" : "−"}{fmtHours(Math.abs(diff))}
                    </span>
                  </TaskRow>
                ))}
              </div>
            ) : (
              <p className="kin-empty">Every tracked task came in exactly on its estimate.</p>
            )}
          </InsightsCard>
        </div>
      </div>
    </div>
  );
}
