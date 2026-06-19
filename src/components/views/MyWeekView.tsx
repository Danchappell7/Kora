/* ============================================================
   KANBO — My Week: a weekly planning + review ritual.
   This week's days, what slipped, what's unscheduled.
   ============================================================ */
import { Icon, StatusDot } from "../primitives";
import { getProject, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";

const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div>
      <div className="kicker">{label}</div>
      <div className="mono tnum" style={{ fontSize: 24, fontWeight: 600, color: color || "var(--ink)" }}>{value}</div>
    </div>
  );
}

export function MyWeekView({ tasks, onOpen, onPatch }: { tasks: Task[]; onOpen: (id: string) => void; onPatch: (id: string, patch: Partial<Task>) => void }) {
  const today = new Date(KANBO_TODAY.getFullYear(), KANBO_TODAY.getMonth(), KANBO_TODAY.getDate());
  const todayIso = isoOf(today);
  const dow = (today.getDay() + 6) % 7; // 0 = Monday
  const monday = new Date(today); monday.setDate(today.getDate() - dow);
  const days = Array.from({ length: 7 }, (_, i) => { const d = new Date(monday); d.setDate(monday.getDate() + i); return d; });
  const weekIsos = days.map(isoOf);
  const open = tasks.filter((t) => t.status !== "done" && !t.archivedAt && !t.parentId);
  const overdue = open.filter((t) => t.dueDate && t.dueDate < todayIso);
  const noDate = open.filter((t) => !t.dueDate);
  const doneThisWeek = tasks.filter((t) => t.status === "done" && t.completedAt && t.completedAt.slice(0, 10) >= weekIsos[0] && t.completedAt.slice(0, 10) <= weekIsos[6]).length;
  const dueThisWeek = open.filter((t) => t.dueDate && weekIsos.includes(t.dueDate)).length;

  const TaskChip = ({ t }: { t: Task }) => {
    const proj = getProject(t.projectId);
    return (
      <button onClick={() => onOpen(t.id)} className="lift" style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", borderRadius: 9, border: "1px solid var(--hairline)", background: "var(--surface)", cursor: "pointer", textAlign: "left", width: "100%" }}>
        <StatusDot status={t.status} size={6} />
        <span className="truncate" style={{ flex: 1, fontSize: 12.5, color: "var(--ink)" }}>{t.title}</span>
        {proj && <span title={proj.name} style={{ width: 6, height: 6, borderRadius: 2, background: proj.color, flexShrink: 0 }} />}
      </button>
    );
  };

  return (
    <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px 44px", maxWidth: 1100, width: "100%", margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginBottom: 18 }}>
        <Stat label="Due this week" value={dueThisWeek} color="var(--accent)" />
        <Stat label="Done this week" value={doneThisWeek} color="var(--st-done)" />
        <Stat label="Carried over" value={overdue.length} color={overdue.length ? "var(--prio-urgent)" : undefined} />
        <Stat label="Unscheduled" value={noDate.length} />
      </div>

      {overdue.length > 0 && (
        <div className="glass" style={{ borderRadius: 14, padding: 14, marginBottom: 16, borderLeft: "3px solid var(--prio-urgent)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
            <Icon name="clock" size={15} style={{ color: "var(--prio-urgent)" }} />
            <span style={{ fontSize: 13.5, fontWeight: 600 }}>Carried over — {overdue.length} overdue</span>
            <button onClick={() => overdue.forEach((t) => onPatch(t.id, { dueDate: todayIso }))} className="btn btn-ghost" style={{ marginLeft: "auto", padding: "5px 10px", fontSize: 12 }}>Pull all to today</button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 7 }}>
            {overdue.slice(0, 12).map((t) => <TaskChip key={t.id} t={t} />)}
          </div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 10 }}>
        {days.map((d, i) => {
          const iso = weekIsos[i];
          const items = open.filter((t) => t.dueDate === iso);
          const isToday = iso === todayIso;
          return (
            <div key={iso} style={{ minHeight: 150, borderRadius: 12, padding: 9, background: isToday ? "var(--accent-dim)" : "color-mix(in oklch, var(--bg-deep) 22%, transparent)", border: isToday ? "1px solid var(--accent)" : "1px solid var(--hairline)" }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 5, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: isToday ? "var(--accent)" : "var(--ink-2)" }}>{d.toLocaleDateString(undefined, { weekday: "short" })}</span>
                <span className="mono tnum" style={{ fontSize: 11, color: "var(--ink-4)" }}>{d.getDate()}</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {items.map((t) => <TaskChip key={t.id} t={t} />)}
              </div>
            </div>
          );
        })}
      </div>

      {noDate.length > 0 && (
        <div style={{ marginTop: 18 }}>
          <div className="kicker" style={{ marginBottom: 8 }}>Unscheduled — give these a due date to slot them into your week</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 7 }}>
            {noDate.slice(0, 18).map((t) => <TaskChip key={t.id} t={t} />)}
          </div>
        </div>
      )}
    </div>
  );
}
