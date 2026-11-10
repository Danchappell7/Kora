/* lib/meetings: the agenda Kanbo builds for a meeting (0056), one engine for team and leadership meetings.
   It reads only what it's handed (what the person starting it can see), never carries a leadership-only
   goal into a team meeting, nor anyone's reason for being off; and who may run, read and attend one. */
import { describe, expect, it } from "vitest";
import type { Goal, Project, StatusUpdate, Task, Workspace, WorkspaceMember } from "../../data/types";
import {
  actionState, agendaFacts, assembleAgenda, forAudience, goalsWords, itemsLine, mayRun, meetingPeople, meetingTitle, overviewLede, PRESETS, sectionOf, type AgendaInput,
} from "./agenda";
import { parseAgenda, type MeetingItem } from "./types";
import { parseActivityMeta } from "../activityMeta";
import { activityWorkspace } from "../businesses";

const TODAY = new Date(2026, 10, 10);     // Tuesday 10 Nov 2026
const ws = (id: string, name: string, ownerId?: string): Workspace => ({ id, name, kind: "team", ...(ownerId ? { ownerId } : {}) });
const WS = [ws("w-a", "Alpha Studio", "me"), ws("w-b", "Beta Padel", "bo")];
const mem = (workspaceId: string, userId: string, role: WorkspaceMember["role"], name = userId): WorkspaceMember =>
  ({ id: `${workspaceId}-${userId}`, workspaceId, userId, email: `${userId}@x.io`, name, role, status: "active" });
const MEMBERS = [
  mem("w-a", "me", "owner", "Dee Owner"), mem("w-a", "ann", "admin", "Ann Admin"), mem("w-a", "max", "member", "Max Member"), mem("w-a", "gus", "guest", "Gus Guest"),
  mem("w-b", "bo", "owner", "Bo Boss"), mem("w-b", "me", "admin", "Dee Owner"), mem("w-b", "ann", "member", "Ann Admin"),
];
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, status: "todo", priority: "medium", projectId: "pa", workspaceId: "w-a", assigneeId: "me", dependencies: [], subtasks: [], tags: [], comments: 0,
  createdAt: "2026-11-01T09:00:00Z", ...o,
} as Task);
const proj = (id: string, workspaceId: string, o: Partial<Project> = {}): Project => ({ id, name: `Project ${id}`, color: "", workspaceId, ...o } as Project);
const goal = (o: Partial<Goal> & { id: string }): Goal => ({ name: o.id, status: "on_track", workspaceId: "w-a", ...o } as Goal);

const TASKS = [
  task({ id: "done-max", assigneeId: "max", status: "done", completedAt: "2026-11-09" }),
  task({ id: "blocked-max", assigneeId: "max", status: "blocked", dependencies: ["prog-ann"] }),
  task({ id: "prog-ann", assigneeId: "ann", status: "progress", title: "Draft the brief" }),
  task({ id: "late-me", assigneeId: "me", dueDate: "2026-11-02", title: "Send the invoices" }),
  task({ id: "guest-work", assigneeId: "gus", status: "progress" }),
  task({ id: "b1", workspaceId: "w-b", projectId: "pb", assigneeId: "bo", dueDate: "2026-11-01" }),
  task({ id: "b2", workspaceId: "w-b", projectId: "pb", assigneeId: "bo", dueDate: "2026-11-03" }),
  task({ id: "b3", workspaceId: "w-b", projectId: "pb", assigneeId: "bo", dueDate: "2026-11-04" }),
];
const GOALS = [
  goal({ id: "g-team", name: "Grow members", status: "at_risk" }),
  goal({ id: "g-lead", name: "Raise the round", status: "off_track", visibility: "leadership" }),
  goal({ id: "g-b", name: "Fill the courts", status: "off_track", workspaceId: "w-b" }),
];
const UPDATES: StatusUpdate[] = [];
const input = (o: Partial<AgendaInput> = {}): AgendaInput => ({
  preset: "team", workspaces: [WS[0]], hostId: "w-a", members: MEMBERS, me: "me", tasks: TASKS, projects: [proj("pa", "w-a"), proj("pb", "w-b")],
  goals: GOALS, statusUpdates: UPDATES, today: TODAY, capacitiesFor: () => ({}),
  offNote: (u) => (u === "ann" ? { label: "Off today", now: true } : null), ...o,
});
const item = (o: Partial<MeetingItem> & { id: string; kind: MeetingItem["kind"] }): MeetingItem => ({
  meetingId: "m0", body: o.id, agendaKey: null, ownerId: null, due: null, taskId: null, createdBy: "me", createdAt: "2026-11-03T10:00:00Z", ...o,
});

describe("the agenda", () => {
  it("a team meeting goes round the team (never its guests), with who's off at the end", () => {
    const f = agendaFacts(input());
    const ids = f.people.map((p) => p.personId);
    expect([...ids].sort()).toEqual(["ann", "max", "me"]);
    expect(ids[ids.length - 1]).toBe("ann");
    const max = f.people.find((p) => p.personId === "max")!;
    expect(max.done.map((t) => t.taskId)).toEqual(["done-max"]);
    expect(max.blocked).toEqual([expect.objectContaining({ taskId: "blocked-max", note: "Waiting on Ann", tone: "signal" })]);
    expect(f.people.find((p) => p.personId === "me")!.today).toEqual([expect.objectContaining({ taskId: "late-me", note: "Overdue · due 2 Nov", tone: "signal" })]);
    expect(f.people[2]).toMatchObject({ off: "Off today", offNow: true });
    expect(f.offToday).toEqual(["Ann"]);
    expect(JSON.stringify(f)).not.toContain("gus");
  });
  it("says whose work is waiting on someone's, and how much of theirs falls due while they're away", () => {
    const f = agendaFacts(input({ tasks: [...TASKS, task({ id: "ann-due", assigneeId: "ann", dueDate: "2026-11-12" }), task({ id: "ann-later", assigneeId: "ann", dueDate: "2026-11-20" })],
      offNote: (u) => (u === "ann" ? { label: "Off until Mon", now: true, from: "2026-11-09", to: "2026-11-13" } : null) }));
    const ann = f.people.find((p) => p.personId === "ann")!;
    expect(ann.offDue).toBe(1);
    expect(ann.holding).toEqual([{ taskId: "blocked-max", title: "blocked-max", whoId: "max" }]);
    expect(f.people.find((p) => p.personId === "max")!.holding).toBeUndefined();
  });
  it("counts goals the way Pulse and Goals do: a goal's key results that are behind sit inside it", () => {
    const goals = [goal({ id: "g-grow", name: "Grow weekly actives", status: "at_risk" }), goal({ id: "kr-1", name: "Lift activation", status: "at_risk", parentId: "g-grow" }),
      goal({ id: "kr-2", name: "Win back accounts", status: "off_track", parentId: "g-grow" }), goal({ id: "g-ship", name: "Ship v2", status: "on_track" }),
      goal({ id: "kr-3", name: "Beta to 50 teams", status: "off_track", parentId: "g-ship" })];
    const f = agendaFacts(input({ goals }));
    expect(f.goals.map((g) => [g.id, g.krs?.map((k) => k.id) ?? [], g.parentName ?? null])).toEqual([
      ["kr-3", [], "Ship v2"], ["g-grow", ["kr-2", "kr-1"], null],
    ]);
    expect([f.goalsBehind, f.keyResultsBehind]).toEqual([1, 1]);
    expect(overviewLede(f, ["goals"]).map((p) => p.text).join("")).toBe("1 goal and 1 key result are behind pace.");
    expect(goalsWords(f)).toBe("1 goal and 1 key result");
    // and the stored agenda keeps them
    const stored = parseAgenda(JSON.parse(JSON.stringify(assembleAgenda(f, ["goals"]))));
    expect(stored.find((x) => x.kind === "goals")).toMatchObject({ goals: [{ id: "kr-3", parentName: "Ship v2" }, { id: "g-grow", krs: [{ id: "kr-2" }, { id: "kr-1" }] }] });
  });
  it("a team meeting never carries a leadership-only goal; a leadership one does", () => {
    expect(agendaFacts(input()).goals.map((g) => g.id)).toEqual(["g-team"]);
    expect(agendaFacts(input({ preset: "leadership" })).goals.map((g) => g.id).sort()).toEqual(["g-lead", "g-team"]);
  });
  it("nor anything under one: its key results (marked 'everyone', as they're made) and theirs stay out of a team meeting", () => {
    // a leadership-only objective that's on track, a key result under it at risk, and one two levels down overdue
    const goals = [
      goal({ id: "g-team", name: "Grow members", status: "at_risk" }),
      goal({ id: "g-sell", name: "Sell the company to Acme", status: "on_track", visibility: "leadership" }),
      goal({ id: "kr-term", name: "Close Acme term sheet by Dec", status: "off_track", parentId: "g-sell", visibility: "everyone", ownerId: "me" }),
      goal({ id: "kr-mid", name: "Mid KR fine", status: "on_track", parentId: "g-sell" }),
      goal({ id: "kr-deep", name: "Data room ready", status: "at_risk", parentId: "kr-mid", due: "2026-11-01" }),
      // (a key result whose goal the starter can't read: not the team's either)
      goal({ id: "kr-orphan", name: "Under a goal nobody here loaded", status: "off_track", parentId: "g-unseen" }),
    ];
    const team = agendaFacts(input({ goals }));
    expect(team.goals.map((g) => g.id)).toEqual(["g-team"]);
    const stored = JSON.stringify(assembleAgenda(team, ["goals"]));
    for (const secret of ["Sell the company", "Close Acme term sheet", "Mid KR fine", "Data room ready", "Under a goal nobody"]) expect(stored).not.toContain(secret);
    // a leadership meeting has them
    const lead = agendaFacts(input({ preset: "leadership", goals }));
    expect(JSON.stringify(lead.goals)).toContain("Close Acme term sheet");
  });
  it("a Group meeting covers each business it's for (not the others), each row marked with its business", () => {
    const f = agendaFacts(input({ preset: "leadership", workspaces: WS }));
    expect(f.people).toEqual([]);   // one business at a time
    expect(f.goals.map((g) => [g.id, g.workspaceId])).toEqual(expect.arrayContaining([["g-team", "w-a"], ["g-b", "w-b"], ["g-lead", "w-a"]]));
    expect(f.projects.map((p) => [p.id, p.workspaceId])).toEqual([["pa", "w-a"], ["pb", "w-b"]]);
    expect(f.risks.every((r) => r.workspaceId === "w-a" || r.workspaceId === "w-b")).toBe(true);
    expect(agendaFacts(input()).projects.map((p) => p.id)).toEqual(["pa"]);   // a meeting at Alpha never reads Beta's
  });
  it("last meeting's actions, with where each stands now", () => {
    const previous = { meeting: { id: "m0", title: "Alpha team meeting, Tue 3 Nov", endedAt: "2026-11-03T10:30:00Z" }, items: [
      item({ id: "a1", kind: "action", taskId: "done-max" }), item({ id: "a2", kind: "action", taskId: "late-me" }), item({ id: "a3", kind: "action", due: "2026-11-20" }),
      item({ id: "d1", kind: "decision" }),
    ] };
    const f = agendaFacts(input({ previous }));
    expect(f.actions.map((a) => a.itemId)).toEqual(["a1", "a2", "a3"]);
    expect([f.actionsDone, f.actionsOverdue]).toEqual([1, 1]);
    expect(f.from).toEqual({ id: "m0", title: "Alpha team meeting, Tue 3 Nov", endedAt: "2026-11-03T10:30:00Z" });
  });
  it("is built in the one order, empty sections left out, Kanbo's read first and the wrap-up last", () => {
    const f = agendaFacts(input({ previous: { meeting: { id: "m0", title: "Last", endedAt: null }, items: [] } }));
    const a = assembleAgenda(f, PRESETS.team.sections);
    expect(a.map((x) => x.kind)).toEqual(["overview", "person", "person", "person", "risks", "goals", "actions", "wrap"]);
    expect(a.map(sectionOf)).toEqual([null, "people", "people", "people", "risks", "goals", "actions", null]);
    expect(new Set(a.map((x) => x.key)).size).toBe(a.length);
    // switched off, or nothing in it: not on the agenda
    expect(assembleAgenda(agendaFacts(input()), ["actions"]).map((x) => x.kind)).toEqual(["overview", "wrap"]);
    expect(assembleAgenda(f, ["projects"]).map((x) => x.kind)).toEqual(["overview", "projects", "wrap"]);
  });
  it("Kanbo's read says it in a sentence or two", () => {
    const f = agendaFacts(input());
    const text = (s: Parameters<typeof overviewLede>[1]) => overviewLede(f, s).map((p) => p.text).join("");
    expect(text(["people", "goals", "risks"])).toMatch(/^Since yesterday the team finished 1 task\. .* Ann is off today\. 1 goal is behind pace and Radar has \d+ risks?\.$/);
    expect(text(["goals", "projects"])).toBe("1 goal is behind pace and 1 project needs a look.");
    expect(overviewLede(agendaFacts(input({ tasks: [], goals: [] })), ["goals", "projects", "risks"]).map((p) => p.text).join(""))
      .toBe("Every goal is on pace, no project needs a look and Radar is clear.");
    expect(text([])).toBe("Nothing on the agenda yet: add notes as you go.");
    expect(overviewLede(f, ["goals"]).find((p) => p.strong)?.text).toBe("1 goal");
  });
  it("names the meeting", () => {
    expect(meetingTitle("team", [WS[0]], TODAY)).toBe("Alpha Studio team meeting, Tue 10 Nov");
    expect(meetingTitle("leadership", [WS[0]], TODAY)).toBe("Alpha Studio leadership, Tue 10 Nov");
    expect(meetingTitle("leadership", WS, TODAY)).toBe("Group leadership, Tue 10 Nov");
    expect(itemsLine(2, 1)).toBe("2 decisions · 1 action");
    expect(itemsLine(0, 0)).toBe("No decisions or actions");
  });
});

describe("an action's state, read live", () => {
  const today = "2026-11-10";
  it("from its task as you can see it", () => {
    expect(actionState({ taskId: "t" }, task({ id: "t", status: "done" }), today)).toEqual({ state: "done", label: "Done" });
    expect(actionState({ taskId: "t" }, task({ id: "t", status: "blocked" }), today).state).toBe("blocked");
    expect(actionState({ taskId: "t" }, task({ id: "t", dueDate: "2026-11-06" }), today)).toEqual({ state: "overdue", label: "Overdue · due 6 Nov" });
    expect(actionState({ taskId: "t" }, task({ id: "t", dueDate: today }), today).label).toBe("Due today");
    expect(actionState({ taskId: "t" }, task({ id: "t", dueDate: "2026-11-16" }), today).label).toBe("Open · due 16 Nov");
    expect(actionState({ taskId: "t" }, undefined, today).state).toBe("gone");
    expect(actionState({ taskId: "t" }, task({ id: "t", archivedAt: "2026-11-01" }), today).state).toBe("gone");
  });
  it("one that never became a task says so (and is overdue past its day)", () => {
    expect(actionState({ taskId: null }, undefined, today)).toEqual({ state: "untracked", label: "Not a task yet" });
    expect(actionState({ taskId: null, due: "2026-11-08" }, undefined, today)).toEqual({ state: "overdue", label: "Not a task yet · was due 8 Nov" });
  });
});

describe("who a meeting is for (the database's rule)", () => {
  it("a team meeting: the host's owners, admins and members; never a guest or an outsider", () => {
    expect(["me", "ann", "max"].every((u) => mayRun("team", "w-a", ["w-a"], u, MEMBERS, WS))).toBe(true);
    expect(mayRun("team", "w-a", ["w-a"], "gus", MEMBERS, WS)).toBe(false);
    expect(mayRun("team", "w-a", ["w-a"], "bo", MEMBERS, WS)).toBe(false);
    expect(meetingPeople("team", "w-a", ["w-a"], "me", MEMBERS, WS).map((p) => p.id)).toEqual(["me", "ann", "max"]);
  });
  it("a leadership meeting: owners and admins; a Group one, those who lead every business in it", () => {
    expect(meetingPeople("leadership", "w-a", ["w-a"], "me", MEMBERS, WS).map((p) => p.id)).toEqual(["me", "ann"]);
    expect(mayRun("leadership", "w-a", ["w-a"], "max", MEMBERS, WS)).toBe(false);
    expect(mayRun("leadership", "w-a", ["w-a", "w-b"], "me", MEMBERS, WS)).toBe(true);
    expect(mayRun("leadership", "w-a", ["w-a", "w-b"], "ann", MEMBERS, WS)).toBe(false);   // a member at Beta
    expect(mayRun("leadership", "w-a", ["w-a", "w-b"], "bo", MEMBERS, WS)).toBe(false);    // not in Alpha
    expect(meetingPeople("leadership", "w-a", ["w-a", "w-b"], "me", MEMBERS, WS).map((p) => p.id)).toEqual(["me"]);
    // the host must be one of them
    expect(mayRun("leadership", "w-a", ["w-b"], "me", MEMBERS, WS)).toBe(false);
  });
});

describe("what another browser stored", () => {
  it("keeps the items Kanbo would have written, drops the rest, keys once", () => {
    const got = parseAgenda([
      { key: "overview", kind: "overview", title: "Where things stand", lede: [{ text: "Hi", strong: true }, { nope: 1 }] },
      { key: "person:x", kind: "person", title: "Max", personId: "x", done: [{ taskId: "t1", title: "One", status: "done" }, { title: "no id" }], today: "bad", blocked: [], more: { done: 2 } },
      { key: "person:x", kind: "person", title: "Again", personId: "x" },
      { key: "risks", kind: "risks", risks: [{ id: "r", title: "Risky", severity: "loud" }] },
      { kind: "script", title: "<img>" },
      "nonsense", null,
      { key: "wrap", kind: "wrap" },
    ]);
    expect(got.map((a) => a.key)).toEqual(["overview", "person:x", "risks", "wrap"]);
    expect(got[0]).toMatchObject({ lede: [{ text: "Hi", strong: true }] });
    expect(got[1]).toMatchObject({ done: [{ taskId: "t1", title: "One", status: "done" }], today: [], more: { done: 2, today: 0, blocked: 0 } });
    expect(got[2]).toMatchObject({ title: "Radar risks", risks: [{ id: "r", severity: "neutral", taskIds: [] }] });
    expect(parseAgenda({ not: "a list" })).toEqual([]);
  });
});

describe("the recap in the Inbox (activity kind 'meeting')", () => {
  it("reads its meta, and belongs to its business", () => {
    const meta = parseActivityMeta({ meeting_id: "m1", workspace_id: "w-a", preset: "leadership", decisions: 2, actions: 3, doc_id: "d1", project_id: "pa" });
    expect(meta).toEqual({ meetingId: "m1", workspaceId: "w-a", meetingPreset: "leadership", decisions: 2, actions: 3, docId: "d1", projectId: "pa" });
    expect(parseActivityMeta({ meeting_id: "m1", preset: "board", decisions: -1 })).toEqual({ meetingId: "m1" });
    expect(activityWorkspace({ id: "a", taskId: null, taskTitle: "x", kind: "meeting", detail: "", createdAt: "", meta: { meetingId: "m1", workspaceId: "w-b" } }, new Map(), [])).toBe("w-b");
  });
});

describe("project access (0058, D17): an agenda carries only what everyone it's for can see", () => {
  const on = { on: true, defaultVisibility: "workspace" as const, membersMayMakePrivate: false };
  const gated = [{ ...WS[0], projectAccess: on }, WS[1]];
  const projects = [proj("pa", "w-a"), proj("pm", "w-a", { visibility: "members" }), proj("pp", "w-a", { visibility: "private" }), proj("pb", "w-b")];
  const secret = [
    task({ id: "m-task", projectId: "pm", assigneeId: "max", status: "blocked", title: "Board pack" }),
    task({ id: "p-task", projectId: "pp", assigneeId: "max", status: "done", completedAt: "2026-11-09", title: "Theo's contract" }),
  ];
  const ids = (f: ReturnType<typeof agendaFacts>) => f.people.flatMap((p) => [...p.done, ...p.today, ...p.blocked].map((e) => e.taskId));
  it("a team meeting leaves out Members only and Private work; a leadership one keeps Members only", () => {
    const team = agendaFacts(input({ workspaces: [gated[0]], tasks: [...TASKS, ...secret], projects }));
    expect(ids(team)).not.toContain("m-task");
    expect(ids(team)).not.toContain("p-task");
    expect(ids(team)).toContain("done-max");
    const lead = agendaFacts(input({ preset: "leadership", workspaces: [gated[0]], tasks: [...TASKS, ...secret], projects }));
    expect(lead.risks.flatMap((r) => r.taskIds)).not.toContain("p-task");
    const scoped = forAudience(input({ preset: "leadership", workspaces: [gated[0]], tasks: [...TASKS, ...secret], projects }));
    expect(scoped.tasks.map((t) => t.id)).toContain("m-task");
    expect(scoped.tasks.map((t) => t.id)).not.toContain("p-task");
    expect(scoped.projects.map((p) => p.id)).toEqual(["pa", "pm", "pb"]);
  });
  it("a goal whose % comes from a Members only project stays off a team meeting's agenda (never 'Past due at 0%')", () => {
    const seedTasks = [1, 2, 3, 4].map((i) => task({ id: `s${i}`, projectId: "pm", status: i < 4 ? "done" : "todo" }));
    const g = goal({ id: "g-seed", name: "Close the seed round", projectId: "pm", due: "2026-11-01" });
    const team = agendaFacts(input({ workspaces: [gated[0]], tasks: [...TASKS, ...seedTasks], goalTasks: [...TASKS, ...seedTasks], projects, goals: [g] }));
    expect(team.goals.map((x) => x.id)).toEqual([]);
    expect(team.goalsBehind).toBe(0);
    const lead = agendaFacts(input({ preset: "leadership", workspaces: [gated[0]], tasks: [...TASKS, ...seedTasks], goalTasks: [...TASKS, ...seedTasks], projects, goals: [g] }));
    expect(lead.goals.map((x) => [x.id, x.pct, x.line])).toEqual([["g-seed", 75, "Past due at 75%"]]);
  });
  it("with project access off, nothing is left out", () => {
    const all = input({ tasks: [...TASKS, ...secret], projects });
    expect(forAudience(all)).toBe(all);
    expect(ids(agendaFacts(all))).toContain("p-task");
  });
});
