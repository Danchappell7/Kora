import { describe, it, expect, beforeEach } from "vitest";
import { taskMatchesQuery, toQuery, isQueryActive, queriesEqual, searchTerms, searchRank, EMPTY_QUERY, type Query } from "./searchQuery";
import { setReferenceData, dayOffset } from "../data/data";
import type { Task, Member, Project } from "../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-live", assigneeId: "u-me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const member = (id: string, name: string): Member => ({ id, name, email: `${id}@example.com`, type: "team", color: "#888" });
const project = (id: string, name: string, archivedAt?: string): Project => ({ id, name, emoji: "", color: "#888", workspaceId: "ws", archivedAt: archivedAt ?? null });
const q = (o: Partial<Query>): Query => ({ ...EMPTY_QUERY, ...o });

beforeEach(() => {
  setReferenceData({
    members: [member("u-me", "Dan Chappell"), member("u-sarah", "Sarah Jones"), member("u-zoe", "Zoë Brontë")],
    projects: [project("p-live", "Q3 Marketing"), project("p-old", "Old Launch", "2026-09-01T00:00:00Z")],
  });
});

describe("archived projects", () => {
  const live = task({ id: "a", projectId: "p-live", dueDate: dayOffset(-3) });
  const old = task({ id: "b", projectId: "p-old", dueDate: dayOffset(-3) });

  it("leaves out tasks whose project is archived", () => {
    expect(taskMatchesQuery(live, q({ due: "overdue" }))).toBe(true);
    expect(taskMatchesQuery(old, q({ due: "overdue" }))).toBe(false);
    expect(taskMatchesQuery(old, EMPTY_QUERY)).toBe(false);
  });

  it("includes them when includeArchived is on", () => {
    expect(taskMatchesQuery(old, q({ due: "overdue", includeArchived: true }))).toBe(true);
  });

  it("still never returns an archived task", () => {
    expect(taskMatchesQuery(task({ archivedAt: "2026-09-01" }), q({ includeArchived: true }))).toBe(false);
  });

  it("re-reads the project, so archiving takes effect immediately", () => {
    expect(taskMatchesQuery(live, EMPTY_QUERY)).toBe(true);
    setReferenceData({ projects: [project("p-live", "Q3 Marketing", "2026-09-30T00:00:00Z")] });
    expect(taskMatchesQuery(live, EMPTY_QUERY)).toBe(false);
  });
});

describe("text search", () => {
  const t = task({ title: "Q3 marketing budget review", assigneeId: "u-sarah", tags: ["finance"] });

  it("matches every word in any order", () => {
    expect(taskMatchesQuery(t, q({ text: "budget Q3" }))).toBe(true);
    expect(taskMatchesQuery(t, q({ text: "review   budget" }))).toBe(true);
    expect(taskMatchesQuery(t, q({ text: "budget forecast" }))).toBe(false);
  });

  it("matches words across fields (assignee name + title word, tags)", () => {
    expect(taskMatchesQuery(t, q({ text: "Sarah budget" }))).toBe(true);
    expect(taskMatchesQuery(t, q({ text: "finance review" }))).toBe(true);
  });

  it("finds tasks by a collaborator's name", () => {
    expect(taskMatchesQuery(task({ title: "Plan offsite", collaborators: ["u-zoe"] }), q({ text: "zoe offsite" }))).toBe(true);
  });

  it("keeps quoted phrases together, including curly quotes", () => {
    expect(taskMatchesQuery(t, q({ text: '"budget review"' }))).toBe(true);
    expect(taskMatchesQuery(t, q({ text: '"review budget"' }))).toBe(false);
    expect(taskMatchesQuery(t, q({ text: "“budget review”" }))).toBe(true);
  });

  it("ignores accents and case", () => {
    expect(taskMatchesQuery(task({ title: "Café opening" }), q({ text: "CAFE" }))).toBe(true);
    expect(taskMatchesQuery(task({ title: "Cafe opening" }), q({ text: "café" }))).toBe(true);
  });

  it("parses terms robustly", () => {
    expect(searchTerms("  a   b ")).toEqual(["a", "b"]);
    expect(searchTerms('"unclosed phrase')).toEqual(["unclosed", "phrase"]);
    expect(searchTerms('""')).toEqual([]);
    expect(searchTerms('x "  two   words " y')).toEqual(["x", "two words", "y"]);
  });

  it("ranks title matches and open work first", () => {
    const titleOpen = task({ id: "1", title: "Budget" });
    const titleDone = task({ id: "2", title: "Budget", status: "done" });
    const descOpen = task({ id: "3", title: "Plan", description: "budget" });
    const query = q({ text: "budget" });
    expect(searchRank(titleOpen, query)).toBeLessThan(searchRank(titleDone, query));
    expect(searchRank(titleDone, query)).toBeLessThan(searchRank(descOpen, query));
    expect(searchRank(descOpen, EMPTY_QUERY)).toBe(0);
  });
});

describe("filters", () => {
  it("'open' status hides done tasks", () => {
    expect(taskMatchesQuery(task({ status: "done" }), q({ status: "open" }))).toBe(false);
    expect(taskMatchesQuery(task({ status: "review" }), q({ status: "open" }))).toBe(true);
  });

  it("assignee filter includes collaborators", () => {
    expect(taskMatchesQuery(task({ assigneeId: "u-sarah", collaborators: ["u-me"] }), q({ assignee: "u-me" }))).toBe(true);
    expect(taskMatchesQuery(task({ assigneeId: "u-sarah" }), q({ assignee: "u-me" }))).toBe(false);
  });
});

describe("query helpers", () => {
  it("toQuery keeps strings, drops garbage and reads includeArchived", () => {
    const out = toQuery({ text: 5, status: "open", includeArchived: "true", junk: "x" } as Record<string, unknown>);
    expect(out.text).toBe("");
    expect(out.status).toBe("open");
    expect(out.includeArchived).toBe(true);
    expect(toQuery(null)).toEqual(EMPTY_QUERY);
    expect(toQuery({ includeArchived: "yes please" }).includeArchived).toBe(false);
  });

  it("the archived switch alone isn't an active search", () => {
    expect(isQueryActive(EMPTY_QUERY)).toBe(false);
    expect(isQueryActive(q({ includeArchived: true }))).toBe(false);
    expect(isQueryActive(q({ text: "  " }))).toBe(false);
    expect(isQueryActive(q({ status: "open" }))).toBe(true);
  });

  it("queriesEqual treats a missing includeArchived as off and trims text", () => {
    const { includeArchived: _drop, ...noFlag } = q({ due: "today" });
    expect(queriesEqual(noFlag as Query, q({ due: "today" }))).toBe(true);
    expect(queriesEqual(q({ text: " a " }), q({ text: "a" }))).toBe(true);
    expect(queriesEqual(q({ due: "today" }), q({ due: "today", includeArchived: true }))).toBe(false);
  });
});
