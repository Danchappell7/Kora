/* Today across businesses: time you've planned in another business is busy here (Plan my day works round
   it, free time leaves it out, it isn't counted as a meeting, and it opens its task), the line naming who
   needs you sits under the brief's words, and in All businesses a guest workspace's rows stay view-only. */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import { TodayView, type TodayViewProps } from "./TodayView";
import { ToastProvider } from "../Toast";
import { BusinessChipsProvider } from "../businesses/Businesses";
import { localDayKey } from "./planCanvas";
import { WORKSPACES } from "../../data/data";
import type { BusinessLead } from "../../lib/businesses";
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
const elsewhere: CalEvent = { id: "elsewhere-x", title: "Investor call prep", start: 9 * 60, end: 17 * 60, kind: "break",
  elsewhere: { workspaceId: "ws-reco", name: "Reco HQ", taskId: "t-32" } };

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
    const onOpen = vi.fn();
    renderToday({ busyElsewhere: [elsewhere], onOpen });
    expect(within(brief()).getByRole("button", { name: /free$/ }).textContent).not.toBe(freeBefore);
    expect(within(brief()).queryByText(/meeting/)).toBeNull();
    // the one big thing can't go in the hours taken elsewhere
    expect(within(brief()).queryByText(/09:00|10:00|11:00/)).toBeNull();
    // it says where it was planned (not "calendar"), and opens its task
    const block = screen.getByRole("button", { name: /^Investor call prep\s*, planned in Reco HQ/ });
    expect(block).not.toHaveTextContent(/calendar/);
    fireEvent.click(block);
    expect(onOpen).toHaveBeenCalledWith("t-32");
  });

  it("the line naming who needs you sits under the brief's words, before its figures", () => {
    const lead: BusinessLead = {
      lead: { key: "ws-courtside", workspace: WORKSPACES.find((w) => w.id === "ws-courtside")!, parts: ["sign the lighting order", "1 approval"], score: 6, taskId: "t-36", taskWhen: "overdue", detail: "1 approval · 1 overdue" },
      others: [], plain: "",
    };
    const onShowAll = vi.fn();
    renderToday({ businessLead: { lead, mode: "elsewhere", onShowAll } });
    const brief = screen.getByRole("region", { name: "Your day in brief" });
    const line = within(brief).getByRole("note", { name: "Your other workspaces" });
    expect(line).toHaveTextContent("Courtside Padel needs you: sign the lighting order (overdue) and 1 approval.");
    const head = within(brief).getByRole("heading", { level: 2 });
    expect(head.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const facts = within(brief).getByRole("group", { name: "Today at a glance" });
    expect(line.compareDocumentPosition(facts) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(within(line).getByRole("button", { name: "Show all businesses" }));
    expect(onShowAll).toHaveBeenCalled();
  });

  it("All businesses: a guest workspace's row is view-only and left out of Plan my day; no capture where you can't add", () => {
    const tasks = [
      task({ id: "mine", title: "Launch deck", projectId: "p-launch", workspaceId: "ws-foundrise", dueDate: localDayKey(), focusMin: 60 }),
      task({ id: "board", title: "Read the board pack", projectId: "p-northwind", workspaceId: "ws-harbour", dueDate: localDayKey(), focusMin: 30 }),
    ];
    const props: TodayViewProps = {
      tasks, allTasks: tasks, events: [], calendarConnected: true, currentUserId: "me", userName: "Daniel Okai",
      captureDefaults: { projectId: "p-northwind", assigneeId: "me" }, onUpdate: vi.fn(), onCreate: vi.fn(), onOpen: vi.fn(),
      onRank: vi.fn(async () => "ai" as const), ranking: false, onStartFocus: vi.fn(), onShutdown: vi.fn(), setup: [], showSuggestions: true, noCapture: true,
    };
    render(<ToastProvider><BusinessChipsProvider on workspaces={WORKSPACES} guestIn={new Set(["ws-harbour"])}><TodayView {...props} /></BusinessChipsProvider></ToastProvider>);
    expect(screen.queryByLabelText("Capture a task for today")).toBeNull();
    // your own row can be ticked; the guest workspace's can't
    expect(screen.getAllByRole("checkbox", { name: /Launch deck/ }).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("checkbox", { name: /Read the board pack/ })).toHaveLength(0);
    // Plan my day's suggestions leave it be
    expect(screen.queryByRole("button", { name: /Accept.*Read the board pack|Read the board pack.*suggested/ })).toBeNull();
  });
});
