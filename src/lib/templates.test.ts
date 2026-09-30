import { describe, it, expect, beforeEach } from "vitest";
import {
  BUILTIN_TASK_TEMPLATES, BUILTIN_PROJECT_TEMPLATES, MAX_USER_TEMPLATES,
  getTemplates, getUserTemplates, saveTemplate, deleteTemplate,
  getProjectTemplates, saveProjectTemplate, projectTemplateTasks,
  projectBlueprint, findProjectTemplate, getUserProjectTemplates, MAX_BLUEPRINT_TASKS,
  storeProjectTemplate, MAX_BLUEPRINT_NOTES, MAX_BLUEPRINT_CHARS,
} from "./templates";
import { vi } from "vitest";
import type { Task } from "../data/types";

const KEY = "kanbo-templates";
const PKEY = "kanbo-project-templates";
const base = { title: "T", priority: "medium" as const, tags: [], focusMin: 30, recurrence: "none" as const, description: "" };
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

beforeEach(() => localStorage.clear());

describe("task templates", () => {
  it("never writes the built-ins to storage, however many times you save", () => {
    for (let i = 0; i < 6; i++) saveTemplate({ ...base, name: `Mine ${i}` });
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.some((t: { id: string }) => t.id.startsWith("builtin-"))).toBe(false);
    const all = getTemplates();
    expect(new Set(ids(all)).size).toBe(all.length); // unique ids → unique React keys
    expect(all.filter((t) => t.id === "builtin-bug")).toHaveLength(1);
    expect(getUserTemplates().map((t) => t.name)).toEqual(["Mine 5", "Mine 4", "Mine 3", "Mine 2", "Mine 1", "Mine 0"]);
  });

  it("keeps user templates instead of evicting them to make room for built-ins", () => {
    for (let i = 0; i < 30; i++) saveTemplate({ ...base, name: `Mine ${i}` });
    expect(getUserTemplates()).toHaveLength(30);
    for (let i = 30; i < MAX_USER_TEMPLATES + 5; i++) saveTemplate({ ...base, name: `Mine ${i}` });
    expect(getUserTemplates()).toHaveLength(MAX_USER_TEMPLATES);
  });

  it("heals storage polluted by older builds (built-ins + duplicate ids)", () => {
    const mine = { ...base, id: "tpl-1", name: "Client onboarding" };
    localStorage.setItem(KEY, JSON.stringify([...BUILTIN_TASK_TEMPLATES, mine, ...BUILTIN_TASK_TEMPLATES, mine, null, { id: 3 }]));
    expect(ids(getTemplates())).toEqual([...ids(BUILTIN_TASK_TEMPLATES), "tpl-1"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual([mine]);
  });

  it("sanitises malformed rows so the picker can't crash", () => {
    localStorage.setItem(KEY, JSON.stringify([{ id: "tpl-x", name: "Odd", tags: "nope", priority: "extreme", recurrence: "hourly", focusMin: "lots" }]));
    const [t] = getUserTemplates();
    expect(t).toEqual({ id: "tpl-x", name: "Odd", title: "Odd", priority: "medium", tags: [], focusMin: 30, recurrence: "none", description: "" });
  });

  it("survives corrupt JSON", () => {
    localStorage.setItem(KEY, "{not json");
    expect(ids(getTemplates())).toEqual(ids(BUILTIN_TASK_TEMPLATES));
  });

  it("never overwrites a template saved under the same name — the new one gets a suffix", () => {
    const a = saveTemplate({ ...base, name: "Weekly report", priority: "high", tags: ["t-finance"], description: "Finance checklist" });
    saveTemplate({ ...base, name: "Other" });
    const b = saveTemplate({ ...base, name: "weekly report ", priority: "low" });
    const c = saveTemplate({ ...base, name: "Weekly report" });
    expect(new Set([a.id, b.id, c.id]).size).toBe(3);
    expect(getUserTemplates().map((t) => [t.name, t.priority])).toEqual([
      ["Weekly report (3)", "medium"], ["weekly report (2)", "low"], ["Other", "medium"], ["Weekly report", "high"],
    ]);
    // the first one is untouched
    expect(getUserTemplates().find((t) => t.id === a.id)).toMatchObject({ tags: ["t-finance"], description: "Finance checklist" });
    // a built-in's name isn't "taken" — they're listed in their own group
    expect(saveTemplate({ ...base, name: "Bug report" }).name).toBe("Bug report");
  });

  it("deletes only the user's template and leaves built-ins alone", () => {
    const a = saveTemplate({ ...base, name: "A" });
    saveTemplate({ ...base, name: "B" });
    deleteTemplate(a.id);
    deleteTemplate("builtin-bug");
    expect(getUserTemplates().map((t) => t.name)).toEqual(["B"]);
    expect(getTemplates().some((t) => t.id === "builtin-bug")).toBe(true);
    expect(JSON.parse(localStorage.getItem(KEY)!).some((t: { id: string }) => t.id.startsWith("builtin-"))).toBe(false);
  });
});

describe("project templates", () => {
  it("persists only the user's own project templates", () => {
    for (let i = 0; i < 4; i++) saveProjectTemplate({ name: `P${i}`, emoji: "📁", color: "#fff" });
    const all = getProjectTemplates();
    expect(new Set(ids(all)).size).toBe(all.length);
    expect(all.slice(0, BUILTIN_PROJECT_TEMPLATES.length)).toEqual(BUILTIN_PROJECT_TEMPLATES);
    expect(JSON.parse(localStorage.getItem(PKEY)!)).toHaveLength(4);
  });

  it("keeps both project templates saved under the same name", () => {
    saveProjectTemplate({ name: "Client", emoji: "🤝", color: "#000" });
    saveProjectTemplate({ name: "Client", emoji: "📁", color: "#fff" });
    expect(getProjectTemplates().slice(BUILTIN_PROJECT_TEMPLATES.length).map((t) => [t.name, t.emoji])).toEqual([["Client (2)", "📁"], ["Client", "🤝"]]);
  });

  it("heals polluted project-template storage", () => {
    const mine = { id: "ptpl-1", name: "Client", emoji: "🤝", color: "#000" };
    localStorage.setItem(PKEY, JSON.stringify([...BUILTIN_PROJECT_TEMPLATES, mine, mine]));
    expect(ids(getProjectTemplates())).toEqual([...ids(BUILTIN_PROJECT_TEMPLATES), "ptpl-1"]);
    expect(JSON.parse(localStorage.getItem(PKEY)!)).toEqual([mine]);
  });
});

describe("project template blueprints", () => {
  it("every built-in has sections and starter tasks that point at real sections", () => {
    for (const t of BUILTIN_PROJECT_TEMPLATES) {
      expect(t.sections?.length, t.name).toBeGreaterThan(0);
      expect(t.tasks?.length, t.name).toBeGreaterThan(0);
      for (const bt of t.tasks!) if (bt.section) expect(t.sections, `${t.name}: ${bt.title}`).toContain(bt.section);
    }
  });

  it("builds persist-ready tasks with relative due dates and mapped sections", () => {
    const launch = BUILTIN_PROJECT_TEMPLATES.find((t) => t.id === "builtin-launch")!;
    const tasks = projectTemplateTasks(launch, {
      projectId: "p-1", workspaceId: "ws-1", assigneeId: "u-1",
      sectionIds: { Plan: "s-plan", Build: "s-build" },
      today: new Date(2026, 9, 5, 15, 30), // 5 Oct 2026, afternoon — local date math
    });
    expect(tasks).toHaveLength(launch.tasks!.length);
    expect(new Set(tasks.map((t) => t.id)).size).toBe(tasks.length);
    const first = tasks[0];
    expect(first).toMatchObject({ projectId: "p-1", workspaceId: "ws-1", assigneeId: "u-1", status: "todo", sectionId: "s-plan", dueDate: "2026-10-08", planToday: false, tags: [] });
    expect(first.id.startsWith("t-new-")).toBe(true);
    // a section that wasn't created is simply left unassigned
    expect(tasks.find((t) => t.title.startsWith("Publish"))!.sectionId).toBeUndefined();
    // positions keep the template's order
    expect(tasks.map((t) => t.position)).toEqual([...tasks.map((t) => t.position)].sort((a, b) => a! - b!));
  });

  it("returns no tasks for a user-saved project template", () => {
    const tpl = saveProjectTemplate({ name: "Mine", emoji: "📁", color: "#fff" });
    expect(projectTemplateTasks(tpl, { projectId: "p", workspaceId: null, assigneeId: "u" })).toEqual([]);
  });
});

describe("saving a project as a template", () => {
  const t = (id: string, o: Partial<Task> = {}): Task => ({
    id, title: `Task ${id}`, description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "u",
    tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
  });

  it("keeps the project's top-level work, in order, without people, dates or progress", () => {
    const bp = projectBlueprint([
      t("b", { position: 2, title: "Second", priority: "high", focusMin: 90, description: "Notes", dueDate: "2026-10-01", status: "done" }),
      t("a", { position: 1, title: "First", recurrence: "weekly" }),
      t("s", { parentId: "a", title: "A sub-task" }),
      t("x", { archivedAt: "2026-01-01", title: "Archived" }),
    ]);
    expect(bp).toEqual([
      { title: "First", recurrence: "weekly" },
      { title: "Second", priority: "high", focusMin: 90, description: "Notes" },
    ]);
  });

  it("stores the tasks with the template, so a new project can start from them", () => {
    const tpl = saveProjectTemplate({ name: "Client onboarding", emoji: "🤝", color: "#000", tasks: [{ title: "Kick-off call", priority: "high" }] });
    expect(findProjectTemplate(tpl.id)?.tasks).toEqual([{ title: "Kick-off call", priority: "high" }]);
    expect(findProjectTemplate("builtin-launch")?.name).toBe("Product launch");
    const tasks = projectTemplateTasks(findProjectTemplate(tpl.id)!, { projectId: "p-2", workspaceId: null, assigneeId: "u-1" });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Kick-off call", priority: "high", projectId: "p-2", status: "todo" });
  });

  it("keeps a template small: notes are trimmed, and dropped once the template's text budget is spent", () => {
    const long = "n".repeat(MAX_BLUEPRINT_NOTES + 500);
    const bp = projectBlueprint(Array.from({ length: 40 }, (_, i) => t(`k${i}`, { position: i, title: `Step ${i}`, description: long })));
    expect(bp).toHaveLength(40);                                        // every title is kept
    expect(bp[0].description).toHaveLength(MAX_BLUEPRINT_NOTES);
    expect(bp.some((x) => !x.description)).toBe(true);                  // later notes didn't fit
    expect(JSON.stringify(bp).length).toBeLessThan(MAX_BLUEPRINT_CHARS + 40 * 60);
  });

  it("cleans a template's tasks on the way in, not only on the way out", () => {
    storeProjectTemplate({ name: "Raw", emoji: "📁", color: "#000", tasks: [{ title: "  Tidy me  ", priority: "extreme" as never }, { title: " " }] });
    const stored = JSON.parse(localStorage.getItem(PKEY)!)[0];
    expect(stored.tasks).toEqual([{ title: "Tidy me" }]);
  });

  it("says when this browser won't store the template (private mode, or storage full)", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    try {
      expect(storeProjectTemplate({ name: "Big", emoji: "📁", color: "#000" })).toBeNull();
      expect(saveProjectTemplate({ name: "Big", emoji: "📁", color: "#000" }).name).toBe("Big"); // the old call still answers
    } finally { setItem.mockRestore(); }
    expect(getUserProjectTemplates()).toEqual([]);
  });

  it("sanitises stored template tasks", () => {
    localStorage.setItem(PKEY, JSON.stringify([{ id: "ptpl-9", name: "Odd", emoji: "📁", color: "#fff", tasks: [
      { title: "  Fine  ", priority: "extreme", focusMin: "lots", recurrence: "hourly", dueInDays: -3 }, { title: "" }, null, "nope",
      ...Array.from({ length: MAX_BLUEPRINT_TASKS + 5 }, (_, i) => ({ title: `T${i}` })),
    ] }]));
    const [tpl] = getUserProjectTemplates();
    expect(tpl.tasks![0]).toEqual({ title: "Fine", dueInDays: 0 });
    expect(tpl.tasks).toHaveLength(MAX_BLUEPRINT_TASKS);
  });
});
