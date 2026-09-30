import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ShutdownSheet } from "./ShutdownSheet";
import { WeeklyReview } from "./WeeklyReview";
import { todayISO } from "../../data/data";
import type { Task } from "../../data/types";
import { addDaysISO, isoWeek, nextWeekISO, readBig3, reviewWeek, shutdownDone, writeBig3 } from "../../lib/rituals";
import { clearUndo, undoLast } from "../../lib/undoStack";

const today = todayISO();
const tomorrow = addDaysISO(today, 1);
const now = new Date().toISOString();
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...extra,
});

// three weeks out: after both Tomorrow and Next week, whatever day the tests run on
const later = addDaysISO(today, 21);
const TASKS: Task[] = [
  task("Finalise deck", { status: "done", completedAt: now, dur: 90 }),
  task("Send the interview brief", { dueDate: today }),
  task("Draft the agenda", { planToday: true, scheduled: 540 }),
  task("Approve token naming", { planToday: true, scheduled: 600, dueDate: later }),   // planned; its deadline is later
  task("Plan Q4 offsite"),                                          // not on today
];
// tasks you collaborate on: the due date is Maya's (m-1 in the demo members)
const SHARED: Task[] = [
  task("Review Maya's copy", { assigneeId: "m-1", collaborators: ["me"], planToday: true, scheduled: 660, dueDate: later }),
  task("Launch checklist", { assigneeId: "m-1", collaborators: ["me"], dueDate: today }),
];

function shutdown(extra: Partial<Parameters<typeof ShutdownSheet>[0]> = {}) {
  const onPatch = vi.fn();
  const props = {
    open: true, onClose: vi.fn(), tasks: TASKS, allTasks: TASKS, currentUserId: "me", userName: "Daniel Okai",
    onPatch, onComment: vi.fn().mockResolvedValue({ id: "c1" }), focusMinutesToday: 25, ...extra,
  };
  return { ...render(<ShutdownSheet {...props} />), props, onPatch };
}
const next = () => fireEvent.click(screen.getByRole("button", { name: "Next" }));
const chip = (title: string, label: RegExp) =>
  within(screen.getByRole("group", { name: `Where “${title}” goes` })).getByRole("button", { name: label });

beforeEach(() => { localStorage.clear(); clearUndo(); });
afterEach(() => { clearUndo(); });

describe("ShutdownSheet — step 1, what you finished", () => {
  it("counts what you finished today and shows your day in colour", () => {
    shutdown();
    const dialog = screen.getByRole("dialog", { name: "Shut down my day" });
    expect(within(dialog).getByText("Today you finished")).toBeInTheDocument();
    expect(within(dialog).getByText("1")).toBeInTheDocument();
    expect(within(dialog).getByRole("list", { name: "Finished today" })).toHaveTextContent("Finalise deck");
    expect(within(dialog).getByRole("img", { name: /^Your day in colour: Q3 Product Launch 1h 30m, Focus 25m/ })).toBeInTheDocument();
  });

  it("copies a plain-text summary", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    shutdown();
    fireEvent.click(screen.getByRole("button", { name: "Copy summary" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.calls[0][0]).toMatch(/^Shut down · .+\n\nFinished today \(1\)\n• Finalise deck/);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("ShutdownSheet — step 2, leftovers", () => {
  it("lists what's still on today: due today, planned or scheduled", () => {
    shutdown();
    next();
    expect(screen.getByRole("group", { name: "Where “Send the interview brief” goes" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Where “Draft the agenda” goes" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Where “Approve token naming” goes" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Where “Plan Q4 offsite” goes" })).toBeNull();
  });

  it("Tomorrow sets the due date to tomorrow and takes it off today's plan", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Draft the agenda", /^Tomorrow/));
    expect(props.onPatch).toHaveBeenCalledWith("Draft the agenda", { dueDate: tomorrow, planToday: false, scheduled: null });
    expect(chip("Draft the agenda", /^Tomorrow/)).toHaveAttribute("aria-pressed", "true");
  });

  it("Next week, Someday and Drop from today do what they say", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Send the interview brief", /^Next week/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Send the interview brief", { dueDate: nextWeekISO(today), planToday: false, scheduled: null });
    fireEvent.click(chip("Send the interview brief", /^Someday/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Send the interview brief", { dueDate: undefined, planToday: false, scheduled: null });
    // "Drop from today" is only offered for planned work (a due date stays due)
    expect(within(screen.getByRole("group", { name: "Where “Send the interview brief” goes" })).queryByRole("button", { name: /Drop from today/ })).toBeNull();
    fireEvent.click(chip("Draft the agenda", /Drop from today/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Draft the agenda", { planToday: false, scheduled: null });
  });

  it("never pulls a deadline earlier: a task due later is only taken off today's plan", () => {
    const { props } = shutdown();
    next();
    const group = screen.getByRole("group", { name: "Where “Approve token naming” goes" });
    expect(within(group).queryByRole("button", { name: /^Tomorrow/ })).toBeNull();
    expect(within(group).queryByRole("button", { name: /^Next week/ })).toBeNull();
    fireEvent.click(chip("Approve token naming", /Drop from today/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Approve token naming", { planToday: false, scheduled: null });
  });

  it("a planned task that's also due today can't be dropped (it would still be on today)", () => {
    shutdown({ tasks: [task("Due and planned", { dueDate: today, planToday: true, scheduled: 600 })] });
    next();
    const group = screen.getByRole("group", { name: "Where “Due and planned” goes" });
    expect(within(group).queryByRole("button", { name: /Drop from today/ })).toBeNull();
    expect(within(group).getByRole("button", { name: /^Tomorrow/ })).toBeInTheDocument();
  });

  it("choosing the same place again puts the task back as it was", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Draft the agenda", /^Tomorrow/));
    fireEvent.click(chip("Draft the agenda", /^Tomorrow/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Draft the agenda", { dueDate: undefined, planToday: true, scheduled: 540 });
    expect(chip("Draft the agenda", /^Tomorrow/)).toHaveAttribute("aria-pressed", "false");
  });

  it("'Move all to tomorrow' moves every leftover it can, and never pulls a deadline earlier", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Move all to tomorrow" }));
    const toTomorrow = { dueDate: tomorrow, planToday: false, scheduled: null };
    expect(props.onPatch).toHaveBeenCalledWith("Send the interview brief", toTomorrow);
    expect(props.onPatch).toHaveBeenCalledWith("Draft the agenda", toTomorrow);
    expect(props.onPatch).toHaveBeenCalledWith("Approve token naming", { planToday: false, scheduled: null });
    expect(props.onPatch).toHaveBeenCalledTimes(3);
    expect(screen.getByRole("button", { name: "All moved off today" })).toBeDisabled();
  });

  it("with nothing left over, says so", () => {
    shutdown({ tasks: [TASKS[0], TASKS[4]] });
    next();
    expect(screen.getByText("Nothing left over")).toBeInTheDocument();
  });
});

describe("ShutdownSheet — a teammate's task is never re-dated", () => {
  const withShared = [...TASKS, ...SHARED];

  it("offers only Drop from today on a task you collaborate on, and it patches no due date", () => {
    const { props } = shutdown({ tasks: withShared, allTasks: withShared });
    next();
    const group = screen.getByRole("group", { name: "Where “Review Maya's copy” goes" });
    expect(within(group).getAllByRole("button").map((b) => b.textContent)).toEqual(["Drop from today"]);
    expect(group).toHaveTextContent("Maya's task: its date stays");
    fireEvent.click(chip("Review Maya's copy", /Drop from today/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Review Maya's copy", { planToday: false, scheduled: null });
    // and putting it back only restores your own plan
    fireEvent.click(chip("Review Maya's copy", /Drop from today/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Review Maya's copy", { planToday: true, scheduled: 660 });
  });

  it("a teammate's task due today has no choices: its date is theirs", () => {
    shutdown({ tasks: withShared, allTasks: withShared });
    next();
    expect(screen.queryByRole("group", { name: "Where “Launch checklist” goes" })).toBeNull();
    expect(screen.getByText("Maya's task, due today. Its date is theirs to move.")).toBeInTheDocument();
    expect(screen.getByText("Due dates only move later, and only on tasks assigned to you.")).toBeInTheDocument();
  });

  it("'Move all to tomorrow' never sends a due date for a teammate's task", () => {
    const { props, onPatch } = shutdown({ tasks: withShared, allTasks: withShared });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Move all to tomorrow" }));
    const calls = onPatch.mock.calls as [string, Partial<Task>][];
    for (const [id, patch] of calls.filter(([id]) => id === "Review Maya's copy" || id === "Launch checklist")) {
      expect({ id, hasDue: "dueDate" in patch }).toEqual({ id, hasDue: false });
    }
    expect(calls.map(([id]) => id)).not.toContain("Launch checklist");
    expect(props.onPatch).toHaveBeenCalledWith("Review Maya's copy", { planToday: false, scheduled: null });
  });

  it("its Undo puts back your plan and leaves the teammate's date alone", () => {
    const { onPatch } = shutdown({ tasks: withShared, allTasks: withShared });
    next();
    fireEvent.click(screen.getByRole("button", { name: "Move all to tomorrow" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    onPatch.mockClear();
    undoLast();
    expect(onPatch).toHaveBeenCalledWith("Review Maya's copy", { planToday: true, scheduled: 660 });
  });
});

describe("ShutdownSheet — guests", () => {
  it("lists the leftovers but offers no moves, and never patches", () => {
    const { onPatch } = shutdown({ readOnly: true });
    next();
    expect(screen.getByText("Still on today. You're a guest in this workspace, so they stay as they are.")).toBeInTheDocument();
    expect(screen.getByText("Send the interview brief")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: /^Where “/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move all to tomorrow" })).toBeNull();
    next(); fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.getByRole("heading", { name: "Done for today. 1 finished." })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(undoLast()).toBeNull();
  });

  it("can still post a blocker (guests can comment)", async () => {
    const { props } = shutdown({ readOnly: true });
    next(); next();
    fireEvent.change(screen.getByLabelText("What's blocking you?"), { target: { value: "No access to the brand files" } });
    fireEvent.click(screen.getByRole("button", { name: /Post blocker/ }));
    await waitFor(() => expect(props.onComment).toHaveBeenCalledWith("Send the interview brief", "Blocked: No access to the brand files"));
  });
});

describe("ShutdownSheet — step 3, blockers", () => {
  it("posts the blocker as a comment on the chosen task", async () => {
    const { props } = shutdown();
    next(); next();
    expect(screen.getByRole("button", { name: /Post blocker/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Post it on"), { target: { value: "Draft the agenda" } });
    fireEvent.change(screen.getByLabelText("What's blocking you?"), { target: { value: "Waiting on the candidate list from Theo" } });
    fireEvent.click(screen.getByRole("button", { name: /Post blocker/ }));
    await waitFor(() => expect(props.onComment).toHaveBeenCalledWith("Draft the agenda", "Blocked: Waiting on the candidate list from Theo"));
    expect(await screen.findByText(/Your blocker is on “Draft the agenda”/)).toBeInTheDocument();
  });

  it("the task is optional: it's the first leftover unless you pick another", async () => {
    const { props } = shutdown();
    next(); next();
    expect(screen.getByLabelText("Post it on")).toHaveValue("Send the interview brief");
    fireEvent.change(screen.getByLabelText("What's blocking you?"), { target: { value: "Stuck on the rota" } });
    fireEvent.click(screen.getByRole("button", { name: /Post blocker/ }));
    await waitFor(() => expect(props.onComment).toHaveBeenCalledWith("Send the interview brief", "Blocked: Stuck on the rota"));
  });

  it("a post that fails keeps what you wrote", async () => {
    shutdown({ onComment: vi.fn().mockResolvedValue(null) });
    next(); next();
    fireEvent.change(screen.getByLabelText("What's blocking you?"), { target: { value: "Stuck" } });
    fireEvent.click(screen.getByRole("button", { name: /Post blocker/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't post that");
    expect(screen.getByLabelText("What's blocking you?")).toHaveValue("Stuck");
  });

  it("can be skipped", () => {
    const { props } = shutdown();
    next(); next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(props.onComment).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent(/^Done for today/);
  });
});

describe("ShutdownSheet — close", () => {
  it("counts correctly, records the day, and offers one Undo for every move", () => {
    const { props, onPatch } = shutdown();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Move all to tomorrow" }));
    next();
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    // a heading on the page, announced through the sheet's live region; focus waits on Done
    expect(screen.getByRole("heading", { name: "Done for today. 1 finished, 2 moved to tomorrow, 1 taken off your plan." })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Done for today. 1 finished, 2 moved to tomorrow, 1 taken off your plan.");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Done" }));
    expect(shutdownDone("me")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalled();
    onPatch.mockClear();
    expect(undoLast()).toMatch(/moved 3 tasks/);
    expect(onPatch).toHaveBeenCalledWith("Send the interview brief", { dueDate: today, planToday: false, scheduled: null });
    expect(onPatch).toHaveBeenCalledWith("Draft the agenda", { dueDate: undefined, planToday: true, scheduled: 540 });
    expect(onPatch).toHaveBeenCalledWith("Approve token naming", { dueDate: later, planToday: true, scheduled: 600 });
    expect(undoLast()).toBeNull();                                   // one Undo, run once
  });

  it("closing early still offers the Undo, but doesn't count as shut down", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Send the interview brief", /^Tomorrow/));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));   // the sheet's ×
    expect(props.onClose).toHaveBeenCalled();
    expect(shutdownDone("me")).toBe(false);
    expect(undoLast()).toMatch(/moved 1 task/);
  });

  it("renders nothing when closed", () => {
    shutdown({ open: false });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("WeeklyReview", () => {
  const week = isoWeek(new Date(reviewWeek(today).plan + "T00:00:00"));
  const WEEK_TASKS: Task[] = [
    task("Shipped the deck", { status: "done", completedAt: now }),
    task("Overdue review", { dueDate: addDaysISO(today, -3) }),
    task("Big launch", { priority: "urgent", dueDate: addDaysISO(today, 7) }),
    task("Pricing FAQ", { priority: "high" }),
    task("Renew passport", { priority: "low", dueDate: addDaysISO(today, 20) }),
  ];
  function review(extra: Partial<Parameters<typeof WeeklyReview>[0]> = {}) {
    const props = { open: true, onClose: vi.fn(), tasks: WEEK_TASKS, allTasks: WEEK_TASKS, currentUserId: "me", onPatch: vi.fn(), ...extra };
    return { ...render(<WeeklyReview {...props} />), props };
  }

  it("walks wins → carried over → Big 3 → share, and saves next week's Big 3", () => {
    const { props } = review();
    expect(screen.getByText("Shipped the deck")).toBeInTheDocument();
    next();
    // carried over: re-date the overdue one to next Monday
    const row = screen.getByRole("checkbox", { name: "Overdue review" });
    fireEvent.click(row);
    fireEvent.click(screen.getByRole("button", { name: /Move to Mon/ }));
    expect(props.onPatch).toHaveBeenCalledWith("Overdue review", { dueDate: reviewWeek(today).plan, planToday: false, scheduled: null });
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "Big launch" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pricing FAQ" }));
    expect(readBig3("me", week)).toEqual(["Big launch", "Pricing FAQ"]);
    next();
    expect(screen.getByRole("button", { name: /Copy summary/ })).toBeInTheDocument();
  });

  it("only your own tasks carry over: a teammate's due date is theirs", () => {
    const theirs = task("Maya's overdue deck", { assigneeId: "m-1", collaborators: ["me"], dueDate: addDaysISO(today, -3) });
    review({ tasks: [...WEEK_TASKS, theirs], allTasks: [...WEEK_TASKS, theirs] });
    next();
    expect(screen.getByRole("checkbox", { name: "Overdue review" })).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Maya's overdue deck" })).toBeNull();
  });

  it("guests see what carried over but can't re-date it", () => {
    const { props } = review({ readOnly: true });
    next();
    expect(screen.getByText("Overdue review")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Overdue review" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Move to/ })).toBeNull();
    expect(screen.getByText(/You're a guest in this workspace, so their dates stay as they are\./)).toBeInTheDocument();
    next(); next();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onPatch).not.toHaveBeenCalled();
  });

  it("a saved pick is always shown (first) so it can be cleared; a finished one no longer counts", () => {
    // twelve urgent tasks due this week would push a low-priority pick out of the list
    const busy = Array.from({ length: 12 }, (_, i) => task(`Urgent ${i + 1}`, { priority: "urgent", dueDate: today }));
    const quiet = task("Tidy the drive", { priority: "low" });
    const finished = task("Ship v2", { status: "done", completedAt: now });
    const all = [...WEEK_TASKS, ...busy, quiet, finished];
    writeBig3("me", ["Ship v2", "Tidy the drive"], week);
    review({ tasks: all, allTasks: all });
    next(); next();
    const picks = within(screen.getByRole("list", { name: "Candidates" })).getAllByRole("checkbox");
    expect(picks[0]).toHaveAccessibleName("Tidy the drive");
    expect(picks[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("checkbox", { name: "Ship v2" })).toBeNull();
    expect(screen.getByText(/^1 of 3 picked/)).toBeInTheDocument();
    fireEvent.click(picks[0]);
    expect(readBig3("me", week)).toEqual([]);
    expect(screen.getByText("None picked yet")).toBeInTheDocument();
  });

  it("allows three picks at most", () => {
    const extra = [task("Fourth"), task("Fifth")];
    review({ tasks: [...WEEK_TASKS, ...extra], allTasks: [...WEEK_TASKS, ...extra] });
    next(); next();
    for (const name of ["Big launch", "Pricing FAQ", "Renew passport"]) fireEvent.click(screen.getByRole("checkbox", { name }));
    expect(screen.getByRole("checkbox", { name: "Fourth" })).toBeDisabled();
  });

  it("uses Kanbo's summary when one is offered", async () => {
    review({ onSummarise: vi.fn().mockResolvedValue("A strong week: the deck shipped.") });
    fireEvent.click(screen.getByRole("button", { name: /Summarise my week/ }));
    expect(await screen.findByText("A strong week: the deck shipped.")).toBeInTheDocument();
    // "How I got here" opens onto the facts it was written from
    fireEvent.click(screen.getByRole("button", { name: /How I got here/ }));
    expect(screen.getByText("Finished: Shipped the deck")).toBeVisible();
  });
});
