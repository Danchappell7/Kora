/* ============================================================
   KANBO — Workload: each person's load this week against their
   weekly capacity (hours, set per person on this device)
   ============================================================ */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Icon, Avatar, EmptyArt, Collapse } from "../primitives";
import { getMember, KANBO_TODAY } from "../../data/data";
import type { Task } from "../../data/types";
import { addDays, fmtDayMonth, fmtHours, round1, startOfWeekMon, workloadForWeek } from "./reportingUtils";

const inp: React.CSSProperties = { height: 32, padding: "0 9px", borderRadius: 8, border: "1px solid var(--hairline)", background: "var(--surface)", color: "var(--ink-2)", fontFamily: "var(--font-display)", fontSize: 13, outline: "none" };
/* progress / capacity tracks: a visible well on white cards in the light theme */
const TRACK = "var(--track, var(--surface-2))";
const fmtDay = fmtDayMonth;

function EmptyState({ icon, title, sub }: { icon: "target" | "briefcase" | "chart"; title: string; sub: string }) {
  return (
    <div style={{ textAlign: "center", padding: "70px 24px", color: "var(--ink-4)" }}>
      <div style={{ marginBottom: 14 }}><EmptyArt kind={icon} /></div>
      <p style={{ fontSize: 16, color: "var(--ink)", margin: 0, fontWeight: 600, fontFamily: "var(--font-head)", letterSpacing: "-0.01em" }}>{title}</p>
      <p style={{ fontSize: 13, margin: "5px 0 0", lineHeight: 1.5 }}>{sub}</p>
    </div>
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

/* ---------------- WORKLOAD ---------------- */
export const DEFAULT_CAP = 40;   // weekly capacity (hours) unless set per person
const MIN_CAP = 1, MAX_CAP = 168;
const HEAVY = 12;         // tasks in one week that signal overload even without estimates
const CAP_KEY = "kanbo-capacity";
/** Weekly capacity (hours) per person id, as set on this device. */
export function readCapacities(): Record<string, number> {
  try { const v = JSON.parse(localStorage.getItem(CAP_KEY) || "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

export function WorkloadView({ tasks, members, onOpen }: {
  tasks: Task[];
  members: { id: string; name: string }[];
  onOpen: (id: string) => void;
}) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [caps, setCaps] = useState<Record<string, number>>(readCapacities);
  const capOf = (id: string) => { const c = caps[id]; return typeof c === "number" && c > 0 ? c : DEFAULT_CAP; };
  const setCap = (id: string, hours: number) => setCaps((cur) => {
    const next = { ...cur };
    const h = round1(hours);
    if (!(h > 0) || h === DEFAULT_CAP) delete next[id]; else next[id] = h;
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
  // compare the hours as shown (1 decimal), so "40h / 40h" is never flagged over capacity
  const isOver = (r: { id: string; hours: number }) => round1(r.hours) > capOf(r.id);
  const overloaded = rows.filter((r) => isMember(r.id) && (isOver(r) || r.items.length >= HEAVY));
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
          Estimated hours due in the week, per person. Tasks with a start and due date are spread across the working days between them{weekOffset === 0 ? "; overdue work counts in full this week, and work under way with no due date counts a weekly share" : ""}. Capacity is {DEFAULT_CAP}h unless you set one.
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
            const over = member && isOver(r);
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
                {over && <div style={{ fontSize: 11.5, color: "var(--prio-urgent)", marginTop: 6 }}>Over capacity by {fmtHours(round1(r.hours) - cap)}</div>}
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
                        <DraftInput type="number" min={MIN_CAP} max={MAX_CAP} value={cap} label={`Weekly capacity for ${name}, in hours`} title={`Between ${MIN_CAP} and ${MAX_CAP} hours`}
                          onCommit={(v) => {
                            // out of range (or cleared) → the box shows the capacity actually in use again
                            const h = Number(v);
                            if (v.trim() === "" || !(h >= MIN_CAP && h <= MAX_CAP)) return false;
                            setCap(r.id, h);
                            return String(round1(h));
                          }} style={{ ...inp, width: 72, height: 28, fontFamily: "var(--font-mono)", fontSize: 12.5 }} />
                        h <span style={{ fontSize: 11.5, color: "var(--ink-4)" }}>· {MIN_CAP}–{MAX_CAP}h · saved on this device</span>
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
