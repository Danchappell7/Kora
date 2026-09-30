import { describe, it, expect } from "vitest";
import { triage, groupOf, isRequestTask, requestSource, unreadCount, isNotification, SELF_KINDS, TRIAGE_GROUPS } from "./inboxTriage";
import type { Activity, ActivityKind, Task } from "../data/types";

const item = (id: string, kind: ActivityKind, taskId: string | null = "t1", extra: Partial<Activity> = {}): Activity => ({
  id, taskId, taskTitle: "Q3 budget", kind, detail: "Maya Lin", createdAt: "2026-09-30T09:00:00.000Z", readAt: "2026-09-30T09:01:00.000Z", ...extra,
});
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...extra,
});

describe("inboxTriage — groups", () => {
  const tasks = [
    task("t1"),
    task("req-mine", { description: "Request via Launch requests\nNeed the pricing FAQ updated" }),
    task("req-theirs", { description: "Request via Launch requests", assigneeId: "m-2" }),
    task("form-mine", { formId: "f-1" } as Partial<Task>),
  ];

  it("mentions need your reply; assignments are new to you; everything else is FYI", () => {
    const feed = [
      item("m1", "mention"), item("a1", "assigned"), item("c1", "comment"),
      item("s1", "status"), item("d1", "completed"), item("x1", "deleted", null),
    ];
    const g = triage(feed, { me: "me", tasks });
    expect(g.reply.map((a) => a.id)).toEqual(["m1"]);
    expect(g.newToYou.map((a) => a.id)).toEqual(["a1"]);
    expect(g.fyi.map((a) => a.id)).toEqual(["c1", "s1", "d1", "x1"]);
  });

  it("a request-form task created and assigned to you is new to you; one assigned to someone else is FYI", () => {
    const g = triage([
      item("r1", "created", "req-mine"),
      item("r2", "created", "req-theirs"),
      item("r3", "created", "form-mine"),
      item("r4", "created", "t1"),
    ], { me: "me", tasks });
    expect(g.newToYou.map((a) => a.id)).toEqual(["r1", "r3"]);
    expect(g.fyi.map((a) => a.id)).toEqual(["r2", "r4"]);
  });

  it("keeps the feed's order inside each group and accepts a task map", () => {
    const feed = [item("m2", "mention"), item("c1", "comment"), item("m1", "mention")];
    const g = triage(feed, { me: "me", tasks: new Map(tasks.map((t) => [t.id, t])) });
    expect(g.reply.map((a) => a.id)).toEqual(["m2", "m1"]);
  });

  it("an item whose task is gone still lands somewhere (never dropped)", () => {
    const feed = [item("m1", "mention", "missing"), item("c1", "created", "missing"), item("c2", "comment", null)];
    const g = triage(feed, { me: "me", tasks: [] });
    expect(g.reply.length + g.newToYou.length + g.fyi.length).toBe(3);
    expect(g.reply.map((a) => a.id)).toEqual(["m1"]);
  });

  it("without a user id, a request counts as yours", () => {
    expect(groupOf(item("r", "created", "req-theirs"), { task: tasks[2] })).toBe("newToYou");
  });

  it("lists the groups in reading order", () => {
    expect(TRIAGE_GROUPS.map((g) => g.label)).toEqual(["Needs your reply", "New to you", "FYI"]);
  });
});

describe("inboxTriage — requests", () => {
  it("spots a request by its form id or its 'Request via' line", () => {
    expect(isRequestTask({ description: "Request via Launch requests" })).toBe(true);
    expect(isRequestTask({ description: "  request via IT desk" })).toBe(true);
    expect(isRequestTask({ description: "", formId: "f-1" })).toBe(true);
    expect(isRequestTask({ description: "A request via email" })).toBe(false);
    expect(isRequestTask(undefined)).toBe(false);
  });

  it("names the form the request came through", () => {
    expect(requestSource({ description: "Request via Launch requests\nDetails…" })).toBe("Launch requests");
    expect(requestSource({ description: "Request via IT desk. Laptop broken" })).toBe("IT desk");
    expect(requestSource({ description: "Plain task" })).toBeNull();
  });
});

describe("inboxTriage — your own history is never new", () => {
  it("keeps the SELF_KINDS exclusion", () => {
    expect([...SELF_KINDS].sort()).toEqual(["completed", "created", "deleted", "reopened", "status"]);
    expect(isNotification({ kind: "comment" })).toBe(true);
    expect(isNotification({ kind: "completed" })).toBe(false);
  });

  it("counts unread notifications only", () => {
    const feed = [
      item("m1", "mention", "t1", { readAt: undefined }),
      item("a1", "assigned", "t1", { readAt: undefined }),
      item("s1", "status", "t1", { readAt: undefined }),   // your own: not counted
      item("c1", "comment"),                               // read
    ];
    expect(unreadCount(feed)).toBe(2);
  });
});
