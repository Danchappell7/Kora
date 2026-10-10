/* The board on the real drag kit, end to end (pointer events, hit-testing, the
   insertion point between cards). Runs once lib/dnd's engine is in (u3); while
   the kit is the inert contract stub these are skipped. Layout is faked:
   every column is 180px wide, 200px apart; cards are 90px tall, 100px apart. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act, cleanup } from "@testing-library/react";
import * as dnd from "../../lib/dnd";
import { BoardView } from "../tasks/OtherViews";
import type { Task } from "../../data/types";

const live = typeof (dnd as Record<string, unknown>).__resetDnd === "function";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string; isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? "mouse"; this.isPrimary = init.isPrimary ?? true;
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

const rect = (l: number, t: number, w: number, h: number) =>
  ({ left: l, top: t, right: l + w, bottom: t + h, x: l, y: t, width: w, height: h, toJSON() { return {}; } }) as DOMRect;
let spy: { mockRestore: () => void } | null = null;
beforeEach(() => {
  localStorage.clear();
  spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const lanes = Array.from(document.querySelectorAll(".kbd-lane"));
    const lane = this.classList.contains("kbd-lane") ? this : this.closest(".kbd-lane");
    const i = lane ? lanes.indexOf(lane) : -1;
    if (i < 0) return rect(0, 0, 0, 0);
    if (lane === this) return rect(i * 200, 0, 180, 1000);
    const card = this.closest("[data-card-id]");
    if (!card) return rect(0, 0, 0, 0);
    const j = Array.from(lane!.querySelectorAll(":scope > [data-card-id]")).indexOf(card);
    return rect(i * 200, 10 + j * 100, 180, 90);
  });
});
afterEach(() => {
  if (live) act(() => { (dnd as unknown as { __resetDnd: () => void }).__resetDnd(); });
  cleanup();
  // only our own spy: the global matchMedia mock from test/setup must survive
  spy?.mockRestore(); spy = null;
});

const mk = (over: Partial<Task>): Task => ({
  id: "t", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...over,
});
const move = (type: string, x: number, y: number) =>
  act(() => { window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" })); });

describe.runIf(live)("the board on the live drag kit", () => {
  it("drags a card between two cards of another column", () => {
    const tasks = [mk({ id: "a", title: "Brief" }), mk({ id: "b", title: "Deck", status: "progress", position: 1 }), mk({ id: "c", title: "Venue", status: "progress", position: 2 })];
    const onMove = vi.fn();
    render(<BoardView tasks={tasks} allTasks={tasks} onOpen={vi.fn()} onAdd={vi.fn()} onMove={onMove} onPatch={vi.fn()} />);
    const card = document.querySelector<HTMLElement>('[data-card-id="a"]')!;
    expect(card).toHaveAttribute("data-kdnd-source", "board");
    fireEvent.pointerDown(card, { clientX: 90, clientY: 50, button: 0, pointerId: 1, pointerType: "mouse" });
    move("pointermove", 120, 60);
    move("pointermove", 290, 115); // In progress, the lower half of "Deck" (10–100) → just past its middle
    move("pointermove", 290, 112);
    move("pointerup", 290, 112);
    expect(onMove).toHaveBeenCalledTimes(1);
    const [id, status, pos] = onMove.mock.calls[0];
    expect([id, status]).toEqual(["a", "progress"]);
    expect(pos).toBeGreaterThan(1);
    expect(pos).toBeLessThan(2);
  });

  it("a press that doesn't travel is a click: the task opens", () => {
    const tasks = [mk({ id: "a", title: "Brief" })];
    const onOpen = vi.fn(), onMove = vi.fn();
    render(<BoardView tasks={tasks} allTasks={tasks} onOpen={onOpen} onAdd={vi.fn()} onMove={onMove} onPatch={vi.fn()} />);
    const card = document.querySelector<HTMLElement>('[data-card-id="a"]')!;
    fireEvent.pointerDown(card, { clientX: 90, clientY: 50, button: 0, pointerId: 1, pointerType: "mouse" });
    move("pointerup", 91, 50);
    fireEvent.click(card);
    expect(onOpen).toHaveBeenCalledWith("a");
    expect(onMove).not.toHaveBeenCalled();
  });
});

it("is skipped until the drag kit's engine is in (or runs above)", () => {
  expect(typeof dnd.useTaskDragSource).toBe("function");
});
