import { describe, it, expect } from "vitest";
import { pageViewQuery, pageStateFromView, suggestViewName, applyViewToTasksPageStorage } from "./pageQuery";
import { describeView, describeViewLine } from "./describe";

describe("a tasks page as a view, and back", () => {
  it("My tasks: only what's filtered goes in; grouping and sort ride along but don't make it saveable", () => {
    expect(pageViewQuery({ scope: "my", tab: "open", groupBy: "priority", sort: "due" })).toEqual({
      kind: "my_tasks", active: false, query: { v: 1, list: "open", groupBy: "priority", sort: "due" },
    });
    const out = pageViewQuery({ scope: "my", tab: "waiting", priority: "urgent", assignee: "all", tag: "design", hideDone: true, custom: { f1: "Web", f2: "all" }, text: "  deck ", sort: "manual" });
    expect(out.active).toBe(true);
    expect(out.query).toEqual({ v: 1, list: "waiting", filters: { priority: "urgent", tag: "design", hideDone: true, "cf:f1": "Web", text: "deck" } });
  });

  it("a project: its view type (list when it's another tab)", () => {
    expect(pageViewQuery({ scope: "project", projectId: "p-launch", tab: "board", status: "blocked", groupBy: "assignee" }).query)
      .toEqual({ v: 1, projectId: "p-launch", viewType: "board", filters: { status: "blocked" }, groupBy: "assignee" });
    expect(pageViewQuery({ scope: "project", projectId: "p-launch", tab: "files" }).query.viewType).toBe("list");
  });

  it("round-trips into the page's own filter record, with “@me” as the viewer", () => {
    const { kind, query } = pageViewQuery({ scope: "project", projectId: "p-launch", tab: "calendar", section: "__none", due: "week", custom: { f1: "Web" }, text: "deck", sortDir: "desc" });
    const back = pageStateFromView({ kind, query: { ...query, filters: { ...query.filters, assignee: "@me" } } }, "u-me");
    expect(back).toMatchObject({ scope: "project", projectId: "p-launch", tab: "calendar", text: "deck", sortDir: "desc" });
    expect(back.filters).toEqual({ priority: "all", assignee: "u-me", tag: "all", due: "week", status: "all", section: "__none", hideDone: false, showArchived: false, custom: { f1: "Web" } });
    expect(pageStateFromView({ kind: "my_tasks", query: { v: 1 } }, "u").tab).toBe("open");
  });

  it("arriving on a view writes what TasksPage and App read on mount", () => {
    localStorage.clear();
    localStorage.setItem("kanbo-pview-p-launch", JSON.stringify({ view: "list", groupBy: "status" }));
    const s = applyViewToTasksPageStorage({ kind: "project", query: { v: 1, projectId: "p-launch", viewType: "list", filters: { priority: "high", text: "deck" }, groupBy: "section", sort: "due" } }, "u");
    expect(s.text).toBe("deck");
    expect(JSON.parse(localStorage.getItem("kanbo-filters:p-launch")!)).toMatchObject({ priority: "high", status: "all", showArchived: false });
    expect(JSON.parse(localStorage.getItem("kanbo-pview-p-launch")!)).toEqual({ view: "list", groupBy: "section" });
    expect(localStorage.getItem("kanbo-sort")).toBe("due");
    applyViewToTasksPageStorage({ kind: "project", query: { v: 1, projectId: "p-launch", viewType: "board", groupBy: "assignee" } }, "u");
    expect(localStorage.getItem("kanbo-board-group")).toBe("assignee");
    applyViewToTasksPageStorage({ kind: "my_tasks", query: { v: 1, filters: { assignee: "@me" }, groupBy: "priority" } }, "u-me");
    expect(localStorage.getItem("kanbo-groupby-my")).toBe("priority");
    expect(JSON.parse(localStorage.getItem("kanbo-filters:my")!).assignee).toBe("u-me");
  });

  it("suggests a short name from the filters", () => {
    expect(suggestViewName({ scope: "project", projectId: "p-launch", status: "blocked" })).toBe("Blocked in Q3 Product Launch");
    expect(suggestViewName({ scope: "my", priority: "urgent", tag: "design", due: "overdue", text: "deck" })).toBe("Urgent · Design · Overdue");
    expect(suggestViewName({ scope: "my" })).toBe("My view");
    expect(suggestViewName({ scope: "my", assignee: "m-3" })).toBe("Sana");
  });
});

describe("a view in words", () => {
  it("says where it opens and what it filters, groups and sorts by", () => {
    expect(describeView("project", { v: 1, projectId: "p-launch", viewType: "board", filters: { status: "blocked", assignee: "@me" }, groupBy: "assignee" }))
      .toEqual({ where: "Q3 Product Launch · Board", parts: ["Status: Blocked", "Assigned to whoever's looking", "Grouped by assignee"] });
    expect(describeView("my_tasks", { v: 1, list: "waiting", filters: { priority: "urgent", tag: "design", due: "week", hideDone: true, "cf:x": "1", text: "deck" }, sort: "due", sortDir: "desc" }, { viewer: "m-self" }))
      .toEqual({ where: "My tasks · Waiting on", parts: ["Priority: Urgent", "Tag: Design", "Due in the next 7 days", "Done tasks hidden", "1 custom field", "Title contains “deck”", "Sorted by due date (descending)"] });
  });
  it("search views: the words, kinds, scope, people and dates", () => {
    const d = describeView("search", { v: 1, search: { text: "pricing", filters: { kinds: ["doc", "comment"], workspaceId: "ws-1", authorId: "m-self", dueFrom: "2026-10-05", dueTo: "2026-10-11", excludeDone: true } } },
      { viewer: "m-self", workspaceName: () => "Foundrise" });
    expect(d.where).toBe("Search for “pricing”");
    expect(d.parts).toEqual(["Docs, Comments only", "In Foundrise", "Open only", "Due 5 Oct–11 Oct", "Comments by you"]);
    expect(describeView("search", { v: 1, filters: { text: "old words", assignee: "m-3" } }).parts).toEqual(["Assigned to Sana Rao"]);
    expect(describeView("search", { v: 1, search: { text: "", filters: { workspaceId: null } } }).parts).toEqual(["Personal only"]);
  });
  it("one line for lists", () => {
    expect(describeViewLine("my_tasks", { v: 1 })).toBe("My tasks · Open");
    expect(describeViewLine("my_tasks", { v: 1, filters: { section: "s1" } }, { sectionName: () => "Backlog" })).toBe("My tasks · Open — Section: Backlog");
  });
});
