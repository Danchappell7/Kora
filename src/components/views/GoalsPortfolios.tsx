/* ============================================================
   KANBO — Goals (a number you want to hit, with its progress) and
   Portfolios (projects rolled up: cards to manage them, a table to
   read them at a glance)
   ============================================================ */
import { useMemo, useState } from "react";
import { Avatar, Button, DateChip, EmptyState, Icon, IconButton, Meter, Pill, ProjectDot, Segmented } from "../primitives";
import { getProject, getMember, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind, StatusUpdate, Workspace } from "../../data/types";
import { goalDescendants, goalProgressMap, goalTree, projectHealth, useStableOrder, type GoalProgress, type HealthKind } from "./reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { fmtAge, fmtShortDay, FORMER_MEMBER, indexTasks, isStale, oldestTaskAge, projectUpdates, statusFacts, STALE_DAYS, updateAuthor, type TaskIndex } from "../../lib/statusDraft";
import { combinedProgress, progressOf, projectPct } from "../../lib/countRules";
import { WorkspaceMark } from "../businesses/Businesses";
import { shortName } from "../../lib/businesses";
import "../project/projects.css";

/* A Personal portfolio across businesses: each project says which business it's from, a project you can no
   longer see keeps its place (and can be taken out), and the card says who can see it. */
const ACROSS_CSS = `
.kpj-pf-name { display: flex; align-items: center; gap: 10px; min-width: 0; }
.kpj-pf-name > .kpj-pf-open { flex: 0 1 auto; }
.kpj-pf-biz { display: inline-flex; align-items: center; gap: 5px; flex-shrink: 1; min-width: 0; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); white-space: nowrap; }
.kpj-pf-biz > span:last-child { overflow: hidden; text-overflow: ellipsis; }
.kpj-pf-gone { min-width: 0; font: 500 14px/20px var(--kpj-font); color: var(--ink-3); font-style: italic; }
/* stacked (a narrow table): the remove button stays beside the name */
@container (max-width: 599px) { .kpj-exec .kpj-tr[data-gone] .kpj-td:nth-child(5) { grid-column: 2; grid-row: 1; text-align: right; } }
.kpj-pf-only { display: inline-flex; align-items: center; gap: 6px; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); white-space: nowrap; }
.kpj-pf-only > svg { color: var(--icon-quiet, var(--ink-4)); }
.kpj-pick-group { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; width: 100%; }
.kpj-pick-head { display: inline-flex; align-items: center; gap: 6px; flex-basis: 100%; margin-top: 4px; font: 600 12px/16px var(--kpj-font); color: var(--ink-3); }
.kpj-pick-group:first-child .kpj-pick-head { margin-top: 0; }
.kpj-proj .kpj-pf-biz { grid-column: 2; }
/* (its summary carries one more line: it wraps rather than run off a phone's edge) */
[data-across] .kpj-card-side, [data-across] .kpj-pf-exec-head { flex-wrap: wrap; min-width: 0; row-gap: 6px; }
[data-across] .kpj-card-side { justify-content: flex-end; }
@media (max-width: 859px) {
  .kpj-pf-name { flex-wrap: wrap; row-gap: 0; }
  [data-across] .kpj-card-side { justify-content: flex-start; margin-left: 0; }
  .kpj-pf-only { flex-basis: 100%; }
}
`;
const ONLY_YOU = "It's in your Personal space, so only you can see it. It shows projects from every business you're in, from what you can already see.";

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
/** "Maya" for Maya Lin; "Former member" stays whole */
const firstName = (name: string) => (name === FORMER_MEMBER ? name : name.split(/\s+/)[0] || name);

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
export function GoalsView({ goals, projects, tasks, onCreate, onUpdate, onDelete, readOnly = false }: {
  goals: Goal[];
  projects: Project[];
  /** the workspace's tasks, archived projects' included: a goal linked to a finished,
   *  archived project keeps reading that project's progress instead of dropping to 0% */
  tasks: Task[];
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Goal, "name" | "description" | "target" | "current" | "unit" | "due" | "status" | "parentId" | "projectId">>) => void;
  onDelete: (id: string) => void;
  /** a guest: the goals to read, no controls (writes would only be refused) */
  readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // the whole tree, any depth (a sub-goal's own sub-goals used to vanish)
  const ordered = goalTree(useStableOrder(goals));
  // a linked project's % is its top-level tasks done, as on its own header (lib/countRules)
  const progress = goalProgressMap(goals, (pid) => projectPct(tasks, pid));
  const todayIso = toLocalISO(KANBO_TODAY);
  const numOr0 = (v: string) => { const n = Number(v); return v.trim() === "" || !isFinite(n) ? 0 : n; };
  // save a typed number (blank → 0) only when it differs, and show it as stored
  const saveNum = (g: Goal, key: "current" | "target", v: string) => {
    const n = numOr0(v);
    if (n !== (g[key] ?? 0)) onUpdate(g.id, key === "current" ? { current: n } : { target: n });
    return String(n);
  };
  const explainer = "Goals track a number you want to hit. Link one to a project and its progress fills in automatically.";
  if (readOnly) return <GoalsReadOnly ordered={ordered} progress={progress} projects={realProjects} todayIso={todayIso} />;
  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          {goals.length === 0 && !adding ? (
            <EmptyState art="target" title="No goals yet" body={explainer}
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
                  const linkedProject = linkedOf(g, realProjects);
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
                      <DraftInput value={g.description ?? ""} placeholder="Add a description" label={`Description of ${g.name}`} multiline
                        onCommit={(v) => onUpdate(g.id, { description: v })} className="kpj-name-input kpj-goal-desc" />
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
                      <GoalSource prog={prog} linked={linkedProject} />
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

/** The project a goal is linked to, archived ones included (they keep their progress). */
function linkedOf(g: Goal, projects: Project[]): Project | undefined {
  return g.projectId ? (getProject(g.projectId) ?? projects.find((p) => p.id === g.projectId)) : undefined;
}

/** Where a goal's % comes from: its project (top-level tasks done), its sub-goals, or its own number. */
function GoalSource({ prog, linked }: { prog: GoalProgress; linked?: Project }) {
  return (
    <div style={{ marginTop: 6 }}>
      {prog.source === "project" && (
        <span className="kpj-goal-source" title="The share of the project's tasks that are done (sub-tasks count with their parent)">
          From project {linked?.name ?? "—"}{linked?.archivedAt ? " (archived)" : ""}
        </span>
      )}
      {prog.source === "subgoals" && <span className="kpj-goal-source" title="Enter a current value to track this goal's own number instead">Average of {plural(prog.children, "sub-goal")}</span>}
      {prog.source === "manual" && prog.subPct !== undefined && <span className="kpj-goal-source">Own value · {plural(prog.children, "sub-goal")} average {prog.subPct}%</span>}
    </div>
  );
}

/** Goals for a guest: the same cards to read, with no fields, pickers or buttons
 *  (a guest's changes would only be refused). Once 0051 is run, guests can't read
 *  goals at all, and the page says who they're for instead. */
function GoalsReadOnly({ ordered, progress, projects, todayIso }: {
  ordered: { g: Goal; depth: number }[]; progress: Map<string, GoalProgress>; projects: Project[]; todayIso: string;
}) {
  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          {ordered.length === 0 ? (
            <EmptyState art="target" title="Goals are for members"
              body="Members of this workspace set its goals and track them here. As a guest you can still open every project and comment on its tasks." />
          ) : (
            <>
              <div className="kpj-toolbar">
                <p className="kpj-toolbar-note">The goals this workspace is working towards. Members keep them up to date; as a guest you can read them.</p>
              </div>
              <div className="kpj-stack">
                {ordered.map(({ g, depth }) => {
                  const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
                  const prog: GoalProgress = progress.get(g.id) ?? { pct: 0, source: "manual", children: 0 };
                  const linked = linkedOf(g, projects);
                  const overdue = !!g.due && g.due < todayIso && g.status !== "done" && prog.pct < 100;
                  return (
                    <article key={g.id} className="kpj-card kpj-goal" data-depth={depth || undefined} aria-label={`Goal ${g.name}`}
                      style={depth ? ({ "--depth": Math.min(depth, 5) } as React.CSSProperties) : undefined}>
                      <div className="kpj-card-head">
                        {depth > 0 && <Icon name="arrowRight" size={14} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />}
                        <h3 className="kpj-name-static" style={{ margin: 0 }}>{g.name}</h3>
                        <div className="kpj-card-side"><Pill tone={meta.tone}>{meta.label}</Pill></div>
                      </div>
                      {g.description && <p className="kpj-goal-desc-text">{g.description}</p>}
                      {(g.due || overdue || (prog.source !== "project" && (g.target ?? 0) > 0)) && (
                        <div className="kpj-card-row">
                          {g.due && <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} tone="plain" readOnly onChange={() => undefined} />}
                          {overdue && <Pill tone="signal">Overdue</Pill>}
                          {prog.source !== "project" && (g.target ?? 0) > 0 && (
                            <span className="kpj-card-meta kpj-mono">{g.current ?? 0} / {g.target}{g.unit ? ` ${g.unit}` : ""}</span>
                          )}
                        </div>
                      )}
                      <div className="kpj-goal-progress">
                        <Meter value={prog.pct} height={6} label={`${g.name} progress`} />
                        <span className="kpj-mono">{prog.pct}%</span>
                      </div>
                      <GoalSource prog={prog} linked={linked} />
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

export function PortfoliosView({ portfolios, projects, tasks, statusUpdates = [], onCreate, onUpdate, onDelete, onOpenProject, acrossBusinesses, readOnly = false }: {
  portfolios: Portfolio[];
  projects: Project[];
  /** the workspace's tasks, archived projects' included: a finished project that's been
   *  archived keeps its % in the portfolio, as on a goal linked to it */
  tasks: Task[];
  /** project status updates, newest first — adds each project's latest call to its row */
  statusUpdates?: StatusUpdate[];
  /** Personal: portfolios only you can see, whose projects can come from every business you're in. `projects`
   *  and `tasks` are then every workspace's (yours to see); the picker groups them by business. */
  acrossBusinesses?: { workspaces: Workspace[] };
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: { name?: string; projectIds?: string[] }) => void;
  onDelete: (id: string) => void;
  onOpenProject: (projectId: string) => void;
  /** a guest: the portfolios to read and open, no controls */
  readOnly?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null);
  const [view, setViewRaw] = useState<PfView>(readView);
  const setView = (v: PfView) => { setViewRaw(v); try { localStorage.setItem("kanbo-portfolio-view", v); } catch { /* private mode */ } };
  const ordered = useStableOrder(portfolios);
  // the task list grouped by project once per change, not filtered again for every project
  const idx = useMemo(() => indexTasks(tasks), [tasks]);
  const across = acrossBusinesses ?? null;
  const explainer = across
    ? "A portfolio rolls several projects into one view. In Personal it can hold projects from every business you're in, and only you can see it."
    : "A portfolio rolls several projects into one view: their progress, health and latest updates.";
  const findProject = (pid: string) => getProject(pid) ?? projects.find((p) => p.id === pid);
  const bizOf = (p: Project) => (across ? across.workspaces.find((w) => (w.id ?? null) === (p.workspaceId ?? null)) : undefined);
  const biz = (p: Project) => {
    const w = bizOf(p);
    return w ? <span className="kpj-pf-biz"><WorkspaceMark workspace={w} size={16} /><span>{shortName(w.name)}</span></span> : null;
  };
  const onlyYou = across ? <span className="kpj-pf-only" title={ONLY_YOU}><Icon name="lock" size={12} sw={2} />Only you can see this</span> : null;
  // an archived project keeps its row (and its %), and says so
  const openBtn = (p: Project) => (
    <button type="button" className="kpj-pf-open" onClick={() => onOpenProject(p.id)} aria-label={`Open project ${p.name}${p.archivedAt ? " (archived)" : ""}`}>
      {p.name}{p.archivedAt && <span className="kpj-pf-archived"> (archived)</span>}
    </button>
  );

  return (
    <div className="kpj-page">
      {across && <style>{ACROSS_CSS}</style>}
      <div className="kpj-wrap">
        {portfolios.length === 0 && readOnly ? (
          <EmptyState art="briefcase" title="Portfolios are for members"
            body="Members of this workspace group its projects here to see how they're going together. As a guest you can still open every project." />
        ) : portfolios.length === 0 && !adding ? (
          <EmptyState art="briefcase" title="No portfolios yet" body={explainer}
            action={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>} />
        ) : (
          <>
            <div className="kpj-toolbar">
              <p className="kpj-toolbar-note">{readOnly ? "Projects grouped by the workspace's members. As a guest you can read them and open each project." : explainer}</p>
              <Segmented ariaLabel="Portfolio view" value={view} onChange={setView}
                options={[{ value: "cards", label: "Cards" }, { value: "table", label: "Table" }]} />
              {!readOnly && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New portfolio</Button>}
            </div>
            {adding && <Adder label="New portfolio name" placeholder="Portfolio name, e.g. Q3 initiatives" onAdd={(n) => { onCreate(n); setAdding(false); }} onCancel={() => setAdding(false)} />}
            <div className={view === "cards" ? "kpj-stack" : undefined}>
              {ordered.map((pf) => {
                const inPf = pf.projectIds.map(findProject).filter((p): p is Project => !!p);
                // (Personal, across businesses: a project you can no longer see keeps its place, to be taken out)
                const gone = across ? pf.projectIds.filter((id) => !findProject(id)) : [];
                const goneRows = (table: boolean) => gone.map((id) => {
                  const remove = <IconButton icon="x" size="sm" label={`Remove the project you can no longer see from ${pf.name}`} onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((x) => x !== id) })} />;
                  const why = <span className="kpj-card-meta">You've lost access to it, or it was deleted</span>;
                  // in the table: a cell under each column (why under Latest update, remove under Updated)
                  return table ? (
                    <div key={id} className="kpj-tr kpj-exec-tr" role="row" data-gone="">
                      <div role="cell" className="kpj-td"><span className="kpj-proj" style={{ padding: 0 }}><ProjectDot color="oklch(0.62 0 0)" size={10} /><span className="kpj-pf-gone">No longer visible to you</span></span></div>
                      <div role="cell" className="kpj-td">{why}</div>
                      <div role="cell" className="kpj-td" data-empty="true" />
                      <div role="cell" className="kpj-td kpj-exec-ms" />
                      <div role="cell" className="kpj-td kpj-num">{remove}</div>
                    </div>
                  ) : (
                    <div key={id} className="kpj-pf-row" data-gone="">
                      <ProjectDot color="oklch(0.62 0 0)" size={10} />
                      <span className="kpj-pf-gone">No longer visible to you</span>
                      <div className="kpj-pf-side">{why}{remove}</div>
                    </div>
                  );
                });
                const rows = inPf.map((p) => {
                  const ptasks = idx.byProject.get(p.id) ?? [];
                  return { p, ptasks, health: projectHealth(ptasks, KANBO_TODAY), latest: projectUpdates(statusUpdates, p.id)[0] };
                });
                // every top-level task across the portfolio's projects (lib/countRules), so it agrees with each row
                const combined = combinedProgress(rows.flatMap((r) => r.ptasks), inPf.map((p) => p.id)).pct;
                const offN = rows.filter((r) => r.health?.kind === "off_track").length;
                const riskN = rows.filter((r) => r.health?.kind === "at_risk").length;
                const summary = (
                  <>
                    {onlyYou}
                    {inPf.length > 0 && <span className="kpj-count">{combined}% · {plural(inPf.length, "project")}</span>}
                    {offN > 0 && <Pill tone="signal">{offN} off track</Pill>}
                    {riskN > 0 && <Pill tone="warn">{riskN} at risk</Pill>}
                  </>
                );

                if (view === "table") {
                  return (
                    <section key={pf.id} className="kpj-pf-exec" aria-label={pf.name} data-across={across ? "" : undefined}>
                      <div className="kpj-pf-exec-head">
                        <h2 className="kpj-pf-exec-name">{pf.name}</h2>
                        {summary}
                      </div>
                      {rows.length === 0 && gone.length === 0 ? <p className="kpj-card-meta">{readOnly ? "No projects in this portfolio yet." : "No projects in this portfolio yet. Switch to Cards to add some."}</p> : (
                        <PortfolioTable rows={rows.map((r) => r.p)} tasks={tasks} idx={idx} statusUpdates={statusUpdates} label={`${pf.name} projects`} onOpenProject={onOpenProject}
                          bizOf={across ? biz : undefined} extraRows={goneRows(true)} />
                      )}
                    </section>
                  );
                }

                const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id));
                const picking = pickFor === pf.id;
                const pick = (p: Project) => (
                  <button key={p.id} type="button" className="kpj-chip" aria-label={`Add ${p.name} to ${pf.name}`}
                    onClick={() => { onUpdate(pf.id, { projectIds: [...pf.projectIds, p.id] }); setPickFor(null); }}>
                    <ProjectDot color={p.color} size={8} /> {p.name}
                  </button>
                );
                return (
                  <article key={pf.id} className="kpj-card" aria-label={`Portfolio ${pf.name}`} data-across={across ? "" : undefined}>
                    <div className="kpj-card-head">
                      <Icon name="briefcase" size={16} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />
                      {readOnly ? <h3 className="kpj-name-static" style={{ margin: 0 }}>{pf.name}</h3>
                        : <DraftInput value={pf.name} required label={`Portfolio name: ${pf.name}`} onCommit={(v) => onUpdate(pf.id, { name: v })} className="kpj-name-input" />}
                      <div className="kpj-card-side">
                        {summary}
                        {!readOnly && <>
                          <Button variant="ghost" size="sm" icon="plus" aria-expanded={picking} aria-label={`Add a project to ${pf.name}`} onClick={() => setPickFor((x) => x === pf.id ? null : pf.id)}>Project</Button>
                          <IconButton icon="trash" size="sm" tone="danger" label={`Delete portfolio ${pf.name}`}
                            onClick={() => { if (window.confirm(`Delete portfolio “${pf.name}”? The projects themselves are kept. This can't be undone.`)) onDelete(pf.id); }} />
                        </>}
                      </div>
                    </div>
                    {picking && (available.length > 0 ? (
                      <div className="kpj-card-row" role="group" aria-label={`Projects you can add to ${pf.name}`}>
                        {across
                          // every business you're in, each under its logo
                          ? across.workspaces.map((w) => {
                            const here = available.filter((p) => (p.workspaceId ?? null) === (w.id ?? null));
                            return here.length === 0 ? null : (
                              <div key={w.id ?? "personal"} className="kpj-pick-group" role="group" aria-label={w.name}>
                                <span className="kpj-pick-head" aria-hidden="true"><WorkspaceMark workspace={w} size={16} />{w.name}</span>
                                {here.map(pick)}
                              </div>
                            );
                          })
                          : available.map(pick)}
                      </div>
                    ) : <p className="kpj-card-meta" style={{ margin: "12px 0 0" }}>{across ? "Every project you can see is already in this portfolio." : "Every project in this workspace is already in this portfolio."}</p>)}
                    {rows.length === 0 && gone.length === 0 ? (
                      <p className="kpj-card-meta" style={{ margin: "12px 0 0" }}>{readOnly ? "No projects in this portfolio yet." : "No projects yet. Add one with + Project."}</p>
                    ) : rows.map(({ p, ptasks, health, latest }) => {
                      // top-level tasks, the same rule as the Table and the project's own header
                      const { total: count, pct } = progressOf(ptasks);
                      const by = latest ? updateAuthor(latest) : undefined;
                      const ownerName = p.ownerId ? (getMember(p.ownerId)?.name ?? "(former member)") : null;
                      return (
                        <div key={p.id} className="kpj-pf-row">
                          <ProjectDot color={p.color} size={10} />
                          {across ? (
                            <span className="kpj-pf-name">
                              {openBtn(p)}
                              {biz(p)}
                            </span>
                          ) : openBtn(p)}
                          <div className="kpj-pf-side">
                            {health && <Pill tone={HEALTH_TONE[health.kind]} title={`Kanbo's read: ${health.detail}`}>{health.label}</Pill>}
                            {latest && STATUS_KIND_META[latest.status] && (
                              <Pill tone={KIND_TONE[latest.status]} title={`Latest update (${fmtShortDay(latest.createdAt, KANBO_TODAY)}${by ? `, ${by}` : ""}): ${latest.summary}`}>
                                Update: {STATUS_KIND_META[latest.status].label}
                              </Pill>
                            )}
                            {/* the avatar alone reads as initials: say whose it is */}
                            {ownerName && p.ownerId && getMember(p.ownerId) && (
                              <span className="kpj-owner" role="img" aria-label={`Owner: ${ownerName}`}><Avatar id={p.ownerId} size={20} /></span>
                            )}
                            <span className="kpj-card-meta kpj-mono" style={{ fontSize: 11 }}>
                              {plural(count, "task")}{health && health.overdue > 0 && <span className="kpj-signal"> · {health.overdue} overdue</span>}
                            </span>
                            <span className="kpj-progress" style={{ width: 112 }}>
                              <Meter value={pct} width={72} height={4} label={`${p.name} progress`} />
                              <span className="kpj-mono" aria-hidden="true">{pct}%</span>
                            </span>
                            {!readOnly && <IconButton icon="x" size="sm" label={`Remove ${p.name} from ${pf.name}`} onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((id) => id !== p.id) })} />}
                          </div>
                        </div>
                      );
                    })}
                    {goneRows(false)}
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
function PortfolioTable({ rows, tasks, idx, statusUpdates, label, onOpenProject, bizOf, extraRows }: {
  rows: Project[]; tasks: Task[]; idx: TaskIndex; statusUpdates: StatusUpdate[]; label: string; onOpenProject: (id: string) => void;
  /** across businesses: the business a project is from, under its name */
  bizOf?: (p: Project) => React.ReactNode;
  /** rows after the projects (a Personal portfolio's projects you can no longer see) */
  extraRows?: React.ReactNode;
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
          const f = statusFacts(p, tasks, statusUpdates, KANBO_TODAY, idx);
          const stale = isStale(f, oldestTaskAge(idx.byProject.get(p.id) ?? [], p.id, KANBO_TODAY));
          const latest = f.latest;
          const by = latest ? updateAuthor(latest) : undefined;
          return (
            <div key={p.id} role="row" className="kpj-tr kpj-exec-tr" onClick={() => onOpenProject(p.id)}>
              <div role="cell" className="kpj-td">
                <span className="kpj-proj" style={{ padding: 0 }}>
                  <ProjectDot color={p.color} size={10} />
                  <button type="button" className="kpj-pf-open" aria-label={`Open project ${p.name}${p.archivedAt ? " (archived)" : ""}`} title={p.archivedAt ? `${p.name} (archived)` : undefined}
                    onClick={(e) => { e.stopPropagation(); onOpenProject(p.id); }}>
                    {p.name}{p.archivedAt && <span className="kpj-pf-archived"> (archived)</span>}
                  </button>
                  {bizOf?.(p)}
                </span>
              </div>
              <div role="cell" className="kpj-td">
                {latest && STATUS_KIND_META[latest.status] ? (
                  <span className="kpj-exec-update">
                    <Pill tone={KIND_TONE[latest.status]}>{STATUS_KIND_META[latest.status].label}</Pill>
                    {/* who said it, in words (a tooltip alone is out of reach on a phone or the keyboard) */}
                    {by && <span className="kpj-exec-by" data-former={latest.authorId && getMember(latest.authorId) ? undefined : ""}>{firstName(by)}</span>}
                    <span className="kpj-exec-summary" title={by ? `${by}: ${latest.summary}` : latest.summary}>{latest.summary}</span>
                  </span>
                ) : <Pill tone="neutral">No update</Pill>}
              </div>
              <div role="cell" className="kpj-td">
                <span className="kpj-progress">
                  <Meter value={f.pct} width={64} height={4} label={`${p.name} progress`} />
                  <span className="kpj-mono" aria-hidden="true">{f.pct}%<span className="kpj-exec-lbl"> done</span></span>
                </span>
              </div>
              <div role="cell" className="kpj-td kpj-exec-ms">
                {f.nextMilestone ? (
                  <span className="kpj-ms">
                    <span className="kpj-ms-title" title={f.nextMilestone.title}>{f.nextMilestone.title}</span>
                    <span className="kpj-ms-date">{fmtShortDay(f.nextMilestone.dueDate, KANBO_TODAY)}</span>
                  </span>
                ) : <><span className="kpj-dash" aria-hidden="true">—</span><span className="sr-only">No milestone</span></>}
              </div>
              <div role="cell" className="kpj-td kpj-num" data-empty={!stale && f.lastUpdateDays == null ? "true" : undefined}>
                {/* the header row is hidden in the stacked (narrow) layout, so the cell says what it is */}
                {stale
                  ? <span className="kpj-warn kpj-exec-stale">No update in {STALE_DAYS} days</span>
                  : f.lastUpdateDays != null
                    ? <span className="kpj-mono"><span className="kpj-exec-lbl">Updated </span>{fmtAge(f.lastUpdateDays)}{f.lastUpdateDays > 0 && <span className="kpj-exec-lbl"> ago</span>}</span>
                    : <><span className="kpj-dash" aria-hidden="true">—</span><span className="sr-only">No update yet</span></>}
              </div>
            </div>
          );
        })}
        {extraRows}
      </div>
    </div>
  );
}
