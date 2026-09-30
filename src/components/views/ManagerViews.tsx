/* ============================================================
   KANBO — manager / reporting views: Workload, Goals (OKRs), Portfolios,
   Automations and intake Forms.
   ============================================================ */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Icon, Avatar, EmptyArt, Collapse } from "../primitives";
import { getProject, getMember, projectProgress, KANBO_TODAY, TAGS, PRIORITY_META, toLocalISO } from "../../data/data";
import type { Task, Project, Goal, GoalStatus, Portfolio, StatusKind, StatusUpdate, Section, AutomationRule, AutomationAction, AutomationActionType, FormDef, FormFieldKey, TagDef, Priority } from "../../data/types";
import { addDays, fmtDayMonth, fmtHours, goalDescendants, goalProgressMap, goalTree, projectHealth, resolveTagId, round1, startOfWeekMon, useStableOrder, workloadForWeek, type HealthKind } from "./reportingUtils";

const inp: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" };
/* progress / capacity tracks: a visible well on white cards in the light theme */
const TRACK = "var(--fill-2, var(--hairline))";
const nameInput: CSSProperties = { flex: 1, minWidth: 0, border: "none", background: "transparent", outline: "none", fontFamily: "var(--font-display)", fontSize: 15, fontWeight: 600, color: "var(--ink)", padding: "2px 0" };
const closeBtn: CSSProperties = { border: "none", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontSize: 16, lineHeight: 1, padding: "2px 4px", borderRadius: 6, flexShrink: 0 };
const fmtDay = fmtDayMonth;
const PRIORITIES: Priority[] = ["low", "medium", "high", "urgent"];

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
 *  realtime reload in between could revert the field mid-word. */
function DraftInput({ value, onCommit, label, style, type = "text", placeholder, required = false, min }: {
  value: string | number | undefined;
  onCommit: (v: string) => void;
  label: string;
  style?: CSSProperties;
  type?: "text" | "number";
  placeholder?: string;
  /** an empty value reverts instead of saving (names can't be blank) */
  required?: boolean;
  min?: number;
}) {
  const external = value == null ? "" : String(value);
  const [draft, setDraft] = useState(external);
  const editing = useRef(false);
  const cancelled = useRef(false);
  // follow outside changes (another tab, a teammate) — but never mid-edit
  useEffect(() => { if (!editing.current) setDraft(external); }, [external]);
  const commit = () => {
    editing.current = false;
    if (cancelled.current) { cancelled.current = false; setDraft(external); return; }
    const v = type === "text" ? draft.trim() : draft;
    if (required && !v) { setDraft(external); return; }
    setDraft(v);
    if (v !== external) onCommit(v);
  };
  return (
    <input type={type} value={draft} min={min} placeholder={placeholder} aria-label={label} style={style}
      onFocus={() => { editing.current = true; }}
      onChange={(e) => { editing.current = true; setDraft(e.target.value); }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
        else if (e.key === "Escape") { e.stopPropagation(); cancelled.current = true; e.currentTarget.blur(); }
      }} />
  );
}

/* ---------------- WORKLOAD ---------------- */
const DEFAULT_CAP = 40;   // weekly capacity (hours) unless set per person
const HEAVY = 12;         // tasks in one week that signal overload even without estimates
const CAP_KEY = "kanbo-capacity";
function readCaps(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(CAP_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export function WorkloadView({ tasks, members, onOpen }: {
  tasks: Task[];
  members: { id: string; name: string }[];
  onOpen: (id: string) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<string, number>>(readCaps);
  const capOf = (id: string) => { const c = caps[id]; return typeof c === "number" && c > 0 ? c : DEFAULT_CAP; };
  const setCap = (id: string, hours: number) => setCaps((cur) => {
    const next = { ...cur };
    if (!(hours > 0) || hours === DEFAULT_CAP) delete next[id]; else next[id] = round1(hours);
    try { localStorage.setItem(CAP_KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return next;
  });

  const weekStart = addDays(startOfWeekMon(KANBO_TODAY), weekOffset * 7);
  const weekTitle = weekOffset === 0 ? "This week" : weekOffset === 1 ? "Next week" : `In ${weekOffset} weeks`;
  const { rows: load, undated } = workloadForWeek(tasks, weekStart, KANBO_TODAY);
  const isMember = (id: string) => members.some((m) => m.id === id);
  members.forEach((m) => { if (!load.has(m.id)) load.set(m.id, { id: m.id, hours: 0, items: [], undated: 0 }); });
  // members always show; "Unassigned" and people who've left only when they carry work this week
  const rows = [...load.values()].filter((r) => isMember(r.id) || r.items.length > 0)
    .sort((a, b) => (b.hours - a.hours) || (b.items.length - a.items.length) || nameOf(a.id).localeCompare(nameOf(b.id)));
  function nameOf(id: string): string {
    if (!id) return "Unassigned";
    const m = members.find((x) => x.id === id);
    if (m) return m.name;
    const known = getMember(id)?.name;
    return known ? `${known} (former member)` : "(former member)";
  }
  const overloaded = rows.filter((r) => isMember(r.id) && (r.hours > capOf(r.id) || r.items.length >= HEAVY));
  const orphaned = rows.filter((r) => !isMember(r.id) && r.items.length > 0).reduce((a, r) => a + r.items.length, 0);
  // rebalance hint: the busiest person + a teammate who clearly has room
  const freeest = rows.filter((r) => isMember(r.id)).sort((a, b) => (a.hours / capOf(a.id) - b.hours / capOf(b.id)) || (a.items.length - b.items.length))[0];
  const rebalance = overloaded.length && freeest && freeest.id !== overloaded[0].id && freeest.hours < capOf(freeest.id) * 0.6 && freeest.items.length < HEAVY
    ? { from: nameOf(overloaded[0].id), to: nameOf(freeest.id) }
    : null;
  const navBtn: CSSProperties = { display: "grid", placeItems: "center", width: 30, height: 30, borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", cursor: "pointer" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 920, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <button type="button" onClick={() => setWeekOffset((w) => Math.max(0, w - 1))} disabled={weekOffset === 0} aria-label="Previous week" style={{ ...navBtn, opacity: weekOffset === 0 ? 0.45 : 1, cursor: weekOffset === 0 ? "default" : "pointer" }}><Icon name="chevronLeft" size={15} /></button>
          <div style={{ minWidth: 150, textAlign: "center" }} aria-live="polite">
            <div style={{ fontSize: 14, fontWeight: 600, color: "var(--ink)" }}>{weekTitle}</div>
            <div className="mono" style={{ fontSize: 11.5, color: "var(--ink-4)" }}>{fmtDay(weekStart)} – {fmtDay(addDays(weekStart, 6))}</div>
          </div>
          <button type="button" onClick={() => setWeekOffset((w) => Math.min(12, w + 1))} disabled={weekOffset >= 12} aria-label="Next week" style={{ ...navBtn, opacity: weekOffset >= 12 ? 0.45 : 1 }}><Icon name="chevronRight" size={15} /></button>
          {weekOffset > 0 && <button type="button" onClick={() => setWeekOffset(0)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>This week</button>}
        </div>
        <p style={{ flex: "1 1 280px", fontSize: 12.5, color: "var(--ink-4)", margin: 0, lineHeight: 1.5 }}>
          Estimated hours due in the week, per person. Tasks with a start and due date are spread across the working days between them{weekOffset === 0 ? "; overdue work counts this week" : ""}. Capacity is {DEFAULT_CAP}h unless you set one.
        </p>
      </div>
      {overloaded.length > 0 && (
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", marginBottom: 14, borderRadius: 12, background: "color-mix(in oklch, var(--prio-urgent) 10%, transparent)", border: "1px solid color-mix(in oklch, var(--prio-urgent) 28%, transparent)" }}>
          <Icon name="zap" size={16} style={{ color: "var(--prio-urgent)", flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.5 }}>
            <strong style={{ color: "var(--prio-urgent)" }}>{overloaded.length} {overloaded.length === 1 ? "person looks" : "people look"} overloaded.</strong>{" "}
            {overloaded.map((r) => nameOf(r.id)).slice(0, 3).join(", ")}{overloaded.length > 3 ? ` +${overloaded.length - 3} more` : ""} {overloaded.length === 1 ? "is" : "are"} over capacity or carrying a lot of work {weekOffset === 0 ? "this week" : "that week"}.
            {rebalance && <> Consider moving a task or two from <strong>{rebalance.from}</strong> to <strong>{rebalance.to}</strong>, who has room.</>}
          </div>
        </div>
      )}
      {orphaned > 0 && (
        <p style={{ fontSize: 12.5, color: "var(--ink-3)", margin: "0 0 14px", display: "flex", alignItems: "center", gap: 7 }}>
          <Icon name="user" size={14} style={{ color: "var(--st-review)" }} />
          {orphaned} task{orphaned === 1 ? " is" : "s are"} unassigned or assigned to someone no longer in this workspace — reassign {orphaned === 1 ? "it" : "them"} below.
        </p>
      )}
      {rows.length === 0 ? <EmptyState icon="chart" title="No workload yet" sub="Assign tasks and give them an hours estimate to see capacity." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.map((r) => {
            const member = isMember(r.id);
            const cap = capOf(r.id);
            const over = member && r.hours > cap;
            const heavy = member && !over && r.items.length >= HEAVY;
            const pct = Math.min(100, (r.hours / cap) * 100);
            const name = nameOf(r.id);
            const open = expanded === r.id;
            const panelId = `workload-${r.id || "unassigned"}`;
            const overdueN = r.items.filter((i) => i.overdue).length;
            return (
              <div key={r.id || "unassigned"} className="glass" style={{ borderRadius: 14, padding: "13px 16px" }}>
                <button type="button" onClick={() => setExpanded((e) => e === r.id ? null : r.id)} aria-expanded={open} aria-controls={panelId}
                  style={{ display: "flex", alignItems: "center", gap: 11, width: "100%", padding: 0, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", color: "inherit", borderRadius: 8 }}>
                  {getMember(r.id) ? <Avatar id={r.id} size={26} /> : <span aria-hidden style={{ width: 26, height: 26, borderRadius: 99, flexShrink: 0, border: "1.5px dashed var(--hairline-strong)" }} />}
                  <span className="truncate" style={{ flex: 1, minWidth: 0, fontSize: 14, fontWeight: 500, color: member ? "var(--ink)" : "var(--ink-3)" }}>{name}</span>
                  <span className="mono tnum" style={{ fontSize: 12.5, color: over || heavy ? "var(--prio-urgent)" : "var(--ink-3)", whiteSpace: "nowrap" }}>
                    {fmtHours(r.hours)}{member ? ` / ${fmtHours(cap)}` : ""} · {r.items.length} task{r.items.length === 1 ? "" : "s"}
                  </span>
                  <Icon name="chevronDown" size={14} style={{ color: "var(--ink-4)", flexShrink: 0, transform: open ? "rotate(180deg)" : "none", transition: "transform .2s var(--ease)" }} />
                </button>
                <div style={{ marginTop: 9, height: 9, borderRadius: 6, background: TRACK, overflow: "hidden" }}>
                  <div style={{ width: `${heavy ? 100 : pct}%`, height: "100%", borderRadius: 6, background: over || heavy ? "var(--prio-urgent)" : member ? "var(--accent)" : "var(--ink-4)", transition: "width .6s var(--ease)" }} />
                </div>
                {over && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Over capacity by {fmtHours(r.hours - cap)}</div>}
                {heavy && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Heavy load — {r.items.length} tasks {weekOffset === 0 ? "this week" : "that week"}</div>}
                <Collapse open={open}>
                  <div id={panelId} style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 4 }}>
                    {r.items.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: "2px 0 4px" }}>Nothing due {weekOffset === 0 ? "this week" : "that week"}.</p>}
                    {r.items.length > 0 && overdueN > 0 && <div className="kicker" style={{ color: "var(--prio-urgent)", margin: "2px 0" }}>{overdueN} overdue</div>}
                    {r.items.map(({ task: t, hours, overdue }) => {
                      const effort = t.effortHours ?? 0;
                      const partial = effort > 0 && round1(hours) !== round1(effort);
                      return (
                        <button key={t.id} type="button" onClick={() => onOpen(t.id)} className="lift-row" aria-label={`Open task ${t.title}`}
                          style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-display)", fontSize: 13, color: "var(--ink-2)" }}>
                          <span className="truncate" style={{ flex: 1, minWidth: 0 }}>{t.title}</span>
                          {t.dueDate && <span className="mono" style={{ fontSize: 11.5, color: overdue ? "var(--prio-urgent)" : "var(--ink-4)", whiteSpace: "nowrap" }}>{overdue ? "Overdue · " : "Due "}{fmtDay(new Date(t.dueDate + "T00:00:00"))}</span>}
                          <span className="mono" style={{ fontSize: 11.5, color: "var(--ink-3)", whiteSpace: "nowrap", minWidth: 40, textAlign: "right" }} title={partial ? "This week's share of the estimate" : undefined}>
                            {effort > 0 ? (partial ? `${fmtHours(hours)} of ${fmtHours(effort)}` : fmtHours(effort)) : "no estimate"}
                          </span>
                        </button>
                      );
                    })}
                    {r.undated > 0 && <p style={{ fontSize: 11.5, color: "var(--ink-4)", margin: "4px 8px 0" }}>+ {r.undated} open task{r.undated === 1 ? "" : "s"} with no dates (not counted).</p>}
                    {member && (
                      <label style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 8, padding: "8px 8px 2px", borderTop: "1px solid var(--hairline)", fontSize: 12.5, color: "var(--ink-3)", flexWrap: "wrap" }}>
                        Weekly capacity
                        <DraftInput type="number" min={1} value={cap} label={`Weekly capacity for ${name}, in hours`}
                          onCommit={(v) => setCap(r.id, Number(v))} style={{ ...inp, width: 72, height: 28, fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                        h <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>· saved on this device</span>
                      </label>
                    )}
                  </div>
                </Collapse>
              </div>
            );
          })}
        </div>
      )}
      {undated > 0 && (
        <p style={{ fontSize: 12, color: "var(--ink-4)", margin: "14px 2px 0", lineHeight: 1.5 }}>
          {undated} open task{undated === 1 ? " has" : "s have"} no start or due date, so {undated === 1 ? "it isn't" : "they aren't"} counted. Give {undated === 1 ? "it" : "them"} a date to plan capacity.
        </p>
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
  // the whole tree, any depth (a sub-goal's own sub-goals used to vanish)
  const ordered = goalTree(useStableOrder(goals));
  const progress = goalProgressMap(goals, (pid) => projectProgress(tasks, pid));
  const todayIso = toLocalISO(KANBO_TODAY);
  const numOr0 = (v: string) => { const n = Number(v); return v.trim() === "" || !isFinite(n) ? 0 : n; };
  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Track measurable objectives — link a project for automatic progress, or nest sub-goals and the parent rolls up their average.</p>
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
            const prog = progress.get(g.id) ?? { pct: 0, source: "manual" as const, children: 0 };
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
                {prog.source === "manual" && (
                  <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 8, flexWrap: "wrap" }}>
                    <DraftInput type="number" value={g.current ?? 0} label={`Current value for ${g.name}`} onCommit={(v) => onUpdate(g.id, { current: numOr0(v) })} style={{ ...inp, width: 90 }} />
                    <span style={{ color: "var(--ink-4)", fontSize: 13 }}>/</span>
                    <DraftInput type="number" value={g.target ?? 0} label={`Target for ${g.name}`} onCommit={(v) => onUpdate(g.id, { target: numOr0(v) })} style={{ ...inp, width: 90 }} />
                    <DraftInput value={g.unit ?? ""} placeholder="unit" label={`Unit for ${g.name}`} onCommit={(v) => onUpdate(g.id, { unit: v })} style={{ ...inp, width: 90 }} />
                  </div>
                )}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  {prog.source === "project" && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>From project {linkedProject?.name ?? "—"}</span>}
                  {prog.source === "subgoals" && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Average of {prog.children} sub-goal{prog.children === 1 ? "" : "s"}</span>}
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

/* ---------------- AUTOMATIONS ---------------- */
const ACTION_LABEL: Record<AutomationActionType, string> = {
  set_priority: "Set priority to",
  set_assignee: "Assign to",
  set_section: "Move to section",
  add_tag: "Add tag",
};
const TRIGGER_LABEL: Record<AutomationRule["trigger"], string> = {
  task_created: "a task is created",
  status_changed: "a task's status changes",
  task_completed: "a task is completed",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Add tag" value picker — bound to real tag ids. Rules saved before this
 *  picker stored free text (which never matched a tag, so the rule did
 *  nothing visible); those show up flagged, with a one-click link when a tag
 *  with that label exists. */
function TagPicker({ value, tags, onChange, label }: { value: string; tags: Record<string, TagDef>; onChange: (v: string) => void; label: string }) {
  const entries = Object.entries(tags).sort((a, b) => a[1].label.localeCompare(b[1].label));
  const known = !!tags[value];
  const foreignId = !known && UUID_RE.test(value);           // a teammate's tag — valid, just not in your list
  const legacy = !!value && !known && !foreignId;            // free text from the old input
  const match = legacy ? resolveTagId(value, tags) : null;
  const color = known ? tags[value].color : undefined;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap", minWidth: 0 }}>
      <span aria-hidden style={{ width: 9, height: 9, borderRadius: 3, flexShrink: 0, background: color ?? "transparent", border: color ? "none" : "1px dashed var(--hairline-strong)" }} />
      <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={label} aria-invalid={legacy || undefined}
        style={{ ...inp, border: legacy ? "1px solid color-mix(in oklch, var(--prio-urgent) 55%, transparent)" : inp.border }}>
        {!value && <option value="" disabled>Choose a tag…</option>}
        {foreignId && <option value={value}>A teammate's tag</option>}
        {legacy && <option value={value}>“{value}” — not a tag</option>}
        {entries.map(([id, t]) => <option key={id} value={id}>{t.label}</option>)}
      </select>
      {match && <button type="button" onClick={() => onChange(match)} className="btn btn-ghost" style={{ padding: "3px 9px", fontSize: 12 }}>Link to tag “{tags[match].label}”</button>}
      {legacy && !match && <span style={{ fontSize: 11.5, color: "var(--prio-urgent)" }}>Choose a tag — this action adds nothing until you do.</span>}
      {entries.length === 0 && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>No tags yet — create one from any task first.</span>}
    </span>
  );
}

export function AutomationsView({ rules, projects, members, sections, tags, onCreate, onUpdate, onDelete }: {
  rules: AutomationRule[];
  projects: Project[];
  members: { id: string; name: string }[];
  sections: Section[];
  /** tag registry (id → label/colour); defaults to the live TAGS reference data */
  tags?: Record<string, TagDef>;
  onCreate: (projectId: string, name: string, actions: AutomationAction[], trigger: AutomationRule["trigger"]) => void;
  onUpdate: (id: string, patch: { name?: string; actions?: AutomationAction[]; enabled?: boolean; trigger?: AutomationRule["trigger"] }) => void;
  onDelete: (id: string) => void;
}) {
  const tagMap = tags ?? TAGS;
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  const [adding, setAdding] = useState(false);
  const [pidSel, setPid] = useState(realProjects[0]?.id ?? "");
  // after a workspace switch the remembered project isn't in the list any more —
  // fall back to this workspace's first project so a new rule lands here
  const pid = realProjects.some((p) => p.id === pidSel) ? pidSel : (realProjects[0]?.id ?? "");
  useEffect(() => { if (pid !== pidSel) setPid(pid); }, [pid, pidSel]);
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState<AutomationRule["trigger"]>("task_created");
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, [], trigger); setName(""); setAdding(false); } };
  const firstTag = Object.entries(tagMap).sort((a, b) => a[1].label.localeCompare(b[1].label))[0]?.[0] ?? "";
  const defaultValue = (type: AutomationActionType): string =>
    type === "set_priority" ? "medium" : type === "set_assignee" ? (members[0]?.id ?? "") : type === "add_tag" ? firstTag : "";
  const personName = (id: string) => members.find((m) => m.id === id)?.name ?? (getMember(id)?.name ? `${getMember(id)!.name} (former member)` : "(former member)");
  const ordered = useStableOrder(rules);
  const small: CSSProperties = { height: 26, padding: "0 6px", borderRadius: 7, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 12, outline: "none", cursor: "pointer" };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Pick a trigger, then the actions to apply automatically when it fires.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New rule</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="chart" title="No projects yet" sub="Create a project first — rules run on its new tasks." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <select value={trigger} onChange={(e) => setTrigger(e.target.value as AutomationRule["trigger"])} style={inp} aria-label="Trigger">
            {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>When {TRIGGER_LABEL[t]}</option>)}
          </select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Rule name, e.g. Triage inbound" aria-label="New rule name" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {rules.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="chart" title="No rules yet" sub="Create a rule to auto-assign, prioritise or file new tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ordered.map((rule) => {
            const proj = getProject(rule.projectId);
            const projSections = sections.filter((s) => s.projectId === rule.projectId);
            const setActions = (actions: AutomationAction[]) => onUpdate(rule.id, { actions });
            const setValue = (i: number, value: string) => setActions(rule.actions.map((x, j) => j === i ? { ...x, value } : x));
            return (
              <div key={rule.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10, flexWrap: "wrap" }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <DraftInput value={rule.name} required label={`Rule name: ${rule.name}`} onCommit={(v) => onUpdate(rule.id, { name: v })} style={{ ...nameInput, flex: "1 1 160px" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  {!rule.enabled && <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>Paused</span>}
                  <button type="button" role="switch" aria-checked={rule.enabled} aria-label={`Run rule ${rule.name}`} title={rule.enabled ? "On — click to pause" : "Paused — click to turn on"}
                    onClick={() => onUpdate(rule.id, { enabled: !rule.enabled })}
                    style={{ width: 40, height: 22, flexShrink: 0, borderRadius: 999, border: "none", cursor: "pointer", padding: 0, background: rule.enabled ? "var(--accent)" : "var(--hairline-strong)", position: "relative", transition: "background .15s" }}>
                    <span style={{ position: "absolute", top: 2, left: rule.enabled ? 20 : 2, width: 18, height: 18, borderRadius: 99, background: "#fff", boxShadow: "0 1px 2px oklch(0.25 0.02 266 / 0.2), 0 0 0 0.5px oklch(0.25 0.02 266 / 0.08)", transition: "left .15s" }} />
                  </button>
                  <button onClick={() => { if (window.confirm(`Delete automation “${rule.name}”?`)) onDelete(rule.id); }} aria-label={`Delete rule ${rule.name}`} style={closeBtn}>×</button>
                  </div>
                </div>
                <div style={{ opacity: rule.enabled ? 1 : 0.62, transition: "opacity .2s" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: "var(--ink-4)", marginBottom: 8 }}>
                    <span>When</span>
                    <select value={rule.trigger} onChange={(e) => onUpdate(rule.id, { trigger: e.target.value as AutomationRule["trigger"] })} aria-label={`Trigger for ${rule.name}`} style={small}>
                      {(Object.keys(TRIGGER_LABEL) as AutomationRule["trigger"][]).map((t) => <option key={t} value={t}>{TRIGGER_LABEL[t]}</option>)}
                    </select>
                    <span>→</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
                    {rule.actions.length === 0 && <p style={{ fontSize: 12.5, color: "var(--ink-4)", margin: 0 }}>No actions yet — add one below. The rule does nothing until it has one.</p>}
                    {rule.actions.map((a, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                        <span style={{ fontSize: 12.5, color: "var(--ink-3)", width: 120, flexShrink: 0 }}>{ACTION_LABEL[a.type]}</span>
                        {a.type === "set_priority" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Priority set by ${rule.name}`} style={inp}>
                            {PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p}</option>)}
                          </select>
                        )}
                        {a.type === "set_assignee" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Person assigned by ${rule.name}`} style={inp}>
                            {!a.value && <option value="" disabled>Choose a person…</option>}
                            {a.value && !members.some((m) => m.id === a.value) && <option value={a.value}>{personName(a.value)}</option>}
                            {members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                          </select>
                        )}
                        {a.type === "set_section" && (
                          <select value={a.value} onChange={(e) => setValue(i, e.target.value)} aria-label={`Section used by ${rule.name}`} style={inp}>
                            <option value="">—</option>
                            {a.value && !projSections.some((sct) => sct.id === a.value) && <option value={a.value}>(deleted section)</option>}
                            {projSections.map((sct) => <option key={sct.id} value={sct.id}>{sct.name}</option>)}
                          </select>
                        )}
                        {a.type === "add_tag" && <TagPicker value={a.value} tags={tagMap} onChange={(v) => setValue(i, v)} label={`Tag added by ${rule.name}`} />}
                        <button onClick={() => setActions(rule.actions.filter((_, j) => j !== i))} aria-label={`Remove “${ACTION_LABEL[a.type]}” from ${rule.name}`} style={{ ...closeBtn, marginLeft: "auto", fontSize: 14 }}>×</button>
                      </div>
                    ))}
                  </div>
                  <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }}>
                    {(Object.keys(ACTION_LABEL) as AutomationActionType[]).map((type) => (
                      <button key={type} onClick={() => setActions([...rule.actions, { type, value: defaultValue(type) }])} aria-label={`Add action “${ACTION_LABEL[type]}” to ${rule.name}`} style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px", borderRadius: 999, border: "1px solid var(--hairline)", background: "transparent", cursor: "pointer", fontSize: 12, color: "var(--ink-3)", fontFamily: "var(--font-display)" }}>
                        <Icon name="plus" size={12} /> {ACTION_LABEL[type]}
                      </button>
                    ))}
                  </div>
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
  const [pidSel, setPid] = useState(realProjects[0]?.id ?? "");
  // after a workspace switch the remembered project isn't in the list any more —
  // fall back to this workspace's first project so the form is saved here
  const pid = realProjects.some((p) => p.id === pidSel) ? pidSel : (realProjects[0]?.id ?? "");
  useEffect(() => { if (pid !== pidSel) setPid(pid); }, [pid, pidSel]);
  const [name, setName] = useState("");
  const [fillFor, setFillFor] = useState<string | null>(null);
  const [vals, setVals] = useState<FormValues>({ title: "" });
  // a remembered assignee from another workspace would silently assign the task outside this team
  const assigneeId = vals.assigneeId && members.some((m) => m.id === vals.assigneeId) ? vals.assigneeId : "";
  const add = () => { const n = name.trim(); if (n && pid) { onCreate(pid, n, ["description", "priority"]); setName(""); setAdding(false); } };
  const submit = (f: FormDef) => { if (vals.title.trim()) { onSubmit(f.projectId, { ...vals, title: vals.title.trim(), assigneeId: assigneeId || undefined }); setVals({ title: "" }); setFillFor(null); } };
  const ordered = useStableOrder(forms);

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "24px 24px 48px", maxWidth: 880, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <p style={{ flex: "1 1 260px", fontSize: 13, color: "var(--ink-4)", margin: 0 }}>Build a form — each submission becomes a task in its project.</p>
        {realProjects.length > 0 && <button onClick={() => setAdding(true)} className="btn btn-accent" style={{ marginLeft: "auto", padding: "7px 13px", fontSize: 13 }}><Icon name="plus" size={15} /> New form</button>}
      </div>
      {realProjects.length === 0 ? <EmptyState icon="briefcase" title="No projects yet" sub="Create a project first — forms file submissions into it." /> : adding && (
        <div className="glass" style={{ borderRadius: 12, padding: 12, marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <select value={pid} onChange={(e) => setPid(e.target.value)} style={inp} aria-label="Project">{realProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") add(); else if (e.key === "Escape") setAdding(false); }} placeholder="Form name, e.g. Bug report" aria-label="New form name" style={{ ...inp, flex: 1, minWidth: 160 }} />
          <button onClick={add} className="btn btn-accent" style={{ padding: "5px 12px", fontSize: 12.5 }}>Add</button>
          <button onClick={() => setAdding(false)} className="btn btn-ghost" style={{ padding: "5px 10px", fontSize: 12.5 }}>Cancel</button>
        </div>
      )}
      {forms.length === 0 && !adding && realProjects.length > 0 ? <EmptyState icon="briefcase" title="No forms yet" sub="Create a form to capture requests as tasks." /> : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {ordered.map((f) => {
            const proj = getProject(f.projectId);
            const filling = fillFor === f.id;
            return (
              <div key={f.id} className="glass" style={{ borderRadius: 14, padding: "15px 17px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  {proj && <span style={{ width: 9, height: 9, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
                  <DraftInput value={f.name} required label={`Form name: ${f.name}`} onCommit={(v) => onUpdate(f.id, { name: v })} style={{ ...nameInput, flex: "1 1 160px" }} />
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginLeft: "auto" }}>
                  <span style={{ fontSize: 12, color: "var(--ink-4)" }}>{proj?.name}</span>
                  <button onClick={() => { setFillFor(filling ? null : f.id); setVals({ title: "" }); }} aria-expanded={filling} aria-label={`${filling ? "Close" : "Open"} form ${f.name}`} className="btn btn-ghost" style={{ padding: "5px 11px", fontSize: 12.5 }}>{filling ? "Close" : "Open form"}</button>
                  <button onClick={() => { if (window.confirm(`Delete form “${f.name}”?`)) onDelete(f.id); }} aria-label={`Delete form ${f.name}`} style={closeBtn}>×</button>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 6, marginTop: 10, flexWrap: "wrap" }} role="group" aria-label={`Fields asked for by ${f.name}`}>
                  {FORM_FIELDS.map((ff) => {
                    const on = f.fields.includes(ff.key);
                    return <button key={ff.key} aria-pressed={on} onClick={() => onUpdate(f.id, { fields: on ? f.fields.filter((x) => x !== ff.key) : [...f.fields, ff.key] })} style={{ padding: "3px 10px", borderRadius: 999, cursor: "pointer", fontSize: 12, border: `1px solid ${on ? "var(--accent)" : "var(--hairline)"}`, background: on ? "var(--accent-dim)" : "transparent", color: on ? "var(--ink)" : "var(--ink-4)", fontFamily: "var(--font-display)" }}>{ff.label}</button>;
                  })}
                </div>
                {filling && (
                  <div style={{ marginTop: 14, borderTop: "1px solid var(--hairline)", paddingTop: 14, display: "flex", flexDirection: "column", gap: 9 }}>
                    <input autoFocus value={vals.title} onChange={(e) => setVals((v) => ({ ...v, title: e.target.value }))} placeholder="Title (required)" aria-label="Title" style={inp} />
                    {f.fields.includes("description") && <textarea value={vals.description ?? ""} onChange={(e) => setVals((v) => ({ ...v, description: e.target.value }))} placeholder="Description" aria-label="Description" rows={2} style={{ ...inp, height: "auto", padding: "8px 9px", resize: "vertical" }} />}
                    {f.fields.includes("priority") && <select value={vals.priority ?? "medium"} onChange={(e) => setVals((v) => ({ ...v, priority: e.target.value }))} aria-label="Priority" style={inp}>{PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_META[p]?.label ?? p}</option>)}</select>}
                    {f.fields.includes("dueDate") && <input type="date" value={vals.dueDate ?? ""} onChange={(e) => setVals((v) => ({ ...v, dueDate: e.target.value }))} aria-label="Due date" style={inp} />}
                    {f.fields.includes("assignee") && <select value={assigneeId} onChange={(e) => setVals((v) => ({ ...v, assigneeId: e.target.value }))} aria-label="Assignee" style={inp}><option value="">Unassigned</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>}
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
