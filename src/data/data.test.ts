import { describe, it, expect } from "vitest";
import {
  parseCapture, planDay, dueState, fmtDue, dueOffset, energyOf,
  projectProgress, blockingTasks, memberInitials, dayOffset, EVENTS,
  DAY_START, DAY_END, nextDueDate,
} from "./data";
import type { Task } from "./types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

describe("parseCapture", () => {
  it("parses duration, energy and due date from natural language", () => {
    const t = parseCapture("Draft Q3 deck 90m deep work today")!;
    expect(t).not.toBeNull();
    expect(t.dur).toBe(90);
    expect(t.energy).toBe("deep");
    expect(t.dueDate).toBe(dayOffset(0));
    expect(t.title.toLowerCase()).toContain("draft q3 deck");
    expect(t.planToday).toBe(true);
    expect(t.status).toBe("todo");
  });

  it("handles hours and tomorrow", () => {
    const t = parseCapture("Design review 2h tomorrow")!;
    expect(t.dur).toBe(120);
    expect(t.energy).toBe("create");
    expect(t.dueDate).toBe(dayOffset(1));
  });

  it("returns null for empty input", () => {
    expect(parseCapture("   ")).toBeNull();
  });
});

describe("planDay", () => {
  it("places tasks without overlapping fixed events and within day bounds", () => {
    const tasks: Task[] = [
      task({ id: "a", dur: 60, energy: "deep", dueDate: dayOffset(0) }),
      task({ id: "b", dur: 30, energy: "admin", dueDate: dayOffset(0) }),
    ];
    const placed = planDay(tasks, EVENTS);
    for (const id of Object.keys(placed)) {
      const start = placed[id];
      const t = tasks.find((x) => x.id === id)!;
      const end = start + (t.dur || t.focusMin);
      expect(start).toBeGreaterThanOrEqual(DAY_START);
      expect(end).toBeLessThanOrEqual(DAY_END);
      for (const e of EVENTS) {
        const overlaps = start < e.end && end > e.start;
        expect(overlaps).toBe(false);
      }
    }
  });
});

describe("date helpers", () => {
  it("dueState reflects relative dates", () => {
    expect(dueState(dayOffset(0), "todo")).toBe("today");
    expect(dueState(dayOffset(-1), "todo")).toBe("overdue");
    expect(dueState(dayOffset(1), "todo")).toBe("soon");
    expect(dueState(dayOffset(5), "todo")).toBe("future");
    expect(dueState(dayOffset(0), "done")).toBe("none");
    expect(dueState(undefined, "todo")).toBe("none");
  });

  it("fmtDue gives friendly labels", () => {
    expect(fmtDue(dayOffset(0))).toBe("Today");
    expect(fmtDue(dayOffset(1))).toBe("Tomorrow");
    expect(fmtDue(dayOffset(-1))).toBe("Yesterday");
  });

  it("dueOffset returns day delta", () => {
    expect(dueOffset(dayOffset(3))).toBe(3);
    expect(dueOffset(undefined)).toBe(99);
  });
});

describe("nextDueDate (recurrence)", () => {
  it("advances by the recurrence step and never lands in the past", () => {
    // a due date a week ago, recurring weekly → next is today or future
    const past = dayOffset(-7);
    const next = nextDueDate(past, "weekly");
    expect(next >= dayOffset(0)).toBe(true);
    // daily from today → tomorrow
    expect(nextDueDate(dayOffset(0), "daily")).toBe(dayOffset(1));
    // monthly advances roughly a month
    const m = nextDueDate(dayOffset(0), "monthly");
    expect(m > dayOffset(0)).toBe(true);
  });
});

describe("energyOf", () => {
  it("maps tags to energy buckets", () => {
    expect(energyOf(task({ tags: ["design"] }))).toBe("create");
    expect(energyOf(task({ tags: ["research"] }))).toBe("collab");
    expect(energyOf(task({ tags: ["ops"] }))).toBe("admin");
    expect(energyOf(task({ tags: ["writing"] }))).toBe("deep");
    expect(energyOf(task({ tags: [] }))).toBe("admin");
  });
});

describe("task utilities", () => {
  it("projectProgress computes completion percent", () => {
    const tasks = [
      task({ id: "1", projectId: "p", status: "done" }),
      task({ id: "2", projectId: "p", status: "todo" }),
      task({ id: "3", projectId: "p", status: "todo" }),
      task({ id: "4", projectId: "other", status: "done" }),
    ];
    expect(projectProgress(tasks, "p")).toBe(33);
    expect(projectProgress(tasks, "missing")).toBe(0);
  });

  it("blockingTasks returns unfinished dependencies", () => {
    const all = [
      task({ id: "dep-done", status: "done" }),
      task({ id: "dep-open", status: "todo" }),
    ];
    const t = task({ id: "main", dependencies: ["dep-done", "dep-open"] });
    const blocked = blockingTasks(t, all);
    expect(blocked.map((b) => b.id)).toEqual(["dep-open"]);
  });

  it("memberInitials takes up to two initials", () => {
    expect(memberInitials("Daniel Okai")).toBe("DO");
    expect(memberInitials("Cher")).toBe("C");
    expect(memberInitials("")).toBe("?");
  });
});
