import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { ToastProvider } from "../Toast";
import { localDayKey, planSeenKey } from "./planCanvas";
import { useTaskDragSource, dropOnTarget, listDropTargets, __resetDnd } from "../../lib/dnd";
import { loadAllChunks } from "../../lib/lazyLoad";
import type { Task, ExternalEvent } from "../../data/types";

// jsdom has no PointerEvent: without one, pointerId/pointerType/button never reach the kit
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "m-self", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

/** a fixed morning (the clock decides what's past and where a slot is offered) */
const at = (h: number, m = 0) => {
  const d = new Date(2026, 9, 9, h, m, 0);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(d);
};

/** Somewhere else in the app a task can be picked up from (My tasks, the Inbox, a board). */
function Elsewhere({ ids, source = "list" }: { ids: string[]; source?: "list" | "inbox" | "board" | "search" }) {
  const src = useTaskDragSource({ taskIds: ids, source, originId: "row-" + ids.join("-") });
  return <div {...src.bind} data-testid="elsewhere">row</div>;
}

function renderPlan(tasks: Task[], extra: Partial<Parameters<typeof PlanView>[0]> = {}, from?: string[]) {
  const onUpdate = vi.fn();
  const utils = render(
    <ToastProvider>
      {from && <Elsewhere ids={from} />}
      <PlanView tasks={tasks} onUpdate={onUpdate} onCreate={vi.fn()} onOpen={vi.fn()} calendarConnected externalEvents={[]} currentUserId="m-self" {...extra} />
    </ToastProvider>,
  );
  return { ...utils, onUpdate };
}

const on = (type: string, x: number, y: number) =>
  act(() => { window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" })); });
const press = (el: Element, x: number, y: number) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" });
/** pick up from elsewhere and hold it over (x, y) */
const carry = (x: number, y: number) => { press(screen.getByTestId("elsewhere"), 10, 10); on("pointermove", 30, 30); on("pointermove", x, y); };
const clickUndo = () => { const b = screen.getByRole("button", { name: "Undo" }); fireEvent.pointerDown(b); fireEvent.click(b); };

// restore only our own spy (restoreAllMocks would also wipe the global matchMedia mock)
let rectSpy: { mockRestore: () => void } | null = null;
// the day canvas on the left (0–780px, a pixel a minute from 07:00), the rail on the right
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(planSeenKey("m-self"), JSON.stringify({}));
  rectSpy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const r = this.tagName === "ASIDE" ? { left: 800, right: 1140, top: 0, bottom: 900 } : { left: 0, right: 780, top: 0, bottom: 900 };
    return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() { return r; } } as DOMRect;
  });
  at(8);
});
afterEach(() => {
  act(() => { __resetDnd(); });
  vi.useRealTimers();
  rectSpy?.mockRestore();
});

describe("PlanView: drag to plan from anywhere", () => {
  it("a task from another place lands on the slot, joins today's list, and says so with Undo", () => {
    const { onUpdate } = renderPlan([task({ id: "x", title: "Draft memo", focusMin: 45 })], {}, ["x"]);
    carry(100, 190); // 07:00 + (190 − 16 held) → 09:54 → 10:00
    const drop = document.querySelector(".kday-drop")!;
    expect(drop.textContent).toBe("10:00–10:45");
    expect(document.querySelector(".kday-canvas")).toHaveAttribute("data-kdnd-over", "true");
    on("pointerup", 100, 190);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("x", { scheduled: 600, planToday: true });
    expect(document.querySelector(".kday-drop")).toBeNull();
    expect(screen.getByText("Planned “Draft memo” for 10:00–10:45.")).toBeInTheDocument();
    clickUndo();
    expect(onUpdate).toHaveBeenLastCalledWith("x", { scheduled: null, planToday: false });
  });

  it("several at once land back to back from where they're dropped", () => {
    const { onUpdate } = renderPlan([task({ id: "a", title: "A", focusMin: 30 }), task({ id: "b", title: "B", focusMin: 60, planToday: true })], {}, ["a", "b"]);
    carry(100, 190);
    expect(document.querySelector(".kday-drop")?.textContent).toBe("10:00–11:30");
    on("pointerup", 100, 190);
    expect(onUpdate.mock.calls).toEqual([["a", { scheduled: 600, planToday: true }], ["b", { scheduled: 630 }]]);
    expect(screen.getByText("Planned 2 tasks from 10:00 · 1h 30m")).toBeInTheDocument();
  });

  it("a task with only an estimate in hours lands at that length", () => {
    const { onUpdate } = renderPlan([task({ id: "e", title: "Estimate", focusMin: 0, effortHours: 1.5 })], {}, ["e"]);
    carry(100, 190);
    expect(document.querySelector(".kday-drop")?.textContent).toBe("10:00–11:30");
    on("pointerup", 100, 190);
    expect(onUpdate).toHaveBeenCalledWith("e", { scheduled: 600, planToday: true, dur: 90 });
  });

  it("finished tasks and other people's stay put (the day doesn't take them)", () => {
    const { onUpdate } = renderPlan([task({ id: "d", title: "Done", status: "done" })], {}, ["d", "someone-elses"]);
    carry(100, 190);
    expect(document.querySelector(".kday-drop")).toBeNull();
    expect(document.querySelector(".kday-canvas")).not.toHaveAttribute("data-kdnd-over");
    on("pointerup", 100, 190);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("the drop takes its own lane beside what it overlaps, and names it", () => {
    const ev = (h: number, m: number) => { const d = new Date(2026, 9, 9, h, m); return d.toISOString(); };
    const events: ExternalEvent[] = [{ id: "e1", title: "Standup", start: ev(10, 0), end: ev(10, 30), allDay: false } as ExternalEvent];
    renderPlan([task({ id: "x", title: "Draft memo" })], { externalEvents: events }, ["x"]);
    carry(100, 190);
    const drop = document.querySelector<HTMLElement>(".kday-drop")!;
    expect(drop.textContent).toBe("10:00–10:30overlaps Standup");
    // the second of two lanes: half the width, from halfway
    expect(drop.style.width).toContain("0.5 * (100% - 64px)");
    expect(drop.style.left).toContain("0.5 * (100% - 64px)");
  });

  it("the rail: a block goes back to Unplanned, a task from elsewhere joins today's list", () => {
    const { onUpdate } = renderPlan([
      task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 }),
      task({ id: "y", title: "Tomorrow's", dueDate: "2026-10-10" }),
    ], {}, ["y"]);
    const block = screen.getByRole("button", { name: /^Write brief,/ });
    press(block, 100, 130);
    on("pointermove", 100, 140);
    on("pointermove", 900, 300);
    expect(screen.getByText("Release to move back to Unplanned")).toBeInTheDocument();
    expect(document.querySelector("aside")).toHaveAttribute("data-drop", "true");
    on("pointerup", 900, 300);
    expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: null });
    carry(900, 300);
    expect(screen.getByText("Release to add to today's list")).toBeInTheDocument();
    on("pointerup", 900, 300);
    expect(onUpdate).toHaveBeenLastCalledWith("y", { planToday: true });
    expect(screen.getByText("Added “Tomorrow's” to today's list.")).toBeInTheDocument();
  });

  it("a keyboard drop on a time runs the canvas's own handler; the beam isn't offered twice", () => {
    const { onUpdate } = renderPlan([task({ id: "m", title: "Memo", planToday: true })], {
      lede: () => <div data-daybeam="" data-from="480" data-to="1080">beam</div>,
    });
    const targets = listDropTargets(["today-slot", "today-rail"]);
    expect(targets.map((t) => `${t.kind}:${t.label}`)).toEqual(["today-slot:Today's plan", "today-rail:Today, no time"]);
    let took = false;
    act(() => { took = dropOnTarget({ taskIds: ["m"], source: "list", originId: "m" }, { kind: "today-slot", id: `${localDayKey()}T14:30` }); });
    expect(took).toBe(true);
    expect(onUpdate).toHaveBeenCalledWith("m", { scheduled: 14 * 60 + 30 });
  });

  it("guests: nothing to pick up, nothing to drop on, no edges to drag", () => {
    renderPlan([task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 }), task({ id: "r", title: "Rail", dueDate: localDayKey() })], { readOnly: true });
    expect(document.querySelector("[data-kdnd-source]")).toBeNull();
    expect(document.querySelector("[data-kdnd-target]")).toBeNull();
    expect(document.querySelector(".kday-resize")).toBeNull();
    expect(listDropTargets()).toEqual([]);
  });
});

describe("PlanView: a block's length", () => {
  it("dragging its bottom edge changes it on the quarter hour; Escape puts it back", () => {
    const { onUpdate } = renderPlan([task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 })]);
    const edge = () => document.querySelector(".kday-resize")!;
    press(edge(), 100, 148);
    on("pointermove", 100, 170); // +22 minutes → 45
    expect(document.querySelector(".kday-block")).toHaveAttribute("data-resizing", "true");
    expect(screen.getByRole("button", { name: /^Write brief, 09:00–09:45/ })).toBeInTheDocument();
    on("pointermove", 100, 180); // +32 → 60
    on("pointerup", 100, 180);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("b1", { dur: 60 });
    press(edge(), 100, 148);
    on("pointermove", 100, 200);
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    on("pointerup", 100, 200);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(document.querySelector(".kday-block")).not.toHaveAttribute("data-resizing");
  });

  it("Alt+↓ / Alt+↑ change it from the keyboard, in one write", () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const { onUpdate } = renderPlan([task({ id: "b1", title: "Deck", planToday: true, scheduled: 9 * 60 })]);
    const btn = screen.getByRole("button", { name: /^Deck,/ });
    act(() => btn.focus());
    fireEvent.keyDown(btn, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(btn, { key: "ArrowDown", altKey: true });
    fireEvent.keyDown(btn, { key: "ArrowUp", altKey: true });
    expect(onUpdate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(800); });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith("b1", { dur: 45 });
  });
});

describe("PlanView: Schedule… (the keyboard's drag onto the day)", () => {
  it("S on a rail row: ↑/↓ pick the time, ←/→ the length, Enter plans it", async () => {
    await loadAllChunks();
    const { onUpdate } = renderPlan([task({ id: "m", title: "Draft memo", planToday: true })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Draft memo, 30m/ }), { key: "s" });
    const dialog = await screen.findByRole("dialog", { name: "Schedule “Draft memo”" });
    const list = within(dialog).getByRole("listbox", { name: "Start time" });
    fireEvent.keyDown(list, { key: "Home" });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("07:00–07:30, earlier today");
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowRight" });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("08:15–09:00, free");
    expect(within(dialog).getByRole("spinbutton", { name: "Length" })).toHaveAttribute("aria-valuetext", "45m");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onUpdate).toHaveBeenCalledWith("m", { scheduled: 8 * 60 + 15, dur: 45 });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("the clock on a block reschedules it; a time that runs into a meeting says so", async () => {
    await loadAllChunks();
    const ev = (h: number, m: number) => new Date(2026, 9, 9, h, m).toISOString();
    const events: ExternalEvent[] = [{ id: "e1", title: "Standup", start: ev(10, 0), end: ev(10, 30), allDay: false } as ExternalEvent];
    const { onUpdate } = renderPlan([task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 })], { externalEvents: events });
    fireEvent.click(screen.getByRole("button", { name: "Reschedule “Write brief”" }));
    const dialog = await screen.findByRole("dialog", { name: "Schedule “Write brief”" });
    const list = within(dialog).getByRole("listbox");
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("09:00–09:30, free");
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("10:00–10:30, overlaps Standup");
    fireEvent.click(within(dialog).getByRole("button", { name: "Move: 10:00–10:30" }));
    expect(onUpdate).toHaveBeenCalledWith("b1", { scheduled: 600 });
  });
});
