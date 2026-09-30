import { describe, it, expect } from "vitest";
import type { Task } from "../data/types";
import type { AskAction, AskContext } from "./askTypes";
import { validateActions, diffRows, headsUps, inversePatches, fmtDay, changeCount, MAX_ASK_CHANGES, CAP_REASON, GUEST_REASON } from "./askActions";

const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "u-me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...extra,
});

const ctx: AskContext = {
  today: "2026-09-30",
  me: "u-me",
  members: [{ id: "u-me", name: "Daniel Okai" }, { id: "u-maya", name: "Maya Lin" }, { id: "u-sana", name: "Sana Rao" }],
  projects: [{ id: "p-launch", name: "Q3 Product Launch" }, { id: "p-brand", name: "Brand Refresh" }],
};

const tasks: Task[] = [
  task("t1", "Approve token naming", { dueDate: "2026-09-30" }),
  task("t2", "Ship onboarding redesign", { assigneeId: "u-maya", status: "blocked", dueDate: "2026-10-01", dependencies: ["t1"] }),
  task("t3", "Refresh brand colour palette", { assigneeId: "u-sana", status: "done", dueDate: "2026-09-25", projectId: "p-brand" }),
  task("t4", "Draft investor update", { dueDate: "2026-10-02" }),
  task("t5", "Launch day", { dueDate: "2026-10-05", isMilestone: true, dependencies: ["t4"] }),
];
const byId = new Map(tasks.map((t) => [t.id, t]));
const upd = (id: string, patch: Record<string, unknown>) => ({ op: "update", id, patch });

describe("validateActions", () => {
  it("accepts whitelisted fields with valid values", () => {
    const { valid, rejected } = validateActions([
      upd("t1", { dueDate: "2026-10-05", dueTime: "9:30", status: "progress", priority: "urgent", assigneeId: "u-sana", projectId: "p-brand", planToday: true, title: "  Approve token names  " }),
    ], tasks, ctx, true);
    expect(rejected).toEqual([]);
    expect(valid).toEqual([upd("t1", { dueDate: "2026-10-05", dueTime: "09:30", status: "progress", priority: "urgent", assigneeId: "u-sana", projectId: "p-brand", planToday: true, title: "Approve token names" })]);
  });

  it("rejects fields outside the whitelist", () => {
    const { valid, rejected } = validateActions([upd("t1", { description: "hi" }), upd("t1", { workspaceId: "ws-x" })], tasks, ctx, true);
    expect(valid).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual(["Kanbo can't change “description”", "Kanbo can't change “workspaceId”"]);
  });

  it("only touches tasks that were sent", () => {
    const { valid, rejected } = validateActions([upd("t-unknown", { status: "done" }), { op: "update", id: 7, patch: { status: "done" } }], tasks, ctx, true);
    expect(valid).toEqual([]);
    expect(rejected).toHaveLength(2);
    expect(rejected[0].reason).toMatch(/only change the tasks it was asked about/);
  });

  it("checks people and projects against the workspace (and allows unassigning)", () => {
    const { valid, rejected } = validateActions([
      upd("t1", { assigneeId: "u-stranger" }),
      upd("t4", { projectId: "p-elsewhere" }),
      upd("t4", { assigneeId: "" }),
    ], tasks, ctx, true);
    expect(rejected.map((r) => r.reason)).toEqual(["That person isn't in this workspace", "That project isn't in this workspace"]);
    expect(valid).toEqual([upd("t4", { assigneeId: "" })]);
  });

  it("checks enums, dates, times, titles and booleans", () => {
    const bad = [
      upd("t1", { status: "finished" }),
      upd("t1", { priority: "critical" }),
      upd("t1", { dueDate: "5 Oct" }),
      upd("t1", { dueDate: "2026-02-30" }),
      upd("t1", { dueTime: "25:00" }),
      upd("t1", { dueTime: "3pm" }),
      upd("t1", { title: "   " }),
      upd("t1", { title: "x".repeat(201) }),
      upd("t1", { planToday: "yes" }),
    ];
    const { valid, rejected } = validateActions(bad, tasks, ctx, true);
    expect(valid).toEqual([]);
    expect(rejected).toHaveLength(bad.length);
  });

  it("never deletes, and turns away unknown ops and junk", () => {
    const { valid, rejected } = validateActions([{ op: "delete", id: "t1" }, { op: "archive", id: "t1" }, null, "move it", { op: "update", id: "t1" }], tasks, ctx, true);
    expect(valid).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([
      "Kanbo never deletes tasks",
      "Kanbo can only change, create or open tasks",
      "Kanbo didn't understand that change",
      "Kanbo didn't understand that change",
      "Kanbo didn't say what to change",
    ]);
  });

  it("merges several updates to one task and drops fields that wouldn't change", () => {
    const { valid, rejected } = validateActions([
      upd("t1", { dueDate: "2026-10-01", priority: "medium" }),
      upd("t4", { status: "progress" }),
      upd("t1", { dueDate: "2026-10-05", status: "progress" }),
      upd("t4", { status: "todo" }),
    ], tasks, ctx, true);
    expect(valid).toEqual([upd("t1", { dueDate: "2026-10-05", status: "progress" })]);
    expect(rejected.map((r) => r.reason)).toEqual(["Nothing would change"]);
  });

  it("checks creates and opens", () => {
    const { valid, rejected } = validateActions([
      { op: "create", task: { title: "Book the venue", dueDate: "2026-10-09", assigneeId: "u-maya" } },
      { op: "create", task: { title: "" } },
      { op: "create", task: { title: "Sneaky", workspaceId: "ws-other" } },
      { op: "open", route: { view: "plan" } },
      { op: "open", route: { view: "plan" } },
      { op: "open", taskId: "t4" },
      { op: "open", taskId: "t-nope" },
      { op: "open", route: { view: "admin" } },
      { op: "open", route: { view: "project", projectId: "p-elsewhere" } },
    ], tasks, ctx, true);
    expect(valid).toEqual([
      { op: "create", task: { title: "Book the venue", dueDate: "2026-10-09", assigneeId: "u-maya" } },
      { op: "open", route: { view: "plan" } },
      { op: "open", taskId: "t4" },
    ]);
    expect(rejected).toHaveLength(5);
  });

  it(`caps a question at ${MAX_ASK_CHANGES} changes`, () => {
    const many = Array.from({ length: 30 }, (_, i) => task(`m${i}`, `Task ${i}`));
    const { valid, rejected } = validateActions(many.map((t) => upd(t.id, { priority: "high" })), many, ctx, true);
    expect(valid).toHaveLength(MAX_ASK_CHANGES);
    expect(changeCount(valid)).toBe(25);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((r) => r.reason === CAP_REASON)).toBe(true);
    expect(CAP_REASON).toBe("Kanbo can change up to 25 tasks at once");
  });

  it("rejects everything when the person can't act (guests)", () => {
    const { valid, rejected } = validateActions([upd("t1", { status: "done" }), { op: "open", route: { view: "plan" } }], tasks, ctx, false);
    expect(valid).toEqual([]);
    expect(rejected.map((r) => r.reason)).toEqual([GUEST_REASON, GUEST_REASON]);
  });

  it("copes with a non-array", () => {
    expect(validateActions(undefined, tasks, ctx, true)).toEqual({ valid: [], rejected: [] });
  });
});

describe("diffRows", () => {
  it("reads old → new per field, dates in en-GB", () => {
    const rows = diffRows([upd("t1", { dueDate: "2026-10-05", assigneeId: "u-sana", planToday: true }) as AskAction], byId, ctx);
    expect(rows).toEqual([{
      index: 0, op: "update", taskId: "t1", title: "Approve token naming", status: "todo",
      changes: [
        { field: "dueDate", label: "Due", from: "Wed 30 Sep", to: "Mon 5 Oct", mono: true },
        { field: "assigneeId", label: "Assignee", from: "Daniel Okai", to: "Sana Rao", mono: false },
        { field: "planToday", label: "Today", from: "Off Today", to: "On Today", mono: false },
      ],
    }]);
  });

  it("shows empty values and new tasks plainly", () => {
    const rows = diffRows([
      upd("t4", { dueTime: "15:00", status: "progress" }) as AskAction,
      { op: "create", task: { title: "Book the venue", dueDate: "2027-01-04" } },
      { op: "open", route: { view: "plan" } },
    ], Object.fromEntries(tasks.map((t) => [t.id, t])), ctx);
    expect(rows[0].changes.map((c) => [c.label, c.from, c.to])).toEqual([["Status", "To do", "In progress"], ["Time", "No time", "15:00"]]);
    expect(rows[1]).toMatchObject({ index: 1, op: "create", title: "Book the venue", status: "todo" });
    expect(rows[1].changes).toEqual([{ field: "dueDate", label: "Due", from: null, to: "Mon 4 Jan 2027", mono: true }]);
    expect(rows).toHaveLength(2);
  });
});

describe("headsUps", () => {
  it("warns when a blocker moves past the task waiting on it", () => {
    const valid = [upd("t1", { dueDate: "2026-10-05" })] as AskAction[];
    const [h] = headsUps(valid, tasks, "u-me", ctx.members);
    expect(h).toMatchObject({ kind: "blocker", lead: "Approve token naming", indices: [0], keep: "Keep it" });
    expect(h.text).toBe("unblocks Maya's “Ship onboarding redesign”, due Thu 1 Oct — moving it later delays that.");
  });

  it("stays quiet when the dependant moves too", () => {
    const valid = [upd("t1", { dueDate: "2026-10-05" }), upd("t2", { dueDate: "2026-10-06" })] as AskAction[];
    expect(headsUps(valid, tasks, "u-me", ctx.members).filter((h) => h.kind === "blocker")).toEqual([]);
  });

  it("warns about someone else's task, grouping several", () => {
    const one = headsUps([upd("t2", { priority: "high" })] as AskAction[], tasks, "u-me", ctx.members);
    expect(one).toEqual([expect.objectContaining({ kind: "others", lead: "Ship onboarding redesign", text: "is Maya's task.", indices: [0], keep: "Leave it" })]);
    const two = headsUps([upd("t2", { priority: "high" }), upd("t1", { priority: "high" }), upd("t3", { priority: "high" })] as AskAction[], tasks, "u-me", ctx.members);
    expect(two.find((h) => h.kind === "others")).toMatchObject({ lead: "2 of these", text: "belong to Maya and Sana.", indices: [0, 2], keep: "Leave theirs" });
  });

  it("says it once when someone else's task also blocks work", () => {
    const hs = headsUps([upd("t2", { dueDate: "2026-10-08" })] as AskAction[], [...tasks, task("t9", "Launch comms", { assigneeId: "u-sana", dueDate: "2026-10-03", dependencies: ["t2"] })], "u-me", ctx.members);
    expect(hs).toEqual([expect.objectContaining({
      kind: "blocker", lead: "Ship onboarding redesign", indices: [0],
      text: "is Maya's task, and unblocks Sana's “Launch comms”, due Sat 3 Oct — moving it later delays that.",
    })]);
  });

  it("warns about reopening a done task", () => {
    const hs = headsUps([upd("t3", { status: "progress" })] as AskAction[], tasks, "u-sana", ctx.members);
    expect(hs).toEqual([expect.objectContaining({ kind: "reopen", lead: "Refresh brand colour palette", keep: "Keep it done" })]);
  });

  it("warns when a milestone, or a task it depends on, moves", () => {
    const moved = headsUps([upd("t5", { dueDate: "2026-10-12" })] as AskAction[], tasks, "u-me", ctx.members);
    expect(moved[0]).toMatchObject({ kind: "milestone", lead: "Launch day" });
    const dep = headsUps([upd("t4", { dueDate: "2026-10-07" })] as AskAction[], tasks, "u-me", ctx.members);
    expect(dep[0]).toMatchObject({ kind: "milestone", lead: "Draft investor update", text: "feeds the milestone “Launch day”, due Mon 5 Oct — this lands after it." });
  });
});

describe("inversePatches", () => {
  it("restores every changed field, clearing ones that were empty", () => {
    const inv = inversePatches([
      upd("t1", { dueDate: "2026-10-05", dueTime: "09:00", status: "progress" }),
      { op: "create", task: { title: "New" } },
      { op: "open", route: { view: "plan" } },
    ] as AskAction[], byId);
    expect(inv).toEqual([{ op: "update", id: "t1", patch: { status: "todo", dueDate: "2026-09-30", dueTime: undefined } }]);
    expect("dueTime" in (inv[0] as { patch: object }).patch).toBe(true);
  });
});

describe("fmtDay", () => {
  it("formats en-GB, long on request, with the year only when it differs", () => {
    expect(fmtDay("2026-10-05", "2026-09-30")).toBe("Mon 5 Oct");
    expect(fmtDay("2026-10-05", "2026-09-30", true)).toBe("Monday 5 Oct");
    expect(fmtDay("2027-01-04", "2026-09-30")).toBe("Mon 4 Jan 2027");
  });
});
