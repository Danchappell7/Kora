import { describe, it, expect } from "vitest";
import { noticedToday } from "./noticed";
import type { CalEvent, Task } from "../data/types";
import type { Risk } from "./radar";

const TODAY = "2026-09-30";
const day = (n: number) => { const d = new Date(2026, 8, 30 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const H = (h: number, m = 0) => h * 60 + m;
let n = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium",
  projectId: "p", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const busy = (start: number, end: number): CalEvent => ({ id: "m" + start, title: "Meeting", start, end, kind: "meeting" });
const members = [{ id: "me", name: "Daniel Okai" }, { id: "maya", name: "Maya Lin" }, { id: "theo", name: "Theo Vance" }];
const noticed = (tasks: Task[], o: Partial<Parameters<typeof noticedToday>[0]> = {}) =>
  noticedToday({ tasks: tasks.filter((t) => t.assigneeId === "me"), allTasks: tasks, events: [], nowMin: H(10), today: TODAY, me: "me", members, ...o });

describe("Kanbo noticed", () => {
  it("someone blocked on your work comes first, with an action that opens it and one that puts it on today", () => {
    const mine = task({ id: "tok", title: "Design tokens", status: "review", focusMin: 20 });
    const theirs = task({ title: "Ship onboarding", assigneeId: "maya", status: "blocked", dependencies: ["tok"] });
    const [first] = noticed([mine, theirs]);
    expect(first).toMatchObject({
      id: "waiting:tok", kind: "waiting", tone: "signal", title: "Maya is blocked on you",
      body: "Ship onboarding can't move until Design tokens is done. It's about 20m.",
    });
    expect(first.actions).toEqual([
      { kind: "open", label: "Review it now", taskId: "tok" },
      { kind: "today", label: "Add to today", taskId: "tok" },
    ]);
  });

  it("several people waiting read as a count", () => {
    const mine = task({ id: "api" });
    const items = noticed([mine, task({ assigneeId: "maya", dependencies: ["api"] }), task({ assigneeId: "theo", dependencies: ["api"] })]);
    expect(items[0].title).toBe("2 people are waiting on you");
    expect(items[0].tone).toBe("accent");
  });

  it("a date that has slipped offers the free stretch for it today", () => {
    const t = task({ id: "inv", title: "Investor update", dueDate: day(2), originalDueDate: day(-5), focusMin: 40 });
    const [s] = noticed([t], { events: [busy(H(10), H(14))] });
    expect(s).toMatchObject({ kind: "slipped", tone: "warn", title: "Investor update has slipped 7 days" });
    expect(s.body).toBe("It was due 25 Sep; now it's 2 Oct. It's only 40m, and 14:00–14:40 is free today.");
    expect(s.actions[0]).toEqual({ kind: "place", label: "Put it at 14:00", taskId: "inv", start: H(14) });
  });

  it("a free stretch today before tomorrow's deadline", () => {
    const [s] = noticed([task({ id: "faq", title: "Press FAQ", dueDate: day(1), focusMin: 45 })]);
    expect(s).toMatchObject({ kind: "slot", title: "Room today for Press FAQ", body: "It's due tomorrow, and 10:00–10:45 is free today." });
  });

  it("shows Radar's risks only when they touch your work, and not twice for the same wait", () => {
    const mine = task({ id: "a" });
    const risk = (id: string, taskIds: string[], severity: Risk["severity"] = "signal"): Risk => ({ id, kind: "blocked", severity, title: `Risk ${id}`, reason: "Waiting", taskIds, fixes: [] });
    const items = noticed([mine, task({ id: "x", assigneeId: "theo" })], { risks: [risk("mine", ["a"]), risk("theirs", ["x"]), risk("quiet", ["a"], "neutral")] });
    expect(items.map((i) => i.id)).toEqual(["risk:mine"]);
    expect(items[0].actions).toEqual([{ kind: "open", label: "Open it", taskId: "a" }, { kind: "risks", label: "See the risks" }]);
  });

  it("keeps to three, most pressing first, and leaves out what you've waved away", () => {
    const tasks = [
      task({ id: "a" }), task({ assigneeId: "maya", status: "blocked", dependencies: ["a"] }),
      task({ id: "b" }), task({ assigneeId: "theo", dependencies: ["b"] }),
      task({ id: "s", dueDate: day(3), originalDueDate: day(0) }),
      task({ id: "f", dueDate: day(1) }),
    ];
    expect(noticed(tasks).map((i) => i.id)).toEqual(["waiting:a", "waiting:b", "slipped:s:" + day(3)]);
    expect(noticed(tasks, { dismissed: ["waiting:a"] }).map((i) => i.id)).toEqual(["waiting:b", "slipped:s:" + day(3), "slot:f"]);
  });

  it("after the working day, offers no slots", () => {
    expect(noticed([task({ dueDate: day(1) })], { nowMin: H(19) })).toEqual([]);
  });
});
