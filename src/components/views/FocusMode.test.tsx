import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FocusMode } from "./FocusMode";
import type { FocusTimer } from "../../hooks/useFocusTimer";

const timer = (o: Partial<FocusTimer> = {}): FocusTimer => ({
  running: false, setRunning: vi.fn(), seconds: 0, reset: vi.fn(), targetMin: 25, setTargetMin: vi.fn(),
  taskId: "", setTaskId: vi.fn(), weekMin: 0, endSession: vi.fn(() => 0), pomodoro: false, setPomodoro: vi.fn(),
  phase: "work", cyclesToday: 0, focusMinToday: 0, notice: null, notifyPermission: "granted", requestNotify: vi.fn(), ...o,
});

beforeEach(() => { document.body.innerHTML = ""; });

describe("FocusMode", () => {
  it("is a labelled modal dialog that lands focus on the main control", () => {
    render(<FocusMode focus={timer()} tasks={[]} onClose={vi.fn()} onOpenTask={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Focus mode" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Start focus timer" }));
    expect(screen.getByRole("button", { name: "Reset timer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "25-minute session" })).toHaveAttribute("aria-pressed", "true");
  });

  it("labels Pause while running and closes on Escape", () => {
    const onClose = vi.fn();
    render(<FocusMode focus={timer({ running: true, seconds: 61 })} tasks={[]} onClose={onClose} onOpenTask={vi.fn()} />);
    const pause = screen.getByRole("button", { name: "Pause focus timer" });
    fireEvent.keyDown(pause, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("confirms what End banked", () => {
    render(<FocusMode focus={timer({ seconds: 600, endSession: vi.fn(() => 10) })} tasks={[]} onClose={vi.fn()} onOpenTask={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /End session/ }));
    expect(screen.getByText("Banked 10m of deep work")).toBeInTheDocument();
  });

  it("offers notifications only while permission hasn't been asked", () => {
    const requestNotify = vi.fn();
    const { rerender } = render(<FocusMode focus={timer({ notifyPermission: "default", requestNotify })} tasks={[]} onClose={vi.fn()} onOpenTask={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Notify me when time's up/ }));
    expect(requestNotify).toHaveBeenCalled();
    rerender(<FocusMode focus={timer({ notifyPermission: "denied" })} tasks={[]} onClose={vi.fn()} onOpenTask={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /Notify me/ })).not.toBeInTheDocument();
  });

  it("doesn't start from an invisible frame (no opacity-0 entrance)", () => {
    render(<FocusMode focus={timer()} tasks={[]} onClose={vi.fn()} onOpenTask={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("style") ?? "").not.toMatch(/fadeIn/);
  });
});
