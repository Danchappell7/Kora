import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act, within, waitFor } from "@testing-library/react";
import { TodayView, type TodayViewProps } from "./TodayView";
import { ToastProvider } from "../Toast";
import { ghostPrefsKey, localDayKey } from "./planCanvas";
import { EVENTS, setReferenceData } from "../../data/data";
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

/** Today at hh:mm as an ISO datetime (a connected calendar's event times). */
function isoAt(h: number, m = 0) {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.toISOString();
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
  it("speaks first: the greeting, the day's one big thing (it opens the task), why, and the day in numbers", () => {
    const deck = task({ id: "deck", title: "Launch deck", dueDate: today(), aiScore: 90 });
    const { props } = renderToday([deck, task({ id: "b", dueDate: today() })], { riskCount: 2, onOpenRisks: vi.fn() });
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    const head = within(brief).getByRole("heading", { level: 2 });
    expect(head.textContent).toBe("Morning, Daniel. One big thing today: launch deck.");
    expect(within(brief).getByText(/Kanbo/, { selector: ".kbrief-who" })).toBeInTheDocument();
    expect(within(brief).getByText("09:00")).toBeInTheDocument();                                     // when it was written
    expect(within(brief).getByRole("button", { name: /free$/ })).toBeInTheDocument();
    const due = within(brief).getByRole("button", { name: "2 due today" });
    expect(due).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(within(head).getByRole("button", { name: "launch deck" }));
    expect(props.onOpen).toHaveBeenCalledWith("deck");
    fireEvent.click(within(brief).getByRole("button", { name: "Two risks need a look" }));
    expect(props.onOpenRisks).toHaveBeenCalled();
  });

  it("the focus phrase is a real button (keyboard for free), and keeps its full stop in its gradient", () => {
    renderToday([task({ id: "deck", title: "Launch deck", dueDate: today(), aiScore: 90 })]);
    const focus = screen.getByRole("button", { name: "launch deck" });
    expect(focus.tagName).toBe("BUTTON");
    expect(focus).toHaveClass("kbrief-focus");
    expect(focus.textContent).toBe("launch deck.");
  });

  it("How I got here opens the facts the brief was built from", async () => {
    renderToday([task({ id: "deck", title: "Launch deck", dueDate: today(), dueTime: "17:00", aiScore: 90 })]);
    const how = screen.getByRole("button", { name: "How I got here" });
    expect(how).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(how);
    expect(how).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Due today")).toBeInTheDocument();
    expect(screen.getByText("Launch deck (17:00)")).toBeInTheDocument();
    expect(screen.getByText("Your calendar")).toBeInTheDocument();
    expect(screen.getByText(/Nothing changes until you say so/)).toBeInTheDocument();
  });

  it("Just show me the list goes to My tasks, and the Ask hint opens Kanbo", () => {
    const onOpenMyTasks = vi.fn(), onAsk = vi.fn();
    renderToday([task({ id: "a", dueDate: today() })], { onOpenMyTasks, onAsk });
    fireEvent.click(screen.getByRole("button", { name: "Just show me the list" }));
    expect(onOpenMyTasks).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /tell Kanbo what's different today/ }));
    expect(onAsk).toHaveBeenCalled();
  });

  it("a number narrows the rail to that group, and again shows everything", () => {
    renderToday([task({ id: "a", title: "Due one", dueDate: today() }), task({ id: "b", title: "Planned one", planToday: true })]);
    const rail = screen.getByRole("complementary", { name: "Unplanned" });
    expect(within(rail).getByText("Planned one")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 due today" }));
    expect(screen.getByRole("button", { name: "1 due today" })).toHaveAttribute("aria-pressed", "true");
    expect(within(rail).getByText("Due one")).toBeInTheDocument();
    expect(within(rail).queryByText("Planned one")).not.toBeInTheDocument();
    fireEvent.click(within(rail).getByRole("button", { name: "Show all" }));
    expect(within(rail).getByText("Planned one")).toBeInTheDocument();
  });

  it("slipping and new-from-the-team narrow the rail too", () => {
    renderToday([
      task({ id: "s", title: "Moved on", dueDate: today(), originalDueDate: "2020-01-01" }),
      task({ id: "t", title: "From Maya", createdBy: "maya", createdAt: new Date().toISOString() }),
      task({ id: "o", title: "Other", planToday: true }),
    ]);
    const rail = screen.getByRole("complementary", { name: "Unplanned" });
    fireEvent.click(screen.getByRole("button", { name: "1 slipping" }));
    expect(within(rail).getByText("Showing what's slipping")).toBeInTheDocument();
    expect(within(rail).getByText("Moved on")).toBeInTheDocument();
    expect(within(rail).queryByText("Other")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "1 new from the team" }));
    expect(within(rail).getByText("From Maya")).toBeInTheDocument();
    expect(within(rail).queryByText("Moved on")).not.toBeInTheDocument();
  });

  it("an empty day asks whether to pull something forward", () => {
    renderToday([task({ id: "n", title: "Next week's thing", dueDate: "2999-01-01" })]);
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    expect(within(brief).getByRole("heading", { level: 2 }).textContent).toBe("Morning, Daniel. A clear day. Want to pull something forward?");
    expect(screen.getByRole("button", { name: /Plan my day/ })).toBeDisabled();
  });
});

describe("TodayView: Kanbo noticed", () => {
  const blockedOnMe = () => [
    task({ id: "mine", title: "Review tokens", status: "review", dueDate: today(), focusMin: 20 }),
    task({ id: "theirs", title: "Ship onboarding", assigneeId: "maya", status: "blocked", dependencies: ["mine"] }),
  ];

  it("names who's waiting on you, with an action and Not now (which lasts the day, with an Undo)", () => {
    const { props } = renderToday(blockedOnMe(), { members: [{ id: "me", name: "Daniel Okai" }, { id: "maya", name: "Maya Lin" }] });
    const card = screen.getByRole("region", { name: "Kanbo noticed" });
    expect(within(card).getByRole("heading", { name: "Maya is blocked on you" })).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: "Review it now" }));
    expect(props.onOpen).toHaveBeenCalledWith("mine");
    fireEvent.click(within(card).getByRole("button", { name: /^Not now: hide “Maya is blocked on you”/ }));
    expect(screen.queryByRole("region", { name: "Kanbo noticed" })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-noticed:me")!).ids).toEqual(["waiting:mine"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("region", { name: "Kanbo noticed" })).toBeInTheDocument();
  });

  it("stays away for the day once waved off (read back on the next visit)", () => {
    localStorage.setItem("kanbo-noticed:me", JSON.stringify({ day: today(), ids: ["waiting:mine"] }));
    renderToday(blockedOnMe(), { members: [{ id: "maya", name: "Maya Lin" }] });
    expect(screen.queryByRole("region", { name: "Kanbo noticed" })).not.toBeInTheDocument();
  });

  it("isn't shown to a guest", () => {
    renderToday(blockedOnMe(), { readOnly: true });
    expect(screen.queryByRole("region", { name: "Kanbo noticed" })).not.toBeInTheDocument();
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

  it("plans in the order Kanbo has just given, not the scores from before it ranked", async () => {
    const onUpdate = vi.fn();
    function Host() {
      const [ts, setTs] = useState(() => [
        task({ id: "x", title: "First by the old scores", dueDate: today(), aiScore: 80 }),
        task({ id: "y", title: "First by the new scores", dueDate: today(), aiScore: 20 }),
      ]);
      // like the real ranking: the new scores land after a round trip, not inside the click
      const onRank = async () => {
        await new Promise((r) => setTimeout(r, 0));
        setTs((p) => p.map((t) => ({ ...t, aiScore: t.id === "y" ? 90 : 10 })));
        return "ai" as const;
      };
      return (
        <ToastProvider>
          <TodayView tasks={ts} allTasks={ts} events={[]} calendarConnected currentUserId="me" captureDefaults={{ projectId: "p-personal", assigneeId: "me" }}
            onUpdate={onUpdate} onCreate={vi.fn()} onOpen={vi.fn()} onRank={onRank} ranking={false}
            onStartFocus={vi.fn()} onShutdown={vi.fn()} setup={[]} showSuggestions />
        </ToastProvider>
      );
    }
    render(<Host />);
    fireEvent.click(screen.getByRole("button", { name: /Plan my day/ }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const at = (id: string) => onUpdate.mock.calls.find(([i]) => i === id)![1].scheduled as number;
    expect(at("y")).toBeLessThan(at("x"));
  });

  it("says when the ordering was done on-device", async () => {
    const { props } = renderToday(work(), { onRank: vi.fn(async () => "heuristic" as const) });
    fireEvent.click(screen.getByRole("button", { name: /Plan my day/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled());
    expect(screen.getAllByText(/\(on.device ordering\)$/).length).toBeGreaterThan(0);
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
    // H can't bring back what Settings switched off: it says where the switch is
    fireEvent.keyDown(window, { key: "h" });
    expect(ghostButtons()).toHaveLength(0);
    expect(screen.getAllByText("Suggestions are switched off in Settings › Appearance.").length).toBeGreaterThan(0);
  });

  it("when nothing fits, Plan my day says so and writes nothing", async () => {
    at(17, 40);
    const { props } = renderToday([task({ id: "big", title: "Big job", dueDate: today(), focusMin: 90 })]);
    expect(ghostButtons()).toHaveLength(0);
    // there's free time, just not a piece big enough: the hint says so rather than "full"
    expect(screen.getByText("1 task won't fit today")).toBeInTheDocument();
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

  it("a day whose only block is under way still reads as planned, and Re-plan moves nothing", async () => {
    at(14, 12);
    const { props } = renderToday([task({ id: "now", title: "Under way", planToday: true, scheduled: 14 * 60, focusMin: 90 })]);
    const btn = screen.getByRole("button", { name: /Re-plan/ });
    expect(btn).toBeEnabled();
    expect(screen.getByText("Your day is planned")).toBeInTheDocument();
    fireEvent.click(btn);
    await waitFor(() => expect(screen.getAllByText("Your day is planned — nothing needed moving.").length).toBeGreaterThan(0));
    expect(props.onUpdate).not.toHaveBeenCalled();
  });

  it("Re-plan never double-books: a block that no longer fits comes off the day, and Undo puts it back", async () => {
    at(16);
    const meeting = { id: "m", title: "Board prep", start: isoAt(16), end: isoAt(17), allDay: false, provider: "google" };
    const a = task({ id: "A", title: "Tidy inbox", priority: "low", planToday: true, scheduled: 17 * 60, focusMin: 60 });
    const b = task({ id: "B", title: "Fix the outage", priority: "urgent", dueDate: today(), focusMin: 60 });
    const { props } = renderToday([a, b], { events: [meeting] });
    // B doesn't fit around A, so the hero offers to re-plan
    fireEvent.click(screen.getByRole("button", { name: /Re-plan/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(2));
    expect(props.onUpdate).toHaveBeenCalledWith("B", { scheduled: 17 * 60, planToday: true });
    expect(props.onUpdate).toHaveBeenCalledWith("A", { scheduled: null });
    expect(screen.getAllByText("Re-planned 1 task · 1h · 1 back to Unplanned").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(props.onUpdate).toHaveBeenCalledWith("B", { scheduled: null, planToday: false });
    expect(props.onUpdate).toHaveBeenCalledWith("A", { scheduled: 17 * 60, planToday: true });
  });

  it("a block waved away earlier and then put on the day is still re-laid (never left under another)", async () => {
    at(16);
    const meeting = { id: "m", title: "Board prep", start: isoAt(16), end: isoAt(17), allDay: false, provider: "google" };
    localStorage.setItem(ghostPrefsKey("me"), JSON.stringify({ day: today(), skipped: ["A"], hidden: false }));
    const a = task({ id: "A", title: "Tidy inbox", priority: "low", planToday: true, scheduled: 17 * 60, focusMin: 60 });
    const b = task({ id: "B", title: "Fix the outage", priority: "urgent", dueDate: today(), focusMin: 60 });
    const { props } = renderToday([a, b], { events: [meeting] });
    fireEvent.click(screen.getByRole("button", { name: /Re-plan/ }));
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledWith("A", { scheduled: null }));
    expect(props.onUpdate).toHaveBeenCalledWith("B", { scheduled: 17 * 60, planToday: true });
  });

  it("an empty day has nothing to plan", () => {
    renderToday([]);
    expect(screen.getByRole("button", { name: /Plan my day/ })).toBeDisabled();
    expect(screen.getByText("Nothing to place yet")).toBeInTheDocument();
  });

  it("while Kanbo orders the day the button says so, holding its place (both labels share one cell)", async () => {
    let release: (v: "ai") => void = () => {};
    const onRank = vi.fn(() => new Promise<"ai">((r) => { release = r; }));
    const { props } = renderToday(work(), { onRank });
    const btn = screen.getByRole("button", { name: /Plan my day/ });
    // the busy label is already there, hidden, so the button is as wide as it will be
    expect(within(btn).getByText("Ordering your day…")).toHaveAttribute("aria-hidden", "true");
    fireEvent.click(btn);
    await waitFor(() => expect(btn).toHaveAttribute("aria-busy", "true"));
    expect(btn).toHaveAccessibleName(/Ordering your day…/);
    expect(within(btn).getByText("Plan my day for me")).toHaveAttribute("aria-hidden", "true");
    await act(async () => { release("ai"); });
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalledTimes(2));
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

  it("a real account with no calendar connected is offered one; the demo day's meetings stand in for it", () => {
    const onConnectCalendar = vi.fn();
    const demo = EVENTS;
    // demo mode: its illustrative meetings fill the day, so there's nothing to connect
    const first = renderToday([], { calendarConnected: false, onConnectCalendar });
    expect(screen.queryByRole("button", { name: /Connect your calendar/ })).not.toBeInTheDocument();
    first.unmount();
    // a real account starts with no meetings at all
    setReferenceData({ events: [] });
    try {
      renderToday([], { calendarConnected: false, onConnectCalendar });
      fireEvent.click(screen.getByRole("button", { name: "Connect your calendar to see meetings here" }));
      expect(onConnectCalendar).toHaveBeenCalledTimes(1);
    } finally {
      setReferenceData({ events: demo });
    }
  });

  it("a connected calendar with a clear day doesn't ask to connect again", () => {
    renderToday([], { calendarConnected: true, onConnectCalendar: vi.fn(), events: [] });
    expect(screen.queryByRole("button", { name: /Connect your calendar/ })).not.toBeInTheDocument();
  });

  it("F on a block starts focus on it", () => {
    const { props } = renderToday([task({ id: "p", title: "Placed", planToday: true, scheduled: 11 * 60 })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Placed, 11:00–11:30/ }), { key: "f" });
    expect(props.onStartFocus).toHaveBeenCalledWith("p");
  });
});

describe("TodayView: the brief counts what the rail shows", () => {
  it("a collaborator's task and a subtask aren't in the figures, or the one to start with", () => {
    const mine = task({ id: "mine", title: "Mine due", dueDate: today(), aiScore: 10 });
    const collab = task({ id: "collab", title: "Collab due", dueDate: today(), assigneeId: "maya", collaborators: ["me"], aiScore: 90 });
    const sub = task({ id: "sub", title: "Subtask due", dueDate: today(), parentId: "mine", aiScore: 80 });
    renderToday([mine, collab, sub]);
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    expect(within(brief).getByRole("button", { name: "1 due today" })).toBeInTheDocument();
    expect(within(brief).getByRole("button", { name: "mine due" })).toBeInTheDocument();
    expect(ghostButtons().map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Suggested: Mine due/)]);
    fireEvent.click(within(brief).getByRole("button", { name: "1 due today" }));
    const rail = screen.getByRole("complementary", { name: "Unplanned" });
    expect(within(rail).getByText("Mine due")).toBeInTheDocument();
    expect(within(rail).queryByText("Collab due")).not.toBeInTheDocument();
  });

  it("narrowed to what's due, the rail says how much of it is already on the day", () => {
    renderToday([
      task({ id: "a", title: "Due, unplaced", dueDate: today() }),
      task({ id: "b", title: "Due, placed", dueDate: today(), planToday: true, scheduled: 14 * 60 }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "2 due today" }));
    expect(screen.getByText("Showing what's due today · 1 already on your day")).toBeInTheDocument();
  });
});

describe("TodayView: after the working day", () => {
  it("offers no suggestions and no plan, just the way to close the day", () => {
    at(19);
    const { props } = renderToday([task({ id: "d", title: "Due thing", dueDate: today() })]);
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    expect(within(brief).getByRole("heading", { level: 2 }).textContent).toBe("Evening, Daniel. The working day's done.");
    expect(brief.textContent).toContain("One thing is still open. Shut down to close the day and pick tomorrow's first thing.");
    // the day's grid folds away: tomorrow takes its place
    expect(screen.getByRole("region", { name: "Tomorrow" })).toHaveTextContent("Due thing");
    expect(screen.getByRole("button", { name: /^Today · 07:00–22:00/ })).toHaveAttribute("aria-expanded", "false");
    expect(ghostButtons()).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /Plan my day|Re-plan/ })).not.toBeInTheDocument();
    expect(screen.getByText("Tomorrow's plan starts at 08:00")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /no free time left/ }).getAttribute("aria-label")).not.toMatch(/suggestion/);
    // the rail marks it for tomorrow rather than suggesting an evening slot
    expect(within(screen.getByRole("complementary", { name: "Unplanned" })).getByText("Tomorrow")).toBeInTheDocument();
    // the hero closes the day (the rail's own link steps aside for it)
    const shut = screen.getAllByRole("button", { name: "Shut down my day" });
    expect(shut).toHaveLength(1);
    fireEvent.click(shut[0]);
    expect(props.onShutdown).toHaveBeenCalledTimes(1);
    // P explains rather than planning into the evening
    fireEvent.keyDown(document.body, { key: "p" });
    expect(props.onRank).not.toHaveBeenCalled();
    expect(screen.getAllByText("The working day's done. Tomorrow's plan starts at 08:00.").length).toBeGreaterThan(0);
  });

  it("once you've shut down, the day reads as closed: no gradient Shut down, a quiet Plan tomorrow", () => {
    at(21, 44);
    const onPlanTomorrow = vi.fn();
    const { props } = renderToday([task({ id: "m", title: "Moved thing", dueDate: localDayKey(new Date(Date.now() + 86400000)) })], { dayClosed: true, onPlanTomorrow });
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    expect(within(brief).getByRole("heading", { level: 2 }).textContent).toBe("Evening, Daniel. The day's closed.");
    expect(brief.textContent).toContain("One thing is due tomorrow; first up: Moved thing.");
    expect(brief.textContent).not.toMatch(/Everything|Shut down to close/);
    expect(screen.queryByRole("button", { name: "Shut down my day" })).not.toBeInTheDocument();
    const next = screen.getByRole("button", { name: "Plan tomorrow" });
    expect(next).toHaveAttribute("data-variant", "secondary");
    fireEvent.click(next);
    expect(onPlanTomorrow).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: "p" });
    expect(props.onRank).not.toHaveBeenCalled();
    expect(screen.getAllByText("You've closed today. Tomorrow's plan starts at 08:00.").length).toBeGreaterThan(0);
  });

  it("before the working day starts, suggestions begin at 08:00", () => {
    at(7, 10);
    renderToday([task({ id: "d", title: "Due thing", dueDate: today(), energy: "deep" })]);
    expect(ghostButtons().map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Suggested: Due thing, 08:00–08:30/)]);
  });

  it("a task due at a time is suggested before it, as the brief says", () => {
    renderToday([task({ id: "c", title: "Send contract", dueDate: today(), dueTime: "11:00" })]);
    expect(screen.getByRole("region", { name: "Your day in brief" }).textContent).toContain("It's due at 11:00, so I'd give it your clearest stretch, 09:00–09:30, before lunch.");
    expect(ghostButtons().map((b) => b.getAttribute("aria-label"))).toEqual([expect.stringMatching(/^Suggested: Send contract, 09:00–09:30/)]);
  });
});

describe("TodayView: waving suggestions away, and bringing them back", () => {
  /** A host that applies every write, like the app does. */
  function Host({ initial, onUpdate }: { initial: Task[]; onUpdate?: (id: string, p: Partial<Task>) => void }) {
    const [ts, setTs] = useState(initial);
    return (
      <ToastProvider>
        <TodayView tasks={ts} allTasks={ts} events={[]} calendarConnected currentUserId="me" captureDefaults={{ projectId: "p-personal", assigneeId: "me" }}
          onUpdate={(id, p) => { onUpdate?.(id, p); setTs((prev) => prev.map((t) => (t.id === id ? { ...t, ...p } : t))); }}
          onCreate={vi.fn()} onOpen={vi.fn()} onRank={async () => "ai" as const} ranking={false}
          onStartFocus={vi.fn()} onShutdown={vi.fn()} setup={[]} showSuggestions />
      </ToastProvider>
    );
  }

  it("the mouse can hide and show the suggestions, as H does", () => {
    renderToday([task({ id: "a", title: "Send the brief", dueDate: today() })]);
    expect(ghostButtons()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Hide suggestions for today" }));
    expect(ghostButtons()).toHaveLength(0);
    // the hint still says what P will do; the switch says how to see it again
    expect(screen.getByText("Places 1 task · 30m")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show suggestions" }));
    expect(ghostButtons()).toHaveLength(1);
  });

  it("with nothing to suggest there's no switch to show", () => {
    renderToday([task({ id: "p", title: "Placed", planToday: true, scheduled: 14 * 60 })]);
    expect(screen.queryByRole("button", { name: /suggestions/ })).not.toBeInTheDocument();
  });

  it("Not today, then Undo: the task is on today's list and a suggestion again (Plan my day can place it)", () => {
    render(<Host initial={[task({ id: "x", title: "Expenses", planToday: true })]} />);
    expect(ghostButtons()).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: /Not today: take “Expenses”/ }));
    expect(ghostButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ghostButtons()).toHaveLength(1);
    expect(screen.getByRole("button", { name: /Plan my day/ })).toBeEnabled();
    expect(screen.getByText("Places 1 task · 30m")).toBeInTheDocument();
  });

  it("Not today on work that's only due today still offers an Undo", () => {
    render(<Host initial={[task({ id: "d", title: "Due thing", dueDate: today() })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Not today: take “Due thing”/ }));
    expect(ghostButtons()).toHaveLength(0);
    expect(screen.getAllByText("Took “Due thing” off today.").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ghostButtons()).toHaveLength(1);
  });

  it("with the only suggestion set aside, the hint says so rather than 'nothing to place'", () => {
    render(<Host initial={[task({ id: "x", title: "Expenses", planToday: true })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Not now: hide the suggestion for “Expenses”/ }));
    expect(screen.getByText("Nothing to place · 1 set aside for today")).toBeInTheDocument();
  });

  it("Not now has an Undo too", () => {
    render(<Host initial={[task({ id: "d", title: "Due thing", dueDate: today() })]} />);
    fireEvent.click(screen.getByRole("button", { name: /Not now: hide the suggestion for “Due thing”/ }));
    expect(ghostButtons()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(ghostButtons()).toHaveLength(1);
  });

  it("putting a waved-away task back on today's list from elsewhere makes it a suggestion again", () => {
    const d = task({ id: "d", title: "Due thing", dueDate: today() });
    const props: TodayViewProps = {
      tasks: [d], allTasks: [d], events: [], calendarConnected: true, currentUserId: "me", captureDefaults: { projectId: "p-personal", assigneeId: "me" },
      onUpdate: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(), onRank: vi.fn(async () => "ai" as const), ranking: false,
      onStartFocus: vi.fn(), onShutdown: vi.fn(), setup: [], showSuggestions: true,
    };
    const { rerender } = render(<ToastProvider><TodayView {...props} /></ToastProvider>);
    fireEvent.click(screen.getByRole("button", { name: /Not now: hide the suggestion for “Due thing”/ }));
    expect(ghostButtons()).toHaveLength(0);
    // e.g. "On Today" in the task panel
    const back = { ...d, planToday: true };
    rerender(<ToastProvider><TodayView {...props} tasks={[back]} allTasks={[back]} /></ToastProvider>);
    expect(ghostButtons()).toHaveLength(1);
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
