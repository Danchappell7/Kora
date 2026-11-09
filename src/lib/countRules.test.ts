import { describe, it, expect } from "vitest";
import type { Project, Task } from "../data/types";
import {
  blockedAndWaiting, blockedText, combinedProgress, isBlocked, isWaiting, needsActionText, openBlockers, progressOf,
  projectPct, projectProgressOf, riskTally, RISK_WORDS, waitingText,
} from "./countRules";
import { statusFacts } from "./statusDraft";
import { projectProgress } from "../data/data";
import { goalProgressMap, projectHealth } from "../components/views/reportingUtils";
import { topLevelProgress } from "./taskOps";
import { computeRisks } from "./radar";

const TODAY = new Date(2026, 8, 30);
let n = 0;
const task = (o: Partial<Task> & { title?: string }): Task => ({
  id: `t-${++n}`, title: "A task", description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

// one project: 4 top-level tasks (2 done), and 6 sub-tasks under the first (all open).
// Counting every task said 2 of 10 (20%); the header has always said 2 of 4 (50%).
const parent = task({ id: "parent", status: "done" });
const P_TASKS = [
  parent, task({ status: "done" }), task({}), task({ status: "blocked" }),
  ...Array.from({ length: 6 }, () => task({ parentId: "parent" })),
  task({ status: "done", archivedAt: "2026-09-01T10:00:00Z" }),   // archived: never counted
];
const OTHER = [task({ projectId: "q", status: "done" }), task({ projectId: "q" })];
const ALL = [...P_TASKS, ...OTHER];
const PROJECT: Project = { id: "p", name: "Launch", emoji: "🚀", color: "red", workspaceId: "ws" };

describe("progress: one rule", () => {
  it("counts live top-level tasks only", () => {
    expect(progressOf(P_TASKS)).toEqual({ total: 4, done: 2, pct: 50 });
    expect(projectProgressOf(ALL, "p")).toEqual({ total: 4, done: 2, pct: 50 });
    expect(projectPct(ALL, "q")).toBe(50);
    expect(projectPct(ALL, "missing")).toBe(0);
    expect(progressOf([])).toEqual({ total: 0, done: 0, pct: 0 });
  });

  it("a portfolio reads every top-level task across its projects, not an average of percentages", () => {
    const big = Array.from({ length: 9 }, (_, i) => task({ projectId: "big", status: i < 9 ? "done" : "todo" }));
    const small = [task({ projectId: "small" })];
    expect(combinedProgress([...big, ...small], ["big", "small"])).toEqual({ total: 10, done: 9, pct: 90 });
    expect(combinedProgress(ALL, ["p", "q"])).toEqual({ total: 6, done: 3, pct: 50 });
    expect(combinedProgress(ALL, [])).toEqual({ total: 0, done: 0, pct: 0 });
  });

  it("every screen that shows a project's % agrees with the project header", () => {
    const header = statusFacts(PROJECT, ALL, [], TODAY).pct;            // the project header and the directory
    expect(header).toBe(50);
    expect(projectProgress(ALL, "p")).toBe(header);                       // Overview cards (data.projectProgress)
    expect(projectHealth(P_TASKS.filter((t) => !t.archivedAt), TODAY)?.pct).toBe(header);   // portfolio health
    expect(topLevelProgress(P_TASKS.filter((t) => !t.archivedAt)).pct).toBe(header);
    const goals = goalProgressMap([{ id: "g", name: "Ship", status: "on_track", projectId: "p" }], (pid) => projectPct(ALL, pid));
    expect(goals.get("g")?.pct).toBe(header);                               // a linked goal
  });
});

describe("the risk vocabulary", () => {
  const blocker = task({ id: "b1", title: "Design tokens" });
  const doneDep = task({ id: "b2", status: "done" });
  const marked = task({ id: "m", status: "blocked", dependencies: ["b1"] });
  const markedAlone = task({ id: "m2", status: "blocked" });
  const waiting = task({ id: "w", dependencies: ["b1"] });
  const free = task({ id: "f", dependencies: ["b2"] });
  const finished = task({ id: "d", status: "done", dependencies: ["b1"] });
  const list = [blocker, doneDep, marked, markedAlone, waiting, free, finished];
  const byId = new Map(list.map((t) => [t.id, t]));

  it("blocked is the status; waiting on is an open dependency; never both", () => {
    expect(isBlocked(marked)).toBe(true);
    expect(isBlocked(markedAlone)).toBe(true);
    expect(isWaiting(marked, byId)).toBe(false);       // counted once, as blocked
    expect(isWaiting(waiting, byId)).toBe(true);
    expect(isWaiting(free, byId)).toBe(false);         // its dependency is done
    expect(isWaiting(finished, byId)).toBe(false);     // done work waits on nothing
    expect(isBlocked(task({ status: "blocked", archivedAt: "2026-09-01" }))).toBe(false);
    expect(openBlockers(waiting, (id) => byId.get(id)).map((t) => t.id)).toEqual(["b1"]);
    const split = blockedAndWaiting(list);
    expect(split.blocked.map((t) => t.id)).toEqual(["m", "m2"]);
    expect(split.waiting.map((t) => t.id)).toEqual(["w"]);
    // dependencies are looked up in `all` when the list is only part of it
    expect(blockedAndWaiting([waiting], list).waiting.map((t) => t.id)).toEqual(["w"]);
    expect(blockedAndWaiting([waiting]).waiting).toEqual([]);
  });

  it("a milestone is never waiting: it waits for its work by design", () => {
    const launch = task({ id: "ms", isMilestone: true, dependencies: ["b1"] });
    expect(isWaiting(launch, byId)).toBe(false);
    expect(blockedAndWaiting([...list, launch]).waiting.map((t) => t.id)).toEqual(["w"]);
  });

  it("Radar's blocked and held-up risks are some of Ask Kanbo's blocked and waiting tasks, never more or others", () => {
    const day = (d: number) => { const x = new Date(2026, 8, 30 + d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`; };
    const deck = task({ id: "deck", title: "Launch deck", status: "progress", assigneeId: "m-2", dueDate: day(1) });
    const tasks = [
      deck,
      task({ id: "press", title: "Press release", assigneeId: "m-1", dueDate: day(2), dependencies: ["deck"] }),      // held up: someone else's, due soon
      task({ id: "later", title: "Later work", assigneeId: "m-1", dueDate: day(30), dependencies: ["deck"] }),        // waiting, not pressing
      task({ id: "own", title: "Own follow-up", assigneeId: "m-2", dueDate: day(2), dependencies: ["deck"] }),        // their own sequencing
      task({ id: "day", title: "Launch day", isMilestone: true, assigneeId: "m-1", dueDate: day(3), dependencies: ["deck"] }),
      task({ id: "vendor", title: "Vendor contract", status: "blocked", assigneeId: "m-2" }),
    ];
    const members = [{ id: "m-1", name: "Maya" }, { id: "m-2", name: "Theo" }];
    const risks = computeRisks({ tasks, members, capacities: {}, today: day(0) });
    const split = blockedAndWaiting(tasks);
    expect(split.blocked.map((t) => t.id)).toEqual(["vendor"]);
    expect(split.waiting.map((t) => t.id).sort()).toEqual(["later", "own", "press"]);
    const heldUp = risks.filter((r) => r.kind === "waiting");
    expect(heldUp.map((r) => r.taskIds[0])).toEqual(["press"]);
    expect(heldUp[0].title).toBe("Press release is held up");   // a risk's words, not the category's
    for (const r of heldUp) expect(split.waiting.map((t) => t.id)).toContain(r.taskIds[0]);
    for (const r of risks.filter((x) => x.kind === "blocked")) expect(split.blocked.map((t) => t.id)).toContain(r.taskIds[0]);
  });

  it("says it the same way everywhere", () => {
    expect(RISK_WORDS).toEqual({ blocked: "Blocked", waiting: "Waiting on", action: "Needs action", look: "Worth a look" });
    expect(blockedText(2)).toBe("2 blocked");
    expect(waitingText(1)).toBe("1 waiting on other work");
    expect(needsActionText(1)).toBe("One risk needs action");
    expect(needsActionText(4)).toBe("Four risks need action");
    expect(needsActionText(12)).toBe("12 risks need action");
    expect(riskTally([{ severity: "signal" }, { severity: "warn" }, { severity: "signal" }, { severity: "neutral" }])).toEqual({ all: 4, action: 2, look: 2 });
  });
});
