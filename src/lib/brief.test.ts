import { describe, it, expect } from "vitest";
import {
  composeBrief, countOf, countWord, freeGaps, freeMinutes, ghostCandidates, ghostPlan, momentum, momentumCounts,
  placesHint, plannedMinutes, reasonFor, topTask, WORK_END, WORK_START,
} from "./brief";
import type { CalEvent, Task } from "../data/types";

const TODAY = "2026-09-30"; // a Wednesday
const day = (n: number) => { const d = new Date(2026, 8, 30 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const H = (h: number, m = 0) => h * 60 + m;

let n = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "me", tags: [], dependencies: [], subtasks: [],
  focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const meeting = (start: number, end: number, title = "Meeting"): CalEvent => ({ id: title + start, title, start, end, kind: "meeting" });
const lunch: CalEvent = { id: "lunch", title: "Lunch", start: H(12), end: H(13), kind: "break" };

const brief = (o: Partial<Parameters<typeof composeBrief>[0]>) =>
  composeBrief({ tasks: [], events: [], nowMin: H(10), today: TODAY, userName: "Daniel Okai", ...o });
const kinds = (b: ReturnType<typeof composeBrief>) => b.parts.filter((p) => typeof p !== "string").map((p) => (p as { kind: string }).kind);

describe("words for numbers", () => {
  it("writes nine or fewer in words and larger numbers as digits", () => {
    expect(countWord(0)).toBe("zero");
    expect(countWord(4)).toBe("four");
    expect(countWord(9)).toBe("nine");
    expect(countWord(10)).toBe("10");
    expect(countOf(1, "thing")).toBe("one thing");
    expect(countOf(3, "task")).toBe("three tasks");
    expect(countOf(12, "risk")).toBe("12 risks");
  });
  it("the Plan my day hint is a data line, so it keeps digits", () => {
    expect(placesHint(4, 135)).toBe("Places 4 tasks · 2h 15m");
    expect(placesHint(1, 30)).toBe("Places 1 task · 30m");
  });
});

describe("composeBrief: the greeting", () => {
  it("greets by the hour, with the first name", () => {
    expect(brief({ nowMin: H(9) }).plain).toMatch(/^Good morning, Daniel\. /);
    expect(brief({ nowMin: H(14) }).plain).toMatch(/^Good afternoon, Daniel\. /);
    expect(brief({ nowMin: H(19) }).plain).toMatch(/^Good evening, Daniel\. /);
  });
  it("says 'there' with no name (or only an email address)", () => {
    expect(brief({ userName: undefined }).plain).toMatch(/^Good morning, there\. /);
    expect(brief({ userName: "dan@kanbo.app" }).plain).toMatch(/^Good morning, there\. /);
  });
});

describe("composeBrief: the day", () => {
  // from 10:00 to 18:00 is 8h; lunch and a 13:00–14:00 meeting leave 6h
  const events = [meeting(H(9), H(9, 30), "Standup"), lunch, meeting(H(13), H(14), "Design review")];

  it("free time and things due", () => {
    const b = brief({ events, tasks: [1, 2, 3, 4].map(() => task({ dueDate: TODAY })) });
    expect(b.plain).toContain("You have 6h free and four things due.");
    expect(kinds(b)).toEqual(expect.arrayContaining(["free", "due"]));
  });

  it("due and overdue", () => {
    const b = brief({ events, tasks: [task({ dueDate: TODAY }), task({ dueDate: day(-1) }), task({ dueDate: day(-3) })] });
    expect(b.plain).toContain("You have 6h free, one thing due and two overdue.");
    expect(kinds(b)).toEqual(expect.arrayContaining(["free", "due", "overdue"]));
  });

  it("only overdue", () => {
    expect(brief({ events, tasks: [task({ dueDate: day(-2) })] }).plain).toContain("You have 6h free and one thing overdue.");
  });

  it("nothing due", () => {
    const b = brief({ events, tasks: [task({ dueDate: day(3) })] });
    expect(b.plain).toContain("Nothing's due today — 6h free.");
    expect(kinds(b)).toEqual(["free"]);
  });

  it("counts free time from now, around meetings and planned blocks", () => {
    const planned = task({ planToday: true, scheduled: H(15), dur: 90 });
    expect(brief({ events, nowMin: H(12, 30), tasks: [planned] }).plain).toContain("Nothing's due today — 2h 30m free.");
  });

  it("a fully booked day (under 15 minutes free)", () => {
    const b = brief({ events: [meeting(H(10), H(17, 50))], tasks: [task({ dueDate: TODAY })] });
    expect(b.plain).toContain("Your day is fully booked, with one thing due.");
    expect(brief({ events: [meeting(H(10), H(18))] }).plain).toContain("Your day is fully booked.");
  });

  it("numbers above nine stay as digits", () => {
    const b = brief({ tasks: Array.from({ length: 12 }, () => task({ dueDate: TODAY })) });
    expect(b.plain).toContain("and 12 things due.");
  });

  it("finished, archived and done work doesn't count as due", () => {
    const b = brief({ tasks: [task({ dueDate: TODAY, status: "done" }), task({ dueDate: TODAY, archivedAt: "2026-09-29" })] });
    expect(b.plain).toContain("Nothing's due today");
  });
});

describe("composeBrief: where to start", () => {
  it("starts with the top task by Kanbo's score, with Kanbo's reason tidied to follow a colon", () => {
    const deck = task({ title: "Finalise Q3 launch narrative deck", dueDate: TODAY, aiScore: 96, aiReason: "Blocks 3 downstream tasks and is due today." });
    const b = brief({ tasks: [task({ dueDate: TODAY, aiScore: 40 }), deck] });
    expect(b.plain).toContain("Start with Finalise Q3 launch narrative deck: blocks 3 downstream tasks and is due today.");
    const part = b.parts.find((p) => typeof p !== "string" && p.kind === "task");
    expect(part).toEqual({ kind: "task", text: "Finalise Q3 launch narrative deck", taskId: deck.id });
  });

  it("ties on score go to the earlier due date, then the higher priority", () => {
    const a = task({ dueDate: TODAY, aiScore: 50, priority: "low" });
    const b = task({ dueDate: day(-1), aiScore: 50, priority: "low" });
    const c = task({ dueDate: day(-1), aiScore: 50, priority: "high" });
    expect(topTask([a, b, c], TODAY)?.id).toBe(c.id);
  });

  it("derives a reason when Kanbo hasn't given one", () => {
    const deck = task({ title: "Deck", dueDate: TODAY });
    const all = [deck, task({ dependencies: [deck.id] }), task({ dependencies: [deck.id] }), task({ dependencies: [deck.id], status: "done" })];
    expect(reasonFor(deck, all, TODAY)).toBe("it's holding up two tasks");
    expect(reasonFor(task({ dueDate: TODAY, dueTime: "15:00" }), [], TODAY)).toBe("it's due at 15:00");
    expect(reasonFor(task({ dueDate: day(-2) }), [], TODAY)).toBe("it's been overdue since Mon");
    expect(reasonFor(task({ dueDate: "2026-09-12" }), [], TODAY)).toBe("it's been overdue since 12 Sep");
    expect(reasonFor(task({ dueDate: TODAY }), [], TODAY)).toBe("it's your highest priority");
    // capture boilerplate is not a reason
    expect(reasonFor(task({ dueDate: TODAY, aiReason: "Captured just now — drag it onto your day or hit Auto-plan." }), [], TODAY)).toBe("it's your highest priority");
  });

  it("uses the workspace to count what the task is holding up", () => {
    const deck = task({ title: "Deck", dueDate: TODAY });
    const b = brief({ tasks: [deck], allTasks: [deck, task({ dependencies: [deck.id], assigneeId: "maya" })] });
    expect(b.plain).toContain("Start with Deck: it's holding up one task.");
  });

  it("long titles are shortened in the sentence", () => {
    const b = brief({ tasks: [task({ title: "A".repeat(80), dueDate: TODAY })] });
    const part = b.parts.find((p) => typeof p !== "string" && p.kind === "task") as { text: string };
    expect(part.text.length).toBeLessThanOrEqual(56);
    expect(part.text.endsWith("…")).toBe(true);
  });

  it("no work for today, no suggestion", () => {
    expect(brief({ tasks: [task({ dueDate: day(4) })] }).plain).not.toContain("Start with");
  });

  it("counts the work the rail and the suggestions show: mine, or on today's list — not a collaborator's, not a subtask", () => {
    const mine = task({ title: "Mine due", dueDate: TODAY, aiScore: 10 });
    const collab = task({ title: "Collab due", dueDate: TODAY, assigneeId: "maya", collaborators: ["me"], priority: "urgent", aiScore: 90 });
    const sub = task({ title: "Subtask due", dueDate: TODAY, parentId: mine.id, aiScore: 80 });
    const listed = task({ title: "Maya's, on my list", dueDate: day(-1), assigneeId: "maya", planToday: true, aiScore: 5 });
    const b = brief({ me: "me", tasks: [mine, collab, sub, listed] });
    expect(b.plain).toContain("one thing due and one overdue.");
    expect(b.plain).toContain("Start with Mine due:");
    // the same set ghostCandidates works from
    const ids = ghostCandidates([mine, collab, sub, listed], { today: TODAY, me: "me" }).map((t) => t.id);
    expect(ids.sort()).toEqual([mine.id, listed.id].sort());
    expect(topTask([mine, collab, sub], TODAY, "me")?.id).toBe(mine.id);
  });
});

describe("composeBrief: risks and the evening", () => {
  it("owners and admins with risks get a last sentence, singular and plural", () => {
    expect(brief({ riskCount: 1 }).plain).toMatch(/One risk needs a look\.$/);
    const b = brief({ riskCount: 3 });
    expect(b.plain).toMatch(/Three risks need a look\.$/);
    expect(kinds(b)).toContain("risks");
    expect(brief({ riskCount: 0 }).plain).not.toContain("risk");
  });

  it("after 18:00 it counts what you finished instead", () => {
    const done = [1, 2, 3].map(() => task({ status: "done", completedAt: TODAY }));
    const b = brief({ nowMin: H(19, 30), tasks: [...done, task({ status: "done", completedAt: day(-1) })] });
    expect(b.plain).toBe("Good evening, Daniel. You finished three things today.");
  });

  it("the evening variant still says what's due, and never 'fully booked'", () => {
    const b = brief({ nowMin: H(22, 15), tasks: [task({ status: "done", completedAt: TODAY }), task({ dueDate: TODAY })] });
    expect(b.plain).toBe("Good evening, Daniel. You finished one thing today, with one thing due.");
    expect(brief({ nowMin: H(23) }).plain).toBe("Good evening, Daniel. The working day's done.");
  });

  it("plain is the parts joined", () => {
    const b = brief({ tasks: [task({ dueDate: TODAY, title: "Deck" })], riskCount: 2 });
    expect(b.plain).toBe(b.parts.map((p) => (typeof p === "string" ? p : p.text)).join(""));
    expect(b.plain).toBe("Good morning, Daniel. You have 8h free and one thing due. Start with Deck: it's your highest priority. Two risks need a look.");
  });
});

describe("free time, planned time and momentum", () => {
  it("freeGaps are the stretches still ahead in the working day", () => {
    expect(freeGaps([], [lunch], H(11))).toEqual([{ start: H(11), end: H(12) }, { start: H(13), end: WORK_END }]);
    expect(freeMinutes([], [lunch], H(11))).toBe(6 * 60);
    expect(freeMinutes([], [], H(19))).toBe(0);
  });

  it("plannedMinutes counts open placed blocks once", () => {
    const a = task({ planToday: true, scheduled: H(9), dur: 60 });
    const b = task({ planToday: true, scheduled: H(9, 30), dur: 60 });
    const done = task({ planToday: true, scheduled: H(14), dur: 60, status: "done" });
    const notOnDay = task({ scheduled: H(15), dur: 60 });
    expect(plannedMinutes([a, b, done, notOnDay])).toBe(90);
  });

  it("momentum is done today over today's work", () => {
    const tasks = [
      task({ status: "done", completedAt: TODAY }),
      task({ status: "done", completedAt: `${TODAY}T09:12:00Z` }),
      task({ dueDate: TODAY }),
      task({ planToday: true }),
      task({ dueDate: day(3) }),
      task({ status: "done", completedAt: day(-1) }),
    ];
    expect(momentumCounts(tasks, TODAY)).toEqual({ done: 2, total: 4 });
    expect(momentum(tasks, TODAY)).toBe(0.5);
    expect(momentum([task({ dueDate: day(2) })], TODAY)).toBeNull();
  });

  it("with me, momentum counts only the work Today shows me", () => {
    const tasks = [
      task({ status: "done", completedAt: TODAY }),
      task({ dueDate: TODAY }),
      task({ status: "done", completedAt: TODAY, assigneeId: "maya", collaborators: ["me"] }), // theirs
      task({ dueDate: TODAY, assigneeId: "maya", collaborators: ["me"] }),                     // theirs
      task({ dueDate: TODAY, assigneeId: "maya", planToday: true }),                           // on my list
    ];
    expect(momentumCounts(tasks, TODAY, "me")).toEqual({ done: 1, total: 3 });
  });
});

describe("ghostPlan", () => {
  const opts = { today: TODAY, me: "me" };

  it("suggests my due, overdue and planned-for-today work that isn't on the day yet", () => {
    const due = task({ dueDate: TODAY });
    const late = task({ dueDate: day(-2) });
    const planned = task({ planToday: true });
    const theirsPlanned = task({ planToday: true, assigneeId: "maya" }); // on my list: suggested
    const theirs = task({ dueDate: TODAY, assigneeId: "maya" });         // not mine: not suggested
    const placed = task({ dueDate: TODAY, planToday: true, scheduled: H(9) });
    const done = task({ dueDate: TODAY, status: "done" });
    const later = task({ dueDate: day(3) });
    const ids = ghostCandidates([due, late, planned, theirsPlanned, theirs, placed, done, later], opts).map((t) => t.id);
    expect(ids.sort()).toEqual([due.id, late.id, planned.id, theirsPlanned.id].sort());
  });

  it("places them after now, around meetings and blocks, and never writes", () => {
    const a = task({ dueDate: TODAY, focusMin: 30 });
    const placed = task({ planToday: true, scheduled: H(10), focusMin: 60 });
    const tasks = [a, placed];
    const { suggestions } = ghostPlan(tasks, [meeting(H(11), H(12))], H(9, 50), opts);
    expect(suggestions).toHaveLength(1);
    const s = suggestions[0];
    expect(s.id).toBe(a.id);
    expect(s.start).toBeGreaterThanOrEqual(H(9, 50));
    expect(s.end - s.start).toBe(30);
    const clash = (x: number, y: number) => s.start < y && s.end > x;
    expect(clash(H(10), H(11))).toBe(false);
    expect(clash(H(11), H(12))).toBe(false);
    expect(a.scheduled).toBeUndefined();
  });

  it("flags overdue suggestions", () => {
    const { suggestions } = ghostPlan([task({ dueDate: day(-1) })], [], H(9), opts);
    expect(suggestions[0].overdue).toBe(true);
  });

  it("leaves out what you waved away today", () => {
    const a = task({ dueDate: TODAY });
    expect(ghostPlan([a], [], H(9), { ...opts, skip: [a.id] }).suggestions).toEqual([]);
  });

  it("what doesn't fit before the end of the working day is tomorrow's", () => {
    const big = task({ dueDate: TODAY, focusMin: 120 });
    const plan = ghostPlan([big], [], H(16, 30), opts);
    expect(plan.suggestions).toEqual([]);
    expect(plan.unplaced.map((t) => t.id)).toEqual([big.id]);
  });

  it("once the working day is over nothing is suggested: it's all tomorrow's (as the brief and the Daybeam say)", () => {
    const small = task({ dueDate: TODAY, focusMin: 30 });
    const plan = ghostPlan([small], [], H(19), opts);
    expect(plan.suggestions).toEqual([]);
    expect(plan.unplaced.map((t) => t.id)).toEqual([small.id]);
    expect(ghostPlan([small], [], WORK_END, opts).suggestions).toEqual([]);
  });

  it("never suggests anything before the working day starts", () => {
    const { suggestions } = ghostPlan([task({ dueDate: TODAY, energy: "deep" })], [], H(7), opts);
    expect(suggestions[0].start).toBe(WORK_START);
    expect(freeGaps([], [], H(7))[0].start).toBe(WORK_START);
  });

  it("work due at a time today is suggested to finish by then, not after", () => {
    // an admin task would otherwise wait for the afternoon (13:00)
    const contract = task({ title: "Send contract", dueDate: TODAY, dueTime: "11:00", focusMin: 30 });
    const { suggestions } = ghostPlan([contract], [], H(9), opts);
    expect(suggestions).toEqual([{ id: contract.id, start: H(9), end: H(9, 30), overdue: false }]);
    // the brief says the same thing
    expect(brief({ nowMin: H(9), tasks: [contract] }).plain).toContain("Start with Send contract: it's due at 11:00.");
  });

  it("a timed task goes around meetings, and ahead of other work that wanted its slot", () => {
    const urgent = task({ dueDate: TODAY, priority: "urgent", focusMin: 60, energy: "deep", aiScore: 99 });
    const timed = task({ dueDate: TODAY, dueTime: "10:30", focusMin: 30 });
    const { suggestions } = ghostPlan([urgent, timed], [meeting(H(9), H(9, 30), "Standup")], H(9), opts);
    const at = (id: string) => suggestions.find((s) => s.id === id)!;
    expect(at(timed.id).start).toBe(H(9, 30));
    expect(at(timed.id).end).toBeLessThanOrEqual(H(10, 30));
    expect(at(urgent.id).start).toBeGreaterThanOrEqual(at(timed.id).end);
  });

  it("a deadline that can't be met any more is still today's: as soon as there's room", () => {
    // due 11:00, but the morning is taken until 10:45: it goes straight after
    const late = task({ dueDate: TODAY, dueTime: "11:00", focusMin: 30 });
    const s1 = ghostPlan([late], [meeting(H(9), H(10, 45))], H(9), opts).suggestions[0];
    expect(s1.start).toBe(H(10, 45));
    expect(s1.overdue).toBe(false);
    // and once 11:00 has gone it's overdue, and first thing
    const s2 = ghostPlan([late], [], H(12, 10), opts).suggestions[0];
    expect(s2.start).toBe(H(12, 10));
    expect(s2.overdue).toBe(true);
  });

  it("uses a gap the focus break held back before calling anything tomorrow's", () => {
    const long = task({ dueDate: TODAY, focusMin: 90, aiScore: 90 });
    const short = task({ dueDate: TODAY, focusMin: 25, aiScore: 10 });
    const plan = ghostPlan([long, short], [], H(16), opts);
    expect(plan.unplaced).toEqual([]);
    expect(plan.suggestions.map((s) => [s.id, s.start])).toEqual([[long.id, H(16)], [short.id, H(17, 30)]]);
  });

  it("Kanbo's score breaks ties between equally due, equally urgent work", () => {
    const low = task({ dueDate: TODAY, aiScore: 20 });
    const high = task({ dueDate: TODAY, aiScore: 90 });
    const { suggestions } = ghostPlan([low, high], [], H(9), opts);
    expect(suggestions[0].id).toBe(high.id);
  });
});
