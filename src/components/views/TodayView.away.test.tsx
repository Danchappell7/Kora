import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Task } from "../../data/types";
import type { Noticed } from "../../lib/noticed";
import { ToastProvider } from "../Toast";
import { TodayView, type TodayViewProps } from "./TodayView";

const task = (o: Partial<Task>): Task => ({
  id: "t1", title: "Task", description: "", status: "todo", priority: "medium", projectId: "p", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const card: Noticed = {
  id: "away:sana:2026-11-11", kind: "away", tone: "warn", icon: "calendar",
  title: "Sana's away when two tasks are due", body: "Sana is off 11–13 Nov, and “FAQ copy” and “Hero” are due then. Move them to Mon, when Sana's back?",
  actions: [{ kind: "away", label: "Move to Mon", userId: "sana", taskIds: ["a", "b"], to: "2026-11-16" }, { kind: "open", label: "Open it", taskId: "a" }],
};

beforeEach(() => { localStorage.clear(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date(2026, 10, 10, 9)); });
afterEach(() => { vi.useRealTimers(); });

describe("Today: work due while someone's away (0055)", () => {
  it("Kanbo noticed offers the move, makes it, and keeps it away for the day", () => {
    const onMove = vi.fn();
    const props: TodayViewProps = {
      tasks: [task({})], allTasks: [task({})], events: [], calendarConnected: true, currentUserId: "me", userName: "Daniel Okai",
      captureDefaults: { projectId: "p", assigneeId: "me" }, onUpdate: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
      onRank: vi.fn(async () => "ai" as const), ranking: false, onStartFocus: vi.fn(), onShutdown: vi.fn(), setup: [], showSuggestions: true,
      away: { noticed: [card], onMove },
    };
    const { rerender } = render(<ToastProvider><TodayView {...props} /></ToastProvider>);
    expect(screen.getByText("Sana's away when two tasks are due")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Move to Mon" }));
    expect(onMove).toHaveBeenCalledWith(["a", "b"], "2026-11-16", undefined);
    rerender(<ToastProvider><TodayView {...props} /></ToastProvider>);
    expect(screen.queryByText("Sana's away when two tasks are due")).toBeNull();
  });
});
