/* ============================================================
   KANBO — Team › People › Workspace health (0058), for a team's
   owners and admins. How the rollout is taking, one line each, with
   one fix each:
     · invited but not joined ...................... Resend all
     · active in the last 7 days, by day (a seven-day strip; who's
       been quiet, roughly: "over a week ago", never a time) ...... —
     · open tasks with no owner or date ............ Sort them out
       (a sheet: give each an owner and a date, or every unowned one
       to its project's owner in one go)
     · projects missing an update .................. Ask for updates
     · goals with no check-in for two weeks ........ Open goals
   and the rollout plan: a champion, a pilot group, a go-live date
   (workspaces.rollout; "not switched on yet" before 0058).
   lib/rollout works the numbers out; the host does the fixes.
   ============================================================ */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Avatar, Button, Icon, ProjectTile, Sheet } from "../primitives";
import type { IconName, Project, RolloutPlan, Task, WorkspaceMember } from "../../data/types";
import { lastActiveWords, namesLine, type WorkspaceHealth } from "../../lib/rollout";

export type ActivityState = "loading" | "ok" | "off" | "failed";

export interface WorkspaceHealthProps {
  workspaceName: string;
  health: WorkspaceHealth;
  /** workspace_activity: loading, answered, not switched on yet (before 0058), or couldn't load */
  activity: ActivityState;
  /** the workspace's active members (the rollout's pickers) */
  members: WorkspaceMember[];
  nameOf: (m: WorkspaceMember) => string;
  projects: Project[];
  /** the rollout plan (null: none yet) and whether it can be saved here (0058) */
  rollout: RolloutPlan | null;
  rolloutOn: boolean;
  onSaveRollout: (plan: RolloutPlan | null) => void;
  /** re-send every pending invite's email (the invite-member function): how it went */
  onResendAll: () => Promise<{ sent: number; failed: number }>;
  /** ask each missing project's owner for its update: how many were asked */
  onAskUpdates: () => Promise<{ asked: number; note?: string }>;
  onOpenGoals: () => void;
  onPatchTask: (taskId: string, patch: Partial<Task>) => void;
  /** every unowned task to its project's owner (with Undo, the host's): how many moved */
  onGiveToOwners: (taskIds: string[]) => number;
  /** opened from Kanbo noticed: scroll here, and open this fix's sheet */
  focus?: { fix: string; at: number } | null;
}

const WEEKDAY = ["S", "M", "T", "W", "T", "F", "S"];
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;
const dayOf = (iso: string) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };

export function WorkspaceHealthCard(props: WorkspaceHealthProps) {
  const { health: h, activity, workspaceName } = props;
  const headId = "khealth" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const cardRef = useRef<HTMLElement>(null);
  const [tidyOpen, setTidyOpen] = useState(false);
  const [busy, setBusy] = useState<null | "resend" | "ask">(null);
  const [note, setNote] = useState<{ row: string; text: string } | null>(null);

  // opened from a nudge: bring the card into view, and its sheet when the fix has one
  useEffect(() => {
    if (!props.focus) return;
    cardRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    if (props.focus.fix === "assign") setTidyOpen(true);
  }, [props.focus]);

  const resend = async () => {
    setBusy("resend"); setNote(null);
    try {
      const r = await props.onResendAll();
      setNote({ row: "invited", text: r.failed ? `Sent ${r.sent} of ${r.sent + r.failed}. Try the rest again in a minute.` : `Sent ${plural(r.sent, "fresh invite")}.` });
    } finally { setBusy(null); }
  };
  const ask = async () => {
    setBusy("ask"); setNote(null);
    try {
      const r = await props.onAskUpdates();
      setNote({ row: "updates", text: r.note ?? (r.asked ? `Asked ${plural(r.asked, "owner")}. They'll find Kanbo's draft waiting.` : "Nobody else to ask: these are yours to post.") });
    } finally { setBusy(null); }
  };

  const joinedOk = h.invited.length === 0;
  const looseOk = h.loose.tasks.length === 0;
  const updatesOk = h.missing.length === 0;
  const goalsOk = !h.quietGoals?.length;
  const count = h.issues;

  return (
    <section ref={cardRef} className="khealth" aria-labelledby={headId}>
      <style>{HEALTH_CSS}</style>
      <header className="khealth-head">
        <div className="khealth-heading">
          <h2 id={headId} className="khealth-title">Workspace health</h2>
          <p className="khealth-sub">How {workspaceName} is taking to Kanbo. Only owners and admins see this.</p>
        </div>
        <span className="khealth-count" data-ok={count === 0 || undefined}>{count === 0 ? "All good" : `${plural(count, "thing")} to look at`}</span>
      </header>

      <ul className="khealth-rows">
        <Row id="invited" icon="send" ok={joinedOk}
          title={joinedOk ? "Everyone you invited has joined" : `${plural(h.invited.length, "person", "people")} invited but not joined`}
          detail={joinedOk ? undefined : `${namesLine(h.invited.map((m) => props.nameOf(m)))} ${h.invited.length === 1 ? "hasn't" : "haven't"} signed in yet.`}
          note={note?.row === "invited" ? note.text : undefined}
          fix={joinedOk ? null : <Button size="sm" variant="secondary" icon="refresh" loading={busy === "resend"} onClick={() => void resend()}>{h.invited.length === 1 ? "Resend invite" : "Resend all"}</Button>} />

        <li className="khealth-row" data-row="active">
          <span className="khealth-icon" aria-hidden="true"><Icon name="pulse" size={16} sw={1.75} /></span>
          <span className="khealth-text">
            {h.active ? (
              <>
                <span className="khealth-line">{h.active.count} of {plural(h.active.of, "person", "people")} active in the last 7 days</span>
                <span className="khealth-detail">
                  {h.active.quiet.length
                    ? `Quiet this week: ${namesLine(h.active.quiet.map((q) => `${props.nameOf(q.member).split(/\s+/)[0]} (${lastActiveWords(q.lastDay, h.active!.today).toLowerCase()})`), 4)}.`
                    : "Everyone's been in this week."}
                  {" "}Days only, never times.
                </span>
              </>
            ) : (
              <>
                <span className="khealth-line">Active in the last 7 days</span>
                <span className="khealth-detail">{activity === "loading" ? "Working it out…" : activity === "off" ? "Not switched on yet." : "Couldn't load who's been active. Try again later."}</span>
              </>
            )}
          </span>
          {h.active && <DayStrip days={h.active.days} of={h.active.of} />}
        </li>

        <Row id="loose" icon="user" ok={looseOk}
          title={looseOk ? "Every open task has an owner and a date" : `${plural(h.loose.tasks.length, "open task")} with no owner or date`}
          detail={looseOk ? undefined : [h.loose.noOwner ? `${h.loose.noOwner} with no owner` : "", h.loose.noDate ? `${h.loose.noDate} with no date` : ""].filter(Boolean).join(" · ")}
          fix={looseOk ? null : <Button size="sm" variant="secondary" onClick={() => setTidyOpen(true)}>Sort them out</Button>} />

        <Row id="updates" icon="message" ok={updatesOk}
          title={updatesOk ? "No project updates missing" : `${plural(h.missing.length, "project")} missing an update`}
          detail={updatesOk ? undefined : namesLine(h.missing.map((p) => p.name))}
          note={note?.row === "updates" ? note.text : undefined}
          fix={updatesOk ? null : <Button size="sm" variant="secondary" loading={busy === "ask"} onClick={() => void ask()}>{h.missing.length === 1 ? "Ask for it" : "Ask for updates"}</Button>} />

        {h.quietGoals && (
          <Row id="goals" icon="target" ok={goalsOk}
            title={goalsOk ? "Every goal has a recent check-in" : `${plural(h.quietGoals.length, "goal")} with no check-in for two weeks`}
            detail={goalsOk ? undefined : namesLine(h.quietGoals.map((g) => g.name))}
            fix={goalsOk ? null : <Button size="sm" variant="secondary" onClick={props.onOpenGoals}>Open goals</Button>} />
        )}
      </ul>

      <RolloutPlanPart {...props} />

      <TidySheet open={tidyOpen} onClose={() => setTidyOpen(false)} tasks={h.loose.tasks} members={props.members} nameOf={props.nameOf}
        projects={props.projects} onPatchTask={props.onPatchTask} onGiveToOwners={props.onGiveToOwners} />
    </section>
  );
}

function Row({ id, icon, ok, title, detail, note, fix }: { id: string; icon: IconName; ok: boolean; title: string; detail?: string; note?: string; fix: React.ReactNode }) {
  return (
    <li className="khealth-row" data-row={id} data-ok={ok || undefined}>
      <span className="khealth-icon" aria-hidden="true"><Icon name={ok ? "check" : icon} size={16} sw={ok ? 2.25 : 1.75} /></span>
      <span className="khealth-text">
        <span className="khealth-line">{title}</span>
        {detail && <span className="khealth-detail">{detail}</span>}
        {note && <span className="khealth-note" role="status">{note}</span>}
      </span>
      {fix}
    </li>
  );
}

/** The last seven days: how many people were active each day (a bar each, today last). */
function DayStrip({ days, of }: { days: { day: string; people: number }[]; of: number }) {
  const max = Math.max(1, of);
  const words = days.map((d) => `${dayOf(d.day).toLocaleDateString("en-GB", { weekday: "short" })} ${d.people}`).join(", ");
  return (
    <span className="khealth-strip" role="img" aria-label={`People active each day: ${words}`}>
      {days.map((d) => (
        <span key={d.day} className="khealth-bar">
          <span className="khealth-bar-fill" style={{ height: `${Math.max(d.people ? 14 : 0, Math.round((d.people / max) * 100))}%` }} />
          <span className="khealth-bar-day" aria-hidden="true">{WEEKDAY[dayOf(d.day).getDay()]}</span>
        </span>
      ))}
    </span>
  );
}

/* ---------- the rollout plan: champion, pilot group, go-live ---------- */

function RolloutPlanPart({ rollout, rolloutOn, members, nameOf, onSaveRollout }: WorkspaceHealthProps) {
  const plan = rollout ?? {};
  const can = members.filter((m) => m.role !== "guest" && m.userId);
  const byId = useMemo(() => new Map(can.map((m) => [m.userId!, m])), [can]);
  const [pilotOpen, setPilotOpen] = useState(false);
  const pilot = (plan.pilot ?? []).filter((id) => byId.has(id));
  const champion = plan.champion ? byId.get(plan.champion) : undefined;
  const save = (next: RolloutPlan) => {
    const clean: RolloutPlan = {};
    if (next.champion) clean.champion = next.champion;
    if (next.pilot?.length) clean.pilot = next.pilot;
    if (next.goLive) clean.goLive = next.goLive;
    onSaveRollout(Object.keys(clean).length ? clean : null);
  };
  const done = [!!champion, pilot.length > 0, !!plan.goLive].filter(Boolean).length;
  const goLiveWords = plan.goLive ? dayOf(plan.goLive).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }) : "";
  return (
    <div className="khealth-plan">
      <div className="khealth-plan-head">
        <h3 className="khealth-plan-title">Rollout</h3>
        <span className="khealth-plan-sub">{rolloutOn ? `${done} of 3 decided` : "Not switched on yet."}</span>
      </div>
      <ul className="khealth-rows" data-plan="">
        <li className="khealth-row" data-ok={!!champion || undefined}>
          <span className="khealth-icon" aria-hidden="true"><Icon name={champion ? "check" : "user"} size={16} sw={champion ? 2.25 : 1.75} /></span>
          <span className="khealth-text">
            <span className="khealth-line">{champion ? `${nameOf(champion)} is your champion` : "Pick a champion"}</span>
            <span className="khealth-detail">The person teammates ask first, who keeps the rollout moving.</span>
          </span>
          <select className="khealth-select" aria-label="Champion" disabled={!rolloutOn} value={champion?.userId ?? ""}
            onChange={(e) => save({ ...plan, champion: e.target.value || null })}>
            <option value="">No one yet</option>
            {can.map((m) => <option key={m.userId!} value={m.userId!}>{nameOf(m)}</option>)}
          </select>
        </li>
        <li className="khealth-row" data-ok={pilot.length > 0 || undefined}>
          <span className="khealth-icon" aria-hidden="true"><Icon name={pilot.length ? "check" : "users"} size={16} sw={pilot.length ? 2.25 : 1.75} /></span>
          <span className="khealth-text">
            <span className="khealth-line">{pilot.length ? `Pilot group: ${namesLine(pilot.map((id) => nameOf(byId.get(id)!).split(/\s+/)[0]), 4)}` : "Choose your pilot group"}</span>
            <span className="khealth-detail">Three to five people who use it first and tell you what to change.</span>
            {pilotOpen && rolloutOn && (
              <span className="khealth-chips" role="group" aria-label="Pilot group">
                {can.map((m) => {
                  const on = pilot.includes(m.userId!);
                  return (
                    <button key={m.userId!} type="button" className="khealth-chip" aria-pressed={on}
                      onClick={() => save({ ...plan, pilot: on ? pilot.filter((x) => x !== m.userId) : [...pilot, m.userId!] })}>
                      <Avatar id={m.userId!} size={20} />{nameOf(m)}
                    </button>
                  );
                })}
              </span>
            )}
          </span>
          <Button size="sm" variant="secondary" disabled={!rolloutOn} aria-expanded={pilotOpen} onClick={() => setPilotOpen((v) => !v)}>{pilotOpen ? "Done" : pilot.length ? "Change" : "Choose"}</Button>
        </li>
        <li className="khealth-row" data-ok={!!plan.goLive || undefined}>
          <span className="khealth-icon" aria-hidden="true"><Icon name={plan.goLive ? "check" : "flag"} size={16} sw={plan.goLive ? 2.25 : 1.75} /></span>
          <span className="khealth-text">
            <span className="khealth-line">{plan.goLive ? `Going live on ${goLiveWords}` : "Set a go-live date"}</span>
            <span className="khealth-detail">The day everyone moves their work into Kanbo, and the old lists stop.</span>
          </span>
          <input type="date" className="khealth-select" aria-label="Go-live date" disabled={!rolloutOn} value={plan.goLive ?? ""}
            onChange={(e) => save({ ...plan, goLive: e.target.value || null })} />
        </li>
      </ul>
    </div>
  );
}

/* ---------- Sort them out: open tasks with no owner or date ---------- */

function TidySheet({ open, onClose, tasks, members, nameOf, projects, onPatchTask, onGiveToOwners }: {
  open: boolean; onClose: () => void; tasks: Task[]; members: WorkspaceMember[]; nameOf: (m: WorkspaceMember) => string; projects: Project[];
  onPatchTask: WorkspaceHealthProps["onPatchTask"]; onGiveToOwners: WorkspaceHealthProps["onGiveToOwners"];
}) {
  const people = members.filter((m) => m.role !== "guest" && m.userId);
  const projectOf = (t: Task) => projects.find((p) => p.id === t.projectId);
  const toOwners = tasks.filter((t) => !t.assigneeId && projectOf(t)?.ownerId && people.some((m) => m.userId === projectOf(t)!.ownerId));
  const [said, setSaid] = useState("");
  // (a task leaves the list once it has both; the sheet keeps the ones you've just fixed one of)
  const shown = tasks.slice(0, 40);
  return (
    <Sheet open={open} onClose={onClose} label="Tasks with no owner or date" title="Tasks with no owner or date" width={640}
      footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <div className="khealth-tidy">
        <p className="khealth-tidy-lede">Work nobody owns tends to wait, and undated work never reaches anyone's day. Give each one an owner and a rough date.</p>
        {toOwners.length > 0 && (
          <div className="khealth-tidy-bulk">
            <span>{plural(toOwners.length, "task")} with no owner {toOwners.length === 1 ? "has a project with an owner" : "have projects with owners"}.</span>
            <Button size="sm" variant="secondary" icon="users" onClick={() => { const n = onGiveToOwners(toOwners.map((t) => t.id)); setSaid(`Gave ${plural(n, "task")} to their project owners.`); }}>Give to project owners</Button>
          </div>
        )}
        <p className="sr-only" role="status">{said}</p>
        {shown.length === 0 ? <p className="khealth-detail">Nothing left to sort out.</p> : (
          <ul className="khealth-tidy-list">
            {shown.map((t) => {
              const p = projectOf(t);
              return (
                <li key={t.id} className="khealth-tidy-row">
                  {p ? <ProjectTile project={p} size={20} /> : <span className="khealth-tidy-dot" aria-hidden="true" />}
                  <span className="khealth-tidy-title">{t.title}</span>
                  <select className="khealth-select" aria-label={`Owner for ${t.title}`} value={t.assigneeId ?? ""} onChange={(e) => onPatchTask(t.id, { assigneeId: e.target.value })}>
                    <option value="">No owner</option>
                    {people.map((m) => <option key={m.userId!} value={m.userId!}>{nameOf(m)}</option>)}
                  </select>
                  <input type="date" className="khealth-select" aria-label={`Due date for ${t.title}`} value={t.dueDate ?? ""}
                    onChange={(e) => onPatchTask(t.id, { dueDate: e.target.value || undefined })} />
                </li>
              );
            })}
          </ul>
        )}
        {tasks.length > shown.length && <p className="khealth-detail">And {tasks.length - shown.length} more once these are done.</p>}
      </div>
    </Sheet>
  );
}

const HEALTH_CSS = `
.khealth {
  container-type: inline-size; margin: 24px 0 8px; padding: 16px 16px 10px 20px;
  border-radius: var(--r-lg, 12px); background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline));
}
.khealth-head { display: flex; align-items: flex-start; gap: 12px; }
.khealth-heading { flex: 1; min-width: 0; }
.khealth-title { margin: 0; font: 600 17px/24px var(--font-head); letter-spacing: -0.01em; color: var(--ink); }
.khealth-sub { margin: 2px 0 0; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.khealth-count {
  flex-shrink: 0; padding: 2px 10px; border-radius: 999px; font: 600 12px/20px var(--font-ui, var(--font-display));
  background: color-mix(in oklch, var(--warn, var(--st-review)) 12%, transparent); color: var(--warn-text, var(--ink-2));
}
.khealth-count[data-ok] { background: color-mix(in oklch, var(--ok, var(--st-done)) 12%, transparent); }
.khealth-rows { margin: 10px 0 0; padding: 0; list-style: none; }
.khealth-row { display: flex; align-items: center; gap: 12px; min-height: 56px; padding: 8px 0; box-shadow: inset 0 1px 0 var(--hairline); }
.khealth-icon {
  display: grid; place-items: center; width: 32px; height: 32px; flex-shrink: 0; border-radius: var(--r-md, 8px);
  background: var(--fill-1); color: var(--ink-2); box-shadow: inset 0 0 0 1px var(--hairline);
}
.khealth-row[data-ok] .khealth-icon { color: var(--ok, var(--st-done)); background: color-mix(in oklch, var(--ok, var(--st-done)) 10%, transparent); box-shadow: none; }
.khealth-text { display: grid; flex: 1; min-width: 0; }
.khealth-line { font: 600 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); text-wrap: pretty; }
.khealth-row[data-ok] .khealth-line { font-weight: 500; color: var(--ink-2); }
.khealth-detail { font: 400 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.khealth-note { margin-top: 2px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ok-text, var(--ok, var(--st-done))); }
.khealth-row > .kbtn, .khealth-row > .khealth-select { flex-shrink: 0; }
.khealth-strip { display: inline-flex; align-items: flex-end; gap: 4px; height: 40px; flex-shrink: 0; }
.khealth-bar { display: grid; grid-template-rows: 1fr auto; justify-items: center; gap: 2px; width: 12px; height: 100%; }
.khealth-bar-fill { align-self: end; width: 8px; min-height: 2px; border-radius: 3px; background: var(--accent-fill, var(--accent)); opacity: 0.85; }
.khealth-bar-day { font: 600 9px/10px var(--font-ui, var(--font-display)); color: var(--ink-4); }
.khealth-plan { margin-top: 6px; padding-top: 10px; box-shadow: inset 0 1px 0 var(--hairline-strong, var(--hairline)); }
.khealth-plan-head { display: flex; align-items: baseline; gap: 10px; }
.khealth-plan-title { margin: 0; font: 600 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); }
.khealth-plan-sub { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.khealth-rows[data-plan] { margin-top: 4px; }
.khealth-select {
  height: 32px; max-width: 200px; padding: 0 10px; border-radius: var(--r-md, 8px); border: 1px solid var(--field-border, var(--hairline-strong));
  background: var(--field-bg, var(--surface)); color: var(--ink); font: 500 13px/20px var(--font-ui, var(--font-display));
}
.khealth-select:disabled { opacity: 0.55; }
.khealth-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.khealth-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 4px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--hairline-strong, var(--hairline)); background: var(--surface); color: var(--ink-2); font: 500 12px/16px var(--font-ui, var(--font-display));
}
.khealth-chip[aria-pressed="true"] { border-color: var(--accent-fill, var(--accent)); background: color-mix(in oklch, var(--accent-fill, var(--accent)) 12%, transparent); color: var(--ink); }
.khealth-tidy { display: grid; gap: 12px; }
.khealth-tidy-lede { margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.khealth-tidy-bulk { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 10px 12px; border-radius: var(--r-md, 8px); background: var(--fill-1); font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-2); }
.khealth-tidy-bulk > span { flex: 1; min-width: 200px; }
.khealth-tidy-list { margin: 0; padding: 0; list-style: none; }
.khealth-tidy-row { display: flex; align-items: center; gap: 10px; min-height: 48px; box-shadow: inset 0 1px 0 var(--hairline); }
.khealth-tidy-title { flex: 1; min-width: 0; font: 500 14px/20px var(--font-ui, var(--font-display)); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.khealth-tidy-dot { width: 20px; height: 20px; flex-shrink: 0; border-radius: 6px; background: var(--fill-2, var(--fill-1)); }
.khealth-tidy-row .khealth-select { width: 150px; }
/* narrow: each line's fix goes under its words, so the words keep the width */
@container (max-width: 520px) {
  .khealth-row { flex-wrap: wrap; row-gap: 8px; }
  .khealth-text { flex: 1 1 calc(100% - 44px); }
  .khealth-row > .kbtn, .khealth-row > .khealth-select, .khealth-strip { margin-left: 44px; }
  .khealth-row > .khealth-select { flex: 1; max-width: none; }
}
@media (max-width: 859px) {
  .khealth { padding: 14px 12px 8px 14px; }
  .khealth-tidy-row { flex-wrap: wrap; padding: 6px 0; }
  .khealth-tidy-title { flex-basis: calc(100% - 40px); white-space: normal; }
  .khealth-tidy-row .khealth-select { flex: 1; width: auto; max-width: none; height: 40px; margin-left: 30px; }
  .khealth-tidy-row .khealth-select + .khealth-select { margin-left: 0; }
  .khealth-select { height: 40px; font-size: 16px; }
}
`;
