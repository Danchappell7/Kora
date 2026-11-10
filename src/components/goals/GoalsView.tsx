/* ============================================================
   KANBO — Goals: a number you want to hit and how far along it is,
   who owns it and the quarter it runs in (0052), how it has moved
   (check-ins), the work it's linked to, and where it should be by now:
   Kanbo suggests a status from the pace and the goal's owner decides.
   Only the people who may change a goal get its fields (lib/goalRules,
   the same rules as the database); everyone else reads it.
   Before 0052 is run the page is the one it always was, with the pace
   line (from the day the goal was made to its due date).
   ============================================================ */
import { useMemo, useState } from "react";
import { Button, DateChip, EmptyState, Icon, IconButton, Meter, Pill } from "../primitives";
import { getProject, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, GoalLinkKind, GoalPatch, GoalStatus, Project, Role, Task, WorkspaceMember } from "../../data/types";
import { goalDescendants, goalProgressMap, goalTree, useStableOrder, type GoalProgress } from "../views/reportingUtils";
import { DraftInput } from "../project/DraftInput";
import { projectPct } from "../../lib/countRules";
import { goalPace } from "../../lib/goalPace";
import { periodRange, quarterOf } from "../../lib/goalPeriods";
import { canEditGoal, canHandOverGoal, canMakeCompanyGoal, canPlaceGoal, canSeeGoal, COMPANY_GOALS_RULE } from "../../lib/goalRules";
import { fmtGoalValue, GoalCheckins, GoalDetails, GoalLinks, GoalMetaRow, GoalPaceLine } from "./GoalParts";
import "../project/projects.css";

/* Goals 2.0's parts on the card (the card itself is the Projects pages' .kpj-card) */
const GOALS_CSS = `
.kgl-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; margin-top: 10px; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); }
.kgl-owner, .kgl-period { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
.kgl-period > svg { color: var(--kpj-icon); flex-shrink: 0; }
.kgl-owner-name { color: var(--ink-2); }
.kgl-noface { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 99px; border: 1px dashed var(--hairline-strong, var(--hairline)); color: var(--kpj-icon); }
.kgl-select { max-width: 200px; min-width: 0; }
.kgl-dates { display: inline-flex; align-items: center; gap: 4px; color: var(--ink-4); }
.kgl-kind { padding: 1px 6px; border-radius: var(--kpj-r-xs); background: var(--kpj-hover); color: var(--ink-2); }
.kgl-pace { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; margin: 8px 0 0; font: 500 12px/18px var(--kpj-font); color: var(--ink-3); }
.kgl-pace-line { color: var(--ink-2); }
.kgl-pace[data-state="behind"] .kgl-pace-line, .kgl-pace[data-state="late"] .kgl-pace-line { color: var(--kpj-warn); }
.kgl-pace[data-state="ahead"] .kgl-pace-line, .kgl-pace[data-state="done"] .kgl-pace-line { color: var(--kpj-ok); }
.kgl-pace-say { color: var(--ink-2); }
.kgl-pace .kbtn { margin-left: -4px; }
.kgl-checkins { margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--hairline); }
.kgl-checkin-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 12px; min-height: 28px; }
.kgl-latest { display: inline-flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px; flex: 1 1 260px; min-width: 0; font: 400 13px/20px var(--kpj-font); color: var(--ink-3); }
.kgl-latest > b { color: var(--ink); font-size: 13px; }
.kgl-conf { font-size: 12px; }
.kgl-note { min-width: 0; color: var(--ink-2); overflow-wrap: anywhere; quotes: "“" "”"; }
.kgl-quiet { font: 400 13px/20px var(--kpj-font); color: var(--ink-4); }
.kgl-checkin-acts { display: inline-flex; align-items: center; gap: 6px; margin-left: auto; }
.kgl-composer { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 12px; margin-top: 10px; padding: 12px; border-radius: var(--kpj-r-md); background: var(--kpj-hover); }
.kgl-field { display: inline-flex; flex-direction: column; gap: 4px; min-width: 0; font: 500 12px/16px var(--kpj-font); color: var(--ink-3); }
.kgl-field > b { font: 500 13px/28px var(--kpj-font); color: var(--ink-2); }
.kgl-composer .kgl-field > .kpj-field[type="number"] { width: 112px; }
.kgl-field-grow { flex: 1 1 200px; }
.kgl-composer-acts { display: inline-flex; gap: 6px; }
.kgl-history { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.kgl-history > li { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; padding: 4px 0; font: 400 13px/20px var(--kpj-font); color: var(--ink-3); }
.kgl-history > li > b { color: var(--ink); font-size: 12px; }
.kgl-history-when { min-width: 84px; font-size: 12px; }
.kgl-history-note { flex: 1 1 200px; min-width: 0; color: var(--ink-2); overflow-wrap: anywhere; }
.kgl-history > li > .kibtn { margin-left: auto; align-self: center; }
.kgl-links { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.kgl-links-head { font: 500 12px/16px var(--kpj-font); color: var(--ink-3); margin-right: 2px; }
.kgl-chip { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; height: 24px; padding: 0 8px; border-radius: 99px;
  background: var(--kpj-hover); font: 500 12px/16px var(--kpj-font); color: var(--ink-2); }
.kgl-chip > svg { color: var(--kpj-icon); flex-shrink: 0; }
.kgl-chip-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.kgl-chip-x { display: inline-grid; place-items: center; width: 18px; height: 18px; margin-right: -4px; padding: 0; border: 0; border-radius: 99px; background: none; color: var(--kpj-icon); cursor: pointer; }
.kgl-chip-x:hover { background: var(--kpj-press); color: var(--kpj-signal); }
.kgl-link-pick { max-width: 160px; }
.kgl-foot { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.kgl-details { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 20px; margin-top: 8px; padding: 12px; border-radius: var(--kpj-r-md); background: var(--kpj-hover); }
.kgl-num { width: 96px; }
.kgl-field-wide { flex: 1 1 100%; }
.kgl-field-wide .ktoggle { max-width: 520px; }
.kgl-helpers { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.kgl-archived { opacity: 0.72; }
.kgl-sub-adder { margin: 8px 0 0; }
@media (max-width: 599px) {
  .kgl-select { max-width: 100%; }
  .kgl-checkin-acts { margin-left: 0; }
  .kgl-composer .kgl-field > .kpj-field[type="number"] { width: 100%; }
  .kgl-composer > .kgl-field:not(.kgl-field-grow) { flex: 1 1 120px; }
}
`;

type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";
const GOAL_STATUS: Record<GoalStatus, { label: string; tone: Tone }> = {
  on_track: { label: "On track", tone: "ok" },
  at_risk: { label: "At risk", tone: "warn" },
  off_track: { label: "Off track", tone: "signal" },
  done: { label: "Achieved", tone: "accent" },
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;


/** An inline "add" row: a name field with Add and Cancel. */
function Adder({ label, placeholder, onAdd, onCancel, className }: { label: string; placeholder: string; onAdd: (name: string) => void; onCancel: () => void; className?: string }) {
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) onAdd(n); };
  return (
    <div className={className ? `kpj-adder ${className}` : "kpj-adder"}>
      {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
      <input autoFocus className="kpj-field" value={name} onChange={(e) => setName(e.target.value)} placeholder={placeholder} aria-label={label}
        onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }} />
      <Button variant="primary" onClick={add} disabled={!name.trim()}>Add</Button>
      <Button variant="ghost" onClick={onCancel}>Cancel</Button>
    </div>
  );
}

export interface GoalsViewProps {
  goals: Goal[];
  projects: Project[];
  /** the workspace's tasks, archived projects' included: a goal linked to a finished,
   *  archived project keeps reading that project's progress instead of dropping to 0% */
  tasks: Task[];
  onCreate: (name: string, extra?: GoalPatch) => void;
  onUpdate: (id: string, patch: GoalPatch) => void;
  onDelete: (id: string) => void;
  /** a guest: the goals to read, no controls (writes would only be refused) */
  readOnly?: boolean;
  /* ---- 0052: owners, quarters, check-ins and links (absent or null: not switched on) ---- */
  extras?: GoalExtras | null;
  /** the workspace these goals are in (null: Personal) */
  workspaceId?: string | null;
  /** who's looking, and their role in this workspace (null in Personal) */
  me?: string;
  role?: Role | null;
  /** the workspace's members: who can own a goal or help on one */
  members?: WorkspaceMember[];
  onCheckin?: (goal: Goal, value: number, confidence: number | null, note: string) => void;
  onDeleteCheckin?: (checkinId: string, goal: Goal) => void;
  onLink?: (goal: Goal, kind: GoalLinkKind, targetId: string) => void;
  onUnlink?: (link: GoalLink) => void;
  today?: Date;
}

export function GoalsView(props: GoalsViewProps) {
  const { goals, projects, tasks, onCreate, onUpdate, onDelete, readOnly = false, extras, me = "", role = null, members = [], today = KANBO_TODAY } = props;
  const v2 = !!extras;
  const who = { me, role };
  const [adding, setAdding] = useState(false);
  const [addingUnder, setAddingUnder] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // a leadership-only goal you can't see never reaches you live; in the demo it's held back here
  const visible = v2 ? goals.filter((g) => canSeeGoal(g, who)) : goals;
  const stable = useStableOrder(visible);
  const archivedCount = v2 ? visible.filter((g) => g.archivedAt).length : 0;
  const listed = showArchived ? stable : stable.filter((g) => !g.archivedAt);
  // the whole tree, any depth (a sub-goal's own sub-goals used to vanish)
  const ordered = goalTree(listed);
  // a linked project's % is its top-level tasks done, as on its own header (lib/countRules)
  const progress = goalProgressMap(visible, (pid) => projectPct(tasks, pid));
  const todayIso = toLocalISO(today);
  const checkinsOf = useMemo(() => {
    const m = new Map<string, GoalCheckin[]>();
    for (const c of extras?.checkins ?? []) { const a = m.get(c.goalId) ?? []; a.push(c); m.set(c.goalId, a); }
    return m;
  }, [extras]);
  const linksOf = (id: string) => (extras?.links ?? []).filter((l) => l.goalId === id);
  const wsId = props.workspaceId !== undefined ? props.workspaceId : (goals[0]?.workspaceId ?? null);
  const personal = wsId === null;
  const canNew = !v2 || canMakeCompanyGoal(wsId, role);
  const explainer = "Goals track a number you want to hit. Link one to a project and its progress fills in automatically.";
  if (readOnly) return <GoalsReadOnly ordered={goalTree(stable)} progress={progress} projects={realProjects} todayIso={todayIso} />;

  const quarter = quarterOf(today), qr = periodRange(quarter)!;
  const create = (name: string, parent?: Goal) => {
    if (!v2) { onCreate(name); return; }
    const team = !personal;
    const extra: GoalPatch = parent
      ? { parentId: parent.id, kind: "key_result", ...(team ? { ownerId: me } : {}), period: parent.period ?? null, periodStart: parent.periodStart ?? null, periodEnd: parent.periodEnd ?? null }
      : { kind: "objective", ...(team ? { ownerId: me } : {}), period: quarter, periodStart: qr.start, periodEnd: qr.end };
    onCreate(name, extra);
  };

  return (
    <div className="kpj-page">
      {v2 && <style>{GOALS_CSS}</style>}
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          {visible.length === 0 && !adding ? (
            <EmptyState art="target" title="No goals yet" body={canNew ? explainer : `${explainer} ${COMPANY_GOALS_RULE}`}
              action={canNew ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New goal</Button> : undefined} />
          ) : (
            <>
              <div className="kpj-toolbar">
                <p className="kpj-toolbar-note">
                  {explainer} {v2 ? (personal ? "Put goals under a parent to roll them up." : COMPANY_GOALS_RULE) : "Put goals under a parent to roll them up."}
                </p>
                {archivedCount > 0 && (
                  <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                    {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                  </Button>
                )}
                {canNew && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>New goal</Button>}
              </div>
              {adding && <Adder label="New goal name" placeholder="Goal name, e.g. Reach 1,000 active users" onAdd={(n) => { create(n); setAdding(false); }} onCancel={() => setAdding(false)} />}
              <div className="kpj-stack">
                {ordered.map(({ g, depth }) => {
                  const editable = !v2 || canEditGoal(g, who);
                  return (
                    <GoalCard key={g.id} g={g} depth={depth} goals={visible} ordered={ordered} progress={progress.get(g.id) ?? { pct: 0, source: "manual", children: 0 }}
                      realProjects={realProjects} tasks={tasks} todayIso={todayIso} today={today} v2={v2} editable={editable}
                      canHandOver={v2 && canHandOverGoal(g, who)} canAddUnder={v2 && !g.archivedAt && canPlaceGoal(g.workspaceId ?? null, g, who)}
                      canTopLevel={canNew} placeable={(p) => !v2 || canPlaceGoal(p.workspaceId ?? null, p, who)}
                      members={members} me={me} isAdmin={role === "owner" || role === "admin"}
                      checkins={checkinsOf.get(g.id) ?? []} links={linksOf(g.id)} props={props}
                      addingUnder={addingUnder === g.id} onAddUnder={(open) => setAddingUnder(open ? g.id : null)}
                      onCreateUnder={(name) => { create(name, g); setAddingUnder(null); }} />
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

/** One goal: fields for those who may change it, the same facts to read for everyone else. */
function GoalCard({ g, depth, goals, ordered, progress: prog, realProjects, tasks, todayIso, today, v2, editable, canHandOver, canAddUnder, canTopLevel, placeable,
  members, me, isAdmin, checkins, links, props, addingUnder, onAddUnder, onCreateUnder }: {
  g: Goal; depth: number; goals: Goal[]; ordered: { g: Goal; depth: number }[]; progress: GoalProgress;
  realProjects: Project[]; tasks: Task[]; todayIso: string; today: Date; v2: boolean; editable: boolean; canHandOver: boolean;
  canAddUnder: boolean; canTopLevel: boolean; placeable: (parent: Goal) => boolean;
  members: WorkspaceMember[]; me: string; isAdmin: boolean;
  checkins: GoalCheckin[]; links: GoalLink[]; props: GoalsViewProps;
  addingUnder: boolean; onAddUnder: (open: boolean) => void; onCreateUnder: (name: string) => void;
}) {
  const { onUpdate, onDelete } = props;
  const [details, setDetails] = useState(false);
  const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
  const pct = prog.pct;
  const linkedProject = linkedOf(g, realProjects);
  const update = (patch: GoalPatch) => onUpdate(g.id, patch);
  // a goal can't sit under itself or anything nested beneath it (nor, with 0052, under one you can't edit)
  const blocked = goalDescendants(goals, g.id); blocked.add(g.id);
  const parentOptions = ordered.filter((o) => !blocked.has(o.g.id) && (o.g.id === g.parentId || placeable(o.g)));
  const parentValue = g.parentId && goals.some((x) => x.id === g.parentId) ? g.parentId : "";
  const childCount = goals.filter((x) => x.parentId === g.id && x.id !== g.id).length;
  const overdue = !!g.due && g.due < todayIso && g.status !== "done" && pct < 100;
  const read = goalPace(g, pct, today);
  const numOr0 = (v: string) => { const n = Number(v); return v.trim() === "" || !isFinite(n) ? 0 : n; };
  // save a typed number (blank → 0) only when it differs, and show it as stored
  const saveNum = (key: "current" | "target", v: string) => {
    const n = numOr0(v);
    if (n !== (g[key] ?? 0)) update(key === "current" ? { current: n } : { target: n });
    return String(n);
  };
  const ownNumber = prog.source === "manual";
  return (
    <article className={`kpj-card kpj-goal${g.archivedAt ? " kgl-archived" : ""}`} data-depth={depth || undefined} aria-label={`Goal ${g.name}`}
      style={depth ? ({ "--depth": Math.min(depth, 5) } as React.CSSProperties) : undefined}>
      <div className="kpj-card-head">
        {depth > 0 && <Icon name="arrowRight" size={14} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />}
        {editable
          ? <DraftInput value={g.name} required label={`Goal name: ${g.name}`} onCommit={(v) => update({ name: v })} className="kpj-name-input" />
          : <h3 className="kpj-name-static" style={{ margin: 0 }}>{g.name}</h3>}
        <div className="kpj-card-side">
          {g.archivedAt && <Pill tone="neutral">Archived</Pill>}
          {editable ? (
            <select className="kpj-field kpj-goal-status" data-size="sm" data-tone={meta.tone} value={g.status}
              onChange={(e) => update({ status: e.target.value as GoalStatus })} aria-label={`Status of ${g.name}`}>
              {(Object.keys(GOAL_STATUS) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS[s].label}</option>)}
            </select>
          ) : <Pill tone={meta.tone}>{meta.label}</Pill>}
          {editable && v2 && (
            <IconButton icon={g.archivedAt ? "undo" : "archive"} size="sm" label={g.archivedAt ? `Restore goal ${g.name}` : `Archive goal ${g.name}`}
              onClick={() => update({ archivedAt: g.archivedAt ? null : new Date().toISOString() })} />
          )}
          {editable && (
            <IconButton icon="trash" size="sm" tone="danger" label={`Delete goal ${g.name}`} onClick={() => {
              const msg = childCount
                ? `Delete goal “${g.name}”? Its ${plural(childCount, "sub-goal")} will move up to the top level. This can't be undone.`
                : `Delete goal “${g.name}”? This can't be undone.`;
              if (window.confirm(msg)) onDelete(g.id);
            }} />
          )}
        </div>
      </div>
      {editable ? (
        <DraftInput value={g.description ?? ""} placeholder="Add a description" label={`Description of ${g.name}`} multiline
          onCommit={(v) => update({ description: v })} className="kpj-name-input kpj-goal-desc" />
      ) : g.description ? <p className="kpj-goal-desc-text">{g.description}</p> : null}
      {v2 && <GoalMetaRow goal={g} members={members} canHandOver={canHandOver} canEdit={editable} today={today} onUpdate={update} />}
      <div className="kpj-card-row">
        {editable ? (
          <>
            <select className="kpj-field" data-size="sm" value={g.projectId ?? ""} onChange={(e) => update({ projectId: e.target.value || undefined })} style={{ maxWidth: 220 }} aria-label={`Project linked to ${g.name}`}>
              <option value="">Not linked to a project</option>
              {g.projectId && !realProjects.some((p) => p.id === g.projectId) && <option value={g.projectId}>↪ {linkedProject?.name ?? "Archived project"}</option>}
              {realProjects.map((p) => <option key={p.id} value={p.id}>↪ {p.name}</option>)}
            </select>
            {goals.length > 1 && (parentOptions.length > 0 || parentValue) && (
              <select className="kpj-field" data-size="sm" value={parentValue} onChange={(e) => update({ parentId: e.target.value || undefined })} style={{ maxWidth: 240 }} aria-label={`Parent goal of ${g.name}`}>
                {(canTopLevel || !parentValue) && <option value="">No parent goal</option>}
                {parentOptions.map((o) => <option key={o.g.id} value={o.g.id}>{"  ".repeat(o.depth)}Under: {o.g.name}</option>)}
              </select>
            )}
            <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} placeholder="Add a due date" tone="plain"
              onChange={(d) => update({ due: d || undefined })} />
          </>
        ) : g.due ? <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} tone="plain" readOnly onChange={() => undefined} /> : null}
        {overdue && <Pill tone="signal">Overdue</Pill>}
      </div>
      {ownNumber && (editable ? (
        <div className="kpj-card-row">
          <span className="kpj-goal-nums">
            <DraftInput type="number" value={g.current ?? 0} label={`Current value for ${g.name}`} onCommit={(v) => saveNum("current", v)} className="kpj-field kpj-mono" />
            <span className="kpj-slash" aria-hidden="true">/</span>
            <DraftInput type="number" value={g.target ?? 0} label={`Target for ${g.name}`} onCommit={(v) => saveNum("target", v)} className="kpj-field kpj-mono" />
            <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => update({ unit: v })} className="kpj-field" />
          </span>
          {v2 && g.startValue != null && (
            <span className="kpj-card-meta">From {fmtGoalValue(g.startValue, g.unit)}{g.direction === "lower" ? " · lower is better" : ""}</span>
          )}
        </div>
      ) : (g.target ?? 0) !== 0 ? (
        <div className="kpj-card-row"><span className="kpj-card-meta">{numbersLine(g)}</span></div>
      ) : null)}
      <div className="kpj-goal-progress">
        <Meter value={pct} height={6} label={`${g.name} progress`} />
        <span className="kpj-mono">{pct}%</span>
      </div>
      <GoalPaceLine goal={g} read={read} canEdit={editable} onAccept={(status) => update({ status })} />
      <GoalSource prog={prog} linked={linkedProject} weighted={goals.some((x) => x.parentId === g.id && !x.archivedAt && x.weight != null && x.weight !== 1)} />
      {v2 && (checkins.length > 0 || (ownNumber && editable && !!props.onCheckin)) && (
        <GoalCheckins goal={g} checkins={checkins} members={members} canEdit={editable} canPost={ownNumber && !!props.onCheckin} today={today} me={me} isAdmin={isAdmin}
          onPost={(value, confidence, note) => props.onCheckin?.(g, value, confidence, note)}
          onRemove={(c) => props.onDeleteCheckin?.(c.id, g)} />
      )}
      {v2 && (
        <GoalLinks goal={g} links={links} projects={realProjects} tasks={tasks} canEdit={editable && !!props.onLink}
          onLink={(kind, id) => props.onLink?.(g, kind, id)} onUnlink={(l) => props.onUnlink?.(l)} />
      )}
      {v2 && (editable || canAddUnder) && (
        <div className="kgl-foot">
          {editable && (
            <Button size="sm" variant="ghost" icon={details ? "chevronDown" : "chevronRight"} aria-expanded={details} onClick={() => setDetails((v) => !v)}>
              {details ? "Fewer details" : "More details"}
            </Button>
          )}
          {canAddUnder && !addingUnder && <Button size="sm" variant="ghost" icon="plus" onClick={() => onAddUnder(true)}>Add a key result</Button>}
        </div>
      )}
      {v2 && details && editable && <GoalDetails goal={g} members={members} canEdit={editable} canHandOver={canHandOver} onUpdate={update} />}
      {addingUnder && (
        <Adder className="kgl-sub-adder" label={`New key result under ${g.name}`} placeholder="Key result, e.g. Cut churn from 8% to 5%"
          onAdd={onCreateUnder} onCancel={() => onAddUnder(false)} />
      )}
    </article>
  );
}

/** A goal's numbers in words: "3,760 of 5,000 users, from 3,200" or "6.6%, down to 5%, from 8%". */
function numbersLine(g: Goal): string {
  const now = g.current ?? g.startValue ?? 0;
  const head = g.direction === "lower" ? `${fmtGoalValue(now, g.unit)}, down to ${fmtGoalValue(g.target, g.unit)}`
    : g.unit && !/^[£$€%]/.test(g.unit) ? `${fmtGoalValue(now)} of ${fmtGoalValue(g.target, g.unit)}` : `${fmtGoalValue(now, g.unit)} of ${fmtGoalValue(g.target, g.unit)}`;
  return g.startValue != null && g.startValue !== 0 ? `${head}, from ${fmtGoalValue(g.startValue, g.unit)}` : head;
}

/** The project a goal is linked to, archived ones included (they keep their progress). */
function linkedOf(g: Goal, projects: Project[]): Project | undefined {
  return g.projectId ? (getProject(g.projectId) ?? projects.find((p) => p.id === g.projectId)) : undefined;
}

/** Where a goal's % comes from: its project (top-level tasks done), its sub-goals, or its own number. */
function GoalSource({ prog, linked, weighted }: { prog: GoalProgress; linked?: Project; weighted?: boolean }) {
  return (
    <div style={{ marginTop: 6 }}>
      {prog.source === "project" && (
        <span className="kpj-goal-source" title="The share of the project's tasks that are done (sub-tasks count with their parent)">
          From project {linked?.name ?? "—"}{linked?.archivedAt ? " (archived)" : ""}
        </span>
      )}
      {prog.source === "subgoals" && <span className="kpj-goal-source" title="Enter a current value to track this goal's own number instead">{weighted ? "Weighted average" : "Average"} of {plural(prog.children, "sub-goal")}</span>}
      {prog.source === "manual" && prog.subPct !== undefined && <span className="kpj-goal-source">Own value · {plural(prog.children, "sub-goal")} {weighted ? "weighted average" : "average"} {prog.subPct}%</span>}
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
