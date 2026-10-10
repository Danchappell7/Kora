import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  useTaskDragSource, useTaskDropTarget, useDropTargets, useDragState, listDropTargets, dropOnTarget, isTaskDragActive, cancelTaskDrag,
  DragLayer, __resetDnd, DND_LONG_PRESS_MS,
  type TaskDropEvent, type TaskDragPayload, type DropTargetRef, type TaskDropTargetOptions, type TaskDragSourceOptions,
} from "./dnd";

// jsdom has no PointerEvent: without one, pointerId/pointerType/button never reach the handlers
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

/* layout: each element says where it is with data-rect="left top right bottom" */
const rects = new WeakMap<Element, [number, number, number, number]>();
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const attr = (this as HTMLElement).dataset?.rect;
    const [l, t, r, b] = attr ? attr.split(" ").map(Number) : rects.get(this) ?? [0, 0, 0, 0];
    return { left: l, top: t, right: r, bottom: b, x: l, y: t, width: r - l, height: b - t, toJSON() { return {}; } } as DOMRect;
  });
});
afterEach(() => {
  act(() => { __resetDnd(); });
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document as { elementFromPoint?: unknown }).elementFromPoint;
});

const on = (type: string, x: number, y: number, o: { pointerType?: string; pointerId?: number } = {}) =>
  act(() => { window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: o.pointerId ?? 1, pointerType: o.pointerType ?? "mouse" })); });
const press = (el: Element, x: number, y: number, o: { pointerType?: string; pointerId?: number; shiftKey?: boolean } = {}) =>
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerId: o.pointerId ?? 1, pointerType: o.pointerType ?? "mouse", shiftKey: o.shiftKey });

function Source({ id, ids, label, rect = "0 0 100 30", onEnd, ...rest }: Partial<TaskDragSourceOptions> & { id: string; ids?: string[] | (() => string[]); rect?: string; onEnd?: TaskDragSourceOptions["onDragEnd"] }) {
  const s = useTaskDragSource({ taskIds: ids ?? [id], source: "list", originId: id, label: label ?? `Task ${id}`, onDragEnd: onEnd, ...rest });
  return <div {...s.bind} data-testid={`src-${id}`} data-rect={rect} onClick={rest.onDragStart ? undefined : () => clicks.push(id)}>{id}<input aria-label={`edit ${id}`} /></div>;
}
const clicks: string[] = [];

function Target({ target, rect, children, ...o }: Omit<TaskDropTargetOptions, "onDrop" | "target"> & { target: DropTargetRef; rect: string; onDrop?: (e: TaskDropEvent) => void; children?: React.ReactNode }) {
  const t = useTaskDropTarget({ target, onDrop: o.onDrop ?? (() => {}), ...o });
  return <section {...t.bind} data-testid={`t-${target.kind}-${target.id}`} data-rect={rect} data-can={t.canDrop || undefined}>{children}</section>;
}

describe("dnd: picking up and putting down", () => {
  it("a mouse press becomes a drag only past the threshold, and a drop runs the target's handler", () => {
    const onDrop = vi.fn();
    const onEnd = vi.fn();
    render(<><Source id="a" onEnd={onEnd} /><Target target={{ kind: "project", id: "p1", label: "Launch" }} rect="200 0 400 100" onDrop={onDrop} /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 13, 12); // 3.6px: still a click
    expect(isTaskDragActive()).toBe(false);
    on("pointermove", 20, 10);
    expect(isTaskDragActive()).toBe(true);
    expect(screen.getByTestId("src-a")).toHaveAttribute("data-kdnd-dragging", "true");
    expect(screen.getByTestId("t-project-p1")).toHaveAttribute("data-can", "true");
    on("pointermove", 300, 25);
    expect(screen.getByTestId("t-project-p1")).toHaveAttribute("data-kdnd-over", "true");
    on("pointerup", 300, 25);
    expect(isTaskDragActive()).toBe(false);
    expect(onDrop).toHaveBeenCalledTimes(1);
    const e: TaskDropEvent = onDrop.mock.calls[0][0];
    expect(e.payload).toEqual({ taskIds: ["a"], source: "list", originId: "a" });
    expect(e.target).toMatchObject({ kind: "project", id: "p1" });
    expect(e.via).toBe("pointer");
    expect(e.point).toEqual({ x: 300, y: 25 });
    expect(e.within).toEqual({ x: 0.5, y: 0.25 });
    expect(onEnd).toHaveBeenCalledWith({ dropped: e, cancelled: false });
    expect(screen.getByTestId("src-a")).not.toHaveAttribute("data-kdnd-dragging");
    expect(screen.getByTestId("t-project-p1")).not.toHaveAttribute("data-kdnd-over");
  });

  it("Escape cancels (nothing dropped, the target is told it was left), and so does letting go over nothing", () => {
    const onDrop = vi.fn(), onLeave = vi.fn(), onEnd = vi.fn();
    render(<><Source id="a" onEnd={onEnd} /><Target target={{ kind: "project", id: "p1" }} rect="200 0 400 100" onDrop={onDrop} onLeave={onLeave} /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(isTaskDragActive()).toBe(false);
    expect(onLeave).toHaveBeenCalledTimes(1);
    on("pointerup", 300, 20);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenLastCalledWith({ dropped: null, cancelled: true });
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 120, 300);
    on("pointerup", 120, 300);
    expect(onDrop).not.toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(onEnd).toHaveBeenLastCalledWith({ dropped: null, cancelled: true });
  });

  it("pointercancel and cancelTaskDrag() abort too; a second pointer can't drop", () => {
    const onDrop = vi.fn();
    render(<><Source id="a" /><Target target={{ kind: "project", id: "p1" }} rect="200 0 400 100" onDrop={onDrop} /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    on("pointerup", 300, 20, { pointerId: 9 });
    expect(isTaskDragActive()).toBe(true);
    on("pointercancel", 300, 20);
    expect(isTaskDragActive()).toBe(false);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    act(() => cancelTaskDrag());
    expect(isTaskDragActive()).toBe(false);
    expect(onDrop).not.toHaveBeenCalled();
  });

  it("touch: a long-press picks up; a swipe before it never does", () => {
    vi.useFakeTimers();
    const onDrop = vi.fn();
    render(<><Source id="a" /><Target target={{ kind: "project", id: "p1" }} rect="200 0 400 100" onDrop={onDrop} /></>);
    press(screen.getByTestId("src-a"), 10, 10, { pointerType: "touch", pointerId: 4 });
    on("pointermove", 10, 30, { pointerType: "touch", pointerId: 4 }); // a scroll
    act(() => { vi.advanceTimersByTime(DND_LONG_PRESS_MS + 50); });
    expect(isTaskDragActive()).toBe(false);
    on("pointerup", 10, 30, { pointerType: "touch", pointerId: 4 });
    press(screen.getByTestId("src-a"), 10, 10, { pointerType: "touch", pointerId: 5 });
    on("pointermove", 13, 14, { pointerType: "touch", pointerId: 5 }); // a wobble
    act(() => { vi.advanceTimersByTime(DND_LONG_PRESS_MS - 20); });
    expect(isTaskDragActive()).toBe(false);
    act(() => { vi.advanceTimersByTime(30); });
    expect(isTaskDragActive()).toBe(true);
    on("pointermove", 300, 20, { pointerType: "touch", pointerId: 5 });
    on("pointerup", 300, 20, { pointerType: "touch", pointerId: 5 });
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("presses in a text field, with a modifier key, or on a disabled source never start a drag", () => {
    render(<><Source id="a" /><Source id="b" disabled rect="0 40 100 70" /></>);
    press(screen.getByLabelText("edit a"), 10, 10);
    on("pointermove", 60, 10);
    expect(isTaskDragActive()).toBe(false);
    on("pointerup", 60, 10);
    press(screen.getByTestId("src-a"), 10, 10, { shiftKey: true });
    on("pointermove", 60, 10);
    expect(isTaskDragActive()).toBe(false);
    on("pointerup", 60, 10);
    expect(screen.getByTestId("src-b")).not.toHaveAttribute("data-kdnd-source");
    press(screen.getByTestId("src-b"), 10, 50);
    on("pointermove", 60, 50);
    expect(isTaskDragActive()).toBe(false);
  });

  it("a multi-select drag reads the selection when it starts, and the ghost says how many", () => {
    const onDrop = vi.fn();
    let selection = ["a"];
    render(<><DragLayer getTaskTitle={(id) => `Title ${id}`} /><Source id="a" ids={() => selection} /><Target target={{ kind: "person", id: "u1", label: "Sana Rao" }} rect="200 0 400 100" onDrop={onDrop} /></>);
    selection = ["a", "b", "a", "c"];
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 30, 10);
    const ghost = document.querySelector(".kdnd-ghost")!;
    expect(ghost.querySelector("b")?.textContent).toBe("3 tasks");
    expect(ghost.querySelector("i")?.textContent).toBe("3");
    expect(ghost).toHaveAttribute("aria-hidden", "true");
    on("pointermove", 300, 20);
    expect(ghost.querySelector("span")?.textContent).toBe("→ Sana Rao");
    expect(screen.getByRole("status").textContent).toBe("Picked up 3 tasks. Escape cancels.");
    on("pointerup", 300, 20);
    expect(document.querySelector(".kdnd-ghost")).toBeNull();
    expect((onDrop.mock.calls[0][0] as TaskDropEvent).payload.taskIds).toEqual(["a", "b", "c"]);
  });

  it("the ghost of one task shows its title; a cancel is said out loud", () => {
    render(<><DragLayer getTaskTitle={(id) => (id === "a" ? "Write the brief" : undefined)} /><Source id="a" /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 30, 10);
    expect(document.querySelector(".kdnd-ghost b")?.textContent).toBe("Write the brief");
    expect((document.querySelector(".kdnd-ghost") as HTMLElement).style.left).toBe("44px");
    // near the right edge it stays on screen (jsdom's window is 1024 wide; the ghost is at most 260)
    on("pointermove", window.innerWidth - 4, 10);
    expect((document.querySelector(".kdnd-ghost") as HTMLElement).style.left).toBe(`${window.innerWidth - 268}px`);
    act(() => { fireEvent.keyDown(window, { key: "Escape" }); });
    expect(screen.getByRole("status").textContent).toBe("Cancelled. Write the brief didn't move.");
  });

  it("the innermost target that accepts wins; one that refuses gives way to the one around it", () => {
    const day = vi.fn(), slot = vi.fn();
    const { rerender } = render(<><Source id="a" />
      <Target target={{ kind: "week-day", id: "2026-10-09" }} rect="200 0 400 400" onDrop={day}>
        <Target target={{ kind: "week-slot", id: "2026-10-09" }} rect="200 50 230 400" onDrop={slot} />
      </Target></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 210, 100);
    on("pointerup", 210, 100);
    expect(slot).toHaveBeenCalledTimes(1);
    expect(day).not.toHaveBeenCalled();
    rerender(<><Source id="a" />
      <Target target={{ kind: "week-day", id: "2026-10-09" }} rect="200 0 400 400" onDrop={day}>
        <Target target={{ kind: "week-slot", id: "2026-10-09" }} rect="200 50 230 400" onDrop={slot} accepts={() => false} />
      </Target></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 210, 100);
    expect(screen.getByTestId("t-week-slot-2026-10-09")).not.toHaveAttribute("data-can");
    on("pointerup", 210, 100);
    expect(day).toHaveBeenCalledTimes(1);
    expect(slot).toHaveBeenCalledTimes(1);
  });

  it("onOver follows the pointer inside a target", () => {
    const onOver = vi.fn();
    render(<><Source id="a" /><Target target={{ kind: "today-slot", id: "2026-10-09" }} rect="0 100 200 500" onOver={onOver} /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 50, 200);
    on("pointermove", 50, 300);
    expect(onOver.mock.calls.map((c) => (c[0] as TaskDropEvent).within?.y)).toEqual([0.25, 0.5]);
  });

  it("a browser's elementFromPoint decides when a target is covered (a dialog, a clipped list)", () => {
    const onDrop = vi.fn();
    render(<><Source id="a" /><Target target={{ kind: "project", id: "p1" }} rect="200 0 400 100" onDrop={onDrop} /><div data-testid="cover" /></>);
    const cover = screen.getByTestId("cover");
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => cover;
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    on("pointerup", 300, 20);
    expect(onDrop).not.toHaveBeenCalled();
    (document as { elementFromPoint?: unknown }).elementFromPoint = () => screen.getByTestId("t-project-p1");
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    on("pointerup", 300, 20);
    expect(onDrop).toHaveBeenCalledTimes(1);
  });

  it("the click that ends a drag doesn't open what's under it; the next one does", async () => {
    clicks.length = 0;
    render(<><Source id="a" /><Target target={{ kind: "project", id: "p1" }} rect="200 0 400 100" /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 300, 20);
    on("pointerup", 300, 20);
    fireEvent.click(screen.getByTestId("src-a"));
    expect(clicks).toEqual([]);
    await act(() => new Promise((r) => setTimeout(r, 5)));
    fireEvent.click(screen.getByTestId("src-a"));
    expect(clicks).toEqual(["a"]);
  });

  it("hovering a [data-kdnd-spring] element during a drag clicks it after a moment", () => {
    vi.useFakeTimers();
    const go = vi.fn();
    render(<><Source id="a" /><a href="#today" data-kdnd-spring="" data-testid="nav" onClick={(e) => { e.preventDefault(); go(); }}>Today</a></>);
    const nav = screen.getByTestId("nav");
    (document as { elementFromPoint?: unknown }).elementFromPoint = (x: number) => (x > 100 ? nav : document.body);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 150, 10);
    expect(nav).toHaveAttribute("data-kdnd-spring-armed", "true");
    act(() => { vi.advanceTimersByTime(400); });
    on("pointermove", 50, 10); // left before it fired
    expect(nav).not.toHaveAttribute("data-kdnd-spring-armed");
    on("pointermove", 150, 10);
    act(() => { vi.advanceTimersByTime(750); });
    expect(go).toHaveBeenCalledTimes(1);
    expect(isTaskDragActive()).toBe(true); // the drag travels on
  });
});

describe("dnd: auto-scroll", () => {
  it("scrolls the scroller under the pointer near its edge, and only while it can", () => {
    let frame: FrameRequestCallback | null = null;
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => { frame = cb; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { frame = null; });
    function Scroller() {
      return (
        <div data-testid="sc" data-rect="0 0 300 400" style={{ overflowY: "auto" }}>
          <Source id="a" rect="0 0 300 30" />
        </div>
      );
    }
    render(<Scroller />);
    const sc = screen.getByTestId("sc");
    Object.defineProperty(sc, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(sc, "clientHeight", { value: 400, configurable: true });
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 100, 390); // 10px from the bottom edge
    expect(frame).not.toBeNull();
    act(() => { frame!(0); });
    expect(sc.scrollTop).toBeGreaterThan(0);
    const after = sc.scrollTop;
    on("pointermove", 100, 200); // the middle: still
    act(() => { frame!(0); });
    expect(sc.scrollTop).toBe(after);
    on("pointerup", 100, 200);
    expect(frame).toBeNull();
  });
});

describe("dnd: the keyboard path", () => {
  function Menu() {
    const all = useDropTargets();
    const days = useDropTargets(["week-day"]);
    return <ul data-testid="menu" data-days={days.map((d) => d.id).join(",")}>{all.map((t) => <li key={t.kind + t.id}>{t.label ?? t.id}</li>)}</ul>;
  }
  const payload: TaskDragPayload = { taskIds: ["a"], source: "week", originId: "a" };

  it("lists what's mounted (not pointer-only or disabled targets) and follows mounting", () => {
    function Host() {
      const [more, setMore] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setMore(true)}>more</button>
          <Target target={{ kind: "week-day", id: "2026-10-09", label: "Fri 9 Oct" }} rect="0 0 1 1" />
          <Target target={{ kind: "today-slot", id: "2026-10-09@beam", data: { listed: false } }} rect="0 0 1 1" />
          <Target target={{ kind: "person", id: "u9", label: "Guest view" }} rect="0 0 1 1" disabled />
          {more && <Target target={{ kind: "project", id: "p1", label: "Launch" }} rect="0 0 1 1" />}
          <Menu />
        </>
      );
    }
    render(<Host />);
    expect(screen.getByTestId("menu").textContent).toBe("Fri 9 Oct");
    expect(screen.getByTestId("menu")).toHaveAttribute("data-days", "2026-10-09");
    fireEvent.click(screen.getByText("more"));
    expect(screen.getByTestId("menu").textContent).toBe("Fri 9 OctLaunch");
    expect(listDropTargets(["project"])).toEqual([{ kind: "project", id: "p1", label: "Launch" }]);
  });

  it("dropOnTarget runs the same handler, with accepts(); a slot takes a keyboard time", () => {
    const day = vi.fn(), slot = vi.fn();
    render(<>
      <Target target={{ kind: "week-day", id: "2026-10-09" }} rect="0 0 1 1" onDrop={day} accepts={(p) => !p.taskIds.includes("locked")} />
      <Target target={{ kind: "today-slot", id: "2026-10-09", data: { date: "2026-10-09" } }} rect="0 0 1 1" onDrop={slot} />
    </>);
    expect(dropOnTarget(payload, { kind: "week-day", id: "2026-10-09" })).toBe(true);
    expect(day).toHaveBeenCalledWith({ payload, target: { kind: "week-day", id: "2026-10-09" }, point: null, within: null, via: "keyboard" });
    expect(dropOnTarget({ ...payload, taskIds: ["locked"] }, { kind: "week-day", id: "2026-10-09" })).toBe(false);
    expect(dropOnTarget(payload, { kind: "week-day", id: "2026-10-10" })).toBe(false);
    expect(dropOnTarget(payload, { kind: "today-slot", id: "2026-10-09T14:45" })).toBe(true);
    expect(slot.mock.calls[0][0].target).toEqual({ kind: "today-slot", id: "2026-10-09T14:45", data: { date: "2026-10-09", minute: 14 * 60 + 45 } });
    expect(dropOnTarget({ ...payload, taskIds: [] }, { kind: "week-day", id: "2026-10-09" })).toBe(false);
  });

  it("useDragState is idle with nothing in the air", () => {
    let seen: unknown = null;
    function Probe() { seen = useDragState(); return null; }
    render(<Probe />);
    expect(seen).toEqual({ payload: null, over: null, point: null });
  });
});

describe("dnd: hints and menus", () => {
  it("a hint that follows the pointer reaches the ghost, never the menus", () => {
    let menus = 0;
    function Menu() { useDropTargets(); menus++; return null; }
    let state: ReturnType<typeof useDragState> | null = null;
    function Probe() { state = useDragState(); return null; }
    function Hinted() {
      const [n, setN] = useState(0);
      const t = useTaskDropTarget({ target: { kind: "today-slot", id: "d", label: "Today's plan" }, hint: n ? `slot ${n}` : undefined,
        onOver: () => setN((x) => x + 1), onDrop: () => {} });
      return <section {...t.bind} data-rect="200 0 400 100" />;
    }
    render(<><DragLayer /><Probe /><Source id="a" /><Hinted /><Menu /></>);
    press(screen.getByTestId("src-a"), 10, 10);
    on("pointermove", 20, 10);
    on("pointermove", 300, 50);
    const before = menus;
    on("pointermove", 300, 60);
    on("pointermove", 300, 70);
    expect(menus).toBe(before);
    expect(document.querySelector(".kdnd-ghost > span")?.textContent).toBe("→ slot 3");
    expect(state!.hint).toBe("slot 3");
    expect(state!.over).toEqual({ kind: "today-slot", id: "d", label: "Today's plan" });
    expect(listDropTargets()).toEqual([{ kind: "today-slot", id: "d", label: "Today's plan" }]);
    on("pointerup", 300, 70);
  });

  it("a menu re-renders only when what it lists changes", () => {
    let projects = 0;
    function Menu() { useDropTargets(["project"]); projects++; return null; }
    function Host() {
      const [n, setN] = useState(0);
      return (
        <>
          <button type="button" onClick={() => setN((x) => x + 1)}>more</button>
          {n > 0 && <Target target={{ kind: "week-day", id: "2026-10-09", label: "Fri 9 Oct" }} rect="0 0 1 1" />}
          {n > 1 && <Target target={{ kind: "project", id: "p1", label: "Launch" }} rect="0 0 1 1" />}
          <Menu />
        </>
      );
    }
    render(<Host />);
    const settle = projects;
    fireEvent.click(screen.getByText("more")); // a day mounts: Host re-renders the menu once, its list doesn't change
    expect(projects).toBe(settle + 1);
    fireEvent.click(screen.getByText("more")); // a project mounts: once for Host, once for the new list
    expect(projects).toBe(settle + 3);
  });
});

describe("dnd: targets written inline", () => {
  it("a fresh target object each render with the same contents doesn't churn the menus", () => {
    let renders = 0;
    function Both() {
      renders++;
      const all = useDropTargets();
      const t = useTaskDropTarget({ target: { kind: "section", id: "s1", label: "Doing", data: { projectId: "p1" } }, onDrop: () => {} });
      return <div {...t.bind} data-n={all.length} />;
    }
    render(<Both />);
    expect(renders).toBeLessThan(5);
    expect(listDropTargets(["section"])).toEqual([{ kind: "section", id: "s1", label: "Doing", data: { projectId: "p1" } }]);
  });
});
