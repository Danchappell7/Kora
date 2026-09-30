import { describe, it, expect, beforeEach } from "vitest";
import { SMART_LISTS, smartListById, smartListQuery } from "./smartLists";
import { taskMatchesQuery, toQuery } from "./searchQuery";
import { setReferenceData, dayOffset } from "../data/data";
import type { Task, Project } from "../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-live", assigneeId: "u-me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const project = (id: string, archivedAt?: string): Project => ({ id, name: id, emoji: "", color: "#888", workspaceId: "ws", archivedAt: archivedAt ?? null });
const count = (id: string, tasks: Task[], me = "u-me") => tasks.filter((t) => smartListById(id)!.match(t, me)).length;

beforeEach(() => {
  setReferenceData({ projects: [project("p-live"), project("p-old", "2026-09-01T00:00:00Z")] });
});

describe("smart lists are personal", () => {
  const tasks = [
    task({ id: "mine", assigneeId: "u-me", dueDate: dayOffset(-2) }),
    task({ id: "collab", assigneeId: "u-sarah", collaborators: ["u-me"], dueDate: dayOffset(-2) }),
    task({ id: "theirs", assigneeId: "u-sarah", dueDate: dayOffset(-2) }),
    task({ id: "theirs2", assigneeId: "u-raj", dueDate: dayOffset(-5) }),
  ];

  it("Overdue counts only my tasks and ones I collaborate on", () => {
    expect(count("overdue", tasks)).toBe(2);
    expect(count("overdue", tasks, "u-sarah")).toBe(2);
    expect(count("overdue", tasks, "u-raj")).toBe(1);
  });

  it("Due today and Due this week are scoped the same way", () => {
    const today = tasks.map((t) => ({ ...t, dueDate: dayOffset(0) }));
    expect(count("today", today)).toBe(2);
    const week = tasks.map((t) => ({ ...t, dueDate: dayOffset(3) }));
    expect(count("week", week)).toBe(2);
    expect(count("week", [task({ dueDate: dayOffset(3), status: "done" })])).toBe(0);
  });

  it("matches nothing before a user is known", () => {
    expect(count("mine", tasks, "")).toBe(0);
  });
});

describe("archived projects", () => {
  it("are left out of every smart-list count", () => {
    const old = task({ projectId: "p-old", dueDate: dayOffset(-1) });
    for (const s of SMART_LISTS) expect(s.match(old, "u-me")).toBe(false);
    expect(smartListById("overdue")!.match({ ...old, projectId: "p-live" }, "u-me")).toBe(true);
  });
});

describe("badge and Search always agree", () => {
  it("each list's match is the Search predicate over its resolved preset", () => {
    const sample = [
      task({ id: "1", dueDate: dayOffset(0) }),
      task({ id: "2", dueDate: dayOffset(-1) }),
      task({ id: "3", dueDate: dayOffset(4), status: "done" }),
      task({ id: "4", dueDate: dayOffset(6), assigneeId: "u-x", collaborators: ["u-me"] }),
      task({ id: "5", dueDate: dayOffset(2), assigneeId: "u-x" }),
      task({ id: "6", projectId: "p-old", dueDate: dayOffset(0) }),
      task({ id: "7", archivedAt: "2026-09-01", dueDate: dayOffset(0) }),
      task({ id: "8" }),
    ];
    for (const s of SMART_LISTS) {
      const query = toQuery(smartListQuery(s.id, "u-me"));
      expect(query.assignee).toBe("u-me");
      for (const t of sample) expect(s.match(t, "u-me")).toBe(taskMatchesQuery(t, query));
    }
  });

  it("re-resolves the preset when the signed-in user changes", () => {
    const t = task({ assigneeId: "u-a" });
    const mine = smartListById("mine")!;
    expect(mine.match(t, "u-a")).toBe(true);
    expect(mine.match(t, "u-b")).toBe(false);
    expect(mine.match(t, "u-a")).toBe(true);
  });

  it("smartListQuery returns undefined for unknown ids", () => {
    expect(smartListQuery("nope", "u-me")).toBeUndefined();
    expect(smartListQuery(undefined, "u-me")).toBeUndefined();
  });
});
