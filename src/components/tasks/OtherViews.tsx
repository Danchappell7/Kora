/* ============================================================
   KORA — Board (Kanban), Timeline (Gantt), Calendar views
   ============================================================ */
import { useState } from "react";
import { Icon, Avatar, StatusDot, Tag, PriorityFlag } from "../primitives";
import { SubtaskProgress } from "./ListView";
import {
  getProject, blockingTasks, dueState, fmtDue,
  STATUS_META, STATUS_ORDER, PROJECTS, KORA_TODAY, toLocalISO,
} from "../../data/data";
import type { Task, Status, CalProvider, CalendarConnection, ExternalEvent } from "../../data/types";

const PROVIDER_META: Record<CalProvider, { label: string; color: string }> = {
  google: { label: "Google Calendar", color: "oklch(0.7 0.18 25)" },
  microsoft: { label: "Microsoft / Outlook", color: "oklch(0.62 0.16 250)" },
};

/* ---------------- KANBAN ---------------- */
function KanbanCard({ task, allTasks, onOpen }: { task: Task; allTasks: Task[]; onOpen: (id: string) => void }) {
  const proj = getProject(task.projectId);
  const blocked = blockingTasks(task, allTasks);
  const ds = dueState(task.dueDate, task.status);
  return (
    <div onClick={() => onOpen(task.id)} className="glass clickable lift" draggable
      onDragStart={(e) => { e.dataTransfer.setData("text/kora-task", task.id); e.dataTransfer.effectAllowed = "move"; }}
      style={{ padding: 13, borderRadius: 12, cursor: "grab" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
        <PriorityFlag priority={task.priority} size={13} />
        <span style={{ flex: 1, fontSize: 13.5, lineHeight: 1.35, fontWeight: 450 }}>{task.title}</span>
      </div>
      {(task.tags || []).length > 0 && <div style={{ display: "flex", gap: 6, marginTop: 9, flexWrap: "wrap" }}>{task.tags.slice(0, 2).map((tg) => <Tag key={tg} id={tg} small />)}</div>}
      {blocked.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 5, marginTop: 9, fontSize: 11, color: "var(--st-blocked)" }}>
          <Icon name="lock" size={12} /> Blocked
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 11 }}>
        {proj && <span style={{ width: 7, height: 7, borderRadius: 2, background: proj.color }} />}
        <SubtaskProgress subtasks={task.subtasks} />
        <div style={{ flex: 1 }} />
        {task.dueDate && <span className="mono" style={{ fontSize: 11, color: ds === "overdue" ? "var(--prio-urgent)" : ds === "today" ? "var(--accent)" : "var(--ink-4)" }}>{fmtDue(task.dueDate)}</span>}
        <Avatar id={task.assigneeId} size={22} />
      </div>
    </div>
  );
}

export function BoardView({ tasks, allTasks, onOpen, onAdd, onMove }: { tasks: Task[]; allTasks: Task[]; onOpen: (id: string) => void; onAdd: (status: Status) => void; onMove: (taskId: string, status: Status) => void }) {
  const [dragOver, setDragOver] = useState<Status | null>(null);
  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ display: "flex", gap: 16, padding: "20px 24px 28px", minHeight: "100%" }}>
        {STATUS_ORDER.map((s) => {
          const items = tasks.filter((t) => t.status === s);
          return (
            <div key={s} style={{ width: 296, flexShrink: 0, display: "flex", flexDirection: "column" }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes("text/kora-task")) { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(s); } }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOver((d) => d === s ? null : d); }}
              onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/kora-task"); setDragOver(null); if (id) onMove(id, s); }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 4px 12px" }}>
                <StatusDot status={s} glow />
                <span style={{ fontSize: 13.5, fontWeight: 600 }}>{STATUS_META[s].label}</span>
                <span className="mono tnum" style={{ fontSize: 11.5, color: "var(--ink-4)", background: "var(--surface)", borderRadius: 6, padding: "1px 7px" }}>{items.length}</span>
                <button onClick={() => onAdd(s)} className="btn-icon" title="Add task" style={{ marginLeft: "auto", width: 24, height: 24, border: "none", color: "var(--ink-4)" }}><Icon name="plus" size={15} /></button>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: 1, padding: 4, borderRadius: 14, minHeight: 120, transition: "background .15s, box-shadow .15s",
                background: dragOver === s ? "var(--accent-dim)" : "color-mix(in oklch, var(--bg-deep) 28%, transparent)",
                boxShadow: dragOver === s ? "inset 0 0 0 2px var(--accent)" : "none" }}>
                {items.map((t) => <KanbanCard key={t.id} task={t} allTasks={allTasks} onOpen={onOpen} />)}
                <button onClick={() => onAdd(s)} style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "9px", borderRadius: 11, border: "1px dashed var(--hairline-strong)", background: "transparent", color: "var(--ink-4)", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 12.5 }}>
                  <Icon name="plus" size={14} /> Add task
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- TIMELINE (Gantt) ---------------- */
export function TimelineView({ tasks, onOpen }: { tasks: Task[]; allTasks?: Task[]; onOpen: (id: string) => void }) {
  const DAYS = 16, START = -2; // show -2 .. +13
  const dates = Array.from({ length: DAYS }, (_, i) => { const d = new Date(KORA_TODAY); d.setDate(d.getDate() + START + i); return d; });
  const colW = 78, labelW = 230, rowH = 46;
  const dayIndex = (iso?: string): number | null => {
    if (!iso) return null;
    const d = new Date(iso + "T00:00:00");
    const base = new Date(KORA_TODAY); base.setDate(base.getDate() + START);
    return Math.round((d.getTime() - new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime()) / 86400000);
  };

  const byProject = PROJECTS.map((p) => ({ project: p, items: tasks.filter((t) => t.projectId === p.id) })).filter((g) => g.items.length);
  const todayIdx = -START;

  return (
    <div style={{ flex: 1, overflow: "auto" }}>
      <div style={{ minWidth: labelW + DAYS * colW, padding: "8px 0 40px" }}>
        {/* axis */}
        <div style={{ display: "flex", position: "sticky", top: 0, zIndex: 3, background: "color-mix(in oklch, var(--bg) 88%, transparent)", backdropFilter: "blur(8px)", borderBottom: "1px solid var(--hairline)" }}>
          <div style={{ width: labelW, flexShrink: 0, padding: "12px 18px" }}><span className="kicker">Task</span></div>
          {dates.map((d, i) => {
            const isToday = i === todayIdx;
            const weekend = d.getDay() === 0 || d.getDay() === 6;
            return (
              <div key={i} style={{ width: colW, flexShrink: 0, textAlign: "center", padding: "10px 0", background: weekend ? "color-mix(in oklch, var(--bg-deep) 22%, transparent)" : "transparent" }}>
                <div className="kicker" style={{ color: isToday ? "var(--accent)" : "var(--ink-4)" }}>{d.toLocaleDateString(undefined, { weekday: "short" })}</div>
                <div className="mono tnum" style={{ fontSize: 14, fontWeight: 600, marginTop: 2, color: isToday ? "var(--accent)" : "var(--ink-2)" }}>{d.getDate()}</div>
              </div>
            );
          })}
        </div>

        {/* rows */}
        <div style={{ position: "relative" }}>
          {/* today line */}
          <div style={{ position: "absolute", top: 0, bottom: 0, left: labelW + todayIdx * colW + colW / 2, width: 2, background: "var(--accent)", opacity: 0.4, zIndex: 1, boxShadow: "0 0 12px var(--accent)" }} />
          {byProject.map((g) => (
            <div key={g.project.id}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "14px 18px 6px", position: "sticky", left: 0, width: labelW }}>
                <span style={{ width: 8, height: 8, borderRadius: 2, background: g.project.color }} />
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{g.project.name}</span>
              </div>
              {g.items.map((t) => {
                const di = dayIndex(t.dueDate);
                const start = Math.max(0, (di ?? 0) - Math.ceil(t.focusMin / 60 / 2) - 1);
                const span = Math.max(1, (di ?? 0) - start + 1);
                const done = t.status === "done";
                return (
                  <div key={t.id} style={{ display: "flex", height: rowH, alignItems: "center", position: "relative" }}>
                    <div className="truncate" style={{ width: labelW, flexShrink: 0, padding: "0 18px", fontSize: 13, color: "var(--ink-2)", display: "flex", alignItems: "center", gap: 8 }}>
                      <StatusDot status={t.status} size={7} />{t.title}
                    </div>
                    <div style={{ position: "absolute", left: labelW, right: 0, top: 0, bottom: 0 }}>
                      {di != null && di >= 0 && di < DAYS && (
                        <div onClick={() => onOpen(t.id)} className="clickable" style={{
                          position: "absolute", top: rowH / 2 - 13, left: start * colW + 6, width: span * colW - 12, height: 26,
                          borderRadius: 8, display: "flex", alignItems: "center", gap: 7, padding: "0 9px", overflow: "hidden",
                          background: done ? "color-mix(in oklch, var(--st-done) 18%, transparent)" : `color-mix(in oklch, ${g.project.color} 22%, transparent)`,
                          border: `1px solid color-mix(in oklch, ${done ? "var(--st-done)" : g.project.color} 45%, transparent)`,
                          transition: "all .16s",
                        }}
                          onMouseEnter={(e) => (e.currentTarget.style.transform = "translateY(-1px)")}
                          onMouseLeave={(e) => (e.currentTarget.style.transform = "none")}>
                          <span style={{ width: 6, height: 6, borderRadius: 99, background: done ? "var(--st-done)" : g.project.color, flexShrink: 0 }} />
                          <span className="truncate" style={{ fontSize: 11.5, color: "var(--ink)" }}>{t.title}</span>
                          <Avatar id={t.assigneeId} size={16} />
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- CALENDAR ---------------- */
function ConnectCalendarMenu({ connections, onConnect, onDisconnect, syncing }: {
  connections: CalendarConnection[];
  onConnect: (p: CalProvider) => void;
  onDisconnect: (p: CalProvider) => void;
  syncing?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const connectedFor = (p: CalProvider) => connections.find((c) => c.provider === p);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
      {connections.map((c) => {
        const meta = PROVIDER_META[c.provider];
        return (
          <span key={c.provider} className="glass" style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 10px 5px 11px", borderRadius: 99, fontSize: 12.5 }}>
            <span style={{ width: 8, height: 8, borderRadius: 99, background: meta.color, boxShadow: `0 0 8px ${meta.color}` }} />
            <span style={{ color: "var(--ink-2)" }}>{c.accountEmail || meta.label}</span>
            <button className="btn-icon" title={`Disconnect ${meta.label}`} aria-label={`Disconnect ${meta.label}`} onClick={() => onDisconnect(c.provider)} style={{ border: "none", width: 22, height: 22, color: "var(--ink-4)" }}><Icon name="x" size={13} /></button>
          </span>
        );
      })}
      {syncing && <span style={{ fontSize: 12, color: "var(--ink-4)" }}>Syncing…</span>}
      <div style={{ position: "relative", marginLeft: "auto" }}>
        <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} style={{ fontSize: 13 }}>
          <Icon name="calendarPlus" size={15} /> Connect calendar <Icon name="chevronDown" size={14} />
        </button>
        {open && (
          <>
            <div onClick={() => setOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 30 }} />
            <div className="glass anim-scalein" style={{ position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 31, width: 248, padding: 6, borderRadius: 12, background: "var(--surface-raised)", boxShadow: "var(--shadow-lg)" }}>
              {(Object.keys(PROVIDER_META) as CalProvider[]).map((p) => {
                const meta = PROVIDER_META[p];
                const conn = connectedFor(p);
                return (
                  <button key={p} onClick={() => { setOpen(false); conn ? onDisconnect(p) : onConnect(p); }}
                    style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", padding: "9px 10px", borderRadius: 8, border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-display)", fontSize: 13.5, textAlign: "left", color: "var(--ink-2)" }}>
                    <span style={{ width: 9, height: 9, borderRadius: 99, background: meta.color, flexShrink: 0 }} />
                    <span style={{ flex: 1 }}>{meta.label}</span>
                    {conn ? <span style={{ fontSize: 11, color: "var(--ink-4)" }}>Disconnect</span> : <Icon name="plus" size={14} style={{ color: "var(--ink-4)" }} />}
                  </button>
                );
              })}
              <div className="divider" style={{ margin: "4px 4px" }} />
              <p style={{ margin: 0, padding: "4px 10px 6px", fontSize: 11, color: "var(--ink-4)", lineHeight: 1.45 }}>We only read your events to show them here. Disconnect anytime.</p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function CalendarView({ tasks, onOpen, connections = [], externalEvents = [], onConnect, onDisconnect, syncing }: {
  tasks: Task[];
  onOpen: (id: string) => void;
  connections?: CalendarConnection[];
  externalEvents?: ExternalEvent[];
  onConnect?: (p: CalProvider) => void;
  onDisconnect?: (p: CalProvider) => void;
  syncing?: boolean;
}) {
  const year = KORA_TODAY.getFullYear(), month = KORA_TODAY.getMonth();
  const first = new Date(year, month, 1);
  const startDow = (first.getDay() + 6) % 7; // Mon-first
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (number | null)[] = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);
  const todayD = KORA_TODAY.getDate();
  const iso = (d: number) => toLocalISO(new Date(year, month, d));

  // group external events by local calendar day
  const evByDate: Record<string, ExternalEvent[]> = {};
  for (const e of externalEvents) {
    const key = e.allDay ? (e.start || "").slice(0, 10) : toLocalISO(new Date(e.start));
    if (key) (evByDate[key] ||= []).push(e);
  }
  const fmtTime = (e: ExternalEvent) => {
    if (e.allDay) return "";
    const d = new Date(e.start);
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  };

  return (
    <div style={{ flex: 1, overflow: "auto", padding: "18px 24px 28px" }}>
      {onConnect && onDisconnect && <ConnectCalendarMenu connections={connections} onConnect={onConnect} onDisconnect={onDisconnect} syncing={syncing} />}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gap: 1, marginBottom: 8 }}>
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="kicker" style={{ textAlign: "center", padding: "4px 0" }}>{d}</div>)}
      </div>
      <div className="glass" style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", gridAutoRows: "minmax(118px,1fr)", gap: 1, padding: 1, borderRadius: 16, overflow: "hidden", background: "var(--hairline)" }}>
        {cells.map((d, i) => {
          const dayIso = d ? iso(d) : "";
          const dayTasks = d ? tasks.filter((t) => t.dueDate === dayIso) : [];
          const dayEvents = d ? (evByDate[dayIso] ?? []) : [];
          const isToday = d === todayD;
          const overflow = Math.max(0, dayTasks.length - 3) + Math.max(0, dayEvents.length - 2);
          return (
            <div key={i} style={{ background: d ? "var(--surface)" : "color-mix(in oklch, var(--bg-deep) 30%, transparent)", padding: 9, minHeight: 0, display: "flex", flexDirection: "column", gap: 5 }}>
              {d && (
                <>
                  <span className="mono tnum" style={{ fontSize: 12, fontWeight: 600, alignSelf: "flex-start", color: isToday ? "var(--on-accent)" : "var(--ink-3)", background: isToday ? "var(--accent)" : "transparent", borderRadius: 7, padding: isToday ? "1px 7px" : "1px 2px", boxShadow: isToday ? "0 0 12px var(--accent-glow)" : "none" }}>{d}</span>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, overflow: "hidden" }}>
                    {dayEvents.slice(0, 2).map((e) => {
                      const color = PROVIDER_META[(e.provider as CalProvider)]?.color || "var(--ink-3)";
                      const time = fmtTime(e);
                      return (
                        <span key={e.id} className="truncate" title={`${time ? time + " · " : ""}${e.title}`} style={{
                          display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 6px", borderRadius: 6,
                          color: "var(--ink-3)", background: `color-mix(in oklch, ${color} 12%, transparent)`, borderLeft: `2px solid ${color}`,
                        }}>
                          {time && <span className="mono" style={{ fontSize: 9.5, color: "var(--ink-4)", flexShrink: 0 }}>{time}</span>}
                          <span className="truncate">{e.title}</span>
                        </span>
                      );
                    })}
                    {dayTasks.slice(0, 3).map((t) => {
                      const proj = getProject(t.projectId);
                      return (
                        <button key={t.id} onClick={() => onOpen(t.id)} className="truncate" style={{
                          display: "flex", alignItems: "center", gap: 5, fontSize: 11, padding: "3px 6px", borderRadius: 6, cursor: "pointer",
                          border: "none", textAlign: "left", color: t.status === "done" ? "var(--ink-4)" : "var(--ink-2)",
                          textDecoration: t.status === "done" ? "line-through" : "none",
                          background: `color-mix(in oklch, ${proj?.color || "var(--accent)"} 14%, transparent)`,
                          borderLeft: `2px solid ${proj?.color || "var(--accent)"}`,
                        }}>
                          <span className="truncate">{t.title}</span>
                        </button>
                      );
                    })}
                    {overflow > 0 && <span style={{ fontSize: 10.5, color: "var(--ink-4)", paddingLeft: 6 }}>+{overflow} more</span>}
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
