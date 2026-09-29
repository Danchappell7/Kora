import { describe, it, expect, beforeEach } from "vitest";
import {
  resolveMentions, wouldCreateCycle, dependencyCandidates, activityLine, isTextEntry,
  attachmentOwnerId, canDeleteAttachment, readDraft, writeDraft,
} from "./taskDetailHelpers";
import type { Task } from "../data/types";

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
    expect(activityLine({ kind: "comment", detail: "Theo Vance" })).toBe("Theo Vance commented");
    expect(activityLine({ kind: "assigned", detail: "" })).toBe("Someone assigned you");
    expect(activityLine({ kind: "completed", detail: "Marked complete" })).toBe("Marked complete");
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
});

describe("comment drafts", () => {
  beforeEach(() => sessionStorage.clear());
  it("persist per task and clear when emptied", () => {
    writeDraft("t1", "half a thought");
    expect(readDraft("t1")).toBe("half a thought");
    expect(readDraft("t2")).toBe("");
    writeDraft("t1", "   ");
    expect(readDraft("t1")).toBe("");
  });
});
