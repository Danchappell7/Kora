import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { MyWeekView } from "./MyWeekView";
import { ToastProvider } from "../Toast";
import { dayOffset } from "../../data/data";
import { useTaskDragSource, __resetDnd } from "../../lib/dnd";
import { loadAllChunks } from "../../lib/lazyLoad";
import type { Task } from "../../data/types";

// a fixed Friday morning, before the modules read "today" (KANBO_TODAY)
vi.hoisted(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 9, 9, 0, 0));
});

// jsdom has no PointerEvent: without one, pointerId/pointerType/button never reach the drag kit
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
  projectId: "p-personal", assigneeId: "me", tags: [], dependencies: [],
  subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});

function renderWeek(tasks: Task[]) {
  const onPatch = vi.fn();
  render(<ToastProvider><MyWeekView tasks={tasks} onOpen={vi.fn()} onPatch={onPatch} currentUserId="me" /></ToastProvider>);
  return { onPatch };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("MyWeekView — Pull to today", () => {
  it("only moves overdue tasks assigned to me, and Undo restores their dates", () => {
    const { onPatch } = renderWeek([
      task({ id: "a", title: "Mine", dueDate: dayOffset(-2) }),
      task({ id: "b", title: "Maya's", dueDate: dayOffset(-3), assigneeId: "maya", collaborators: ["me"] }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Pull my 1 to today" }));
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: dayOffset(0) });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onPatch).toHaveBeenLastCalledWith("a", { dueDate: dayOffset(-2) });
  });

  it("asks first when moving more than three", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { onPatch } = renderWeek([1, 2, 3, 4].map((i) => task({ id: "o" + i, title: "Old " + i, dueDate: dayOffset(-i) })));
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(confirm).toHaveBeenCalled();
    expect(onPatch).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(onPatch).toHaveBeenCalledTimes(4);
  });

  it("doesn't ask for three or fewer", () => {
    const confirm = vi.spyOn(window, "confirm");
    const { onPatch } = renderWeek([task({ id: "a", dueDate: dayOffset(-1) })]);
    fireEvent.click(screen.getByRole("button", { name: "Pull all to today" }));
    expect(confirm).not.toHaveBeenCalled();
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  it("hides the button when none of the overdue tasks are mine", () => {
    renderWeek([task({ id: "b", dueDate: dayOffset(-3), assigneeId: "maya" })]);
    expect(screen.queryByRole("button", { name: /to today/ })).not.toBeInTheDocument();
  });

  it("lets long lists expand", () => {
    renderWeek(Array.from({ length: 20 }, (_, i) => task({ id: "n" + i, title: "No date " + i })));
    expect(screen.queryByText("No date 19")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show all 20 unscheduled tasks" }));
    expect(screen.getByText("No date 19")).toBeInTheDocument();
  });
});

describe("MyWeekView — moving work between days", () => {
  // the week laid out: day columns 150px apart (140 wide, 400 tall), each with its time strip down
  // its left edge (16px, from 36 to 392); "No date" underneath at y 500–600
  const ISO = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const weekIsos = () => { const t = new Date(); t.setHours(0, 0, 0, 0); const m = new Date(t); m.setDate(t.getDate() - ((t.getDay() + 6) % 7)); return Array.from({ length: 7 }, (_, i) => { const d = new Date(m); d.setDate(m.getDate() + i); return ISO(d); }); };
  beforeEach(() => {
    const isos = weekIsos();
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      let r = { left: 0, top: 0, right: 0, bottom: 0 };
      const day = el.closest?.("[data-day]") as HTMLElement | null;
      if (day) {
        const x = isos.indexOf(day.dataset.day!) * 150;
        r = el.classList.contains("kweek-times") ? { left: x, top: 36, right: x + 16, bottom: 392 }
          : el === day ? { left: x, top: 0, right: x + 140, bottom: 400 } : { left: x + 20, top: 40, right: x + 130, bottom: 70 };
      } else if (el.classList.contains("kweek-nodate")) r = { left: 0, top: 500, right: 1000, bottom: 600 };
      else if (el.closest?.(".kweek-nodate")) r = { left: 10, top: 520, right: 200, bottom: 560 };
      return { ...r, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, toJSON() { return r; } } as DOMRect;
    });
  });
  afterEach(() => { act(() => { __resetDnd(); }); });
  const on = (type: string, x: number, y: number) =>
    act(() => { window.dispatchEvent(new window.PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, pointerId: 1, pointerType: "mouse" })); });
  const drag = (el: Element, to: [number, number]) => {
    fireEvent.pointerDown(el, { clientX: 5, clientY: 5, button: 0, pointerId: 1, pointerType: "mouse" });
    on("pointermove", 30, 30);
    on("pointermove", to[0], to[1]);
    on("pointerup", to[0], to[1]);
  };
  const chipOf = (title: string) => screen.getByRole("button", { name: new RegExp(`^${title}`) }).closest("[data-task-id]")!;
  const dayCol = (iso: string) => document.querySelector(`[data-day="${iso}"]`)!;
  const xOf = (iso: string) => weekIsos().indexOf(iso) * 150;
  // a day of this week other than today, and the day in the grid it lands on
  const otherDay = () => { const d = new Date(); const dow = (d.getDay() + 6) % 7; return dayOffset(dow === 6 ? -1 : 1); };
  const undo = () => { const b = screen.getByRole("button", { name: "Undo" }); fireEvent.pointerDown(b); fireEvent.click(b); };

  it("shows seven days, Monday first, with today marked", () => {
    renderWeek([]);
    const cols = document.querySelectorAll("[data-day]");
    expect(cols).toHaveLength(7);
    expect(cols[0].querySelector("h3")?.getAttribute("aria-label")).toMatch(/^Monday /);
    expect(document.querySelector(`[data-day="${dayOffset(0)}"]`)).toHaveAttribute("data-today", "true");
  });

  it("dragging a chip onto a day gives it that due date, and Undo puts it back", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Loose end" })]);
    const to = otherDay();
    fireEvent.pointerDown(chipOf("Loose end"), { clientX: 5, clientY: 5, button: 0, pointerId: 1, pointerType: "mouse" });
    on("pointermove", 30, 30);
    on("pointermove", xOf(to) + 100, 200);
    expect(dayCol(to)).toHaveAttribute("data-drop", "true");
    expect(chipOf("Loose end")).toHaveAttribute("data-dragging", "true");
    on("pointerup", xOf(to) + 100, 200);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: to });
    undo();
    expect(onPatch).toHaveBeenLastCalledWith("a", { dueDate: undefined });
  });

  it("dropping a chip back on its own day writes nothing; letting go over nothing neither", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Today's", dueDate: dayOffset(0) })]);
    drag(chipOf("Today's"), [xOf(dayOffset(0)) + 100, 200]);
    drag(chipOf("Today's"), [2000, 2000]);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("the day's time strip gives it a time too (on the quarter hour), and says which while it's over it", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Call Sana" })]);
    const to = otherDay();
    fireEvent.pointerDown(chipOf("Call Sana"), { clientX: 5, clientY: 5, button: 0, pointerId: 1, pointerType: "mouse" });
    on("pointermove", 30, 30);
    // the strip runs 07:00–21:00 over 356px: 214px down is 07:00 + 0.601 × 14h = 15:25 → 15:30
    on("pointermove", xOf(to) + 8, 36 + 214);
    expect(dayCol(to).querySelector(".kweek-times")).toHaveAttribute("data-over", "true");
    expect(dayCol(to).querySelector(".kweek-mark")?.textContent).toBe("15:30");
    on("pointerup", xOf(to) + 8, 36 + 214);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: to, dueTime: "15:30" });
  });

  it("several days' chips keep their times; a day lists the timed ones first", () => {
    renderWeek([task({ id: "u", title: "Untimed", dueDate: dayOffset(0) }), task({ id: "t", title: "Timed", dueDate: dayOffset(0), dueTime: "09:30" })]);
    const titles = Array.from(dayCol(dayOffset(0)).querySelectorAll(".kweek-chip-title")).map((e) => e.textContent);
    expect(titles).toEqual(["Timed", "Untimed"]);
    expect(dayCol(dayOffset(0)).querySelector(".kweek-chip-time")?.textContent).toBe("09:30");
  });

  it("“No date” takes a date (and its time) off; it shows up only while something dated is in the air", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Dated", dueDate: dayOffset(0), dueTime: "10:00" })]);
    expect(screen.queryByText("No date")).not.toBeInTheDocument();
    fireEvent.pointerDown(chipOf("Dated"), { clientX: 5, clientY: 5, button: 0, pointerId: 1, pointerType: "mouse" });
    on("pointermove", 30, 30);
    expect(screen.getByText("Drop here to take the date off")).toBeInTheDocument();
    on("pointermove", 400, 550);
    on("pointerup", 400, 550);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: undefined, dueTime: undefined });
    expect(screen.queryByText("Drop here to take the date off")).not.toBeInTheDocument();
  });

  it("takes tasks dragged from elsewhere (the Inbox, a list), but not someone else's or finished ones", () => {
    function Elsewhere({ ids }: { ids: string[] }) {
      const src = useTaskDragSource({ taskIds: ids, source: "inbox", originId: "act-1" });
      return <div {...src.bind} data-testid="inbox-row">row</div>;
    }
    const onPatch = vi.fn();
    render(<ToastProvider><Elsewhere ids={["a", "x", "d"]} /><MyWeekView tasks={[task({ id: "a", title: "Mine" }), task({ id: "d", title: "Finished", status: "done" })]} onOpen={vi.fn()} onPatch={onPatch} currentUserId="me" /></ToastProvider>);
    const to = otherDay();
    drag(screen.getByTestId("inbox-row"), [xOf(to) + 100, 200]);
    expect(onPatch).toHaveBeenCalledTimes(1);
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: to });
    expect(screen.getByText(/^Moved “Mine” to/)).toBeInTheDocument();
  });

  it("the keyboard path: “Move to…” lists the days and next week", async () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Loose end" })]);
    fireEvent.click(screen.getByRole("button", { name: "Move “Loose end” to another day" }));
    const menu = await screen.findByRole("menu", { name: "Move “Loose end” to" });
    const items = within(menu).getAllByRole("menuitemradio");
    expect(items).toHaveLength(8);
    expect(items.some((i) => /^Today/.test(i.textContent ?? ""))).toBe(true);
    fireEvent.click(within(menu).getByRole("menuitemradio", { name: /^Next week/ }));
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: expect.any(String) });
    const next = onPatch.mock.calls[0][1].dueDate as string;
    expect(new Date(next + "T00:00:00").getDay()).toBe(1); // a Monday
    expect(next > dayOffset(0)).toBe(true);
  });

  it("Shift+F10 on a chip opens the same menu", async () => {
    renderWeek([task({ id: "a", title: "Loose end" })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Loose end/ }), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Move “Loose end” to" })).toBeInTheDocument();
  });

  it("a guest can look but not move anything", () => {
    render(<ToastProvider><MyWeekView tasks={[task({ id: "a", title: "Loose end", dueDate: dayOffset(-2) })]} onOpen={vi.fn()} onPatch={vi.fn()} currentUserId="me" readOnly /></ToastProvider>);
    expect(screen.queryByRole("button", { name: /to another day/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /to today/ })).not.toBeInTheDocument();
    screen.getAllByRole("button", { name: "Loose end" }).forEach((b) => expect(b.closest("[data-task-id]")).not.toHaveAttribute("data-kdnd-source"));
    expect(document.querySelector(".kweek-times")).toBeNull();
    expect(document.querySelector("[data-kdnd-target]")).toBeNull();
  });

  it("S opens Schedule…: a day and a time from the keyboard (↑/↓ by 15 minutes, ←/→ a day)", async () => {
    await loadAllChunks();
    const { onPatch } = renderWeek([task({ id: "a", title: "Loose end", dueDate: dayOffset(0), dueTime: "10:00" })]);
    fireEvent.keyDown(screen.getByRole("button", { name: /^Loose end/ }), { key: "s" });
    const dialog = await screen.findByRole("dialog", { name: "Schedule “Loose end”" });
    const list = within(dialog).getByRole("listbox", { name: "Start time" });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("10:00, free");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("11:15, free");
    const days = within(dialog).getByRole("radiogroup", { name: "Day" });
    const checked = () => within(days).getByRole("radio", { checked: true }).textContent;
    expect(checked()).toBe("Today");
    fireEvent.keyDown(list, { key: "ArrowRight" });
    const moved = checked();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledTimes(1);
    const [id, patch] = onPatch.mock.calls[0];
    expect(id).toBe("a");
    expect(patch.dueTime).toBe("11:15");
    // (on a Sunday there's no later day this week but Next week's Monday)
    expect(moved === "Today" ? patch.dueDate : patch.dueDate > dayOffset(0)).toBeTruthy();
  });

  it("Schedule… offers “Any time”: the day without a time", async () => {
    await loadAllChunks();
    const { onPatch } = renderWeek([task({ id: "a", title: "Loose end", dueDate: dayOffset(0), dueTime: "10:00" })]);
    fireEvent.click(screen.getByRole("button", { name: "Move “Loose end” to another day" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Pick a day and time/ }));
    const list = within(await screen.findByRole("dialog", { name: "Schedule “Loose end”" })).getByRole("listbox");
    fireEvent.keyDown(list, { key: "Home" });
    expect(within(list).getByRole("option", { selected: true })).toHaveAccessibleName("Any time");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(onPatch).toHaveBeenCalledWith("a", { dueTime: undefined });
    expect(screen.getByText("“Loose end” is due today, any time")).toBeInTheDocument();
  });

  it("the header counts this week's wins", () => {
    renderWeek([task({ id: "d", status: "done", completedAt: dayOffset(0) })]);
    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Completed over the last seven days/ })).toBeInTheDocument();
  });
});
