/* The workspace switcher's signals: each workspace's unread count and a needs-you dot, and a dot on the
   switcher itself while another workspace has something for you. */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { ToastProvider } from "./Toast";
import type { FocusTimer } from "../hooks/useFocusTimer";
import type { Workspace } from "../data/types";

const focus = { running: false, setRunning: vi.fn(), seconds: 0, endSession: () => 0, focusMinToday: 0 } as unknown as FocusTimer;
const workspaces: Workspace[] = [
  { id: null, name: "Personal", kind: "personal" },
  { id: "w-a", name: "Alpha Studio", kind: "team" },
  { id: "w-b", name: "Beta Padel", kind: "team" },
];
const renderSidebar = (signals?: Map<string, { unread: number; attention: number; detail: string }>, workspace = "w-a") => render(
  <ToastProvider>
    <Sidebar route={{ view: "plan" }} setRoute={vi.fn()} workspace={workspace} setWorkspace={vi.fn()} workspaces={workspaces} onNewWorkspace={vi.fn()}
      focus={focus} openFocus={vi.fn()} tasks={[]} projects={[]} inboxCount={0} currentUserId="me" onNewProject={vi.fn()} onDeleteProject={vi.fn()}
      onUpgrade={() => {}} onManageBilling={() => {}} myRole="owner" wsSignals={signals} />
  </ToastProvider>,
);

describe("Sidebar · the switcher's signals", () => {
  it("each workspace says what's unread and what needs you; the switcher says another workspace has something", () => {
    renderSidebar(new Map([
      ["personal", { unread: 0, attention: 0, detail: "" }],
      ["w-a", { unread: 3, attention: 0, detail: "" }],
      ["w-b", { unread: 2, attention: 3, detail: "1 approval · 2 overdue" }],
    ]));
    const switcher = screen.getByRole("button", { name: /^Switch workspace, current: Alpha Studio/ });
    expect(switcher).toHaveAccessibleName("Switch workspace, current: Alpha Studio. Another workspace has something for you");
    fireEvent.click(switcher);
    const menu = screen.getByRole("dialog", { name: "Workspaces" });
    expect(within(menu).getByRole("button", { name: "Beta Padel, 2 unread, needs you: 1 approval · 2 overdue" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Alpha Studio, 3 unread" })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: "Personal" })).toBeInTheDocument();
  });

  it("nothing elsewhere (or no signals at all): no dot, plain names", () => {
    const { unmount } = renderSidebar(new Map([["w-a", { unread: 4, attention: 1, detail: "1 overdue" }]]));
    expect(screen.getByRole("button", { name: "Switch workspace, current: Alpha Studio" })).toBeInTheDocument();
    unmount();
    renderSidebar(undefined);
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace, current: Alpha Studio" }));
    expect(within(screen.getByRole("dialog", { name: "Workspaces" })).getByRole("button", { name: "Beta Padel" })).toBeInTheDocument();
  });
});
