/* ============================================================
   KANBO — Projects › Group: every business you run (owner or admin)
   on one calm page. One section per business, with its logo: goals
   behind, projects off track or missing an update, requests waiting
   for your approval and the week's wins, the business that needs you
   most first (as the switcher and Today say it). Clicking anything
   switches to that business and opens it. On a phone a calm block folds
   into one line, so a calm business is short.
   Everything comes from what's already loaded for you (lib/group), so
   nothing shows that you couldn't open yourself. A project carries one
   pill, its lead's call and Kanbo's read together (a mark when the call
   is rosier than the work; those come first), and one whose update is
   missing can be asked for it there and then.
   `pace` is wave 2's hook: a goal's pace line, under its meter.
   0056: Run meeting on each business (its leadership meeting) and, at
   the top, one over every business you run (components/meetings).
   ============================================================ */
import { useMemo, type ReactNode } from "react";
import { Button, EmptyState, Icon, Meter, Pill, ProjectTile, StatusGlyph } from "../primitives";
import { timeAgo } from "../../data/data";
import type { ApprovalWithTask, Goal, Project, StatusUpdate, Task, Workspace, WorkspaceMember } from "../../data/types";
import { digestLine, groupDigest, offTrackPills, type BusinessDigest, type GoalPace, type GoalWhy } from "../../lib/group";
import type { WorkspaceSignal } from "../../lib/businesses";
import { readCapacities } from "../../lib/radar";
import { useAvailability } from "../availability/useAvailability";
import { BUSINESS_CSS, WorkspaceMark } from "../businesses/Businesses";
import type { AskForUpdate } from "../../lib/updateAsks";
import { MergedStatusPill } from "../updates/MergedStatusPill";
import { AskForUpdateButton } from "../updates/AskForUpdate";
import { RunMeetingButton } from "../meetings/RunMeetingButton";
import "../project/projects.css";

/** Where a click on the Group page goes, in the business it belongs to. */
export type GroupTarget =
  | { kind: "business" }
  | { kind: "goals" }
  | { kind: "project"; projectId: string }
  | { kind: "task"; taskId: string }
  | { kind: "risks" };

export interface GroupViewProps {
  workspaces: Workspace[];
  members: WorkspaceMember[];
  currentUserId: string;
  /** every live task you can see, in every workspace */
  tasks: Task[];
  /** the same, archived projects' tasks included (a goal linked to one keeps its %) */
  goalTasks?: Task[];
  projects: Project[];
  goals: Goal[];
  statusUpdates: StatusUpdate[];
  /** requests waiting for your approval (every workspace) */
  approvals: ApprovalWithTask[];
  today: Date;
  /** switch to the business, then open what was clicked */
  onOpen: (workspaceId: string, to: GroupTarget) => void;
  /** wave 2: the goal pace line */
  pace?: GoalPace;
  /** each workspace's signals (your own work there, and who needs you most: the switcher's meaning) */
  signals?: ReadonlyMap<string, WorkspaceSignal>;
  /** 0053: ask a project's owner for its missing update */
  asks?: AskForUpdate;
  /** 0056: Run meeting on each business, and over them all */
  runMeetings?: boolean;
}

const GROUP_CSS = `
.kgrp-intro { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-height: 48px; padding: 8px 0; }
.kgrp-intro p { flex: 1 1 320px; margin: 0; font: 400 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); text-wrap: pretty; }
.kgrp-list { display: flex; flex-direction: column; gap: 20px; container-type: inline-size; }
.kgrp-biz { position: relative; padding: 20px 20px 18px; border-radius: var(--r-xl, 16px); background: var(--surface, var(--surface-raised)); box-shadow: var(--e1, 0 0 0 1px var(--hairline)); }
.kgrp-head { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.kgrp-title { flex: 1 1 260px; min-width: 0; }
.kgrp-name { display: flex; align-items: center; gap: 10px; margin: 0; font: 600 20px/28px var(--font-head); letter-spacing: -0.012em; color: var(--ink); }
.kgrp-name button { padding: 0; border: 0; background: none; font: inherit; letter-spacing: inherit; color: inherit; cursor: pointer; text-align: left; border-radius: 4px; }
.kgrp-name button:hover { color: var(--accent-text, var(--accent)); }
.kgrp-sub { margin: 2px 0 0; font: 500 13px/18px var(--font-ui, var(--font-display)); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kgrp-sub b { font-weight: 600; color: var(--ink-2); }
.kgrp-side { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.kgrp-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 232px), 1fr)); gap: 12px; margin-top: 16px; }
.kgrp-block { min-width: 0; padding: 12px 14px 10px; border-radius: var(--r-lg, 12px); background: var(--fill-1); box-shadow: inset 0 0 0 1px var(--hairline); }
.kgrp-block h3 { display: flex; align-items: baseline; gap: 8px; margin: 0 0 6px; font: 600 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kgrp-n { font: 600 12px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink); }
.kgrp-n[data-tone="signal"] { color: var(--signal, var(--st-blocked)); }
.kgrp-n[data-tone="warn"] { color: var(--warn); }
.kgrp-of { font: 500 11px/16px var(--font-mono); color: var(--ink-4); }
.kgrp-rows { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.kgrp-row { display: flex; flex-direction: column; gap: 3px; padding: 7px 0; border-top: 1px solid var(--hairline); }
.kgrp-row:first-child { border-top: 0; padding-top: 2px; }
.kgrp-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
.kgrp-open { flex: 1 1 auto; min-width: 0; padding: 0; border: 0; background: none; cursor: pointer; text-align: left; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink); border-radius: 4px; }
.kgrp-open:hover { color: var(--accent-text, var(--accent)); }
.kgrp-meta { display: flex; align-items: center; gap: 8px; min-width: 0; font: 500 11px/16px var(--font-mono); font-variant-numeric: tabular-nums; color: var(--ink-3); }
.kgrp-meta > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* (the one pill keeps its "Lead says / Kanbo sees" tip, and its whole word) */
.kgrp-meta > .kup-pair { flex-shrink: 0; overflow: visible; }
/* a project's why wraps rather than lose the update's call off its end */
.kgrp-meta:has(> .kgrp-why) { flex-wrap: wrap; row-gap: 2px; }
.kgrp-meta > .kgrp-why { white-space: normal; }
.kgrp-pace { font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kgrp-calm { display: flex; align-items: center; gap: 8px; margin: 2px 0 4px; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kgrp-calm > svg { color: var(--ok, var(--st-done)); flex-shrink: 0; }
.kgrp-wins-n { display: block; margin: 0 0 4px; font: 600 24px/30px var(--font-head); letter-spacing: -0.01em; color: var(--ink); }
.kgrp-wins-n small { margin-left: 6px; font: 500 12px/16px var(--font-ui, var(--font-display)); color: var(--ink-3); letter-spacing: 0; }
.kgrp-go { flex-shrink: 0; display: inline-flex; align-items: center; gap: 4px; }
/* what's calm, in one line (a phone's: the calm blocks fold into it) */
.kgrp-calmline { display: none; flex-wrap: wrap; gap: 2px 14px; margin: 12px 0 0; padding: 0; list-style: none; font: 500 13px/20px var(--font-ui, var(--font-display)); color: var(--ink-3); }
.kgrp-calmline li { display: inline-flex; align-items: center; gap: 6px; }
.kgrp-calmline svg { color: var(--ok, var(--st-done)); flex-shrink: 0; }
/* narrow (a phone, or the task panel open beside it): Open stays by the name, the pills go underneath */
@container (max-width: 759px) {
  .kgrp-head { gap: 10px 12px; }
  .kgrp-title { flex: 1 1 0; }
  .kgrp-go { order: 2; align-self: flex-start; margin: 2px -8px 0 0; }
  .kgrp-side { order: 3; width: 100%; }
}
@media (max-width: 859px) {
  .kgrp-biz { padding: 16px 14px 14px; border-radius: var(--r-lg, 12px); }
  .kgrp-name { font-size: 18px; line-height: 24px; }
  .kgrp-block[data-calm] { display: none; }
  .kgrp-calmline { display: flex; }
  .kgrp-grid:not(:has(.kgrp-block:not([data-calm]))) { display: none; }
}
`;

const GOAL_WHY: Record<GoalWhy, { label: string; tone: "warn" | "signal" | "neutral" }> = {
  off_track: { label: "Off track", tone: "signal" },
  at_risk: { label: "At risk", tone: "warn" },
  overdue: { label: "Overdue", tone: "signal" },
  pace: { label: "Behind pace", tone: "warn" },
};
const ROLE_LABEL = { owner: "Owner", admin: "Admin", member: "Member", guest: "Guest" } as const;

function Block({ title, n, of, tone, calm, children }: { title: string; n?: number; of?: number; tone?: "warn" | "signal"; calm?: boolean; children: ReactNode }) {
  return (
    <section className="kgrp-block" aria-label={title} data-calm={calm || undefined}>
      <h3>
        <span>{title}</span>
        {n !== undefined && <span className="kgrp-n" data-tone={n > 0 ? tone : undefined}>{n}</span>}
        {of !== undefined && of > 0 && <span className="kgrp-of">of {of}</span>}
      </h3>
      {children}
    </section>
  );
}

const Calm = ({ children }: { children: ReactNode }) => <p className="kgrp-calm"><Icon name="check" size={14} sw={2} />{children}</p>;

function BusinessSection({ d, onOpen, asks, runMeetings }: { d: BusinessDigest; onOpen: GroupViewProps["onOpen"]; asks?: AskForUpdate; runMeetings?: boolean }) {
  const ws = d.workspace;
  const wsId = ws.id!;
  const go = (to: GroupTarget) => onOpen(wsId, to);
  const nameId = `kgrp-${wsId}`;
  // (on a phone these fold into one line under the name)
  const calmGoals = d.goals.behind.length === 0, calmProjects = d.projects.needs.length === 0, calmWaiting = d.approvals.length === 0;
  const calmLine = [
    calmGoals && (d.goals.total ? "Every goal on track" : "No goals yet"),
    calmProjects && (d.projects.total ? "No project needs a look" : "No projects yet"),
    calmWaiting && "Nothing waiting for you",
    d.wins.count === 0 && "Nothing finished yet",
  ].filter((x): x is string => !!x);
  return (
    <section className="kgrp-biz" aria-labelledby={nameId}>
      <div className="kgrp-head">
        <WorkspaceMark workspace={ws} size={40} />
        <div className="kgrp-title">
          <h2 className="kgrp-name" id={nameId}>
            <button type="button" onClick={() => go({ kind: "business" })} title={`Switch to ${ws.name}`}>{ws.name}</button>
          </h2>
          <p className="kgrp-sub"><b>{ROLE_LABEL[d.role]}</b> · {digestLine(d)}</p>
        </div>
        {d.needsMost || d.risks > 0 ? (
          <div className="kgrp-side">
            {d.needsMost && <Pill tone="accent">Needs you most</Pill>}
            {d.risks > 0 && (
              <Pill tone="signal" icon="radar" onClick={() => go({ kind: "risks" })} title={`Open ${ws.name}'s Pulse`}>
                {d.risks} {d.risks === 1 ? "risk" : "risks"} on the radar
              </Pill>
            )}
          </div>
        ) : null}
        <span className="kgrp-go">
          {/* 0056: this business's leadership meeting (you run it: an owner or admin) */}
          {runMeetings && <RunMeetingButton scope={{ workspaceId: wsId, preset: "leadership", canLead: true }} variant="ghost" />}
          <Button variant="ghost" size="sm" iconRight="arrowRight" onClick={() => go({ kind: "business" })} aria-label={`Open ${ws.name}`}>Open</Button>
        </span>
      </div>

      <div className="kgrp-grid">
        <Block title="Goals behind" n={d.goals.behind.length} of={d.goals.total} tone="warn" calm={calmGoals}>
          {d.goals.total === 0 ? <p className="kgrp-calm">No goals yet.</p>
            : d.goals.behind.length === 0 ? <Calm>Every goal is on track.</Calm> : (
              <ul className="kgrp-rows">
                {d.goals.behind.slice(0, 3).map(({ goal, pct, why, pace }) => (
                  <li key={goal.id} className="kgrp-row">
                    <div className="kgrp-line">
                      <button type="button" className="kgrp-open" onClick={() => go({ kind: "goals" })} title={goal.name}>{goal.name}</button>
                      <Pill tone={GOAL_WHY[why].tone}>{GOAL_WHY[why].label}</Pill>
                    </div>
                    <div className="kgrp-meta">
                      <Meter value={pct} width={88} height={4} label={`${goal.name} progress`} />
                      <span>{pct}%</span>
                    </div>
                    {/* wave 2: the pace line */}
                    {pace?.line && <span className="kgrp-pace">{pace.line}</span>}
                  </li>
                ))}
              </ul>
            )}
        </Block>

        <Block title="Projects to look at" n={d.projects.needs.length} of={d.projects.total} tone={offTrackPills(d) > 0 ? "signal" : "warn"} calm={calmProjects}>
          {d.projects.total === 0 ? <p className="kgrp-calm">No projects yet.</p>
            : d.projects.needs.length === 0 ? <Calm>No project needs a look.</Calm> : (
              <ul className="kgrp-rows">
                {d.projects.needs.slice(0, 3).map((n) => (
                  <li key={n.project.id} className="kgrp-row">
                    <div className="kgrp-line">
                      <ProjectTile project={n.project} size={16} />
                      <button type="button" className="kgrp-open" onClick={() => go({ kind: "project", projectId: n.project.id })}>{n.project.name}</button>
                      {/* (whatever else is wrong with it: a missing update can be asked for) */}
                      {n.missing && <AskForUpdateButton project={n.project} asks={asks} compact />}
                    </div>
                    <div className="kgrp-meta">
                      {/* one pill: the lead's call and Kanbo's read together */}
                      <MergedStatusPill m={n.status} />
                      {(n.missing || n.why === "stale") && <span className="kup-fresh" data-kind="missing">{n.why === "stale" ? n.label : "Update missing"}</span>}
                      <span className="kgrp-why">{n.detail}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
        </Block>

        <Block title="Waiting for your approval" n={d.approvals.length} tone="warn" calm={calmWaiting}>
          {d.approvals.length === 0 ? <Calm>Nothing waiting for you.</Calm> : (
            <ul className="kgrp-rows">
              {d.approvals.slice(0, 3).map((a) => (
                <li key={a.id} className="kgrp-row">
                  <div className="kgrp-line">
                    <button type="button" className="kgrp-open" onClick={() => go({ kind: "task", taskId: a.taskId })}>{a.title}</button>
                  </div>
                  <div className="kgrp-meta"><span>{a.requestedByName ? `From ${a.requestedByName.split(/\s+/)[0]} · ` : ""}{timeAgo(a.createdAt)}</span></div>
                </li>
              ))}
            </ul>
          )}
        </Block>

        <Block title={d.wins.label} calm={d.wins.count === 0}>
          {d.wins.count === 0 ? <p className="kgrp-calm">Nothing finished yet.</p> : (
            <>
              <span className="kgrp-wins-n">{d.wins.count}<small>{d.wins.count === 1 ? "task done" : "tasks done"}</small></span>
              <ul className="kgrp-rows">
                {d.wins.top.map((t) => (
                  <li key={t.id} className="kgrp-row">
                    <div className="kgrp-line">
                      <StatusGlyph status="done" size={14} readOnly />
                      <button type="button" className="kgrp-open" onClick={() => go({ kind: "task", taskId: t.id })}>{t.title}</button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Block>
      </div>
      {calmLine.length > 0 && (
        <ul className="kgrp-calmline" aria-hidden="true">
          {calmLine.map((c) => <li key={c}><Icon name="check" size={14} sw={2} />{c}</li>)}
        </ul>
      )}
    </section>
  );
}

export function GroupView({ workspaces, members, currentUserId, tasks, goalTasks, projects, goals, statusUpdates, approvals, today, onOpen, pace, signals, asks, runMeetings }: GroupViewProps) {
  // worked out once per change of what it reads (App re-renders every second while the focus timer runs)
  // (0055: each business's own shared capacities, read again when they change)
  const avail = useAvailability();
  const digests = useMemo(
    () => groupDigest({ workspaces, members, me: currentUserId, tasks, goalTasks, projects, goals, statusUpdates, approvals, today, capacities: readCapacities(), capacitiesFor: (ws) => readCapacities(ws), pace, signals }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, members, currentUserId, tasks, goalTasks, projects, goals, statusUpdates, approvals, today, pace, signals, avail],
  );
  return (
    <div className="kpj-page">
      <style>{BUSINESS_CSS}</style>
      <style>{GROUP_CSS}</style>
      <div className="kpj-wrap">
        {digests.length < 2 ? (
          <EmptyState art="briefcase" title="One business at a time, for now"
            body="The Group page shows every business you run side by side. It appears once you're an owner or admin of two or more workspaces." />
        ) : (
          <>
            <div className="kgrp-intro">
              <p>Every business you run, side by side: what's behind, what's waiting for you and what got done. Tap or click anything to open it in its business.</p>
              {/* 0056: one leadership meeting over them all (hosted by the business that needs you most) */}
              {runMeetings && <RunMeetingButton label="Run group meeting"
                scope={{ workspaceId: digests[0].workspace.id!, workspaceIds: digests.map((d) => d.workspace.id!).filter(Boolean), preset: "leadership", canLead: true }} />}
            </div>
            <div className="kgrp-list">
              {digests.map((d) => <BusinessSection key={d.workspace.id} d={d} onOpen={onOpen} asks={asks} runMeetings={runMeetings} />)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
