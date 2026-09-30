// @vitest-environment node
// ai-assist input shaping: big workspaces are trimmed to the tasks that
// matter, never rejected, and every field stays bounded.
import { describe, expect, it } from "vitest";
import { cleanTasks, MAX_TASKS } from "./tasks.ts";

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
});
