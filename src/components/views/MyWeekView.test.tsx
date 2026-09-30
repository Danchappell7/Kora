import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { MyWeekView } from "./MyWeekView";
import { ToastProvider } from "../Toast";
import { dayOffset } from "../../data/data";
import type { Task } from "../../data/types";

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
  // jsdom has no DataTransfer
  const transfer = () => {
    const data: Record<string, string> = {};
    return {
      types: [] as string[], effectAllowed: "", dropEffect: "",
      setData(k: string, v: string) { data[k] = v; if (!this.types.includes(k)) this.types.push(k); },
      getData(k: string) { return data[k] ?? ""; },
    };
  };
  const chipOf = (title: string) => screen.getByRole("button", { name: title }).closest("[data-task-id]")!;
  const dayCol = (iso: string) => document.querySelector(`[data-day="${iso}"]`)!;
  // a day of this week other than today, and the day in the grid it lands on
  const otherDay = () => { const d = new Date(); const dow = (d.getDay() + 6) % 7; return dayOffset(dow === 6 ? -1 : 1); };

  it("shows seven days, Monday first, with today marked", () => {
    renderWeek([]);
    const cols = document.querySelectorAll("[data-day]");
    expect(cols).toHaveLength(7);
    expect(cols[0].querySelector("h3")?.getAttribute("aria-label")).toMatch(/^Monday /);
    expect(document.querySelector(`[data-day="${dayOffset(0)}"]`)).toHaveAttribute("data-today", "true");
  });

  it("dragging a chip onto a day gives it that due date, and Undo puts it back", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Loose end" })]);
    const d = transfer();
    const to = otherDay();
    fireEvent.dragStart(chipOf("Loose end"), { dataTransfer: d });
    fireEvent.dragOver(dayCol(to), { dataTransfer: d });
    expect(dayCol(to)).toHaveAttribute("data-drop", "true");
    fireEvent.drop(dayCol(to), { dataTransfer: d });
    expect(onPatch).toHaveBeenCalledWith("a", { dueDate: to });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onPatch).toHaveBeenLastCalledWith("a", { dueDate: undefined });
  });

  it("dropping a chip back on its own day writes nothing", () => {
    const { onPatch } = renderWeek([task({ id: "a", title: "Today's", dueDate: dayOffset(0) })]);
    const d = transfer();
    fireEvent.dragStart(chipOf("Today's"), { dataTransfer: d });
    fireEvent.drop(dayCol(dayOffset(0)), { dataTransfer: d });
    expect(onPatch).not.toHaveBeenCalled();
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
    fireEvent.keyDown(screen.getByRole("button", { name: "Loose end" }), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu", { name: "Move “Loose end” to" })).toBeInTheDocument();
  });

  it("a guest can look but not move anything", () => {
    render(<ToastProvider><MyWeekView tasks={[task({ id: "a", title: "Loose end", dueDate: dayOffset(-2) })]} onOpen={vi.fn()} onPatch={vi.fn()} currentUserId="me" readOnly /></ToastProvider>);
    expect(screen.queryByRole("button", { name: /to another day/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /to today/ })).not.toBeInTheDocument();
    screen.getAllByRole("button", { name: "Loose end" }).forEach((b) => expect(b.closest("[data-task-id]")).not.toHaveAttribute("draggable"));
  });

  it("the header counts this week's wins", () => {
    renderWeek([task({ id: "d", status: "done", completedAt: dayOffset(0) })]);
    expect(screen.getByText("1 done")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Completed over the last seven days/ })).toBeInTheDocument();
  });
});
