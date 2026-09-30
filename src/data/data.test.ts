import { describe, it, expect, afterEach, vi } from "vitest";
import {
  parseCapture, planDay, planDayDetailed, dueState, fmtDue, dueOffset, energyOf,
  projectProgress, blockingTasks, memberInitials, dayOffset, EVENTS,
  DAY_START, DAY_END, nextDueDate, nextOccurrence, nextOccurrenceChildren,
  refreshClock, KANBO_TODAY, NOW_MIN, presetDate, todayISO, parseTaskTokens,
  seriesAnchorDay, TASKS, DEMO_ACTIVITY, DEMO_TASK_EVENTS, DEMO_GOALS, DEMO_PORTFOLIOS, DEMO_STATUS_UPDATES,
  DEMO_RULES, DEMO_FORMS,
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
    const placed = planDay(tasks, EVENTS, { nowMin: DAY_START });
    expect(Object.keys(placed).sort()).toEqual(["a", "b"]);
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

/* ---------- live clock ---------- */
describe("refreshClock (tabs left open overnight)", () => {
  afterEach(() => { refreshClock(); }); // back to the real wall clock

  it("rolls today forward in place at midnight", () => {
    const held = KANBO_TODAY; // what every importer holds
    refreshClock(new Date(2026, 8, 30, 23, 58));
    expect(todayISO()).toBe("2026-09-30");
    expect(NOW_MIN).toBe(23 * 60 + 58);

    // same day → no change
    expect(refreshClock(new Date(2026, 8, 30, 23, 59))).toBe(false);
    expect(NOW_MIN).toBe(23 * 60 + 59);

    // past midnight → new day, same Date object
    expect(refreshClock(new Date(2026, 9, 1, 0, 1))).toBe(true);
    expect(held).toBe(KANBO_TODAY);
    expect(held.getFullYear()).toBe(2026);
    expect(held.getMonth()).toBe(9);
    expect(held.getDate()).toBe(1);
    expect(held.getHours()).toBe(0);
    expect(NOW_MIN).toBe(1); // live binding
  });

  it("makes every relative-date helper answer for the new day", () => {
    refreshClock(new Date(2026, 8, 30, 18, 0)); // Wednesday
    expect(dueState("2026-09-30", "todo")).toBe("today");
    refreshClock(new Date(2026, 9, 1, 8, 30)); // next morning, same tab
    expect(dayOffset(0)).toBe("2026-10-01");
    expect(presetDate("today")).toBe("2026-10-01");
    expect(presetDate("tomorrow")).toBe("2026-10-02");
    expect(dueState("2026-09-30", "todo")).toBe("overdue");
    expect(dueState("2026-10-01", "todo")).toBe("today");
    expect(fmtDue("2026-10-02")).toBe("Tomorrow");
    expect(fmtDue("2026-09-30")).toBe("Yesterday");
    expect(dueOffset("2026-10-01")).toBe(0);
    // quick capture "…today" writes the real today
    expect(parseCapture("Call supplier today")!.dueDate).toBe("2026-10-01");
  });

  it("handles month, year and DST boundaries", () => {
    refreshClock(new Date(2026, 11, 31, 23, 59));
    expect(refreshClock(new Date(2027, 0, 1, 0, 0))).toBe(true);
    expect(todayISO()).toBe("2027-01-01");
    // UK clocks go forward on 29 Mar 2026 — still exactly one day per step
    refreshClock(new Date(2026, 2, 28, 12, 0));
    expect(refreshClock(new Date(2026, 2, 29, 12, 0))).toBe(true);
    expect(todayISO()).toBe("2026-03-29");
    expect(dayOffset(1)).toBe("2026-03-30");
  });
});

/* ---------- recurrence ---------- */
describe("nextDueDate monthly clamping", () => {
  afterEach(() => { refreshClock(); });

  it("clamps to the last day of shorter months instead of skipping them", () => {
    refreshClock(new Date(2026, 0, 10, 9, 0));
    expect(nextDueDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextDueDate("2026-03-31", "monthly")).toBe("2026-04-30");
    expect(nextDueDate("2026-01-15", "monthly")).toBe("2026-02-15");
    expect(nextDueDate("2026-12-31", "monthly")).toBe("2027-01-31");
    refreshClock(new Date(2026, 7, 1, 9, 0));
    expect(nextDueDate("2026-08-31", "monthly")).toBe("2026-09-30"); // not 1 Oct
    refreshClock(new Date(2028, 0, 10, 9, 0));
    expect(nextDueDate("2028-01-31", "monthly")).toBe("2028-02-29"); // leap year
  });

  it("returns to the anchor day after a short month", () => {
    refreshClock(new Date(2026, 1, 1, 9, 0));
    expect(nextDueDate("2026-02-28", "monthly", 31)).toBe("2026-03-31");
    expect(nextDueDate("2026-02-28", "monthly", 30)).toBe("2026-03-30");
    expect(nextDueDate("2026-02-28", "monthly")).toBe("2026-03-28");
    // a chain previewed with its anchor stays on the 31st where it can
    const chain: string[] = [];
    let cur = "2026-01-31";
    for (let i = 0; i < 4; i++) { cur = nextDueDate(cur, "monthly", 31); chain.push(cur); }
    expect(chain).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]);
  });

  it("keeps the anchor while rolling an old date forward past today", () => {
    refreshClock(new Date(2026, 4, 10, 9, 0)); // 10 May
    expect(nextDueDate("2026-01-31", "monthly")).toBe("2026-05-31");
  });

  it("leaves the other rules as they were", () => {
    refreshClock(new Date(2026, 0, 1, 9, 0));
    expect(nextDueDate("2026-01-16", "weekdays")).toBe("2026-01-19"); // Fri → Mon
    expect(nextDueDate("2026-01-14", "weekdays")).toBe("2026-01-15");
    expect(nextDueDate("2026-01-16", "biweekly")).toBe("2026-01-30");
    expect(nextDueDate("2026-01-16", "weekly")).toBe("2026-01-23");
    expect(nextDueDate("2026-01-16", "none")).toBe("2026-01-16");
    // garbage in → today-based, never "NaN-NaN-NaN"
    expect(nextDueDate("not-a-date", "daily")).toBe("2026-01-02");
  });

  it("ignores an anchor that isn't a number", () => {
    // e.g. new Date(badValue).getDate() from stored data
    refreshClock(new Date(2026, 8, 1, 9, 0));
    expect(nextDueDate("2026-09-30", "monthly", NaN)).toBe("2026-10-30");
    expect(nextDueDate("2026-09-30", "monthly", Infinity)).toBe("2026-10-30");
    // rolled forward past today on its own day (31st), clamped to 30 Sep
    expect(nextDueDate("2026-01-31", "monthly", NaN)).toBe("2026-09-30");
  });
});

describe("nextOccurrence", () => {
  afterEach(() => { refreshClock(); });

  it("starts the next occurrence fresh", () => {
    refreshClock(new Date(2026, 0, 5, 9, 0));
    const done = task({
      id: "r1", status: "done", recurrence: "weekly", dueDate: "2026-01-09", startDate: "2026-01-06",
      completedAt: "2026-01-09", loggedHours: 3, reactions: { "👍": ["u1"] }, comments: 4,
      dependencies: ["x"], scheduled: 600, planToday: true, originalDueDate: "2026-01-08",
      createdAt: "2026-01-01T09:00:00Z", archivedAt: undefined, followers: ["u2"], effortHours: 4,
      subtasks: [{ id: "s1", title: "Check", done: true }],
    });
    const next = nextOccurrence(done, "r2");
    expect(next.id).toBe("r2");
    expect(next.status).toBe("todo");
    expect(next.dueDate).toBe("2026-01-16");
    expect(next.startDate).toBe("2026-01-13"); // moved with the due date — same length bar
    expect(next.loggedHours).toBeUndefined(); // no double-counted timesheets
    expect(next.reactions).toBeUndefined();
    expect(next.comments).toBe(0);
    expect(next.dependencies).toEqual([]);
    expect(next.completedAt).toBeUndefined();
    expect(next.createdAt).toBeUndefined();
    expect(next.originalDueDate).toBeUndefined();
    expect(next.scheduled).toBeNull();
    expect(next.planToday).toBe(false);
    expect(next.subtasks).toEqual([{ id: "s1", title: "Check", done: false }]);
    // the work itself carries over
    expect(next.recurrence).toBe("weekly");
    expect(next.followers).toEqual(["u2"]);
    expect(next.effortHours).toBe(4);
    // the finished task is untouched
    expect(done.loggedHours).toBe(3);
    expect(done.subtasks[0].done).toBe(true);
  });

  it("keeps a monthly series on its anchor day", () => {
    refreshClock(new Date(2026, 1, 1, 9, 0));
    const feb = task({ id: "m", recurrence: "monthly", dueDate: "2026-02-28" });
    expect(nextOccurrence(feb, "m2", 31).dueDate).toBe("2026-03-31");
  });

  it("remembers a month-end series' day across short months without being told", () => {
    // spawned occurrence after occurrence, as App does — no anchor passed in
    refreshClock(new Date(2026, 0, 5, 9, 0));
    let cur = task({ id: "r0", recurrence: "monthly", dueDate: "2026-01-31" });
    const dues: string[] = [];
    for (let i = 1; i <= 5; i++) { cur = nextOccurrence(cur, "r" + i); dues.push(cur.dueDate!); }
    expect(dues).toEqual(["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31", "2026-06-30"]);
    expect(cur.originalDueDate).toBe("2026-01-31");
  });

  it("keeps a 28th series on the 28th, and follows a date the user moved", () => {
    refreshClock(new Date(2026, 0, 5, 9, 0));
    // payday on the 28th: 28 Feb is the end of the month, but the series' day is 28
    let pay = task({ id: "p0", recurrence: "monthly", dueDate: "2026-01-28" });
    pay = nextOccurrence(pay, "p1");
    expect(pay.dueDate).toBe("2026-02-28");
    expect(nextOccurrence(pay, "p2").dueDate).toBe("2026-03-28");
    // someone moved this occurrence to the 15th: the series moves with it
    const moved = task({ id: "x", recurrence: "monthly", dueDate: "2026-03-15", originalDueDate: "2026-01-31" });
    const after = nextOccurrence(moved, "x2");
    expect(after.dueDate).toBe("2026-04-15");
    expect(after.originalDueDate).toBe("2026-03-15");
  });

  it("seriesAnchorDay only trusts originalDueDate for a date that may have been clamped", () => {
    expect(seriesAnchorDay({ dueDate: "2026-02-28", originalDueDate: "2026-01-31" })).toBe(31);
    expect(seriesAnchorDay({ dueDate: "2026-04-30", originalDueDate: "2026-01-31" })).toBe(31);
    expect(seriesAnchorDay({ dueDate: "2026-02-27", originalDueDate: "2026-01-31" })).toBe(27);
    expect(seriesAnchorDay({ dueDate: "2026-02-28", originalDueDate: "2026-01-20" })).toBe(28);
    expect(seriesAnchorDay({ dueDate: "2026-02-28" })).toBe(28);
    expect(seriesAnchorDay({})).toBeUndefined();
    expect(seriesAnchorDay({ dueDate: "rubbish" })).toBeUndefined();
  });

  it("carries child sub-tasks over, reset and re-parented", () => {
    refreshClock(new Date(2026, 0, 5, 9, 0));
    const parent = task({ id: "p1", recurrence: "weekly", dueDate: "2026-01-09", projectId: "p-launch", workspaceId: "ws-1" });
    const kids = [
      task({ id: "c1", parentId: "p1", status: "done", dueDate: "2026-01-08", loggedHours: 1, completedAt: "2026-01-08" }),
      task({ id: "c2", parentId: "p1", status: "todo" }),
      task({ id: "c3", parentId: "p1", archivedAt: "2026-01-02" }), // archived — stays behind
      task({ id: "c4", parentId: "someone-else" }),
    ];
    const next = { ...nextOccurrence(parent, "tmp"), id: "p2-saved" };
    let n = 0;
    const clones = nextOccurrenceChildren(kids, parent, next, () => "new-" + (++n));
    expect(clones.map((c) => c.id)).toEqual(["new-1", "new-2"]);
    expect(clones.every((c) => c.parentId === "p2-saved" && c.status === "todo" && c.projectId === "p-launch" && c.workspaceId === "ws-1")).toBe(true);
    expect(clones[0].dueDate).toBe("2026-01-15"); // moved a week with its parent
    expect(clones[0].loggedHours).toBeUndefined();
    expect(clones[0].completedAt).toBeUndefined();
    expect(clones[1].dueDate).toBeUndefined();
  });

  it("leaves sub-tasks that repeat on their own to their own series", () => {
    refreshClock(new Date(2026, 0, 5, 9, 0));
    const parent = task({ id: "p1", recurrence: "monthly", dueDate: "2026-01-30" });
    const kids = [
      // a weekly check-in under the monthly parent: done once, and its own next
      // occurrence was already spawned under the same parent
      task({ id: "w1", parentId: "p1", recurrence: "weekly", status: "done", dueDate: "2026-01-09" }),
      task({ id: "w2", parentId: "p1", recurrence: "weekly", status: "todo", dueDate: "2026-01-16" }),
      task({ id: "c1", parentId: "p1", recurrence: "none", title: "Checklist item" }),
      task({ id: "c2", parentId: "p1", title: "No recurrence field" }),
    ];
    const next = { ...nextOccurrence(parent, "tmp"), id: "p2" };
    let n = 0;
    const clones = nextOccurrenceChildren(kids, parent, next, () => "k" + (++n));
    expect(clones.map((c) => c.title)).toEqual(["Checklist item", "No recurrence field"]);
  });
});

/* ---------- auto-plan ---------- */
describe("planDay (auto-plan)", () => {
  const within = (s: number, dur: number, b: { start: number; end: number }) => s < b.end && s + dur > b.start;

  it("never lays a task over a block that is already on the day", () => {
    // the planned block sorts AFTER the new task (due later), which is how the
    // old planner missed it
    const existing = task({ id: "planned", scheduled: 13 * 60, dur: 60, energy: "admin", dueDate: dayOffset(5) });
    const fresh = task({ id: "new", dur: 30, energy: "admin", dueDate: dayOffset(0), priority: "urgent" });
    const placed = planDay([fresh, existing], [], { nowMin: 12 * 60 + 30 });
    expect(placed.planned).toBeUndefined(); // already placed — left alone
    expect(placed.new).toBeDefined();
    expect(within(placed.new, 30, { start: 13 * 60, end: 14 * 60 })).toBe(false);
  });

  it("respects done tasks' blocks but never schedules a done task", () => {
    const doneBlock = task({ id: "d", status: "done", scheduled: 13 * 60, dur: 120 });
    const doneLoose = task({ id: "dl", status: "done", dur: 30 });
    const t1 = task({ id: "t1", dur: 30, energy: "admin" });
    const { placed, unplaced } = planDayDetailed([doneBlock, doneLoose, t1], [], { nowMin: 12 * 60 + 30 });
    expect(placed.dl).toBeUndefined();
    expect(unplaced.map((t) => t.id)).toEqual([]);
    expect(placed.t1).toBeGreaterThanOrEqual(15 * 60);
  });

  it("never places anything in the past, and snaps to 5 minutes", () => {
    const now = 15 * 60 + 3; // 3:03pm
    const tasks = [
      task({ id: "deep", dur: 60, energy: "deep", dueDate: dayOffset(0) }),
      task({ id: "admin1", dur: 25, energy: "admin", dueDate: dayOffset(0) }),
      task({ id: "admin2", dur: 30, energy: "admin", dueDate: dayOffset(1) }),
    ];
    const placed = planDay(tasks, EVENTS, { nowMin: now });
    expect(Object.keys(placed).sort()).toEqual(["admin1", "admin2", "deep"]);
    for (const [id, start] of Object.entries(placed)) {
      const t = tasks.find((x) => x.id === id)!;
      expect(start).toBeGreaterThanOrEqual(15 * 60 + 5);
      expect(start % 5).toBe(0);
      expect(start + (t.dur || t.focusMin)).toBeLessThanOrEqual(DAY_END);
      for (const e of EVENTS) expect(within(start, t.dur || t.focusMin, e)).toBe(false);
    }
    // placements never overlap each other either
    const spans = Object.entries(placed).map(([id, s]) => ({ start: s, end: s + (tasks.find((x) => x.id === id)!.dur || 30) }));
    for (let i = 0; i < spans.length; i++) for (let j = i + 1; j < spans.length; j++) {
      expect(within(spans[i].start, spans[i].end - spans[i].start, spans[j])).toBe(false);
    }
  });

  it("snaps around calendar events that end off the grid", () => {
    const placed = planDay([task({ id: "a", dur: 30, energy: "deep" })], [
      { id: "odd", title: "Odd call", start: 7 * 60, end: 7 * 60 + 52, kind: "meeting" },
    ], { nowMin: 6 * 60 });
    expect(placed.a).toBe(7 * 60 + 55);
  });

  it("returns what doesn't fit instead of running past the end of the day", () => {
    const tasks = [
      task({ id: "fits", dur: 30, energy: "admin", dueDate: dayOffset(0) }),
      task({ id: "too-long", dur: 90, energy: "admin", dueDate: dayOffset(0) }),
    ];
    const { placed, unplaced } = planDayDetailed(tasks, [], { nowMin: DAY_END - 45 });
    expect(Object.keys(placed)).toEqual(["fits"]);
    expect(placed.fits + 30).toBeLessThanOrEqual(DAY_END);
    expect(unplaced.map((t) => t.id)).toEqual(["too-long"]);
    // after the end of the day nothing is placed at all
    const late = planDayDetailed(tasks, [], { nowMin: DAY_END + 10 });
    expect(late.placed).toEqual({});
    expect(late.unplaced).toHaveLength(2);
  });

  it("uses the live time when none is given", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 8, 30, 16, 2));
      const placed = planDay([task({ id: "a", dur: 30, energy: "deep" })], []);
      expect(placed.a).toBe(16 * 60 + 5);
    } finally { vi.useRealTimers(); }
  });
});

/* ---------- natural-language capture ---------- */
describe("parseCapture phrases", () => {
  it("'Focus group prep' is a title, not a deep-work block", () => {
    const t = parseCapture("Focus group prep")!;
    expect(t.title).toBe("Focus group prep");
    expect(t.energy).not.toBe("deep");
  });

  it("still reads deep/focus as energy when followed by 'work' or at the end", () => {
    expect(parseCapture("Write board memo focus")!).toMatchObject({ title: "Write board memo", energy: "deep" });
    expect(parseCapture("Pricing model 2h focus time")!).toMatchObject({ title: "Pricing model", energy: "deep", dur: 120 });
    const lead = parseCapture("Deep work on the pricing model")!;
    expect(lead.energy).toBe("deep");
    expect(lead.title).toBe("Deep work on the pricing model");
    expect(parseCapture("Deep dive into churn")!.energy).not.toBe("deep");
  });

  it("understands hr / hrs / hours and mixed durations", () => {
    expect(parseCapture("Prepare 3 hrs review")!).toMatchObject({ dur: 180, title: "Prepare review" });
    expect(parseCapture("Budget 1 hr")!.dur).toBe(60);
    expect(parseCapture("Budget 2 hours")!.dur).toBe(120);
    expect(parseCapture("Budget 1.5h")!.dur).toBe(90);
    expect(parseCapture("Budget 1h30")!.dur).toBe(90);
    expect(parseCapture("Budget 1h 30m")!.dur).toBe(90);
    expect(parseCapture("Budget 45 mins")!.dur).toBe(45);
    // "Q3" and "3pm" aren't durations
    expect(parseCapture("Plan Q3 offsite")!).toMatchObject({ dur: 30, title: "Plan Q3 offsite" });
    expect(parseCapture("Call Sam at 3pm")!.title).toBe("Call Sam at 3pm");
  });

  it("leaves \"today's\" in the title and doesn't invent a date", () => {
    const t = parseCapture("Review today's numbers")!;
    expect(t.title).toBe("Review today's numbers");
    expect(t.dueDate).toBeUndefined();
    expect(parseCapture("Prep tomorrow’s agenda")!.title).toBe("Prep tomorrow’s agenda");
  });

  it("has no due date unless one is said", () => {
    expect(parseCapture("Call supplier")!.dueDate).toBeUndefined();
    expect(parseCapture("Call supplier today")!).toMatchObject({ title: "Call supplier", dueDate: dayOffset(0) });
    expect(parseCapture("Send invoice by tomorrow")!).toMatchObject({ title: "Send invoice", dueDate: dayOffset(1) });
    expect(parseCapture("Draft plan next week")!.dueDate).toBe(dayOffset(7));
  });

  it("reads urgent / asap / !! as high priority", () => {
    expect(parseCapture("Fix login asap")!).toMatchObject({ priority: "high", title: "Fix login" });
    expect(parseCapture("Fix login !!")!).toMatchObject({ priority: "high", title: "Fix login" });
    expect(parseCapture("Fix login")!.priority).toBe("medium");
  });

  it("files into the caller's project and assignee", () => {
    const t = parseCapture("Draft Q3 deck 90m deep work today", { projectId: "p-launch", assigneeId: "u-123" })!;
    expect(t.projectId).toBe("p-launch");
    expect(t.assigneeId).toBe("u-123");
    // without options it falls back to Personal and the signed-in member
    const d = parseCapture("Stretch")!;
    expect(d.projectId).toBe("p-personal");
    expect(d.assigneeId).toBe("m-self");
  });

  it("uses built-in tag ids in demo mode only", async () => {
    expect(parseCapture("Write chapter deep work")!.tags).toEqual(["writing"]);
    vi.resetModules();
    vi.doMock("../lib/supabase", () => ({ isSupabaseConfigured: true, supabase: null }));
    try {
      const real = await import("./data");
      const t = real.parseCapture("Write chapter deep work")!;
      expect(t.energy).toBe("deep"); // energy is still read…
      expect(t.tags).toEqual([]);    // …but no demo tag id is written
    } finally {
      vi.doUnmock("../lib/supabase");
      vi.resetModules();
    }
  });
});

describe("capture tokens are cut where they were found", () => {
  it("keeps an earlier look-alike word in the title", () => {
    expect(parseCapture("Review today's numbers today")!).toMatchObject({ title: "Review today's numbers", dueDate: dayOffset(0) });
    expect(parseCapture("Prep tomorrow's agenda tomorrow")!).toMatchObject({ title: "Prep tomorrow's agenda", dueDate: dayOffset(1) });
    expect(parseCapture("Send next week's rota next week")!).toMatchObject({ title: "Send next week's rota", dueDate: dayOffset(7) });
    expect(parseCapture("Upload 30mb file 30m")!).toMatchObject({ title: "Upload 30mb file", dur: 30 });
    expect(parseCapture("Chase asaparagus supplier asap")!).toMatchObject({ title: "Chase asaparagus supplier", priority: "high" });
    expect(parseTaskTokens("Review today's numbers today")).toMatchObject({ title: "Review today's numbers", dueDate: dayOffset(0) });
    expect(parseTaskTokens("Upload 30mb file 30m")).toMatchObject({ title: "Upload 30mb file", focusMin: 30 });
    expect(parseTaskTokens("Fix !highway sign !high")).toMatchObject({ title: "Fix !highway sign", priority: "high" });
  });

  it("reads tokens in brackets or after a comma, and tidies what's left", () => {
    expect(parseCapture("Write report (2h)")!).toMatchObject({ title: "Write report", dur: 120 });
    expect(parseCapture("Standup (15m) today")!).toMatchObject({ title: "Standup", dur: 15, dueDate: dayOffset(0) });
    expect(parseCapture("Book dentist [tomorrow]")!).toMatchObject({ title: "Book dentist", dueDate: dayOffset(1) });
    expect(parseCapture("Draft deck (deep work)")!).toMatchObject({ title: "Draft deck", energy: "deep" });
    expect(parseCapture("Call supplier,today")!).toMatchObject({ title: "Call supplier", dueDate: dayOffset(0) });
    expect(parseCapture("Call supplier (by tomorrow)")!).toMatchObject({ title: "Call supplier", dueDate: dayOffset(1) });
    expect(parseTaskTokens("Write report (2h), tomorrow")).toMatchObject({ title: "Write report", focusMin: 120, dueDate: dayOffset(1) });
    expect(parseCapture("Practise 10,000 hours")!).toMatchObject({ title: "Practise 10,000 hours", dur: 30 });
    // brackets that aren't a token's are left alone
    expect(parseCapture("Fix parseDate() crash")!.title).toBe("Fix parseDate() crash");
    expect(parseTaskTokens("Fix parseDate() crash tomorrow").title).toBe("Fix parseDate() crash");
    expect(parseCapture("Plan (Q3) offsite")!.title).toBe("Plan (Q3) offsite");
    // quick-add keeps a leading dash or trailing colon a title may need
    expect(parseTaskTokens("-5% churn: tomorrow").title).toBe("-5% churn:");
  });

  it("doesn't read a date out of a word or a number that belongs to the title", () => {
    for (const text of ["Fix 24/7 monitoring", "Review weekend sales", "Plan the weekend", "Monday standup notes", "Split the 50/50 budget"]) {
      expect(parseCapture(text)!).toMatchObject({ title: text, dueDate: undefined });
      expect(parseTaskTokens(text)).toEqual({ title: text });
    }
  });
});

describe("parseTaskTokens shares the fixes", () => {
  it("keeps apostrophes and reads hrs", () => {
    const a = parseTaskTokens("Review today's numbers");
    expect(a.title).toBe("Review today's numbers");
    expect(a.dueDate).toBeUndefined();
    const b = parseTaskTokens("Prepare 3 hrs review !high tomorrow");
    expect(b).toMatchObject({ focusMin: 180, priority: "high", dueDate: dayOffset(1), title: "Prepare review" });
    expect(parseTaskTokens("Email Sara tomorrow 90m").title).toBe("Email Sara");
    expect(parseTaskTokens("Plan next week").dueDate).toBe(dayOffset(7));
  });
});

/* ---------- the living demo ---------- */
describe("demo seed", () => {
  const byId = (id: string) => TASKS.find((t) => t.id === id)!;

  it("keeps t-1…t-16 where tests expect them, and adds t-17…t-30", () => {
    expect(TASKS.map((t) => t.id)).toEqual(Array.from({ length: 30 }, (_, i) => `t-${i + 1}`));
    expect(byId("t-1")).toMatchObject({ title: "Finalise Q3 launch narrative deck", status: "progress", projectId: "p-launch", assigneeId: "m-self" });
    expect(byId("t-1").subtasks.filter((s) => s.done)).toHaveLength(2);
    expect(byId("t-2")).toMatchObject({ status: "blocked", assigneeId: "m-1", dependencies: ["t-4"] });
    expect(TASKS.every((t) => !!t.createdBy && !!t.createdAt)).toBe(true);
  });

  it("writes British English", () => {
    const copy = TASKS.flatMap((t) => [t.title, t.description, t.aiReason ?? ""]).join(" ");
    expect(copy).not.toMatch(/\b(finalize|color|organize|prioritize|canceled)\b/i);
  });

  it("puts Maya over a 40h week and leaves the press release unowned", () => {
    const maya = ["t-2", "t-6", "t-10", "t-18"].reduce((h, id) => h + (byId(id).effortHours ?? 0), 0);
    expect(maya).toBe(44);
    expect(byId("t-17")).toMatchObject({ assigneeId: "", dueDate: dayOffset(2), projectId: "p-launch" });
    // the deck really is holding up three tasks
    expect(TASKS.filter((t) => t.dependencies.includes("t-1")).map((t) => t.id)).toEqual(["t-17", "t-20", "t-23"]);
    expect(byId("t-23").isMilestone).toBe(true);
  });

  it("has a date that slipped twice and a task that went quiet", () => {
    expect(byId("t-3").originalDueDate).toBe(dayOffset(-4));
    const slips = DEMO_TASK_EVENTS.filter((e) => e.taskId === "t-3" && e.field === "due");
    expect(slips.map((e) => e.newValue).sort()).toEqual([dayOffset(-1), dayOffset(3)].sort());
    const t9 = DEMO_TASK_EVENTS.filter((e) => e.taskId === "t-9");
    expect(t9).toHaveLength(1);
    expect(Date.now() - Date.parse(t9[0].createdAt)).toBeGreaterThan(8 * 86400000);
    expect(Date.now() - Date.parse(byId("t-9").createdAt!)).toBeGreaterThan(19 * 86400000);
  });

  it("gives Pulse two days of history, newest first, by real people", () => {
    const names = new Set(DEMO_TASK_EVENTS.filter((e) => Date.now() - Date.parse(e.createdAt) < 3 * 86400000).map((e) => e.actorName));
    expect([...names]).toEqual(expect.arrayContaining(["Maya Lin", "Theo Vance", "Sana Rao"]));
    const times = DEMO_TASK_EVENTS.map((e) => e.createdAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(DEMO_TASK_EVENTS.every((e) => TASKS.some((t) => t.id === e.taskId))).toBe(true);
  });

  it("fills the Inbox, Goals, Portfolios, updates, Rules and Requests", () => {
    expect(DEMO_ACTIVITY).toHaveLength(6);
    expect(DEMO_ACTIVITY.filter((a) => !a.readAt).map((a) => a.kind).sort()).toEqual(["assigned", "mention"]);
    expect(DEMO_ACTIVITY.every((a) => a.taskTitle === TASKS.find((t) => t.id === a.taskId)?.title)).toBe(true);
    expect(DEMO_GOALS.map((g) => g.status)).toEqual(["on_track", "at_risk"]);
    expect(DEMO_PORTFOLIOS).toEqual([expect.objectContaining({ name: "Q3 launch", projectIds: ["p-launch", "p-brand", "p-infra"] })]);
    expect(DEMO_STATUS_UPDATES.some((u) => u.projectId === "p-infra")).toBe(false);
    expect(DEMO_RULES[0]).toMatchObject({ projectId: "p-launch", trigger: "task_created", actions: [{ type: "add_tag", value: "eng" }] });
    expect(DEMO_FORMS[0]).toMatchObject({ name: "Launch requests", fields: ["description", "priority", "dueDate"] });
    expect(EVENTS.map((e) => e.id)).toEqual(expect.arrayContaining(["e1", "e2", "e3", "e4", "e5"]));
  });
});
