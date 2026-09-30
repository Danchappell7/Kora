import { describe, it, expect } from "vitest";
import type { Task } from "../data/types";
import type { AskContext } from "./askTypes";
import { localAsk, parseWhen, parseWhenLocal, LOCAL_HELP } from "./askFallback";
import { validateActions } from "./askActions";

// Wednesday 30 September 2026; the week runs Mon 28 Sep – Sun 4 Oct
const TODAY = "2026-09-30";
const task = (id: string, title: string, extra: Partial<Task> = {}): Task => ({
  id, title, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "u-me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, ...extra,
});
const ctx: AskContext = {
  today: TODAY,
  me: "u-me",
  members: [
    { id: "u-me", name: "Daniel Okai" }, { id: "u-maya", name: "Maya Lin" },
    { id: "u-sana", name: "Sana Rao" }, { id: "u-theo", name: "Theo Vance" },
  ],
  projects: [{ id: "p-launch", name: "Q3 Product Launch" }, { id: "p-brand", name: "Brand Refresh" }],
};
const tasks: Task[] = [
  task("t1", "Send Idris the interview brief", { dueDate: "2026-09-28" }),
  task("t2", "Approve token naming", { dueDate: TODAY, projectId: "p-brand" }),
  task("t3", "Weekly review & plan", { dueDate: TODAY, aiScore: 40 }),
  task("t4", "Draft investor update", { dueDate: "2026-10-02" }),
  task("t5", "Finalise Q3 launch narrative deck", { status: "progress", dueDate: TODAY, aiScore: 96, aiReason: "Blocks 3 downstream tasks and is due today." }),
  task("t6", "Prep launch-day comms plan", { status: "progress", dueDate: "2026-10-01" }),
  task("t7", "Migrate auth to edge sessions", { status: "progress", assigneeId: "u-maya", dueDate: "2026-10-01", aiScore: 90 }),
  task("t8", "Ship onboarding redesign to staging", { status: "blocked", assigneeId: "u-maya", dueDate: "2026-10-01", dependencies: ["t2"] }),
  task("t9", "Set up usage analytics events", { status: "review", assigneeId: "u-maya", dueDate: "2026-10-02" }),
  task("t10", "Run pricing-page A/B test", { assigneeId: "u-theo", dueDate: "2026-10-06" }),
  task("t11", "Approve Q3 launch budget", { status: "done", dueDate: "2026-09-29" }),
  task("t12", "New homepage hero illustration", { assigneeId: "u-sana", dueDate: "2026-09-25", projectId: "p-brand", tags: ["design"] }),
  task("t13", "Old archived thing", { dueDate: "2026-09-20", archivedAt: "2026-09-21" }),
];
const ask = (q: string) => localAsk(q, tasks, ctx);
const updates = (q: string) => ask(q).actions.map((a) => (a.op === "update" ? [a.id, a.patch] : a));

describe("localAsk: moving", () => {
  it("moves my unstarted tasks this week to Monday, leaving work under way alone", () => {
    const r = ask("move my unstarted tasks this week to monday");
    expect(r.source).toBe("local");
    expect(updates("move my unstarted tasks this week to monday")).toEqual([
      ["t1", { dueDate: "2026-10-05" }], ["t2", { dueDate: "2026-10-05" }], ["t3", { dueDate: "2026-10-05" }], ["t4", { dueDate: "2026-10-05" }],
    ]);
    expect(r.answer).toBe("Four of your tasks due this week haven't been started. I'll move them to Monday 5 Oct. “Finalise Q3 launch narrative deck” and “Prep launch-day comms plan” are already under way, so I've left them alone.");
    expect(r.cites).toEqual(expect.arrayContaining(["t1", "t2", "t3", "t4", "t5", "t6"]));
    // what it proposes passes validation untouched
    expect(validateActions(r.actions, tasks, ctx, true).valid).toEqual(r.actions);
  });

  it("moves everything due today, and my overdue tasks", () => {
    expect(updates("Move everything due today to Friday")).toEqual([
      ["t2", { dueDate: "2026-10-02" }], ["t3", { dueDate: "2026-10-02" }], ["t5", { dueDate: "2026-10-02" }],
    ]);
    const late = ask("push my overdue tasks to tomorrow");
    expect(late.actions).toEqual([{ op: "update", id: "t1", patch: { dueDate: "2026-10-01" } }]);
    expect(late.answer).toBe("One of your tasks is overdue. I'll move it to Thursday 1 Oct.");
  });

  it("moves one task by a quoted or rough title, with a time", () => {
    expect(updates("reschedule “investor update” to 5/10 at 3pm")).toEqual([["t4", { dueDate: "2026-10-05", dueTime: "15:00" }]]);
    expect(ask("move the interview brief to 9/10").answer).toBe("I'll move “Send Idris the interview brief” to Friday 9 Oct.");
  });

  it("moves by a relative amount", () => {
    expect(updates("push the investor update back a week")).toEqual([["t4", { dueDate: "2026-10-09" }]]);
    expect(updates("bring the investor update forward 2 days")).toEqual([["t4", { dueDate: "2026-09-30" }]]);
  });

  it("says when a task is already there, or can't be found, or the day is unclear", () => {
    expect(ask("move investor update to 2 Oct").answer).toBe("“Draft investor update” is already due Friday 2 Oct.");
    expect(ask("move the spaceship to monday").answer).toBe("I couldn't find a task called “the spaceship”.");
    expect(ask("move the investor update to someday").answer).toMatch(/couldn't tell which day/);
  });

  it("asks which one when a title is ambiguous", () => {
    const r = ask("move launch to friday");
    expect(r.actions).toEqual([]);
    expect(r.answer).toBe("Two tasks match “launch”: “Finalise Q3 launch narrative deck” and “Prep launch-day comms plan”. Which one did you mean?");
    expect(r.cites).toEqual(["t5", "t6"]);
    // a finished task only counts when nothing open matches
    expect(updates("move approve to friday")).toEqual([["t2", { dueDate: "2026-10-02" }]]);
  });

  it("moves a task to another project", () => {
    expect(updates("move the investor update to Brand Refresh")).toEqual([["t4", { projectId: "p-brand" }]]);
  });
});

describe("localAsk: read-only (guests)", () => {
  it("answers, and says what a change would take instead of promising it", () => {
    const r = localAsk("move my unstarted tasks this week to monday", tasks, ctx, { canAct: false });
    expect(r.answer).toMatch(/^Four of your tasks due this week haven't been started\. Moving them to Monday 5 Oct needs edit access\./);
    // the changes still come back, and the one gate turns them all away
    expect(r.actions).toHaveLength(4);
    expect(validateActions(r.actions, tasks, ctx, false).valid).toEqual([]);
    expect(localAsk("assign pricing-page test to sana", tasks, ctx, { canAct: false }).answer).toBe("Assigning “Run pricing-page A/B test” to Sana Rao needs edit access.");
  });

  it("doesn't ask a guest to firm up a plan", () => {
    expect(localAsk("plan my day", tasks, ctx, { canAct: false }).answer).toMatch(/Your day is laid out on Today\.$/);
    expect(localAsk("plan my day", tasks, ctx).answer).toMatch(/press Plan my day to make it solid\.$/);
  });
});

describe("localAsk: assigning and marking", () => {
  it("assigns by fuzzy title and first name", () => {
    const r = ask("assign pricing-page test to sana");
    expect(r.actions).toEqual([{ op: "update", id: "t10", patch: { assigneeId: "u-sana" } }]);
    expect(r.answer).toBe("I'll assign “Run pricing-page A/B test” to Sana Rao.");
    expect(ask("assign the pricing page test to theo").answer).toBe("“Run pricing-page A/B test” is already Theo's.");
    expect(ask("assign the pricing page test to bob").answer).toBe("I don't know anyone called “bob” in this workspace.");
    expect(updates("assign weekly review to me")).toEqual([]);
    expect(updates("unassign the hero illustration")).toEqual([["t12", { assigneeId: "" }]]);
  });

  it("marks a task done, in progress or blocked", () => {
    expect(updates("mark weekly review done")).toEqual([["t3", { status: "done" }]]);
    expect(updates("mark the investor update as in progress")).toEqual([["t4", { status: "progress" }]]);
    expect(updates("set token naming to blocked")).toEqual([["t2", { status: "blocked" }]]);
    expect(updates("move weekly review to done")).toEqual([["t3", { status: "done" }]]);
    expect(ask("mark the deck in progress").answer).toBe("“Finalise Q3 launch narrative deck” is already in progress.");
  });

  it("changes priority", () => {
    expect(updates("make the investor update urgent")).toEqual([["t4", { priority: "urgent" }]]);
  });
});

describe("localAsk: questions", () => {
  it("answers what's overdue, with owners and citations", () => {
    const r = ask("What's overdue?");
    expect(r.actions).toEqual([]);
    expect(r.answer).toBe("Two tasks are overdue: “New homepage hero illustration” (Sana) and “Send Idris the interview brief” (yours).");
    expect(r.cites).toEqual(["t12", "t1"]);
    expect(ask("what's overdue in brand refresh").answer).toBe("One of Sana's tasks is overdue in Brand Refresh: “New homepage hero illustration”.");
  });

  it("answers what's due today and this week", () => {
    expect(ask("what's due today?").answer).toBe("Three of your tasks are due today: “Finalise Q3 launch narrative deck”, “Weekly review & plan” and “Approve token naming”.");
    const week = ask("what is due this week");
    expect(week.cites).toHaveLength(9);
    expect(week.answer).toMatch(/^Nine tasks are due this week: .+ and 6 more\.$/);
    expect(ask("what's due tomorrow for maya").answer).toBe("Two of Maya's tasks are due tomorrow: “Migrate auth to edge sessions” and “Ship onboarding redesign to staging”.");
  });

  it("answers what someone is working on", () => {
    const r = ask("what is maya working on?");
    expect(r.answer).toBe("Maya has two things under way: “Migrate auth to edge sessions” and “Set up usage analytics events” (in review). “Ship onboarding redesign to staging” is blocked.");
    expect(r.cites).toEqual(["t7", "t9", "t8"]);
    expect(ask("theo's tasks").answer).toBe("Theo has nothing in progress right now. Next up: “Run pricing-page A/B test”, due Tue 6 Oct.");
    expect(ask("what am I working on").answer).toMatch(/^You have two things under way/);
    expect(ask("what is gandalf working on").answer).toBe("I don't know anyone called “gandalf” in this workspace.");
  });

  it("answers what's blocked", () => {
    expect(ask("what's blocked?").answer).toBe("One of Maya's tasks is blocked: “Ship onboarding redesign to staging” (waiting on “Approve token naming”).");
  });

  it("plans my day by opening Today", () => {
    const r = ask("plan my afternoon");
    expect(r.actions).toEqual([{ op: "open", route: { view: "plan" } }]);
    expect(r.answer).toMatch(/^For this afternoon: you have three things on today and one overdue\. Start with “Finalise Q3 launch narrative deck”: blocks 3 downstream tasks and is due today\./);
  });

  it("suggests what to work on next", () => {
    expect(ask("what should I work on next?")).toMatchObject({ actions: [{ op: "open", taskId: "t5" }], cites: ["t5"] });
  });

  it("explains what it can do for anything else", () => {
    expect(ask("write me a poem").answer).toBe(LOCAL_HELP);
    expect(ask("").answer).toBe(LOCAL_HELP);
    // not drawn from the tasks, so no "How I got here"
    expect(ask("write me a poem").cites).toBeUndefined();
    expect(ask("what is zed working on?").cites).toBeUndefined();
    expect(LOCAL_HELP).toBe("I can find, move, assign and mark tasks on-device. Try “what's overdue?” or “move my unstarted tasks this week to Monday”.");
  });
});

describe("parseWhen", () => {
  // what any reading of the shared grammar agrees on (nlp.ts decides first)
  it.each([
    ["today", "2026-09-30"], ["tomorrow", "2026-10-01"], ["monday", "2026-10-05"], ["Mon", "2026-10-05"],
    ["friday", "2026-10-02"], ["5/10", "2026-10-05"], ["05/10/2026", "2026-10-05"], ["5 Oct", "2026-10-05"], ["2026-11-01", "2026-11-01"],
  ])("%s → %s", (text, date) => {
    expect(parseWhen(text, TODAY)?.date).toBe(date);
  });
  it("reads a trailing time", () => {
    expect(parseWhen("friday at 3pm", TODAY)).toEqual({ date: "2026-10-02", time: "15:00" });
    expect(parseWhen("tomorrow 9:30", TODAY)).toEqual({ date: "2026-10-01", time: "09:30" });
  });
  it("is null for things that aren't days", () => {
    expect(parseWhen("someday", TODAY)).toBeNull();
    expect(parseWhen("31/02", TODAY)).toBeNull();
  });
});

describe("parseWhenLocal (the on-device rules)", () => {
  it.each([
    ["today", "2026-09-30"], ["tomorrow", "2026-10-01"], ["monday", "2026-10-05"], ["Mon", "2026-10-05"],
    ["friday", "2026-10-02"], ["next friday", "2026-10-09"], ["next monday", "2026-10-05"], ["wednesday", "2026-10-07"],
    ["next week", "2026-10-05"], ["end of the week", "2026-10-02"], ["in 3 days", "2026-10-03"], ["in a fortnight", "2026-10-14"],
    ["5/10", "2026-10-05"], ["5.10", "2026-10-05"], ["05/10/2026", "2026-10-05"], ["5 Oct", "2026-10-05"], ["october 12th", "2026-10-12"],
    ["3 sep", "2027-09-03"], ["2026-11-01", "2026-11-01"], ["the weekend", "2026-10-03"], ["end of month", "2026-09-30"],
  ])("%s → %s", (text, date) => {
    expect(parseWhenLocal(text, TODAY)?.date).toBe(date);
  });
  it("reads times, but not a dd.mm date as one", () => {
    expect(parseWhenLocal("friday at 9.30", TODAY)).toEqual({ date: "2026-10-02", time: "09:30" });
    expect(parseWhenLocal("mon 3pm", TODAY)).toEqual({ date: "2026-10-05", time: "15:00" });
    expect(parseWhenLocal("5.10", TODAY)).toEqual({ date: "2026-10-05" });
  });
  it("is null for things that aren't days", () => {
    expect(parseWhenLocal("someday", TODAY)).toBeNull();
    expect(parseWhenLocal("31/02", TODAY)).toBeNull();
  });
});
