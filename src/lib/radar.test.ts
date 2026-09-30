import { describe, it, expect, beforeEach } from "vitest";
import type { Task, WorkspaceEvent } from "../data/types";
import { computeRisks, loadForWeek, loadTone, readCapacities, taskHours, writeCapacities, type Risk } from "./radar";

// Wednesday 30 September 2026; the week runs Mon 28 Sep – Sun 4 Oct
const TODAY = "2026-09-30";
const day = (offset: number) => { const d = new Date(2026, 8, 30 + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const at = (offset: number, hour = 10) => new Date(2026, 8, 30 + offset, hour).toISOString();

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-1",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, createdAt: at(-2), ...o,
});
let e = 0;
const ev = (taskId: string, field: string, oldValue: string | null, newValue: string | null, createdAt: string): WorkspaceEvent =>
  ({ id: "e" + (++e), taskId, actorId: "m-1", actorName: "Maya Lin", field, oldValue, newValue, createdAt });

const members = [
  { id: "m-self", name: "Daniel Okai" },
  { id: "m-1", name: "Maya Lin" },
  { id: "m-2", name: "Theo Vance" },
  { id: "m-3", name: "Sana Rao" },
];
const risks = (tasks: Task[], extra: Partial<Parameters<typeof computeRisks>[0]> = {}) =>
  computeRisks({ tasks, members, today: TODAY, capacities: {}, ...extra });
const kinds = (rs: Risk[]) => rs.map((r) => r.kind);

beforeEach(() => { localStorage.clear(); });

describe("computeRisks", () => {
  it("blocked: a task marked blocked names who it waits on, for how long, and offers a nudge", () => {
    const tokens = task({ id: "tokens", title: "Define design tokens v2", status: "review", assigneeId: "m-3", dueDate: day(0) });
    const onboarding = task({ id: "onb", title: "Ship onboarding redesign", status: "blocked", assigneeId: "m-1", dueDate: day(1), dependencies: ["tokens"] });
    const [r] = risks([tokens, onboarding], { events: [ev("onb", "status", "progress", "blocked", at(-2))] });
    expect(r).toMatchObject({
      kind: "blocked", severity: "signal", title: "Ship onboarding redesign is blocked",
      reason: 'Waiting on "Define design tokens v2" (Sana) for 2 days',
      taskIds: ["onb", "tokens"], memberId: "m-3", focusTaskId: "tokens",
    });
    expect(r.fixes).toEqual([{ kind: "nudge", label: "Nudge Sana" }, { kind: "open", label: "Open chain" }]);
  });

  it("blocked: waiting on someone else's open task counts when it's due within a week — not your own sequencing, not next month", () => {
    const edge = task({ id: "edge", title: "Migrate auth", status: "progress", assigneeId: "m-2", dueDate: day(1) });
    const soon = task({ id: "soon", title: "Usage events", status: "review", assigneeId: "m-1", dueDate: day(2), dependencies: ["edge"] });
    const mine = task({ id: "mine", title: "Own follow-up", assigneeId: "m-2", dueDate: day(2), dependencies: ["edge"] });
    const later = task({ id: "later", title: "Later work", assigneeId: "m-1", dueDate: day(30), dependencies: ["edge"] });
    const rs = risks([edge, soon, mine, later]).filter((r) => r.kind === "blocked");
    expect(rs.map((r) => r.id)).toEqual(["blocked:soon"]);
    expect(rs[0].reason).toBe('Waiting on "Migrate auth" (Theo), still in progress');
  });

  it("blocked: marked blocked with nothing to wait on nudges its own owner", () => {
    const [r] = risks([task({ id: "b", title: "Vendor contract", status: "blocked", assigneeId: "m-2" })]);
    expect(r).toMatchObject({ kind: "blocked", reason: "Marked blocked · Theo", memberId: "m-2" });
    expect(r.fixes[0]).toEqual({ kind: "nudge", label: "Nudge Theo" });
  });

  it("blocker_late: a blocker due after the task waiting on it, with the dates as a chain", () => {
    const deck = task({ id: "deck", title: "Launch deck", status: "progress", assigneeId: "m-self", dueDate: day(7) });
    const press = task({ id: "press", title: "Press kit", assigneeId: "m-2", dueDate: day(20), dependencies: ["deck"] });
    const kit = task({ id: "kit", title: "Press kit review", assigneeId: "m-3", dueDate: day(2), dependencies: ["deck"] });
    const [r] = risks([deck, press, kit]).filter((x) => x.kind === "blocker_late");
    expect(r).toMatchObject({
      id: "blocker_late:deck", severity: "signal", title: "Launch deck will hold up Press kit review",
      mono: "7 Oct → 2 Oct", reason: "7 Oct → 2 Oct · Daniel", taskIds: ["deck", "kit"], focusTaskId: "deck",
    });
    expect(r.fixes.map((f) => f.kind)).toEqual(["firm_date", "open"]);
  });

  it("blocker_late: an overdue blocker holds up everything waiting on it", () => {
    const spec = task({ id: "spec", title: "API spec", status: "progress", assigneeId: "m-3", dueDate: day(-3) });
    const a = task({ id: "a", title: "Client SDK", assigneeId: "m-1", dueDate: day(20), dependencies: ["spec"] });
    const b = task({ id: "b", title: "Docs", assigneeId: "m-1", dueDate: day(25), dependencies: ["spec"] });
    const [r] = risks([spec, a, b]).filter((x) => x.kind === "blocker_late");
    expect(r.title).toBe("API spec will hold up Client SDK");
    expect(r.reason).toBe("27 Sep → 20 Oct · overdue · Sana · and 1 more task");
    expect(r.taskIds).toEqual(["spec", "a", "b"]);
  });

  it("slipping: moved later twice shows the whole date chain", () => {
    const t = task({ id: "pr", title: "Pricing test", assigneeId: "m-2", originalDueDate: day(-4), dueDate: day(7) });
    const [r] = risks([t], { events: [ev("pr", "due", day(-4), day(2), at(-3)), ev("pr", "due", day(2), day(7), at(-1))] });
    expect(r).toMatchObject({
      kind: "slipping", severity: "warn", title: "Pricing test has slipped twice",
      mono: "26 Sep → 2 Oct → 7 Oct", reason: "26 Sep → 2 Oct → 7 Oct · Theo", memberId: "m-2",
    });
    expect(r.fixes).toEqual([{ kind: "firm_date", label: "Set a firm date" }, { kind: "check_in", label: "Check in" }]);
  });

  it("slipping: without any change history, only a move of more than a week counts", () => {
    const far = task({ id: "far", title: "Brand audit", originalDueDate: day(-5), dueDate: day(5) });
    const near = task({ id: "near", title: "Small nudge", originalDueDate: day(0), dueDate: day(3) });
    const once = task({ id: "once", title: "Moved once", originalDueDate: day(-5), dueDate: day(10) });
    const rs = risks([far, near, once], { events: [ev("once", "due", day(-5), day(10), at(-1))] }).filter((r) => r.kind === "slipping");
    expect(rs.map((r) => r.title)).toEqual(["Brand audit has slipped by 10 days"]);
    expect(rs[0].mono).toBe("25 Sep → 5 Oct");
  });

  it("stale: in progress with no change for a week", () => {
    const quiet = task({ id: "hero", title: "Hero illustration", status: "progress", assigneeId: "m-3", createdAt: at(-20) });
    const fresh = task({ id: "fresh", title: "Fresh work", status: "progress", createdAt: at(-20) });
    const rs = risks([quiet, fresh], { events: [ev("hero", "status", "todo", "progress", at(-9)), ev("fresh", "priority", "low", "high", at(-1))] });
    expect(rs.map((r) => r.id)).toEqual(["stale:hero"]);
    expect(rs[0]).toMatchObject({ title: "Hero illustration hasn't moved in 9 days", reason: "In progress with no changes since 21 Sep · Sana", memberId: "m-3" });
    expect(rs[0].fixes).toEqual([{ kind: "check_in", label: "Check in" }]);
  });

  it("stale: with no events, the age comes from when it was created — or 'over' the window the events cover", () => {
    const a = task({ id: "a", title: "Created a while ago", status: "progress", createdAt: at(-12) });
    const b = task({ id: "b", title: "Ancient", status: "progress", createdAt: at(-90) });
    const rs = risks([a, b], { events: [], eventsSince: day(-30) });
    expect(rs.map((r) => r.title).sort()).toEqual(["Ancient hasn't moved in over 30 days", "Created a while ago hasn't moved in 12 days"]);
  });

  it("unassigned_due: open, nobody owns it and it's due within three days", () => {
    const rs = risks([
      task({ id: "pr", title: "Press release", assigneeId: "", dueDate: day(1) }),
      task({ id: "late", title: "Late one", assigneeId: "", dueDate: day(-1) }),
      task({ id: "far", title: "Far off", assigneeId: "", dueDate: day(5) }),
      task({ id: "done", title: "Done one", assigneeId: "", dueDate: day(1), status: "done" }),
    ]).filter((r) => r.kind === "unassigned_due");
    expect(rs.map((r) => r.title).sort()).toEqual(["Late one is overdue with no owner", "Press release is due tomorrow with no owner"]);
    expect(rs[0].fixes).toEqual([{ kind: "assign", label: "Assign" }]);
    expect(rs[0].reason).toBe("Nobody has picked it up · Q3 Product Launch");
  });

  it("over_capacity: this week's hours against capacity — signal past 110%, warn from 90%", () => {
    const maya = [12, 16, 6, 10].map((h, i) => task({ assigneeId: "m-1", effortHours: h, dueDate: day(i) }));
    const theo = [30, 16].map((h) => task({ assigneeId: "m-2", effortHours: h, dueDate: day(2) }));
    const sana = [37].map((h) => task({ assigneeId: "m-3", effortHours: h, dueDate: day(2) }));
    const rs = risks([...maya, ...theo, ...sana]).filter((r) => r.kind === "over_capacity");
    expect(rs.map((r) => [r.title, r.severity, r.mono])).toEqual([
      ["Theo is over capacity", "signal", "46h / 40h"],
      ["Maya is over capacity", "warn", "44h / 40h"],
      ["Sana is near capacity", "warn", "37h / 40h"],
    ]);
    expect(rs[1]).toMatchObject({ memberId: "m-1", reason: "44h / 40h this week · 4 tasks", fixes: [{ kind: "rebalance", label: "Rebalance" }] });
    // a bigger capacity (as set in Workload) clears it; guests never carry capacity
    expect(risks(maya, { capacities: { "m-1": 50 } }).some((r) => r.kind === "over_capacity")).toBe(false);
    expect(computeRisks({ tasks: maya, members: [{ id: "m-1", name: "Maya Lin", guest: true }], today: TODAY, capacities: {} })).toEqual([]);
  });

  it("over_capacity: without estimates each task counts an hour (or its planned block)", () => {
    const many = Array.from({ length: 40 }, () => task({ assigneeId: "m-1", dueDate: day(1) }));
    const [r] = risks([...many, task({ assigneeId: "m-1", dueDate: day(1), dur: 90 })]).filter((x) => x.kind === "over_capacity");
    expect(r.mono).toBe("41.5h / 40h");
  });

  it("milestone_at_risk: a milestone within ten days with blocked or overdue work upstream", () => {
    const ms = task({ id: "ms", title: "Launch day", isMilestone: true, assigneeId: "", dueDate: day(8), dependencies: ["deck", "onb"] });
    const deck = task({ id: "deck", title: "Deck", status: "progress", dueDate: day(0) });
    const onb = task({ id: "onb", title: "Onboarding", status: "blocked", dueDate: day(1), assigneeId: "m-1" });
    const rs = risks([ms, deck, onb]).filter((r) => r.kind === "milestone_at_risk");
    expect(rs).toHaveLength(1);
    expect(rs[0]).toMatchObject({ title: "Launch day is at risk", reason: "Onboarding is blocked · due on 8 Oct", taskIds: ["ms", "onb"], fixes: [{ kind: "open", label: "Open chain" }] });
    // too far out: not yet a risk
    expect(risks([{ ...ms, dueDate: day(20) }, deck, onb]).some((r) => r.kind === "milestone_at_risk")).toBe(false);
  });

  it("ranks by severity, then by how much work each risk holds up, then by due date", () => {
    const blocker = task({ id: "x", title: "Upstream", status: "blocked", assigneeId: "m-2", dueDate: day(5) });
    const d1 = task({ id: "d1", title: "Down one", assigneeId: "m-2", dueDate: day(30), dependencies: ["x"] });
    const d2 = task({ id: "d2", title: "Down two", assigneeId: "m-2", dueDate: day(30), dependencies: ["d1"] });
    const lone = task({ id: "lone", title: "Lonely block", status: "blocked", assigneeId: "m-3", dueDate: day(1) });
    const unowned = task({ id: "u", title: "Unowned", assigneeId: "", dueDate: day(0) });
    const rs = risks([unowned, lone, blocker, d1, d2]);
    expect(rs.map((r) => r.id)).toEqual(["blocked:x", "blocked:lone", "unassigned_due:u"]);
  });

  it("narrows to one project, and ignores archived work", () => {
    const a = task({ id: "a", title: "In launch", status: "blocked", projectId: "p-launch" });
    const b = task({ id: "b", title: "In brand", status: "blocked", projectId: "p-brand" });
    const c = task({ id: "c", title: "Archived", status: "blocked", archivedAt: at(-1) });
    expect(risks([a, b, c], { projectId: "p-brand" }).map((r) => r.id)).toEqual(["blocked:b"]);
    expect(kinds(risks([a, b, c]))).toEqual(["blocked", "blocked"]);
  });

  it("reads capacities saved in Workload when none are passed", () => {
    writeCapacities({ "m-1": 20 });
    expect(readCapacities()).toEqual({ "m-1": 20 });
    const rs = computeRisks({ tasks: [task({ assigneeId: "m-1", effortHours: 21, dueDate: day(1) })], members, today: TODAY });
    expect(rs.map((r) => r.mono)).toEqual(["21h / 20h"]);
  });
});

describe("the shared load model", () => {
  it("hours come from the estimate, else the planned block, else 1h", () => {
    expect(taskHours({ effortHours: 3 })).toEqual({ hours: 3, estimated: true });
    expect(taskHours({ dur: 45 })).toEqual({ hours: 0.75, estimated: true });
    expect(taskHours({})).toEqual({ hours: 1, estimated: false });
  });

  it("counts this week's open work per person, and says how much of it was estimated", () => {
    const week = new Date(2026, 8, 28), today = new Date(2026, 8, 30);
    const { rows, estimated, undated } = loadForWeek([
      task({ assigneeId: "m-1", effortHours: 5, dueDate: day(1) }),
      task({ assigneeId: "m-1", dueDate: day(2) }),
      task({ assigneeId: "m-1", dueDate: day(2), status: "done" }),
      task({ assigneeId: "m-1", isMilestone: true, dueDate: day(2) }),
      task({ assigneeId: "m-2" }),
    ], week, today);
    expect(rows.get("m-1")?.hours).toBe(6);
    expect(rows.get("m-1")?.items.map((i) => i.estimated)).toEqual([true, false]);
    expect(estimated).toBe(1);
    expect(undated).toBe(1);
  });

  it("tones: ink under 90%, warn to 100%, signal above", () => {
    expect(loadTone(35, 40)).toBe("ink");
    expect(loadTone(36, 40)).toBe("warn");
    expect(loadTone(40.04, 40)).toBe("warn");
    expect(loadTone(41, 40)).toBe("signal");
  });
});
