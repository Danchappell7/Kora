import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { PlanView } from "./PlanView";
import { ToastProvider } from "../Toast";
import { localDayKey, PLAN_DAY_KEY, PLAN_CARRY_KEY } from "./planCanvas";
import type { Task } from "../../data/types";

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

beforeEach(() => { localStorage.clear(); localStorage.setItem(PLAN_DAY_KEY, localDayKey()); });
afterEach(() => { vi.useRealTimers(); });

describe("PlanView", () => {
  it("doesn't crash on a quick-added task with no energy or duration", () => {
    renderPlan([task({ id: "q1", title: "Call supplier", planToday: true, scheduled: null, energy: undefined, dur: undefined })]);
    expect(screen.getByText("Call supplier")).toBeInTheDocument();
  });

  it("doesn't crash when a placed block has no energy", () => {
    renderPlan([task({ id: "b1", title: "Imported block", planToday: true, scheduled: 9 * 60, energy: undefined })]);
    expect(screen.getByRole("button", { name: /Imported block, 9am – 9:30am/ })).toBeInTheDocument();
  });

  it("leaves finished tasks off the canvas", () => {
    renderPlan([
      task({ id: "open", title: "Still to do", planToday: true, scheduled: 9 * 60 }),
      task({ id: "done", title: "Already done", planToday: true, scheduled: 10 * 60, status: "done" }),
    ]);
    expect(screen.getByText("Still to do")).toBeInTheDocument();
    expect(screen.queryByText("Already done")).not.toBeInTheDocument();
  });

  it("opens a block on click without writing anything", () => {
    const { onUpdate, onOpen } = renderPlan([task({ id: "b1", title: "Write brief", planToday: true, scheduled: 9 * 60 + 7 })]);
    const btn = screen.getByRole("button", { name: /^Write brief,/ });
    fireEvent.pointerDown(btn, { button: 0, pointerType: "mouse", clientX: 100, clientY: 100 });
    fireEvent.pointerUp(window, { pointerType: "mouse", clientX: 100, clientY: 100 });
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledWith("b1");
    expect(onUpdate).not.toHaveBeenCalled();
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
    btn.focus();
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
    localStorage.setItem(PLAN_DAY_KEY, yesterday());
    const { onUpdate } = renderPlan([
      task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 }),
      task({ id: "b", title: "B", planToday: true, scheduled: 11 * 60 }),
      task({ id: "c", title: "Maya's", planToday: true, scheduled: 13 * 60, assigneeId: "maya" }),
      task({ id: "d", title: "Done", planToday: true, scheduled: 14 * 60, status: "done" }),
    ]);
    const banner = screen.getByRole("region", { name: /Unfinished blocks/ });
    expect(within(banner).getByText(/Yesterday's plan: 2 unfinished blocks/)).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole("button", { name: "Carry over" }));
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: null });
    expect(onUpdate).toHaveBeenCalledWith("b", { scheduled: null });
    expect(screen.queryByRole("region", { name: /Unfinished blocks/ })).not.toBeInTheDocument();
    expect(localStorage.getItem(PLAN_DAY_KEY)).toBe(localDayKey());
    // Undo puts them back where they were
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: 9 * 60, planToday: true });
  });

  it("Clear takes yesterday's blocks off today entirely", () => {
    localStorage.setItem(PLAN_DAY_KEY, yesterday());
    const { onUpdate } = renderPlan([task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })]);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onUpdate).toHaveBeenCalledWith("a", { scheduled: null, planToday: false });
  });

  it("doesn't prompt again the same day, and keeps a pending prompt across visits", () => {
    localStorage.setItem(PLAN_DAY_KEY, yesterday());
    const tasks = [task({ id: "a", title: "A", planToday: true, scheduled: 9 * 60 })];
    const first = renderPlan(tasks);
    expect(screen.getByText(/1 unfinished block/)).toBeInTheDocument();
    first.unmount();
    expect(JSON.parse(localStorage.getItem(PLAN_CARRY_KEY) || "{}").ids).toEqual(["a"]);
    renderPlan(tasks);
    expect(screen.getByText(/1 unfinished block/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Keep them where they are" }));
    expect(screen.queryByText(/unfinished block/)).not.toBeInTheDocument();
    expect(localStorage.getItem(PLAN_CARRY_KEY)).toBeNull();
  });

  it("announces plan updates in a live region and points capture at q", () => {
    renderPlan([task({ id: "i1", title: "Expenses", planToday: true, scheduled: null })]);
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(screen.queryByText("⌘K")).not.toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "q" });
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: /Capture a task/ }));
  });
});
