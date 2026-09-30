// @vitest-environment node
// ai-assist input shaping: big workspaces are trimmed to the tasks that
// matter, never rejected, and every field stays bounded.
import { describe, expect, it } from "vitest";
import { cleanTasks, DESCRIPTION_MAX, MAX_TASKS, MAX_TASKS_COMMAND } from "./tasks.ts";

const task = (i: number, over: Record<string, unknown> = {}) => ({
  id: `t${i}`, title: `Task number ${i} with a realistic sort of title`, status: "todo", priority: "med",
  dueDate: null, completedAt: null, ...over,
});

describe("cleanTasks", () => {
  it("keeps a small list as sent (order included)", () => {
    const list = [task(2), task(1, { status: "done", completedAt: "2026-09-29T10:00:00Z" }), task(3)];
    expect(cleanTasks(list, "summary").map((t) => t.id)).toEqual(["t2", "t1", "t3"]);
  });

  it("trims a 1,500-task workspace to MAX_TASKS instead of refusing it", () => {
    const list = Array.from({ length: 1500 }, (_, i) => task(i));
    const out = cleanTasks(list, "ask");
    expect(out).toHaveLength(MAX_TASKS);
  });

  it("keeps open work due soonest, undated last", () => {
    const list = [
      ...Array.from({ length: 200 }, (_, i) => task(i)), // undated
      task(900, { dueDate: "2026-10-03" }),
      task(901, { dueDate: "2026-09-01" }),
    ];
    const out = cleanTasks(list, "prioritize");
    expect(out.slice(0, 2).map((t) => t.id)).toEqual(["t901", "t900"]);
    expect(out.every((t) => t.status !== "done")).toBe(true);
  });

  it("saves room for recently completed work in a summary", () => {
    const open = Array.from({ length: 300 }, (_, i) => task(i, { dueDate: "2026-10-10" }));
    const done = Array.from({ length: 100 }, (_, i) =>
      task(1000 + i, { status: "done", completedAt: new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString() }));
    const out = cleanTasks([...done, ...open], "summary");
    expect(out).toHaveLength(MAX_TASKS);
    const kept = out.filter((t) => t.status === "done");
    expect(kept).toHaveLength(40);
    expect(kept[0].id).toBe("t1099"); // most recently completed first
    // prioritize doesn't spend places on finished work
    expect(cleanTasks([...done, ...open], "prioritize").some((t) => t.status === "done")).toBe(false);
  });

  it("fills spare places with completed work when little is open", () => {
    const open = Array.from({ length: 10 }, (_, i) => task(i));
    const done = Array.from({ length: 200 }, (_, i) => task(500 + i, { status: "done", completedAt: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}` }));
    const out = cleanTasks([...open, ...done], "summary");
    expect(out).toHaveLength(MAX_TASKS);
    expect(out.filter((t) => t.status !== "done")).toHaveLength(10);
  });

  it("bounds every field and ignores junk", () => {
    const [t] = cleanTasks([{ id: "x".repeat(500), title: "y".repeat(5000), status: 3, priority: null, tags: Array(50).fill("z".repeat(99)), focusMin: 99999 }]);
    expect(t.id).toHaveLength(64);
    expect(t.title).toHaveLength(300);
    expect(t.status).toBe("3");
    expect(t.priority).toBe("");
    expect(t.tags).toHaveLength(10);
    expect(t.tags![0]).toHaveLength(40);
    expect(t.focusMin).toBe(1440);
    expect(cleanTasks("nope")).toEqual([]);
  });

  it("keeps who a task is for and who asked for it (the dropped-assignee fix)", () => {
    const [t] = cleanTasks([{
      ...task(1), assignee: "Maya Chen", collaborators: ["Theo Park", "Sana Okafor"], createdBy: "Daniel Okai",
      startDate: "2026-09-28", dueDate: "2026-10-02", dueTime: "15:00", description: "Final pass on the narrative before the board sees it.",
      projectName: "Q3 Product Launch", project: "Q3 Product Launch",
    }]);
    expect(t).toMatchObject({
      assignee: "Maya Chen", collaborators: ["Theo Park", "Sana Okafor"], createdBy: "Daniel Okai",
      startDate: "2026-09-28", dueDate: "2026-10-02", dueTime: "15:00", projectName: "Q3 Product Launch",
      description: "Final pass on the narrative before the board sees it.",
    });
    // an unassigned task says so, rather than looking like the field was lost
    expect(cleanTasks([{ ...task(2), assignee: null }])[0].assignee).toBeNull();
  });

  it("bounds the new fields too", () => {
    const [t] = cleanTasks([{
      ...task(1), assignee: "a".repeat(500), createdBy: "c".repeat(500), collaborators: Array(40).fill("n".repeat(200)),
      description: "d".repeat(5000), dueTime: "15:00:00.000+01:00",
    }]);
    expect(t.assignee).toHaveLength(80);
    expect(t.createdBy).toHaveLength(80);
    expect(t.collaborators).toHaveLength(10);
    expect(t.collaborators![0]).toHaveLength(80);
    expect(t.description).toHaveLength(DESCRIPTION_MAX);
    expect(t.dueTime).toHaveLength(8);
    // an empty description isn't sent at all
    expect("description" in cleanTasks([{ ...task(1), description: "" }])[0]).toBe(false);
  });

  it("command mode keeps the app's own relevance order, up to MAX_TASKS_COMMAND", () => {
    const list = Array.from({ length: 400 }, (_, i) => task(i, { dueDate: i % 2 ? "2026-10-01" : null, status: i % 3 ? "todo" : "done" }));
    const out = cleanTasks(list, "command");
    expect(out).toHaveLength(MAX_TASKS_COMMAND);
    expect(out.map((t) => t.id)).toEqual(list.slice(0, MAX_TASKS_COMMAND).map((t) => t.id));
  });
});
