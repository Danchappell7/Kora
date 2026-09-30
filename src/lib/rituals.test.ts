import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  isoWeek, readBig3, writeBig3, shutdownDone, markShutdownDone, leftovers, dayInColour, addDaysISO, nextMondayISO,
  nextWeekISO, shortDay, dayLabel, finishedToday, movePatch, redatePatch, leftoverChoices, beforeMove, closingLine, shutdownSummary, weekStartISO,
  reviewWeek, finishedThisWeek, carriedOver,
} from "./rituals";
import type { Task } from "../data/types";

const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...extra,
});
const at = (iso: string, h = 12) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d, h).toISOString(); };

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("rituals — isoWeek", () => {
  it.each([
    ["2026-09-30", "2026-W40"],   // today in the brief
    ["2026-01-01", "2026-W01"],   // a Thursday: week 1 of its own year
    ["2027-01-01", "2026-W53"],   // Friday: still the last week of 2026 (a 53-week year)
    ["2024-12-30", "2025-W01"],   // Monday: already week 1 of next year
    ["2021-01-03", "2020-W53"],   // Sunday: the week that began in 2020
    ["2026-12-28", "2026-W53"],
    ["2027-01-04", "2027-W01"],
  ])("%s is %s", (day, week) => {
    const [y, m, d] = day.split("-").map(Number);
    expect(isoWeek(new Date(y, m - 1, d))).toBe(week);
  });
});

describe("rituals — Big 3", () => {
  it("reads and writes per person and week, at most three, no duplicates", () => {
    writeBig3("me", ["a", "b", "a", "c", "d"], "2026-W40");
    expect(readBig3("me", "2026-W40")).toEqual(["a", "b", "c"]);
    expect(readBig3("me", "2026-W41")).toEqual([]);
    expect(readBig3("someone-else", "2026-W40")).toEqual([]);
    expect(localStorage.getItem("kanbo-big3:me:2026-W40")).toBe('["a","b","c"]');
  });

  it("an empty list clears the week", () => {
    writeBig3("me", ["a"], "2026-W40");
    writeBig3("me", [], "2026-W40");
    expect(localStorage.getItem("kanbo-big3:me:2026-W40")).toBeNull();
  });

  it("survives storage throwing (private mode) and junk in storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    expect(() => writeBig3("me", ["a"], "2026-W40")).not.toThrow();
    expect(readBig3("me", "2026-W40")).toEqual([]);
    expect(shutdownDone("me", "2026-09-30")).toBe(false);
    expect(() => markShutdownDone("me", "2026-09-30")).not.toThrow();
    vi.restoreAllMocks();
    localStorage.setItem("kanbo-big3:me:2026-W40", '{"not":"a list"}');
    expect(readBig3("me", "2026-W40")).toEqual([]);
    localStorage.setItem("kanbo-big3:me:2026-W40", '["a", 4, null, "b"]');
    expect(readBig3("me", "2026-W40")).toEqual(["a", "b"]);
  });

  it("remembers the shut down per person and day", () => {
    expect(shutdownDone("me", "2026-09-30")).toBe(false);
    markShutdownDone("me", "2026-09-30");
    expect(shutdownDone("me", "2026-09-30")).toBe(true);
    expect(shutdownDone("me", "2026-10-01")).toBe(false);
    expect(localStorage.getItem("kanbo-shutdown:me:2026-09-30")).toBe("1");
  });
});

describe("rituals — the shut down's arithmetic", () => {
  const today = "2026-09-30";

  it("leftovers are open tasks due, planned or scheduled today", () => {
    const ts = [
      task("due", { dueDate: today }),
      task("planned", { planToday: true, dueDate: "2026-10-04" }),
      task("scheduled", { scheduled: 600 }),
      task("done", { dueDate: today, status: "done" }),
      task("later", { dueDate: "2026-10-01" }),
      task("archived", { dueDate: today, archivedAt: "2026-09-29T10:00:00Z" }),
    ];
    expect(leftovers(ts, today).map((t) => t.id)).toEqual(["due", "planned", "scheduled"]);
  });

  it("finished today reads the completion time in local time", () => {
    const ts = [
      task("a", { status: "done", completedAt: at(today, 9) }),
      task("b", { status: "done", completedAt: at("2026-09-29", 23) }),
      task("c", { status: "done" }),                              // no completion time
      task("d", { status: "progress", completedAt: at(today) }),  // reopened
    ];
    expect(finishedToday(ts, today).map((t) => t.id)).toEqual(["a"]);
  });

  it("the day in colour splits minutes by project, largest first, with focus last", () => {
    const projects = [{ id: "p1", name: "Launch", color: "oklch(0.7 0.14 230)" }, { id: "p2", name: "Brand", color: "#c24be0" }];
    const done = [
      task("a", { projectId: "p1", dur: 45 }),
      task("b", { projectId: "p2", focusMin: 90 }),
      task("c", { projectId: "p1", focusMin: 30 }),
      task("d", { projectId: "p9", dur: 10 }),                    // unknown project
      task("e", { projectId: "p2" }),                             // no minutes: not counted
    ];
    const { segments, total } = dayInColour(done, projects, 42.4);
    expect(segments.map((s) => [s.key, s.label, s.minutes])).toEqual([
      ["p2", "Brand", 90], ["p1", "Launch", 75], ["p9", "Other", 10], ["focus", "Focus", 42],
    ]);
    expect(total).toBe(217);
    expect(segments[segments.length - 1].color).toBeUndefined();
  });

  it("dates move by local calendar days and next week starts on Monday", () => {
    expect(addDaysISO(today, 1)).toBe("2026-10-01");
    expect(addDaysISO("2026-10-24", 2)).toBe("2026-10-26");    // across the clocks going back
    expect(nextMondayISO(today)).toBe("2026-10-05");           // Wednesday → Monday
    expect(nextMondayISO("2026-10-05")).toBe("2026-10-12");    // a Monday → the next one
    expect(nextMondayISO("2026-10-04")).toBe("2026-10-05");    // Sunday → tomorrow
    expect(shortDay("2026-10-01")).toBe("Thu 1");
    expect(dayLabel("2026-09-30")).toBe("Wed 30 Sep");
    expect(weekStartISO(today)).toBe("2026-09-28");
    expect(weekStartISO("2026-10-04")).toBe("2026-09-28");     // Sunday belongs to the week before
  });

  it("on a Sunday, Next week is the Monday after tomorrow, never the same day as Tomorrow", () => {
    const sunday = "2026-10-04";
    expect(nextWeekISO(today)).toBe("2026-10-05");             // Wednesday: the coming Monday
    expect(nextWeekISO("2026-10-05")).toBe("2026-10-12");      // Monday: a week on
    expect(nextWeekISO(sunday)).toBe("2026-10-12");            // Sunday: not tomorrow
    expect(movePatch("tomorrow", sunday)).toEqual({ dueDate: "2026-10-05", planToday: false, scheduled: null });
    expect(movePatch("nextweek", sunday)).toEqual({ dueDate: "2026-10-12", planToday: false, scheduled: null });
    // due Wednesday: Tomorrow (Mon 5) would pull it forward, Next week (Mon 12) moves it later
    expect(leftoverChoices(task("x", { planToday: true, dueDate: "2026-10-07" }), "me", sunday).moves).toEqual(["nextweek", "someday", "drop"]);
    expect(leftoverChoices(task("x", { planToday: true, dueDate: "2026-10-14" }), "me", sunday).moves).toEqual(["someday", "drop"]);
  });

  it("each move takes the task off today; Tomorrow and Next week re-date it, Someday clears it", () => {
    expect(movePatch("tomorrow", today)).toEqual({ dueDate: "2026-10-01", planToday: false, scheduled: null });
    expect(movePatch("nextweek", today)).toEqual({ dueDate: "2026-10-05", planToday: false, scheduled: null });
    const someday = movePatch("someday", today);
    expect(someday).toEqual({ dueDate: undefined, planToday: false, scheduled: null });
    expect("dueDate" in someday).toBe(true);                   // the store clears a key that's present
    expect(movePatch("drop", today)).toEqual({ planToday: false, scheduled: null });
    expect(beforeMove(task("x", { dueDate: today, planToday: true, scheduled: 540 }))).toEqual({ dueDate: today, planToday: true, scheduled: 540 });
    expect(beforeMove(task("y"))).toEqual({ dueDate: undefined, planToday: false, scheduled: null });
  });

  it("a due date only ever moves later", () => {
    // due in two weeks and planned for today: Tomorrow takes it off today's plan and keeps the deadline
    expect(movePatch("tomorrow", today, "2026-10-14")).toEqual({ planToday: false, scheduled: null });
    expect(movePatch("nextweek", today, "2026-10-14")).toEqual({ planToday: false, scheduled: null });
    expect(movePatch("tomorrow", today, today)).toEqual({ dueDate: "2026-10-01", planToday: false, scheduled: null });
    expect(movePatch("nextweek", today, "2026-10-05")).toEqual({ dueDate: "2026-10-05", planToday: false, scheduled: null });
    expect(redatePatch("2026-10-05", "2026-09-20")).toEqual({ dueDate: "2026-10-05", planToday: false, scheduled: null });
    expect(redatePatch("2026-10-05", "2026-10-06")).toEqual({ planToday: false, scheduled: null });
  });

  it("your own leftovers can go anywhere that isn't earlier than their deadline", () => {
    const mine = (extra: Partial<Task>) => leftoverChoices(task("x", extra), "me", today);
    expect(mine({ dueDate: today })).toEqual({ moves: ["tomorrow", "nextweek", "someday"], all: "tomorrow", mine: true });
    expect(mine({ planToday: true })).toEqual({ moves: ["tomorrow", "nextweek", "someday", "drop"], all: "tomorrow", mine: true });
    // due Saturday: next Monday is later, tomorrow isn't
    expect(mine({ planToday: true, dueDate: "2026-10-03" })).toEqual({ moves: ["nextweek", "someday", "drop"], all: "drop", mine: true });
    expect(mine({ scheduled: 600, dueDate: "2026-10-14" })).toEqual({ moves: ["someday", "drop"], all: "drop", mine: true });
    // due today AND planned: Drop wouldn't take it off today, so it isn't offered
    expect(mine({ planToday: true, dueDate: today }).moves).not.toContain("drop");
  });

  it("a teammate's task you collaborate on: only your own plan moves, never their date", () => {
    const theirs = (extra: Partial<Task>) => leftoverChoices(task("x", { assigneeId: "m-1", collaborators: ["me"], ...extra }), "me", today);
    expect(theirs({ planToday: true, dueDate: "2026-10-14" })).toEqual({ moves: ["drop"], all: "drop", mine: false });
    expect(theirs({ planToday: true })).toEqual({ moves: ["drop"], all: "drop", mine: false });
    expect(theirs({ dueDate: today })).toEqual({ moves: [], all: null, mine: false });
    expect(theirs({ dueDate: today, scheduled: 540 })).toEqual({ moves: [], all: null, mine: false });
    // no assignee, or no signed-in id: not yours to re-date either
    expect(leftoverChoices(task("x", { assigneeId: undefined, planToday: true }), "me", today).mine).toBe(false);
    expect(leftoverChoices(task("x", { assigneeId: "", planToday: true }), "", today).mine).toBe(false);
  });

  it("the closing line counts what happened", () => {
    expect(closingLine(5, ["tomorrow", "tomorrow"])).toBe("Done for today. 5 finished, 2 moved to tomorrow.");
    expect(closingLine(1, ["nextweek"])).toBe("Done for today. 1 finished, 1 moved to next week.");
    expect(closingLine(3, ["tomorrow", "someday", "drop"])).toBe("Done for today. 3 finished, 1 moved to tomorrow, 1 to someday, 1 taken off your plan.");
    expect(closingLine(2, ["drop", "drop", "nextweek", "tomorrow"])).toBe("Done for today. 2 finished, 1 moved to tomorrow, 1 to next week, 2 taken off your plan.");
    expect(closingLine(0, ["drop"])).toBe("Done for today. 1 taken off your plan.");
    expect(closingLine(4, [])).toBe("Done for today. 4 finished.");
    expect(closingLine(0, ["tomorrow"])).toBe("Done for today. 1 moved to tomorrow.");
    expect(closingLine(0, [])).toBe("Done for today.");
  });

  it("the summary is plain text you can paste anywhere", () => {
    const text = shutdownSummary({
      day: today, finished: [{ title: "Finalise deck" }, { title: "Send brief" }],
      segments: [{ key: "p1", label: "Launch", minutes: 90 }, { key: "focus", label: "Focus", minutes: 25 }],
    });
    expect(text).toBe("Shut down · Wed 30 Sep\n\nFinished today (2)\n• Finalise deck\n• Send brief\n\nTime: Launch 1h 30m · Focus 25m");
    expect(shutdownSummary({ day: today, finished: [], segments: [] })).toContain("Nothing marked done today.");
  });
});

describe("rituals — the week", () => {
  const today = "2026-10-02"; // Friday
  it("finished this week runs Monday to today, newest first", () => {
    const ts = [
      task("mon", { status: "done", completedAt: at("2026-09-28", 10) }),
      task("fri", { status: "done", completedAt: at(today, 9) }),
      task("lastweek", { status: "done", completedAt: at("2026-09-27", 18) }),
      task("open", { completedAt: at(today) }),
    ];
    expect(finishedThisWeek(ts, today).map((t) => t.id)).toEqual(["fri", "mon"]);
  });

  it("a review on Friday and on the Monday after look at the same week and plan the same one", () => {
    const week = { start: "2026-09-28", end: "2026-10-04", plan: "2026-10-05" };
    expect(reviewWeek(today)).toEqual(week);               // Friday
    expect(reviewWeek("2026-10-04")).toEqual(week);        // Sunday
    expect(reviewWeek("2026-10-05")).toEqual(week);        // Monday morning: last week, planning this one
    expect(reviewWeek("2026-10-06")).toEqual({ start: "2026-10-05", end: "2026-10-11", plan: "2026-10-12" });
  });

  it("on a Monday, wins and leftovers are last week's", () => {
    const monday = "2026-10-05";
    const ts = [
      task("lastfri", { status: "done", completedAt: at("2026-10-02", 16) }),
      task("today", { status: "done", completedAt: at(monday, 8) }),
      task("older", { status: "done", completedAt: at("2026-09-25", 16) }),
    ];
    expect(finishedThisWeek(ts, monday, reviewWeek(monday).start).map((t) => t.id)).toEqual(["today", "lastfri"]);
  });

  it("carried over is what's still open and due by the end of this week", () => {
    const ts = [
      task("overdue", { dueDate: "2026-09-20" }),
      task("fri", { dueDate: today }),
      task("sun", { dueDate: "2026-10-04" }),
      task("nextweek", { dueDate: "2026-10-05" }),
      task("done", { dueDate: today, status: "done" }),
      task("nodate"),
    ];
    expect(carriedOver(ts, today).map((t) => t.id)).toEqual(["overdue", "fri", "sun"]);
    expect(carriedOver(ts, today, { end: "2026-10-05" }).map((t) => t.id)).toEqual(["overdue", "fri", "sun", "nextweek"]);
  });

  it("with your id, only what's assigned to you carries over (a teammate's date is theirs)", () => {
    const ts = [
      task("mine", { dueDate: today }),
      task("theirs", { dueDate: today, assigneeId: "m-1", collaborators: ["me"] }),
    ];
    expect(carriedOver(ts, today, { me: "me" }).map((t) => t.id)).toEqual(["mine"]);
  });
});
