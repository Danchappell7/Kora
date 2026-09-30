/* ============================================================
   KANBO — Goals (a number you want to hit, with its progress) and
   Portfolios (projects rolled up: cards to manage them, a table to
   read them at a glance)
   ============================================================ */
import { useState } from "react";
import { Avatar, Button, DateChip, EmptyState, Icon, IconButton, Meter, Pill, ProjectDot, Segmented } from "../primitives";
import { getProject, getMember, projectProgress, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind, StatusUpdate } from "../../data/types";
import { goalDescendants, goalProgressMap, goalTree, projectHealth, useStableOrder, type GoalProgress, type HealthKind } from "./reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { fmtAge, fmtShortDay, isStale, oldestTaskAge, projectUpdates, statusFacts, STALE_DAYS } from "../../lib/statusDraft";
import "../project/projects.css";

type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";

const GOAL_STATUS: Record<GoalStatus, { label: string; color: string; tone: Tone }> = {
  on_track: { label: "On track", color: "var(--st-done)", tone: "ok" },
  at_risk: { label: "At risk", color: "var(--st-review)", tone: "warn" },
  off_track: { label: "Off track", color: "var(--prio-urgent)", tone: "signal" },
  done: { label: "Achieved", color: "var(--st-progress)", tone: "accent" },
};
export const STATUS_KIND_META: Record<StatusKind, { label: string; color: string }> = {
  on_track: { label: "On track", color: "var(--st-done)" },
  at_risk: { label: "At risk", color: "var(--st-review)" },
  off_track: { label: "Off track", color: "var(--prio-urgent)" },
};
const KIND_TONE: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal" };
const HEALTH_TONE: Record<HealthKind, Tone> = { complete: "ok", on_track: "ok", at_risk: "warn", off_track: "signal" };
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An inline "add" row: a name field with Add and Cancel. */
function Adder({ label, placeholder, onAdd, onCancel }: { label: string; placeholder: string; onAdd: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) onAdd(n); };
  return (
    <div className="kpj-adder">
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={label}
        onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

/* ---------------- GOALS / OKRs ---------------- */
export function GoalsView({ goals, projects, tasks, onCreate, onUpdate, onDelete }: {
  goals: Goal[];
  projects: Project[];
  tasks: Task[];
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // the whole tree, any depth (a sub-goal's own sub-goals used to vanish)
  const ordered = goalTree(useStableOrder(goals));
  const progress = goalProgressMap(goals, (pid) => projectProgress(tasks, pid));
  const todayIso = toLocalISO(KANBO_TODAY);
  const numOr0 = (v: string) => { const n = Number(v); return v.trim() === "" || !isFinite(n) ? 0 : n; };
  // save a typed number (blank → 0) only when it differs, and show it as stored
  const saveNum = (g: Goal, key: "current" | "target", v: string) => {
    const n = numOr0(v);
    if (n !== (g[key] ?? 0)) onUpdate(g.id, key === "current" ? { current: n } : { target: n });
    return String(n);
  };
  const explainer = "Goals track a number you want to hit. Link one to a project and its progress fills in automatically.";
  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          {goals.length === 0 && !adding ? (
            <EmptyState art="target" size="lg" title="No goals yet" body={explainer}
              action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New goal</Button>} />
          ) : (
            <>
              <div className="kpj-toolbar">
                <p className="kpj-toolbar-note">{explainer} Put goals under a parent to roll them up.</p>
                <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New goal</Button>
              </div>
              {adding && <Adder label="New goal name" placeholder="Goal name, e.g. Reach 1,000 active users" onAdd={(n) => { onCreate(n); setAdding(false); }} onCancel={() => setAdding(false)} />}
              <div className="kpj-stack">
                {ordered.map(({ g, depth }) => {
                  const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
                  const prog: GoalProgress = progress.get(g.id) ?? { pct: 0, source: "manual", children: 0 };
                  const pct = prog.pct;
                  const linkedProject = g.projectId ? (getProject(g.projectId) ?? realProjects.find((p) => p.id === g.projectId)) : undefined;
                  // a goal can't sit under itself or anything nested beneath it
                  const blocked = goalDescendants(goals, g.id); blocked.add(g.id);
                  const parentOptions = ordered.filter((o) => !blocked.has(o.g.id));
                  const parentValue = g.parentId && goals.some((x) => x.id === g.parentId) ? g.parentId : "";
                  const childCount = goals.filter((x) => x.parentId === g.id && x.id !== g.id).length;
                  const overdue = !!g.due && g.due < todayIso && g.status !== "done" && pct < 100;
                  return (
                    <article key={g.id} className="kpj-card kpj-goal" data-depth={depth || undefined} aria-label={`Goal ${g.name}`}
                      style={depth ? ({ "--depth": Math.min(depth, 5) } as React.CSSProperties) : undefined}>
                      <div className="kpj-card-head">
                        {depth > 0 && <Icon name="arrowRight" size={14} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />}
                        <DraftInput value={g.name} required label={`Goal name: ${g.name}`} onCommit={(v) => onUpdate(g.id, { name: v })} className="kpj-name-input" />
                        <div className="kpj-card-side">
                          <select className="kpj-field kpj-goal-status" data-size="sm" data-tone={meta.tone} value={g.status}
                            onChange={(e) => onUpdate(g.id, { status: e.target.value as GoalStatus })} aria-label={`Status of ${g.name}`}>
                            {(Object.keys(GOAL_STATUS) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS[s].label}</option>)}
                          </select>
                          <IconButton icon="trash" size="sm" tone="danger" label={`Delete goal ${g.name}`} onClick={() => {
                            const msg = childCount
                              ? `Delete goal “${g.name}”? Its ${plural(childCount, "sub-goal")} will move up to the top level. This can't be undone.`
                              : `Delete goal “${g.name}”? This can't be undone.`;
                            if (window.confirm(msg)) onDelete(g.id);
                          }} />
                        </div>
                      </div>
                      <div className="kpj-card-row">
                        <select className="kpj-field" data-size="sm" value={g.projectId ?? ""} onChange={(e) => onUpdate(g.id, { projectId: e.target.value || undefined })} style={{ maxWidth: 220 }} aria-label={`Project linked to ${g.name}`}>
                          <option value="">Not linked to a project</option>
                          {g.projectId && !realProjects.some((p) => p.id === g.projectId) && <option value={g.projectId}>↪ {linkedProject?.name ?? "Archived project"}</option>}
                          {realProjects.map((p) => <option key={p.id} value={p.id}>↪ {p.name}</option>)}
                        </select>
                        {goals.length > 1 && (
                          <select className="kpj-field" data-size="sm" value={parentValue} onChange={(e) => onUpdate(g.id, { parentId: e.target.value || undefined })} style={{ maxWidth: 240 }} aria-label={`Parent goal of ${g.name}`}>
                            <option value="">No parent goal</option>
                            {parentOptions.map((o) => <option key={o.g.id} value={o.g.id}>{"  ".repeat(o.depth)}Under: {o.g.name}</option>)}
                          </select>
                        )}
                        <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} placeholder="Add a due date" tone="plain"
                          onChange={(d) => onUpdate(g.id, { due: d || undefined })} />
                        {overdue && <Pill tone="signal">Overdue</Pill>}
                      </div>
                      {prog.source !== "project" && (
                        <div className="kpj-card-row">
                          <span className="kpj-goal-nums">
                            <DraftInput type="number" value={g.current ?? 0} label={`Current value for ${g.name}`} onCommit={(v) => saveNum(g, "current", v)} className="kpj-field kpj-mono" />
                            <span className="kpj-slash" aria-hidden="true">/</span>
                            <DraftInput type="number" value={g.target ?? 0} label={`Target for ${g.name}`} onCommit={(v) => saveNum(g, "target", v)} className="kpj-field kpj-mono" />
                            <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => onUpdate(g.id, { unit: v })} className="kpj-field" />
                          </span>
                        </div>
                      )}
                      <div className="kpj-goal-progress">
                        <Meter value={pct} height={6} label={`${g.name} progress`} />
                        <span className="kpj-mono">{pct}%</span>
                      </div>
                      <div style={{ marginTop: 6 }}>
                        {prog.source === "project" && <span className="kpj-goal-source">From project {linkedProject?.name ?? "—"}</span>}
                        {prog.source === "subgoals" && <span className="kpj-goal-source" title="Enter a current value to track this goal's own number instead">Average of {plural(prog.children, "sub-goal")}</span>}
                        {prog.source === "manual" && prog.subPct !== undefined && <span className="kpj-goal-source">Own value · {plural(prog.children, "sub-goal")} average {prog.subPct}%</span>}
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------- PORTFOLIOS ---------------- */
type PfView = "cards" | "table";
const readView = (): PfView => { try { return localStorage.getItem("kanbo-portfolio-view") === "table" ? "table" : "cards"; } catch { return "cards"; } };

export function PortfoliosView({ portfolios, projects, tasks, statusUpdates = [], onCreate, onUpdate, onDelete, onOpenProject }: {
  portfolios: Portfolio[];
  projects: Project[];
  tasks: Task[];
  /** project status updates, newest first — adds each project's latest call to its row */
  statusUpdates?: StatusUpdate[];
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: { name?: string; projectIds?: string[] }) => void;
  onDelete: (id: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [view, setViewRaw] = useState<PfView>(readView);
  const setView = (v: PfView) => { setViewRaw(v); try { localStorage.setItem("kanbo-portfolio-view", v); } catch { /* private mode */ } };
  const ordered = useStableOrder(portfolios);
  const explainer = "A portfolio rolls several projects into one view: their progress, health and latest updates.";
  const findProject = (pid: string) => getProject(pid) ?? projects.find((p) => p.id === pid);

  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        {portfolios.length === 0 && !adding ? (
          <EmptyState art="briefcase" size="lg" title="No portfolios yet" body={explainer}
            action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>} />
        ) : (
          <>
            <div className="kpj-toolbar">
              <p className="kpj-toolbar-note">{explainer}</p>
              <Segmented ariaLabel="Portfolio view" value={view} onChange={setView}
                options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]} />
              <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>
            </div>
            {adding && <Adder label="New portfolio name" placeholder="Portfolio name, e.g. Q3 initiatives" onAdd={(n) => { onCreate(n); setAdding(false); }} onCancel={() => setAdding(false)} />}
            <div className={view === "cards" ? "kpj-stack" : undefined}>
              {ordered.map((pf) => {
                const inPf = pf.projectIds.map(findProject).filter((p): p is Project => !!p);
                const rows = inPf.map((p) => {
                  const ptasks = tasks.filter((t) => t.projectId === p.id && !t.archivedAt);
                  return { p, ptasks, health: projectHealth(ptasks, KANBO_TODAY), latest: projectUpdates(statusUpdates, p.id)[0] };
                });
                const allTasks = rows.reduce((a, r) => a + r.ptasks.length, 0);
                const allDone = rows.reduce((a, r) => a + r.ptasks.filter((t) => t.status === "done").length, 0);
                const combined = allTasks ? Math.round((allDone / allTasks) * 100) : 0;
                const offN = rows.filter((r) => r.health?.kind === "off_track").length;
                const riskN = rows.filter((r) => r.health?.kind === "at_risk").length;
                const summary = (
                  <>
                    {inPf.length > 0 && <span className="kpj-count">{combined}% · {plural(inPf.length, "project")}</span>}
                    {offN > 0 && <Pill tone="signal">{offN} off track</Pill>}
                    {riskN > 0 && <Pill tone="warn">{riskN} at risk</Pill>}
                  </>
                );

                if (view === "table") {
                  return (
                    <section key={pf.id} className="kpj-pf-exec" aria-label={pf.name}>
                      <div className="kpj-pf-exec-head">
                        <h2 className="kpj-pf-exec-name">{pf.name}</h2>
                        {summary}
                      </div>
                      {rows.length === 0 ? <p className="kpj-card-meta">No projects in this portfolio yet. Switch to Cards to add some.</p> : (
                        <PortfolioTable rows={rows.map((r) => r.p)} tasks={tasks} statusUpdates={statusUpdates} label={`${pf.name} projects`} onOpenProject={onOpenProject} />
                      )}
                    </section>
                  );
                }

                const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id));
                const picking = pickFor === pf.id;
                return (
                  <article key={pf.id} className="kpj-card" aria-label={`Portfolio ${pf.name}`}>
                    <div className="kpj-card-head">
                      <Icon name="briefcase" size={16} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />
                      <DraftInput value={pf.name} required label={`Portfolio name: ${pf.name}`} onCommit={(v) => onUpdate(pf.id, { name: v })} className="kpj-name-input" />
                      <div className="kpj-card-side">
                        {summary}
                        <Button variant="ghost" size="sm" icon="plus" aria-expanded={picking} aria-label={`Add a project to ${pf.name}`} onClick={() => setPickFor((x) => x === pf.id ? null : pf.id)}>Project</Button>
                        <IconButton icon="trash" size="sm" tone="danger" label={`Delete portfolio ${pf.name}`}
                          onClick={() => { if (window.confirm(`Delete portfolio “${pf.name}”? The projects themselves are kept. This can't be undone.`)) onDelete(pf.id); }} />
                      </div>
                    </div>
                    {picking && (available.length > 0 ? (
                      <div className="kpj-card-row" role="group" aria-label={`Projects you can add to ${pf.name}`}>
                        {available.map((p) => (
                          <button key={p.id} type="button" className="kpj-chip" aria-label={`Add ${p.name} to ${pf.name}`}
                            onClick={() => { onUpdate(pf.id, { projectIds: [...pf.projectIds, p.id] }); setPickFor(null); }}>
                            <ProjectDot color={p.color} size={8} /> {p.name}
                          </button>
                        ))}
                      </div>
                    ) : <p className="kpj-card-meta" style={{ margin: "12px 0 0" }}>Every project in this workspace is already in this portfolio.</p>)}
                    {rows.length === 0 ? (
                      <p className="kpj-card-meta" style={{ margin: "12px 0 0" }}>No projects yet. Add one with + Project.</p>
                    ) : rows.map(({ p, ptasks, health, latest }) => {
                      const pct = projectProgress(tasks, p.id);
                      const count = ptasks.filter((t) => !t.parentId).length;
                      const ownerName = p.ownerId ? (getMember(p.ownerId)?.name ?? "(former member)") : null;
                      return (
                        <div key={p.id} className="kpj-pf-row">
                          <ProjectDot color={p.color} size={10} />
                          <button type="button" className="kpj-pf-open" onClick={() => onOpenProject(p.id)} aria-label={`Open project ${p.name}`}>{p.name}</button>
                          <div className="kpj-pf-side">
                            {health && <Pill tone={HEALTH_TONE[health.kind]} title={`Kanbo's read: ${health.detail}`}>{health.label}</Pill>}
                            {latest && STATUS_KIND_META[latest.status] && (
                              <Pill tone={KIND_TONE[latest.status]} title={`Latest update (${fmtShortDay(latest.createdAt, KANBO_TODAY)}): ${latest.summary}`}>
                                Update: {STATUS_KIND_META[latest.status].label}
                              </Pill>
                            )}
                            {ownerName && p.ownerId && getMember(p.ownerId) && <Avatar id={p.ownerId} size={20} />}
                            <span className="kpj-card-meta kpj-mono" style={{ fontSize: 11 }}>
                              {plural(count, "task")}{health && health.overdue > 0 && <span className="kpj-signal"> · {health.overdue} overdue</span>}
                            </span>
                            <span className="kpj-progress" style={{ width: 112 }}>
                              <Meter value={pct} width={72} height={4} label={`${p.name} progress`} />
                              <span className="kpj-mono" aria-hidden="true">{pct}%</span>
                            </span>
                            <IconButton icon="x" size="sm" label={`Remove ${p.name} from ${pf.name}`} onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((id) => id !== p.id) })} />
                          </div>
                        </div>
                      );
                    })}
                  </article>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** The exec view of a portfolio: one row per project with its latest call, progress,
 *  next milestone and how fresh its update is. */
function PortfolioTable({ rows, tasks, statusUpdates, label, onOpenProject }: {
  rows: Project[]; tasks: Task[]; statusUpdates: StatusUpdate[]; label: string; onOpenProject: (id: string) => void;
}) {
  return (
    <div role="table" aria-label={label} className="kpj-table kpj-exec">
      <div role="rowgroup" className="kpj-thead">
        <div role="row" className="kpj-tr kpj-exec-tr">
          <span role="columnheader" className="kpj-th">Project</span>
          <span role="columnheader" className="kpj-th">Latest update</span>
          <span role="columnheader" className="kpj-th">Done</span>
          <span role="columnheader" className="kpj-th kpj-exec-ms">Next milestone</span>
          <span role="columnheader" className="kpj-th kpj-num">Updated</span>
        </div>
      </div>
      <div role="rowgroup" className="kpj-tbody">
        {rows.map((p) => {
          const f = statusFacts(p, tasks, statusUpdates, KANBO_TODAY);
          const stale = isStale(f, oldestTaskAge(tasks, p.id, KANBO_TODAY));
          const latest = f.latest;
          return (
            <div key={p.id} role="row" className="kpj-tr kpj-exec-tr" onClick={() => onOpenProject(p.id)}>
              <div role="cell" className="kpj-td">
                <span className="kpj-proj" style={{ padding: 0 }}>
                  <ProjectDot color={p.color} size={10} />
                  <button type="button" className="kpj-pf-open" aria-label={`Open project ${p.name}`} onClick={(e) => { e.stopPropagation(); onOpenProject(p.id); }}>{p.name}</button>
                </span>
              </div>
              <div role="cell" className="kpj-td">
                {latest && STATUS_KIND_META[latest.status] ? (
                  <span className="kpj-exec-update">
                    <Pill tone={KIND_TONE[latest.status]}>{STATUS_KIND_META[latest.status].label}</Pill>
                    <span className="kpj-exec-summary" title={latest.summary}>{latest.summary}</span>
                  </span>
                ) : <Pill tone="neutral">No update</Pill>}
              </div>
              <div role="cell" className="kpj-td">
                <span className="kpj-progress">
                  <Meter value={f.pct} width={56} height={4} label={`${p.name} progress`} />
                  <span className="kpj-mono" aria-hidden="true">{f.pct}%</span>
                </span>
              </div>
              <div role="cell" className="kpj-td kpj-exec-ms">
                {f.nextMilestone ? (
                  <span className="kpj-ms">
                    <span className="kpj-ms-title" title={f.nextMilestone.title}>{f.nextMilestone.title}</span>
                    <span className="kpj-ms-date">{fmtShortDay(f.nextMilestone.dueDate, KANBO_TODAY)}</span>
                  </span>
                ) : <span className="kpj-dash" aria-label="None">—</span>}
              </div>
              <div role="cell" className="kpj-td kpj-num">
                {stale
                  ? <span className="kpj-warn" style={{ fontFamily: "var(--kpj-font)", fontSize: 12 }}>No update in {STALE_DAYS} days</span>
                  : f.lastUpdateDays != null ? <span className="kpj-mono">{fmtAge(f.lastUpdateDays)}</span> : <span className="kpj-dash">—</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
