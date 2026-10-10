import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { parseTask } from "../../lib/nlp";
import { refreshClock } from "../../data/data";
import {
  parseQuickAdd, tidyDictation, oneLine, quickAddTask, recentProjectIds, projectChips, readingSummary, liveKept,
} from "./quickAdd";

// Friday 9 October 2026, mid-morning, London
const NOW = new Date("2026-10-09T10:00:00+01:00");
const today = new Date(2026, 9, 9);
const projects = [{ id: "p-launch", name: "Launch" }, { id: "p-hire", name: "Hiring" }];
const members = [{ id: "m-1", name: "Sana Rao" }, { id: "m-2", name: "May Lee" }];
const ctx = { today, projects, members };

beforeAll(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); refreshClock(NOW); });
afterAll(() => { vi.useRealTimers(); refreshClock(new Date()); });

describe("parseQuickAdd", () => {
  it("reads exactly as the grammar does when nothing is kept", () => {
    const text = "Call @sana tomorrow 3pm #launch !high";
    const r = parseQuickAdd(text, ctx);
    const p = parseTask(text, ctx);
    expect(r).toEqual({ ...p, kept: [] });
    expect(r).toMatchObject({ title: "Call", dueDate: "2026-10-10", dueTime: "15:00", projectId: "p-launch", assigneeId: "m-1", priority: "high" });
  });

  it("a kept token stays in the title as words, and isn't read", () => {
    const r = parseQuickAdd("Book drinks friday", ctx, [{ text: "friday", kind: "date" }]);
    expect(r.title).toBe("Book drinks friday");
    expect(r.dueDate).toBeUndefined();
    expect(r.spans).toEqual([]);
    expect(r.kept).toEqual([{ start: 12, end: 18, text: "friday", kind: "date" }]);
  });

  it("stays kept as more is typed around it, in any case, while the rest is still read", () => {
    expect(parseTask("Prep FRIDAY drinks list tomorrow 9am", ctx).dueDate).toBe("2026-10-16");
    const r = parseQuickAdd("Prep FRIDAY drinks list tomorrow 9am", ctx, [{ text: "friday", kind: "date" }]);
    expect(r.title).toBe("Prep FRIDAY drinks list");
    expect(r).toMatchObject({ dueDate: "2026-10-10", dueTime: "09:00" });
    expect(r.kept.map((k) => k.text)).toEqual(["FRIDAY"]);
  });

  it("keeps several, of different kinds", () => {
    const r = parseQuickAdd("Thank @may for the #launch slides tomorrow", ctx, [{ text: "@may", kind: "person" }, { text: "#launch", kind: "project" }]);
    expect(r.title).toBe("Thank @may for the #launch slides");
    expect(r.assigneeId).toBeUndefined();
    expect(r.projectId).toBeUndefined();
    expect(r.dueDate).toBe("2026-10-10");
    expect(r.kept.map((k) => k.kind)).toEqual(["person", "project"]);
  });

  it("a kept token of another kind doesn't hide a real one", () => {
    const r = parseQuickAdd("Call Sana friday", ctx, [{ text: "friday", kind: "start" }]);
    expect(r.dueDate).toBeDefined();
    expect(r.kept).toEqual([]);
  });
});

describe("dictation", () => {
  it("drops the full stop a dictated sentence ends with, not an ellipsis or an abbreviation", () => {
    expect(tidyDictation("Call the bank.")).toBe("Call the bank");
    expect(tidyDictation("Wait for news...")).toBe("Wait for news...");
    expect(tidyDictation("Buy pens, paper etc.")).toBe("Buy pens, paper etc.");
    expect(tidyDictation("  Review   the  deck \n")).toBe("Review the deck");
    expect(tidyDictation("Is it done?")).toBe("Is it done?");
  });
  it("a spoken or pasted new line is a space", () => {
    expect(oneLine("Call Sana\nabout the deck")).toBe("Call Sana about the deck");
    expect(oneLine("one \r\n  two")).toBe("one two");
  });
  it("reads a dictated sentence, punctuation and all", () => {
    const r = parseQuickAdd("Call the bank tomorrow at 3 p.m.", ctx);
    expect(quickAddTask(r)).toMatchObject({ title: "Call the bank", dueDate: "2026-10-10", dueTime: "15:00" });
  });
});

describe("quickAddTask", () => {
  it("sends what Quick capture sends", () => {
    const r = parseQuickAdd("Draft offer @may today 4pm ~30m !urgent", ctx);
    expect(quickAddTask(r, "p-hire")).toEqual({
      title: "Draft offer", priority: "urgent", status: "todo", dueDate: "2026-10-09", dueTime: "16:00",
      assigneeId: "m-2", projectId: "p-hire", effortHours: 0.5, planToday: true,
    });
  });
  it("nothing to add without a title", () => {
    expect(quickAddTask(parseQuickAdd("tomorrow 3pm", ctx))).toBeNull();
    expect(quickAddTask(parseQuickAdd("   .", ctx))).toBeNull();
  });
});

describe("recent projects", () => {
  const tasks = [
    { projectId: "p-a", createdAt: "2026-10-01T09:00:00Z", assigneeId: "me" },
    { projectId: "p-b", createdAt: "2026-10-08T09:00:00Z", assigneeId: "me" },
    { projectId: "p-c", createdAt: "2026-10-09T08:00:00Z", assigneeId: "someone", createdBy: "me" },
    { projectId: "p-d", createdAt: "2026-10-09T09:00:00Z", assigneeId: "someone" },
    { projectId: "p-b", createdAt: "2026-10-02T09:00:00Z", assigneeId: "me" },
    { projectId: "p-e", createdAt: "2026-10-09T09:30:00Z", assigneeId: "me", archivedAt: "2026-10-09T09:31:00Z" },
    { projectId: "p-gone", createdAt: "2026-10-09T09:40:00Z", assigneeId: "me" },
  ];
  const live = ["p-a", "p-b", "p-c", "p-d", "p-e"].map((id) => ({ id }));
  it("newest first, mine only, existing projects, no archived tasks", () => {
    expect(recentProjectIds(tasks, { userId: "me", projects: live })).toEqual(["p-c", "p-b", "p-a"]);
    expect(recentProjectIds(tasks, { projects: live, limit: 2 })).toEqual(["p-d", "p-c"]);
  });
  it("chips: the project you're in first, then picks, then recents — at most five, no repeats", () => {
    const exists = (id: string) => id !== "x";
    expect(projectChips({ defaultId: "p-a", picked: ["p-b", "p-a"], recent: ["p-c", "x", "p-b", "p-d", "p-e", "p-f"] }, exists))
      .toEqual(["p-a", "p-b", "p-c", "p-d", "p-e"]);
    expect(projectChips({}, exists)).toEqual([]);
  });
});

describe("what's said to a screen reader", () => {
  it("sums up the reading", () => {
    const r = parseQuickAdd("Call @sana tomorrow 3pm !high ~1h", ctx);
    expect(readingSummary(r, { project: "Launch", person: "Sana Rao" })).toBe("Due Sat 10 Oct at 15:00 · High priority · 1h estimate · In Launch · For Sana Rao");
    expect(readingSummary(parseQuickAdd("Plain words", ctx), {})).toBe("");
    expect(readingSummary(parseQuickAdd("me @sana", ctx), { person: "Sana Rao", you: true })).toBe("For you");
  });
  it("forgets kept words once they're gone from the text", () => {
    expect(liveKept("Book drinks", [{ text: "friday", kind: "date" }, { text: "drinks", kind: "tag" }])).toEqual([{ text: "drinks", kind: "tag" }]);
  });
});
