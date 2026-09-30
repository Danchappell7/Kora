import { describe, it, expect, beforeAll } from "vitest";
import {
  bucketOpen, bucketWaiting, bucketDone, doneToday, openBucketOf, daysFromToday, localDayOf, dayLabel, dueFocusGroup, isMine,
} from "./myTaskBuckets";
import { KANBO_TODAY, setReferenceData, toLocalISO } from "../data/data";
import type { Task, Member } from "../data/types";

const mk = (p: Partial<Task> & { id: string }): Task => ({
  title: p.id, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...p,
});
// a fixed Wednesday, so "this week" and day labels are predictable
const TODAY = new Date(2026, 8, 30);
const iso = (n: number) => toLocalISO(new Date(2026, 8, 30 + n));
const keys = (bs: { key: string; items: Task[] }[]) => bs.map((b) => [b.key, b.items.map((t) => t.id)]);

beforeAll(() => {
  const m = (id: string, name: string): Member => ({ id, name, email: `${id}@x.test`, type: "team", color: "#888" });
  setReferenceData({ members: [m("me", "Daniel Okai"), m("maya", "Maya Lin"), m("sana", "Sana Qureshi"), m("idris", "Idris Bello")] });
});

describe("day maths", () => {
  it("reads a plain date as a local day and a timestamp as the local day it fell on", () => {
    expect(localDayOf("2026-09-30")!.getDate()).toBe(30);
    const ts = new Date(2026, 8, 29, 23, 30); // late on the 29th, local time
    expect(localDayOf(ts.toISOString())!.getDate()).toBe(29);
    expect(localDayOf("not a date")).toBeNull();
    expect(localDayOf(undefined)).toBeNull();
  });

  it("counts whole days from today, across month ends", () => {
    expect(daysFromToday(iso(0), TODAY)).toBe(0);
    expect(daysFromToday(iso(-1), TODAY)).toBe(-1);
    expect(daysFromToday("2026-10-01", TODAY)).toBe(1);
    expect(daysFromToday(undefined, TODAY)).toBeNull();
  });

  it("defaults to KANBO_TODAY", () => {
    expect(daysFromToday(toLocalISO(KANBO_TODAY))).toBe(0);
  });
});

describe("bucketOpen", () => {
  it("groups open work by when it's due, in a fixed order, leaving out empty groups", () => {
    const tasks = [
      mk({ id: "later", dueDate: iso(9) }),
      mk({ id: "over", dueDate: iso(-2) }),
      mk({ id: "nodate" }),
      mk({ id: "today", dueDate: iso(0) }),
      mk({ id: "week", dueDate: iso(7) }),
      mk({ id: "tomorrow", dueDate: iso(1) }),
      mk({ id: "shipped", status: "done", dueDate: iso(0) }),
    ];
    expect(keys(bucketOpen(tasks, TODAY))).toEqual([
      ["overdue", ["over"]], ["today", ["today"]], ["week", ["week", "tomorrow"]], ["later", ["later"]], ["nodate", ["nodate"]],
    ]);
    expect(bucketOpen(tasks, TODAY)[0]).toMatchObject({ label: "Overdue", tone: "signal" });
  });

  it("puts planned-for-today, scheduled and in-progress-with-no-date work under Today", () => {
    expect(openBucketOf(mk({ id: "a", planToday: true }), TODAY)).toBe("today");
    expect(openBucketOf(mk({ id: "b", planToday: true, dueDate: iso(5) }), TODAY)).toBe("today");
    expect(openBucketOf(mk({ id: "c", scheduled: 540 }), TODAY)).toBe("today");
    expect(openBucketOf(mk({ id: "d", status: "progress" }), TODAY)).toBe("today");
    // in progress but due next week stays in its week
    expect(openBucketOf(mk({ id: "e", status: "progress", dueDate: iso(3) }), TODAY)).toBe("week");
    // a plain to-do with no date has no date
    expect(openBucketOf(mk({ id: "f" }), TODAY)).toBe("nodate");
    // scheduled: null means "not on the canvas"
    expect(openBucketOf(mk({ id: "g", scheduled: null }), TODAY)).toBe("nodate");
  });

  it("keeps overdue work overdue even when it's planned for today", () => {
    expect(openBucketOf(mk({ id: "a", dueDate: iso(-1), planToday: true }), TODAY)).toBe("overdue");
  });

  it("rolls over at the day boundary (the same task, tomorrow)", () => {
    const t = mk({ id: "a", dueDate: iso(0) });
    expect(openBucketOf(t, TODAY)).toBe("today");
    expect(openBucketOf(t, new Date(2026, 9, 1))).toBe("overdue");
    expect(openBucketOf(mk({ id: "b", dueDate: iso(8) }), TODAY)).toBe("later");
    expect(openBucketOf(mk({ id: "b", dueDate: iso(8) }), new Date(2026, 9, 1))).toBe("week");
  });

  it("finds what was ticked off today", () => {
    const tasks = [mk({ id: "a", status: "done", completedAt: iso(0) }), mk({ id: "b", status: "done", completedAt: iso(-1) }), mk({ id: "c", completedAt: iso(0) })];
    expect(doneToday(tasks, TODAY).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("bucketWaiting", () => {
  it("lists tasks I created for others, grouped by person (busiest first)", () => {
    const tasks = [
      mk({ id: "brief", createdBy: "me", assigneeId: "maya" }),
      mk({ id: "copy", createdBy: "me", assigneeId: "maya" }),
      mk({ id: "hire", createdBy: "me", assigneeId: "sana" }),
      mk({ id: "mine", createdBy: "me", assigneeId: "me" }),           // mine, not waiting
      mk({ id: "theirs", createdBy: "sana", assigneeId: "maya" }),     // nothing to do with me
      mk({ id: "shipped", createdBy: "me", assigneeId: "maya", status: "done" }),
    ];
    const { groups, reasons } = bucketWaiting(tasks, "me");
    expect(keys(groups)).toEqual([["maya", ["brief", "copy"]], ["sana", ["hire"]]]);
    expect(groups.map((g) => g.label)).toEqual(["With Maya", "With Sana"]);
    expect(reasons.get("hire")).toEqual({ kind: "with", personId: "sana" });
  });

  it("includes tasks I follow, but not ones I'm also working on", () => {
    const tasks = [
      mk({ id: "followed", createdBy: "sana", assigneeId: "maya", followers: ["me"] }),
      mk({ id: "shared", createdBy: "me", assigneeId: "maya", collaborators: ["me"] }),
    ];
    expect(keys(bucketWaiting(tasks, "me").groups)).toEqual([["maya", ["followed"]]]);
  });

  it("adds my own tasks held up by someone else's open blocker", () => {
    const tasks = [
      mk({ id: "review", title: "Design review", assigneeId: "idris" }),
      mk({ id: "ship", assigneeId: "me", dependencies: ["review"] }),
      mk({ id: "done-blocker", assigneeId: "idris", status: "done" }),
      mk({ id: "free", assigneeId: "me", dependencies: ["done-blocker"] }),
      mk({ id: "self-blocked", assigneeId: "me", dependencies: ["free"] }), // my own blocker: not waiting on anyone
    ];
    const { groups, reasons } = bucketWaiting(tasks, "me");
    expect(keys(groups)).toEqual([["idris", ["ship"]]]);
    expect(reasons.get("ship")).toEqual({ kind: "needs", personId: "idris", blockerId: "review", blocker: "Design review" });
  });

  it("is empty without a signed-in user", () => {
    expect(bucketWaiting([mk({ id: "a", createdBy: "", assigneeId: "maya" })], "").groups).toEqual([]);
  });
});

describe("bucketDone", () => {
  it("groups my finished work by the day it was done, newest first", () => {
    const tasks = [
      mk({ id: "a", status: "done", completedAt: iso(0) }),
      mk({ id: "b", status: "done", completedAt: iso(-1) }),
      mk({ id: "c", status: "done", completedAt: iso(-2) }),
      mk({ id: "d", status: "done", completedAt: iso(-2) }),
      mk({ id: "not-mine", status: "done", completedAt: iso(0), assigneeId: "maya" }),
      mk({ id: "open", completedAt: iso(0) }),
    ];
    const { groups, olderCount } = bucketDone(tasks, "me", 30, TODAY);
    expect(groups.map((g) => [g.label, g.items.map((t) => t.id)])).toEqual([["Today", ["a"]], ["Yesterday", ["b"]], ["Mon 28 Sep", ["c", "d"]]]);
    expect(olderCount).toBe(0);
  });

  it("keeps anything beyond the window (or undated) aside, by month", () => {
    const tasks = [
      mk({ id: "edge", status: "done", completedAt: iso(-29) }),
      mk({ id: "aug", status: "done", completedAt: "2026-08-01" }),
      mk({ id: "last-year", status: "done", completedAt: "2025-12-24" }),
      mk({ id: "undated", status: "done" }),
    ];
    const { groups, older, olderCount } = bucketDone(tasks, "me", 30, TODAY);
    expect(groups.map((g) => g.items.map((t) => t.id))).toEqual([["edge"]]);
    expect(olderCount).toBe(3);
    expect(older.map((g) => [g.label, g.items.map((t) => t.id)])).toEqual([["August", ["aug"]], ["December 2025", ["last-year"]], ["Earlier", ["undated"]]]);
  });

  it("uses the local day of a completion timestamp (timezone boundary)", () => {
    const lateLastNight = new Date(2026, 8, 29, 23, 45).toISOString();
    const { groups } = bucketDone([mk({ id: "a", status: "done", completedAt: lateLastNight })], "me", 30, TODAY);
    expect(groups[0].label).toBe("Yesterday");
  });
});

describe("labels and links", () => {
  it("says Sep, not Sept, and adds the year for other years", () => {
    expect(dayLabel(new Date(2026, 8, 28), TODAY)).toBe("Mon 28 Sep");
    expect(dayLabel(new Date(2025, 8, 28), TODAY)).toBe("Sun 28 Sep 2025");
  });

  it("maps a ?due= link to its group", () => {
    expect(dueFocusGroup("overdue")).toBe("overdue");
    expect(dueFocusGroup("week")).toBe("week");
    expect(dueFocusGroup("mine")).toBeUndefined();
    expect(dueFocusGroup(undefined)).toBeUndefined();
  });

  it("counts collaborators as mine", () => {
    expect(isMine(mk({ id: "a", assigneeId: "maya", collaborators: ["me"] }), "me")).toBe(true);
    expect(isMine(mk({ id: "a", assigneeId: "maya" }), "me")).toBe(false);
  });
});
