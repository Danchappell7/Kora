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
import { periodChoices, periodLabel, periodRange } from "../../lib/goalPeriods";
import { paceDisagrees, type PaceRead } from "../../lib/goalPace";
import { FORMER_MEMBER } from "../../lib/statusDraft";

export const GOAL_STATUS_LABEL: Record<GoalStatus, string> = { on_track: "On track", at_risk: "At risk", off_track: "Off track", done: "Achieved" };
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
      {goal.visibility === "leadership" && <Pill tone="neutral" icon="lock" title="Only owners, admins, the goal's owner and the people helping can see it">Leadership only</Pill>}
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
export function GoalCheckins({ goal, checkins, members, canEdit, canPost, today, me, isAdmin, onPost, onRemove }: {
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
}) {
  const [composing, setComposing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const latest = checkins[0];
  const personal = (goal.workspaceId ?? null) === null;
  return (
    <div className="kgl-checkins">
      <div className="kgl-checkin-row">
        {latest ? (
          <span className="kgl-latest">
            <span>Checked in {daysAgo(latest.createdAt, today)}{personal ? "" : ` by ${first(personName(latest.authorId, members))}`}:</span>
            <b className="kpj-mono">{withUnit(latest.value, goal.unit)}</b>
            {latest.confidence ? <span className="kgl-conf">Confidence {CONFIDENCE_LABEL[latest.confidence].toLowerCase()}</span> : null}
            {latest.note && <q className="kgl-note">{latest.note}</q>}
          </span>
        ) : <span className="kgl-latest kgl-quiet">{canPost ? "No check-ins yet." : null}</span>}
        <span className="kgl-checkin-acts">
          {checkins.length > 1 && (
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
              {!personal && <span className="kgl-history-who">{first(personName(c.authorId, members))}</span>}
              {c.note && <span className="kgl-history-note">{c.note}</span>}
              {canEdit && (c.authorId === me || isAdmin || personal) && (
                <IconButton icon="x" size="sm" tone="danger" label={`Take back the check-in of ${withUnit(c.value, goal.unit)}`} onClick={() => onRemove(c)} />
              )}
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
 *  for editors. The project its % comes from is always among them. */
export function GoalLinks({ goal, links, projects, tasks, canEdit, onLink, onUnlink }: {
  goal: Goal;
  links: GoalLink[];
  /** this workspace's projects (archived ones may still be linked) */
  projects: Project[];
  tasks: Task[];
  canEdit: boolean;
  onLink: (kind: "project" | "task", targetId: string) => void;
  onUnlink: (link: GoalLink) => void;
}) {
  const projectOf = (id: string) => getProject(id) ?? projects.find((p) => p.id === id);
  const shown = links.filter((l) => l.kind !== "project" || projectOf(l.targetId) || l.targetId === goal.projectId);
  const has = (kind: string, id: string) => links.some((l) => l.kind === kind && l.targetId === id);
  const progressFrom = goal.projectId && !has("project", goal.projectId) ? goal.projectId : null;
  if (!shown.length && !progressFrom && !canEdit) return null;
  const open = tasks.filter((t) => !t.parentId && t.status !== "done" && !t.archivedAt && !has("task", t.id) && projects.some((p) => p.id === t.projectId));
  return (
    <div className="kgl-links" aria-label={`Work linked to ${goal.name}`}>
      <span className="kgl-links-head">Linked work</span>
      {progressFrom && <LinkChip icon="folder" label={projectOf(progressFrom)?.name ?? "Archived project"} emoji={projectOf(progressFrom)?.emoji} />}
      {shown.map((l) => {
        const p = l.kind === "project" ? projectOf(l.targetId) : undefined;
        const t = l.kind === "task" ? tasks.find((x) => x.id === l.targetId) : undefined;
        const label = l.kind === "project" ? p?.name ?? "Archived project" : l.kind === "task" ? t?.title ?? "A task you can't see" : "Saved view";
        return (
          <LinkChip key={l.id} icon={l.kind === "project" ? "folder" : l.kind === "task" ? "check" : "layers"} emoji={p?.emoji} label={label}
            onRemove={canEdit && !(l.kind === "project" && l.targetId === goal.projectId) ? () => onUnlink(l) : undefined} />
        );
      })}
      {!shown.length && !progressFrom && <span className="kgl-quiet">None yet.</span>}
      {canEdit && (
        <select className="kpj-field kgl-select kgl-link-pick" data-size="sm" value="" aria-label={`Link work to ${goal.name}`}
          onChange={(e) => { const [kind, id] = e.target.value.split(":"); if (id) onLink(kind as "project" | "task", e.target.value.slice(kind.length + 1)); }}>
          <option value="">Link work…</option>
          <optgroup label="Projects">
            {projects.filter((p) => !p.archivedAt && !has("project", p.id) && p.id !== goal.projectId).map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}
          </optgroup>
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

function LinkChip({ icon, emoji, label, onRemove }: { icon: "folder" | "check" | "layers"; emoji?: string; label: string; onRemove?: () => void }) {
  return (
    <span className="kgl-chip">
      {emoji ? <span aria-hidden="true">{emoji}</span> : <Icon name={icon} size={12} sw={1.75} />}
      <span className="kgl-chip-name">{label}</span>
      {onRemove && <button type="button" className="kgl-chip-x" aria-label={`Unlink ${label}`} onClick={onRemove}><Icon name="x" size={12} sw={2} /></button>}
    </span>
  );
}

/* ---------------- the rest of its settings ---------------- */

/** Kind, which way is better, the start value, the pace, its weight, who helps and who can
 *  see it. Each part only for whoever may change it. */
export function GoalDetails({ goal, members, canEdit, canHandOver, onUpdate }: {
  goal: Goal;
  members: WorkspaceMember[];
  canEdit: boolean;
  canHandOver: boolean;
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
            {canEdit ? (
              <Segmented ariaLabel={`Which way is better for ${goal.name}`} value={goal.direction ?? "higher"}
                options={[{ value: "higher", label: "Higher" }, { value: "lower", label: "Lower" }]}
                onChange={(d) => onUpdate(d === "lower" && goal.startValue == null ? { direction: d, startValue: goal.current ?? null } : { direction: d })} />
            ) : <b>{goal.direction === "lower" ? "Lower" : "Higher"}</b>}
          </div>
          <label className="kgl-field">
            <span>Started at</span>
            <input type="number" inputMode="decimal" className="kpj-field kpj-mono kgl-num" data-size="sm" disabled={!canEdit}
              defaultValue={goal.startValue ?? ""} key={`start-${goal.startValue ?? ""}`} placeholder={goal.direction === "lower" ? "Where it was" : "0"}
              onBlur={(e) => { const v = numOrNull(e.target.value); if (v !== (goal.startValue ?? null)) onUpdate({ startValue: v }); }} />
          </label>
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
            description="Only owners, admins, the goal's owner and the people helping can see it, its check-ins and its links."
            onChange={(on) => onUpdate({ visibility: on ? "leadership" : "everyone" })} />
        </div>
      )}
    </div>
  );
}
