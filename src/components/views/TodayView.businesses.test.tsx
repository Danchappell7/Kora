/* Today across businesses: time you've planned in another business is busy here (Plan my day works round
   it, free time leaves it out, and it isn't counted as a meeting), and All businesses' lead line sits in
   the brief, before its headline. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { TodayView, type TodayViewProps } from "./TodayView";
import { ToastProvider } from "../Toast";
import { localDayKey } from "./planCanvas";
import type { CalEvent, Task } from "../../data/types";

const task = (o: Partial<Task>): Task => ({
  id: "t", title: "x", description: "", status: "todo", priority: "medium",
  projectId: "p-personal", assigneeId: "me", tags: [], dependencies: [], subtasks: [], focusMin: 30, comments: 0, aiScore: 0, ...o,
});
const renderToday = (extra: Partial<TodayViewProps> = {}) => {
  const tasks = [task({ id: "deck", title: "Launch deck", dueDate: localDayKey(), focusMin: 60 })];
  const props: TodayViewProps = {
    tasks, allTasks: tasks, events: [], calendarConnected: true, currentUserId: "me", userName: "Daniel Okai",
    captureDefaults: { projectId: "p-personal", assigneeId: "me" }, onUpdate: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
    onRank: vi.fn(async () => "ai" as const), ranking: false, onStartFocus: vi.fn(), onShutdown: vi.fn(), setup: [], showSuggestions: true, ...extra,
  };
  return render(<ToastProvider><TodayView {...props} /></ToastProvider>);
};
const elsewhere: CalEvent = { id: "elsewhere-x", title: "Reco HQ · Investor call prep", start: 9 * 60, end: 17 * 60, kind: "break", calendarName: "Reco HQ" };

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: ["Date"] });
  const d = new Date(); d.setHours(8, 30, 0, 0); vi.setSystemTime(d);
});
afterEach(() => { vi.useRealTimers(); });

describe("TodayView · across businesses", () => {
  it("a block planned in another business is on the day, named, and not free time or a meeting", () => {
    const { unmount } = renderToday();
    const brief = () => screen.getByRole("region", { name: "Your day in brief" });
    const freeBefore = within(brief()).getByRole("button", { name: /free$/ }).textContent;
    unmount();
    renderToday({ busyElsewhere: [elsewhere] });
    expect(screen.getByText("Reco HQ · Investor call prep")).toBeInTheDocument();
    expect(within(brief()).getByRole("button", { name: /free$/ }).textContent).not.toBe(freeBefore);
    expect(within(brief()).queryByText(/meeting/)).toBeNull();
    // the one big thing can't go in the hours taken elsewhere
    expect(within(brief()).queryByText(/09:00|10:00|11:00/)).toBeNull();
  });

  it("All businesses' lead line sits in the brief, before the headline", () => {
    renderToday({ briefLead: <div role="note" aria-label="Across your businesses">Courtside Padel needs you most today</div> });
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    const lead = within(brief).getByRole("note", { name: "Across your businesses" });
    const head = within(brief).getByRole("heading", { level: 2 });
    expect(lead.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
