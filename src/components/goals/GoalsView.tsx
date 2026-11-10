/* ============================================================
   KANBO — Goals, in Quiet Precision. One sentence first ("4 of 6
   goals on pace; Launch Q3 is behind"), a quarter switcher, then the
   goals in three groups: Company (the business's top-level goals),
   Team (key results the team owns) and Mine (the ones you own or help
   on). Each goal is a compact row: its icon and colour, its owner, a
   pace bar (where it is, with a tick where it should be by now), how
   long since its last check-in, and a health dot for each project
   behind it, or "No work behind this". A row opens the goal panel
   (GoalPanel: editing, check-ins, linked work and Delete live there).
   On a phone each row becomes a little card to read, with a one-tap
   Check in. Guests read a calm list, or "Goals are for members".
   Before 0052 is run the rows read the same, from the goals as they
   were (no owners, quarters or check-ins).
   ============================================================ */
import { useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Avatar, Button, DateChip, EmptyState, Icon, Meter, Pill, ProjectTile, Segmented } from "../primitives";
import { KANBO_TODAY, toLocalISO, WORKSPACES } from "../../data/data";
import { accessOn } from "../../lib/projectAccess";
import type { Goal, GoalCheckin, GoalExtras, GoalLink, GoalLinkKind, GoalPatch, Project, Role, StatusUpdate, Task, WorkspaceMember } from "../../data/types";
import { goalTree, useStableOrder, type GoalProgress } from "../views/reportingUtils";
import { periodRange, quarterOf } from "../../lib/goalPeriods";
import { paceDisagrees } from "../../lib/goalPace";
import { canEditGoal, canMakeCompanyGoal, canSeeGoal, COMPANY_GOALS_RULE, goalLookup } from "../../lib/goalRules";
import {
  checkinAge, checkinsOf, goalCarriedOver, goalGroup, goalProjectIds, goalsInQuarter, goalsSummary, GROUP_LABEL, hasWorkBehind, hiddenProjectOf, paceWords, periodShort, projectDot, quarterOptions, readGoals, takesCheckins,
  type GoalGroup, type GoalRead,
} from "../../lib/goalFlow";
import { GOAL_STATUS_LABEL, GOAL_TONE, GoalAdder, GoalSource, KIND_LABEL, daysAgo, goalTile, linkedOf, numbersLine, personName } from "./GoalParts";
import { GoalPanel } from "./GoalPanel";
import "../project/projects.css";
import "./goals.css";

export interface GoalsViewProps {
  goals: Goal[];
  projects: Project[];
  /** the workspace's tasks, archived projects' included: a goal linked to a finished,
   *  archived project keeps reading that project's progress instead of dropping to 0% */
  tasks: Task[];
  onCreate: (name: string, extra?: GoalPatch) => void;
  onUpdate: (id: string, patch: GoalPatch) => void;
  onDelete: (id: string) => void;
  /** a guest: the goals to read, no controls (writes would only be refused) */
  readOnly?: boolean;
  /* ---- 0052: owners, quarters, check-ins and links (absent or null: not switched on) ---- */
  extras?: GoalExtras | null;
  /** the workspace these goals are in (null: Personal) */
  workspaceId?: string | null;
  /** who's looking, and their role in this workspace (null in Personal) */
  me?: string;
  role?: Role | null;
  /** the workspace's members: who can own a goal or help on one */
  members?: WorkspaceMember[];
  onCheckin?: (goal: Goal, value: number, confidence: number | null, note: string) => void;
  onDeleteCheckin?: (checkinId: string, goal: Goal) => void;
  onLink?: (goal: Goal, kind: GoalLinkKind, targetId: string) => void;
  onUnlink?: (link: GoalLink) => void;
  today?: Date;
  /* ---- the goal panel ---- */
  /** the projects' latest updates (a linked project's health dot) */
  statusUpdates?: StatusUpdate[];
  /** open a goal in the host's docked panel (`checkin`: with the composer out). Without it the
   *  page opens its own. */
  onOpenGoal?: (id: string, opts?: { checkin?: boolean }) => void;
  /** the goal the host's panel shows */
  openGoalId?: string | null;
  /** the quarter it opens on ("2027-Q1": a business pack's summary opens it on the pack's goals) */
  quarter?: string;
}

/** A goal named in the summary sentence keeps it one sentence: a long name is cut (in full on hover). */
const SUM_NAME = 40;
const clip = (name: string) => (name.length > SUM_NAME ? `${name.slice(0, SUM_NAME - 1).trimEnd()}…` : name);

export function GoalsView(props: GoalsViewProps) {
  const { goals, projects, tasks, onCreate, readOnly = false, extras, me = "", role = null, statusUpdates = [], today = KANBO_TODAY } = props;
  const v2 = !!extras;
  const who = { me, role };
  const [adding, setAdding] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  // (a business whose goals are all for next quarter, as a business pack set up late in this one makes them, opens on next quarter)
  const [quarter, setQuarter] = useState(() => {
    const here = quarterOf(today), next = quarterOptions(today)[2].value;
    if (props.quarter && quarterOptions(today).some((q) => q.value === props.quarter)) return props.quarter;
    const live = goals.filter((g) => !g.archivedAt);
    return live.some((g) => g.period === next) && !live.some((g) => (g.period ?? here) === here) ? next : here;
  });
  // without a host panel, the page opens its own
  const [ownOpen, setOwnOpen] = useState<{ id: string; checkin: boolean } | null>(null);
  const realProjects = projects.filter((p) => p.id !== "p-personal");
  // a leadership-only goal you can't see never reaches you live; in the demo it's held back here
  const visible = useMemo(() => {
    if (!v2) return goals;
    const byId = goalLookup(goals);
    return goals.filter((g) => canSeeGoal(g, { me, role }, byId));
  }, [v2, goals, me, role]);
  const stable = useStableOrder(visible);
  // (0058: a goal reading its % from a project you can't see has none you can know)
  const hidden = useMemo(() => hiddenProjectOf(projects, WORKSPACES), [projects]);
  const reads = useMemo(() => readGoals(visible, tasks, today, hidden), [visible, tasks, today, hidden]);
  const links = extras?.links ?? [];
  const checkins = extras?.checkins ?? [];
  const wsId = props.workspaceId !== undefined ? props.workspaceId : (goals[0]?.workspaceId ?? null);
  const personal = wsId === null;
  const canNew = !v2 || canMakeCompanyGoal(wsId, role);
  const explainer = "Goals track a number you want to hit. Link one to a project and its progress fills in automatically.";
  const quarters = useMemo(() => quarterOptions(today), [today]);
  const range = quarters.find((q) => q.value === quarter)?.range ?? null;
  // (the quarter you're in also carries over open goals whose time ran out before it)
  const inQuarter = goalsInQuarter(stable, reads, range, today);
  const archivedCount = inQuarter.filter((g) => g.archivedAt).length;
  const listed = showArchived ? inQuarter : inQuarter.filter((g) => !g.archivedAt);
  const summary = goalsSummary(listed.filter((g) => !g.archivedAt).map((g) => reads.get(g.id)!).filter(Boolean));
  const openGoal = (id: string, opts?: { checkin?: boolean }) => {
    if (!props.onOpenGoal) setOwnOpen({ id, checkin: !!opts?.checkin });
    else if (opts) props.onOpenGoal(id, opts);
    else props.onOpenGoal(id);
  };
  const openId = props.onOpenGoal ? props.openGoalId ?? null : ownOpen?.id ?? null;

  if (readOnly) return <GoalsReadOnly ordered={goalTree(stable)} reads={reads} projects={realProjects} todayIso={toLocalISO(today)} gated={accessOn(WORKSPACES.find((w) => w.id === wsId))} />;

  // a new goal goes in the quarter on show (with every goal showing, the one you're in)
  const newQuarter = quarter === "all" ? quarterOf(today) : quarter;
  const newQuarterName = quarters.find((q) => q.value === newQuarter)?.label ?? "";
  const qr = periodRange(newQuarter)!;
  const create = (name: string) => {
    if (!v2) { onCreate(name); return; }
    onCreate(name, { kind: "objective", ...(personal ? {} : { ownerId: me }), period: newQuarter, periodStart: qr.start, periodEnd: qr.end });
  };
  const newLabel = v2 && newQuarter !== quarterOf(today) ? `New goal for ${newQuarterName}` : "New goal";

  // the groups, each in the goals' own order (a key result straight after its goal's)
  const ordered = goalTree(listed).map((o) => o.g);
  const groups: { key: GoalGroup; rows: Goal[] }[] = (["company", "team", "mine"] as GoalGroup[])
    .map((key) => ({ key, rows: ordered.filter((g) => goalGroup(g, visible, me) === key) }))
    .filter((x) => x.rows.length > 0);
  const quarterName = quarters.find((q) => q.value === quarter)?.label ?? "";
  // ↑ ↓ (and J K) move between the rows, Enter opens one
  const onListKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("kgp-open")) return;
    const down = e.key === "ArrowDown" || e.key === "j", up = e.key === "ArrowUp" || e.key === "k";
    if (!down && !up) return;
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(".kgp-open")];
    const i = all.indexOf(t as HTMLButtonElement);
    const next = all[down ? Math.min(all.length - 1, i + 1) : Math.max(0, i - 1)];
    if (next) { e.preventDefault(); next.focus(); }
  };
  const ownGoal = ownOpen ? visible.find((g) => g.id === ownOpen.id) : undefined;

  return (
    <div className="kpj-page">
      <div className="kpj-wrap" style={{ maxWidth: 960 }}>
        {visible.length === 0 && !adding ? (
          <EmptyState art="target" title="No goals yet" body={canNew ? explainer : `${explainer} ${COMPANY_GOALS_RULE}`}
            action={canNew ? <Button variant="primary" icon="plus" onClick={() => setAdding(true)}>New goal</Button> : undefined} />
        ) : (
          <>
            {groups.length > 0 && (
              <p className="kgp-summary" aria-live="polite" data-tour="goals">
                {summary.parts.map((p, i) => typeof p === "string" ? <span key={i}>{p}</span>
                  : <button key={i} type="button" className="kgp-sum-goal" title={p.text.length > SUM_NAME ? p.text : undefined} onClick={() => openGoal(p.goalId)}>{clip(p.text)}</button>)}
              </p>
            )}
            <div className="kgp-bar">
              <Segmented ariaLabel="Quarter" value={quarter} onChange={setQuarter} options={quarters.map((q) => ({ value: q.value, label: q.label }))} />
              <span className="kpj-spacer" />
              {archivedCount > 0 && (
                <Button variant="ghost" size="sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                  {showArchived ? "Hide archived" : `Show archived (${archivedCount})`}
                </Button>
              )}
              {canNew && <Button variant="primary" size="sm" icon="plus" onClick={() => setAdding(true)}>{newLabel}</Button>}
            </div>
            {adding && (
              <GoalAdder label={v2 ? `New goal for ${newQuarterName}` : "New goal name"} placeholder={v2 ? `Goal for ${newQuarterName}, e.g. Reach 1,000 active users` : "Goal name, e.g. Reach 1,000 active users"}
                onAdd={(n) => { create(n); setAdding(false); }} onCancel={() => setAdding(false)} />
            )}
            {groups.length === 0 ? (
              <p className="kgp-empty-q">
                {quarter === "all" ? "Nothing planned yet." : `Nothing planned for ${quarterName} yet.`}{" "}
                {quarter !== "all" && <Button size="sm" variant="ghost" onClick={() => setQuarter("all")}>Show every goal</Button>}
              </p>
            ) : (
              <div className="kgp-groups" onKeyDown={onListKey}>
                {groups.map(({ key, rows }) => (
                  <section key={key} className="kgp-group" aria-label={personal ? "Your goals" : `${GROUP_LABEL[key]} goals`}>
                    {!personal && <h2 className="kgp-group-head">{GROUP_LABEL[key]}<span className="kgp-group-n">{rows.length}</span></h2>}
                    <ul className="kgp-list">
                      {rows.map((g) => (
                        <GoalRow key={g.id} r={reads.get(g.id)!} all={visible} links={links} checkins={checkins} projects={realProjects} tasks={tasks}
                          statusUpdates={statusUpdates} members={props.members ?? []} today={today} personal={personal} v2={v2} open={openId === g.id}
                          carried={!!range && goalCarriedOver(reads.get(g.id)!, range)}
                          canCheckin={v2 && !g.archivedAt && takesCheckins(reads.get(g.id)) && canEditGoal(g, who) && !!props.onCheckin}
                          onOpen={() => openGoal(g.id)} onCheckin={() => openGoal(g.id, { checkin: true })} />
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
            <p className="kgp-note" style={{ marginTop: 20 }}>{explainer} {v2 && !personal ? COMPANY_GOALS_RULE : "Put key results under a goal to roll them up."}</p>
          </>
        )}
      </div>
      {!props.onOpenGoal && ownGoal && (
        <GoalPanel goal={ownGoal} goals={visible} projects={projects} tasks={tasks} extras={extras ?? null} me={me} role={role} members={props.members ?? []}
          statusUpdates={statusUpdates} today={today} composeFirst={ownOpen?.checkin} onClose={() => setOwnOpen(null)} onOpenGoal={(id) => setOwnOpen({ id, checkin: false })}
          onCreate={onCreate} onUpdate={props.onUpdate} onDelete={props.onDelete} onCheckin={props.onCheckin} onDeleteCheckin={props.onDeleteCheckin} onLink={props.onLink} onUnlink={props.onUnlink} />
      )}
    </div>
  );
}

/** One goal: its identity, owner, pace bar, last check-in and the health of the work behind it. */
function GoalRow({ r, all, links, checkins, projects, tasks, statusUpdates, members, today, personal, v2, open, carried, canCheckin, onOpen, onCheckin }: {
  r: GoalRead; all: Goal[]; links: GoalLink[]; checkins: GoalCheckin[]; projects: Project[]; tasks: Task[]; statusUpdates: StatusUpdate[];
  members: WorkspaceMember[]; today: Date; personal: boolean; v2: boolean; open: boolean;
  /** open from an earlier quarter, shown in this one */
  carried: boolean;
  canCheckin: boolean;
  onOpen: () => void; onCheckin: () => void;
}) {
  const g = r.goal;
  const parent = g.parentId ? all.find((x) => x.id === g.parentId) : undefined;
  const kids = all.filter((c) => c.parentId === g.id && c.id !== g.id && !c.archivedAt).length;
  const latest = checkinsOf(g.id, checkins)[0];
  const age = checkinAge(latest, today);
  const projectIds = goalProjectIds(g, links).filter((id) => projects.some((p) => p.id === id));
  const dots = projectIds.map((id) => projectDot(projects.find((p) => p.id === id)!, tasks, statusUpdates, today));
  const noWork = v2 && !personal && !hasWorkBehind(g, all, links);
  const period = periodShort(g, today);
  // a goal that tracks its own number says it ("60% of 80%"), so its % beside the bar reads as how far along it is
  const numbers = r.progress.source === "manual" && !r.needs && g.target != null ? numbersLine(g, { from: false }) : "";
  const sub = [
    parent ? `${g.kind && g.kind !== "objective" ? KIND_LABEL[g.kind] : "Under"} · ${parent.name}` : g.kind && g.kind !== "objective" ? KIND_LABEL[g.kind] : "",
    period,
    carried ? "Carried over" : "",
    numbers,
    kids ? `${kids} key ${kids === 1 ? "result" : "results"}` : "",
    g.visibility === "leadership" ? "Leadership only" : "",
    g.archivedAt ? "Archived" : "",
  ].filter(Boolean);
  const state = r.pace?.state;
  const tone = state === "behind" ? "warn" : state === "late" ? "signal" : state === "done" ? "ok" : "accent";
  const expected = r.pace && r.pace.state !== "early" ? r.pace.expected : undefined;
  const ownerName = g.ownerId ? personName(g.ownerId, members) : "";
  const say = paceWords(r) || (r.progress.source === "project" ? "From its project" : "");
  // the owner's call beside Kanbo's read: "At risk · Behind pace by 13%" (and when they differ, it shows)
  const status = GOAL_STATUS_LABEL[g.status] ?? "On track";
  const statusTone = (GOAL_TONE[g.status] ?? GOAL_TONE.on_track).tone;
  const statusTip = paceDisagrees(g.status, r.pace) ? `Marked ${status.toLowerCase()}; the pace says ${r.pace.line.toLowerCase()}` : undefined;
  return (
    <li className="kgp-row" data-open={open || undefined} data-archived={g.archivedAt ? "true" : undefined}>
      <ProjectTile project={goalTile(g)} size={28} className="kgp-tile" />
      <div className="kgp-main">
        <button type="button" className="kgp-open" onClick={onOpen} aria-current={open || undefined}>{g.name}</button>
        {sub.length > 0 && <div className="kgp-sub">{sub.map((s, i) => <span key={i}>{s}</span>)}</div>}
      </div>
      <span className="kgp-owner">
        {personal ? null : g.ownerId
          ? <span role="img" aria-label={`Owner: ${ownerName}`} title={ownerName}><Avatar id={g.ownerId} size={24} /></span>
          : v2 ? <span className="kgp-noface" role="img" aria-label="No owner" title="No owner"><Icon name="user" size={12} /></span> : null}
      </span>
      <div className="kgp-pace">
        {r.hidden ? <span className="kgp-pct" aria-label="Progress unknown">–</span> : <>
          <Meter value={r.pct} height={4} tone={tone} marker={expected} label={`${g.name} progress`} />
          <span className="kgp-pct" title={numbers ? `${r.pct}% of the way` : undefined}>{r.pct}%</span>
        </>}
        <span className="kgp-pace-say" data-state={state} title={statusTip}>
          <span className="kgp-status" data-tone={statusTone}>{status}</span>
          {say && <span className="kgp-pace-words">{say}</span>}
        </span>
      </div>
      <span className="kgp-age" data-none={!age || undefined} title={latest ? `Last check-in ${daysAgo(latest.createdAt, today)}` : "No check-ins yet"}>
        {age ?? "–"}
        <span className="sr-only">{latest ? ` since the last check-in` : " no check-ins yet"}</span>
      </span>
      <span className="kgp-dots">
        {dots.length > 0 ? (
          <>
            {dots.slice(0, 3).map((d, i) => <span key={i} className="kgp-dot" data-tone={d.tone} role="img" aria-label={d.label} title={d.label} />)}
            {dots.length > 3 && <span className="kgp-dots-more">+{dots.length - 3}</span>}
          </>
        ) : noWork ? <span className="kgp-nowork">No work behind this</span> : null}
      </span>
      <div className="kgp-checkin">
        <span className="kgp-checkin-say" data-state={state} title={statusTip}>
          <span className="kgp-status" data-tone={statusTone}>{status}</span>
          {[say, latest ? `checked in ${daysAgo(latest.createdAt, today)}` : "", noWork ? "no work behind this" : ""].filter(Boolean).map((x) => ` · ${x}`).join("")}
        </span>
        {canCheckin && <Button size="sm" variant="secondary" icon="check" aria-label={`Check in on ${g.name}`} onClick={onCheckin}>Check in</Button>}
      </div>
    </li>
  );
}

/** Goals for a guest: the same goals to read, with no fields, pickers or buttons (a guest's
 *  changes would only be refused). Once 0051 is run, guests can't read goals at all, and the
 *  page says who they're for instead. */
function GoalsReadOnly({ ordered, reads, projects, todayIso, gated = false }: {
  ordered: { g: Goal; depth: number }[]; reads: Map<string, GoalRead>; projects: Project[]; todayIso: string;
  /** 0058: project access is on here (a guest sees only the projects they're added to) */
  gated?: boolean;
}) {
  return (
    <div className="kpj-page">
      <div className="kpj-wrap">
        <div className="kpj-narrow">
          {ordered.length === 0 ? (
            <EmptyState art="target" title="Goals are for members"
              body={`Members of this workspace set its goals and track them here. As a guest you can still open ${gated ? "the projects you're added to and comment on their tasks" : "every project and comment on its tasks"}.`} />
          ) : (
            <>
              <div className="kpj-toolbar">
                <p className="kpj-toolbar-note">The goals this workspace is working towards. Members keep them up to date; as a guest you can read them.</p>
              </div>
              <div className="kpj-stack">
                {ordered.map(({ g, depth }) => {
                  const meta = GOAL_TONE[g.status] ?? GOAL_TONE.on_track;
                  const prog: GoalProgress = reads.get(g.id)?.progress ?? { pct: 0, source: "manual", children: 0 };
                  const linked = linkedOf(g, projects);
                  const overdue = !!g.due && g.due < todayIso && g.status !== "done" && prog.pct < 100;
                  return (
                    <article key={g.id} className="kpj-card kpj-goal" data-depth={depth || undefined} aria-label={`Goal ${g.name}`}
                      style={depth ? ({ "--depth": Math.min(depth, 5) } as React.CSSProperties) : undefined}>
                      <div className="kpj-card-head">
                        {depth > 0 && <Icon name="arrowRight" size={14} sw={1.75} style={{ color: "var(--icon-quiet, var(--ink-4))" }} />}
                        <h3 className="kpj-name-static" style={{ margin: 0, whiteSpace: "normal" }}>{g.name}</h3>
                        <div className="kpj-card-side"><Pill tone={meta.tone}>{GOAL_STATUS_LABEL[g.status] ?? "On track"}</Pill></div>
                      </div>
                      {g.description && <p className="kpj-goal-desc-text">{g.description}</p>}
                      {(g.due || overdue || (prog.source !== "project" && (g.target ?? 0) > 0)) && (
                        <div className="kpj-card-row">
                          {g.due && <DateChip size="sm" label={`Due date for ${g.name}`} value={g.due} tone="plain" readOnly onChange={() => undefined} />}
                          {overdue && <Pill tone="signal">Overdue</Pill>}
                          {prog.source !== "project" && (g.target ?? 0) > 0 && (
                            <span className="kpj-card-meta kpj-mono">{g.current ?? 0} / {g.target}{g.unit ? ` ${g.unit}` : ""}</span>
                          )}
                        </div>
                      )}
                      <div className="kpj-goal-progress">
                        <Meter value={prog.pct} height={6} label={`${g.name} progress`} />
                        <span className="kpj-mono">{prog.pct}%</span>
                      </div>
                      <GoalSource prog={prog} linked={linked} />
                    </article>
                  );
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
