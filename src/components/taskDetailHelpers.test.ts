import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveMentions, wouldCreateCycle, dependencyCandidates, activityLine, isTextEntry,
  attachmentOwnerId, canDeleteAttachment, readDraft, writeDraft, stashUnsaved, takeUnsaved, clearTaskDrafts,
  consequenceOf, slipNote, dueMoves, eventText, buildTimeline, dayLabel, ago, fmtHours, parseHours,
  type HistoryEvent,
} from "./taskDetailHelpers";
import type { Activity, Comment, Task } from "../data/types";

const mk = (over: Partial<Task>): Task => ({
  id: "t1", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p1", assigneeId: "u1",
  tags: [], dependencies: [], subtasks: [], focusMin: 25, comments: 0, aiScore: 0, workspaceId: "w1", ...over,
});

describe("resolveMentions", () => {
  const members = [
    { id: "dan", name: "Dan" }, { id: "daniel", name: "Daniel" },
    { id: "sam", name: "Sam" }, { id: "samr", name: "Sam Reed" },
    { id: "alex1", name: "Alex" }, { id: "alex2", name: "Alex" },
    { id: "priya", name: "Priya Shah" },
  ];

  it("doesn't also notify a shorter name that's a prefix", () => {
    expect(resolveMentions("@Daniel can you check", [], members)).toEqual(["daniel"]);
  });
  it("prefers the longest name (a full name isn't also the first name)", () => {
    expect(resolveMentions("@Sam Reed please review", [], members)).toEqual(["samr"]);
    expect(resolveMentions("@Sam and @Sam Reed", [], members).sort()).toEqual(["sam", "samr"]);
  });
  it("needs a word boundary after the name, but punctuation is fine", () => {
    expect(resolveMentions("@Danny hi", [], members)).toEqual([]);
    expect(resolveMentions("thanks @Dan.", [], members)).toEqual(["dan"]);
    expect(resolveMentions("(@Priya Shah's call)", [], members)).toEqual(["priya"]);
  });
  it("ignores email-like text", () => {
    expect(resolveMentions("mail me at x@dan", [], members)).toEqual([]);
  });
  it("uses the picked id when two teammates share a name, and skips an ambiguous hand-typed one", () => {
    expect(resolveMentions("@Alex over to you", [{ id: "alex2", name: "Alex" }], members)).toEqual(["alex2"]);
    expect(resolveMentions("@Alex over to you", [], members)).toEqual([]);
  });
  it("drops a picked mention whose token was deleted from the text", () => {
    expect(resolveMentions("never mind", [{ id: "priya", name: "Priya Shah" }], members)).toEqual([]);
  });
  it("is case-insensitive", () => {
    expect(resolveMentions("@priya shah fyi", [], members)).toEqual(["priya"]);
  });
});

describe("dependencies", () => {
  const a = mk({ id: "a" });
  const b = mk({ id: "b", dependencies: ["c"] });
  const c = mk({ id: "c", dependencies: ["a"] });          // c is blocked by a
  const done = mk({ id: "d", status: "done" });
  const archived = mk({ id: "e", archivedAt: "2026-09-01" });
  const otherWs = mk({ id: "f", workspaceId: "w2" });
  const personal = mk({ id: "g", workspaceId: null });
  const open = mk({ id: "h", title: "Budget sign-off" });
  const all = [a, b, c, done, archived, otherWs, personal, open];

  it("detects direct and transitive cycles", () => {
    expect(wouldCreateCycle(all, "a", "a")).toBe(true);
    expect(wouldCreateCycle(all, "a", "c")).toBe(true);   // c → a already
    expect(wouldCreateCycle(all, "a", "b")).toBe(true);   // b → c → a
    expect(wouldCreateCycle(all, "a", "h")).toBe(false);
  });
  it("offers only open, unarchived tasks in the same workspace that can't loop", () => {
    expect(dependencyCandidates(a, all, "").map((t) => t.id)).toEqual(["h"]);
    expect(dependencyCandidates(a, all, "budget").map((t) => t.id)).toEqual(["h"]);
    expect(dependencyCandidates(a, all, "nothing like it")).toEqual([]);
  });
  it("keeps personal tasks with personal tasks", () => {
    const mine = mk({ id: "p", workspaceId: null });
    expect(dependencyCandidates(mine, [...all, mine], "").map((t) => t.id)).toEqual(["g"]);
  });
});

describe("activityLine", () => {
  it("words notification rows like the inbox", () => {
    expect(activityLine({ kind: "mention", detail: "Maya Lin" })).toBe("Maya Lin mentioned you");
    expect(activityLine({ kind: "comment", detail: "Theo Vance" }, ["Maya Lin", "Theo Vance"])).toBe("Theo Vance commented");
    expect(activityLine({ kind: "assigned", detail: "" })).toBe("Someone assigned you");
    expect(activityLine({ kind: "completed", detail: "Marked complete" })).toBe("Marked complete");
  });
  it("doesn't turn your own comment's text into a name", () => {
    // App logs your own comment with its text as the detail
    expect(activityLine({ kind: "comment", detail: "Can we move this to Friday?" }, ["Maya Lin"])).toBe("Comment: “Can we move this to Friday?”");
    expect(activityLine({ kind: "comment", detail: "" })).toBe("Someone commented");
    expect(activityLine({ kind: "approval", detail: "Sana Rao", meta: { event: "requested", status: "pending" } })).toBe("Sana Rao asked for your approval on this task");
    expect(activityLine({ kind: "approval", detail: "Olive", meta: { event: "approved", status: "approved" } })).toBe("Olive approved this task");
  });
});

describe("isTextEntry", () => {
  it("is true for typing fields only", () => {
    const el = (html: string) => { const d = document.createElement("div"); d.innerHTML = html; return d.firstElementChild!; };
    expect(isTextEntry(el("<textarea></textarea>"))).toBe(true);
    expect(isTextEntry(el("<input>"))).toBe(true);
    expect(isTextEntry(el('<input type="number">'))).toBe(true);
    expect(isTextEntry(el('<input type="date">'))).toBe(false);
    expect(isTextEntry(el("<select></select>"))).toBe(false);
    expect(isTextEntry(el("<button></button>"))).toBe(false);
  });
});

describe("attachments", () => {
  it("only the uploader (first path segment) may delete, except in demo mode", () => {
    const a = { path: "u-alice/t1/abc_report.pdf" };
    expect(attachmentOwnerId(a)).toBe("u-alice");
    expect(canDeleteAttachment(a, "u-alice", false)).toBe(true);
    expect(canDeleteAttachment(a, "u-bob", false)).toBe(false);
    expect(canDeleteAttachment({ path: "demo" }, "m-self", true)).toBe(true);
  });
  it("prefers the row's owner when it has one (files handed on when an account is deleted)", () => {
    const a = { path: "u-alice/t1/abc_report.pdf", userId: "u-owner" };
    expect(canDeleteAttachment(a, "u-owner", false)).toBe(true);
    expect(canDeleteAttachment(a, "u-alice", false)).toBe(false);
  });
});

describe("comment drafts", () => {
  beforeEach(() => sessionStorage.clear());
  it("persist per person and task, and clear when emptied", () => {
    writeDraft("u1", "t1", "half a thought");
    expect(readDraft("u1", "t1")).toBe("half a thought");
    expect(readDraft("u1", "t2")).toBe("");
    expect(readDraft("u2", "t1")).toBe("");                   // someone else signing in on this tab
    writeDraft("u1", "t1", "   ");
    expect(readDraft("u1", "t1")).toBe("");
  });
  it("unsaved edits are read once, and sign-out clears everything", () => {
    stashUnsaved("u1", "t1", "title", "Mine");
    expect(takeUnsaved("u1", "t1", "title")).toBe("Mine");
    expect(takeUnsaved("u1", "t1", "title")).toBeNull();
    writeDraft("u1", "t1", "draft");
    stashUnsaved("u1", "t1", "description", "text");
    sessionStorage.setItem("other-key", "keep");
    clearTaskDrafts();
    expect(readDraft("u1", "t1")).toBe("");
    expect(takeUnsaved("u1", "t1", "description")).toBeNull();
    expect(sessionStorage.getItem("other-key")).toBe("keep");
  });
});

describe("dates and durations", () => {
  const today = "2026-09-30";   // a Wednesday
  it("labels days the en-GB way, with the year only when it isn't this one", () => {
    expect(dayLabel("2026-10-02", today)).toBe("Fri 2 Oct");
    expect(dayLabel("2027-01-04", today)).toBe("Mon 4 Jan 2027");
  });
  it("gives compact ages for the timeline", () => {
    const now = Date.parse("2026-09-30T12:00:00");
    expect(ago("2026-09-30T11:59:40", now)).toBe("now");
    expect(ago("2026-09-30T11:55:00", now)).toBe("5m");
    expect(ago("2026-09-30T09:00:00", now)).toBe("3h");
    expect(ago("2026-09-28T09:00:00", now)).toBe("2d");
    expect(ago("2026-09-01T09:00:00", now)).toBe("1 Sep");
  });
  it("reads and writes durations", () => {
    expect(fmtHours(1.5)).toBe("1h 30m");
    expect(fmtHours(2)).toBe("2h");
    expect(fmtHours(0.25)).toBe("15m");
    expect(fmtHours(undefined)).toBe("");
    expect(parseHours("1h 30m")).toBe(1.5);
    expect(parseHours("1h30")).toBe(1.5);
    expect(parseHours("90m")).toBe(1.5);
    expect(parseHours("1:30")).toBe(1.5);
    expect(parseHours("2.5")).toBe(2.5);
    expect(parseHours("2 hours")).toBe(2);
    expect(parseHours("")).toBeUndefined();
    expect(parseHours("soon")).toBeNull();
    expect(parseHours("30 20")).toBeNull();
  });
});

describe("consequenceOf", () => {
  const today = "2026-09-30";
  const names: Record<string, string> = { u1: "Daniel Okai", u2: "Theo Vance", u3: "Sana Rahman" };
  const nameOf = (id: string) => names[id];
  const deck = mk({ id: "deck", title: "Launch deck", dueDate: today, assigneeId: "u1", aiReason: "High impact." });
  const kit = mk({ id: "kit", title: "Press kit", dependencies: ["deck"], assigneeId: "u2", dueDate: "2026-10-02" });
  const brief = mk({ id: "brief", title: "Sales brief", dependencies: ["deck"], assigneeId: "u3", dueDate: "2026-10-05" });
  const shipped = mk({ id: "old", title: "Old thing", dependencies: ["deck"], status: "done" });

  it("names who starts late when a task that blocks others is due today", () => {
    expect(consequenceOf(deck, [deck, kit, brief, shipped], today, { nameOf })).toEqual({
      kind: "blocking", text: "Blocks 2 tasks and is due today. If it slips, Press kit (Theo) starts late.",
    });
  });
  it("says who is waiting when it's already overdue", () => {
    const late = { ...deck, dueDate: "2026-09-28" };
    expect(consequenceOf(late, [late, kit], today, { nameOf })?.text).toBe("Blocks 1 task and is 2 days overdue. Press kit (Theo) is waiting on it.");
  });
  it("says what a blocked task is waiting on, and for how long when it knows", () => {
    expect(consequenceOf(kit, [deck, kit], today, { nameOf })).toEqual({ kind: "blocked", blockerId: "deck", text: "Blocked by “Launch deck” (Daniel)." });
    expect(consequenceOf(kit, [deck, kit], today, { nameOf, blockedSince: "2026-09-27T10:00:00" })?.text).toBe("Blocked for 3 days by “Launch deck” (Daniel).");
    const two = { ...kit, dependencies: ["deck", "brief"] };
    expect(consequenceOf(two, [deck, brief, two], today, { nameOf })?.text).toBe("Blocked by “Launch deck” (Daniel) and 1 more.");
  });
  it("ignores finished blockers, then falls back to overdue, then to Kanbo's reason", () => {
    const doneDeck = { ...deck, status: "done" as const };
    const late = { ...kit, dueDate: "2026-09-28", aiReason: "Quick win." };
    expect(consequenceOf(late, [doneDeck, late], today)).toEqual({ kind: "overdue", text: "Overdue since Mon 28 Sep." });
    expect(consequenceOf({ ...late, dueDate: "2026-10-09" }, [doneDeck, late], today)).toEqual({ kind: "reason", text: "Quick win." });
    expect(consequenceOf(mk({ id: "q" }), [], today)).toBeNull();
    expect(consequenceOf({ ...deck, status: "done" }, [deck, kit], today)).toBeNull();
  });
  it("doesn't warn about blocking when the task isn't due yet", () => {
    const later = { ...deck, dueDate: "2026-10-09" };
    expect(consequenceOf(later, [later, kit], today)?.kind).toBe("reason");
  });
});

describe("due-date slip history", () => {
  const today = "2026-09-30";
  const ev = (field: string, oldValue: string | null, newValue: string | null): HistoryEvent => ({ id: Math.random().toString(36), actorName: "Sana", field, oldValue, newValue, createdAt: "2026-09-29T10:00:00Z" });
  it("counts only real moves", () => {
    expect(dueMoves([ev("due", null, "2026-10-01"), ev("due", "2026-10-01", "2026-10-03"), ev("due", "2026-10-03", "2026-10-06"), ev("status", "todo", "done"), ev("due", "2026-10-06", null)])).toBe(2);
  });
  it("reads as moved, brought forward or pushed back", () => {
    expect(slipNote({ dueDate: "2026-10-06", originalDueDate: "2026-10-02" }, 2, today)).toBe("Moved 2× · first due Fri 2 Oct");
    expect(slipNote({ dueDate: "2026-09-30", originalDueDate: "2026-10-02" }, 0, today)).toBe("Brought forward from Fri 2 Oct");
    expect(slipNote({ dueDate: "2026-10-06", originalDueDate: "2026-10-02" }, 0, today)).toBe("Pushed back from Fri 2 Oct");
    expect(slipNote({ dueDate: "2026-10-06" }, 1, today)).toBe("Moved 1×");
    expect(slipNote({ dueDate: "2026-10-06", originalDueDate: "2026-10-06" }, 0, today)).toBeNull();
  });
  it("never reads a repeating task's series anchor as a slip", () => {
    expect(slipNote({ dueDate: "2026-10-31", originalDueDate: "2026-08-31", recurrence: "monthly" }, 3, today)).toBeNull();
  });
  it("words history rows", () => {
    const nameOf = (id: string) => (id === "u2" ? "Theo Vance" : undefined);
    expect(eventText(ev("due", "2026-10-02", "2026-09-30"), nameOf, today)).toBe("moved due Fri 2 Oct → Wed 30 Sep");
    expect(eventText(ev("due", null, "2026-09-30"), nameOf, today)).toBe("set due Wed 30 Sep");
    expect(eventText(ev("due", "2026-09-30", null), nameOf, today)).toBe("cleared the due date");
    expect(eventText(ev("status", "todo", "progress"), nameOf)).toBe("changed status to In progress");
    expect(eventText(ev("status", "progress", "done"), nameOf)).toBe("completed it");
    expect(eventText(ev("priority", "low", "urgent"), nameOf)).toBe("set priority to Urgent");
    expect(eventText(ev("assignee", null, "u2"), nameOf)).toBe("assigned Theo Vance");
    expect(eventText(ev("assignee", "u2", null), nameOf)).toBe("unassigned it");
  });
  it("words approval history (0047: new_value = what happened, old_value = the status after it)", () => {
    expect(eventText(ev("approval", "pending", "requested"))).toBe("asked for approval");
    expect(eventText(ev("approval", "pending", "approved"))).toBe("approved it, still waiting on others");
    expect(eventText(ev("approval", "approved", "approved"))).toBe("approved it");
    expect(eventText(ev("approval", "changes_requested", "changes_requested"))).toBe("asked for changes");
    expect(eventText(ev("approval", "cancelled", "cancelled"))).toBe("cancelled the approval request");
  });
});

describe("buildTimeline", () => {
  const c = (id: string, at: string, parentId?: string): Comment => ({ id, taskId: "t1", authorId: "u1", authorName: "Me", body: id, createdAt: at, parentId });
  const e = (id: string, at: string, field = "due", newValue: string | null = "2026-10-01"): HistoryEvent => ({ id, actorName: "Sana", field, oldValue: null, newValue, createdAt: at });
  const a = (id: string, at: string, kind: Activity["kind"], taskId = "t1"): Activity => ({ id, taskId, taskTitle: "T", kind, detail: "Maya", createdAt: at });

  it("merges comments, history and notifications oldest first, keeping replies with their thread", () => {
    const items = buildTimeline(
      [c("c2", "2026-09-30T10:00:00Z"), c("c1", "2026-09-29T09:00:00Z"), c("r1", "2026-09-30T12:00:00Z", "c1")],
      [e("e1", "2026-09-29T11:00:00Z")],
      [a("a1", "2026-09-30T11:00:00Z", "mention"), a("a2", "2026-09-30T11:00:00Z", "comment"), a("a3", "2026-09-30T11:00:00Z", "mention", "t2")],
      "t1",
    );
    expect(items.map((i) => i.id)).toEqual(["c1", "r1", "e-e1", "c2", "a-a1"]);
    expect(items.find((i) => i.id === "r1")).toMatchObject({ depth: 1 });
  });
  it("promotes a reply whose parent was deleted", () => {
    expect(buildTimeline([c("r1", "2026-09-30T12:00:00Z", "gone")], [], [], "t1")).toMatchObject([{ id: "r1", depth: 0 }]);
  });
  it("leaves out a notification that repeats a history row", () => {
    const items = buildTimeline([], [e("e1", "2026-09-30T10:00:00Z", "assignee", "u1"), e("e2", "2026-09-30T10:01:00Z", "status", "done")],
      [a("a1", "2026-09-30T10:00:30Z", "assigned"), a("a2", "2026-09-30T10:02:00Z", "completed"), a("a3", "2026-09-29T10:00:00Z", "assigned")], "t1");
    expect(items.map((i) => i.id)).toEqual(["a-a3", "e-e1", "e-e2"]);
  });
  it("leaves out an approval notice that repeats its history row", () => {
    const items = buildTimeline([], [e("e1", "2026-09-30T10:00:00Z", "approval", "requested")],
      [a("a1", "2026-09-30T10:00:01Z", "approval"), a("a2", "2026-09-28T10:00:00Z", "approval")], "t1");
    expect(items.map((i) => i.id)).toEqual(["a-a2", "e-e1"]);
  });
});
