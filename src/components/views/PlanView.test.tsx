import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { ToastProvider } from "../Toast";
import { localDayKey, planSeenKey, writeSeen } from "./planCanvas";
import type { SeenMap } from "./planCanvas";
import type { Task } from "../../data/types";

// jsdom has no PointerEvent: without one, pointerId/pointerType/button never reach
// the handlers and the drag code is never exercised
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

const yesterday = () => { const d = new Date(); d.setDate(d.getDate() - 1); return localDayKey(d); };

function renderPlan(tasks: Task[], extra: Partial<Parameters<typeof PlanView>[0]> = {}) {
  const onUpdate = vi.fn();
  const onOpen = vi.fn();
  const utils = render(
    <ToastProvider>
      <PlanView tasks={tasks} onUpdate={onUpdate} onCreate={vi.fn()} onOpen={onOpen} calendarConnected externalEvents={[]} currentUserId="m-self" {...extra} />
    </ToastProvider>,
  );
  return { ...utils, onUpdate, onOpen };
}

const seed = (map: SeenMap, me = "m-self") => writeSeen(planSeenKey(me), map);
const seenYesterday = (...pairs: [string, number][]): SeenMap => Object.fromEntries(pairs.map(([id, at]) => [id, { day: yesterday(), at }]));

// restore only our own spies (restoreAllMocks would also wipe the global matchMedia mock)
const spies: { mockRestore: () => void }[] = [];
const spy = <T extends { mockRestore: () => void }>(s: T): T => { spies.push(s); return s; };

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); spies.splice(0).forEach((s) => s.mockRestore()); });

describe("PlanView", () => {
  it("files a capture where it's told to (the active workspace's project, the signed-in user)", () => {
    const onCreate = vi.fn();
    renderPlan([], { onCreate, captureDefaults: { projectId: "p-launch", assigneeId: "u-42" } });
    const input = screen.getByLabelText("Capture a task for today");
    fireEvent.change(input, { target: { value: "Draft Q3 deck 90m" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Draft Q3 deck", projectId: "p-launch", assigneeId: "u-42", planToday: true }));
  });

  it("the parse line under capture only names a day when the text does", () => {
    renderPlan([]);
    const input = screen.getByLabelText("Capture a task for today");
    const line = () => document.getElementById(input.getAttribute("aria-describedby")!)!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Call supplier 30m" } });
    expect(line().textContent).toContain("30m");
    expect(line().textContent).toContain("⏎ add · ⇥ plan");
    expect(line().textContent).not.toMatch(/Tomorrow|Today/);
    fireEvent.change(input, { target: { value: "Call supplier tomorrow" } });
    expect(line().textContent).toContain("Tomorrow");
  });

  it("Tab adds the capture and puts it on the day", () => {
    const onCreate = vi.fn();
    renderPlan([], { onCreate });
    const input = screen.getByLabelText("Capture a task for today");
    fireEvent.change(input, { target: { value: "Call supplier 30m" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ title: "Call supplier", planToday: true, scheduled: expect.any(Number) }));
    expect((input as HTMLInputElement).value).toBe("");
    // an empty field lets Tab move on as usual
    const e = fireEvent.keyDown(input, { key: "Tab" });
    expect(e).toBe(true);
    expect(onCreate).toHaveBeenCalledTimes(1);
  });

  it("doesn't crash on a quick-added task with no energy or duration", () => {
    renderPlan([task({ id: "q1", title: "Call supplier", planToday: true, scheduled: null, energy: undefined, dur: undefined })]);
    expect(screen.getByText("Call supplier")).toBeInTheDocument();
  });

  it("doesn't crash when a placed block has no energy", () => {
    renderPlan([task({ id: "b1", title: "Imported block", planToday: true, scheduled: 9 * 60, energy: undefined })]);
    expect(screen.getByRole("button", { name: /Imported block, 09:00–09:30/ })).toBeInTheDocument();
  });

  it("leaves finished tasks off the canvas", () => {
    renderPlan([
      task({ id: "open", title: "Still to do", planToday: true, scheduled: 9 * 60 }),
      task({ id: "done", title: "Already done", planToday: true, scheduled: 10 * 60, status: "done" }),
    ]);
    expect(screen.getByText("Still to do")).toBeInTheDocument();
    expect(screen.queryByText("Already done")).not.toBeInTheDocument();
  });

  it("'Not today' takes a card off today's list", () => {
    const { onUpdate } = renderPlan([task({ id: "i1", title: "Expenses", planToday: true, scheduled: null })]);
    fireEvent.click(screen.getByRole("button", { name: /Not today: take “Expenses”/ }));
    expect(onUpdate).toHaveBeenCalledWith("i1", { planToday: false });
  });

  it("moves a block from the keyboard in one write, and Delete unplans it", () => {
    vi.useFakeTimers();
    const { onUpdate } = renderPlan([task({ id: "b1", title: "Deck", planToday: true, scheduled: 9 * 60 + 7 })]);
    const btn = screen.getByRole("button", { name: /^Deck,/ });
    act(() => btn.focus());
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    fireEvent.keyDown(btn, { key: "ArrowDown" });
    expect(onUpdate).not.toHaveBeenCalled(); // nudges settle before saving
    act(() => { vi.advanceTimersByTime(800); });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: 9 * 60 + 30 });
    fireEvent.keyDown(btn, { key: "Delete" });
    expect(onUpdate).toHaveBeenLastCalledWith("b1", { scheduled: null });
  });

  it("offers to carry over yesterday's unfinished blocks — mine only", () => {
    seed(seenYesterday(["a", 9 * 60], ["b", 11 * 60], ["c", 13 * 60], ["d", 14 * 60]));
    const { onUpdate } = renderPlan([
      task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 }),
      task({ id: "b", title: "B", planToday: true, scheduled: 11 * 60 }),
      task({ id: "c", title: "Maya's", planToday: true, scheduled: 13 * 60, assigneeId: "maya" }),
      task({ id: "d", title: "Done", planToday: true, scheduled: 14 * 60, status: "done" }),
    ]);
    const banner = screen.getByRole("region", { name: /Unfinished blocks/ });
    expect(within(banner).getByText(/Yesterday's plan: 2 unfinished blocks/)).toBeInTheDocument();
    // the group names them, at their old times, earliest first
    expect(within(banner).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["A09:00", "B11:00"]);
    fireEvent.click(within(banner).getByRole("button", { name: "Bring all" }));
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: null });
    expect(onUpdate).toHaveBeenCalledWith("b", { scheduled: null });
    expect(screen.queryByRole("region", { name: /Unfinished blocks/ })).not.toBeInTheDocument();
    // Undo puts them back where they were — and the prompt stays answered
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: 9 * 60, planToday: true });
    expect(screen.queryByRole("region", { name: /Unfinished blocks/ })).not.toBeInTheDocument();
  });

  it("Clear takes yesterday's blocks off today entirely", () => {
    seed(seenYesterday(["a", 9 * 60]));
    const { onUpdate } = renderPlan([task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: null, planToday: false });
  });

  it("keeps a pending prompt across visits, and Keep answers it for the day", () => {
    seed(seenYesterday(["a", 9 * 60]));
    const tasks = [task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })];
    const first = renderPlan(tasks);
    expect(screen.getByText(/1 unfinished block/)).toBeInTheDocument();
    first.unmount();
    const second = renderPlan(tasks);
    expect(screen.getByText(/1 unfinished block/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep them where they are" }));
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
    second.unmount();
    renderPlan(tasks);
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
  });

  it("the first open on a device (or after an update) never offers today's plan", () => {
    const tasks = [task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })];
    const first = renderPlan(tasks);
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
    first.unmount();
    renderPlan(tasks);
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(planSeenKey("m-self")) || "{}").a).toEqual({ day: localDayKey(), at: 9 * 60 });
  });

  it("never offers blocks planned today elsewhere, or moved since", () => {
    seed(seenYesterday(["old", 9 * 60], ["moved", 13 * 60]));
    renderPlan([
      task({ id: "old", title: "Old", planToday: true, scheduled: 9 * 60 }),
      task({ id: "fresh", title: "Planned on my phone", planToday: true, scheduled: 10 * 60 }),
      task({ id: "moved", title: "Moved", planToday: true, scheduled: 14 * 60 }),
    ]);
    expect(screen.getByText(/Yesterday's plan: 1 unfinished block$/)).toBeInTheDocument();
  });

  it("offers each workspace's leftovers, whichever workspace Plan is opened in first", () => {
    seed(seenYesterday(["p1", 9 * 60], ["w1", 10 * 60], ["w2", 11 * 60]));
    const personal = [task({ id: "p1", title: "Personal", planToday: true, scheduled: 9 * 60, workspaceId: null })];
    const team = [
      task({ id: "w1", title: "Team 1", planToday: true, scheduled: 10 * 60, workspaceId: "ws-team" }),
      task({ id: "w2", title: "Team 2", planToday: true, scheduled: 11 * 60, workspaceId: "ws-team" }),
    ];
    const onUpdate = vi.fn();
    const el = (tasks: Task[]) => (
      <ToastProvider>
        <PlanView tasks={tasks} onUpdate={onUpdate} onCreate={vi.fn()} onOpen={vi.fn()} calendarConnected externalEvents={[]} currentUserId="m-self" />
      </ToastProvider>
    );
    const { rerender } = render(el(personal));
    expect(screen.getByText(/Yesterday's plan: 1 unfinished block/)).toBeInTheDocument();
    rerender(el(team));
    expect(screen.getByText(/Yesterday's plan: 2 unfinished blocks/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bring all" }));
    expect(onUpdate).toHaveBeenCalledWith("w1", { scheduled: null });
    expect(onUpdate).toHaveBeenCalledWith("w2", { scheduled: null });
    // …and Personal's prompt is still waiting when you switch back
    rerender(el(personal));
    expect(screen.getByText(/Yesterday's plan: 1 unfinished block/)).toBeInTheDocument();
  });

  it("keeps each person's record apart on a shared computer", () => {
    seed(seenYesterday(["a", 9 * 60]), "u-dan");
    renderPlan([task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60, assigneeId: "u-sam" })], { currentUserId: "u-sam" });
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
  });

  it("with storage blocked, today's plan is never offered as an earlier one", () => {
    spy(vi.spyOn(Storage.prototype, "getItem")).mockImplementation(() => { throw new Error("blocked"); });
    spy(vi.spyOn(Storage.prototype, "setItem")).mockImplementation(() => { throw new Error("blocked"); });
    const tasks = [task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })];
    const first = renderPlan(tasks, { currentUserId: "u-blocked" });
    first.unmount();
    renderPlan(tasks, { currentUserId: "u-blocked" });
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
  });

  it("a free gap centred on the hour steps its label clear of the hour rule", () => {
    const events = [
      { id: "m1", title: "Morning", start: 8 * 60, end: 15 * 60 + 30, kind: "meeting" as const },
      { id: "m2", title: "Late", start: 16 * 60 + 30, end: 17 * 60, kind: "meeting" as const },
    ];
    const { container } = renderPlan([], { events, nowMin: 8 * 60 });
    const labels = Array.from(container.querySelectorAll<HTMLElement>(".kday-free-label"));
    const byText = (t: string) => labels.find((l) => l.textContent === t)!;
    // 15:30–16:30 is centred on 16:00: its label sits 12px below the rule
    expect(byText("Free · 1h").style.transform).toBe("translateY(12px)");
    // 17:00–18:00 is centred on the half hour: left where it is
    expect(labels.filter((l) => l.textContent === "Free · 1h").map((l) => l.style.transform)).toEqual(["translateY(12px)", ""]);
  });

  it("announces plan updates in a live region and points capture at q", () => {
    renderPlan([task({ id: "i1", title: "Expenses", planToday: true, scheduled: null })]);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "q" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /Capture a task/ }));
  });
});

/* ---------- pointer drags ---------- */
describe("PlanView drag and drop", () => {
  // day canvas on the left (0–780px, 1px per minute from 7am), Intake rail on the right
  beforeEach(() => {
    localStorage.setItem(planSeenKey("m-self"), JSON.stringify({ b1: { day: localDayKey(), at: 9 * 60 } }));
    spy(vi.spyOn(Element.prototype, "getBoundingClientRect")).mockImplementation(function (this: Element) {
      const r = this.tagName === "ASIDE" ? { left: 800, right: 1140, top: 0, bottom: 900 } : { left: 0, right: 780, top: 0, bottom: 900 };
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() { return r; } } as DOMRect;
    });
  });

  // the 9am block's top edge is at y=120; presses land 10px into it
  const setup = () => {
    const utils = renderPlan([task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 })]);
    return { ...utils, btn: screen.getByRole("button", { name: /^Write brief,/ }) };
  };
  const on = (type: string, x: number, y: number, o: { pointerType?: string; pointerId?: number } = {}) =>
    window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: o.pointerId ?? 1, pointerType: o.pointerType ?? "mouse" }));
  const press = (el: Element, x: number, y: number, o: { pointerType?: string; pointerId?: number } = {}) =>
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: o.pointerId ?? 1, pointerType: o.pointerType ?? "mouse" });
  const dragging = () => document.querySelectorAll("[data-dragging]").length > 0;

  it("a click opens the block and writes nothing", () => {
    const { btn, onUpdate, onOpen } = setup();
    press(btn, 100, 130);
    act(() => { on("pointerup", 100, 130); });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith("b1");
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a mouse wobble of 4px or less is still a click", () => {
    const { btn, onUpdate } = setup();
    press(btn, 100, 130);
    act(() => { on("pointermove", 102, 133); });
    expect(dragging()).toBe(false);
    act(() => { on("pointerup", 102, 133); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("dragging a block to a new time writes it once", () => {
    const { btn, onUpdate } = setup();
    press(btn, 100, 130);
    act(() => { on("pointermove", 100, 136); });
    expect(dragging()).toBe(true);
    act(() => { on("pointermove", 100, 190); });
    act(() => { on("pointerup", 100, 190); });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: 10 * 60 });
    expect(dragging()).toBe(false);
  });

  it("at Large text (the page is zoomed) an hour of drag is an hour, not more", () => {
    // at zoom 1.25 the 9am block's top edge is on screen at 120 × 1.25 = 150px, and 75 screen px are 60 minutes
    document.documentElement.style.setProperty("--zoom", "1.25");
    try {
      const { btn, onUpdate } = setup();
      press(btn, 100, 160);
      act(() => { on("pointermove", 100, 170); });
      act(() => { on("pointermove", 100, 235); });
      act(() => { on("pointerup", 100, 235); });
      expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: 10 * 60 });
    } finally {
      document.documentElement.style.removeProperty("--zoom");
    }
  });

  it("dropping it back in the same slot writes nothing", () => {
    const { btn, onUpdate } = setup();
    press(btn, 100, 130);
    act(() => { on("pointermove", 100, 140); });
    act(() => { on("pointermove", 100, 131); });
    act(() => { on("pointerup", 100, 131); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("Escape and pointercancel abort a drag without writing", () => {
    const { btn, onUpdate } = setup();
    press(btn, 100, 130);
    act(() => { on("pointermove", 100, 190); });
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(dragging()).toBe(false);
    act(() => { on("pointerup", 100, 190); });
    press(btn, 100, 130);
    act(() => { on("pointermove", 100, 190); });
    act(() => { on("pointercancel", 100, 190); });
    expect(dragging()).toBe(false);
    act(() => { on("pointerup", 100, 190); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a release that lands straight after the drag starts is never lost", () => {
    const { btn, onUpdate } = setup();
    press(btn, 100, 130);
    // the move that starts the drag and the release arrive before React would normally re-render
    act(() => { on("pointermove", 100, 136); on("pointerup", 100, 136); });
    expect(dragging()).toBe(false);
    const writes = onUpdate.mock.calls.length;
    // the next click anywhere else must not drop (or unplan) the block
    act(() => { on("pointerup", 2000, 300); });
    expect(onUpdate.mock.calls.length).toBe(writes);
    expect(onUpdate).not.toHaveBeenCalledWith("b1", { scheduled: null });
  });

  it("touch: a swipe scrolls the day instead of picking the block up", () => {
    vi.useFakeTimers();
    const { btn, onUpdate } = setup();
    press(btn, 100, 130, { pointerType: "touch", pointerId: 7 });
    act(() => { on("pointermove", 100, 150, { pointerType: "touch", pointerId: 7 }); });
    act(() => { vi.advanceTimersByTime(400); });
    expect(dragging()).toBe(false);
    act(() => { on("pointerup", 100, 150, { pointerType: "touch", pointerId: 7 }); });
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("touch: a long-press released in place writes nothing, even with a wobble", () => {
    vi.useFakeTimers();
    const { btn, onUpdate } = setup();
    press(btn, 100, 130, { pointerType: "touch", pointerId: 7 });
    act(() => { on("pointermove", 103, 134, { pointerType: "touch", pointerId: 7 }); }); // 5px of finger wobble
    act(() => { vi.advanceTimersByTime(260); });
    expect(dragging()).toBe(true);
    act(() => { on("pointerup", 103, 134, { pointerType: "touch", pointerId: 7 }); });
    expect(dragging()).toBe(false);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("a task dropped on the Daybeam lands at the time it points to (and the beam is told where)", () => {
    // the beam spans 08:00–18:00 over 600px at y=950: a pixel a minute, from x=100
    spies.pop()?.mockRestore();
    spy(vi.spyOn(Element.prototype, "getBoundingClientRect")).mockImplementation(function (this: Element) {
      const r = (this as HTMLElement).dataset?.daybeam != null ? { left: 100, right: 700, top: 950, bottom: 966 }
        : this.tagName === "ASIDE" ? { left: 800, right: 1140, top: 0, bottom: 900 } : { left: 0, right: 780, top: 0, bottom: 900 };
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() { return r; } } as DOMRect;
    });
    const due = task({ id: "d1", title: "Send the brief", dueDate: localDayKey() });
    const { onUpdate } = renderPlan([due], {
      lede: (drop) => <div data-daybeam="" data-from="480" data-to="1080">{drop ? `lands ${drop.start}–${drop.end}` : "beam"}</div>,
    });
    const card = screen.getByRole("button", { name: /^Send the brief, 30m/ }).closest("[data-intake-card]")!;
    press(card, 900, 100);
    act(() => { on("pointermove", 880, 110); });
    act(() => { on("pointermove", 403, 958); });
    expect(screen.getByText("lands 780–810")).toBeInTheDocument();
    act(() => { on("pointerup", 403, 958); });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("d1", { scheduled: 13 * 60, planToday: true });
    expect(screen.getByText("beam")).toBeInTheDocument();
  });

  it("touch: long-press then drag moves the block; a second finger can't drop it", () => {
    vi.useFakeTimers();
    const { btn, onUpdate } = setup();
    press(btn, 100, 130, { pointerType: "touch", pointerId: 7 });
    act(() => { vi.advanceTimersByTime(260); });
    act(() => { on("pointermove", 100, 190, { pointerType: "touch", pointerId: 7 }); });
    act(() => { on("pointerup", 400, 700, { pointerType: "touch", pointerId: 8 }); });
    expect(dragging()).toBe(true);
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => { on("pointerup", 100, 190, { pointerType: "touch", pointerId: 7 }); });
    expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: 10 * 60 });
  });
});
