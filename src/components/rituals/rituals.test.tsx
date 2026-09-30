import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { ShutdownSheet } from "./ShutdownSheet";
import { WeeklyReview } from "./WeeklyReview";
import { todayISO } from "../../data/data";
import type { Task } from "../../data/types";
import { addDaysISO, isoWeek, nextMondayISO, readBig3, shutdownDone } from "../../lib/rituals";
import { clearUndo, undoLast } from "../../lib/undoStack";

const today = todayISO();
const tomorrow = addDaysISO(today, 1);
const now = new Date().toISOString();
const task = (id: string, extra: Partial<Task> = {}): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...extra,
});

const TASKS: Task[] = [
  task("Finalise deck", { status: "done", completedAt: now, dur: 90 }),
  task("Send the interview brief", { dueDate: today }),
  task("Approve token naming", { planToday: true, scheduled: 600, dueDate: addDaysISO(today, 3) }),
  task("Plan Q4 offsite"),                                          // not on today
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
    expect(screen.getByRole("group", { name: "Where “Approve token naming” goes" })).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Where “Plan Q4 offsite” goes" })).toBeNull();
  });

  it("Tomorrow sets the due date to tomorrow and takes it off today's plan", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Approve token naming", /^Tomorrow/));
    expect(props.onPatch).toHaveBeenCalledWith("Approve token naming", { dueDate: tomorrow, planToday: false, scheduled: null });
    expect(chip("Approve token naming", /^Tomorrow/)).toHaveAttribute("aria-pressed", "true");
  });

  it("Next week, Someday and Drop from today do what they say", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Send the interview brief", /^Next week/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Send the interview brief", { dueDate: nextMondayISO(today), planToday: false, scheduled: null });
    fireEvent.click(chip("Send the interview brief", /^Someday/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Send the interview brief", { dueDate: undefined, planToday: false, scheduled: null });
    // "Drop from today" is only offered for planned work (a due date stays due)
    expect(within(screen.getByRole("group", { name: "Where “Send the interview brief” goes" })).queryByRole("button", { name: /Drop from today/ })).toBeNull();
    fireEvent.click(chip("Approve token naming", /Drop from today/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Approve token naming", { planToday: false, scheduled: null });
  });

  it("choosing the same place again puts the task back as it was", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(chip("Approve token naming", /^Tomorrow/));
    fireEvent.click(chip("Approve token naming", /^Tomorrow/));
    expect(props.onPatch).toHaveBeenLastCalledWith("Approve token naming", { dueDate: addDaysISO(today, 3), planToday: true, scheduled: 600 });
    expect(chip("Approve token naming", /^Tomorrow/)).toHaveAttribute("aria-pressed", "false");
  });

  it("'Move all to tomorrow' moves every leftover", () => {
    const { props } = shutdown();
    next();
    fireEvent.click(screen.getByRole("button", { name: "Move all to tomorrow" }));
    const patch = { dueDate: tomorrow, planToday: false, scheduled: null };
    expect(props.onPatch).toHaveBeenCalledWith("Send the interview brief", patch);
    expect(props.onPatch).toHaveBeenCalledWith("Approve token naming", patch);
    expect(props.onPatch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "All moved to tomorrow" })).toBeDisabled();
  });

  it("with nothing left over, says so", () => {
    shutdown({ tasks: [TASKS[0], TASKS[3]] });
    next();
    expect(screen.getByText("Nothing left over")).toBeInTheDocument();
  });
});

describe("ShutdownSheet — step 3, blockers", () => {
  it("posts the blocker as a comment on the chosen task", async () => {
    const { props } = shutdown();
    next(); next();
    expect(screen.getByRole("button", { name: /Post blocker/ })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Send the interview brief" } });
    fireEvent.change(screen.getByLabelText("What's blocking you?"), { target: { value: "Waiting on the candidate list from Theo" } });
    fireEvent.click(screen.getByRole("button", { name: /Post blocker/ }));
    await waitFor(() => expect(props.onComment).toHaveBeenCalledWith("Send the interview brief", "Blocked: Waiting on the candidate list from Theo"));
    expect(await screen.findByText(/Your blocker is on “Send the interview brief”/)).toBeInTheDocument();
  });

  it("a post that fails keeps what you wrote", async () => {
    shutdown({ onComment: vi.fn().mockResolvedValue(null) });
    next(); next();
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: "Send the interview brief" } });
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
    expect(screen.getByRole("status")).toHaveTextContent("Done for today. 1 finished, 2 moved to tomorrow.");
    expect(shutdownDone("me")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(props.onClose).toHaveBeenCalled();
    onPatch.mockClear();
    expect(undoLast()).toMatch(/moved 2 tasks/);
    expect(onPatch).toHaveBeenCalledWith("Send the interview brief", { dueDate: today, planToday: false, scheduled: null });
    expect(onPatch).toHaveBeenCalledWith("Approve token naming", { dueDate: addDaysISO(today, 3), planToday: true, scheduled: 600 });
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
  const week = isoWeek(new Date(new Date(nextMondayISO(today) + "T00:00:00")));
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
    expect(props.onPatch).toHaveBeenCalledWith("Overdue review", { dueDate: nextMondayISO(today), planToday: false, scheduled: null });
    next();
    fireEvent.click(screen.getByRole("checkbox", { name: "Big launch" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pricing FAQ" }));
    expect(readBig3("me", week)).toEqual(["Big launch", "Pricing FAQ"]);
    next();
    expect(screen.getByRole("button", { name: /Copy summary/ })).toBeInTheDocument();
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
  });
});
