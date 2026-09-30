/* ============================================================
   KANBO — Goals (OKRs) and Portfolios: objectives with their
   progress, and projects rolled up with their health
   ============================================================ */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, Avatar, EmptyArt } from "../primitives";
import { getProject, getMember, projectProgress, KANBO_TODAY, toLocalISO } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind, StatusUpdate } from "../../data/types";
import { fmtDayMonth, goalDescendants, goalProgressMap, goalTree, projectHealth, useStableOrder, type GoalProgress, type HealthKind } from "./reportingUtils";

const inp: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" };
/* progress / capacity tracks: a visible well on white cards in the light theme */
const TRACK = "var(--track, var(--surface-2))";
const nameInput: CSSProperties = { flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)", padding: "2px 0" };
const closeBtn: CSSProperties = { border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px", borderRadius: 6, flexShrink: 0 };
const fmtDay = fmtDayMonth;

const GOAL_STATUS: Record<GoalStatus, { label: string; color: string }> = {
  on_track: { label: "On track", color: "var(--st-done)" },
  at_risk: { label: "At risk", color: "var(--st-review)" },
  off_track: { label: "Off track", color: "var(--prio-urgent)" },
  done: { label: "Achieved", color: "var(--st-progress)" },
};
export const STATUS_KIND_META: Record<StatusKind, { label: string; color: string }> = {
  on_track: { label: "On track", color: "var(--st-done)" },
  at_risk: { label: "At risk", color: "var(--st-review)" },
  off_track: { label: "Off track", color: "var(--prio-urgent)" },
};

function EmptyState({ icon, title, sub }: { icon: "target" | "briefcase" | "chart"; title: string; sub: string }) {
  return (
    <div style={{ textAlign: "center", padding: "70px 24px", color: "var(--ink-4)" }}>
      <div style={{ marginBottom: 14 }}><EmptyArt kind={icon} /></div>
      <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>{title}</p>
      <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}

/** Small coloured status pill (RAG health, status updates). */
function Pill({ color, title, children }: { color: string; title?: string; children: ReactNode }) {
  return (
    <span title={title} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "2px 8px", borderRadius: 99, fontSize: 11.5, fontFamily: "var(--font-display)", whiteSpace: "nowrap", color, background: `color-mix(in oklch, ${color} 13%, transparent)`, border: `1px solid color-mix(in oklch, ${color} 30%, transparent)` }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, background: color, flexShrink: 0 }} />{children}
    </span>
  );
}

/** A field that edits a local draft and saves once — on blur or Enter; Escape
 *  reverts. Saving on every keystroke sent ~25 UPDATEs per name, and a
 *  realtime reload in between could revert the field mid-word.
 *  Only a value the user actually typed is ever saved: focusing a field and
 *  leaving it never writes, so a teammate's change that arrives meanwhile
 *  shows up and is kept. */
function DraftInput({ value, onCommit, label, style, type = "text", placeholder, required = false, min, max, title }: {
  value: string | number | undefined;
  /** save the typed value. Return false to reject it (the field shows the
   *  saved value again), or a string to show the value as it was stored. */
  onCommit: (v: string) => void | string | false;
  label: string;
  style?: CSSProperties;
  type?: "text" | "number";
  placeholder?: string;
  /** an empty value reverts instead of saving (names can't be blank) */
  required?: boolean;
  min?: number;
  max?: number;
  title?: string;
}) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);
  // true once the user has typed; until then the field keeps following `value`
  const dirty = useRef(false);
  const cancelled = useRef(false);
  // follow outside changes (another tab, a teammate) — but never over unsaved typing
  useEffect(() => { if (!dirty.current) setDraft(external); }, [external]);
  const commit = () => {
    const typed = dirty.current, escaped = cancelled.current;
    dirty.current = false; cancelled.current = false;
    if (!typed || escaped) { setDraft(external); return; }
    const v = type === "text" ? draft.trim() : draft;
    if ((required && !v) || v === external) { setDraft(external); return; }
    const shown = onCommit(v);
    setDraft(shown === false ? external : typeof shown === "string" ? shown : v);
  };
  return (
    <input type={type} value={draft} min={min} max={max} title={title} placeholder={placeholder} aria-label={label} style={style}
      onChange={(e) => { dirty.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
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
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) { onCreate(n); setName(""); setAdding(false); } };
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
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Track measurable objectives — link a project for automatic progress, or nest sub-goals: a parent with no current value of its own shows their average.</p>
        <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New goal</button>
      </div>
      {adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Goal name, e.g. Reach 1,000 active users" aria-label="New goal name" style={{ ...inp, flex: 1 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {goals.length === 0 && !adding ? <EmptyState icon="target" title="No goals yet" sub="Create a goal to track progress toward an outcome." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ordered.map(({ g, depth }) => {
            const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
            const prog: GoalProgress = progress.get(g.id) ?? { pct: 0, source: "manual", children: 0 };
            const pct = prog.pct;
            const linkedProject = g.projectId ? getProject(g.projectId) : undefined;
            // a goal can't sit under itself or anything nested beneath it
            const blocked = goalDescendants(goals, g.id); blocked.add(g.id);
            const parentOptions = ordered.filter((o) => !blocked.has(o.g.id));
            const parentValue = g.parentId && goals.some((x) => x.id === g.parentId) ? g.parentId : "";
            const childCount = goals.filter((x) => x.parentId === g.id && x.id !== g.id).length;
            const overdue = !!g.due && g.due < todayIso && g.status !== "done" && pct < 100;
            return (
              <div key={g.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px", marginLeft: depth ? `min(${Math.min(depth, 5) * 24}px, ${Math.min(depth, 5) * 4}vw)` : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {depth > 0 && <Icon name="arrowRight" size={13} style={{ color: "var(--ink-4)", flexShrink: 0 }} />}
                  <DraftInput value={g.name} required label={`Goal name: ${g.name}`} onCommit={(v) => onUpdate(g.id, { name: v })} style={nameInput} />
                  <select value={g.status} onChange={(e) => onUpdate(g.id, { status: e.target.value as GoalStatus })} aria-label={`Status of ${g.name}`} style={{ ...inp, height: 28, color: meta.color }}>
                    {(Object.keys(GOAL_STATUS) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS[s].label}</option>)}
                  </select>
                  <button onClick={() => {
                    const msg = childCount
                      ? `Delete goal “${g.name}”? Its ${childCount} sub-goal${childCount === 1 ? "" : "s"} will move up to the top level. This can't be undone.`
                      : `Delete goal “${g.name}”? This can't be undone.`;
                    if (window.confirm(msg)) onDelete(g.id);
                  }} aria-label={`Delete goal ${g.name}`} style={closeBtn}>×</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0", flexWrap: "wrap" }}>
                  <select value={g.projectId ?? ""} onChange={(e) => onUpdate(g.id, { projectId: e.target.value || undefined })} style={{ ...inp, maxWidth: 200 }} aria-label={`Project linked to ${g.name}`}>
                    <option value="">Not linked to a project</option>
                    {g.projectId && !realProjects.some((p) => p.id === g.projectId) && <option value={g.projectId}>↪ {linkedProject?.name ?? "Archived project"}</option>}
                    {realProjects.map((p) => <option key={p.id} value={p.id}>↪ {p.name}</option>)}
                  </select>
                  {goals.length > 1 && (
                    <select value={parentValue} onChange={(e) => onUpdate(g.id, { parentId: e.target.value || undefined })} style={{ ...inp, maxWidth: 220 }} aria-label={`Parent goal of ${g.name}`}>
                      <option value="">No parent goal</option>
                      {parentOptions.map((o) => <option key={o.g.id} value={o.g.id}>{"  ".repeat(o.depth)}Under: {o.g.name}</option>)}
                    </select>
                  )}
                  <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--ink-4)" }}>
                    Due
                    <input type="date" value={g.due ?? ""} onChange={(e) => onUpdate(g.id, { due: e.target.value || undefined })} aria-label={`Due date for ${g.name}`}
                      style={{ ...inp, height: 30, fontFamily: "var(--font-mono)", fontSize: 12, color: overdue ? "var(--prio-urgent)" : "var(--ink-2)" }} />
                  </label>
                  {overdue && <Pill color="var(--prio-urgent)">Overdue</Pill>}
                </div>
                {prog.source !== "project" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8, flexWrap: "wrap" }}>
                    <DraftInput type="number" value={g.current ?? 0} label={`Current value for ${g.name}`} onCommit={(v) => saveNum(g, "current", v)} style={{ ...inp, width: 90 }} />
                    <span style={{ color: "var(--ink-4)", fontSize: 13 }}>/</span>
                    <DraftInput type="number" value={g.target ?? 0} label={`Target for ${g.name}`} onCommit={(v) => saveNum(g, "target", v)} style={{ ...inp, width: 90 }} />
                    <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => onUpdate(g.id, { unit: v })} style={{ ...inp, width: 90 }} />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  {prog.source === "project" && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>From project {linkedProject?.name ?? "—"}</span>}
                  {prog.source === "subgoals" && <span style={{ fontSize: 12, color: "var(--ink-4)" }} title="Enter a current value to track this goal's own number instead">Average of {prog.children} sub-goal{prog.children === 1 ? "" : "s"}</span>}
                  {prog.source === "manual" && prog.subPct !== undefined && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Own value · {prog.children} sub-goal{prog.children === 1 ? "" : "s"} average {prog.subPct}%</span>}
                  <span className="mono tnum" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, color: meta.color }}>{pct}%</span>
                </div>
                <div role="progressbar" aria-label={`${g.name} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 9, borderRadius: 6, background: TRACK, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", borderRadius: 6, background: meta.color, transition: "width .6s var(--ease)" }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- PORTFOLIOS ---------------- */
const HEALTH_COLOR: Record<HealthKind, string> = {
  complete: "var(--st-done)",
  on_track: "var(--st-done)",
  at_risk: "var(--st-review)",
  off_track: "var(--prio-urgent)",
};
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
  const [name, setName] = useState("");
  const [pickFor, setPickFor] = useState<string | null>(null);
  const add = () => { const n = name.trim(); if (n) { onCreate(n); setName(""); setAdding(false); } };
  const ordered = useStableOrder(portfolios);
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Group projects and watch their combined progress and health.</p>
        <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New portfolio</button>
      </div>
      {adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Portfolio name, e.g. Q3 initiatives" aria-label="New portfolio name" style={{ ...inp, flex: 1 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {portfolios.length === 0 && !adding ? <EmptyState icon="briefcase" title="No portfolios yet" sub="Create a portfolio to roll up several projects." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ordered.map((pf) => {
            const inPf = pf.projectIds.map((pid) => getProject(pid)).filter((p): p is Project => !!p);
            const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id));
            const rows = inPf.map((p) => {
              const ptasks = tasks.filter((t) => t.projectId === p.id && !t.archivedAt);
              return { p, ptasks, health: projectHealth(ptasks, KANBO_TODAY), latest: statusUpdates.find((u) => u.projectId === p.id) };
            });
            const allTasks = rows.reduce((a, r) => a + r.ptasks.length, 0);
            const allDone = rows.reduce((a, r) => a + r.ptasks.filter((t) => t.status === "done").length, 0);
            const combined = allTasks ? Math.round((allDone / allTasks) * 100) : 0;
            const offN = rows.filter((r) => r.health?.kind === "off_track").length;
            const riskN = rows.filter((r) => r.health?.kind === "at_risk").length;
            const picking = pickFor === pf.id;
            return (
              <div key={pf.id} className="glass" style={{ borderRadius: 16, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
                  <Icon name="briefcase" size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
                  <DraftInput value={pf.name} required label={`Portfolio name: ${pf.name}`} onCommit={(v) => onUpdate(pf.id, { name: v })} style={{ ...nameInput, flex: "1 1 160px" }} />
                  {inPf.length > 0 && <span className="mono tnum" style={{ fontSize: 12, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{combined}% · {inPf.length} project{inPf.length === 1 ? "" : "s"}</span>}
                  {offN > 0 && <Pill color={HEALTH_COLOR.off_track}>{offN} off track</Pill>}
                  {riskN > 0 && <Pill color={HEALTH_COLOR.at_risk}>{riskN} at risk</Pill>}
                  <button onClick={() => setPickFor((x) => x === pf.id ? null : pf.id)} aria-expanded={picking} aria-label={`Add a project to ${pf.name}`} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}><Icon name="plus" size={14} /> Project</button>
                  <button onClick={() => { if (window.confirm(`Delete portfolio “${pf.name}”? The projects themselves are kept. This can't be undone.`)) onDelete(pf.id); }} aria-label={`Delete portfolio ${pf.name}`} style={closeBtn}>×</button>
                </div>
                {picking && (available.length > 0 ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {available.map((p) => (
                      <button key={p.id} onClick={() => { onUpdate(pf.id, { projectIds: [...pf.projectIds, p.id] }); setPickFor(null); }} aria-label={`Add ${p.name} to ${pf.name}`} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", fontSize: 12.5, color: "var(--ink-2)", fontFamily: "var(--font-display)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {p.name}
                      </button>
                    ))}
                  </div>
                ) : <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: "0 0 12px" }}>Every project in this workspace is already in this portfolio.</p>)}
                {rows.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No projects yet — add one above.</p>
                ) : rows.map(({ p, ptasks, health, latest }) => {
                  const pct = projectProgress(tasks, p.id);
                  const count = ptasks.filter((t) => !t.parentId).length;
                  const ownerName = p.ownerId ? (getMember(p.ownerId)?.name ?? "(former member)") : null;
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderTop: "1px solid var(--hairline)", flexWrap: "wrap" }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                      <button onClick={() => onOpenProject(p.id)} className="truncate" aria-label={`Open project ${p.name}`} style={{ flex: "1 1 150px", minWidth: 0, textAlign: "left", border: "none", background: "transparent", cursor: "pointer", fontSize: 13.5, color: "var(--ink)", fontFamily: "var(--font-display)", padding: "2px 0", borderRadius: 6 }}>{p.name}</button>
                      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginLeft: "auto", justifyContent: "flex-end" }}>
                        {health && <Pill color={HEALTH_COLOR[health.kind]} title={`Auto health: ${health.detail}`}>{health.label}</Pill>}
                        {latest && (
                          <Pill color={STATUS_KIND_META[latest.status]?.color ?? "var(--ink-4)"} title={`Latest status update (${fmtDay(new Date(latest.createdAt))}): ${latest.summary}`}>
                            Update: {STATUS_KIND_META[latest.status]?.label ?? latest.status}
                          </Pill>
                        )}
                        {ownerName && (
                          <span title={`Owner: ${ownerName}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, maxWidth: 130 }}>
                            <Avatar id={p.ownerId!} size={18} />
                            <span className="truncate" style={{ fontSize: 12, color: "var(--ink-3)" }}>{ownerName}</span>
                          </span>
                        )}
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)", whiteSpace: "nowrap" }}>
                          {count} task{count === 1 ? "" : "s"}{health && health.overdue > 0 && <span style={{ color: "var(--prio-urgent)" }}> · {health.overdue} overdue</span>}
                        </span>
                        <div role="progressbar" aria-label={`${p.name} progress`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ width: 90, height: 8, borderRadius: 6, background: TRACK, overflow: "hidden", flexShrink: 0 }}>
                          <div style={{ width: `${pct}%`, height: "100%", borderRadius: 6, background: "var(--accent)" }} />
                        </div>
                        <span className="mono tnum" style={{ width: 36, textAlign: "right", fontSize: 12, color: "var(--ink-3)" }}>{pct}%</span>
                        <button onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((id) => id !== p.id) })} aria-label={`Remove ${p.name} from ${pf.name}`} style={{ ...closeBtn, fontSize: 14 }}>×</button>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
