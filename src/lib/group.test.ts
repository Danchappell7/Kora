/* lib/group: the Group page's digest per business you run. It reads only what it's handed (rows you can
   already see), and a business you're only a member of, or one you're not in, never gets a section. */
import { describe, it, expect } from "vitest";
import { businessDigest, digestLine, goalsBehind, groupDigest, winsWeek, type GroupInput } from "./group";
import { businessLead, workspaceSignals } from "./businesses";
import type { ApprovalWithTask, Goal, Project, StatusUpdate, Task, Workspace, WorkspaceMember } from "../data/types";

const TODAY = new Date(2026, 9, 9);     // Friday 9 Oct 2026
const MONDAY = new Date(2026, 9, 12);
const ws = (id: string, name: string): Workspace => ({ id, name, kind: "team" });
const WS = [{ id: null, name: "Personal", kind: "personal" } as Workspace, ws("w-a", "Alpha Studio"), ws("w-b", "Beta Padel"), ws("w-c", "Cove Advisory"), ws("w-x", "Elsewhere Ltd")];
const mem = (workspaceId: string, userId: string, role: WorkspaceMember["role"]): WorkspaceMember => ({ id: `${workspaceId}-${userId}`, workspaceId, userId, email: "", name: userId, role, status: "active" });
const MEMBERS = [mem("w-a", "me", "owner"), mem("w-b", "me", "admin"), mem("w-b", "bo", "owner"), mem("w-c", "me", "member")];
const proj = (id: string, workspaceId: string, o: Partial<Project> = {}): Project => ({ id, name: id, color: "", workspaceId, ...o } as Project);
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, status: "todo", priority: "medium", projectId: "pa", workspaceId: "w-a", assigneeId: "me", dependencies: [], subtasks: [], tags: [], comments: 0,
  createdAt: "2026-10-05T09:00:00Z", ...o,
} as Task);
const goal = (o: Partial<Goal> & { id: string }): Goal => ({ name: o.id, status: "on_track", workspaceId: "w-a", ...o } as Goal);
const upd = (projectId: string, workspaceId: string, status: StatusUpdate["status"], createdAt: string): StatusUpdate => ({ id: `u-${projectId}`, projectId, workspaceId, status, createdAt, summary: "…" });

const input = (o: Partial<GroupInput> = {}): GroupInput => ({
  workspaces: WS, members: MEMBERS, me: "me", today: TODAY, capacities: {},
  projects: [proj("pa", "w-a"), proj("pa2", "w-a"), proj("pa-old", "w-a", { archivedAt: "2026-09-01" }), proj("pb", "w-b"), proj("pc", "w-c"), proj("px", "w-x")],
  tasks: [
    // Alpha: one project off track (three overdue), one fine, wins this week
    task({ id: "a1", dueDate: "2026-10-01" }), task({ id: "a2", dueDate: "2026-10-02" }), task({ id: "a3", dueDate: "2026-10-03" }),
    task({ id: "a4", projectId: "pa2", dueDate: "2026-10-20" }),
    task({ id: "won1", status: "done", completedAt: "2026-10-06", priority: "low" }), task({ id: "won2", status: "done", completedAt: "2026-10-08", priority: "high" }),
    task({ id: "won-last-week", status: "done", completedAt: "2026-10-02" }),
    task({ id: "won-sub", status: "done", completedAt: "2026-10-07", parentId: "a1" }),
    // Beta: quiet, its update over two weeks old
    task({ id: "b1", projectId: "pb", workspaceId: "w-b", createdAt: "2026-09-01T09:00:00Z", dueDate: "2026-10-30" }),
    // Cove (you're a member) and Elsewhere (you're not in it): never shown
    task({ id: "c1", projectId: "pc", workspaceId: "w-c", dueDate: "2026-10-01" }), task({ id: "x1", projectId: "px", workspaceId: "w-x", dueDate: "2026-10-01" }),
  ],
  goals: [
    goal({ id: "g-risk", status: "at_risk", position: 1 }), goal({ id: "g-off", status: "off_track", position: 2 }),
    goal({ id: "g-late", due: "2026-10-01", target: 10, current: 4 }), goal({ id: "g-fine", due: "2026-12-31" }), goal({ id: "g-done", status: "done" }),
    goal({ id: "g-b", workspaceId: "w-b", target: 100, current: 90 }), goal({ id: "g-c", workspaceId: "w-c", status: "off_track" }),
  ],
  statusUpdates: [upd("pa2", "w-a", "at_risk", "2026-10-08T10:00:00Z"), upd("pb", "w-b", "on_track", "2026-09-20T10:00:00Z")],
  approvals: [
    { id: "ap1", taskId: "a4", workspaceId: "w-a", title: "a4", requestedByName: "Ana Bell", createdAt: "2026-10-09T08:00:00Z", task: { workspaceId: "w-a", title: "Sign the order" } } as unknown as ApprovalWithTask,
    { id: "ap-moved", taskId: "b1", workspaceId: "w-a", title: "b1", requestedByName: null, createdAt: "2026-10-09T08:00:00Z", task: { workspaceId: "w-b", title: "Moved" } } as unknown as ApprovalWithTask,
  ],
  ...o,
});

describe("the Group page's businesses", () => {
  it("one digest per business you run (owner or admin), the one that needs you most first", () => {
    const d = groupDigest(input());
    expect(d.map((x) => [x.workspace.name, x.role])).toEqual([["Alpha Studio", "owner"], ["Beta Padel", "admin"]]);
    expect(d[0].score).toBeGreaterThan(d[1].score);
    // nothing from a workspace you're only a member of, or not in at all, gets in
    const all = JSON.stringify(d);
    for (const id of ["c1", "x1", "g-c", "pc", "px"]) expect(all).not.toContain(`"${id}"`);
  });

  it("goals behind: marked at risk or off track, or past their date unfinished; the worst first", () => {
    const [alpha] = groupDigest(input());
    expect(alpha.goals.behind.map((g) => [g.goal.id, g.why, g.pct])).toEqual([["g-off", "off_track", 0], ["g-late", "overdue", 40], ["g-risk", "at_risk", 0]]);
    expect(alpha.goals.total).toBe(5);
  });

  it("wave 2's pace line plugs in: a goal it says is behind counts, and its line rides along", () => {
    const pace = (g: Goal) => (g.id === "g-fine" ? { behind: true, line: "Needs 12 a week; doing 8" } : g.id === "g-risk" ? { behind: false, line: "On pace since Tuesday" } : null);
    const behind = goalsBehind(input().goals.filter((g) => g.workspaceId === "w-a"), new Map(), TODAY, pace);
    expect(behind.find((g) => g.goal.id === "g-fine")).toMatchObject({ why: "pace", pace: { line: "Needs 12 a week; doing 8" } });
    expect(behind.find((g) => g.goal.id === "g-risk")?.pace?.line).toBe("On pace since Tuesday");
  });

  it("projects to look at: off track from the work, at risk from the latest update, or quiet for two weeks; archived ones never", () => {
    const [alpha, beta] = groupDigest(input());
    expect(alpha.projects.needs.map((n) => [n.project.id, n.why, n.label, n.detail])).toEqual([
      ["pa", "off_track", "Off track", "3 overdue"],
      ["pa2", "at_risk", "At risk", "Update: at risk"],
    ]);
    expect(alpha.projects.total).toBe(2);
    expect(beta.projects.needs.map((n) => [n.project.id, n.why, n.label, n.detail])).toEqual([["pb", "stale", "No update in 14 days", "Last update 19 days ago"]]);
  });

  it("requests waiting for you there (one whose task moved away stays out)", () => {
    const [alpha, beta] = groupDigest(input());
    expect(alpha.approvals).toEqual([{ id: "ap1", taskId: "a4", title: "Sign the order", requestedByName: "Ana Bell", createdAt: "2026-10-09T08:00:00Z" }]);
    expect(beta.approvals).toEqual([]);
  });

  it("the week's wins: this week so far, the weightiest first; on a Monday, last week's", () => {
    const [alpha] = groupDigest(input());
    expect(alpha.wins).toMatchObject({ count: 2, label: "This week's wins" });
    expect(alpha.wins.top.map((t) => t.id)).toEqual(["won2", "won1"]);
    expect(winsWeek(MONDAY)).toMatchObject({ label: "Last week's wins", from: new Date(2026, 9, 5), to: new Date(2026, 9, 11) });
    const monday = businessDigest(WS[1], "owner", input({ today: MONDAY }));
    expect(monday.wins.count).toBe(2);
  });

  it("a line that sums each business up", () => {
    const [alpha, beta] = groupDigest(input());
    expect(digestLine(alpha)).toBe("1 approval · 1 project off track · 1 project to look at · 3 goals behind");
    expect(digestLine(beta)).toBe("1 project to look at");
    expect(digestLine({ ...beta, projects: { needs: [], total: 1 } })).toBe("Nothing needs you");
  });

  it("the latest update's call rides along when Kanbo's read of the work says worse (the project page shows the update)", () => {
    const d = groupDigest(input({ statusUpdates: [upd("pa", "w-a", "at_risk", "2026-10-08T10:00:00Z")] }));
    expect(d[0].projects.needs[0]).toMatchObject({ project: { id: "pa" }, label: "Off track", source: "work", detail: "3 overdue · Update: at risk" });
  });

  it("'needs you' means what the switcher and Today mean: your own work and requests there; that business comes first", () => {
    // Beta: your own work, overdue and due today (the switcher's dot); Alpha only has things behind
    const tasks = [...input().tasks, task({ id: "b-late", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-05" }), task({ id: "b-today", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-09" }),
      task({ id: "b-late2", projectId: "pb", workspaceId: "w-b", dueDate: "2026-10-06" })];
    const base = input({ tasks: tasks.filter((t) => !["a1", "a2", "a3"].includes(t.id)), approvals: [] });
    const signals = workspaceSignals({ workspaces: WS, tasks: base.tasks, projects: base.projects, activity: [], approvals: [], me: "me", today: "2026-10-09" });
    const d = groupDigest({ ...base, signals });
    expect(d.map((x) => [x.workspace.name, !!x.needsMost])).toEqual([["Beta Padel", true], ["Alpha Studio", false]]);
    expect(d[0].mine).toEqual({ overdue: 2, dueToday: 1 });
    expect(digestLine(d[0])).toBe("2 of yours overdue · 1 of yours due today · 1 project off track");
    // …the very business Today's brief names
    expect(businessLead(signals, WS).lead?.workspace.name).toBe("Beta Padel");
    // nothing needs you anywhere: no pill
    const calm = workspaceSignals({ workspaces: WS, tasks: [], projects: base.projects, activity: [], approvals: [], me: "me", today: "2026-10-09" });
    expect(groupDigest({ ...base, signals: calm }).some((x) => x.needsMost)).toBe(false);
  });
});
