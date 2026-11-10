/* ============================================================
   KANBO — the agenda Kanbo builds for a meeting (0056). One engine
   for both presets: a team meeting goes round each person (done,
   today, blocked, and who's off), then Radar's risks, goals behind
   pace and last meeting's actions; a leadership meeting leads with
   the goals, the projects to look at (an update missing, or a status
   rosier than the work) and the risks. Either can switch any section
   on or off. It opens with Kanbo's read in one or two sentences and
   ends with a wrap-up (decisions, actions, the notes doc, the recap).
   Everything comes from what's already loaded for the person starting
   it (lib/pulse, lib/radar, lib/group), so nothing is shown that they
   couldn't open themselves. A team meeting never carries a
   leadership-only goal (nor its key results, nor theirs) or anyone's
   reason for being off. Pure: no React, no I/O.
   ============================================================ */
import type { Goal, Project, Role, StatusUpdate, Task, Workspace, WorkspaceEvent, WorkspaceMember } from "../../data/types";
import { getMember, toLocalISO } from "../../data/data";
import { buildPulse, pulseSentenceParts, type PulsePerson, type SentencePart } from "../pulse";
import { computeRisks } from "../radar";
import { businessDigest } from "../group";
import { groupGoalPace } from "../goalPace";
import { goalLookup } from "../goalRules";
import { fmtDayMonth, localDay } from "../weekMath";
import { meetingDay } from "./types";
import type {
  AgendaAction, AgendaEntry, AgendaGoal, AgendaItem, AgendaProject, AgendaRisk, Meeting, MeetingItem, MeetingPreset, MeetingSection,
} from "./types";

export const SECTION_ORDER: readonly MeetingSection[] = ["people", "risks", "goals", "projects", "actions"];

export const SECTION_LABEL: Record<MeetingSection, string> = {
  people: "Each person",
  risks: "Radar risks",
  goals: "Goals behind pace",
  projects: "Projects to look at",
  actions: "Last meeting's actions",
};

export interface PresetInfo {
  label: string;
  /** one line under the choice */
  blurb: string;
  /** the sections it starts with switched on */
  sections: readonly MeetingSection[];
  /** a calm time box, in minutes (the timer turns amber past it) */
  minutes: number;
}

export const PRESETS: Record<MeetingPreset, PresetInfo> = {
  team: {
    label: "Team meeting",
    blurb: "Go round the team: what's done, what's on today and what's blocked, then what's at risk.",
    sections: ["people", "risks", "goals", "actions"],
    minutes: 15,
  },
  leadership: {
    label: "Leadership meeting",
    blurb: "Goals behind pace, projects to look at, the risks and last meeting's actions.",
    sections: ["risks", "goals", "projects", "actions"],
    minutes: 45,
  },
};

/** At most this many tasks per person per column, and items per section. */
const PER_LIST = 6;
const PER_SECTION = 12;
const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export { meetingDay } from "./types";

/** The title Kanbo suggests: "Foundrise team meeting, Tue 10 Nov", "Foundrise leadership, Tue 10 Nov",
 *  "Group leadership, Tue 10 Nov" (several businesses). */
export function meetingTitle(preset: MeetingPreset, businesses: readonly Pick<Workspace, "name">[], today: Date): string {
  const day = meetingDay(today);
  if (businesses.length > 1) return `Group leadership, ${day}`;
  const name = (businesses[0]?.name ?? "").trim() || "Team";
  return preset === "leadership" ? `${name} leadership, ${day}` : `${name} team meeting, ${day}`;
}

export interface AgendaInput {
  preset: MeetingPreset;
  /** the businesses it covers, the host among them (a team meeting: just the host) */
  workspaces: readonly Workspace[];
  hostId: string;
  members: readonly WorkspaceMember[];
  me: string;
  /** every live task you can see (filtered to the businesses here) */
  tasks: readonly Task[];
  /** the same, archived projects' tasks included (a goal linked to one keeps its %) */
  goalTasks?: readonly Task[];
  projects: readonly Project[];
  goals: readonly Goal[];
  statusUpdates: readonly StatusUpdate[];
  today: Date;
  /** the host's change history, when it's loaded (Pulse's "done since" and Radar's slips) */
  events?: WorkspaceEvent[];
  /** each business's capacities this week (its shared weeks, less time off) */
  capacitiesFor?: (workspaceId: string) => Record<string, number>;
  /** "Off today" for someone at a business (the label only: never the reason), or null; `from`/`to`: the
   *  stretch's days (YYYY-MM-DD), so the agenda can count what falls due while they're away */
  offNote?: (userId: string, workspaceId: string) => { label: string; now: boolean; from?: string; to?: string } | null;
  /** the last meeting of this kind here, with its items: its actions open the next one */
  previous?: { meeting: Pick<Meeting, "id" | "title" | "endedAt">; items: readonly MeetingItem[] } | null;
}

export interface AgendaFacts {
  /** every section built (so the start sheet can count each, on or off) */
  people: Extract<AgendaItem, { kind: "person" }>[];
  risks: AgendaRisk[];
  goals: AgendaGoal[];
  projects: AgendaProject[];
  actions: AgendaAction[];
  from: { id: string; title: string; endedAt: string | null } | null;
  /** the team's lede (Pulse's), when there's a team to go round */
  pulse: SentencePart[] | null;
  /** who's off today (first names) */
  offToday: string[];
  /** last meeting's actions: done, and overdue now */
  actionsDone: number;
  actionsOverdue: number;
  /** goals behind, counted the way Pulse and Goals count them (a goal, its key results inside it), and the
   *  key results behind whose own goal isn't */
  goalsBehind: number;
  keyResultsBehind: number;
  counts: Record<MeetingSection, number>;
}

/** "2 goals", "1 goal and 1 key result", "2 key results" */
export function goalsWords(f: Pick<AgendaFacts, "goalsBehind" | "keyResultsBehind">): string {
  return [f.goalsBehind ? plural(f.goalsBehind, "goal") : "", f.keyResultsBehind ? plural(f.keyResultsBehind, "key result") : ""].filter(Boolean).join(" and ");
}

const roleOf = (members: readonly WorkspaceMember[], me: string, ws: string): Role | null =>
  members.find((m) => m.workspaceId === ws && m.userId === me && m.status === "active")?.role ?? null;

/** Every section of the agenda, worked out once (lib/pulse, lib/radar, lib/group). */
/** Is a goal leadership-only, or under one (its key results, theirs…)? A goal above it that isn't loaded counts
 *  too: whoever starts the meeting couldn't read it, so it isn't the team's to see. */
function underLeadership(g: Goal, byId: (id: string) => Goal | undefined): boolean {
  if (g.visibility === "leadership") return true;
  const seen = new Set<string>([g.id]);
  for (let cur = g.parentId; cur; ) {
    if (seen.has(cur)) return true;   // (a loop: never the team's)
    seen.add(cur);
    const up = byId(cur);
    if (!up || up.visibility === "leadership") return true;
    cur = up.parentId;
  }
  return false;
}

export function agendaFacts(input: AgendaInput): AgendaFacts {
  const { preset, members, today } = input;
  const byGoalId = goalLookup(input.goals);
  const todayISO = toLocalISO(today);
  const covered = input.workspaces.filter((w): w is Workspace & { id: string } => !!w.id);
  const ids = new Set(covered.map((w) => w.id));
  const tasks = input.tasks.filter((t) => !t.archivedAt && !!t.workspaceId && ids.has(t.workspaceId));
  const peopleOf = (ws: string) => members.filter((m) => m.workspaceId === ws && m.status === "active" && m.userId)
    .map((m) => ({ id: m.userId!, name: getMember(m.userId!)?.name?.trim() || m.name?.trim() || m.email, role: m.title?.trim() || undefined, guest: m.role === "guest" || undefined }));

  /* ---- each person (a team meeting at one business) ---- */
  let people: AgendaFacts["people"] = [];
  let pulse: SentencePart[] | null = null;
  const offToday: string[] = [];
  if (covered.length === 1) {
    const ws = covered[0].id;
    const team = peopleOf(ws).filter((p) => !p.guest);
    const caps = input.capacitiesFor?.(ws) ?? {};
    const facts = buildPulse({ tasks: tasks.filter((t) => t.workspaceId === ws), members: team, events: input.events, today: todayISO, capacities: caps, period: "day" });
    pulse = team.length ? pulseSentenceParts(facts) : null;
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const toEntry = (t: Task, note?: string, tone?: "signal"): AgendaEntry => ({ taskId: t.id, title: clip(t.title.replace(/\s+/g, " ").trim(), 160), status: t.status,
      ...(note ? { note } : {}), ...(tone ? { tone } : {}) });
    const waiting = (t: Task): string => {
      const blocker = (t.dependencies ?? []).map((id) => byId.get(id)).find((x) => x && x.status !== "done");
      if (!blocker) return "Blocked";
      const who = blocker.assigneeId ? team.find((p) => p.id === blocker.assigneeId)?.name ?? getMember(blocker.assigneeId)?.name : "";
      return who ? `Waiting on ${firstName(who)}` : `Waiting on "${clip(blocker.title, 40)}"`;
    };
    const dueNote = (t: Task): { note?: string; tone?: "signal" } => {
      if (!t.dueDate || t.status === "progress" || t.status === "review") return {};
      if (t.dueDate < todayISO) { const d = localDay(t.dueDate); return { note: `Overdue · due ${d ? fmtDayMonth(d) : t.dueDate}`, tone: "signal" }; }
      return t.dueDate === todayISO ? { note: "Due today" } : {};
    };
    const open = (t: Task) => t.status !== "done" && !t.archivedAt;
    const item = (p: PulsePerson): AgendaFacts["people"][number] => {
      const off = input.offNote?.(p.id, ws) ?? null;
      if (off?.now) offToday.push(firstName(p.name));
      // their open work due while they're away
      const from = off?.from && off.from > todayISO ? off.from : todayISO;
      const offDue = off?.to ? tasks.filter((t) => t.workspaceId === ws && t.assigneeId === p.id && open(t) && !t.isMilestone && !!t.dueDate
        && t.dueDate.slice(0, 10) >= from && t.dueDate.slice(0, 10) <= off.to!).length : 0;
      // others' open work waiting on theirs
      const holding = tasks.filter((t) => t.workspaceId === ws && open(t) && !t.isMilestone && t.assigneeId !== p.id
        && (t.dependencies ?? []).some((id) => { const b = byId.get(id); return !!b && b.assigneeId === p.id && open(b); }))
        .slice(0, 3).map((t) => ({ taskId: t.id, title: clip(t.title.replace(/\s+/g, " ").trim(), 120), whoId: t.assigneeId ?? null }));
      return {
        key: `person:${p.id}`, kind: "person", title: p.name, personId: p.id,
        ...(p.role ? { role: p.role } : {}),
        ...(off ? { off: off.label, offNow: off.now } : {}),
        ...(offDue ? { offDue } : {}),
        ...(holding.length ? { holding } : {}),
        done: p.done.slice(0, PER_LIST).map((t) => toEntry(t)),
        today: p.onToday.slice(0, PER_LIST).map((t) => { const n = dueNote(t); return toEntry(t, n.note, n.tone); }),
        blocked: p.blocked.slice(0, PER_LIST).map((t) => toEntry(t, waiting(t), "signal")),
        more: { done: Math.max(0, p.done.length - PER_LIST), today: Math.max(0, p.onToday.length - PER_LIST), blocked: Math.max(0, p.blocked.length - PER_LIST) },
        load: { hours: p.loadHours, capacity: p.capacity },
      };
    };
    // Pulse's order (the fullest weeks first), with anyone off today at the end
    const all = facts.people.map(item);
    people = [...all.filter((p) => !p.offNow), ...all.filter((p) => p.offNow)];
  }

  /* ---- Radar, goals and projects: each business's own ---- */
  const risks: AgendaRisk[] = [];
  const goals: AgendaGoal[] = [];
  const projects: AgendaProject[] = [];
  for (const w of covered) {
    const here = tasks.filter((t) => t.workspaceId === w.id);
    const caps = input.capacitiesFor?.(w.id) ?? {};
    try {
      const found = computeRisks({ tasks: here, members: peopleOf(w.id), capacities: caps, today: todayISO,
        ...(covered.length === 1 && input.events ? { events: input.events } : {}) });
      for (const r of found) {
        risks.push({ id: `${w.id}:${r.id}`, title: clip(r.title, 200), reason: clip(r.reason, 240), severity: r.severity,
          ...(r.memberId ? { memberId: r.memberId } : {}), taskIds: r.taskIds.slice(0, 8), workspaceId: w.id });
      }
    } catch { /* a malformed task never stops the meeting */ }
    // a team meeting never shows a leadership-only goal, nor anything under one (its key results, theirs…):
    // every member reads the agenda, and members can't read those (0052's goal_readable). No exemption for
    // whoever starts it being on one: the readers are everyone.
    const wsGoals = input.goals.filter((g) => (g.workspaceId ?? null) === w.id && (preset === "leadership" || !underLeadership(g, byGoalId)));
    const digest = businessDigest(w, roleOf(members, input.me, w.id) ?? "member", {
      workspaces: input.workspaces, members, me: input.me, tasks: here, goalTasks: input.goalTasks, projects: input.projects,
      goals: wsGoals, statusUpdates: input.statusUpdates, approvals: [], today, pace: groupGoalPace,
      ...(input.capacitiesFor ? { capacitiesFor: (id: string | null) => (id ? input.capacitiesFor!(id) : {}) } : {}),
    });
    // (a key result sits inside its goal, as Pulse and Goals count them: "2 goals behind", not four)
    const lineOf = (g: (typeof digest.goals.behind)[number]) => {
      const why = g.why === "off_track" ? "Off track" : g.why === "at_risk" ? "At risk" : g.why === "overdue" ? `Past due at ${g.pct}%` : "";
      return [why, g.pace?.line && g.pace.line !== why ? g.pace.line : ""].filter(Boolean).join(" · ") || g.pace?.line || "Behind pace";
    };
    const behind = digest.goals.behind;
    const parentOf = (g: Goal) => (g.parentId ? wsGoals.find((x) => x.id === g.parentId && !x.archivedAt) : undefined);
    for (const g of behind) {
      const parent = parentOf(g.goal);
      if (parent && behind.some((b) => b.goal.id === parent.id)) continue;   // shown inside its goal
      const krs = behind.filter((k) => k.goal.parentId === g.goal.id).map((k) => ({ id: k.goal.id, name: clip(k.goal.name, 160), pct: k.pct, line: lineOf(k) }));
      goals.push({ id: g.goal.id, name: clip(g.goal.name, 160), pct: g.pct, why: g.why, line: lineOf(g), ownerId: g.goal.ownerId ?? null, workspaceId: w.id, due: g.goal.due ?? null,
        ...(parent ? { parentName: clip(parent.name, 160) } : {}), ...(krs.length ? { krs } : {}) });
    }
    for (const n of digest.projects.needs) {
      projects.push({
        id: n.project.id, name: clip(n.project.name, 160), ...(n.project.emoji ? { emoji: n.project.emoji } : {}), ...(n.project.color ? { color: n.project.color } : {}),
        label: n.label, detail: clip(n.detail, 160), pill: n.status.label, tone: n.status.tone, says: n.status.says, sees: n.status.sees,
        mismatch: n.status.mismatch, ...(n.missing ? { missing: true } : {}), workspaceId: w.id,
      });
    }
  }
  const sevRank = { signal: 0, warn: 1, neutral: 2 } as const;
  risks.sort((a, b) => sevRank[a.severity] - sevRank[b.severity]);

  /* ---- last meeting's actions ---- */
  const prev = input.previous ?? null;
  const actions: AgendaAction[] = prev
    ? prev.items.filter((i) => i.kind === "action").slice(0, 40)
      .map((i) => ({ itemId: i.id, body: clip(i.body, 400), ownerId: i.ownerId, taskId: i.taskId, due: i.due }))
    : [];
  const taskById = new Map(input.tasks.map((t) => [t.id, t]));
  let actionsDone = 0, actionsOverdue = 0;
  for (const a of actions) {
    const s = actionState(a, a.taskId ? taskById.get(a.taskId) : undefined, todayISO).state;
    if (s === "done") actionsDone++;
    if (s === "overdue") actionsOverdue++;
  }

  const goalsBehind = goals.filter((g) => !g.parentName).length;
  const keyResultsBehind = goals.filter((g) => g.parentName).length;
  return {
    people, risks: risks.slice(0, PER_SECTION), goals: goals.slice(0, PER_SECTION), projects: projects.slice(0, PER_SECTION), actions,
    from: prev ? { id: prev.meeting.id, title: prev.meeting.title, endedAt: prev.meeting.endedAt } : null,
    pulse, offToday, actionsDone, actionsOverdue, goalsBehind, keyResultsBehind,
    counts: { people: people.length, risks: risks.length, goals: goals.length, projects: projects.length, actions: actions.length },
  };
}

/** Kanbo's read, the agenda's first item: the team's lede (when it goes round the team), who's off, then
 *  one sentence over the sections that are on. */
export function overviewLede(f: AgendaFacts, sections: readonly MeetingSection[]): SentencePart[] {
  const on = new Set(sections);
  const parts: SentencePart[] = [];
  const t = (text: string, strong?: boolean) => parts.push(strong ? { text, strong } : { text });
  if (on.has("people") && f.pulse?.length) {
    f.pulse.forEach((p) => parts.push({ ...p }));
    if (f.offToday.length) t(` ${listWords(f.offToday)} ${f.offToday.length === 1 ? "is" : "are"} off today.`);
  }
  const clauses: SentencePart[][] = [];
  if (on.has("goals")) {
    const n = (f.goalsBehind ?? f.counts.goals) + (f.keyResultsBehind ?? 0);
    clauses.push(n === 0 ? [{ text: "every goal is on pace" }]
      : [{ text: goalsWords({ goalsBehind: f.goalsBehind ?? f.counts.goals, keyResultsBehind: f.keyResultsBehind ?? 0 }), strong: true }, { text: n === 1 ? " is behind pace" : " are behind pace" }]);
  }
  if (on.has("projects")) clauses.push(f.counts.projects === 0 ? [{ text: "no project needs a look" }]
    : [{ text: plural(f.counts.projects, "project"), strong: true }, { text: f.counts.projects === 1 ? " needs a look" : " need a look" }]);
  if (on.has("risks")) clauses.push(f.counts.risks === 0 ? [{ text: "Radar is clear" }]
    : [{ text: "Radar has " }, { text: plural(f.counts.risks, "risk"), strong: true }]);
  if (clauses.length) {
    if (parts.length) t(" ");
    clauses.forEach((c, i) => {
      if (i > 0) t(i === clauses.length - 1 ? " and " : ", ");
      c.forEach((p, j) => parts.push(i === 0 && j === 0 ? { ...p, text: p.text.charAt(0).toUpperCase() + p.text.slice(1) } : { ...p }));
    });
    t(".");
  }
  if (on.has("actions") && f.from) {
    if (parts.length) t(" ");
    if (!f.counts.actions) t("Last meeting left no actions.");
    else {
      t("Last meeting left ");
      t(plural(f.counts.actions, "action"), true);
      const bits = [f.actionsDone ? `${f.actionsDone} done` : "", f.actionsOverdue ? `${f.actionsOverdue} overdue` : ""].filter(Boolean);
      t(bits.length ? `: ${bits.join(", ")}.` : ".");
    }
  }
  if (!parts.length) t("Nothing on the agenda yet: add notes as you go.");
  return parts;
}

/** The agenda: Kanbo's read, the chosen sections in their one order (each person their own item; the rest one
 *  item each, left out when there's nothing in it), then the wrap-up. */
export function assembleAgenda(f: AgendaFacts, sections: readonly MeetingSection[]): AgendaItem[] {
  const on = new Set(sections);
  const out: AgendaItem[] = [{ key: "overview", kind: "overview", title: "Where things stand", lede: overviewLede(f, sections) }];
  for (const s of SECTION_ORDER) {
    if (!on.has(s)) continue;
    if (s === "people") out.push(...f.people);
    if (s === "risks" && f.risks.length) out.push({ key: "risks", kind: "risks", title: SECTION_LABEL.risks, risks: f.risks });
    if (s === "goals" && f.goals.length) out.push({ key: "goals", kind: "goals", title: SECTION_LABEL.goals, goals: f.goals });
    if (s === "projects" && f.projects.length) out.push({ key: "projects", kind: "projects", title: SECTION_LABEL.projects, projects: f.projects });
    if (s === "actions" && f.from) out.push({ key: "actions", kind: "actions", title: SECTION_LABEL.actions, from: f.from, actions: f.actions });
  }
  out.push({ key: "wrap", kind: "wrap", title: "Wrap up" });
  return out;
}

/** Which section an agenda item belongs to (null: the overview and the wrap-up). */
export function sectionOf(item: Pick<AgendaItem, "kind">): MeetingSection | null {
  switch (item.kind) {
    case "person": return "people";
    case "risks": return "risks";
    case "goals": return "goals";
    case "projects": return "projects";
    case "actions": return "actions";
    default: return null;
  }
}

/* ---------- an action's state, read live ---------- */

export type ActionState = "done" | "open" | "overdue" | "blocked" | "gone" | "untracked";

/** Where last meeting's action stands now, from its task as you can see it. */
export function actionState(a: Pick<AgendaAction, "taskId" | "due">, task: Task | undefined, todayISO: string): { state: ActionState; label: string } {
  if (!a.taskId) {
    if (a.due && a.due < todayISO) return { state: "overdue", label: `Not a task yet · was due ${dayLabel(a.due)}` };
    return { state: "untracked", label: "Not a task yet" };
  }
  if (!task || task.archivedAt) return { state: "gone", label: "Task no longer here" };
  if (task.status === "done") return { state: "done", label: "Done" };
  if (task.status === "blocked") return { state: "blocked", label: "Blocked" };
  const due = task.dueDate ?? a.due ?? null;
  if (due && due < todayISO) return { state: "overdue", label: `Overdue · due ${dayLabel(due)}` };
  if (due === todayISO) return { state: "open", label: "Due today" };
  return { state: "open", label: due ? `Open · due ${dayLabel(due)}` : task.status === "progress" ? "In progress" : "Open" };
}

/** "6 Nov" */
export function dayLabel(iso: string): string {
  const d = localDay(iso);
  return d ? fmtDayMonth(d) : iso;
}

/** "2 decisions · 3 actions" (or "No decisions or actions") */
export function itemsLine(decisions: number, actions: number): string {
  if (!decisions && !actions) return "No decisions or actions";
  return [decisions ? plural(decisions, "decision") : "", actions ? plural(actions, "action") : ""].filter(Boolean).join(" · ");
}

/* ---------- who a meeting is for ---------- */

const roleAt = (members: readonly WorkspaceMember[], workspaces: readonly Pick<Workspace, "id" | "ownerId">[], user: string, ws: string): Role | null =>
  members.find((m) => m.workspaceId === ws && m.userId === user && m.status === "active")?.role
    ?? (workspaces.find((w) => w.id === ws)?.ownerId === user ? "owner" : null);

/** May this person run (and so read) a meeting of this kind here? A team meeting: the host's owners, admins and
 *  members. A leadership meeting: owners and admins of every business it covers. (The database's rule, 0056.) */
export function mayRun(preset: MeetingPreset, hostId: string, workspaceIds: readonly string[], user: string,
  members: readonly WorkspaceMember[], workspaces: readonly Pick<Workspace, "id" | "ownerId">[]): boolean {
  if (preset === "team") return ["owner", "admin", "member"].includes(roleAt(members, workspaces, user, hostId) ?? "");
  const wss = workspaceIds.length ? workspaceIds : [hostId];
  return wss.includes(hostId) && wss.every((ws) => ["owner", "admin"].includes(roleAt(members, workspaces, user, ws) ?? ""));
}

/** Everyone who may come: the people mayRun says yes to, by name (you first). */
export function meetingPeople(preset: MeetingPreset, hostId: string, workspaceIds: readonly string[], me: string,
  members: readonly WorkspaceMember[], workspaces: readonly Pick<Workspace, "id" | "ownerId">[]): { id: string; name: string }[] {
  const ids = new Set<string>();
  for (const m of members) if (m.workspaceId === hostId && m.status === "active" && m.userId) ids.add(m.userId);
  const owner = workspaces.find((w) => w.id === hostId)?.ownerId;
  if (owner) ids.add(owner);
  ids.add(me);
  const nameOf = (id: string) => getMember(id)?.name?.trim() || members.find((m) => m.userId === id)?.name?.trim() || members.find((m) => m.userId === id)?.email || "Someone";
  return [...ids].filter((id) => mayRun(preset, hostId, workspaceIds, id, members, workspaces))
    .map((id) => ({ id, name: nameOf(id) }))
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name, "en-GB"));
}
