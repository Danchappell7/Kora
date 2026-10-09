/* lib/templates — the task template library (0048, u9): the built-ins, applying
   (dates and roles, pinned to Friday 9 October 2026), the "/" query and fuzzy
   match, saving from a task, the body round-trip, and the data functions in
   demo mode (in memory). The real backend is in templates.remote.test.ts. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LIBRARY_BUILTINS, TEMPLATE_LIMITS, adoptLocalTemplates, cleanTemplateBody, createLibraryTemplate, deleteLibraryTemplate,
  listLibraryTemplates, matchTemplates, parseLibraryTemplate, parseTemplateBody, planTemplate, resetLibraryTemplates, roleAssignee,
  saveTemplate, templateBodyBytes, templateDayLabel, templateDayZero, templateFromTask, templateMeta, templatePlaceholders,
  templateProblem, templateQueryOf, templateRights, templateTasks, updateLibraryTemplate, resolveTemplateTags, sortLibrary,
  isLocalTemplateId, localLibraryTemplates,
} from "./templates";
import type { LibraryTemplate, Task } from "../data/types";

const FRI = new Date(2026, 9, 9);            // Friday 9 October 2026 (local)
const builtin = (slug: string) => LIBRARY_BUILTINS.find((t) => t.id === `builtin-lib-${slug}`)!;
const ctx = (over: Partial<Parameters<typeof planTemplate>[1]> = {}) => ({
  today: FRI, currentUserId: "u-me", projectId: "p-1", projectOwnerId: "u-owner", workspaceId: "ws-1", ...over,
});
const task = (o: Partial<Task> & { title: string }): Task => ({
  id: "t-" + o.title, description: "", status: "todo", priority: "medium", projectId: "p-1", assigneeId: "u-me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 50, ...o,
});
const tpl = (body: LibraryTemplate["body"], o: Partial<LibraryTemplate> = {}): LibraryTemplate => ({
  id: "x", workspaceId: null, userId: "u-me", name: "T", emoji: null, body, shared: false, createdAt: "", updatedAt: "", ...o,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  localStorage.clear();
  resetLibraryTemplates({ demoDelayMs: 0 });
});
afterEach(() => { vi.useRealTimers(); });

describe("the built-ins", () => {
  it("are the eight, in order, with ids the parser marks as built-in", () => {
    expect(LIBRARY_BUILTINS.map((t) => t.name)).toEqual([
      "Client onboarding", "Bug report", "Weekly report", "Hiring loop", "Content piece", "Event checklist", "Expense claim", "Contract review",
    ]);
    for (const t of LIBRARY_BUILTINS) {
      expect(t.id).toMatch(/^builtin-lib-/);
      expect(t.builtin).toBe(true);
      expect(parseLibraryTemplate({ ...t, workspace_id: null, user_id: "", created_at: "", updated_at: "" })?.builtin).toBe(true);
    }
  });
  it("round-trip through the database's parser unchanged and fit its limits", () => {
    for (const t of LIBRARY_BUILTINS) {
      const back = parseTemplateBody(JSON.parse(JSON.stringify(t.body)));
      expect(back).toEqual(t.body);
      expect(cleanTemplateBody(t.body)).toEqual(t.body);
      expect(templateBodyBytes(t.body)).toBeLessThan(TEMPLATE_LIMITS.bodyBytes);
      expect(t.body.subtasks!.length).toBeGreaterThanOrEqual(4);
      expect(t.body.checklist!.length).toBeGreaterThanOrEqual(3);
      expect(t.body.subtasks!.every((s) => (s.offsetDays ?? 0) <= Math.max(t.body.dueOffsetDays ?? 0, 30))).toBe(true);
      expect(templateProblem({ name: t.name, body: t.body })).toBeNull();
    }
  });
  it("are written in British English", () => {
    const words = JSON.stringify(LIBRARY_BUILTINS);
    expect(words).not.toMatch(/\b(organiz|color\b|center\b|favorite|analyz|prioritiz|labeled|canceled|catalog\b|license\b|check-in call)/i);
    expect(words).toMatch(/British English/);
  });
});

describe("planTemplate — applied on Friday 9 October 2026", () => {
  it("dates the task from its own offset and the sub-tasks from the same day 0, weekends to the Monday after", () => {
    const p = planTemplate(builtin("client-onboarding"), ctx());
    expect(p.task).toMatchObject({ title: "Onboard {client}", priority: "high", focusMin: 60, dur: 60, dueDate: "2026-10-23", projectId: "p-1", assigneeId: "u-me", status: "todo" });
    expect(p.subtasks.map((s) => [s.title, s.dueDate, s.assigneeId])).toEqual([
      ["Send the welcome email and kick-off agenda", "2026-10-12", "u-me"],   // day 1 is a Saturday
      ["Hold the kick-off call", "2026-10-12", "u-owner"],
      ["Set up their shared folder and project space", "2026-10-12", "u-me"],
      ["Collect logins, brand assets and contacts", "2026-10-14", ""],
      ["Agree the first milestones in writing", "2026-10-16", "u-owner"],
      ["Book the 30-day check-in", "2026-10-23", "u-me"],
    ]);
    expect(p.checklist).toEqual(builtin("client-onboarding").body.checklist);
    expect(p.subtasks.every((s) => s.projectId === "p-1" && s.workspaceId === "ws-1" && s.status === "todo")).toBe(true);
  });
  it("a due date chosen when applying moves the sub-tasks with it", () => {
    const p = planTemplate(builtin("client-onboarding"), ctx({ dueDate: "2026-10-30" }));
    expect(p.task.dueDate).toBe("2026-10-30");
    expect(p.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-19", "2026-10-19", "2026-10-19", "2026-10-21", "2026-10-23", "2026-10-30"]);
  });
  it("…never into the past: what should already have started is due today", () => {
    const p = planTemplate(builtin("client-onboarding"), ctx({ dueDate: "2026-10-13" }));
    expect(p.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-09", "2026-10-09", "2026-10-09", "2026-10-09", "2026-10-09", "2026-10-13"]);
  });
  it("no due date (null) keeps day 0 today; the template's own date is dropped", () => {
    const p = planTemplate(builtin("bug-report"), ctx({ dueDate: null }));
    expect(p.task.dueDate).toBeUndefined();
    expect(p.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-09", "2026-10-12", "2026-10-12", "2026-10-12", "2026-10-12"]);
  });
  it("a sub-task due on or before the task never moves past it: a Saturday event's day-of work is the Friday", () => {
    const body = { title: "Plan the party", dueOffsetDays: 8, subtasks: [{ title: "Set up the room", offsetDays: 8 }, { title: "Thank everyone", offsetDays: 9 }] };
    const p = planTemplate(tpl(body), ctx({ dueDate: "2026-10-17" }));   // Saturday, picked by hand: kept
    expect(p.task.dueDate).toBe("2026-10-17");
    expect(p.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-16", "2026-10-19"]);   // Friday before; Sunday → Monday after
  });
  it("the event checklist works back from the event (its after-party work lands after)", () => {
    const p = planTemplate(builtin("event-checklist"), ctx());
    expect(p.task.dueDate).toBe("2026-11-06");
    const byTitle = Object.fromEntries(p.subtasks.map((s) => [s.title, s.dueDate]));
    expect(byTitle["Confirm numbers and dietary needs"]).toBe("2026-11-02");
    expect(byTitle["Brief everyone helping on the day"]).toBe("2026-11-04");
    expect(byTitle["Send thank-yous and photos"]).toBe("2026-11-09");
  });
  it("roles: me / project owner (else me) / unassigned; Personal makes everything yours", () => {
    expect(roleAssignee("me", ctx())).toBe("u-me");
    expect(roleAssignee(undefined, ctx())).toBe("u-me");
    expect(roleAssignee("project_owner", ctx())).toBe("u-owner");
    expect(roleAssignee("project_owner", ctx({ projectOwnerId: null }))).toBe("u-me");
    expect(roleAssignee("unassigned", ctx())).toBe("");
    const personal = planTemplate(builtin("hiring-loop"), ctx({ workspaceId: null }));
    expect(new Set(personal.subtasks.map((s) => s.assigneeId))).toEqual(new Set(["u-me"]));
  });
  it("the task's assignee can be someone else; tags resolve by id or label and unknown ones go", () => {
    const tags = { "tag-1": { label: "Bug", color: "red" }, "tag-2": { label: "Writing", color: "blue" } };
    const p = planTemplate(builtin("bug-report"), ctx({ assigneeId: "u-sana", tags }));
    expect(p.task.assigneeId).toBe("u-sana");
    expect(p.task.tags).toEqual(["tag-1"]);
    expect(resolveTemplateTags(["tag-2", "bug", "Nope"], tags)).toEqual(["tag-2", "tag-1"]);
    expect(resolveTemplateTags(["a"], undefined)).toEqual(["a"]);
  });
  it("day 0: the template's own (weekend-moved) date keeps it today; another date moves it", () => {
    expect(templateDayZero({ dueOffsetDays: 1 }, FRI, "2026-10-12")).toEqual(FRI);       // Saturday → Monday: still today
    expect(templateDayZero({ dueOffsetDays: 1 }, FRI, "2026-10-20")).toEqual(new Date(2026, 9, 19));
    expect(templateDayZero({}, FRI, "2026-10-20")).toEqual(FRI);
  });
  it("crosses the October clock change without losing a day", () => {
    const p = planTemplate(tpl({ title: "x", subtasks: [{ title: "a", offsetDays: 16 }, { title: "b", offsetDays: 17 }] }), ctx({ today: new Date(2026, 9, 14) }));
    expect(p.subtasks.map((s) => s.dueDate)).toEqual(["2026-10-30", "2026-11-02"]);   // clocks go back on 25 October
  });
});

describe("templateTasks — the plan as real tasks", () => {
  it("hangs the sub-tasks off the task, keeps nobody as nobody, sorts them after it, and returns the checklist", () => {
    let n = 0;
    const build = (p: Partial<Task> & { title: string }): Task => task({ ...p, id: `new-${++n}`, assigneeId: p.assigneeId || "u-me", position: 1000, planToday: true });
    const plan = planTemplate(builtin("client-onboarding"), ctx());
    const out = templateTasks(plan, build);
    expect(out.task.id).toBe("new-1");
    expect(out.task.subtasks).toEqual([]);                  // the checklist goes on once the task is saved
    expect(out.checklist.map((c) => c.title)).toEqual(plan.checklist);
    expect(out.checklist.every((c) => !c.done)).toBe(true);
    expect(out.subtasks).toHaveLength(6);
    expect(out.subtasks.every((s) => s.parentId === "new-1" && s.projectId === "p-1" && !s.planToday && s.scheduled === null)).toBe(true);
    expect(out.subtasks.map((s) => s.assigneeId)).toEqual(["u-me", "u-owner", "u-me", "", "u-owner", "u-me"]);
    expect(out.subtasks.map((s) => s.position)).toEqual([1001, 1002, 1003, 1004, 1005, 1006]);
  });
});

describe("the \"/\" picker", () => {
  it("reads its query from text that starts with a slash", () => {
    expect(templateQueryOf("call Sana")).toBeNull();
    expect(templateQueryOf("a /b")).toBeNull();
    expect(templateQueryOf("/")).toBe("");
    expect(templateQueryOf("/onb")).toBe("onb");
    expect(templateQueryOf("/template")).toBe("");
    expect(templateQueryOf("/Template bug")).toBe("bug");
    expect(templateQueryOf("/templates hiring loop")).toBe("hiring loop");
    expect(templateQueryOf("/tem")).toBe("");
    expect(templateQueryOf("/te")).toBe("te");
    expect(templateQueryOf("/templ\nx")).toBeNull();
  });
  it("matches fuzzily, best first", () => {
    const names = (q: string) => matchTemplates(q, LIBRARY_BUILTINS).map((t) => t.name);
    expect(names("")).toEqual(LIBRARY_BUILTINS.map((t) => t.name));
    expect(names("bug")[0]).toBe("Bug report");
    expect(names("onb")[0]).toBe("Client onboarding");
    expect(names("co").slice(0, 3)).toEqual(["Content piece", "Contract review", "Client onboarding"]);   // a tie keeps list order
    expect(names("wkly rpt")).toEqual(["Weekly report"]);
    expect(names("hire")[0]).toBe("Hiring loop");                 // its title: "Hire a {role}"
    expect(names("report weekly")[0]).toBe("Weekly report");       // words in any order
    expect(names("zzz")).toEqual([]);
    expect(names("EXPENSE")).toEqual(["Expense claim"]);
    const cafe = tpl({ title: "Order coffee" }, { id: "c", name: "Café run" });
    expect(matchTemplates("cafe", [cafe])).toEqual([cafe]);
  });
  it("finds placeholders to select", () => {
    expect(templatePlaceholders("Onboard {client} for {quarter}")).toEqual([
      { start: 8, end: 16, name: "client" }, { start: 21, end: 30, name: "quarter" },
    ]);
    expect(templatePlaceholders("Weekly report")).toEqual([]);
  });
});

describe("templateFromTask — Save as template", () => {
  const parent = task({
    title: "Onboard Acme", description: "Kick-off notes", priority: "high", focusMin: 90, tags: ["tag-1", "tag-x"],
    dueDate: "2026-10-23", subtasks: [{ id: "c1", title: "Contract signed", done: true }, { id: "c2", title: "  ", done: false }],
  });
  const kids = [
    task({ id: "k2", title: "Kick-off call", parentId: parent.id, dueDate: "2026-10-12", assigneeId: "u-owner", position: 2 }),
    task({ id: "k1", title: "Welcome email", parentId: parent.id, dueDate: "2026-10-10", assigneeId: "u-me", position: 1 }),
    task({ id: "k3", title: "Logins", parentId: parent.id, assigneeId: "u-theo", position: 3 }),
    task({ id: "k4", title: "Gone", parentId: parent.id, archivedAt: "2026-10-01", position: 4 }),
    task({ id: "k5", title: "Someone else's", parentId: "t-other", position: 0 }),
  ];
  it("keeps its shape; dates become days after it's used; people become roles; tags by label", () => {
    const body = templateFromTask(parent, kids, { today: FRI, currentUserId: "u-me", projectOwnerId: "u-owner", tags: { "tag-1": { label: "Clients", color: "x" } } });
    expect(body).toEqual({
      title: "Onboard Acme", description: "Kick-off notes", priority: "high", estimate: 90, tags: ["Clients"], dueOffsetDays: 14,
      subtasks: [
        { title: "Welcome email", offsetDays: 1, assigneeRole: "me" },
        { title: "Kick-off call", offsetDays: 3, assigneeRole: "project_owner" },
        { title: "Logins", assigneeRole: "unassigned" },
      ],
      checklist: ["Contract signed"],
    });
  });
  it("counts from the earliest date when the work started before today (no negative days)", () => {
    const late = { ...parent, dueDate: "2026-10-02" };
    const body = templateFromTask(late, [{ ...kids[1], dueDate: "2026-09-28" }], { today: FRI });
    expect(body.dueOffsetDays).toBe(4);
    expect(body.subtasks).toEqual([{ title: "Welcome email", offsetDays: 0, assigneeRole: "me" }]);
  });
  it("counts from the start date when there is one; without a dictionary tags stay ids", () => {
    const body = templateFromTask({ ...parent, startDate: "2026-10-16" }, [], { today: FRI });
    expect(body.dueOffsetDays).toBe(7);
    expect(body.tags).toEqual(["tag-1", "tag-x"]);
  });
  it("fits the size limit: the description gives way first", () => {
    const big = { ...parent, description: "x".repeat(40_000) };
    const body = templateFromTask(big, kids, { today: FRI });
    expect(templateBodyBytes(body)).toBeLessThanOrEqual(TEMPLATE_LIMITS.bodyBytes);
    expect(body.subtasks).toHaveLength(3);
  });
  it("round-trips: save it, apply it, and the same plan comes back", () => {
    const body = templateFromTask(parent, kids, { today: FRI, currentUserId: "u-me", projectOwnerId: "u-owner" });
    const stored = parseTemplateBody(JSON.parse(JSON.stringify(body)))!;
    expect(stored).toEqual(body);
    const p = planTemplate({ body: stored }, ctx());
    expect(p.task.dueDate).toBe("2026-10-23");
    expect(p.subtasks.map((s) => [s.title, s.dueDate ?? null, s.assigneeId])).toEqual([
      ["Welcome email", "2026-10-12", "u-me"], ["Kick-off call", "2026-10-12", "u-owner"], ["Logins", null, ""],
    ]);
  });
});

describe("words", () => {
  it("meta lines, day and role labels", () => {
    expect(templateMeta(builtin("client-onboarding").body)).toBe("6 sub-tasks · 5 checklist items · 14 days");
    expect(templateMeta({ title: "x" })).toBe("A single task");
    expect(templateMeta({ title: "x", subtasks: [{ title: "a", offsetDays: 1 }] })).toBe("1 sub-task · 1 day");
    expect([0, 1, 4, undefined].map(templateDayLabel)).toEqual(["Today", "Tomorrow", "In 4 days", "No date"]);
  });
  it("problems before saving", () => {
    expect(templateProblem({ name: " ", body: { title: "x" } })).toBe("name");
    expect(templateProblem({ name: "x".repeat(81), body: { title: "x" } })).toBe("name");
    expect(templateProblem({ name: "n", emoji: "🎉".repeat(17), body: { title: "x" } })).toBe("emoji");
    expect(templateProblem({ name: "n", body: { title: " " } })).toBe("title");
    expect(templateProblem({ name: "n", body: { title: "x", description: "é".repeat(20_000) } })).toBe("too_big");
    expect(templateProblem({ name: "n", body: { title: "x" }, shared: true, workspaceId: null })).toBe("share_needs_workspace");
    expect(templateProblem({ name: "n", body: { title: "x" }, shared: true, workspaceId: "ws" })).toBeNull();
  });
  it("cleans a body: trims, drops empties, clamps days and estimates", () => {
    expect(cleanTemplateBody({
      title: "  Hi  ", description: "  \n", estimate: 2, dueOffsetDays: -3, tags: [" a ", "a", ""],
      subtasks: [{ title: " s ", offsetDays: 900 }, { title: "  " }], checklist: [" c ", ""],
    })).toEqual({ title: "Hi", estimate: 5, dueOffsetDays: 0, tags: ["a"], subtasks: [{ title: "s", offsetDays: 365 }], checklist: ["c"] });
  });
});

describe("who may do what", () => {
  const me = { userId: "u-me", workspaceId: "ws-1", canShare: true, canManageShared: false };
  it("built-ins: copy only; yours: everything; others' shared: owners and admins manage them", () => {
    expect(templateRights(builtin("bug-report"), me)).toEqual({ edit: false, delete: false, share: false, shareCopy: false });
    expect(templateRights(tpl({ title: "x" }, { workspaceId: "ws-1" }), me)).toEqual({ edit: true, delete: true, share: true, shareCopy: false });
    expect(templateRights(tpl({ title: "x" }, { workspaceId: null }), me)).toEqual({ edit: true, delete: true, share: false, shareCopy: true });
    const theirs = tpl({ title: "x" }, { userId: "u-sana", workspaceId: "ws-1", shared: true });
    expect(templateRights(theirs, me).edit).toBe(false);
    expect(templateRights(theirs, { ...me, canManageShared: true })).toEqual({ edit: true, delete: true, share: false, shareCopy: false });
    expect(templateRights(tpl({ title: "x" }, { workspaceId: "ws-1" }), { ...me, canShare: false }).share).toBe(false);   // a guest
    expect(templateRights(tpl({ title: "x" }, { workspaceId: null }), { ...me, workspaceId: null }).share).toBe(false);   // Personal
    expect(templateRights(tpl({ title: "x" }, { id: "tpl-1700000000-1" }), me)).toEqual({ edit: false, delete: true, share: false, shareCopy: false });
  });
  it("sorts yours, then shared, then the built-ins in their order", () => {
    const a = tpl({ title: "a" }, { id: "a", name: "A", updatedAt: "2026-10-01" });
    const b = tpl({ title: "b" }, { id: "b", name: "B", updatedAt: "2026-10-05" });
    const s = tpl({ title: "s" }, { id: "s", name: "S", userId: "u-sana", shared: true });
    expect(sortLibrary([LIBRARY_BUILTINS[1], s, a, LIBRARY_BUILTINS[0], b], "u-me").map((t) => t.id))
      .toEqual(["b", "a", "s", LIBRARY_BUILTINS[0].id, LIBRARY_BUILTINS[1].id]);
  });
});

describe("the library in demo mode (in memory)", () => {
  it("Foundrise: your templates, its shared ones (not Reco's), then the built-ins", async () => {
    const list = await listLibraryTemplates("ws-foundrise");
    const names = list.map((t) => t.name);
    expect(names.slice(0, 5)).toEqual(["Monthly invoice run", "Customer interview", "Release checklist", "Design review", "Incident review"]);
    expect(names).not.toContain("Experiment write-up");
    expect(names.slice(-8)).toEqual(LIBRARY_BUILTINS.map((t) => t.name));
    const personal = (await listLibraryTemplates(null)).map((t) => t.name);
    expect(personal).toContain("Monthly invoice run");
    expect(personal).not.toContain("Release checklist");
  });
  it("create, edit, share, delete — and sharing needs a workspace", async () => {
    const t = await createLibraryTemplate({ workspaceId: "ws-foundrise", name: "  Sprint review ", emoji: "🏁", body: { title: " Review sprint {n} ", checklist: ["Demo", " "] } });
    expect(t).toMatchObject({ name: "Sprint review", emoji: "🏁", shared: false, userId: "m-self", workspaceId: "ws-foundrise", body: { title: "Review sprint {n}", checklist: ["Demo"] } });
    expect((await listLibraryTemplates("ws-foundrise"))[0].id).toBe(t.id);
    const shared = await updateLibraryTemplate(t.id, { shared: true, name: "Sprint review (team)" });
    expect(shared).toMatchObject({ shared: true, name: "Sprint review (team)" });
    await expect(createLibraryTemplate({ workspaceId: null, name: "x", body: { title: "x" }, shared: true })).rejects.toThrow(/invalid/);
    const mine = await createLibraryTemplate({ workspaceId: null, name: "Mine", body: { title: "x" } });
    await expect(updateLibraryTemplate(mine.id, { shared: true })).rejects.toThrow(/invalid/);
    await expect(updateLibraryTemplate(LIBRARY_BUILTINS[0].id, { name: "x" })).rejects.toThrow(/not authorized/);
    await expect(createLibraryTemplate({ workspaceId: null, name: "", body: { title: "x" } })).rejects.toThrow(/invalid/);
    await deleteLibraryTemplate(t.id);
    expect((await listLibraryTemplates("ws-foundrise")).some((x) => x.id === t.id)).toBe(false);
    await expect(deleteLibraryTemplate(t.id)).rejects.toThrow(/not found/);
  });
  it("adopts this browser's old templates once (and never twice by name)", async () => {
    saveTemplate({ name: "Client kickoff", title: "Kickoff: ", priority: "high", tags: ["design"], focusMin: 45, recurrence: "none", description: "Agenda" });
    expect(localLibraryTemplates()).toHaveLength(1);
    expect(isLocalTemplateId(localLibraryTemplates()[0].id)).toBe(true);
    const first = await listLibraryTemplates(null);
    const kick = first.filter((t) => t.name === "Client kickoff");
    expect(kick).toHaveLength(1);
    expect(kick[0]).toMatchObject({ userId: "m-self", workspaceId: null, shared: false, body: { title: "Kickoff:", description: "Agenda", priority: "high", estimate: 45, tags: ["design"] } });
    expect(await adoptLocalTemplates()).toBe(1);               // the same run (cached)
    resetLibraryTemplates();
    expect(await adoptLocalTemplates()).toBe(1);               // a new session in demo mode: copied in again (memory only)…
    expect(await adoptLocalTemplates()).toBe(1);               // …once
    expect((await listLibraryTemplates(null)).filter((t) => t.name === "Client kickoff")).toHaveLength(1);
  });
});
