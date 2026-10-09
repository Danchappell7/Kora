/* ============================================================
   KANBO — the planner's review list: the draft grouped by section.
   Every row edits in place — title, owner, start and due dates, the
   estimate, milestone on/off, details (description and what it's
   blocked by) — and can be removed (with Undo) or moved: drag the grip
   (mouse, pen or touch), or focus it and press ↑ / ↓ (it crosses into
   the next section at either end). Sections rename in place, take a
   new task, or go with their tasks. Pure UI over lib/projectPlanner's
   draft helpers; the parent owns the draft.
   ============================================================ */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Avatar, avatarDisc, Button, DateChip, Icon, IconButton } from "../primitives";
import { getMember, memberInitials } from "../../data/data";
import {
  addPlanTask, dependentsOf, movePlanTask, nudgePlanTask, offsetForDate, patchPlanTask, PLAN_LIMITS, removePlanSection, removePlanTasks,
  renamePlanSection, taskDates, tasksBySection,
} from "../../lib/projectPlanner";
import type { PlanDraft, PlannerRosterMember, PlanSection, PlanTask } from "../../data/types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtH = (h: number) => `${Math.round(h * 10) / 10}h`;

export interface PlanReviewProps {
  draft: PlanDraft;
  /** an edit; `say` is announced to screen readers */
  onChange: (next: PlanDraft, say?: string) => void;
  /** a removal (offered as Undo): `before` is the draft to go back to */
  onRemove: (next: PlanDraft, before: PlanDraft, label: string) => void;
  roster: PlannerRosterMember[];
  currentUserId: string;
  /** tasks due after the deadline */
  lateKeys: ReadonlySet<string>;
  /** rows a warning's "Show" lit up */
  flashKeys: ReadonlySet<string>;
  /** a row to bring into view and focus (bumped by `focusSeq`) */
  focusKey?: string | null;
  focusSeq?: number;
  /** id prefix for rows ("<prefix>-row-<key>") */
  idPrefix: string;
}

/** An owner's disc: the workspace avatar when the app knows them, else initials in the same recipe. */
function PersonMark({ id, name }: { id: string | null; name?: string }) {
  if (!id) return <span className="kpl-who-none" aria-hidden="true"><Icon name="user" size={12} sw={1.75} /></span>;
  if (getMember(id)) return <Avatar id={id} size={20} />;
  const disc = avatarDisc("oklch(0.7 0.1 268)");
  return <span className="kpl-disc" aria-hidden="true" style={disc}>{memberInitials(name || "?")}</span>;
}

/** The estimate: typed freely, saved on blur or Enter (Escape puts it back). */
function HoursField({ value, label, onCommit }: { value: number | null; label: string; onCommit: (v: number | null) => void }) {
  const shown = value == null ? "" : String(value);
  const [text, setText] = useState(shown);
  const editing = useRef(false);
  useEffect(() => { if (!editing.current) setText(shown); }, [shown]);
  const commit = () => {
    editing.current = false;
    const t = text.trim().replace(",", ".");
    if (!t) { onCommit(null); return; }
    const n = Number(t);
    if (!Number.isFinite(n) || n < 0) { setText(shown); return; }
    const v = n === 0 ? null : Math.min(PLAN_LIMITS.estimateHours, Math.round(n * 4) / 4);
    setText(v == null ? "" : String(v));
    onCommit(v);
  };
  return (
    <label className="kpl-hours" title="Estimate in hours">
      <input className="kpl-hours-input" inputMode="decimal" value={text} placeholder="–" aria-label={label}
        onChange={(e) => { editing.current = true; setText(e.target.value); }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
          else if (e.key === "Escape") { e.stopPropagation(); editing.current = false; setText(shown); }
        }} />
      <span className="kpl-hours-unit" aria-hidden="true">h</span>
    </label>
  );
}

interface DropAt { section: string | null; index: number }

export function PlanReview({ draft, onChange, onRemove, roster, currentUserId, lateKeys, flashKeys, focusKey, focusSeq, idPrefix }: PlanReviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const groups = tasksBySection(draft);
  const titleOf = (t: PlanTask) => t.title.trim() || "Untitled task";
  const sectionName = (key: string | null) => draft.sections.find((s) => s.key === key)?.name.trim() || "No section";

  // a warning's "Show": bring the row into view and put focus on its title
  useEffect(() => {
    if (!focusKey) return;
    const row = document.getElementById(`${idPrefix}-row-${focusKey}`);
    row?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    row?.querySelector<HTMLInputElement>(".kpl-title")?.focus({ preventScroll: true });
  }, [focusKey, focusSeq, idPrefix]);

  /* ---------- moving ---------- */
  const say = (key: string, next: PlanDraft) => {
    const g = tasksBySection(next).find((x) => x.tasks.some((t) => t.key === key));
    const i = g ? g.tasks.findIndex((t) => t.key === key) : -1;
    const t = next.tasks.find((x) => x.key === key);
    return g && t ? `Moved “${titleOf(t)}” to ${g.section?.name.trim() || "No section"}, ${i + 1} of ${g.tasks.length}.` : undefined;
  };
  const refocusGrip = (key: string) => window.requestAnimationFrame(() => document.getElementById(`${idPrefix}-grip-${key}`)?.focus({ preventScroll: false }));
  const nudge = (key: string, delta: -1 | 1) => {
    const next = nudgePlanTask(draft, key, delta);
    if (next === draft) return;
    onChange(next, say(key, next));
    refocusGrip(key);
  };

  // pointer drag on the grip (mouse, pen and touch alike)
  const drag = useRef<{ key: string; id: number; x: number; y: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropAt | null>(null);
  const dropRef = useRef<DropAt | null>(null);
  const countIn = (section: string | null) => draft.tasks.filter((t) => (t.sectionKey ?? null) === section).length;
  const targetAt = (x: number, y: number): DropAt | null => {
    const root = rootRef.current;
    const el = typeof document.elementFromPoint === "function" ? (document.elementFromPoint(x, y) as HTMLElement | null) : null;
    if (!root || !el || !root.contains(el)) return null;
    const row = el.closest<HTMLElement>("[data-plrow]");
    if (row) {
      const r = row.getBoundingClientRect();
      const i = Number(row.dataset.index);
      return { section: row.dataset.section || null, index: y < r.top + r.height / 2 ? i : i + 1 };
    }
    const sec = el.closest<HTMLElement>("[data-plsec]");
    if (sec) return { section: sec.dataset.section || null, index: sec.dataset.end ? countIn(sec.dataset.section || null) : 0 };
    return null;
  };
  const onGripDown = (e: ReactPointerEvent<HTMLButtonElement>, key: string) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { key, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };
  const onGripMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
    if (!d.moved) { d.moved = true; setDragging(d.key); }
    const at = targetAt(e.clientX, e.clientY);
    dropRef.current = at;
    setDropAt(at);
    // near the top or bottom of the sheet, scroll it
    const body = rootRef.current?.closest<HTMLElement>(".ksheet-body");
    if (body) {
      const r = body.getBoundingClientRect();
      if (e.clientY < r.top + 48) body.scrollTop -= 14;
      else if (e.clientY > r.bottom - 48) body.scrollTop += 14;
    }
  };
  const endDrag = (commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    const at = dropRef.current;
    dropRef.current = null;
    setDragging(null);
    setDropAt(null);
    if (!commit || !d?.moved || !at) return;
    const t = draft.tasks.find((x) => x.key === d.key);
    if (!t) return;
    let index = at.index;
    // the target index counts the dragged task; movePlanTask counts without it
    if ((t.sectionKey ?? null) === at.section) {
      const cur = draft.tasks.filter((x) => (x.sectionKey ?? null) === at.section).findIndex((x) => x.key === d.key);
      if (cur >= 0 && cur < index) index -= 1;
      if (cur === index) return;
    }
    const next = movePlanTask(draft, d.key, at.section, index);
    onChange(next, say(d.key, next));
  };
  const onGripKey = (e: ReactKeyboardEvent<HTMLButtonElement>, key: string) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); nudge(key, e.key === "ArrowUp" ? -1 : 1); }
    else if (e.key === "Escape" && drag.current) { e.stopPropagation(); endDrag(false); }
  };

  /* ---------- editing ---------- */
  const patch = (key: string, p: Partial<Omit<PlanTask, "key">>, said?: string) => onChange(patchPlanTask(draft, key, p), said);
  const removeTask = (t: PlanTask) => onRemove(removePlanTasks(draft, [t.key]), draft, `“${titleOf(t)}”`);
  const removeSection = (s: PlanSection, n: number) => onRemove(removePlanSection(draft, s.key), draft, n ? `“${s.name.trim() || "Untitled section"}” and its ${plural(n, "task")}` : `“${s.name.trim() || "Untitled section"}”`);
  const addTask = (section: string | null) => {
    const r = addPlanTask(draft, section);
    if (!r) return;
    onChange(r.draft, `Added a task to ${sectionName(section)}.`);
    window.requestAnimationFrame(() => document.getElementById(`${idPrefix}-row-${r.key}`)?.querySelector<HTMLInputElement>(".kpl-title")?.focus());
  };
  const toggleOpen = (key: string) => setOpen((cur) => { const n = new Set(cur); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const atCap = draft.tasks.length >= PLAN_LIMITS.tasks;
  // numbered through the whole plan, as shown, for the fields' names
  const numberOf = new Map(groups.flatMap((g) => g.tasks).map((t, i) => [t.key, i + 1]));

  return (
    <div className="kpl-list" ref={rootRef} data-dragging={dragging ? "true" : undefined}>
      <p id={hintId} className="sr-only">To move a task, focus its handle and press the up or down arrow, or drag it.</p>
      {groups.map((g) => {
        const sKey = g.section?.key ?? null;
        const hours = g.tasks.reduce((s, t) => s + (t.isMilestone ? 0 : t.estimateHours ?? 0), 0);
        const name = g.section?.name ?? "No section";
        const headId = `${idPrefix}-sec-${sKey ?? "none"}`;
        return (
          <section key={sKey ?? "none"} className="kpl-sec" aria-labelledby={headId}>
            <div className="kpl-sec-head" data-plsec="" data-section={sKey ?? ""}>
              <h3 className="sr-only" id={headId}>{name.trim() || "Untitled section"}</h3>
              {g.section ? (
                <input className="kpl-sec-name" value={g.section.name} maxLength={PLAN_LIMITS.sectionName} aria-label="Section name"
                  onChange={(e) => onChange(renamePlanSection(draft, g.section!.key, e.target.value))}
                  onBlur={(e) => { if (!e.target.value.trim()) onChange(renamePlanSection(draft, g.section!.key, "Untitled section")); }} />
              ) : <span className="kpl-sec-name" data-static="true">No section</span>}
              <span className="kpl-sec-meta">
                <span>{plural(g.tasks.length, "task")}</span>
                {hours > 0 && <span className="kpl-mono">{fmtH(hours)}</span>}
              </span>
              <span className="kpl-sec-acts">
                <IconButton icon="plus" size="sm" label={`Add a task to ${name.trim() || "this section"}`} disabled={atCap} onClick={() => addTask(sKey)} />
                {g.section && <IconButton icon="trash" size="sm" tone="danger" label={`Remove ${name.trim() || "this section"}${g.tasks.length ? ` and its ${plural(g.tasks.length, "task")}` : ""}`} onClick={() => removeSection(g.section!, g.tasks.length)} />}
              </span>
            </div>
            {g.tasks.length ? (
              <ul className="kpl-rows" aria-label={`Tasks in ${name.trim() || "this section"}`}>
                {g.tasks.map((t, i) => {
                  const drop = dropAt && dragging !== t.key && (dropAt.section ?? null) === sKey
                    ? (dropAt.index === i ? "before" : dropAt.index === i + 1 && i === g.tasks.length - 1 ? "after" : undefined) : undefined;
                  return (
                    <PlanRow key={t.key} task={t} index={i} number={numberOf.get(t.key) ?? i + 1} sectionKey={sKey} draft={draft} roster={roster} currentUserId={currentUserId}
                      idPrefix={idPrefix} hintId={hintId} late={lateKeys.has(t.key)} flash={flashKeys.has(t.key)} open={open.has(t.key)}
                      dragging={dragging === t.key} drop={drop}
                      onToggleOpen={() => toggleOpen(t.key)} onPatch={(p, said) => patch(t.key, p, said)} onRemove={() => removeTask(t)}
                      onGripDown={(e) => onGripDown(e, t.key)} onGripMove={onGripMove} onGripUp={() => endDrag(true)} onGripCancel={() => endDrag(false)}
                      onGripKey={(e) => onGripKey(e, t.key)} />
                  );
                })}
              </ul>
            ) : (
              <div className="kpl-sec-empty" data-plsec="" data-section={sKey ?? ""} data-drop={dropAt && (dropAt.section ?? null) === sKey ? "inside" : undefined}>
                No tasks here yet. Drag one in, or add one.
              </div>
            )}
            <div className="kpl-sec-foot" data-plsec="" data-end="true" data-section={sKey ?? ""}>
              <Button variant="ghost" size="sm" icon="plus" disabled={atCap} onClick={() => addTask(sKey)}>Add a task</Button>
            </div>
          </section>
        );
      })}
    </div>
  );
}

function PlanRow({
  task, index, number, sectionKey, draft, roster, currentUserId, idPrefix, hintId, late, flash, open, dragging, drop,
  onToggleOpen, onPatch, onRemove, onGripDown, onGripMove, onGripUp, onGripCancel, onGripKey,
}: {
  task: PlanTask;
  /** position in its section (drag and drop) */
  index: number;
  /** position in the whole plan (names) */
  number: number;
  sectionKey: string | null;
  draft: PlanDraft;
  roster: PlannerRosterMember[];
  currentUserId: string;
  idPrefix: string;
  hintId: string;
  late: boolean;
  flash: boolean;
  open: boolean;
  dragging: boolean;
  drop?: "before" | "after";
  onToggleOpen: () => void;
  onPatch: (p: Partial<Omit<PlanTask, "key">>, said?: string) => void;
  onRemove: () => void;
  onGripDown: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onGripMove: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onGripUp: () => void;
  onGripCancel: () => void;
  onGripKey: (e: ReactKeyboardEvent<HTMLButtonElement>) => void;
}) {
  const name = task.title.trim() || `task ${number}`;
  const { start, due } = taskDates(draft, task);
  const owner = roster.find((r) => r.id === task.assigneeId) ?? null;
  const ownerGone = !!task.assigneeId && !owner;
  const blockers = task.dependsOn.map((k) => draft.tasks.find((t) => t.key === k)).filter((t): t is PlanTask => !!t);
  const moreId = `${idPrefix}-more-${task.key}`;
  // what it may wait for: anything but itself and what already waits for it (no loops)
  const waiting = open ? dependentsOf(draft, task.key) : new Set<string>();
  const candidates = open ? draft.tasks.filter((t) => t.key !== task.key && !waiting.has(t.key) && !task.dependsOn.includes(t.key)) : [];

  return (
    <li id={`${idPrefix}-row-${task.key}`} className="kpl-row" data-plrow="" data-section={sectionKey ?? ""} data-index={index}
      data-milestone={task.isMilestone || undefined} data-late={late || undefined} data-flash={flash || undefined}
      data-open={open || undefined} data-dragging={dragging || undefined} data-drop={drop}>
      <div className="kpl-row-main">
        <button type="button" id={`${idPrefix}-grip-${task.key}`} className="kpl-grip" aria-label={`Move “${name}”`} aria-describedby={hintId}
          onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripCancel} onKeyDown={onGripKey}>
          <svg width="10" height="16" viewBox="0 0 10 16" aria-hidden="true" focusable="false">
            {[3, 8, 13].map((y) => [3, 7].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.3" fill="currentColor" />))}
          </svg>
        </button>
        {task.isMilestone && <span className="kpl-ms-glyph" aria-hidden="true" />}
        <input className="kpl-title" value={task.title} maxLength={PLAN_LIMITS.title} placeholder="Name this task"
          aria-label={`Title of ${task.isMilestone ? "milestone" : "task"} ${number}`}
          onChange={(e) => onPatch({ title: e.target.value })} />
        <div className="kpl-meta">
          {!task.isMilestone && (
            <label className="kpl-who" data-empty={!task.assigneeId || undefined}>
              <PersonMark id={task.assigneeId} name={owner?.name} />
              <select className="kpl-select" value={owner ? owner.id : ""} aria-label={`Who does “${name}”`}
                onChange={(e) => onPatch({ assigneeId: e.target.value || null })}>
                <option value="">{ownerGone ? "Someone who's left" : "Unassigned"}</option>
                {roster.map((r) => (
                  <option key={r.id} value={r.id}>{r.name}{r.id === currentUserId ? " (me)" : ""}{r.guest ? " (guest)" : ""}</option>
                ))}
              </select>
            </label>
          )}
          <span className="kpl-dates">
            {!task.isMilestone && (
              <>
                <DateChip value={start} label={`Start of “${name}”`} tone="plain"
                  onChange={(d) => { if (d) onPatch({ startOffset: offsetForDate(draft.startDate, d, "start") }); }} />
                <span className="kpl-dates-sep" aria-hidden="true">→</span>
              </>
            )}
            <span className="kpl-due">
              <DateChip value={due} label={task.isMilestone ? `Date of “${name}”` : `Due date of “${name}”`} tone="plain"
                onChange={(d) => { if (d) onPatch(task.isMilestone ? { dueOffset: offsetForDate(draft.startDate, d, "due"), startOffset: offsetForDate(draft.startDate, d, "due") } : { dueOffset: offsetForDate(draft.startDate, d, "due") }); }} />
            </span>
            {late && <span className="kpl-late">After the deadline</span>}
          </span>
          {!task.isMilestone && <HoursField value={task.estimateHours} label={`Estimate for “${name}”, in hours`} onCommit={(v) => onPatch({ estimateHours: v })} />}
          <span className="kpl-row-acts">
            <button type="button" className="kpl-ms" aria-pressed={task.isMilestone} aria-label={`Milestone: “${name}”`} data-tip={task.isMilestone ? "Milestone (on)" : "Make it a milestone"}
              onClick={() => onPatch({ isMilestone: !task.isMilestone }, task.isMilestone ? `“${name}” is a task again.` : `“${name}” is a milestone.`)}>
              <span className="kpl-ms-mark" aria-hidden="true" />
            </button>
            <IconButton icon={open ? "chevronDown" : "chevronRight"} size="sm" label={`Details of “${name}”`} aria-expanded={open} aria-controls={moreId} onClick={onToggleOpen} />
            <IconButton icon="trash" size="sm" tone="danger" label={`Remove “${name}”`} onClick={onRemove} />
          </span>
        </div>
      </div>
      {!open && (blockers.length > 0 || task.description) && (
        <p className="kpl-row-sub">
          {blockers.length > 0 && <span className="kpl-blocked"><Icon name="link" size={12} sw={2} />{blockers.length === 1 ? `After “${blockers[0].title.trim() || "a task"}”` : `After ${blockers.length} tasks`}</span>}
          {task.description && <span className="kpl-desc">{task.description}</span>}
        </p>
      )}
      <div id={moreId} className="kpl-more" hidden={!open}>
        {open && (
          <>
            <label className="kpl-more-field">
              <span className="kpl-more-label">Description</span>
              <textarea className="kpl-more-text" value={task.description} maxLength={PLAN_LIMITS.description} rows={2} aria-label={`Description of “${name}”`}
                placeholder="What does done look like?" onChange={(e) => onPatch({ description: e.target.value })} />
            </label>
            <div className="kpl-more-field" role="group" aria-label={`What “${name}” is blocked by`}>
              <span className="kpl-more-label">Blocked by</span>
              <div className="kpl-chips">
                {blockers.map((b) => (
                  <span key={b.key} className="kpl-chip">
                    <span className="kpl-chip-text">{b.title.trim() || "Untitled task"}</span>
                    <button type="button" className="kpl-chip-x" aria-label={`“${name}” no longer waits for “${b.title.trim() || "Untitled task"}”`}
                      onClick={() => onPatch({ dependsOn: task.dependsOn.filter((k) => k !== b.key) })}>
                      <Icon name="x" size={12} sw={2} />
                    </button>
                  </span>
                ))}
                {candidates.length > 0 && (
                  <select className="kpl-select" data-add="true" value="" aria-label={`Add something “${name}” waits for`}
                    onChange={(e) => { if (e.target.value) onPatch({ dependsOn: [...task.dependsOn, e.target.value] }); }}>
                    <option value="">{blockers.length ? "Add another…" : "Add a task it waits for…"}</option>
                    {candidates.map((c) => <option key={c.key} value={c.key}>{c.title.trim() || "Untitled task"}</option>)}
                  </select>
                )}
                {!blockers.length && !candidates.length && <span className="kpl-more-none">Nothing it can wait for yet.</span>}
              </div>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
