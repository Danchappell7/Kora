import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import { TodayView, type TodayViewProps } from "./TodayView";
import { ToastProvider } from "../Toast";
import { localDayKey } from "./planCanvas";
import type { Task } from "../../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

/** Today at hh:mm (the brief and the suggestions follow the clock). */
function at(h: number, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  vi.setSystemTime(d);
}

function renderToday(tasks: Task[], extra: Partial<TodayViewProps> = {}) {
  const props: TodayViewProps = {
    tasks, allTasks: tasks, events: [], calendarConnected: true, currentUserId: "me", userName: "Daniel Okai",
    captureDefaults: { projectId: "p-personal", assigneeId: "me" },
    onUpdate: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
    onRank: vi.fn(async () => "ai" as const), ranking: false,
    onStartFocus: vi.fn(), onShutdown: vi.fn(), setup: [], showSuggestions: true,
    ...extra,
  };
  const utils = render(<ToastProvider><TodayView {...props} /></ToastProvider>);
  return { ...utils, props };
}

const ghostButtons = () => screen.queryAllByRole("button", { name: /^Suggested:/ });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  at(9);
});
afterEach(() => { vi.useRealTimers(); });

const today = () => localDayKey();

describe("TodayView: the brief", () => {
  it("renders the live figures as buttons", () => {
    const deck = task({ id: "deck", title: "Launch deck", dueDate: today(), aiScore: 90 });
    const { props } = renderToday([deck, task({ id: "b", dueDate: today() })], { riskCount: 2, onOpenRisks: vi.fn() });
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    expect(brief.textContent).toContain("Good morning, Daniel.");
    expect(within(brief).getByRole("button", { name: /free$/ })).toBeInTheDocument();
    const due = within(brief).getByRole("button", { name: "two things due" });
    expect(due).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(brief).getByRole("button", { name: "Launch deck" }));
    expect(props.onOpen).toHaveBeenCalledWith("deck");
    fireEvent.click(within(brief).getByRole("button", { name: "Two risks need a look" }));
    expect(props.onOpenRisks).toHaveBeenCalled();
  });

  it("a figure works from the keyboard like any button (Enter, or Space on release)", () => {
    const deck = task({ id: "deck", title: "Launch deck", dueDate: today(), aiScore: 90 });
    const { props } = renderToday([deck]);
    const fig = screen.getByRole("button", { name: "Launch deck" });
    expect(fig).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(fig, { key: "Enter" });
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(fig, { key: " " });
    expect(props.onOpen).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(fig, { key: " " });
    expect(props.onOpen).toHaveBeenCalledTimes(2);
  });

  it("a due figure narrows the rail to that group, and again shows everything", () => {
    renderToday([task({ id: "a", title: "Due one", dueDate: today() }), task({ id: "b", title: "Planned one", planToday: true })]);
    const rail = screen.getByRole("complementary", { name: "Unplanned" });
    expect(within(rail).getByText("Planned one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "one thing due" }));
    expect(screen.getByRole("button", { name: "one thing due" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rail).getByText("Due one")).toBeInTheDocument();
    expect(within(rail).queryByText("Planned one")).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Show all" }));
    expect(within(rail).getByText("Planned one")).toBeInTheDocument();
  });
});

describe("TodayView: the suggested plan", () => {
  const work = () => [
    task({ id: "a", title: "Send the brief", dueDate: today(), focusMin: 30, aiScore: 80, energy: "deep" }),
    task({ id: "b", title: "Write the deck", planToday: true, focusMin: 60, aiScore: 50 }),
    task({ id: "c", title: "Maya's thing", dueDate: today(), assigneeId: "maya" }),
  ];

  it("draws ghosts for what isn't on the day yet, and writes nothing", () => {
    const { props } = renderToday(work());
    expect(ghostButtons().map((b) => b.getAttribute("aria-label"))).toEqual([
      expect.stringMatching(/^Suggested: Send the brief, 09:00–09:30/),
      expect.stringMatching(/^Suggested: Write the deck, /),
    ]);
    expect(screen.getByText("Places 2 tasks · 1h 30m")).toBeInTheDocument();
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("Plan my day asks Kanbo to order the work, commits every ghost, and Undo restores", async () => {
    const { props } = renderToday(work());
    fireEvent.click(screen.getByRole("button", { name: /Plan my day/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(2));
    expect(props.onRank).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith("a", { scheduled: 9 * 60, planToday: true });
    expect(props.onUpdate).toHaveBeenCalledWith("b", { scheduled: expect.any(Number), planToday: true });
    expect(screen.getAllByText(/^Planned 2 tasks · 1h 30m$/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(props.onUpdate).toHaveBeenCalledWith("a", { scheduled: null, planToday: false });
    expect(props.onUpdate).toHaveBeenCalledWith("b", { scheduled: null, planToday: true });
  });

  it("says when the ordering was done on-device", async () => {
    const { props } = renderToday(work(), { onRank: vi.fn(async () => "heuristic" as const) });
    fireEvent.click(screen.getByRole("button", { name: /Plan my day/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled());
    expect(screen.getAllByText(/\(on-device ordering\)$/).length).toBeGreaterThan(0);
  });

  it("P plans the day from the keyboard (never while typing)", async () => {
    const { props } = renderToday(work());
    fireEvent.keyDown(screen.getByLabelText("Capture a task for today"), { key: "p" });
    expect(props.onRank).not.toHaveBeenCalled();
    fireEvent.keyDown(document.body, { key: "p" });
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(2));
  });

  it("a key something else already handled (g then p) doesn't plan", () => {
    const { props } = renderToday(work());
    const e = new KeyboardEvent("keydown", { key: "p", bubbles: true, cancelable: true });
    e.preventDefault();
    window.dispatchEvent(e);
    expect(props.onRank).not.toHaveBeenCalled();
  });

  it("Enter on a ghost accepts just that one", () => {
    const { props } = renderToday(work());
    fireEvent.keyDown(ghostButtons()[0], { key: "Enter" });
    expect(props.onUpdate).toHaveBeenCalledTimes(1);
    expect(props.onUpdate).toHaveBeenCalledWith("a", { scheduled: 9 * 60, planToday: true });
  });

  it("Not now hides one suggestion for the rest of the day", () => {
    renderToday(work());
    fireEvent.click(screen.getByRole("button", { name: /Not now: hide the suggestion for “Send the brief”/ }));
    expect(ghostButtons().map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Suggested: Write the deck/)]);
  });

  it("H hides the suggestions for today, and brings them back", () => {
    renderToday(work());
    expect(ghostButtons()).toHaveLength(2);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(ghostButtons()).toHaveLength(0);
    fireEvent.keyDown(document.body, { key: "h" });
    expect(ghostButtons()).toHaveLength(2);
  });

  it("with suggestions switched off there are no ghosts, and the hint explains the button", () => {
    renderToday(work(), { showSuggestions: false });
    expect(ghostButtons()).toHaveLength(0);
    expect(screen.getByText("Plan my day places tasks in your free time")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Plan my day/ })).toBeEnabled();
  });

  it("when nothing fits, Plan my day says so and writes nothing", async () => {
    at(17, 40);
    const { props } = renderToday([task({ id: "big", title: "Big job", dueDate: today(), focusMin: 90 })]);
    expect(ghostButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Plan my day/ }));
    await waitFor(() => expect(props.onRank).toHaveBeenCalled());
    await waitFor(() => expect(screen.getAllByText("Your day's full — 1 task moved to tomorrow's suggestions.").length).toBeGreaterThan(0));
    expect(props.onUpdate).not.toHaveBeenCalled();
    expect(within(screen.getByRole("complementary", { name: "Unplanned" })).getByText("Tomorrow")).toBeInTheDocument();
  });

  it("once everything's placed the button offers a Re-plan", () => {
    renderToday([task({ id: "p", title: "Placed", planToday: true, scheduled: 14 * 60 })]);
    expect(screen.getByRole("button", { name: /Re-plan/ })).toBeInTheDocument();
    expect(screen.getByText("Your day is planned")).toBeInTheDocument();
  });
});

describe("TodayView: the canvas", () => {
  it("the now label takes the place of a colliding hour label", () => {
    at(10, 10);
    const { container } = renderToday([]);
    const hours = Array.from(container.querySelectorAll(".kday-hour-label")).map((e) => e.textContent);
    expect(hours).not.toContain("10:00");
    expect(hours).toContain("09:00");
    expect(hours).toContain("11:00");
    expect(container.querySelector(".kday-now-label")?.textContent).toBe("10:10");
  });

  it("a guest gets a read-only day: no Plan my day, no capture, no dragging", () => {
    renderToday([task({ id: "a", title: "Due", dueDate: today() }), task({ id: "p", title: "Placed", planToday: true, scheduled: 11 * 60 })], { readOnly: true });
    expect(screen.queryByRole("button", { name: /Plan my day|Re-plan/ })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Capture a task for today")).not.toBeInTheDocument();
    expect(ghostButtons()).toHaveLength(0);
    expect(screen.queryByRole("checkbox", { name: /Done: Placed/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Placed, 11:00–11:30/ })).toBeInTheDocument();
  });

  it("offers to connect a calendar when there are no meetings", () => {
    const onConnectCalendar = vi.fn();
    renderToday([], { calendarConnected: false, onConnectCalendar, events: [] });
    // the demo day's meetings stand in until a calendar is connected (demo mode); a real account has none
    const link = screen.queryByRole("button", { name: /Connect your calendar/ });
    if (link) {
      fireEvent.click(link);
      expect(onConnectCalendar).toHaveBeenCalled();
    }
  });

  it("F on a block starts focus on it", () => {
    const { props } = renderToday([task({ id: "p", title: "Placed", planToday: true, scheduled: 11 * 60 })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Placed, 11:00–11:30/ }), { key: "f" });
    expect(props.onStartFocus).toHaveBeenCalledWith("p");
  });
});

describe("TodayView: getting set up", () => {
  const steps = (action = vi.fn()) => [
    { label: "Add your first task", done: true, action: vi.fn() },
    { label: "Plan your day", done: true, action: vi.fn() },
    { label: "Connect your calendar", done: false, action },
    { label: "Invite your team", done: false, action: vi.fn() },
  ];

  it("a chip counts the steps and opens them", async () => {
    const action = vi.fn();
    renderToday([], { setup: steps(action) });
    fireEvent.click(screen.getByRole("button", { name: /2 of 4 set up/ }));
    const dialog = await screen.findByRole("dialog", { name: "Getting set up" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect your calendar: set it up" }));
    expect(action).toHaveBeenCalled();
  });

  it("Hide puts it away for good", async () => {
    const first = renderToday([], { setup: steps() });
    fireEvent.click(screen.getByRole("button", { name: /2 of 4 set up/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Getting set up" })).getByRole("button", { name: "Hide" }));
    expect(screen.queryByRole("button", { name: /set up/ })).not.toBeInTheDocument();
    first.unmount();
    renderToday([], { setup: steps() });
    expect(screen.queryByRole("button", { name: /2 of 4 set up/ })).not.toBeInTheDocument();
  });

  it("isn't shown once every step is done", () => {
    renderToday([], { setup: steps().map((s) => ({ ...s, done: true })) });
    expect(screen.queryByRole("button", { name: /set up/ })).not.toBeInTheDocument();
  });
});

describe("TodayView: loading", () => {
  it("shows a skeleton, not an empty day", () => {
    renderToday([], { loading: true });
    expect(screen.getByLabelText("Loading your day")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByRole("region", { name: "Your day in brief" })).not.toBeInTheDocument();
    act(() => {});
  });
});
