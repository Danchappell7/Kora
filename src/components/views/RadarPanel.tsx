/* ============================================================
   KANBO — Team › Pulse › Radar: the team's risks, ranked by impact on
   this week, each with the one-click fix that deals with it — Nudge or
   Check in (an @mention comment), Open chain, Rebalance (Workload with
   that person's week open), Set a firm date, Assign. Guests only open.
   ============================================================ */
import { useId, useRef, useState } from "react";
import { Avatar, Button, DateChip, EmptyState, Icon } from "../primitives";
import { Popover } from "../primitives/Popover";
import { useToast } from "../Toast";
import { getMember } from "../../data/data";
import type { Task } from "../../data/types";
import { fmtDayMonth, localDay } from "./reportingUtils";
import type { Risk, RiskFix } from "../../lib/radar";
import { focusWorkloadMember } from "./WorkloadView";

function useOptionalToast() { try { return useToast(); } catch { return null; } }

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;

export interface RadarPanelProps {
  risks: Risk[];
  members: { id: string; name: string; guest?: boolean }[];
  /** guests: every fix but Open is hidden */
  readOnly: boolean;
  onOpen: (id: string) => void;
  /** posts `text` as a comment on the task, mentioning `userId` */
  onNudge: (taskId: string, userId: string, text: string) => Promise<void>;
  onPatch: (id: string, patch: Partial<Task>) => void;
  onOpenWorkload: () => void;
  /** the tasks the risks point at: titles for the nudge text and the current due date for a firm date */
  tasks?: Task[];
  /** the change history is still loading: placeholders instead of a list that may reshuffle */
  loading?: boolean;
  /** you can't nudge yourself: those fixes are left off your own risks */
  currentUserId?: string;
}

export function RadarPanel({ risks, members, readOnly, onOpen, onNudge, onPatch, onOpenWorkload, tasks = [], loading, currentUserId }: RadarPanelProps) {
  const toast = useOptionalToast();
  const headId = "kradar-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  // what was just done about each risk ("Nudged Sana"), until the list moves on
  const [acks, setAcks] = useState<Record<string, string>>({});
  const ack = (riskId: string, text: string) => { setAcks((a) => ({ ...a, [riskId]: text })); toast?.success(text); };
  const taskOf = (id: string | undefined) => (id ? tasks.find((t) => t.id === id) : undefined);
  const nameOf = (id: string | undefined) => (id ? members.find((m) => m.id === id)?.name ?? getMember(id)?.name ?? "" : "");

  return (
    <section className="kradar" aria-labelledby={headId} aria-busy={loading || undefined}>
      <style>{RADAR_CSS}</style>
      <header className="kradar-head">
        <h2 className="kradar-title" id={headId}>
          Radar{!loading && <span className="kradar-count" aria-label={`, ${risks.length} ${risks.length === 1 ? "risk" : "risks"}`}>{risks.length}</span>}
        </h2>
        <span className="kradar-sub">Ranked by impact on this week</span>
      </header>
      {loading ? (
        <div className="kradar-list" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="kradar-item">
              <span className="skel" style={{ width: 20, height: 20, borderRadius: 999 }} />
              <div style={{ display: "grid", gap: 8 }}>
                <span className="skel" style={{ height: 12, width: `${78 - i * 14}%` }} />
                <span className="skel" style={{ height: 10, width: `${62 - i * 8}%` }} />
                <span className="skel" style={{ height: 24, width: 96, marginTop: 4 }} />
              </div>
            </div>
          ))}
        </div>
      ) : risks.length === 0 ? (
        <EmptyState size="sm" title="Nothing at risk" body="Kanbo checks blockers, slips, stale work and capacity." />
      ) : (
        <ol className="kradar-list">
          {risks.map((r, i) => {
            const focus = taskOf(r.focusTaskId ?? r.taskIds[0]);
            const self = !!currentUserId && r.memberId === currentUserId;
            const fixes = readOnly
              ? (r.taskIds.length ? [{ kind: "open", label: r.fixes.find((f) => f.kind === "open")?.label ?? "Open task" } as RiskFix] : [])
              : r.fixes.filter((f) => !(self && (f.kind === "nudge" || f.kind === "check_in")));
            const rest = r.mono && r.reason.startsWith(r.mono) ? r.reason.slice(r.mono.length) : r.reason;
            return (
              <li key={r.id} className="kradar-item" data-severity={r.severity}>
                <span className="kradar-rank" aria-hidden="true">{i + 1}</span>
                <div className="kradar-body">
                  <h3 className="kradar-risk">
                    <span className="sr-only">{r.severity === "signal" ? "Needs action: " : "Worth a look: "}</span>
                    {r.title}
                  </h3>
                  <p className="kradar-reason">
                    {r.mono && r.reason.startsWith(r.mono) && <span className="kradar-mono">{r.mono}</span>}
                    {rest}
                  </p>
                  {acks[r.id] && <p className="kradar-ack"><Icon name="check" size={14} sw={2} />{acks[r.id]}</p>}
                  {fixes.length > 0 && (
                    <div className="kradar-fixes">
                      {fixes.map((f, fi) => {
                        const variant = fi === 0 && !readOnly ? "primary" : "secondary";
                        const key = f.kind + fi;
                        if (f.kind === "open") return <Button key={key} size="sm" variant={variant} onClick={() => onOpen(r.taskIds[0])}>{f.label}</Button>;
                        if (f.kind === "rebalance") {
                          return <Button key={key} size="sm" variant={variant} onClick={() => { if (r.memberId) focusWorkloadMember(r.memberId); onOpenWorkload(); }}>{f.label}</Button>;
                        }
                        if ((f.kind === "nudge" || f.kind === "check_in") && r.memberId) {
                          const who = nameOf(r.memberId);
                          const title = focus?.title ?? r.title;
                          const text = f.kind === "nudge"
                            ? `@${firstName(who)} — is anything blocking "${title}"?`
                            : `@${firstName(who)} — how's "${title}" going?`;
                          return (
                            <NudgeFix key={key} label={f.label} variant={variant} who={who} taskTitle={title} initialText={text}
                              onSend={(body) => onNudge(focus?.id ?? r.taskIds[0], r.memberId!, body)}
                              onSent={() => ack(r.id, `Nudged ${firstName(who)}`)} />
                          );
                        }
                        if (f.kind === "firm_date" && focus) {
                          return (
                            <FirmDateFix key={key} label={f.label} variant={variant} task={focus}
                              onPick={(date) => { onPatch(focus.id, { dueDate: date }); ack(r.id, `Due ${fmtDate(date)} — saved`); }} />
                          );
                        }
                        if (f.kind === "assign" && focus) {
                          return (
                            <AssignFix key={key} label={f.label} variant={variant} task={focus} members={members.filter((m) => !m.guest)}
                              onPick={(m) => { onPatch(focus.id, { assigneeId: m.id }); ack(r.id, `Assigned to ${firstName(m.name)}`); }} />
                          );
                        }
                        return null;
                      })}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const fmtDate = (iso: string) => { const d = localDay(iso); return d ? `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${fmtDayMonth(d)}` : iso; };

type Variant = "primary" | "secondary";

/** Nudge / Check in: an editable @mention, posted as a comment on the task. */
function NudgeFix({ label, variant, who, taskTitle, initialText, onSend, onSent }: {
  label: string; variant: Variant; who: string; taskTitle: string; initialText: string;
  onSend: (text: string) => Promise<void>; onSent: () => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(initialText);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fieldId = "knudge-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const send = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true); setError(null);
    try {
      await onSend(body);
      setOpen(false);
      onSent();
    } catch {
      setError("Couldn't send the nudge. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button ref={btn} size="sm" variant={variant} aria-haspopup="dialog" aria-expanded={open}
        onClick={() => { setText(initialText); setError(null); setOpen((o) => !o); }}>{label}</Button>
      <Popover open={open} anchorRef={btn} onClose={() => setOpen(false)} role="dialog" label={label.startsWith("Nudge") ? label : `${label} with ${firstName(who)}`} minWidth={320} initialFocus={field} className="knudge" style={{ padding: 12 }}>
        <form className="knudge-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          <label htmlFor={fieldId} className="knudge-label">Comment on <span className="knudge-task">{taskTitle}</span></label>
          <textarea id={fieldId} ref={field} rows={3} value={text} onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); } }} />
          {error && <p className="knudge-error" role="alert">{error}</p>}
          <div className="knudge-actions">
            <span className="knudge-hint">{firstName(who)} gets a notification</span>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" variant="primary" type="submit" icon="send" loading={busy} disabled={!text.trim()}>Send</Button>
          </div>
        </form>
      </Popover>
    </>
  );
}

/** Set a firm date: the date picker, straight away; nothing picked puts the button back. */
function FirmDateFix({ label, variant, task, onPick }: { label: string; variant: Variant; task: Task; onPick: (iso: string) => void }) {
  const [editing, setEditing] = useState(false);
  const wrap = useRef<HTMLSpanElement>(null);
  if (!editing) return <Button size="sm" variant={variant} icon="calendar" onClick={() => setEditing(true)}>{label}</Button>;
  return (
    <span ref={wrap} className="kradar-firm"
      onBlur={() => window.setTimeout(() => {
        const w = wrap.current;
        // still choosing (the picker is open), or focus stayed on the chip: keep it
        if (!w || w.querySelector('[aria-expanded="true"]') || w.contains(document.activeElement)) return;
        setEditing(false);
      }, 0)}>
      <DateChip size="md" defaultOpen value={task.dueDate} label={`Firm due date for ${task.title}`}
        onChange={(date) => { if (!date) return; onPick(date); setEditing(false); }} />
    </span>
  );
}

/** Assign: a menu of the team. */
function AssignFix({ label, variant, task, members, onPick }: {
  label: string; variant: Variant; task: Task; members: { id: string; name: string }[]; onPick: (m: { id: string; name: string }) => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button ref={btn} size="sm" variant={variant} icon="user" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{label}</Button>
      <Popover open={open} anchorRef={btn} onClose={() => setOpen(false)} role="menu" label={`Assign ${task.title}`} minWidth={220} maxHeight={320} className="kassign">
        {members.length === 0 && <p className="kassign-empty">No one to assign yet.</p>}
        {members.map((m) => (
          <button key={m.id} type="button" role="menuitem" className="kassign-item" onClick={() => { setOpen(false); onPick(m); }}>
            {getMember(m.id) ? <Avatar id={m.id} size={20} /> : <span className="kassign-dot" aria-hidden="true">{firstName(m.name).charAt(0).toUpperCase()}</span>}
            <span className="truncate">{m.name}</span>
          </button>
        ))}
      </Popover>
    </>
  );
}

const RADAR_CSS = `
.kradar { display: flex; flex-direction: column; min-width: 0; }
.kradar-head { display: flex; align-items: center; gap: 8px; min-height: 48px; }
.kradar-title { display: inline-flex; align-items: baseline; gap: 8px; margin: 0; font: 600 14px/20px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink); }
.kradar-count { font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kradar-sub { margin-left: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-align: right; }
.kradar-list { list-style: none; margin: 0; padding: 0; }
.kradar-item { display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 0 12px; padding: 16px 0; border-top: 1px solid var(--hairline); }
.kradar-item:first-child { border-top: 0; padding-top: 4px; }
.kradar-rank { width: 20px; height: 20px; margin-top: 0; border-radius: 999px; display: grid; place-items: center;
  font: 500 11px/1 var(--font-mono); font-variant-numeric: tabular-nums; background: var(--fill-1); color: var(--ink-3); }
.kradar-item[data-severity="signal"] .kradar-rank { background: var(--signal-tint, color-mix(in oklch, var(--st-blocked) 10%, transparent)); color: var(--signal, var(--st-blocked)); }
.kradar-item[data-severity="warn"] .kradar-rank { background: color-mix(in oklch, var(--warn-fill, var(--st-review)) 14%, transparent); color: var(--warn, var(--st-review)); }
.kradar-body { min-width: 0; }
.kradar-risk { margin: 0; font: 600 13px/20px var(--font-ui, var(--font-display)); letter-spacing: 0; color: var(--ink); overflow-wrap: anywhere; }
.kradar-reason { margin: 2px 0 0; font: 500 12px/18px var(--font-ui, var(--font-display)); color: var(--ink-3); overflow-wrap: anywhere; }
.kradar-mono { font: 500 11px/18px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-2); }
.kradar-ack { display: flex; align-items: center; gap: 6px; margin: 8px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ok, var(--st-done)); }
.kradar-fixes { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 10px; }
.kradar-firm { display: inline-flex; }
/* the popover's own menu hover would repaint these buttons; keep the kit's look */
.knudge .kbtn[data-variant="primary"]:hover:not(:disabled) { background: var(--accent-hover, var(--accent-strong)) !important; color: var(--on-accent) !important; }
.knudge .kbtn[data-variant="ghost"]:hover:not(:disabled) { background: var(--fill-1) !important; color: var(--ink) !important; }
.knudge-form { display: grid; gap: 8px; width: min(340px, calc(100vw - 48px)); }
.knudge-label { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.knudge-task { color: var(--ink-2); font-weight: 600; }
.knudge textarea { width: 100%; resize: vertical; min-height: 72px; padding: 8px 10px; border-radius: var(--r-sm, 6px);
  border: 1px solid var(--field-border, var(--hairline-strong)); background: var(--field-bg, var(--surface)); color: var(--ink);
  font: 500 13px/20px var(--font-ui, var(--font-display)); }
.knudge textarea:hover { border-color: var(--field-border-hover, var(--hairline-strong)); }
.knudge-error { margin: 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--signal, var(--st-blocked)); }
.knudge-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; }
.knudge-hint { margin-right: auto; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kassign-item { display: flex; align-items: center; gap: 8px; width: 100%; height: 32px; padding: 0 8px; border: 0; border-radius: var(--r-sm, 6px);
  background: transparent; color: var(--ink); font: 500 13px/1 var(--font-ui, var(--font-display)); text-align: left; cursor: pointer; }
.kassign-dot { width: 20px; height: 20px; border-radius: 999px; display: grid; place-items: center; flex-shrink: 0; background: var(--fill-2); color: var(--ink-2); font: 600 10px/1 var(--font-ui, var(--font-display)); }
.kassign-empty { margin: 0; padding: 8px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
`;
