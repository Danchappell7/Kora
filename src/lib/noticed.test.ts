import { describe, it, expect } from "vitest";
import { noticedToday } from "./noticed";
import type { CalEvent, Task } from "../data/types";
import type { Risk } from "./radar";

const TODAY = "2026-09-30";
const day = (n: number) => { const d = new Date(2026, 8, 30 + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
const H = (h: number, m = 0) => h * 60 + m;
let n = 0;
const task = (o: Partial<Task> = {}): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "todo", priority: "medium",
  projectId: "p", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const busy = (start: number, end: number): CalEvent => ({ id: "m" + start, title: "Meeting", start, end, kind: "meeting" });
const members = [{ id: "me", name: "Daniel Okai" }, { id: "maya", name: "Maya Lin" }, { id: "theo", name: "Theo Vance" }];
const noticed = (tasks: Task[], o: Partial<Parameters<typeof noticedToday>[0]> = {}) =>
  noticedToday({ tasks: tasks.filter((t) => t.assigneeId === "me"), allTasks: tasks, events: [], nowMin: H(10), today: TODAY, me: "me", members, ...o });

describe("Kanbo noticed", () => {
  it("someone blocked on your work comes first, with an action that opens it and one that puts it on today", () => {
    const mine = task({ id: "tok", title: "Design tokens", status: "review", focusMin: 20 });
    const theirs = task({ title: "Ship onboarding", assigneeId: "maya", status: "blocked", dependencies: ["tok"] });
    const [first] = noticed([mine, theirs]);
    expect(first).toMatchObject({
      id: "waiting:tok", kind: "waiting", tone: "signal", title: "Maya is blocked on you",
      body: "Ship onboarding can't move until Design tokens is done. It's about 20m.",
    });
    expect(first.actions).toEqual([
      { kind: "open", label: "Review it now", taskId: "tok" },
      { kind: "today", label: "Add to today", taskId: "tok" },
    ]);
  });

  it("several people waiting read as a count", () => {
    const mine = task({ id: "api" });
    const items = noticed([mine, task({ assigneeId: "maya", dependencies: ["api"] }), task({ assigneeId: "theo", dependencies: ["api"] })]);
    expect(items[0].title).toBe("2 people are waiting on you");
    expect(items[0].tone).toBe("accent");
  });

  it("a date that has slipped offers the free stretch for it today", () => {
    const t = task({ id: "inv", title: "Investor update", dueDate: day(2), originalDueDate: day(-5), focusMin: 40 });
    const [s] = noticed([t], { events: [busy(H(10), H(14))] });
    expect(s).toMatchObject({ kind: "slipped", tone: "warn", title: "Investor update has slipped 7 days" });
    expect(s.body).toBe("It was due 25 Sep; now it's 2 Oct. It's only 40m, and 14:00–14:40 is free today.");
    expect(s.actions[0]).toEqual({ kind: "place", label: "Put it at 14:00", taskId: "inv", start: H(14) });
  });

  it("a free stretch today before tomorrow's deadline", () => {
    const [s] = noticed([task({ id: "faq", title: "Press FAQ", dueDate: day(1), focusMin: 45 })]);
    expect(s).toMatchObject({ kind: "slot", title: "Room today for Press FAQ", body: "It's due tomorrow, and 10:00–10:45 is free today." });
  });

  it("shows Radar's risks only when they touch your work, and not twice for the same wait", () => {
    const mine = task({ id: "a" });
    const risk = (id: string, taskIds: string[], severity: Risk["severity"] = "signal"): Risk => ({ id, kind: "blocked", severity, title: `Risk ${id}`, reason: "Waiting", taskIds, fixes: [] });
    const items = noticed([mine, task({ id: "x", assigneeId: "theo" })], { risks: [risk("mine", ["a"]), risk("theirs", ["x"]), risk("quiet", ["a"], "neutral")] });
    expect(items.map((i) => i.id)).toEqual(["risk:mine"]);
    expect(items[0].actions).toEqual([{ kind: "open", label: "Open it", taskId: "a" }, { kind: "risks", label: "See the risks" }]);
  });

  it("keeps to three, most pressing first, and leaves out what you've waved away", () => {
    const tasks = [
      task({ id: "a" }), task({ assigneeId: "maya", status: "blocked", dependencies: ["a"] }),
      task({ id: "b" }), task({ assigneeId: "theo", dependencies: ["b"] }),
      task({ id: "s", dueDate: day(3), originalDueDate: day(0) }),
      task({ id: "f", dueDate: day(1) }),
    ];
    expect(noticed(tasks).map((i) => i.id)).toEqual(["waiting:a", "waiting:b", "slipped:s:" + day(3)]);
    expect(noticed(tasks, { dismissed: ["waiting:a"] }).map((i) => i.id)).toEqual(["waiting:b", "slipped:s:" + day(3), "slot:f"]);
  });

  it("after the working day, offers no slots", () => {
    expect(noticed([task({ dueDate: day(1) })], { nowMin: H(19) })).toEqual([]);
  });
});

describe("Kanbo noticed: a key result of yours behind pace (0052)", () => {
  const behind = (o: Partial<{ goalId: string; name: string; noun: string; gap: number; line: string; sinceCheckin: number | null }> = {}) =>
    ({ goalId: "g-win", name: "Win back 120 lapsed accounts", noun: "key result", gap: 21, line: "Behind pace by 21%", sinceCheckin: 9, ...o });

  it("says how far behind and when it was last checked in, with a one-tap check-in", () => {
    const [item] = noticed([], { goalsBehind: [behind()] });
    expect(item).toMatchObject({
      id: "goal:g-win", kind: "goal", tone: "warn", icon: "target", title: "Your key result is behind pace",
      body: "Win back 120 lapsed accounts is 21% behind pace. The last check-in was 9 days ago.",
    });
    expect(item.actions).toEqual([{ kind: "checkin", label: "Check in", goalId: "g-win" }, { kind: "goal", label: "Open it", goalId: "g-win" }]);
  });

  it("only the furthest behind, never twice once waved away, and in the words of where it stands", () => {
    expect(noticed([], { goalsBehind: [behind(), behind({ goalId: "g-2" })] }).filter((n) => n.kind === "goal")).toHaveLength(1);
    expect(noticed([], { goalsBehind: [behind(), behind({ goalId: "g-2", name: "Other" })], dismissed: ["goal:g-win"] })[0].id).toBe("goal:g-2");
    expect(noticed([], { goalsBehind: [behind({ noun: "goal", line: "Past due at 40%", sinceCheckin: null })] })[0])
      .toMatchObject({ title: "Your goal is behind pace", body: "Win back 120 lapsed accounts is past due at 40%. It has no check-ins yet." });
    expect(noticed([], { goalsBehind: [behind({ sinceCheckin: 0 })] })[0].body).toMatch(/You checked in today\.$/);
  });

  it("someone blocked on you still comes first", () => {
    const mine = task({ id: "tok2", title: "Design tokens", status: "review", focusMin: 20 });
    const theirs = task({ title: "Ship onboarding", assigneeId: "maya", status: "blocked", dependencies: ["tok2"] });
    expect(noticed([mine, theirs], { goalsBehind: [behind()] }).map((n) => n.kind)).toEqual(["waiting", "goal"]);
  });

  it("work due while someone's away (0055) comes after anyone blocked on you, before the risks", () => {
    const away = { id: "away:sana:2026-10-01", kind: "away" as const, tone: "warn" as const, icon: "calendar" as const, title: "Sana's away when a task is due", body: "…",
      actions: [{ kind: "away" as const, label: "Move to Mon", userId: "sana", taskIds: ["x"], to: "2026-10-05" }] };
    const risk: Risk = { id: "r1", kind: "blocked", severity: "signal", title: "Launch is blocked", reason: "Waiting", taskIds: ["mine1"], memberId: "me", fixes: [] };
    const mine = task({ id: "mine1", title: "Mine" });
    expect(noticed([mine], { risks: [risk], away: [away] }).map((x) => x.kind)).toEqual(["away", "risk"]);
    expect(noticed([mine], { risks: [risk], away: [away], dismissed: [away.id] }).map((x) => x.kind)).toEqual(["risk"]);
  });
});

describe("Kanbo noticed: leading a rollout (0057)", () => {
  const nudge = { id: "rollout:invited:ws:2", kind: "rollout" as const, tone: "accent" as const, icon: "users" as const, title: "2 people haven't joined Acme",
    body: "Priya and Jonas were invited but haven't signed in yet. A fresh invite often does it.", actions: [{ kind: "fix" as const, label: "Resend all", fix: "resend" }] };
  it("one fix, after your own work, and waved away for the day like any other", () => {
    const mine = task({ id: "tok", title: "Design tokens", status: "review" });
    const items = noticed([mine, task({ assigneeId: "maya", status: "blocked", dependencies: ["tok"] })], { rollout: [nudge, { ...nudge, id: "rollout:owner:ws:3" }] });
    expect(items.map((x) => x.kind)).toEqual(["waiting", "rollout"]);
    expect(items[1].actions).toEqual([{ kind: "fix", label: "Resend all", fix: "resend" }]);
    expect(noticed([], { rollout: [nudge], dismissed: [nudge.id] })).toEqual([]);
  });
  it("never ahead of three things of your own", () => {
    const due = (i: number) => task({ id: `d${i}`, title: `Due ${i}`, dueDate: day(1), originalDueDate: day(-3) });
    const items = noticed([due(1), due(2), due(3), task({ assigneeId: "maya", status: "blocked", dependencies: ["d1"] })], {
      goalsBehind: [{ goalId: "g", name: "Grow", noun: "goal", gap: 10, line: "Behind pace by 10%", sinceCheckin: 4 }], rollout: [nudge],
    });
    expect(items).toHaveLength(3);
    expect(items.some((x) => x.kind === "rollout")).toBe(false);
  });
});

describe("Kanbo noticed: wave 2 and wave 3 together", () => {
  const away = { id: "away:sana:2026-10-01", kind: "away" as const, tone: "warn" as const, icon: "calendar" as const, title: "Sana's away when a task is due", body: "…",
    actions: [{ kind: "away" as const, label: "Give to Theo", userId: "sana", taskIds: ["x"], to: "2026-10-01", assignTo: "theo" }] };
  const update = { id: "update:p1:2026-09-30", kind: "update" as const, tone: "accent" as const, icon: "notes" as const, title: "Your Launch update is due", body: "…",
    actions: [{ kind: "update" as const, label: "Write it", projectId: "p1" }] };
  const rollout = { id: "rollout:loose:ws:4", kind: "rollout" as const, tone: "accent" as const, icon: "users" as const, title: "4 tasks have no owner", body: "…",
    actions: [{ kind: "fix" as const, label: "Sort them out", fix: "loose" }] };
  const goal = { goalId: "g", name: "Grow weekly actives", noun: "key result", gap: 12, line: "Behind pace by 12%", sinceCheckin: 9 };
  it("your update, then the away card, then your goal: three at most, and the rollout's fix waits", () => {
    const items = noticed([], { updates: [update], away: [away], goalsBehind: [goal], rollout: [rollout] });
    expect(items.map((x) => x.kind)).toEqual(["update", "away", "goal"]);
  });
  it("waving one away lets the rollout's fix in, last", () => {
    const items = noticed([], { updates: [update], away: [away], goalsBehind: [goal], rollout: [rollout], dismissed: [away.id] });
    expect(items.map((x) => x.kind)).toEqual(["update", "goal", "rollout"]);
    expect(items[2].actions).toEqual([{ kind: "fix", label: "Sort them out", fix: "loose" }]);
  });
});
