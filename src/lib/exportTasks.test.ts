import { describe, it, expect, vi, afterEach } from "vitest";
import { csvCell, toCsv, buildTasksCsv, exportTasksCsv } from "./exportTasks";
import { parseDelimited } from "./importTasks";
import type { CustomFieldDef, Task } from "../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

describe("csvCell", () => {
  it("always quotes and doubles embedded quotes", () => {
    expect(csvCell("plain")).toBe('"plain"');
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
  });
  it("neutralises formula injection with a leading apostrophe", () => {
    expect(csvCell('=HYPERLINK("https://evil.example","Open")')).toBe(`"'=HYPERLINK(""https://evil.example"",""Open"")"`);
    expect(csvCell("+1 from client")).toBe(`"'+1 from client"`);
    expect(csvCell("-Call supplier")).toBe(`"'-Call supplier"`);
    expect(csvCell("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
    expect(csvCell("\tcmd")).toBe(`"'\tcmd"`);
    expect(csvCell("\rcmd")).toBe(`"'\rcmd"`);
  });
  it("leaves plain signed numbers alone", () => {
    expect(csvCell("-5")).toBe('"-5"');
    expect(csvCell("+2.5")).toBe('"+2.5"');
    expect(csvCell(-3)).toBe('"-3"');
  });
});

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and uses CRLF rows", () => {
    const csv = toCsv([["A", "B"], ["£1", "café"]]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('"A","B"\r\n"£1","café"\r\n');
  });
});

describe("buildTasksCsv", () => {
  const fields: CustomFieldDef[] = [
    { id: "f-budget", projectId: "p-personal", name: "Budget", type: "currency", options: [] },
    { id: "f-ok", projectId: "p-personal", name: "Signed off", type: "checkbox", options: [] },
    { id: "f-prio", projectId: "p-personal", name: "Priority", type: "dropdown", options: ["A", "B"] },
    { id: "f-other", projectId: "p-elsewhere", name: "Unused", type: "text", options: [] },
  ];
  const parent = task({ id: "p1", title: "Parent", description: "Notes\nmore", status: "done", completedAt: "2026-09-28", startDate: "2026-09-01", dueDate: "2026-09-30", sectionId: "s1", tags: ["design"], custom: { "f-budget": -250, "f-ok": true, "f-prio": "A" } });
  const child = task({ id: "c1", title: "=1+1", parentId: "p1", completedAt: "2026-09-01" });
  const rows = parseDelimited(buildTasksCsv([parent, child], {
    sections: [{ id: "s1", name: "Build" }], customFields: fields,
    members: [{ id: "m-self", name: "Dan Chappell", email: "dan@example.com" }],
  }).slice(1), ",").filter((r) => r.some(Boolean));

  it("includes description, section, start, completed, parent and custom-field columns", () => {
    expect(rows[0]).toEqual(["Title", "Description", "Status", "Priority", "Assignee", "Assignee email", "Start", "Due", "Completed", "Project", "Section", "Tags", "Parent task", "Budget", "Signed off", "Priority (custom field)"]);
    expect(rows[1]).toEqual(["Parent", "Notes\nmore", "Done", "Medium", "Dan Chappell", "dan@example.com", "2026-09-01", "2026-09-30", "2026-09-28", "Personal", "Build", "Design", "", "-250", "Yes", "A"]);
  });
  it("guards formulas and only reports a completion date for done tasks", () => {
    expect(rows[2][0]).toBe("'=1+1");
    expect(rows[2][8]).toBe("");
    expect(rows[2][12]).toBe("Parent");
  });
});

describe("exportTasksCsv", () => {
  afterEach(() => vi.useRealTimers());
  it("downloads a slugged file name", () => {
    vi.useFakeTimers();
    const clicks: string[] = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicks.push(this.download); };
    try {
      exportTasksCsv([task({})], "Website / Q4 launch");
    } finally {
      HTMLAnchorElement.prototype.click = orig;
    }
    expect(clicks).toHaveLength(1);
    expect(clicks[0]).toMatch(/^kanbo-website-q4-launch-\d{4}-\d{2}-\d{2}\.csv$/);
    vi.runAllTimers();
  });
});
