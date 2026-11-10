/* lib/rollout (0057): Workspace health, Kanbo noticed's one next fix, "Welcome to <workspace>", the
   first run's pilot emails; and lib/rolloutPlan, the rollout plan as stored. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Goal, GoalCheckin, Project, StatusUpdate, Task, Workspace, WorkspaceMember } from "../data/types";
import {
  CHECKIN_DAYS, daysSince, healthNudge, lastActiveWords, namesLine, parseActivity, pilotEmails, shouldWelcome, welcomeContent, welcomedNow,
  workspaceHealth, type HealthInput, type WorkspaceActivity,
} from "./rollout";
import { parseRollout, rolloutRow } from "./rolloutPlan";

const TODAY = new Date(2026, 10, 10, 9, 0);   // Tue 10 Nov 2026
beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(TODAY); });
afterEach(() => { vi.useRealTimers(); });

const daysAgo = (n: number) => new Date(TODAY.getTime() - n * 86_400_000).toISOString();
const member = (id: string, role: WorkspaceMember["role"], extra: Partial<WorkspaceMember> = {}): WorkspaceMember =>
  ({ id: `wm-${id}`, workspaceId: "ws", userId: id, email: `${id}@acme.co`, name: id.charAt(0).toUpperCase() + id.slice(1), role, status: "active", ...extra });
const invitee = (email: string, extra: Partial<WorkspaceMember> = {}): WorkspaceMember =>
  ({ id: `inv-${email}`, workspaceId: "ws", userId: null, email, name: "", role: "member", status: "invited", ...extra });
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: `Task ${id}`, status: "todo", priority: "medium", projectId: "p1", assigneeId: "maya", dueDate: "2026-11-20", tags: [], focusMin: 30,
  comments: 0, aiScore: 0, subtasks: [], dependencies: [], workspaceId: "ws", ...extra,
} as unknown as Task);
const project = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: `Project ${id}`, emoji: "📁", color: "#36f", workspaceId: "ws", ownerId: "dan", ...extra });
const ws: Workspace = { id: "ws", name: "Acme", kind: "team", ownerId: "dan" };

const base = (extra: Partial<HealthInput> = {}): HealthInput => ({
  workspaceId: "ws",
  members: [member("dan", "owner"), member("maya", "member"), member("theo", "member"), member("sana", "admin")],
  tasks: [task("t1"), task("t2", { createdAt: daysAgo(3) })],
  projects: [project("p1")],
  statusUpdates: [{ id: "u1", projectId: "p1", summary: "Fine", status: "on_track", createdAt: daysAgo(2), workspaceId: "ws" } as StatusUpdate],
  workspaces: [ws],
  today: TODAY,
  ...extra,
});

describe("active in the last 7 days: days only", () => {
  it("parses workspace_activity, keeping days and never a time", () => {
    const a = parseActivity({
      today: "2026-11-10",
      members: [{ user_id: "maya", days: 3, last_day: "2026-11-09T23:59:00Z" }, { user_id: "theo", days: 12, last_day: null }, { bogus: 1 }],
      days: [{ day: "2026-11-04", people: 2 }, { day: "nope", people: 1 }],
    });
    expect(a).toEqual({ today: "2026-11-10", members: [{ userId: "maya", days: 3, lastDay: "2026-11-09" }, { userId: "theo", days: 7, lastDay: null }], days: [{ day: "2026-11-04", people: 2 }] });
    expect(parseActivity(null)).toBeNull();
    expect(parseActivity({ members: [] })).toBeNull();
  });
  it("says when roughly, never exactly", () => {
    expect(["2026-11-10", "2026-11-09", "2026-11-06", "2026-11-01", "2026-10-20"].map((d) => lastActiveWords(d, "2026-11-10")))
      .toEqual(["Today", "Yesterday", "4 days ago", "Over a week ago", "Over two weeks ago"]);
    expect(lastActiveWords(null, "2026-11-10")).toBe("Not in the last month");
  });
});

describe("Workspace health", () => {
  it("all well: no invites waiting, every task owned and dated, updates in, nothing to look at", () => {
    const h = workspaceHealth(base());
    expect(h.invited).toEqual([]);
    expect(h.loose.tasks).toEqual([]);
    expect(h.missing).toEqual([]);
    expect(h.quietGoals).toBeNull();   // goals 2.0 not in: no check-in line
    expect(h.active).toBeNull();       // activity not loaded
    expect(h.issues).toBe(0);
    expect(healthNudge(h, { workspaceId: "ws", workspaceName: "Acme", memberName: (m) => m.name, today: TODAY, asks: true })).toBeNull();
  });
  it("finds who hasn't joined, loose work, missing updates and quiet goals", () => {
    const activity: WorkspaceActivity = {
      today: "2026-11-10",
      members: [{ userId: "dan", days: 5, lastDay: "2026-11-10" }, { userId: "maya", days: 2, lastDay: "2026-11-08" }, { userId: "theo", days: 0, lastDay: "2026-10-30" },
        { userId: "sana", days: 0, lastDay: null }],
      days: [{ day: "2026-11-10", people: 1 }],
    };
    const goals = [
      { id: "g1", name: "Revenue to £2m", status: "on_track", workspaceId: "ws", createdAt: daysAgo(40) },
      { id: "g2", name: "Hire two", status: "on_track", workspaceId: "ws", createdAt: daysAgo(40) },
      { id: "g3", name: "Done one", status: "done", workspaceId: "ws", createdAt: daysAgo(40) },
      { id: "g4", name: "New one", status: "on_track", workspaceId: "ws", createdAt: daysAgo(3) },
      { id: "g5", name: "Elsewhere", status: "on_track", workspaceId: "other", createdAt: daysAgo(40) },
      { id: "g6", name: "Moved by work", status: "on_track", workspaceId: "ws", createdAt: daysAgo(40) },
    ] as Goal[];
    const checkins = [{ id: "c1", goalId: "g2", authorId: "dan", value: 1, createdAt: daysAgo(CHECKIN_DAYS - 1) }] as GoalCheckin[];
    const h = workspaceHealth(base({
      members: [...base().members, invitee("jo@acme.co"), invitee("ali@acme.co"), { ...invitee("x@other.co"), workspaceId: "other" }],
      tasks: [task("t1"), task("t2", { assigneeId: "" }), task("t3", { dueDate: undefined }), task("t4", { assigneeId: "", status: "done" }),
        task("t5", { assigneeId: "", parentId: "t1" }), task("t6", { assigneeId: "", workspaceId: "other" }), task("t7", { assigneeId: "", archivedAt: daysAgo(1) })],
      projects: [project("p1"), project("p2", { name: "Fit-out" }), project("p3", { name: "Paused", status: "on_hold" }), project("p4", { name: "Gone", archivedAt: daysAgo(2) })],
      statusUpdates: [{ id: "u1", projectId: "p1", summary: "Fine", status: "on_track", createdAt: daysAgo(2), workspaceId: "ws" } as StatusUpdate],
      goals, checkins, takesCheckin: (g) => g.id !== "g6", activity,
    }));
    expect(h.invited.map((m) => m.email)).toEqual(["jo@acme.co", "ali@acme.co"]);
    // open, top-level, live: the unowned first
    expect(h.loose.tasks.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect([h.loose.noOwner, h.loose.noDate]).toEqual([1, 1]);
    // p1 posted lately; p2 has no work yet, so no update is owed; on hold and archived are left alone
    expect(h.missing.map((p) => p.id)).toEqual([]);
    expect(h.quietGoals!.map((g) => g.id)).toEqual(["g1"]);
    expect(h.active).toMatchObject({ count: 2, of: 4, today: "2026-11-10" });
    // the quiet: sana (no activity at all) before theo (last on 30 Oct)
    expect(h.active!.quiet.map((q) => [q.member.userId, q.lastDay])).toEqual([["sana", null], ["theo", "2026-10-30"]]);
    expect(h.issues).toBe(3);
  });
  it("a project's update is missing on its update day (0053), or after 14 days without one before it", () => {
    const old = { createdAt: daysAgo(30) };
    const stale = workspaceHealth(base({ tasks: [task("t1", { ...old, projectId: "p2" })], projects: [project("p2")], statusUpdates: [] }));
    expect(stale.missing.map((p) => p.id)).toEqual(["p2"]);
    const fresh = workspaceHealth(base({ tasks: [task("t1", { createdAt: daysAgo(2), projectId: "p2" })], projects: [project("p2")], statusUpdates: [] }));
    expect(fresh.missing).toEqual([]);
  });
});

describe("Workspace health's activity counts the people workspace_activity counts", () => {
  it("never a guest, nor someone the answer leaves out (the admin who set it up and handed it over)", () => {
    const activity: WorkspaceActivity = { today: "2026-11-10", days: [],
      members: [{ userId: "dan", days: 3, lastDay: "2026-11-10" }, { userId: "maya", days: 0, lastDay: "2026-10-30" }, { userId: "gus", days: 4, lastDay: "2026-11-10" }] };
    const h = workspaceHealth(base({ members: [member("dan", "owner"), member("maya", "member"), member("gus", "guest"), member("root", "admin")], activity }));
    expect(h.active).toMatchObject({ count: 1, of: 2 });
    expect(h.active!.quiet.map((q) => q.member.userId)).toEqual(["maya"]);
  });
});

describe("Workspace health for a workspace that's only just started", () => {
  it("only you, nothing in it yet: not started, and nothing counted as fine", () => {
    const h = workspaceHealth(base({ members: [member("dan", "owner")], tasks: [], projects: [], statusUpdates: [], goals: [], checkins: [] }));
    expect(h.solo).toBe(true);
    expect(h.counts).toEqual({ projects: 0, openTasks: 0, goals: 0, workers: 1 });
    // a pack's routines are nobody's yet: on your own there's nobody else to give them to, so no nudge about it
    const alone = workspaceHealth(base({ members: [member("dan", "owner")], tasks: [task("r1", { assigneeId: "" })] }));
    expect(alone.loose.noOwner).toBe(1);
    expect(healthNudge(alone, { workspaceId: "ws", workspaceName: "Acme", memberName: (m) => m.name, today: TODAY, asks: true })).toBeNull();
    expect(h.started).toBe(false);
  });
  it("someone invited, or a teammate, and a project: under way", () => {
    expect(workspaceHealth(base({ members: [member("dan", "owner"), invitee("sam@acme.co")] })).started).toBe(true);
    expect(workspaceHealth(base({ members: [member("dan", "owner"), member("maya", "member")], projects: [] })).started).toBe(false);
    const h = workspaceHealth(base());
    expect([h.solo, h.started]).toEqual([false, true]);
    expect(h.counts).toEqual({ projects: 1, openTasks: 2, goals: 0, workers: 4 });
  });
  it("activity keeps the workspace's first day", () => {
    expect(parseActivity({ today: "2026-11-10", since: "2026-11-08", members: [], days: [] })?.since).toBe("2026-11-08");
    const h = workspaceHealth(base({ activity: { today: "2026-11-10", since: "2026-11-08", members: [], days: [] } }));
    expect(h.active?.since).toBe("2026-11-08");
  });
});

describe("Kanbo noticed: one fix at a time", () => {
  const ctx = { workspaceId: "ws", workspaceName: "Acme", memberName: (m: WorkspaceMember) => m.name || m.email, today: TODAY, asks: true };
  it("invites that have had two days come first (named people by name; a bare address isn't a name)", () => {
    const h = workspaceHealth(base({ members: [...base().members, invitee("priya@acme.co", { name: "Priya Shah", invitedAt: daysAgo(7) }), invitee("jonas@acme.co", { name: "Jonas Berg", invitedAt: daysAgo(3) })] }));
    const n = healthNudge(h, ctx)!;
    expect(n).toMatchObject({ kind: "rollout", title: "2 people haven't joined Acme", actions: [{ kind: "fix", label: "Resend all", fix: "resend" }, { kind: "fix", label: "See health", fix: "health" }] });
    expect(n.body).toBe("Priya and Jonas were invited but haven't signed in yet. A fresh invite often does it.");
    const unnamed = healthNudge(workspaceHealth(base({ members: [...base().members, invitee("sam@acme.co", { invitedAt: daysAgo(4) })] })), ctx)!;
    expect(unnamed.title).toBe("1 person hasn't joined Acme");
    expect(unnamed.body).toBe("Someone you invited hasn't signed in yet. A fresh invite often does it.");
    expect(unnamed.actions[0]).toMatchObject({ label: "Resend invite" });
  });
  it("an invite that's only just gone out isn't nagged about: the next fix comes instead", () => {
    const h = workspaceHealth(base({ members: [...base().members, invitee("new@acme.co", { invitedAt: daysAgo(0) })], tasks: [task("t1", { assigneeId: "" }), task("t2", { assigneeId: "" })] }));
    expect(h.invited).toHaveLength(1);   // the card still lists it
    expect(healthNudge(h, ctx)).toMatchObject({ title: "2 tasks in Acme have no owner", actions: [{ fix: "assign", label: "Assign now" }] });
  });
  it("then missing updates, then undated work, then quiet goals", () => {
    const missing = workspaceHealth(base({ tasks: [task("t1", { createdAt: daysAgo(30) })], statusUpdates: [] }));
    expect(healthNudge(missing, ctx)).toMatchObject({ title: "Project p1 has no update", actions: [{ fix: "ask", label: "Ask for it" }] });
    const undated = workspaceHealth(base({ tasks: [task("t1", { dueDate: undefined })] }));
    expect(healthNudge(undated, ctx)).toMatchObject({ title: "1 task in Acme has no date", actions: [{ fix: "assign" }] });
    const goals = workspaceHealth(base({ goals: [{ id: "g1", name: "Grow", status: "on_track", workspaceId: "ws", createdAt: daysAgo(30) } as Goal], checkins: [] }));
    expect(healthNudge(goals, ctx)).toMatchObject({ title: "Grow hasn't had a check-in", actions: [{ fix: "goals" }] });
  });
  it("before asking for an update works here (0053), a missing update isn't a nudge: its only fix couldn't work", () => {
    // no update day, no updates ever, work older than 14 days: every project reads as missing
    const missing = workspaceHealth(base({ tasks: [task("t1", { createdAt: daysAgo(30) })], statusUpdates: [] }));
    expect(missing.missing).toHaveLength(1);
    expect(healthNudge(missing, { ...ctx, asks: false })).toBeNull();
    // (the next fix down still comes)
    const andUndated = workspaceHealth(base({ tasks: [task("t1", { createdAt: daysAgo(30), dueDate: undefined })], statusUpdates: [] }));
    expect(healthNudge(andUndated, { ...ctx, asks: false })).toMatchObject({ title: "1 task in Acme has no date", actions: [{ fix: "assign" }] });
  });
  it("each card's id is its kind and its workspace, never a count: Not now holds while the number moves", () => {
    const two = workspaceHealth(base({ tasks: [task("t1", { assigneeId: "" }), task("t2", { assigneeId: "" })] }));
    const one = workspaceHealth(base({ tasks: [task("t1", { assigneeId: "" }), task("t2")] }));
    expect(healthNudge(two, ctx)!.id).toBe("rollout:owner:ws");
    expect(healthNudge(one, ctx)!.id).toBe(healthNudge(two, ctx)!.id);
  });
});

describe("Welcome to <workspace>", () => {
  const input = (extra: Partial<Parameters<typeof shouldWelcome>[0]> = {}) => ({
    me: "maya", workspace: ws, membership: { role: "member" as const, status: "active" as const, joinedAt: daysAgo(3) }, today: TODAY, ...extra,
  });
  it("for someone who joined lately, once per workspace", () => {
    expect(shouldWelcome(input())).toBe(true);
    expect(shouldWelcome(input({ membership: { role: "admin", status: "active", joinedAt: daysAgo(29) } }))).toBe(true);
    expect(shouldWelcome(input({ membership: { role: "guest", status: "active", joinedAt: daysAgo(1) } }))).toBe(true);
    expect(shouldWelcome(input({ membership: { role: "member", status: "active", joinedAt: daysAgo(31) } }))).toBe(false);
    expect(shouldWelcome(input({ welcomed: { ws: daysAgo(1) } }))).toBe(false);
    expect(shouldWelcome(input({ welcomed: { other: daysAgo(1) } }))).toBe(true);
  });
  it("never for its owner, Personal, an invite or nobody", () => {
    expect(shouldWelcome(input({ membership: { role: "owner", status: "active", joinedAt: daysAgo(1) } }))).toBe(false);
    expect(shouldWelcome(input({ me: "dan" }))).toBe(false);
    expect(shouldWelcome(input({ workspace: { id: null, kind: "personal" } }))).toBe(false);
    expect(shouldWelcome(input({ membership: { role: "member", status: "invited", joinedAt: null } }))).toBe(false);
    expect(shouldWelcome(input({ membership: undefined }))).toBe(false);
  });
  it("never for whoever made the workspace, even once they've handed it over (a provisioning admin)", () => {
    const made = daysAgo(3);
    const handedOver = { ...ws, ownerId: "nina", createdAt: made };
    expect(shouldWelcome(input({ me: "dan", workspace: handedOver, membership: { role: "admin", status: "active", joinedAt: made } }))).toBe(false);
    // someone who joined later still is
    expect(shouldWelcome(input({ workspace: handedOver, membership: { role: "member", status: "active", joinedAt: daysAgo(1) } }))).toBe(true);
  });
  it("before 0057 knew when people joined: a new account; once it does, people from before aren't welcomed", () => {
    const before = { role: "member" as const, status: "active" as const };
    expect(shouldWelcome(input({ membership: before, accountCreatedAt: daysAgo(5) }))).toBe(true);
    expect(shouldWelcome(input({ membership: before, accountCreatedAt: daysAgo(40) }))).toBe(false);
    expect(shouldWelcome(input({ membership: before }))).toBe(false);
    expect(shouldWelcome(input({ membership: { ...before, joinedAt: null }, accountCreatedAt: daysAgo(2) }))).toBe(false);
  });
  it("your projects first, your people (who runs it first), the team's goal, who to ask and your next two tasks", () => {
    const members = [member("dan", "owner", { title: "Founder" }), member("maya", "member"), member("theo", "member"), member("sana", "admin"), member("gus", "guest"),
      invitee("new@acme.co"), { ...member("zed", "member"), workspaceId: "other" }];
    const projects = [project("p1", { name: "Ops" }), project("p2", { name: "Launch", contributorIds: ["maya"] }), project("p3", { name: "Brand" }), project("p4", { name: "Old", archivedAt: daysAgo(1) }), project("p9", { workspaceId: "other" })];
    const tasks = [task("a", { assigneeId: "maya", dueDate: "2026-11-20", projectId: "p3" }), task("b", { assigneeId: "maya", dueDate: "2026-11-12", projectId: "p3" }),
      task("c", { assigneeId: "maya", dueDate: undefined, projectId: "p3" }), task("d", { assigneeId: "maya", status: "done", projectId: "p3" }), task("e", { assigneeId: "theo" })];
    const goals = [{ id: "g0", name: "Last quarter's", status: "on_track", workspaceId: "ws", period: "2026-Q3", position: 0 }, { id: "g1", name: "Revenue to £2m", status: "on_track", workspaceId: "ws", period: "2026-Q4", position: 1 },
      { id: "g2", name: "A key result", status: "on_track", workspaceId: "ws", parentId: "g1", period: "2026-Q4" }] as Goal[];
    const c = welcomeContent({ me: "maya", workspace: ws, role: "member", members, projects, tasks, goals, nameOf: (m) => m.name, quarter: "2026-Q4" });
    expect(c.projects.map((p) => p.id)).toEqual(["p2", "p3", "p1"]);
    expect(c.people.map((p) => p.id)).toEqual(["dan", "sana", "theo", "gus"]);
    expect(c.people[0]).toMatchObject({ title: "Founder", role: "owner" });
    expect(c.morePeople).toBe(0);
    expect(c.goal?.id).toBe("g1");
    expect(c.ask).toMatchObject({ id: "dan", why: "owner" });
    expect(c.starters.map((t) => t.id)).toEqual(["b", "a"]);
    // the rollout's champion is who to ask; a guest gets no goal (they can't read them) and no starters
    const champ = welcomeContent({ me: "gus", workspace: { ...ws, rollout: { champion: "sana" } }, role: "guest", members, projects, tasks, goals, nameOf: (m) => m.name });
    expect(champ.ask).toMatchObject({ id: "sana", why: "champion" });
    expect(champ.goal).toBeNull();
    expect(champ.starters).toEqual([]);
  });
  it("is put away for that workspace only", () => {
    expect(welcomedNow({ a: "x" }, "ws", TODAY)).toEqual({ a: "x", ws: TODAY.toISOString() });
  });
});

describe("the first run's pilot group, and the words", () => {
  it("takes addresses however they're typed, once each", () => {
    expect(pilotEmails("Sam@Acme.co, alex@acme.co;\n<jo@acme.co> sam@acme.co  nope")).toEqual({ valid: ["sam@acme.co", "alex@acme.co", "jo@acme.co"], invalid: ["nope"] });
    expect(pilotEmails("")).toEqual({ valid: [], invalid: [] });
  });
  it("lists names as people say them", () => {
    expect(namesLine(["Priya"])).toBe("Priya");
    expect(namesLine(["Priya", "Jonas"])).toBe("Priya and Jonas");
    expect(namesLine(["A", "B", "C"])).toBe("A, B and C");
    expect(namesLine(["A", "B", "C", "D", "E"])).toBe("A, B and 3 others");
    expect(daysSince("2026-11-08", TODAY)).toBe(2);
  });
});

describe("the rollout plan as stored (0057 workspaces.rollout)", () => {
  it("reads and writes its three parts, nothing else", () => {
    expect(parseRollout({ champion: "u1", pilot: ["u2", "u2", 3, "u3"], go_live: "2026-12-01", junk: true })).toEqual({ champion: "u1", pilot: ["u2", "u3"], goLive: "2026-12-01" });
    expect(parseRollout({ go_live: "soon" })).toBeNull();
    expect(parseRollout(null)).toBeNull();
    expect(parseRollout(["x"])).toBeNull();
    expect(rolloutRow({ champion: "u1", pilot: ["u2", "u2"], goLive: "2026-12-01" })).toEqual({ champion: "u1", pilot: ["u2"], go_live: "2026-12-01" });
    expect(rolloutRow({ champion: null, pilot: [] })).toBeNull();
    expect(rolloutRow(null)).toBeNull();
  });
});
