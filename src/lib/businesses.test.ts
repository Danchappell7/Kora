/* lib/businesses: who runs what, each workspace's signals, All businesses' lists, the brief's lead line
   and the time planned in other businesses. Everything reads only what it's given (what you can see). */
import { describe, it, expect } from "vitest";
import {
  activityWorkspace, approvalsEverywhere, attentionScore, busyElsewhere, businessLead, businessesYouRun, canAssignIn, hasGroup, inboxEverywhere, liveTasks,
  mentionsInWorkspace, offersAllBusinesses, roleInWorkspace, shortName, signalDetail, taskPhrase, workspaceSignals, wsKey,
} from "./businesses";
import type { Activity, ApprovalWithTask, Project, Task, Workspace, WorkspaceMember } from "../data/types";

const TODAY = "2026-10-09";
const ws = (id: string | null, name: string): Workspace => ({ id, name, kind: id ? "team" : "personal" });
const WS = [ws(null, "Personal"), ws("w-a", "Alpha Studio"), ws("w-b", "Beta Padel"), ws("w-c", "Cove Advisory")];
const mem = (workspaceId: string, userId: string, role: WorkspaceMember["role"], status: WorkspaceMember["status"] = "active"): WorkspaceMember =>
  ({ id: `${workspaceId}-${userId}`, workspaceId, userId, email: `${userId}@x.io`, name: userId, role, status });
const MEMBERS = [mem("w-a", "me", "owner"), mem("w-a", "ana", "member"), mem("w-b", "me", "admin"), mem("w-b", "bo", "owner"), mem("w-c", "me", "member"), mem("w-c", "cy", "owner")];
const task = (o: Partial<Task> & { id: string }): Task => ({
  title: o.id, status: "todo", priority: "medium", projectId: "p-a", workspaceId: "w-a", assigneeId: "me", dependencies: [], subtasks: [], tags: [], comments: 0, ...o,
} as Task);
const proj = (id: string, workspaceId: string | null, archivedAt?: string): Project => ({ id, name: id, color: "", workspaceId, ...(archivedAt ? { archivedAt } : {}) } as Project);
const PROJECTS = [proj("p-a", "w-a"), proj("p-b", "w-b"), proj("p-c", "w-c"), proj("p-old", "w-a", "2026-10-01"), proj("p-me", null)];

describe("who runs what", () => {
  it("your businesses are team workspaces where you're an active owner or admin", () => {
    expect(businessesYouRun(WS, MEMBERS, "me").map((w) => w.id)).toEqual(["w-a", "w-b"]);
    expect(hasGroup(WS, MEMBERS, "me")).toBe(true);
    // a member, an invite not yet accepted, or a guest isn't running it
    const less = [mem("w-a", "me", "owner"), mem("w-b", "me", "admin", "invited"), mem("w-c", "me", "guest")];
    expect(businessesYouRun(WS, less, "me").map((w) => w.id)).toEqual(["w-a"]);
    expect(hasGroup(WS, less, "me")).toBe(false);
    expect(roleInWorkspace(MEMBERS, "me", "w-c")).toBe("member");
    expect(roleInWorkspace(MEMBERS, "me", null)).toBeNull();
  });

  it("All businesses is offered once you're in more than one workspace", () => {
    expect(offersAllBusinesses(WS)).toBe(true);
    expect(offersAllBusinesses([ws(null, "Personal")])).toBe(false);
  });

  it("names: a key per workspace, short names for tight places", () => {
    expect(wsKey(null)).toBe("personal");
    expect(wsKey("w-a")).toBe("w-a");
    expect(shortName("Courtside Padel")).toBe("Courtside Padel");
    expect(shortName("The Very Long Holdings Company")).toBe("The Very Long Hol…");
  });
});

describe("All businesses: the lists", () => {
  it("live tasks leave out archived ones and those in archived projects", () => {
    const list = [task({ id: "a" }), task({ id: "b", archivedAt: "2026-10-02" }), task({ id: "c", projectId: "p-old" })];
    expect(liveTasks(list, PROJECTS).map((t) => t.id)).toEqual(["a"]);
  });

  it("every workspace's Inbox together: items whose task (or doc's project) you can see, your integration notices once", () => {
    const tasks = [task({ id: "ta" }), task({ id: "tb", workspaceId: "w-b", projectId: "p-b" }), task({ id: "tp", workspaceId: null, projectId: "p-me" })];
    const act = (id: string, o: Partial<Activity>): Activity => ({ id, taskId: null, taskTitle: "", kind: "comment", detail: "Ana", createdAt: "2026-10-09T09:00:00Z", ...o } as Activity);
    const feed = [
      act("1", { taskId: "ta" }), act("2", { taskId: "tb" }), act("3", { taskId: "tp" }),
      act("4", { taskId: "gone" }),                                        // a task you can't see: left out
      act("5", { kind: "integration" }),                                   // your setup: shown
      act("6", { kind: "doc_mention", meta: { docId: "d", projectId: "p-c" } }),
      act("7", { kind: "doc_mention", meta: { docId: "d", projectId: "p-hidden" } }),
      // 0054: a project update, by its project's workspace
      act("8", { kind: "update", meta: { statusUpdateId: "su", projectId: "p-b", updateEvent: "posted" } }),
      act("9", { kind: "update", meta: { statusUpdateId: "su", projectId: "p-hidden", updateEvent: "posted" } }),
    ];
    expect(inboxEverywhere(feed, tasks, PROJECTS).map((a) => a.id)).toEqual(["1", "2", "3", "5", "6", "8"]);
    const wsOf = new Map(tasks.map((t) => [t.id, t.workspaceId ?? null] as const));
    expect(activityWorkspace(feed[1], wsOf, PROJECTS)).toBe("w-b");
    expect(activityWorkspace(feed[2], wsOf, PROJECTS)).toBeNull();
    expect(activityWorkspace(feed[5], wsOf, PROJECTS)).toBe("w-c");
    expect(activityWorkspace(feed[3], wsOf, PROJECTS)).toBeUndefined();
  });

  it("requests waiting on you, each still in its task's workspace", () => {
    const a = (id: string, workspaceId: string, taskWs: string) => ({ id, workspaceId, task: { workspaceId: taskWs } } as unknown as ApprovalWithTask);
    expect(approvalsEverywhere([a("1", "w-a", "w-a"), a("2", "w-b", "w-a"), a("3", "w-b", "w-b")]).map((x) => x.id)).toEqual(["1", "3"]);
  });

  it("a reply only mentions people who can see the task", () => {
    expect(mentionsInWorkspace(["ana", "bo"], "w-a", MEMBERS)).toEqual(["ana"]);
    expect(mentionsInWorkspace(["ana"], "w-b", MEMBERS)).toEqual([]);
    expect(mentionsInWorkspace(["ana"], null, MEMBERS)).toEqual([]);                 // a Personal task: nobody else
    expect(mentionsInWorkspace(undefined, "w-a", MEMBERS)).toBeUndefined();
  });

  it("a task only goes to someone who can see it: a member of its workspace; a Personal task, only you", () => {
    expect(canAssignIn(MEMBERS, "ana", "w-a", "me")).toBe(true);
    expect(canAssignIn(MEMBERS, "ana", "w-b", "me")).toBe(false);                     // Ana isn't in Beta Padel
    expect(canAssignIn(MEMBERS, "bo", null, "me")).toBe(false);                       // Personal: nobody else
    expect(canAssignIn(MEMBERS, "me", null, "me")).toBe(true);
    expect(canAssignIn(MEMBERS, undefined, "w-b", "me")).toBe(true);                  // unassigned
    expect(canAssignIn([mem("w-a", "zed", "member", "invited")], "zed", "w-a", "me")).toBe(false);   // not joined yet
  });
});

describe("each workspace's signals (the switcher's dots)", () => {
  const tasks = [
    task({ id: "late", dueDate: "2026-10-07", priority: "high" }),                     // w-a, yours, overdue
    task({ id: "due", dueDate: TODAY }),                                              // w-a, yours, today
    task({ id: "theirs", dueDate: "2026-10-01", assigneeId: "ana" }),                  // not yours
    task({ id: "done", dueDate: "2026-10-01", status: "done" }),
    task({ id: "sub", dueDate: "2026-10-01", parentId: "due" }),
    task({ id: "later", dueDate: "2026-10-20" }),
    task({ id: "b1", workspaceId: "w-b", projectId: "p-b", dueDate: TODAY, collaborators: ["me"], assigneeId: "bo" }),
  ];
  const act = (id: string, taskId: string, o: Partial<Activity> = {}): Activity => ({ id, taskId, taskTitle: "", kind: "mention", detail: "Bo", createdAt: "2026-10-09T08:00:00Z", ...o } as Activity);
  const activity = [act("u1", "b1"), act("u2", "b1", { readAt: "2026-10-09T08:30:00Z" }), act("u3", "due", { kind: "status" }), act("u4", "late")];
  const approvals = [{ id: "ap", workspaceId: "w-b", task: { workspaceId: "w-b" } } as unknown as ApprovalWithTask];
  const sig = workspaceSignals({ workspaces: WS, tasks, projects: PROJECTS, activity, approvals, me: "me", today: TODAY });

  it("counts your overdue and due-today work, unread items (not your own actions) and requests for you", () => {
    expect(sig.get("w-a")).toMatchObject({ unread: 1, overdue: 1, dueToday: 1, approvals: 0, attention: 2, detail: "1 overdue · 1 due today" });
    expect(sig.get("w-a")!.top?.id).toBe("late");                                     // the overdue one comes first
    expect(sig.get("w-b")).toMatchObject({ unread: 1, overdue: 0, dueToday: 1, approvals: 1, attention: 2, detail: "1 approval · 1 due today" });
    expect(sig.get("personal")).toMatchObject({ unread: 0, attention: 0, detail: "" });
    expect(sig.get("w-c")).toMatchObject({ attention: 0 });
  });

  it("an Inbox item on an archived task still counts for its workspace (as the Inbox and its badge count it)", () => {
    const archived = task({ id: "old", workspaceId: "w-b", projectId: "p-b", archivedAt: "2026-10-08" });
    const s2 = workspaceSignals({ workspaces: WS, tasks: liveTasks([...tasks, archived], PROJECTS), allTasks: [...tasks, archived], projects: PROJECTS,
      activity: [act("m1", "old")], approvals: [], me: "me", today: TODAY });
    expect(s2.get("w-b")!.unread).toBe(1);
    // without the full list it couldn't be placed
    expect(workspaceSignals({ workspaces: WS, tasks: liveTasks([...tasks, archived], PROJECTS), projects: PROJECTS, activity: [act("m1", "old")], approvals: [], me: "me", today: TODAY })
      .get("w-b")!.unread).toBe(0);
  });

  it("words for the dot", () => {
    expect(signalDetail({ approvals: 2, overdue: 1, dueToday: 0 })).toBe("2 approvals · 1 overdue");
    expect(signalDetail({ approvals: 0, overdue: 0, dueToday: 0 })).toBe("");
  });

  it("the brief's lead: the business that needs you most, its most pressing task, then the rest", () => {
    // level pegging: the switcher's order decides
    expect(businessLead(sig, WS).lead?.workspace.name).toBe("Alpha Studio");
    // a second request at Beta Padel: requests weigh most
    const more = workspaceSignals({ workspaces: WS, tasks, projects: PROJECTS, activity, approvals: [...approvals, { id: "ap2", workspaceId: "w-b", task: null } as unknown as ApprovalWithTask], me: "me", today: TODAY });
    const lead = businessLead(more, WS);
    expect(lead.lead?.workspace.name).toBe("Beta Padel");
    expect(lead.lead?.parts).toEqual(["b1", "2 approvals"]);
    expect(lead.lead).toMatchObject({ taskId: "b1", taskWhen: "due today", detail: "2 approvals · 1 due today", score: attentionScore(more.get("w-b")!) });
    expect(lead.others.map((o) => [o.workspace.name, o.parts])).toEqual([["Alpha Studio", ["late", "1 more due today"]]]);
    expect(lead.plain).toBe("Beta Padel needs you most today: b1 and 2 approvals. Alpha Studio: late, 1 more due today.");
    // nothing needs you: no lead
    expect(businessLead(workspaceSignals({ workspaces: WS, tasks: [], projects: PROJECTS, activity: [], approvals: [], me: "me", today: TODAY }), WS))
      .toEqual({ lead: null, others: [], plain: "" });
  });

  it("a task inside a sentence keeps names and acronyms", () => {
    expect(taskPhrase("Sign the lighting order")).toBe("sign the lighting order");
    expect(taskPhrase("Q3 launch deck")).toBe("Q3 launch deck");
    expect(taskPhrase("Prepare the very long investor update for the board pack review")).toBe("prepare the very long investor update f…");
  });
});

describe("time planned in other businesses", () => {
  it("your open blocks on today's day elsewhere are busy here (as breaks, never counted as meetings)", () => {
    const tasks = [
      task({ id: "here", planToday: true, scheduled: 600, focusMin: 30 }),                                       // this workspace
      task({ id: "there", title: "Investor prep", workspaceId: "w-b", projectId: "p-b", planToday: true, scheduled: 900, focusMin: 45 }),
      task({ id: "mine-personal", workspaceId: null, projectId: "p-me", planToday: true, scheduled: 780, dur: 20 }),
      task({ id: "done-there", workspaceId: "w-b", projectId: "p-b", planToday: true, scheduled: 960, status: "done" }),
      task({ id: "not-placed", workspaceId: "w-b", projectId: "p-b", planToday: true }),
      task({ id: "someone-else", workspaceId: "w-b", projectId: "p-b", planToday: true, scheduled: 1000, assigneeId: "bo" }),
    ];
    const names: Record<string, string> = { "w-a": "Alpha Studio", "w-b": "Beta Padel" };
    const busy = busyElsewhere(tasks, "w-a", "me", (id) => (id ? names[id] : "Personal"));
    expect(busy).toEqual([
      { id: "elsewhere-mine-personal", title: "mine-personal", start: 780, end: 800, kind: "break", elsewhere: { workspaceId: null, name: "Personal", taskId: "mine-personal" } },
      { id: "elsewhere-there", title: "Investor prep", start: 900, end: 945, kind: "break", elsewhere: { workspaceId: "w-b", name: "Beta Padel", taskId: "there" } },
    ]);
    // seen from Beta Padel, its own block isn't "elsewhere"
    expect(busyElsewhere(tasks, "w-b", "me", (id) => (id ? names[id] : "Personal")).map((e) => e.id)).toEqual(["elsewhere-here", "elsewhere-mine-personal"]);
  });
});
