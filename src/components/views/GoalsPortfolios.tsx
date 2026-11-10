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

/* Portfolios live in components/portfolios (re-exported below, so they share this page's chunk). */
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
  on_hold: { label: "On hold", color: "var(--ink-4)" },
};
const KIND_TONE: Record<StatusKind, Tone> = { on_track: "ok", at_risk: "warn", off_track: "signal", on_hold: "neutral" };
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
export { PortfoliosView } from "../portfolios/PortfoliosView";
