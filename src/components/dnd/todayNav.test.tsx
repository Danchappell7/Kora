import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { todayListPatches, useTodayNavDropTarget } from "./todayNav";
import { useTaskDragSource, listDropTargets, __resetDnd } from "../../lib/dnd";
import type { Task } from "../../data/types";

if (typeof window.PointerEvent === "undefined") {
  class P extends MouseEvent { pointerId: number; pointerType: string; isPrimary = true; constructor(t: string, i: PointerEventInit = {}) { super(t, i); this.pointerId = i.pointerId ?? 1; this.pointerType = i.pointerType ?? "mouse"; } }
  (window as unknown as { PointerEvent: typeof P }).PointerEvent = P;
}
const task = (o: Partial<Task>): Task => ({ id: "t", title: "x", description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o });

let spy: { mockRestore: () => void } | null = null;
afterEach(() => { act(() => { __resetDnd(); }); spy?.mockRestore(); });

describe("the sidebar's Today as a drop target", () => {
  it("puts tasks on today's list (Undo takes them off); leaves done, archived, listed and unknown ones", () => {
    const r = todayListPatches([task({ id: "a", title: "Memo" }), task({ id: "b", planToday: true }), task({ id: "c", status: "done" }), task({ id: "d", archivedAt: "x" })], ["a", "b", "c", "d", "zz", "a"]);
    expect(r).toEqual({ patches: [{ id: "a", patch: { planToday: true } }], undo: [{ id: "a", patch: { planToday: false } }], message: "Added “Memo” to Today" });
    expect(todayListPatches([task({ id: "a" }), task({ id: "b" })], ["a", "b"]).message).toBe("Added 2 tasks to Today");
    expect(todayListPatches([], ["a"]).message).toBe("Already on Today");
  });

  it("takes a drop, isn't offered to keyboard menus, and binds nothing for guests", () => {
    spy = vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const r = (this as HTMLElement).dataset?.testid === "nav" ? { left: 0, top: 0, right: 200, bottom: 40 } : { left: 300, top: 0, right: 600, bottom: 40 };
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() { return r; } } as DOMRect;
    });
    const onDrop = vi.fn();
    function Nav({ readOnly }: { readOnly?: boolean }) { const t = useTodayNavDropTarget({ readOnly, onDrop }); return <a href="#today" data-testid="nav" {...t.bind}>Today</a>; }
    function Row() { const s = useTaskDragSource({ taskIds: ["a"], source: "list", originId: "a" }); return <div data-testid="row" {...s.bind}>row</div>; }
    const { rerender } = render(<><Nav /><Row /></>);
    expect(listDropTargets()).toEqual([]);
    fireEvent.pointerDown(screen.getByTestId("row"), { clientX: 400, clientY: 20, button: 0, pointerId: 1, pointerType: "mouse" });
    act(() => { window.dispatchEvent(new window.PointerEvent("pointermove", { clientX: 100, clientY: 20, pointerId: 1, pointerType: "mouse" })); });
    expect(screen.getByTestId("nav")).toHaveAttribute("data-kdnd-over", "true");
    act(() => { window.dispatchEvent(new window.PointerEvent("pointerup", { clientX: 100, clientY: 20, pointerId: 1, pointerType: "mouse" })); });
    expect(onDrop).toHaveBeenCalledWith(["a"], { taskIds: ["a"], source: "list", originId: "a" });
    rerender(<><Nav readOnly /><Row /></>);
    expect(screen.getByTestId("nav")).not.toHaveAttribute("data-kdnd-target");
  });
});
