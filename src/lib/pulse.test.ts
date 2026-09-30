import { describe, it, expect } from "vitest";
import type { Task, WorkspaceEvent } from "../data/types";
import { buildPulse, lastWorkday, periodStart, plainText, pulseFactsForAi, pulseMarkdown, pulseSentence, pulseSentenceParts, sinceWords, type PulseFacts } from "./pulse";

// Wednesday 30 September 2026
const TODAY = "2026-09-30";
const day = (offset: number) => { const d = new Date(2026, 8, 30 + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const at = (offset: number, hour = 10) => new Date(2026, 8, 30 + offset, hour).toISOString();

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...o,
});
const ev = (taskId: string, newValue: string, createdAt: string): WorkspaceEvent =>
  ({ id: "e-" + taskId + createdAt, taskId, actorId: "m-1", actorName: "Maya Lin", field: "status", oldValue: "progress", newValue, createdAt });

const members = [
  { id: "m-1", name: "Maya Lin", role: "Engineering" },
  { id: "m-2", name: "Theo Vance", role: "Growth" },
  { id: "m-4", name: "Idris Bell", role: "Guest", guest: true },
];

const facts = (totals: Partial<PulseFacts["totals"]>, extra: Partial<PulseFacts> = {}): PulseFacts => ({
  since: day(-1), today: TODAY, period: "day", people: [],
  totals: { done: 0, inFlight: 0, blocked: 0, overCapacity: [], ...totals }, ...extra,
});

describe("lastWorkday and the period", () => {
  it("looks back to Friday from Monday and the weekend, otherwise to yesterday", () => {
    expect(lastWorkday("2026-10-05")).toBe("2026-10-02"); // Mon → Fri
    expect(lastWorkday("2026-10-04")).toBe("2026-10-02"); // Sun → Fri
    expect(lastWorkday("2026-10-03")).toBe("2026-10-02"); // Sat → Fri
    expect(lastWorkday(TODAY)).toBe("2026-09-29");         // Wed → Tue
    expect(lastWorkday(new Date(2026, 9, 6))).toBe("2026-10-05");
  });

  it("'this week' starts on Monday; the words say yesterday or the weekday", () => {
    expect(periodStart("week", TODAY)).toBe("2026-09-28");
    expect(periodStart("day", TODAY)).toBe("2026-09-29");
    expect(sinceWords("2026-09-29", TODAY)).toBe("yesterday");
    expect(sinceWords("2026-10-02", "2026-10-05")).toBe("Friday");
  });
});

describe("buildPulse", () => {
  it("done since the last workday comes from completedAt, or a status change to done", () => {
    const tasks = [
      task({ id: "a", title: "Finished yesterday", status: "done", completedAt: day(-1), assigneeId: "m-1" }),
      task({ id: "b", title: "Finished last week", status: "done", completedAt: day(-6), assigneeId: "m-1" }),
      task({ id: "c", title: "Done by event", status: "done", assigneeId: "m-2" }),
      task({ id: "d", title: "Reopened since", status: "progress", assigneeId: "m-2" }),
    ];
    const f = buildPulse({ tasks, members, events: [ev("c", "done", at(0, 9)), ev("d", "done", at(-1))], today: TODAY });
    expect(f.since).toBe("2026-09-29");
    expect(f.people.find((p) => p.id === "m-1")!.done.map((t) => t.id)).toEqual(["a"]);
    expect(f.people.find((p) => p.id === "m-2")!.done.map((t) => t.id)).toEqual(["c"]);
    expect(f.totals.done).toBe(2);
    expect(f.changes).toBe(2);
    // "this week" reaches back to Monday
    expect(buildPulse({ tasks, members, today: TODAY, period: "week" }).totals.done).toBe(1);
  });

  it("on today = in progress or review, due today (or late), or planned today; blocked is listed apart", () => {
    const tasks = [
      task({ id: "p", status: "progress", assigneeId: "m-1", dueDate: day(10) }),
      task({ id: "r", status: "review", assigneeId: "m-1" }),
      task({ id: "due", status: "todo", assigneeId: "m-1", dueDate: day(0) }),
      task({ id: "late", status: "todo", assigneeId: "m-1", dueDate: day(-2) }),
      task({ id: "plan", status: "todo", assigneeId: "m-1", planToday: true }),
      task({ id: "later", status: "todo", assigneeId: "m-1", dueDate: day(4) }),
      task({ id: "blk", status: "blocked", assigneeId: "m-1", dueDate: day(0) }),
    ];
    const maya = buildPulse({ tasks, members, today: TODAY }).people.find((p) => p.id === "m-1")!;
    expect(maya.onToday.map((t) => t.id)).toEqual(["p", "r", "late", "due", "plan"]);
    expect(maya.blocked.map((t) => t.id)).toEqual(["blk"]);
  });

  it("carries this week's load against capacity, names who is over, and lists guests last", () => {
    const tasks = [
      task({ assigneeId: "m-2", effortHours: 30, dueDate: day(1) }),
      task({ assigneeId: "m-2", effortHours: 15, dueDate: day(2) }),
      task({ assigneeId: "m-4", effortHours: 80, dueDate: day(2) }),
      task({ assigneeId: "m-1", effortHours: 10, dueDate: day(2) }),
    ];
    const f = buildPulse({ tasks, members, today: TODAY, capacities: { "m-1": 20 } });
    expect(f.people.map((p) => [p.name, p.loadHours, p.capacity])).toEqual([
      ["Theo Vance", 45, 40], ["Maya Lin", 10, 20], ["Idris Bell", 80, 40],
    ]);
    expect(f.totals.overCapacity).toEqual(["Theo"]);
  });
});

describe("pulseSentence", () => {
  it("the everyday sentence", () => {
    expect(pulseSentence(facts({ done: 6, inFlight: 8, blocked: 1, overCapacity: ["Maya"] })))
      .toBe("Since yesterday the team finished 6 tasks. 8 are in flight, 1 is blocked and Maya is over capacity.");
  });
  it("Monday looks back to Friday", () => {
    expect(pulseSentence(facts({ done: 1, inFlight: 1 }, { since: "2026-10-02", today: "2026-10-05" })))
      .toBe("Since Friday the team finished 1 task. 1 is in flight and nothing is blocked.");
  });
  it("zero variants", () => {
    expect(pulseSentence(facts({}))).toBe("Nothing has been finished since yesterday. Nothing is in flight and nothing is blocked.");
    expect(pulseSentence(facts({}, { period: "week", since: day(-2) }))).toBe("Nothing has been finished this week yet. Nothing is in flight and nothing is blocked.");
  });
  it("this week, and more than one person over capacity", () => {
    expect(pulseSentence(facts({ done: 2, inFlight: 3, overCapacity: ["Maya", "Theo"] }, { period: "week" })))
      .toBe("This week the team has finished 2 tasks. 3 are in flight and Maya and Theo are over capacity.");
    expect(pulseSentence(facts({ done: 2, inFlight: 3, blocked: 2, overCapacity: ["A", "B", "C"] })))
      .toBe("Since yesterday the team finished 2 tasks. 3 are in flight, 2 are blocked and 3 people are over capacity.");
  });
  it("the figures and names are the strong runs", () => {
    const strong = pulseSentenceParts(facts({ done: 6, inFlight: 8, blocked: 1, overCapacity: ["Maya"] })).filter((p) => p.strong).map((p) => p.text);
    expect(strong).toEqual(["6 tasks", "8", "1", "Maya"]);
  });
});

describe("pulseMarkdown", () => {
  it("a Slack heading, the lede and a line per person", () => {
    const tasks = [
      task({ title: "Spike: token rotation", status: "done", completedAt: day(0), assigneeId: "m-1" }),
      task({ title: "Migrate auth", status: "progress", assigneeId: "m-1" }),
      task({ title: "Ship onboarding", status: "blocked", assigneeId: "m-1" }),
    ];
    const md = pulseMarkdown(buildPulse({ tasks, members: members.slice(0, 2), today: TODAY }));
    expect(md.split("\n")).toEqual([
      "*Pulse — Wed 30 Sep*",
      "Since yesterday the team finished 1 task. 1 is in flight and 1 is blocked.",
      "",
      "• *Maya* — done: Spike: token rotation; today: Migrate auth; blocked: Ship onboarding",
      "• *Theo* — nothing to report",
    ]);
    expect(plainText(md).split("\n")[0]).toBe("Pulse — Wed 30 Sep");
  });

  it("long lists end with a count", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => task({ title: `Item ${i + 1}`, status: "progress", assigneeId: "m-1" }));
    const md = pulseMarkdown(buildPulse({ tasks, members: members.slice(0, 1), today: TODAY }));
    expect(md).toContain("today: Item 1, Item 2, Item 3, Item 4, Item 5 +2 more");
  });
});

describe("pulseFactsForAi", () => {
  it("sends names and titles only, bounded", () => {
    const tasks = [task({ title: "Secret-free title", status: "progress", assigneeId: "m-1", description: "private notes" })];
    const out = JSON.stringify(pulseFactsForAi(buildPulse({ tasks, members, today: TODAY })));
    expect(out).toContain("Secret-free title");
    expect(out).not.toContain("private notes");
    expect(out).not.toContain('"id"');
  });
});
