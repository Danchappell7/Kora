/* ============================================================
   KANBO — manager / reporting views: Workload, Goals (OKRs), Portfolios.
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar } from "../primitives";
import { getProject, getMember, projectProgress } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind, Section, AutomationRule, AutomationAction, AutomationActionType, FormDef, FormFieldKey } from "../../data/types";

const inp: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" };

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
      <div style={{ display: "inline-flex", padding: 14, borderRadius: 16, background: "var(--surface)", border: "1px solid var(--hairline)", marginBottom: 14 }}><Icon name={icon} size={24} style={{ color: "var(--ink-4)" }} /></div>
      <p style={{ fontSize: 14.5, color: "var(--ink-2)", margin: 0, fontWeight: 600 }}>{title}</p>
      <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>{sub}</p>
    </div>
  );
}

/* ---------------- WORKLOAD ---------------- */
export function WorkloadView({ tasks, members, onOpen }: {
  tasks: Task[];
  members: { id: string; name: string }[];
  onOpen: (id: string) => void;
}) {
  const CAP = 40; // assumed weekly capacity, hours
  const open = tasks.filter((t) => t.status !== "done" && !t.archivedAt);
  const byPerson = new Map<string, { hours: number; tasks: Task[] }>();
  open.forEach((t) => {
    const cur = byPerson.get(t.assigneeId) ?? { hours: 0, tasks: [] };
    cur.hours += t.effortHours ?? 0; cur.tasks.push(t);
    byPerson.set(t.assigneeId, cur);
  });
  // include known members even with no load, then sort by hours
  members.forEach((m) => { if (!byPerson.has(m.id)) byPerson.set(m.id, { hours: 0, tasks: [] }); });
  const rows = [...byPerson.entries()].map(([id, v]) => ({ id, ...v })).sort((a, b) => b.hours - a.hours);
  const HEAVY = 12; // open-task count that signals overload even without hour estimates
  const overloaded = rows.filter((r) => r.hours > CAP || r.tasks.length >= HEAVY);
  // rebalance hint: the busiest person + a teammate who clearly has room
  const freeest = [...rows].filter((r) => members.some((m) => m.id === r.id)).sort((a, b) => (a.hours - b.hours) || (a.tasks.length - b.tasks.length))[0];
  const rebalance = overloaded.length && freeest && freeest.id !== overloaded[0].id && freeest.hours < CAP * 0.6 && freeest.tasks.length < HEAVY
    ? { from: getMember(overloaded[0].id)?.name || "Someone", to: getMember(freeest.id)?.name || "a teammate" }
    : null;
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <p style={{ fontSize: 13, color: "var(--ink-4)", margin: "0 0 16px" }}>Estimated open work per person (assumes ~{CAP}h capacity). Set an estimate on a task to feed this.</p>
      {overloaded.length > 0 && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", marginBottom: 14, borderRadius: 12, background: "color-mix(in oklch, var(--prio-urgent) 10%, transparent)", border: "1px solid color-mix(in oklch, var(--prio-urgent) 28%, transparent)" }}>
          <Icon name="zap" size={16} style={{ color: "var(--prio-urgent)", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--prio-urgent)" }}>{overloaded.length} {overloaded.length === 1 ? "person looks" : "people look"} overloaded.</strong>{" "}
            {overloaded.map((r) => getMember(r.id)?.name || "Unassigned").slice(0, 3).join(", ")}{overloaded.length > 3 ? ` +${overloaded.length - 3} more` : ""} {overloaded.length === 1 ? "is" : "are"} over capacity or carrying a lot of open work.
            {rebalance && <> Consider moving a task or two from <strong>{rebalance.from}</strong> to <strong>{rebalance.to}</strong>, who has room.</>}
          </div>
        </div>
      )}
      {rows.length === 0 ? <EmptyState icon="chart" title="No workload yet" sub="Assign tasks and give them an hours estimate to see capacity." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => {
            const over = r.hours > CAP;
            const heavy = !over && r.tasks.length >= HEAVY;
            const pct = Math.min(100, CAP ? (r.hours / CAP) * 100 : 0);
            const name = getMember(r.id)?.name || "Unassigned";
            return (
              <div key={r.id} className="glass" style={{ borderRadius: 14, padding: "13px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, cursor: r.tasks.length ? "pointer" : "default" }} onClick={() => setExpanded((e) => e === r.id ? null : r.id)}>
                  <Avatar id={r.id} size={26} />
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{name}</span>
                  <span className="mono tnum" style={{ fontSize: 12.5, color: over || heavy ? "var(--prio-urgent)" : "var(--ink-3)" }}>{r.hours}h · {r.tasks.length} task{r.tasks.length === 1 ? "" : "s"}</span>
                </div>
                <div style={{ marginTop: 9, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ width: `${heavy ? 100 : pct}%`, height: "100%", borderRadius: 6, background: over || heavy ? "var(--prio-urgent)" : "var(--accent)", transition: "width .6s var(--ease)" }} />
                </div>
                {over && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Over capacity by {r.hours - CAP}h</div>}
                {heavy && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Heavy load — {r.tasks.length} open tasks</div>}
                {expanded === r.id && r.tasks.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {r.tasks.map((t) => (
                      <button key={t.id} onClick={(e) => { e.stopPropagation(); onOpen(t.id); }} className="lift-row" style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)" }}>
                        <span className="truncate" style={{ flex: 1 }}>{t.title}</span>
                        <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{t.effortHours ? `${t.effortHours}h` : "—"}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
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
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) { onCreate(n); setName(""); setAdding(false); } };
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // order: top-level goals, each followed by its sub-goals (one level deep)
  const tops = goals.filter((g) => !g.parentId || !goals.some((x) => x.id === g.parentId));
  const ordered: { g: Goal; depth: number }[] = [];
  tops.forEach((g) => { ordered.push({ g, depth: 0 }); goals.filter((c) => c.parentId === g.id && c.id !== g.id).forEach((c) => ordered.push({ g: c, depth: 1 })); });
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Track measurable objectives — link a project for auto-progress, or nest sub-goals.</p>
        <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New goal</button>
      </div>
      {adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Goal name, e.g. Reach 1,000 active users" style={{ ...inp, flex: 1 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {goals.length === 0 && !adding ? <EmptyState icon="target" title="No goals yet" sub="Create a goal to track progress toward an outcome." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {ordered.map(({ g, depth }) => {
            const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
            const linked = !!g.projectId;
            const pct = linked ? projectProgress(tasks, g.projectId!) : (g.target && g.target > 0 ? Math.min(100, Math.round(((g.current ?? 0) / g.target) * 100)) : 0);
            return (
              <div key={g.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px", marginLeft: depth * 24 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {depth > 0 && <Icon name="arrowRight" size={13} style={{ color: "var(--ink-4)" }} />}
                  <input value={g.name} onChange={(e) => onUpdate(g.id, { name: e.target.value })} style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)" }} />
                  <select value={g.status} onChange={(e) => onUpdate(g.id, { status: e.target.value as GoalStatus })} style={{ ...inp, height: 28, color: meta.color }}>
                    {(Object.keys(GOAL_STATUS) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS[s].label}</option>)}
                  </select>
                  <button onClick={() => onDelete(g.id)} aria-label="Delete goal" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16 }}>×</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "10px 0", flexWrap: "wrap" }}>
                  <select value={g.projectId ?? ""} onChange={(e) => onUpdate(g.id, { projectId: e.target.value || undefined })} style={{ ...inp, maxWidth: 180 }} aria-label="Linked project">
                    <option value="">Not linked to a project</option>
                    {realProjects.map((p) => <option key={p.id} value={p.id}>↪ {p.name}</option>)}
                  </select>
                  {depth === 0 && tops.length > 1 && (
                    <select value={g.parentId ?? ""} onChange={(e) => onUpdate(g.id, { parentId: e.target.value || undefined })} style={{ ...inp, maxWidth: 160 }} aria-label="Parent goal">
                      <option value="">No parent goal</option>
                      {goals.filter((x) => x.id !== g.id && !x.parentId).map((x) => <option key={x.id} value={x.id}>under: {x.name}</option>)}
                    </select>
                  )}
                </div>
                {!linked && (
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8 }}>
                    <input type="number" value={g.current ?? 0} onChange={(e) => onUpdate(g.id, { current: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inp, width: 90 }} aria-label="Current" />
                    <span style={{ color: "var(--ink-4)", fontSize: 13 }}>/</span>
                    <input type="number" value={g.target ?? 0} onChange={(e) => onUpdate(g.id, { target: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inp, width: 90 }} aria-label="Target" />
                    <input value={g.unit ?? ""} onChange={(e) => onUpdate(g.id, { unit: e.target.value })} placeholder="unit" style={{ ...inp, width: 90 }} aria-label="Unit" />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  {linked && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>From project {getProject(g.projectId!)?.name}</span>}
                  <span className="mono tnum" style={{ marginLeft: "auto", fontSize: 13, fontWeight: 600, color: meta.color }}>{pct}%</span>
                </div>
                <div style={{ height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
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
export function PortfoliosView({ portfolios, projects, tasks, onCreate, onUpdate, onDelete, onOpenProject }: {
  portfolios: Portfolio[];
  projects: Project[];
  tasks: Task[];
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: { name?: string; projectIds?: string[] }) => void;
  onDelete: (id: string) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [pickFor, setPickFor] = useState<string | null>(null);
  const add = () => { const n = name.trim(); if (n) { onCreate(n); setName(""); setAdding(false); } };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Group projects and watch their combined progress.</p>
        <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New portfolio</button>
      </div>
      {adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8 }}>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Portfolio name, e.g. Q3 initiatives" style={{ ...inp, flex: 1 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {portfolios.length === 0 && !adding ? <EmptyState icon="briefcase" title="No portfolios yet" sub="Create a portfolio to roll up several projects." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {portfolios.map((pf) => {
            const members = pf.projectIds.map((pid) => getProject(pid)).filter((p): p is Project => !!p);
            const available = projects.filter((p) => p.id !== "p-personal" && !pf.projectIds.includes(p.id));
            return (
              <div key={pf.id} className="glass" style={{ borderRadius: 16, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <Icon name="briefcase" size={16} style={{ color: "var(--accent)" }} />
                  <input value={pf.name} onChange={(e) => onUpdate(pf.id, { name: e.target.value })} style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)" }} />
                  <button onClick={() => setPickFor((x) => x === pf.id ? null : pf.id)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}><Icon name="plus" size={14} /> Project</button>
                  <button onClick={() => onDelete(pf.id)} aria-label="Delete portfolio" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16 }}>×</button>
                </div>
                {pickFor === pf.id && available.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 }}>
                    {available.map((p) => (
                      <button key={p.id} onClick={() => { onUpdate(pf.id, { projectIds: [...pf.projectIds, p.id] }); setPickFor(null); }} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", fontSize: 12.5, color: "var(--ink-2)" }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color }} /> {p.name}
                      </button>
                    ))}
                  </div>
                )}
                {members.length === 0 ? (
                  <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>No projects yet — add one above.</p>
                ) : members.map((p) => {
                  const pct = projectProgress(tasks, p.id);
                  const count = tasks.filter((t) => t.projectId === p.id && !t.parentId && !t.archivedAt).length;
                  return (
                    <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 11, padding: "8px 0", borderTop: "1px solid var(--hairline)" }}>
                      <span style={{ width: 9, height: 9, borderRadius: 2, background: p.color, flexShrink: 0 }} />
                      <button onClick={() => onOpenProject(p.id)} className="truncate" style={{ flex: 1, textAlign: "left", border: "none", background: "transparent", cursor: "pointer", fontSize: 13.5, color: "var(--ink)", fontFamily: "var(--font-display)" }}>{p.name}</button>
                      <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{count} task{count === 1 ? "" : "s"}</span>
                      <div style={{ width: 90, height: 8, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden", flexShrink: 0 }}>
                        <div style={{ width: `${pct}%`, height: "100%", borderRadius: 6, background: "var(--accent)" }} />
                      </div>
                      <span className="mono tnum" style={{ width: 36, textAlign: "right", fontSize: 12, color: "var(--ink-3)" }}>{pct}%</span>
                      <button onClick={() => onUpdate(pf.id, { projectIds: pf.projectIds.filter((id) => id !== p.id) })} aria-label="Remove project" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14 }}>×</button>
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

/* ---------------- AUTOMATIONS ---------------- */
const PRIORITIES = ["low", "medium", "high", "urgent"];
const ACTION_LABEL: Record<AutomationActionType, string> = {
  set_priority: "Set priority to",
  set_assignee: "Assign to",
  set_section: "Move to section",
  add_tag: "Add tag",
};
export function AutomationsView({ rules, projects, members, sections, onCreate, onUpdate, onDelete }: {
  rules: AutomationRule[];
  projects: Project[];
  members: { id: string; name: string }[];
  sections: Section[];
  onCreate: (projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"]) => void;
  onUpdate: (id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] }) => void;
  onDelete: (id: string) => void;
}) {
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const [adding, setAdding] = useState(false);
  const [pid, setPid] = useState(realProjects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationRule["trigger"]>("task_created");
  const add = () => { const n = name.trim(); const proj = pid || realProjects[0]?.id; if (n && proj) { onCreate(proj, n, [], trigger); setName(""); setAdding(false); } };
  const TRIGGER_LABEL: Record<AutomationRule["trigger"], string> = {
    task_created: "a task is created",
    status_changed: "a task's status changes",
    task_completed: "a task is completed",
  };
  const defaultValue = (type: AutomationActionType): string =>
    type === "set_priority" ? "medium" : type === "set_assignee" ? (members[0]?.id ?? "") : "";

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Pick a trigger, then the actions to apply automatically when it fires.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New rule</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="chart" title="No projects yet" sub="Create a project first — rules run on its new tasks." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp}>{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRule["trigger"])} style={inp} aria-label="Trigger">
            {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>When {TRIGGER_LABEL[t]}</option>)}
          </select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Rule name, e.g. Triage inbound" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {rules.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="chart" title="No rules yet" sub="Create a rule to auto-assign, prioritise or file new tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {rules.map((rule) => {
            const proj = getProject(rule.projectId);
            const projSections = sections.filter((s) => s.projectId === rule.projectId);
            const setActions = (actions: AutomationAction[]) => onUpdate(rule.id, { actions });
            return (
              <div key={rule.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px", opacity: rule.enabled ? 1 : 0.6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <input value={rule.name} onChange={(e) => onUpdate(rule.id, { name: e.target.value })} style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)" }} />
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  <button onClick={() => onUpdate(rule.id, { enabled: !rule.enabled })} title={rule.enabled ? "Enabled" : "Disabled"} aria-pressed={rule.enabled} style={{ width: 40, height: 22, borderRadius: 999, border: "none", cursor: "pointer", background: rule.enabled ? "var(--accent)" : "var(--surface-2)", position: "relative", transition: "background .15s" }}>
                    <span style={{ position: "absolute", top: 2, left: rule.enabled ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", transition: "left .15s" }} />
                  </button>
                  <button onClick={() => onDelete(rule.id)} aria-label="Delete rule" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16 }}>×</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-4)", marginBottom: 8 }}>
                  <span>When</span>
                  <select value={rule.trigger} onChange={(e) => onUpdate(rule.id, { trigger: e.target.value as AutomationRule["trigger"] })} aria-label="Trigger"
                    style={{ height: 26, padding: "0 6px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12, outline: "none", cursor: "pointer" }}>
                    {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
                  </select>
                  <span>→</span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                  {rule.actions.map((a, i) => (
                    <div key={i} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ fontSize: 12.5, color: "var(--ink-3)", width: 120, flexShrink: 0 }}>{ACTION_LABEL[a.type]}</span>
                      {a.type === "set_priority" && <select value={a.value} onChange={(e) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={inp}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>}
                      {a.type === "set_assignee" && <select value={a.value} onChange={(e) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={inp}>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
                      {a.type === "set_section" && <select value={a.value} onChange={(e) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} style={inp}><option value="">—</option>{projSections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
                      {a.type === "add_tag" && <input value={a.value} onChange={(e) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="tag" style={inp} />}
                      <button onClick={() => setActions(rule.actions.filter((_, j) => j !== i))} aria-label="Remove action" style={{ marginLeft: "auto", border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 14 }}>×</button>
                    </div>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {(Object.keys(ACTION_LABEL) as AutomationActionType[]).map((type) => (
                    <button key={type} onClick={() => setActions([...rule.actions, { type, value: defaultValue(type) }])} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-display)" }}>
                      <Icon name="plus" size={12} /> {ACTION_LABEL[type]}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- INTAKE FORMS ---------------- */
const FORM_FIELDS: { key: FormFieldKey; label: string }[] = [
  { key: "description", label: "Description" },
  { key: "priority", label: "Priority" },
  { key: "dueDate", label: "Due date" },
  { key: "assignee", label: "Assignee" },
];
export interface FormValues { title: string; description?: string; priority?: string; dueDate?: string; assigneeId?: string }
export function FormsView({ forms, projects, members, onCreate, onUpdate, onDelete, onSubmit }: {
  forms: FormDef[];
  projects: Project[];
  members: { id: string; name: string }[];
  onCreate: (projectId: string, name: string, fields: FormFieldKey[]) => void;
  onUpdate: (id: string, patch: { name?: string; fields?: FormFieldKey[] }) => void;
  onDelete: (id: string) => void;
  onSubmit: (projectId: string, values: FormValues) => void;
}) {
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const [adding, setAdding] = useState(false);
  const [pid, setPid] = useState(realProjects[0]?.id ?? "");
  const [name, setName] = useState("");
  const [fillFor, setFillFor] = useState<string | null>(null);
  const [vals, setVals] = useState<FormValues>({ title: "" });
  const add = () => { const n = name.trim(); const proj = pid || realProjects[0]?.id; if (n && proj) { onCreate(proj, n, ["description", "priority"]); setName(""); setAdding(false); } };
  const submit = (f: FormDef) => { if (vals.title.trim()) { onSubmit(f.projectId, { ...vals, title: vals.title.trim() }); setVals({ title: "" }); setFillFor(null); } };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Build a form — each submission becomes a task in its project.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New form</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="briefcase" title="No projects yet" sub="Create a project first — forms file submissions into it." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp}>{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Form name, e.g. Bug report" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {forms.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="briefcase" title="No forms yet" sub="Create a form to capture requests as tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {forms.map((f) => {
            const proj = getProject(f.projectId);
            const filling = fillFor === f.id;
            return (
              <div key={f.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <input value={f.name} onChange={(e) => onUpdate(f.id, { name: e.target.value })} style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)" }} />
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  <button onClick={() => { setFillFor(filling ? null : f.id); setVals({ title: "" }); }} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>{filling ? "Close" : "Open form"}</button>
                  <button onClick={() => onDelete(f.id)} aria-label="Delete form" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16 }}>×</button>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                  {FORM_FIELDS.map((ff) => {
                    const on = f.fields.includes(ff.key);
                    return <button key={ff.key} onClick={() => onUpdate(f.id, { fields: on ? f.fields.filter((x) => x !== ff.key) : [...f.fields, ff.key] })} style={{ padding: "3px 10px", borderRadius: 999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-dim)" : "transparent", color: on ? "var(--ink)" : "var(--ink-4)", fontFamily: "var(--font-display)" }}>{ff.label}</button>;
                  })}
                </div>
                {filling && (
                  <div style={{ marginTop: 14, borderTop: "1px solid var(--hairline)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                    <input autoFocus value={vals.title} onChange={(e) => setVals((v) => ({ ...v, title: e.target.value }))} placeholder="Title (required)" style={inp} />
                    {f.fields.includes("description") && <textarea value={vals.description ?? ""} onChange={(e) => setVals((v) => ({ ...v, description: e.target.value }))} placeholder="Description" rows={2} style={{ ...inp, height: "auto", padding: "8px 9px", resize: "vertical" }} />}
                    {f.fields.includes("priority") && <select value={vals.priority ?? "medium"} onChange={(e) => setVals((v) => ({ ...v, priority: e.target.value }))} style={inp}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>}
                    {f.fields.includes("dueDate") && <input type="date" value={vals.dueDate ?? ""} onChange={(e) => setVals((v) => ({ ...v, dueDate: e.target.value }))} style={inp} />}
                    {f.fields.includes("assignee") && <select value={vals.assigneeId ?? ""} onChange={(e) => setVals((v) => ({ ...v, assigneeId: e.target.value }))} style={inp}><option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
                    <button onClick={() => submit(f)} disabled={!vals.title.trim()} className="btn btn-accent" style={{ alignSelf: "flex-start", padding: "6px 13px", fontSize: 13, opacity: vals.title.trim() ? 1 : 0.6 }}>Submit → create task</button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
