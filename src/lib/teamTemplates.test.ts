import { describe, it, expect, vi } from "vitest";
import {
  WORKSPACE_TEMPLATES, findWorkspaceTemplate, buildWorkspaceFromTemplate, applyWorkspacePlan, templateStats, appliedPlanMessage,
  type TemplateApplyDeps,
} from "./templates";
import { SPECTRUM, spectrumColor, projectSpectrum } from "./projectIdentity";
import type { AutomationRule, FormDef, Project, Section, Task, WorkspaceTemplate } from "../data/types";

const SPECTRUM_KEYS = new Set(SPECTRUM.map((s) => s.key));

describe("team templates: the content", () => {
  it("has the four set-ups, in gallery order, with unique ids", () => {
    expect(WORKSPACE_TEMPLATES.map((t) => t.name)).toEqual(["Marketing", "Operations", "Product launch", "Client services"]);
    expect(new Set(WORKSPACE_TEMPLATES.map((t) => t.id)).size).toBe(4);
    for (const t of WORKSPACE_TEMPLATES) expect(findWorkspaceTemplate(t.id)).toBe(t);
    expect(findWorkspaceTemplate("nope")).toBeUndefined();
  });

  it.each(WORKSPACE_TEMPLATES.map((t) => [t.name, t] as const))("%s: 2–3 projects, each with its own emoji and spectrum hue, sections and 6–12 starter tasks", (_n, tpl) => {
    expect(SPECTRUM_KEYS.has(tpl.hue)).toBe(true);
    expect(tpl.summary.length).toBeGreaterThan(20);
    expect(tpl.summary.length).toBeLessThanOrEqual(140);
    expect(tpl.projects.length).toBeGreaterThanOrEqual(2);
    expect(tpl.projects.length).toBeLessThanOrEqual(3);
    expect(new Set(tpl.projects.map((p) => p.key)).size).toBe(tpl.projects.length);
    expect(new Set(tpl.projects.map((p) => p.hue)).size).toBe(tpl.projects.length); // a calm mosaic, never two the same
    expect(new Set(tpl.projects.map((p) => p.emoji)).size).toBe(tpl.projects.length);
    for (const p of tpl.projects) {
      expect(SPECTRUM_KEYS.has(p.hue)).toBe(true);
      expect(p.emoji).toBeTruthy();
      expect(p.sections.length).toBeGreaterThanOrEqual(2);
      expect(p.tasks.length).toBeGreaterThanOrEqual(6);
      expect(p.tasks.length).toBeLessThanOrEqual(12);
      for (const task of p.tasks) {
        expect(p.sections, `${p.name}: ${task.title}`).toContain(task.section);
        expect(typeof task.dueInDays).toBe("number");
        expect(task.effortHours).toBeGreaterThan(0);
        expect(task.title).not.toMatch(/\s$|^\s/);
      }
    }
  });

  it("each template has one sample request form and one rule, and every section a rule names exists", () => {
    for (const tpl of WORKSPACE_TEMPLATES) {
      const s = templateStats(tpl);
      expect(s.forms, tpl.name).toBe(1);
      expect(s.rules, tpl.name).toBe(1);
      for (const p of tpl.projects) {
        for (const a of p.rule?.actions ?? []) if (a.type === "set_section") expect(p.sections).toContain(a.value);
        // a public form never asks for an assignee (it would list the team to strangers)
        expect(p.form?.fields ?? []).not.toContain("assignee");
      }
    }
  });

  it("speaks British English", () => {
    const text = JSON.stringify(WORKSPACE_TEMPLATES);
    for (const us of [/\bprioritiz/i, /\borganiz/i, /\bcolor\b/i, /\bcenter\b/i, /\banalyz/i, /\bcatalog\b/i]) expect(text).not.toMatch(us);
  });

  it("counts what a template (or some of its projects) sets up", () => {
    const m = findWorkspaceTemplate("marketing")!;
    expect(templateStats(m)).toEqual({ projects: 3, tasks: 21, forms: 1, rules: 1 });
    expect(templateStats(m, ["campaigns"])).toEqual({ projects: 1, tasks: 8, forms: 0, rules: 0 });
  });
});

describe("buildWorkspaceFromTemplate", () => {
  const tpl: WorkspaceTemplate = {
    id: "x", name: "X", summary: "A test template for the builder.", emoji: "🧪", hue: "jade",
    projects: [
      {
        key: "a", name: "Alpha", emoji: "🅰️", hue: "coral", description: "First", sections: ["One", " Two ", "One", ""],
        tasks: [
          { title: "Due today", section: "One", dueInDays: 0, effortHours: 1 },
          { title: "  Padded  ", section: "Two", dueInDays: 1, priority: "high", focusMin: 90, recurrence: "weekly", description: "notes" },
          { title: "Lands on Saturday", dueInDays: 3, effortHours: 0.3 },
          { title: "Lands on Sunday", section: "Nowhere", dueInDays: 4 },
          { title: "No date", focusMin: 2 },
          { title: "   " },
        ],
        form: { name: "Ask", fields: ["description"] },
        rule: { name: "Into one", trigger: "task_created", actions: [{ type: "set_section", value: "One" }] },
      },
      { key: "b", name: "Beta", emoji: "🅱️", hue: "sky", sections: ["S"], tasks: [{ title: "B1", section: "S", dueInDays: 7 }] },
    ],
  };

  it("makes colours, dates and defaults concrete for the day it's used", () => {
    const plan = buildWorkspaceFromTemplate(tpl, "2026-10-07"); // a Wednesday
    expect(plan).toMatchObject({ templateId: "x", name: "X" });
    const [a, b] = plan.projects;
    expect(a.color).toBe(spectrumColor("coral"));
    expect(projectSpectrum({ id: "p", color: a.color }).key).toBe("coral"); // reads back as its hue
    expect(b.color).toBe(spectrumColor("sky"));
    expect(a.sections).toEqual(["One", "Two"]);
    expect(a.description).toBe("First");
    expect(a.tasks.map((x) => x.title)).toEqual(["Due today", "Padded", "Lands on Saturday", "Lands on Sunday", "No date"]);
    const [today, padded, sat, sun, none] = a.tasks;
    expect(today).toEqual({ title: "Due today", description: "", priority: "medium", section: "One", dueDate: "2026-10-07", effortHours: 1, focusMin: 30, recurrence: "none" });
    expect(padded).toMatchObject({ section: "Two", dueDate: "2026-10-08", priority: "high", focusMin: 90, recurrence: "weekly", description: "notes" });
    expect(padded.effortHours).toBeUndefined();
    // weekends move to the Monday after
    expect(sat.dueDate).toBe("2026-10-12");
    expect(sat.effortHours).toBe(0.25);
    expect(sun.dueDate).toBe("2026-10-12");
    expect(sun.section).toBeUndefined(); // a section the project doesn't have
    expect(none.dueDate).toBeUndefined();
    expect(none.focusMin).toBe(5);
    expect(a.form).toEqual({ name: "Ask", fields: ["description"] });
    expect(a.rule?.actions).toEqual([{ type: "set_section", value: "One" }]);
    expect(b.tasks[0].dueDate).toBe("2026-10-14");
  });

  it("accepts a Date, and falls back to today for something unreadable", () => {
    const fromDate = buildWorkspaceFromTemplate(tpl, new Date(2026, 9, 7, 15, 30));
    expect(fromDate.projects[0].tasks[0].dueDate).toBe("2026-10-07");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 6, 9, 0)); // a Tuesday
    try { expect(buildWorkspaceFromTemplate(tpl, "garbage").projects[0].tasks[0].dueDate).toBe("2026-10-06"); }
    finally { vi.useRealTimers(); }
  });

  it("keeps only the projects asked for, in the template's order", () => {
    expect(buildWorkspaceFromTemplate(tpl, "2026-10-07", { projectKeys: ["b"] }).projects.map((p) => p.key)).toEqual(["b"]);
    expect(buildWorkspaceFromTemplate(tpl, "2026-10-07", { projectKeys: ["b", "a", "zzz"] }).projects.map((p) => p.key)).toEqual(["a", "b"]);
    expect(buildWorkspaceFromTemplate(tpl, "2026-10-07", { projectKeys: [] }).projects).toEqual([]);
  });

  it("is pure: the template is untouched and two builds are equal", () => {
    const before = JSON.stringify(tpl);
    const one = buildWorkspaceFromTemplate(tpl, "2026-10-07");
    one.projects[0].sections.push("mutated");
    one.projects[0].form!.fields.push("priority");
    one.projects[0].rule!.actions[0].value = "mutated";
    expect(JSON.stringify(tpl)).toBe(before);
    expect(buildWorkspaceFromTemplate(tpl, "2026-10-07")).toEqual(buildWorkspaceFromTemplate(tpl, "2026-10-07"));
  });

  it("every built-in builds cleanly", () => {
    for (const t of WORKSPACE_TEMPLATES) {
      const plan = buildWorkspaceFromTemplate(t, "2026-10-05");
      expect(plan.projects).toHaveLength(t.projects.length);
      for (const p of plan.projects) {
        for (const task of p.tasks) {
          expect(task.section).toBeTruthy();
          expect(task.dueDate! >= "2026-10-05").toBe(true);
          const wd = new Date(task.dueDate + "T12:00:00").getDay();
          expect(wd === 0 || wd === 6).toBe(false);
        }
      }
    }
  });
});

describe("applyWorkspacePlan", () => {
  function fakeDeps(fail: { project?: string; section?: string; tasks?: "all" | "partial"; form?: boolean; rule?: boolean } = {}) {
    const calls: string[] = [];
    let n = 0;
    const deps: Required<TemplateApplyDeps> = {
      createProject: vi.fn(async (input) => {
        calls.push("project:" + input.name);
        if (fail.project === input.name) throw new Error("no");
        return { id: "p" + ++n, ...input } as Project;
      }),
      createSection: vi.fn(async (input) => {
        calls.push("section:" + input.name);
        if (fail.section === input.name) throw new Error("no");
        return { id: "s-" + input.name, ...input } as Section;
      }),
      createTasks: vi.fn(async (tasks: Task[]) => {
        calls.push("tasks:" + tasks.length);
        if (fail.tasks === "all") throw new Error("offline?");
        if (fail.tasks === "partial") {
          const err = Object.assign(new Error("1 of n"), { saved: tasks.slice(1), failed: [{ task: tasks[0], message: "nope" }] });
          throw err;
        }
        return tasks;
      }),
      createForm: vi.fn(async (input) => {
        calls.push("form:" + input.name);
        if (fail.form) throw new Error("no");
        return { id: "f1", ...input } as FormDef;
      }),
      createRule: vi.fn(async (input) => {
        calls.push("rule:" + input.name);
        if (fail.rule) throw new Error("no");
        return { id: "r1", enabled: true, trigger: input.trigger ?? "task_created", ...input } as AutomationRule;
      }),
    };
    return { deps, calls };
  }
  const plan = () => buildWorkspaceFromTemplate(findWorkspaceTemplate("clients")!, "2026-10-05");

  it("creates projects, sections, tasks, the form and the rule, in that order", async () => {
    const { deps, calls } = fakeDeps();
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    expect(r.failed).toEqual([]);
    expect(r.projects.map((p) => p.name)).toEqual(["Client accounts", "Delivery", "Client requests"]);
    expect(r.sections).toHaveLength(3 + 4 + 4);
    expect(r.tasks).toHaveLength(8 + 7 + 6);
    expect(r.forms).toHaveLength(1);
    expect(r.rules).toHaveLength(1);
    // within each project: project → sections → tasks → form → rule
    const last = calls.slice(calls.indexOf("project:Client requests"));
    expect(last).toEqual(["project:Client requests", "section:New", "section:Doing", "section:Waiting on client", "section:Done", "tasks:6", "form:Client request", "rule:New requests land in New"]);
    // the project carries the workspace, colour and description
    expect(deps.createProject).toHaveBeenCalledWith(expect.objectContaining({ name: "Client accounts", workspaceId: "ws-1", color: spectrumColor("lagoon"), description: expect.any(String) }));
    expect(deps.createForm).toHaveBeenCalledWith(expect.objectContaining({ projectId: "p3", workspaceId: "ws-1", description: expect.stringContaining("Tell us") }));
  });

  it("starter tasks are to-do, assigned, sectioned, dated, estimated and off everyone's day", async () => {
    const { deps } = fakeDeps();
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    const kickoff = r.tasks.find((x) => x.title === "Hold the kickoff call")!;
    expect(kickoff).toMatchObject({
      status: "todo", priority: "high", assigneeId: "me", workspaceId: "ws-1", projectId: "p1",
      sectionId: "s-Onboarding", dueDate: "2026-10-08", effortHours: 1.5, focusMin: 60, dur: 60,
      planToday: false, scheduled: null, recurrence: "none",
    });
    expect(kickoff.description).toContain("**Goals**");
    expect(new Set(r.tasks.map((x) => x.id)).size).toBe(r.tasks.length);
    expect(r.tasks.every((x) => /^[0-9a-f-]{36}$/.test(x.id))).toBe(true); // real uuids: no id swap needed
  });

  it("resolves a rule's section by name to the created section's id", async () => {
    const { deps } = fakeDeps();
    await applyWorkspacePlan(plan(), { workspaceId: null, assigneeId: "me" }, deps);
    expect(deps.createRule).toHaveBeenCalledWith(expect.objectContaining({ trigger: "task_created", actions: [{ type: "set_section", value: "s-New" }], workspaceId: null }));
  });

  it("a project that fails takes its parts with it and the rest carry on", async () => {
    const { deps } = fakeDeps({ project: "Delivery" });
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    expect(r.failed).toEqual(["Delivery"]);
    expect(r.projects.map((p) => p.name)).toEqual(["Client accounts", "Client requests"]);
    expect(r.tasks).toHaveLength(8 + 6);
  });

  it("reports a failed section, keeps its tasks (unsectioned) and skips a rule that needed it", async () => {
    const { deps } = fakeDeps({ section: "New" });
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    expect(r.failed).toEqual(["Client requests › New", "New requests land in New"]);
    expect(deps.createRule).not.toHaveBeenCalled();
    expect(r.tasks.filter((x) => x.title === "Triage new requests")[0].sectionId).toBeUndefined();
  });

  it("reports the tasks a partial save left out, by title", async () => {
    const { deps } = fakeDeps({ tasks: "partial" });
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    expect(r.failed).toEqual(["Send the welcome pack and kickoff agenda", "Confirm the scope and acceptance criteria", "Triage new requests"]);
    expect(r.tasks).toHaveLength(21 - 3);
  });

  it("reports every task when a save fails outright, and a form or rule that fails", async () => {
    const { deps } = fakeDeps({ tasks: "all", form: true, rule: true });
    const r = await applyWorkspacePlan(buildWorkspaceFromTemplate(findWorkspaceTemplate("clients")!, "2026-10-05", { projectKeys: ["requests"] }), { workspaceId: "ws-1", assigneeId: "me" }, deps);
    expect(r.failed).toHaveLength(6 + 2);
    expect(r.failed).toContain("Client request");
    expect(r.failed).toContain("New requests land in New");
    expect(r.tasks).toEqual([]);
  });

  it("skips forms and rules when the host can't make them", async () => {
    const { deps } = fakeDeps();
    const { createForm: _f, createRule: _r, ...bare } = deps;
    const r = await applyWorkspacePlan(plan(), { workspaceId: "ws-1", assigneeId: "me" }, bare);
    expect(r.failed).toEqual([]);
    expect(r.forms).toEqual([]);
    expect(r.rules).toEqual([]);
  });

  it("says what happened, in one sentence", () => {
    const p = { name: "Marketing" };
    expect(appliedPlanMessage(p, { projects: [{} as Project, {} as Project], tasks: [{} as Task], failed: [] }))
      .toEqual({ tone: "success", text: "Marketing is ready: 2 projects and 1 starter task." });
    expect(appliedPlanMessage(p, { projects: [], tasks: [], failed: ["Campaigns"] }).tone).toBe("error");
    const partial = appliedPlanMessage(p, { projects: [{} as Project], tasks: [], failed: ["a", "b", "c", "d"] });
    expect(partial.tone).toBe("info");
    expect(partial.text).toContain("“a”, “b”, “c” and 1 more couldn't be added. You can add them by hand.");
  });
});
