/* ============================================================
   KANBO — the shell's view across businesses (lib/businesses): whether
   All businesses is on, the lists Today, Inbox and My tasks show while
   it is, each workspace's signals for the switcher's dots, the brief's
   lead line (or, while it's off, the line naming another workspace that
   needs you), Radar across the businesses you run, the workspaces you're
   a guest in, the Group page's eligibility and the time you've planned in
   other businesses. Worked out once per change of what it reads: App
   re-renders every second while the focus timer runs.
   ============================================================ */
import { useMemo } from "react";
import { KANBO_TODAY, getMember } from "../data/data";
import type { Activity, ApprovalWithTask, CalEvent, Member, Project, Task, Workspace, WorkspaceMember } from "../data/types";
import {
  approvalsEverywhere, busyElsewhere, businessesYouRun, businessLead, hasGroup, inboxEverywhere, isYours, liveTasks, offersAllBusinesses, SELF_KINDS,
  workspaceSignals, wsKey, type BusinessLead, type WorkspaceSignal,
} from "../lib/businesses";
import { computeRisks, readCapacities, type Risk } from "../lib/radar";

export interface BusinessScopeInput {
  /** every task you can see, as stored (team and project views' rows) */
  tasks: Task[] | null;
  /** …and as you see them (your own plan on others' tasks) */
  seen: Task[] | null;
  projects: Project[];
  activity: Activity[];
  toReview: ApprovalWithTask[];
  workspaces: Workspace[];
  members: WorkspaceMember[];
  workspace: string | null;
  me: string;
  /** "YYYY-MM-DD": today, so day-based signals move on at midnight */
  today: string;
  /** the person's choice (profiles.onboarding.businesses.all) */
  allChosen: boolean;
}

export interface BusinessScope {
  /** you're in more than one workspace: the switch is offered */
  offered: boolean;
  /** All businesses is on (chosen, and offered) */
  all: boolean;
  /** you run two or more businesses: Projects › Group */
  group: boolean;
  /** every live task you can see, everywhere: as stored, and as you see them */
  liveRows: Task[];
  liveSeen: Task[];
  /** yours, everywhere (as you see them) */
  mine: Task[];
  /** every workspace's Inbox items, together */
  inbox: Activity[];
  /** unread in that list (not your own actions) */
  unread: number;
  /** requests waiting on you, everywhere */
  approvals: ApprovalWithTask[];
  /** each workspace's dots, by wsKey */
  signals: Map<string, WorkspaceSignal>;
  /** All businesses' brief lead */
  lead: BusinessLead;
  /** while it's off: the other workspaces that need you (Today's line under the brief) */
  elsewhere: BusinessLead;
  /** All businesses: Radar's risks in every business you run (owner or admin), else none */
  risks: Risk[];
  /** the businesses you run (owner or admin) */
  runs: Workspace[];
  /** the workspaces you're a guest in (in All businesses their rows are view-only) */
  guestIn: ReadonlySet<string>;
  /** your blocks on today's day in the other workspaces (busy time here) */
  busy: CalEvent[];
  /** everyone in any of your workspaces: names for rows and the brief, Members for approvals */
  people: { id: string; name: string }[];
  peopleAsMembers: Member[];
  /** "All businesses", or the open workspace's name */
  scopeName: string;
  /** "3 businesses" (the Group page's header) */
  groupMeta: string;
  /** today, as one Date per day (the Group page's memo stays put) */
  todayDate: Date;
}

const NO_LEAD: BusinessLead = { lead: null, others: [], plain: "" };
const NO_RISKS: Risk[] = [];

export function useBusinessScope(input: BusinessScopeInput): BusinessScope {
  const { tasks, seen, projects, activity, toReview, workspaces, members, workspace, me, today, allChosen } = input;
  const offered = offersAllBusinesses(workspaces);
  const all = allChosen && offered;
  const group = useMemo(() => hasGroup(workspaces, members, me), [workspaces, members, me]);
  const liveRows = useMemo(() => liveTasks(tasks ?? [], projects), [tasks, projects]);
  const liveSeen = useMemo(() => (seen === tasks ? liveRows : liveTasks(seen ?? [], projects)), [seen, tasks, liveRows, projects]);
  const mine = useMemo(() => liveSeen.filter((t) => isYours(t, me)), [liveSeen, me]);
  const inbox = useMemo(() => inboxEverywhere(activity, tasks ?? [], projects), [activity, tasks, projects]);
  const unread = useMemo(() => inbox.filter((a) => !a.readAt && !SELF_KINDS.has(a.kind)).length, [inbox]);
  const approvals = useMemo(() => approvalsEverywhere(toReview), [toReview]);
  // (an Inbox item's workspace is its task's, archived or not, as the Inbox itself counts it)
  const signals = useMemo(() => workspaceSignals({ workspaces, tasks: liveSeen, allTasks: tasks ?? [], projects, activity: inbox, approvals, me, today }),
    [workspaces, liveSeen, tasks, projects, inbox, approvals, me, today]);
  const lead = useMemo(() => businessLead(signals, workspaces), [signals, workspaces]);
  const elsewhere = useMemo(() => (offered && !all ? businessLead(signals, workspaces.filter((w) => w.id !== workspace)) : NO_LEAD), [offered, all, signals, workspaces, workspace]);
  const runs = useMemo(() => businessesYouRun(workspaces, members, me), [workspaces, members, me]);
  const guestIn = useMemo(() => new Set(members.filter((m) => m.userId === me && m.status === "active" && m.role === "guest" && m.workspaceId).map((m) => m.workspaceId!)), [members, me]);
  // Radar in each business you run, worked out for that business alone (as its Pulse does)
  const risks = useMemo(() => {
    if (!all || !runs.length) return NO_RISKS;
    const caps = readCapacities();
    return runs.flatMap((w) => {
      const people = members.filter((m) => m.workspaceId === w.id && m.status === "active" && m.userId)
        .map((m) => ({ id: m.userId!, name: getMember(m.userId!)?.name || m.name || m.email, ...(m.role === "guest" ? { guest: true } : {}) }));
      try { return computeRisks({ tasks: liveRows.filter((t) => t.workspaceId === w.id), members: people, capacities: caps, today }); } catch { return []; }
    });
  }, [all, runs, members, liveRows, today]);
  const nameOf = useMemo(() => {
    const names = new Map(workspaces.map((w) => [wsKey(w.id), w.name]));
    return (id: string | null) => names.get(wsKey(id)) ?? (id ? "Another workspace" : "Personal");
  }, [workspaces]);
  // (in All businesses every block is on the day itself)
  const busy = useMemo(() => (all ? [] : busyElsewhere(liveSeen, workspace, me, nameOf)), [all, liveSeen, workspace, me, nameOf]);
  const people = useMemo(() => {
    const names = new Map<string, string>([[me, getMember(me)?.name || "You"]]);
    members.forEach((m) => { if (m.status === "active" && m.userId && !names.has(m.userId)) names.set(m.userId, getMember(m.userId)?.name || m.name || m.email); });
    return [...names].map(([id, name]) => ({ id, name }));
  }, [members, me]);
  const peopleAsMembers = useMemo(() => people.map((p): Member => {
    const known = getMember(p.id);
    const guestEverywhere = members.filter((m) => m.userId === p.id && m.status === "active").every((m) => m.role === "guest");
    return { id: p.id, name: p.name, email: known?.email ?? members.find((m) => m.userId === p.id)?.email ?? "", type: p.id === me ? "self" : guestEverywhere ? "external" : "team", color: known?.color ?? "oklch(0.72 0.14 264)" };
  }), [people, members, me]);
  const todayDate = useMemo(() => new Date(KANBO_TODAY), [today]); // eslint-disable-line react-hooks/exhaustive-deps
  const scopeName = all ? "All businesses" : workspaces.find((w) => w.id === workspace)?.name || "Personal";
  return {
    offered, all, group, liveRows, liveSeen, mine, inbox, unread, approvals, signals, lead, elsewhere, risks, runs, guestIn, busy, people, peopleAsMembers,
    scopeName, groupMeta: `${runs.length} ${runs.length === 1 ? "business" : "businesses"}`, todayDate,
  };
}
