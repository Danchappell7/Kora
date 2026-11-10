/* ============================================================
   KANBO — the parts of a goal card that Goals 2.0 (0052) adds: who
   owns it and its quarter, where it should be by now (and the status
   that would say so), its check-ins, the work it's linked to, and the
   rest of its settings. Each one reads only; the card decides who may
   change what (lib/goalRules).
   ============================================================ */
import { useState } from "react";
import { Avatar, Button, DateChip, Icon, IconButton, Pill, Segmented, Toggle } from "../primitives";
import { getMember, getProject } from "../../data/data";
import type { Goal, GoalCheckin, GoalKind, GoalLink, GoalPaceMode, GoalStatus, Project, Task, WorkspaceMember } from "../../data/types";
import type { GoalProgress } from "../../lib/goalProgress";
import { periodChoices, periodLabel, periodRange } from "../../lib/goalPeriods";
import { paceDisagrees, type PaceRead } from "../../lib/goalPace";
import { FORMER_MEMBER } from "../../lib/statusDraft";
import type { DotTone } from "../../lib/goalFlow";
import "./goals.css";

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", done: "Achieved" };
type Tone = "neutral" | "accent" | "ok" | "warn" | "signal";
/** A status as a pill or a select reads it. */
export const GOAL_TONE: Record<GoalStatus, { tone: Tone }> = { on_track: { tone: "ok" }, at_risk: { tone: "warn" }, off_track: { tone: "signal" }, done: { tone: "accent" } };
export const KIND_LABEL: Record<GoalKind, string> = { objective: "Goal", key_result: "Key result", metric: "Metric" };
const PACE_LABEL: Record<GoalPaceMode, string> = { linear: "Steady", backloaded: "Back-loaded", off: "No pace line" };
export const CONFIDENCE_LABEL = ["", "Very low", "Low", "Medium", "High", "Very high"];

/** A goal's numbers, as people write them: 3,760 · 6.6 · 0.85 */
export const fmtNum = (n: number | null | undefined): string =>
  n == null || !isFinite(n) ? "–" : n.toLocaleString("en-GB", { maximumFractionDigits: 2 });
const withUnit = (n: number | null | undefined, unit?: string) => {
  const v = fmtNum(n);
  if (!unit) return v;
  return unit === "%" ? `${v}%` : /^[£$€]/.test(unit) ? `${unit.slice(0, 1)}${v}${unit.slice(1)}` : `${v} ${unit}`;
};
export { withUnit as fmtGoalValue };

const DAY = 86_400_000;
const midday = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
/** "today", "yesterday", "3 days ago" */
export function daysAgo(iso: string, today: Date): string {
  const n = Math.round((midday(today) - midday(new Date(iso))) / DAY);
  return n <= 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`;
}
/** A person's name for a goal (first name), or "Former member" once their account is gone. */
export const personName = (id: string | null | undefined, members?: WorkspaceMember[]): string => {
  if (!id) return FORMER_MEMBER;
  const name = getMember(id)?.name ?? members?.find((m) => m.userId === id)?.name;
  return name?.trim() || FORMER_MEMBER;
};
const first = (name: string) => (name === FORMER_MEMBER ? name : name.split(/\s+/)[0] || name);

/** A goal's identity, as a project tile reads one: its icon (else its name's initial) on its colour
 *  (else a hue its id picks, the same every time). */
export const goalTile = (g: Pick<Goal, "id" | "name" | "icon" | "color">) => ({ id: g.id, name: g.name, emoji: g.icon ?? undefined, color: g.color ?? "" });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** An inline "add" row: a name field with Add and Cancel. */
export function GoalAdder({ label, placeholder, onAdd, onCancel, className }: { label: string; placeholder: string; onAdd: (name: string) => void; onCancel: () => void; className?: string }) {
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

/** A goal's numbers in words: "3,760 of 5,000 users, from 3,200" or "6.6%, down to 5%, from 8%"
 *  (`from: false`: without where it started, for a row). */
export function numbersLine(g: Goal, { from = true }: { from?: boolean } = {}): string {
  const now = g.current ?? g.startValue ?? 0;
  const head = g.direction === "lower" ? `${withUnit(now, g.unit)}, down to ${withUnit(g.target, g.unit)}`
    : g.unit && !/^[£$€%]/.test(g.unit) ? `${withUnit(now)} of ${withUnit(g.target, g.unit)}` : `${withUnit(now, g.unit)} of ${withUnit(g.target, g.unit)}`;
  return from && g.startValue != null && g.startValue !== 0 ? `${head}, from ${withUnit(g.startValue, g.unit)}` : head;
}

/** The project a goal reads its % from, archived ones included (they keep their progress). */
export function linkedOf(g: Goal, projects: Project[]): Project | undefined {
  return g.projectId ? (getProject(g.projectId) ?? projects.find((p) => p.id === g.projectId)) : undefined;
}

/** Where a goal's % comes from: its project (top-level tasks done), its key results, or its own number. */
export function GoalSource({ prog, linked, weighted }: { prog: GoalProgress; linked?: Project; weighted?: boolean }) {
  return (
    <div style={{ marginTop: 6 }}>
      {prog.source === "project" && (
        <span className="kpj-goal-source" title="The share of the project's tasks that are done (sub-tasks count with their parent)">
          From project {linked?.name ?? "—"}{linked?.archivedAt ? " (archived)" : ""}
        </span>
      )}
      {prog.source === "subgoals" && <span className="kpj-goal-source" title="Enter a current value to track this goal's own number instead">{weighted ? "Weighted average" : "Average"} of {plural(prog.children, "key result")}</span>}
      {prog.source === "manual" && prog.subPct !== undefined && <span className="kpj-goal-source">Own value · {plural(prog.children, "key result")} {weighted ? "weighted average" : "average"} {prog.subPct}%</span>}
    </div>
  );
}

/* ---------------- owner and period ---------------- */

/** "Maya Lin · Q4 2026 · Leadership only": who owns the goal and when it runs. Editors of
 *  each part get a picker; everyone else reads it. */
export function GoalMetaRow({ goal, members, canHandOver, canEdit, today, onUpdate }: {
  goal: Goal;
  /** the workspace's active members (guests left out): who can own or help */
  members: WorkspaceMember[];
  canHandOver: boolean;
  canEdit: boolean;
  today: Date;
  onUpdate: (patch: Partial<Goal>) => void;
}) {
  const personal = (goal.workspaceId ?? null) === null;
  const owners = members.filter((m) => m.userId && m.role !== "guest");
  const ownerName = goal.ownerId ? personName(goal.ownerId, members) : "No owner";
  const choices = periodChoices(today);
  const known = !goal.period || goal.period === "custom" || choices.some((c) => c.value === goal.period);
  const setPeriod = (value: string) => {
    if (value === "custom") {
      // your own dates start from the quarter it was in (or this one), to adjust
      const r = periodRange(goal.period, goal.periodStart, goal.periodEnd) ?? periodRange(choices[0].value)!;
      onUpdate({ period: "custom", periodStart: r.start, periodEnd: r.end });
    } else if (!value) onUpdate({ period: null, periodStart: null, periodEnd: null });
    else { const r = periodRange(value)!; onUpdate({ period: value, periodStart: r.start, periodEnd: r.end }); }
  };
  return (
    <div className="kgl-meta">
      {!personal && (
        <span className="kgl-owner">
          {goal.ownerId ? <Avatar id={goal.ownerId} size={20} /> : <span className="kgl-noface" aria-hidden="true"><Icon name="user" size={12} /></span>}
          {canHandOver ? (
            <select className="kpj-field kgl-select" data-size="sm" value={goal.ownerId ?? ""} aria-label={`Owner of ${goal.name}`}
              onChange={(e) => onUpdate({ ownerId: e.target.value || null })}>
              <option value="">No owner</option>
              {goal.ownerId && !owners.some((m) => m.userId === goal.ownerId) && <option value={goal.ownerId}>{ownerName}</option>}
              {owners.map((m) => <option key={m.userId!} value={m.userId!}>{m.name}</option>)}
            </select>
          ) : <span className="kgl-owner-name" title="Owner">{ownerName}</span>}
        </span>
      )}
      {canEdit ? (
        <span className="kgl-period">
          <Icon name="calendar" size={14} sw={1.75} />
          <select className="kpj-field kgl-select" data-size="sm" value={goal.period ?? ""} aria-label={`Period of ${goal.name}`} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">No quarter</option>
            {!known && <option value={goal.period!}>{periodLabel(goal.period)}</option>}
            {(["Quarter", "Half", "Year"] as const).map((group) => (
              <optgroup key={group} label={group}>
                {choices.filter((c) => c.group === group).map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              </optgroup>
            ))}
            <option value="custom">{goal.period === "custom" ? periodLabel("custom", goal.periodStart, goal.periodEnd) : "Your own dates…"}</option>
          </select>
          {goal.period === "custom" && (
            <span className="kgl-dates">
              <DateChip size="sm" tone="plain" label={`Start of ${goal.name}'s period`} value={goal.periodStart ?? undefined}
                onChange={(d) => d && (!goal.periodEnd || d <= goal.periodEnd) && onUpdate({ period: "custom", periodStart: d, periodEnd: goal.periodEnd })} />
              <span aria-hidden="true">–</span>
              <DateChip size="sm" tone="plain" label={`End of ${goal.name}'s period`} value={goal.periodEnd ?? undefined}
                onChange={(d) => d && (!goal.periodStart || d >= goal.periodStart) && onUpdate({ period: "custom", periodStart: goal.periodStart, periodEnd: d })} />
            </span>
          )}
        </span>
      ) : goal.period ? (
        <span className="kgl-period"><Icon name="calendar" size={14} sw={1.75} />{periodLabel(goal.period, goal.periodStart, goal.periodEnd)}</span>
      ) : null}
      {goal.kind && goal.kind !== "objective" && <span className="kgl-kind">{KIND_LABEL[goal.kind]}</span>}
      {goal.visibility === "leadership" && <Pill tone="neutral" icon="lock" title="Only owners, admins, the goal's owner and the people helping can see it, and the goals under it">Leadership only</Pill>}
    </div>
  );
}

/* ---------------- pace ---------------- */

/** "Behind pace by 12%", and when the goal's status says otherwise, what the pace suggests
 *  with a one-tap way to take it. Kanbo never changes the status itself. */
export function GoalPaceLine({ goal, read, canEdit, onAccept }: {
  goal: Goal;
  read: PaceRead | null;
  canEdit: boolean;
  onAccept: (status: GoalStatus) => void;
}) {
  if (!read) return null;
  const differs = paceDisagrees(goal.status, read);
  const tip = read.state === "early" ? undefined
    : `${read.mode === "backloaded" ? "Back-loaded pace" : "Steady pace"}: ${read.expected}% expected by today, ${read.actual}% done`;
  return (
    <p className="kgl-pace" data-state={read.state} data-differs={differs || undefined}>
      <span className="kgl-pace-line" title={tip}>{read.line}</span>
      {differs && (
        <>
          <span className="kgl-pace-say">
            {read.suggest === "done" ? "Kanbo suggests marking it achieved." : `Kanbo suggests ${GOAL_STATUS_LABEL[read.suggest]}.`}
          </span>
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={() => onAccept(read.suggest)}>
              {read.suggest === "done" ? "Mark achieved" : `Mark ${GOAL_STATUS_LABEL[read.suggest]}`}
            </Button>
          )}
        </>
      )}
    </p>
  );
}

/* ---------------- check-ins ---------------- */

/** The newest check-in in a line, a composer for a new one (editors), and the history. */
export function GoalCheckins({ goal, checkins, members, canEdit, canPost, today, me, isAdmin, onPost, onRemove, historyOpen = false, composeFirst = false }: {
  goal: Goal;
  /** this goal's, newest first */
  checkins: GoalCheckin[];
  members: WorkspaceMember[];
  canEdit: boolean;
  /** a check-in sets the goal's own number, so only goals that track one take them */
  canPost: boolean;
  today: Date;
  me: string;
  /** an owner or admin of the workspace (may take back anyone's check-in) */
  isAdmin: boolean;
  onPost: (value: number, confidence: number | null, note: string) => void;
  onRemove: (c: GoalCheckin) => void;
  /** the history shows from the start (the goal panel) */
  historyOpen?: boolean;
  /** the composer opens at once (a one-tap check-in from a row or Kanbo noticed) */
  composeFirst?: boolean;
}) {
  const [composing, setComposing] = useState(composeFirst && canEdit && canPost);
  const [showAll, setShowAll] = useState(historyOpen);
  const latest = checkins[0];
  const personal = (goal.workspaceId ?? null) === null;
  return (
    <div className="kgl-checkins">
      <div className="kgl-checkin-row">
        {historyOpen ? (
          // the panel lists every check-in below: here, only how sure the newest one is
          <span className="kgl-latest kgl-quiet">
            {latest ? (latest.confidence ? `Confidence ${CONFIDENCE_LABEL[latest.confidence].toLowerCase()} at the last check-in` : `${checkins.length} ${checkins.length === 1 ? "check-in" : "check-ins"}`) : canPost ? "No check-ins yet." : null}
          </span>
        ) : latest ? (
          <span className="kgl-latest">
            <span>Checked in {daysAgo(latest.createdAt, today)}{personal ? "" : ` by ${latest.authorId === me ? "you" : first(personName(latest.authorId, members))}`}:</span>
            <b className="kpj-mono">{withUnit(latest.value, goal.unit)}</b>
            {latest.confidence ? <span className="kgl-conf">Confidence {CONFIDENCE_LABEL[latest.confidence].toLowerCase()}</span> : null}
            {latest.note && <q className="kgl-note">{latest.note}</q>}
          </span>
        ) : <span className="kgl-latest kgl-quiet">{canPost ? "No check-ins yet." : null}</span>}
        <span className="kgl-checkin-acts">
          {checkins.length > 1 && !historyOpen && (
            <Button size="sm" variant="ghost" aria-expanded={showAll} onClick={() => setShowAll((v) => !v)}>
              {showAll ? "Hide history" : `History (${checkins.length})`}
            </Button>
          )}
          {canEdit && canPost && !composing && <Button size="sm" variant="secondary" icon="check" onClick={() => setComposing(true)}>Check in</Button>}
        </span>
      </div>
      {composing && (
        <CheckinComposer goal={goal} onCancel={() => setComposing(false)}
          onPost={(v, c, n) => { onPost(v, c, n); setComposing(false); }} />
      )}
      {showAll && (
        <ol className="kgl-history" aria-label={`Check-ins on ${goal.name}`}>
          {checkins.map((c) => (
            <li key={c.id}>
              <span className="kgl-history-when">{daysAgo(c.createdAt, today)}</span>
              <b className="kpj-mono">{withUnit(c.value, goal.unit)}</b>
              <span className="kgl-history-who">{personal ? "" : c.authorId === me ? "You" : first(personName(c.authorId, members))}</span>
              <span className="kgl-history-note">{c.note ?? ""}</span>
              {canEdit && (c.authorId === me || isAdmin || personal) ? (
                <IconButton icon="x" size="sm" tone="danger" label={`Take back the check-in of ${withUnit(c.value, goal.unit)}`} onClick={() => onRemove(c)} />
              ) : <span />}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function CheckinComposer({ goal, onPost, onCancel }: { goal: Goal; onPost: (value: number, confidence: number | null, note: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(String(goal.current ?? goal.startValue ?? ""));
  const [confidence, setConfidence] = useState<string>(goal.confidence ? String(goal.confidence) : "");
  const [note, setNote] = useState("");
  const n = Number(value);
  const ok = value.trim() !== "" && isFinite(n);
  const post = () => { if (ok) onPost(n, confidence ? Number(confidence) : null, note.trim()); };
  return (
    <div className="kgl-composer" role="group" aria-label={`Check in on ${goal.name}`}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}>
      <label className="kgl-field">
        <span>Where it stands{goal.unit ? ` (${goal.unit})` : ""}</span>
        {/* eslint-disable-next-line jsx-a11y/no-autofocus */}
        <input autoFocus type="number" inputMode="decimal" className="kpj-field kpj-mono" value={value} aria-invalid={!ok || undefined}
          onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") post(); }} />
      </label>
      <label className="kgl-field">
        <span>Confidence</span>
        <select className="kpj-field" value={confidence} onChange={(e) => setConfidence(e.target.value)}>
          <option value="">Not saying</option>
          {[5, 4, 3, 2, 1].map((c) => <option key={c} value={c}>{CONFIDENCE_LABEL[c]}</option>)}
        </select>
      </label>
      <label className="kgl-field kgl-field-grow">
        <span>Note</span>
        <input className="kpj-field" value={note} maxLength={280} placeholder="What moved it? (optional)"
          onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") post(); }} />
      </label>
      <span className="kgl-composer-acts">
        <Button variant="primary" size="sm" disabled={!ok} onClick={post}>Post check-in</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

/* ---------------- linked work ---------------- */

/** The projects, tasks and views a goal is linked to (its own workspace's), with a picker
 *  for editors. The project its % comes from is always among them; each project wears a
 *  dot for its health, and each name opens it. */
export function GoalLinks({ goal, links, projects, tasks, views = [], canEdit, onLink, onUnlink, onOpen, dot }: {
  goal: Goal;
  links: GoalLink[];
  /** this workspace's projects (archived ones may still be linked) */
  projects: Project[];
  tasks: Task[];
  /** the saved views it may link (its workspace's shared ones; a personal goal, your own) */
  views?: { id: string; name: string; emoji?: string | null }[];
  canEdit: boolean;
  onLink: (kind: "project" | "task" | "view", targetId: string) => void;
  onUnlink: (link: GoalLink) => void;
  onOpen?: (kind: "project" | "task" | "view", targetId: string) => void;
  /** a linked project's health */
  dot?: (projectId: string) => { tone: DotTone; label: string } | null;
}) {
  const projectOf = (id: string) => getProject(id) ?? projects.find((p) => p.id === id);
  // (work that's since been deleted drops out of the list)
  const shown = links.filter((l) => l.kind === "view" ? views.some((v) => v.id === l.targetId) || !views.length
    : l.kind === "project" ? !!projectOf(l.targetId) || l.targetId === goal.projectId : tasks.some((t) => t.id === l.targetId));
  const has = (kind: string, id: string) => links.some((l) => l.kind === kind && l.targetId === id);
  const progressFrom = goal.projectId && !has("project", goal.projectId) ? goal.projectId : null;
  if (!shown.length && !progressFrom && !canEdit) return null;
  const open = tasks.filter((t) => !t.parentId && t.status !== "done" && !t.archivedAt && !has("task", t.id) && projects.some((p) => p.id === t.projectId));
  const linkable = views.filter((v) => !has("view", v.id));
  const projectChip = (id: string, link?: GoalLink) => {
    const p = projectOf(id);
    const d = p ? dot?.(id) : null;
    return (
      <LinkChip key={link?.id ?? `from-${id}`} icon="folder" emoji={p?.emoji} label={p?.name ?? "Archived project"} dot={d ?? undefined}
        onOpen={onOpen && p ? () => onOpen("project", id) : undefined}
        onRemove={link && canEdit && id !== goal.projectId ? () => onUnlink(link) : undefined} />
    );
  };
  return (
    <div className="kgl-links" aria-label={`Work linked to ${goal.name}`}>
      {progressFrom && projectChip(progressFrom)}
      {shown.map((l) => {
        if (l.kind === "project") return projectChip(l.targetId, l);
        const t = l.kind === "task" ? tasks.find((x) => x.id === l.targetId) : undefined;
        const v = l.kind === "view" ? views.find((x) => x.id === l.targetId) : undefined;
        const label = l.kind === "task" ? t?.title ?? "" : v?.name ?? "Saved view";
        return (
          <LinkChip key={l.id} icon={l.kind === "task" ? "check" : "layers"} emoji={v?.emoji ?? undefined} label={label}
            onOpen={onOpen && (t || v) ? () => onOpen(l.kind, l.targetId) : undefined}
            onRemove={canEdit ? () => onUnlink(l) : undefined} />
        );
      })}
      {!shown.length && !progressFrom && <span className="kgl-quiet">None yet.</span>}
      {canEdit && (
        <select className="kpj-field kgl-select kgl-link-pick" data-size="sm" value="" aria-label={`Link work to ${goal.name}`}
          onChange={(e) => { const [kind] = e.target.value.split(":"); const id = e.target.value.slice(kind.length + 1); if (id) onLink(kind as "project" | "task" | "view", id); }}>
          <option value="">Link work…</option>
          <optgroup label="Projects">
            {projects.filter((p) => !p.archivedAt && !has("project", p.id) && p.id !== goal.projectId).map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
          </optgroup>
          {linkable.length > 0 && (
            <optgroup label="Saved views">
              {linkable.map((v) => <option key={v.id} value={`view:${v.id}`}>{v.name}</option>)}
            </optgroup>
          )}
          {projects.filter((p) => open.some((t) => t.projectId === p.id)).map((p) => (
            <optgroup key={p.id} label={`Tasks in ${p.name}`}>
              {open.filter((t) => t.projectId === p.id).map((t) => <option key={t.id} value={`task:${t.id}`}>{t.title}</option>)}
            </optgroup>
          ))}
        </select>
      )}
    </div>
  );
}

function LinkChip({ icon, emoji, label, dot, onOpen, onRemove }: {
  icon: "folder" | "check" | "layers"; emoji?: string; label: string; dot?: { tone: DotTone; label: string };
  onOpen?: () => void; onRemove?: () => void;
}) {
  const face = (
    <>
      {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name={icon} size={12} sw={1.75} />}
      <span className="kgl-chip-name">{label}</span>
      {dot && <span className="kgp-dot" data-tone={dot.tone} role="img" aria-label={dot.label} title={dot.label} />}
    </>
  );
  return (
    <span className="kgl-chip">
      {onOpen ? <button type="button" className="kgl-chip-open" onClick={onOpen} aria-label={`Open ${label}`}>{face}</button> : face}
      {onRemove && <button type="button" className="kgl-chip-x" aria-label={`Unlink ${label}`} onClick={onRemove}><Icon name="x" size={12} sw={2} /></button>}
    </span>
  );
}

/* ---------------- the rest of its settings ---------------- */

/** Kind, which way is better, the start value, the pace, its weight, who helps and who can
 *  see it. Each part only for whoever may change it. */
export function GoalDetails({ goal, members, canEdit, canHandOver, startInNumbers = false, onUpdate }: {
  goal: Goal;
  members: WorkspaceMember[];
  canEdit: boolean;
  canHandOver: boolean;
  /** where it started is set beside its target ("From 8 to 5"), not here */
  startInNumbers?: boolean;
  onUpdate: (patch: Partial<Goal>) => void;
}) {
  const personal = (goal.workspaceId ?? null) === null;
  const helpers = goal.contributors ?? [];
  const addable = members.filter((m) => m.userId && m.role !== "guest" && m.userId !== goal.ownerId && !helpers.includes(m.userId));
  const numOrNull = (v: string) => (v.trim() === "" || !isFinite(Number(v)) ? null : Number(v));
  return (
    <div className="kgl-details">
      <label className="kgl-field">
        <span>Kind</span>
        <select className="kpj-field" data-size="sm" value={goal.kind ?? "objective"} disabled={!canEdit} onChange={(e) => onUpdate({ kind: e.target.value as GoalKind })}>
          {(Object.keys(KIND_LABEL) as GoalKind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
        </select>
      </label>
      {!goal.projectId && (
        <>
          <div className="kgl-field">
            <span>Better when it's</span>
            {/* (never takes the current value as the start: a new goal's 0 isn't where it started) */}
            {canEdit ? (
              <Segmented ariaLabel={`Which way is better for ${goal.name}`} value={goal.direction ?? "higher"}
                options={[{ value: "higher", label: "Higher" }, { value: "lower", label: "Lower" }]}
                onChange={(d) => onUpdate({ direction: d })} />
            ) : <b>{goal.direction === "lower" ? "Lower" : "Higher"}</b>}
          </div>
          {!startInNumbers && <label className="kgl-field">
            <span>Started at</span>
            <input type="number" inputMode="decimal" className="kpj-field kpj-mono kgl-num" data-size="sm" disabled={!canEdit}
              defaultValue={goal.startValue ?? ""} key={`start-${goal.startValue ?? ""}`} placeholder={goal.direction === "lower" ? "Where it was" : "0"}
              onBlur={(e) => { const v = numOrNull(e.target.value); if (v !== (goal.startValue ?? null)) onUpdate({ startValue: v }); }} />
          </label>}
        </>
      )}
      <label className="kgl-field">
        <span>Pace</span>
        <select className="kpj-field" data-size="sm" value={goal.pace ?? "linear"} disabled={!canEdit} onChange={(e) => onUpdate({ pace: e.target.value as GoalPaceMode })}>
          {(Object.keys(PACE_LABEL) as GoalPaceMode[]).map((p) => <option key={p} value={p}>{PACE_LABEL[p]}</option>)}
        </select>
      </label>
      {goal.parentId && (
        <label className="kgl-field">
          <span>Counts</span>
          <select className="kpj-field" data-size="sm" value={String(goal.weight ?? 1)} disabled={!canEdit} onChange={(e) => onUpdate({ weight: Number(e.target.value) === 1 ? null : Number(e.target.value) })}>
            {[1, 2, 3, 4, 5].map((w) => <option key={w} value={w}>{w === 1 ? "Once" : `${w}×`} in its parent</option>)}
            {goal.weight && ![1, 2, 3, 4, 5].includes(goal.weight) && <option value={goal.weight}>{fmtNum(goal.weight)}× in its parent</option>}
          </select>
        </label>
      )}
      {!personal && (
        <div className="kgl-field kgl-field-wide">
          <span>Helping</span>
          <span className="kgl-helpers">
            {helpers.length === 0 && <span className="kgl-quiet">Nobody yet</span>}
            {helpers.map((id) => (
              <span key={id} className="kgl-chip">
                <Avatar id={id} size={16} />
                <span className="kgl-chip-name">{personName(id, members)}</span>
                {canHandOver && <button type="button" className="kgl-chip-x" aria-label={`Remove ${personName(id, members)}`} onClick={() => onUpdate({ contributors: helpers.filter((x) => x !== id) })}><Icon name="x" size={12} sw={2} /></button>}
              </span>
            ))}
            {canHandOver && addable.length > 0 && (
              <select className="kpj-field kgl-select" data-size="sm" value="" aria-label={`Add someone to help on ${goal.name}`}
                onChange={(e) => e.target.value && onUpdate({ contributors: [...helpers, e.target.value] })}>
                <option value="">Add someone…</option>
                {addable.map((m) => <option key={m.userId!} value={m.userId!}>{m.name}</option>)}
              </select>
            )}
          </span>
        </div>
      )}
      {!personal && canHandOver && (
        <div className="kgl-field kgl-field-wide">
          <Toggle checked={goal.visibility === "leadership"} label="Leadership only"
            description="Only owners, admins, the goal's owner and the people helping can see it, its check-ins and links, and the key results under it (each one's own people still see theirs)."
            onChange={(on) => onUpdate({ visibility: on ? "leadership" : "everyone" })} />
        </div>
      )}
    </div>
  );
}
