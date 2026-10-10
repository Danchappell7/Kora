import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Project, Task } from "../../data/types";
import { setReferenceData } from "../../data/data";
import { taskMatchesQuery, toQuery } from "../searchQuery";
import { smartListQuery, SMART_LISTS } from "../smartLists";
import { localSearch } from "../searchApi";
import { searchFiltersToRpc } from "../searchRows";
import type { SearchNLContext } from "../searchNL";
import {
  EMPTY_PANEL, panelFromQuery, panelToFilters, panelActive, panelCount, resolveSearch, searchToViewQuery, searchFromViewQuery,
  searchFromPreset, toLegacyQuery, matchesSavedSearch, suggestSearchName, localTaskMatches, hasExtras, type SearchPanel,
} from "./searchSpec";

const TODAY = "2026-10-09";
const PROJECTS: Project[] = [
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1" },
  { id: "p-old", name: "Old", emoji: "", color: "grey", workspaceId: "ws-1", archivedAt: "2026-09-01T00:00:00Z" },
];
const CTX: SearchNLContext & { projects: Project[] } = {
  members: [{ id: "m-self", name: "Daniel Okai" }, { id: "m-1", name: "Maya Lin" }, { id: "m-2", name: "Theo Vance" }],
  projects: PROJECTS, currentUserId: "m-self", today: TODAY,
};
const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, workspaceId: "ws-1", ...o,
});
const off = (n: number) => { const d = new Date(Date.UTC(2026, 9, 9 + n)); return d.toISOString().slice(0, 10); };
const TASKS: Task[] = [
  task({ id: "a", title: "Due today", dueDate: off(0) }),
  task({ id: "b", title: "Done today", dueDate: off(0), status: "done" }),
  task({ id: "c", title: "Overdue", dueDate: off(-2) }),
  task({ id: "d", title: "Next week", dueDate: off(6), assigneeId: "m-1" }),
  task({ id: "e", title: "Later", dueDate: off(20), collaborators: ["m-self"], assigneeId: "m-2" }),
  task({ id: "f", title: "No date", priority: "urgent", tags: ["design"] }),
  task({ id: "g", title: "Old project", projectId: "p-old", dueDate: off(0) }),
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  setReferenceData({ projects: PROJECTS, members: CTX.members.map((m) => ({ ...m, email: `${m.id}@x.test`, type: "team" as const, color: "#888" })) });
});
afterEach(() => { vi.useRealTimers(); });

/** the Search view's task rule for a panel (no words) */
const viaPanel = (panel: SearchPanel) => {
  const r = resolveSearch("", panel, CTX, TODAY);
  const viaDevice = localTaskMatches(TASKS, r, (id) => PROJECTS.find((p) => p.id === id)).map((t) => t.id).sort();
  // where the server could answer too, the device's general search agrees
  if (!hasExtras(r.extras) && r.active) {
    expect(localSearch({ text: "", filters: r.filters, tasks: TASKS, projects: PROJECTS, members: [], currentUserId: "m-self", limit: 999 }).map((h) => h.id).sort()).toEqual(viaDevice);
  }
  return viaDevice;
};

describe("the panel keeps the old Search's meaning", () => {
  it("every smart list lists exactly what its sidebar count counts", () => {
    for (const list of SMART_LISTS) {
      const preset = smartListQuery(list.id, "m-self")!;
      const counted = TASKS.filter((t) => taskMatchesQuery(t, toQuery(preset))).map((t) => t.id).sort();
      expect(viaPanel(panelFromQuery(preset)), list.id).toEqual(counted);
    }
  });
  it("priority, tag, has / no due date are applied on the device", () => {
    expect(viaPanel({ ...EMPTY_PANEL, priority: "urgent" })).toEqual(["f"]);
    expect(viaPanel({ ...EMPTY_PANEL, tag: "design" })).toEqual(["f"]);
    expect(viaPanel({ ...EMPTY_PANEL, due: "none" })).toEqual(["f"]);
    expect(viaPanel({ ...EMPTY_PANEL, due: "has" })).toEqual(["a", "b", "c", "d", "e"]);
    expect(panelToFilters({ ...EMPTY_PANEL, due: "has", priority: "high" }, TODAY)).toEqual({ filters: {}, extras: { hasDue: true, priority: "high" } });
  });
  it("scope, author and kind go to the server's filters", () => {
    expect(panelToFilters({ ...EMPTY_PANEL, scope: "personal", author: "m-2", kind: "comment" }, TODAY).filters)
      .toEqual({ workspaceId: null, authorId: "m-2", kinds: ["comment"] });
    expect(panelToFilters({ ...EMPTY_PANEL, scope: "ws-1" }, TODAY).filters).toEqual({ workspaceId: "ws-1" });
  });
  it("what counts as active, and the Filters count", () => {
    expect(panelActive(EMPTY_PANEL)).toBe(false);
    expect(panelActive({ ...EMPTY_PANEL, kind: "doc", includeArchived: true })).toBe(false);
    expect(panelActive({ ...EMPTY_PANEL, scope: "personal" })).toBe(true);
    expect(panelCount({ ...EMPTY_PANEL, status: "open", includeArchived: true })).toBe(2);
  });
});

describe("resolveSearch: chips over the panel", () => {
  it("a chip wins on its own field; the panel fills the rest", () => {
    const r = resolveSearch("Maya's tasks due next week", { ...EMPTY_PANEL, assignee: "m-2", due: "has", status: "open" }, CTX, TODAY);
    expect(r.filters).toEqual({ assigneeId: "m-1", excludeDone: true, dueFrom: "2026-10-12", dueTo: "2026-10-18", kinds: ["task"] });
    expect(r.extras).toEqual({});   // the due chip replaces "has a due date"
  });
  it("a status chip replaces the panel's 'open'", () => {
    expect(resolveSearch("done", { ...EMPTY_PANEL, status: "open" }, CTX, TODAY).filters).toEqual({ statuses: ["done"], kinds: ["task"] });
  });
  it("kinds: asked for, task filters → tasks, else everything", () => {
    expect(resolveSearch("pricing", EMPTY_PANEL, CTX, TODAY).kinds).toEqual(["task", "comment", "doc", "project", "person"]);
    expect(resolveSearch("pricing in launch", EMPTY_PANEL, CTX, TODAY).kinds).toHaveLength(5);
    expect(resolveSearch("blocked pricing", EMPTY_PANEL, CTX, TODAY).kinds).toEqual(["task"]);
    expect(resolveSearch("pricing", { ...EMPTY_PANEL, priority: "high" }, CTX, TODAY).kinds).toEqual(["task"]);
    expect(resolveSearch("docs mentioning pricing", { ...EMPTY_PANEL, kind: "comment" }, CTX, TODAY).kinds).toEqual(["doc"]);
    expect(resolveSearch("pricing", { ...EMPTY_PANEL, kind: "person" }, CTX, TODAY).kinds).toEqual(["person"]);
  });
  it("active: words, or something that narrows; a scope or archived alone isn't a search", () => {
    expect(resolveSearch("", EMPTY_PANEL, CTX, TODAY).active).toBe(false);
    expect(resolveSearch('"', { ...EMPTY_PANEL, scope: "personal", includeArchived: true }, CTX, TODAY).active).toBe(false);
    expect(resolveSearch("overdue", EMPTY_PANEL, CTX, TODAY).active).toBe(true);
    expect(resolveSearch("", { ...EMPTY_PANEL, tag: "design" }, CTX, TODAY).active).toBe(true);
  });
});

describe("saved searches", () => {
  it("a search view keeps the words as typed and the panel, and comes back the same", () => {
    const panel: SearchPanel = { ...EMPTY_PANEL, kind: "doc", scope: "ws-1", priority: "high", includeArchived: true, author: "m-2" };
    const q = searchToViewQuery("  pricing due friday ", panel);
    expect(q).toEqual({ v: 1, search: { text: "pricing due friday", filters: { kinds: ["doc"], workspaceId: "ws-1", authorId: "m-2", includeArchived: true } }, filters: { priority: "high", includeArchived: true } });
    expect(searchFromViewQuery(q, CTX)).toEqual({ input: "pricing due friday", panel });
    expect(searchFromViewQuery(searchToViewQuery("x", { ...EMPTY_PANEL, scope: "personal" }), CTX).panel.scope).toBe("personal");
  });
  it("an adopted old saved search: its text stays text, its fields fill the panel", () => {
    const r = searchFromViewQuery({ v: 1, filters: { text: "overdue report", status: "open", assignee: "m-1" } }, CTX);
    expect(r.input).toBe('"overdue" report');
    expect(r.panel).toMatchObject({ status: "open", assignee: "m-1" });
    expect(searchFromPreset({ text: "budget", priority: "urgent" }, CTX)).toEqual({ input: "budget", panel: { ...EMPTY_PANEL, priority: "urgent" } });
  });
  it("the old shape for the old Save: chips become its fields (for the sidebar's count), the words are kept", () => {
    const q = toLegacyQuery("Maya's overdue tasks in launch about pricing", { ...EMPTY_PANEL, tag: "design" }, CTX, TODAY);
    expect(q).toEqual({ text: "pricing", status: "all", priority: "all", assignee: "m-1", projectId: "p-launch", tag: "design", due: "overdue", includeArchived: false, input: "Maya's overdue tasks in launch about pricing" });
    // reading it back: the words make the chips, and the panel doesn't repeat them
    expect(searchFromPreset(q, CTX)).toEqual({ input: "Maya's overdue tasks in launch about pricing", panel: { ...EMPTY_PANEL, tag: "design" } });
    expect(toLegacyQuery("alpha", EMPTY_PANEL, CTX, TODAY)).toEqual(expect.objectContaining({ text: "alpha" }));
    expect(toLegacyQuery("alpha", EMPTY_PANEL, CTX, TODAY)).not.toHaveProperty("input");
  });
  it("matchesSavedSearch is the list's own rule (for live counts)", () => {
    const q = searchToViewQuery("due today", EMPTY_PANEL);
    expect(TASKS.filter((t) => matchesSavedSearch(q, t, CTX)).map((t) => t.id)).toEqual(["a", "b"]);   // a chip "due today" doesn't hide done work
    const open = searchToViewQuery("open tasks due today", EMPTY_PANEL);
    expect(TASKS.filter((t) => matchesSavedSearch(open, t, CTX)).map((t) => t.id)).toEqual(["a"]);
    expect(TASKS.filter((t) => matchesSavedSearch(searchToViewQuery("docs mentioning x", EMPTY_PANEL), t, CTX))).toEqual([]);
    expect(TASKS.filter((t) => matchesSavedSearch(searchToViewQuery("later", EMPTY_PANEL), t, CTX)).map((t) => t.id)).toEqual(["e"]);
  });
  it("suggested names read like the search", () => {
    const r = resolveSearch("blocked in launch pricing", EMPTY_PANEL, CTX, TODAY);
    expect(suggestSearchName(r)).toBe("“pricing” · Blocked · In Q3 Product Launch");
    expect(suggestSearchName(resolveSearch("", EMPTY_PANEL, CTX, TODAY))).toBe("Search");
  });
});

describe("the payloads search_all gets (replayed by scratchpad/pgtest-u2 against the real SQL)", () => {
  const rpc = (input: string) => searchFiltersToRpc(resolveSearch(input, EMPTY_PANEL, CTX, TODAY).filters);
  it("each plain-English example becomes exactly these filters", () => {
    const launch = "p-launch", maya = "m-1", me = "m-self", theo = "m-2";
    expect(rpc("Maya's overdue tasks in Launch")).toEqual({ assignee_id: maya, due_to: "2026-10-08", exclude_done: true, project_id: launch, kinds: ["task"] });
    expect(rpc("docs mentioning pricing")).toEqual({ kinds: ["doc"] });
    expect(rpc("blocked this week")).toEqual({ statuses: ["blocked"], due_from: "2026-10-05", due_to: "2026-10-11", kinds: ["task"] });
    expect(rpc("assigned to me due friday")).toEqual({ assignee_id: me, due_from: "2026-10-09", due_to: "2026-10-09", kinds: ["task"] });
    expect(rpc("comments by Theo about the deck")).toEqual({ kinds: ["comment"], author_id: theo });
    expect(rpc("pricing")).toEqual({ kinds: ["task", "comment", "doc", "project", "person"] });
    expect(searchFiltersToRpc(resolveSearch("pricing", { ...EMPTY_PANEL, scope: "personal" }, CTX, TODAY).filters))
      .toEqual({ workspace_id: null, kinds: ["task", "comment", "doc", "project", "person"] });
    expect(searchFiltersToRpc(resolveSearch("", panelFromQuery({ assignee: maya, due: "overdue" }), CTX, TODAY).filters))
      .toEqual({ assignee_id: maya, due_to: "2026-10-08", exclude_done: true, kinds: ["task"] });
  });
});
