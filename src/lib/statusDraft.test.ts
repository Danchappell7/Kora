import { describe, it, expect } from "vitest";
import type { Project, StatusUpdate, Task } from "../data/types";
import {
  draftStatusLocal, factLines, indexTasks, isStale, kanbosRead, oldestTaskAge, shortTitle, statusFacts, statusFactsForAi, STALE_DAYS,
} from "./statusDraft";

const TODAY = new Date(2026, 8, 30); // Wed 30 Sep 2026
const day = (n: number) => { const d = new Date(TODAY); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const at = (n: number) => { const d = new Date(TODAY); d.setDate(d.getDate() + n); d.setHours(10); return d.toISOString(); };

const P: Project = { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "oklch(0.74 0.14 230)", workspaceId: "ws" };
let n = 0;
const task = (o: Partial<Task> & { title: string }): Task => ({
  id: `t-${++n}`, description: "secret notes", status: "todo", priority: "medium", projectId: P.id, assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

const deck = task({ id: "deck", title: "Finalise Q3 launch narrative deck", status: "progress", priority: "urgent", dueDate: day(0) });
const tokens = task({ id: "tokens", title: "Define design tokens v2", status: "review", projectId: "p-brand", dueDate: day(0) });
const onboarding = task({ id: "onb", title: "Ship onboarding redesign to staging", status: "blocked", dueDate: day(1), dependencies: ["tokens"] });
const launch = task({ id: "launch", title: "Launch day", isMilestone: true, dueDate: day(8), dependencies: ["deck", "onb"] });
const late = task({ id: "late", title: "Write press release", dueDate: day(-2) });
const slipped = task({ id: "slip", title: "Book the venue", dueDate: day(4), originalDueDate: day(1) });
const done1 = task({ id: "d1", title: "Approve budget", status: "done", completedAt: day(-1) });
const done2 = task({ id: "d2", title: "Pick launch date", status: "done", completedAt: at(-3) });
const doneOld = task({ id: "d3", title: "Kick-off", status: "done", completedAt: day(-20) });
const sub = task({ id: "sub", title: "A sub-task", parentId: "deck", dueDate: day(-1) });
const archived = task({ id: "arch", title: "Gone", archivedAt: at(-1), status: "blocked" });
const other = task({ id: "other", title: "Someone else's", projectId: "p-other", status: "blocked" });
const ALL = [deck, tokens, onboarding, launch, late, slipped, done1, done2, doneOld, sub, archived, other];
const updates: StatusUpdate[] = [
  { id: "u-old", projectId: P.id, status: "on_track", summary: "Kick-off went well.", createdAt: at(-20) },
  { id: "u-new", projectId: P.id, status: "at_risk", summary: "Deck is the critical path.", createdAt: at(-9) },
  { id: "u-x", projectId: "p-other", status: "off_track", summary: "Not ours.", createdAt: at(0) },
];

describe("statusFacts", () => {
  const f = statusFacts(P, ALL, updates, TODAY);

  it("reads only this project's live tasks", () => {
    expect(f.project).toEqual({ id: P.id, name: P.name });
    expect(f.blocked.map((t) => t.id)).toEqual(["onb"]);          // not the archived one, not another project's
    expect(f.total).toBe(8);                                        // top-level only (the sub-task nests)
    expect(f.open).toBe(5);
    expect(f.openAll).toBe(6);                                      // with the sub-task: what overdue counts from
    expect(f.pct).toBe(38);
  });

  it("reads the same facts from a shared index (one pass over the tasks for many projects)", () => {
    const idx = indexTasks(ALL);
    expect(statusFacts(P, ALL, updates, TODAY, idx)).toEqual(f);
    expect(idx.byProject.get(P.id)?.some((t) => t.id === "arch")).toBe(false);   // archived work is left out
    expect(idx.dependents.get("tokens")).toEqual(["onb"]);
  });

  it("finds this week's finished work, the overdue, the slipped and what the blocked wait on", () => {
    expect(f.done7.map((t) => t.id).sort()).toEqual(["d1", "d2"]);
    expect(f.overdue.map((t) => t.id)).toEqual(["late", "sub"]);   // sub-tasks are real late work
    expect(f.slipped.map((t) => t.id)).toEqual(["slip"]);
    expect(f.waitingOn.onb.map((t) => t.id)).toEqual(["tokens"]);  // across projects
  });

  it("finds the next milestone and the critical path into it", () => {
    expect(f.nextMilestone?.id).toBe("launch");
    // the deck and onboarding both hold up the launch; the deck is due first
    expect(f.criticalPath?.id).toBe("deck");
  });

  it("takes the newest update whatever order they arrive in", () => {
    expect(f.latest?.id).toBe("u-new");
    expect(f.lastUpdateDays).toBe(9);
    expect(statusFacts(P, ALL, [], TODAY).lastUpdateDays).toBeNull();
  });

  it("reads the project's health", () => {
    expect(f.health).toBe("at_risk");                               // 2 of 9 live tasks overdue, 1 blocked
    expect(statusFacts(P, [done1], [], TODAY).health).toBe("complete");
    expect(statusFacts(P, [], [], TODAY)).toMatchObject({ total: 0, health: "on_track", criticalPath: undefined });
  });
});

describe("draftStatusLocal", () => {
  it("writes the week in a few sentences, with the status from the health", () => {
    const { summary, status } = draftStatusLocal(statusFacts(P, ALL, updates, TODAY));
    expect(summary).toMatch(/^Finished 2 tasks this week; 38% done overall\./);
    expect(summary).toContain("Finalise Q3 launch narrative deck is the critical path, due Wed 30 Sep.");
    expect(summary).toContain("Ship onboarding redesign to staging is blocked on Define design tokens v2.");
    expect(summary).toContain("Overdue: Write press release and A sub-task.");
    expect(summary).toContain("Next milestone: Launch day, Thu 8 Oct.");
    expect(status).toBe("at_risk");
  });

  it("folds a blocked critical path into one sentence", () => {
    const onb = { ...onboarding, id: "onb2", dependencies: ["tokens"] };
    const ms = { ...launch, id: "ms2", dependencies: ["onb2"] };
    const { summary, status } = draftStatusLocal(statusFacts(P, [onb, ms, tokens], [], TODAY));
    expect(summary).toContain("Ship onboarding redesign to staging is the critical path, due Thu 1 Oct, and it's blocked on Define design tokens v2.");
    expect(summary).not.toMatch(/\. Ship onboarding redesign to staging is blocked/);
    expect(status).toBe("at_risk");
  });

  it("says so when there's nothing to report", () => {
    expect(draftStatusLocal(statusFacts(P, [], [], TODAY))).toEqual({ summary: "No tasks in this project yet.", status: "on_track" });
    expect(draftStatusLocal(statusFacts(P, [done1, done2], [], TODAY)).summary).toBe("Every task is done, 2 tasks of them this week.");
    const quiet = draftStatusLocal(statusFacts(P, [task({ title: "Someday" })], [], TODAY));
    expect(quiet).toEqual({ summary: "Nothing finished this week; 0% done overall.", status: "on_track" });
  });
});

describe("kanbosRead", () => {
  it("names the critical path and how stale the update is, in one line", () => {
    const f = statusFacts(P, ALL, updates, TODAY);
    expect(kanbosRead(f)).toBe("Critical path: Q3 launch narrative deck · no update for 9 days");
    expect(kanbosRead(f, { withUpdate: false })).toBe("Critical path: Q3 launch narrative deck · 1 blocked");
  });

  it("covers empty, finished, blocked-only and quiet projects", () => {
    expect(kanbosRead(statusFacts(P, [], [], TODAY))).toBe("No tasks yet");
    expect(kanbosRead(statusFacts(P, [done1], [{ ...updates[1], createdAt: at(-1) }], TODAY))).toBe("All tasks done");
    const b = { ...onboarding, dependencies: [] };
    expect(kanbosRead(statusFacts(P, [b], [], TODAY))).toBe("1 blocked · no updates yet");
    expect(kanbosRead(statusFacts(P, [late], [{ ...updates[1], createdAt: at(-2) }], TODAY))).toBe("1 overdue");
    expect(kanbosRead(statusFacts(P, [done1, task({ title: "Later" })], [{ ...updates[1], createdAt: at(0) }], TODAY))).toBe("1 task done this week");
  });
});

describe("shortTitle", () => {
  it("drops the doing-word so the read names the thing", () => {
    expect(shortTitle("Finalise Q3 launch narrative deck")).toBe("Q3 launch narrative deck");
    expect(shortTitle("Set up usage analytics events")).toBe("usage analytics events");
    expect(shortTitle("Fix CI")).toBe("Fix CI");                   // too short to trim
    expect(shortTitle("Quarterly board pack")).toBe("Quarterly board pack");
  });
  it("cuts long names at a word, with an ellipsis", () => {
    expect(shortTitle("Write the complete migration guide for enterprise customers", 24)).toBe("the complete migration…");
  });
});

describe("statusFactsForAi", () => {
  it("sends titles and dates, never whole tasks or descriptions", () => {
    const out = statusFactsForAi(statusFacts(P, ALL, updates, TODAY));
    const json = JSON.stringify(out);
    expect(json).not.toContain("secret notes");
    expect(out).toMatchObject({
      project: "Q3 Product Launch", today: "2026-09-30", progressPct: 38,
      criticalPath: { title: "Finalise Q3 launch narrative deck", due: day(0) },
      nextMilestone: { title: "Launch day", due: day(8) },
      blocked: [{ title: "Ship onboarding redesign to staging", waitingOn: ["Define design tokens v2"] }],
      lastUpdate: { daysAgo: 9, status: "at_risk" },
    });
    expect(out.finishedThisWeek.sort()).toEqual(["Approve budget", "Pick launch date"]);
  });
});

describe("staleness", () => {
  it("is stale at 14 days, or with no update once the work is that old", () => {
    expect(isStale({ lastUpdateDays: STALE_DAYS - 1, total: 3 })).toBe(false);
    expect(isStale({ lastUpdateDays: STALE_DAYS, total: 3 })).toBe(true);
    expect(isStale({ lastUpdateDays: null, total: 0 })).toBe(false);          // nothing to report on
    expect(isStale({ lastUpdateDays: null, total: 3 }, null)).toBe(true);     // age unknown: assume it's been a while
    expect(isStale({ lastUpdateDays: null, total: 3 }, 3)).toBe(false);       // a project started this week isn't behind
    expect(isStale({ lastUpdateDays: null, total: 3 }, 20)).toBe(true);
  });
  it("ages a project by its oldest task", () => {
    const ts = [task({ title: "a", createdAt: at(-5) }), task({ title: "b", createdAt: at(-12) }), task({ title: "c" }), task({ title: "d", projectId: "x", createdAt: at(-99) })];
    expect(oldestTaskAge(ts, P.id, TODAY)).toBe(12);
    expect(oldestTaskAge([task({ title: "e" })], P.id, TODAY)).toBeNull();
  });
});

describe("factLines", () => {
  it("lists what a draft was built from", () => {
    const lines = factLines(statusFacts(P, ALL, updates, TODAY));
    expect(lines).toEqual([
      "2 tasks finished in the last 7 days",
      "1 blocked",
      "2 overdue",
      "1 due date moved later",
      "Critical path: Finalise Q3 launch narrative deck",
      "Next milestone: Launch day, Thu 8 Oct",
      "Last update 9 days ago",
    ]);
  });
});
