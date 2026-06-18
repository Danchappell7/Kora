/* ============================================================
   KANBO — manager / reporting views: Workload, Goals (OKRs), Portfolios.
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar } from "../primitives";
import { getProject, getMember, projectProgress } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind } from "../../data/types";

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
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <p style={{ fontSize: 13, color: "var(--ink-4)", margin: "0 0 16px" }}>Estimated open work per person (assumes ~{CAP}h capacity). Set an estimate on a task to feed this.</p>
      {rows.length === 0 ? <EmptyState icon="chart" title="No workload yet" sub="Assign tasks and give them an hours estimate to see capacity." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => {
            const over = r.hours > CAP;
            const pct = Math.min(100, CAP ? (r.hours / CAP) * 100 : 0);
            const name = getMember(r.id)?.name || "Unassigned";
            return (
              <div key={r.id} className="glass" style={{ borderRadius: 14, padding: "13px 16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 11, cursor: r.tasks.length ? "pointer" : "default" }} onClick={() => setExpanded((e) => e === r.id ? null : r.id)}>
                  <Avatar id={r.id} size={26} />
                  <span style={{ flex: 1, fontSize: 14, fontWeight: 500 }}>{name}</span>
                  <span className="mono tnum" style={{ fontSize: 12.5, color: over ? "var(--prio-urgent)" : "var(--ink-3)" }}>{r.hours}h · {r.tasks.length} task{r.tasks.length === 1 ? "" : "s"}</span>
                </div>
                <div style={{ marginTop: 9, height: 9, borderRadius: 6, background: "var(--surface-2)", overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", borderRadius: 6, background: over ? "var(--prio-urgent)" : "var(--accent)", transition: "width .6s var(--ease)" }} />
                </div>
                {over && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Over capacity by {r.hours - CAP}h</div>}
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
export function GoalsView({ goals, onCreate, onUpdate, onDelete }: {
  goals: Goal[];
  onCreate: (name: string) => void;
  onUpdate: (id: string, patch: Partial<Pick<Goal, "name" | "target" | "current" | "unit" | "due" | "status">>) => void;
  onDelete: (id: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const add = () => { const n = name.trim(); if (n) { onCreate(n); setName(""); setAdding(false); } };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", marginBottom: 16 }}>
        <p style={{ fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Track measurable objectives and their progress.</p>
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
          {goals.map((g) => {
            const pct = g.target && g.target > 0 ? Math.min(100, Math.round(((g.current ?? 0) / g.target) * 100)) : 0;
            const meta = GOAL_STATUS[g.status] ?? GOAL_STATUS.on_track;
            return (
              <div key={g.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <input value={g.name} onChange={(e) => onUpdate(g.id, { name: e.target.value })} style={{ flex: 1, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)" }} />
                  <select value={g.status} onChange={(e) => onUpdate(g.id, { status: e.target.value as GoalStatus })} style={{ ...inp, height: 28, color: meta.color }}>
                    {(Object.keys(GOAL_STATUS) as GoalStatus[]).map((s) => <option key={s} value={s}>{GOAL_STATUS[s].label}</option>)}
                  </select>
                  <button onClick={() => onDelete(g.id)} aria-label="Delete goal" style={{ border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16 }}>×</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 9, margin: "12px 0 8px" }}>
                  <input type="number" value={g.current ?? 0} onChange={(e) => onUpdate(g.id, { current: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inp, width: 90 }} aria-label="Current" />
                  <span style={{ color: "var(--ink-4)", fontSize: 13 }}>/</span>
                  <input type="number" value={g.target ?? 0} onChange={(e) => onUpdate(g.id, { target: e.target.value === "" ? 0 : Number(e.target.value) })} style={{ ...inp, width: 90 }} aria-label="Target" />
                  <input value={g.unit ?? ""} onChange={(e) => onUpdate(g.id, { unit: e.target.value })} placeholder="unit" style={{ ...inp, width: 90 }} aria-label="Unit" />
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
