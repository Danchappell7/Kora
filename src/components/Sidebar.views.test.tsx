import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import type { TaskDropTargetOptions } from "../lib/dnd";

/* the drag kit is u3's: capture what the project rows register */
const targets: TaskDropTargetOptions[] = [];
vi.mock("../lib/dnd", async (orig) => {
  const real = await orig<typeof import("../lib/dnd")>();
  return {
    ...real,
    useTaskDropTarget: (o: TaskDropTargetOptions) => {
      targets.push(o);
      return { bind: { ref: () => undefined, "data-kdnd-target": o.disabled ? undefined : o.target.kind }, isOver: false, canDrop: false, payload: null };
    },
  };
});

// jsdom has no PointerEvent: without one, pointerType/button never reach the handlers
if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  (window as unknown as { PointerEvent: typeof PointerEventPolyfill }).PointerEvent = PointerEventPolyfill;
}

import { Sidebar, warmSavedViewUi } from "./Sidebar";
import { ToastProvider, ACTION_TOAST_MIN_MS } from "./Toast";
import type { FocusTimer } from "../hooks/useFocusTimer";
import type { Role, SavedView, Task } from "../data/types";
import type { Route } from "../app-types";
import { WORKSPACES, PROJECTS } from "../data/data";
import { useSavedViews, resetSavedViewsForTests, getSavedView, warmSavedViews } from "../lib/views";

beforeAll(async () => { await warmSavedViews(); await warmSavedViewUi(); });

const focus = { running: false, setRunning: vi.fn(), seconds: 0, endSession: () => 0, focusMinToday: 0 } as unknown as FocusTimer;
const task = (id: string, extra: Partial<Task>): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "m-self",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws-foundrise", ...extra,
});
const TASKS = [
  task("deck", { priority: "urgent" }),
  task("blocked", { status: "blocked", assigneeId: "m-1" }),
  task("tokens", { status: "review", tags: ["design"], projectId: "p-brand" }),
];

type Opts = { route?: Route; myRole?: Role; currentUserId?: string; viewCounts?: Record<string, number | null>; onDropTasksOnProject?: (ids: string[], pid: string) => void; onEditView?: (v: SavedView) => void };
function Harness({ o, setRoute }: { o: Opts; setRoute: (r: Route) => void }) {
  const uid = o.currentUserId ?? "m-self";
  const { views } = useSavedViews("ws-foundrise", uid);
  return (
    <Sidebar route={o.route ?? { view: "plan" }} setRoute={setRoute} workspace="ws-foundrise" setWorkspace={vi.fn()} workspaces={WORKSPACES}
      focus={focus} openFocus={vi.fn()} tasks={TASKS} projects={PROJECTS} inboxCount={0} currentUserId={uid}
      onNewProject={vi.fn()} onDeleteProject={vi.fn()} onNewWorkspace={vi.fn()} onUpgrade={vi.fn()} onManageBilling={vi.fn()}
      myRole={o.myRole ?? "owner"} guardRoute={false} views={views} viewCounts={o.viewCounts} onDropTasksOnProject={o.onDropTasksOnProject} onEditView={o.onEditView} />
  );
}
async function renderViews(o: Opts = {}) {
  const setRoute = vi.fn();
  const r = render(<ToastProvider><Harness o={o} setRoute={setRoute} /></ToastProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { ...r, setRoute, rerender: (n: Opts) => r.rerender(<ToastProvider><Harness o={{ ...o, ...n }} setRoute={setRoute} /></ToastProvider>) };
}
const group = () => screen.getByRole("group", { name: "Saved views" });
const rowNames = () => within(group()).getAllByRole("button").filter((b) => b.classList.contains("knav") && b.hasAttribute("data-view-id")).map((b) => b.querySelector(".knav-label")!.textContent);
const openMenu = (name: string) => fireEvent.click(screen.getByRole("button", { name: `Options for view ${name}` }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  try { localStorage.clear(); sessionStorage.clear(); } catch { /* ignore */ }
  resetSavedViewsForTests();
  targets.length = 0;
});
afterEach(() => { vi.useRealTimers(); });

describe("Sidebar › Views", () => {
  it("lists the pinned views under My tasks with live counts and a shared mark; the rest are an “All views” away", async () => {
    await renderViews();
    expect(rowNames()).toEqual(["Urgent and mine", "Blocked in the launch", "Design in review"]);
    expect(screen.getByRole("button", { name: "Urgent and mine, 1 task" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blocked in the launch, 1 task, shared with Foundrise" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "All views, 2 more" })).toHaveAttribute("aria-haspopup", "dialog");
    // the old saved-search rows are gone in views mode
    expect(screen.queryByRole("button", { name: /^Remove saved list/ })).not.toBeInTheDocument();
  });

  it("takes the host's counts when given (null: no count)", async () => {
    await renderViews({ viewCounts: { "sv-demo-urgent": 12, "sv-demo-blocked": null } });
    expect(screen.getByRole("button", { name: "Urgent and mine, 12 tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Blocked in the launch, shared with Foundrise" })).toBeInTheDocument();
  });

  it("opens a view where it lives, and marks it as the page instead of My tasks / the project", async () => {
    const s = await renderViews();
    fireEvent.click(screen.getByRole("button", { name: /^Blocked in the launch/ }));
    expect(s.setRoute).toHaveBeenCalledWith({ view: "project", projectId: "p-launch", tab: "board", savedViewId: "sv-demo-blocked" });
    s.rerender({ route: { view: "project", projectId: "p-launch", tab: "board", savedViewId: "sv-demo-blocked" } });
    expect(screen.getByRole("button", { name: /^Blocked in the launch/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^Q3 Product Launch/ })).not.toHaveAttribute("aria-current");
    s.rerender({ route: { view: "tasks", savedViewId: "sv-demo-urgent" } });
    expect(screen.getByRole("button", { name: /^Urgent and mine/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^My tasks/ })).not.toHaveAttribute("aria-current");
  });

  it("⋯ (or a right-click) has everything an owner of the view can do", async () => {
    await renderViews();
    openMenu("Urgent and mine");
    const menu = screen.getByRole("menu", { name: "Options for view Urgent and mine" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent?.replace(/[⌥↑↓]|F2/g, "").trim())).toEqual([
      "Rename", "Edit view…", "Change icon…", "Share with Foundrise", "Unpin from sidebar", "Move up", "Move down", "Copy link", "Delete view",
    ]);
    expect(within(menu).getByRole("menuitem", { name: /Move up/ })).toBeDisabled();
    fireEvent.keyDown(menu, { key: "Escape" });
    fireEvent.contextMenu(screen.getByRole("button", { name: /^Design in review/ }));
    expect(screen.getByRole("menu", { name: "Options for view Design in review" })).toBeInTheDocument();
  });

  it("a guest can use a shared view but not change it: details, hide for themselves, order, link", async () => {
    await renderViews({ myRole: "guest", currentUserId: "m-4" });
    expect(rowNames()).toEqual(["Blocked in the launch"]);
    openMenu("Blocked in the launch");
    const items = within(screen.getByRole("menu")).getAllByRole("menuitem").map((m) => m.textContent?.replace(/[⌥↑↓]/g, "").trim());
    expect(items).toEqual(["About this view…", "Hide from my sidebar", "Move up", "Move down", "Copy link"]);
  });

  it("an admin may edit a teammate's shared view: unpinning it is for everyone", async () => {
    await renderViews();
    openMenu("Blocked in the launch");
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin for everyone" }));
    await act(async () => { await Promise.resolve(); });
    expect(rowNames()).toEqual(["Urgent and mine", "Design in review"]);
    expect(screen.getByRole("status")).toHaveTextContent("Unpinned “Blocked in the launch” for everyone");
    expect(group().querySelector("[aria-live]")).not.toHaveAttribute("role");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Undo" })); await Promise.resolve(); });
    expect(rowNames()).toEqual(["Urgent and mine", "Blocked in the launch", "Design in review"]);
  });

  it("renames in place: Enter saves, Escape keeps the old name, focus comes back to the row", async () => {
    await renderViews();
    openMenu("Urgent and mine");
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename/ }));
    const field = screen.getByRole("textbox", { name: "Rename view Urgent and mine" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "On fire" } });
    await act(async () => { fireEvent.keyDown(field, { key: "Enter" }); await Promise.resolve(); });
    expect(getSavedView("sv-demo-urgent")!.name).toBe("On fire");
    expect(screen.getByRole("button", { name: /^On fire/ })).toHaveFocus();
    // F2 on the row renames too
    fireEvent.keyDown(screen.getByRole("button", { name: /^On fire/ }), { key: "F2" });
    const again = screen.getByRole("textbox", { name: "Rename view On fire" });
    fireEvent.change(again, { target: { value: "Nope" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(getSavedView("sv-demo-urgent")!.name).toBe("On fire");
  });

  it("deletes with Undo, and only for real once the Undo window closes", async () => {
    await renderViews();
    openMenu("Design in review");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete view" }));
    expect(rowNames()).toEqual(["Urgent and mine", "Blocked in the launch"]);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rowNames()).toContain("Design in review");
    openMenu("Design in review");
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete view" }));
    expect(getSavedView("sv-demo-design")).toBeTruthy();
    await act(async () => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS + 50); await Promise.resolve(); });
    expect(getSavedView("sv-demo-design")).toBeUndefined();
  });

  it("shares and hides: sharing tells you with whom; hiding a teammate's view is yours alone, with Undo", async () => {
    await renderViews();
    openMenu("Urgent and mine");
    fireEvent.click(screen.getByRole("menuitem", { name: "Share with Foundrise" }));
    await act(async () => { await Promise.resolve(); });
    expect(getSavedView("sv-demo-urgent")!.shared).toBe(true);
    expect(screen.getByRole("button", { name: "Urgent and mine, 1 task, shared with Foundrise" })).toBeInTheDocument();
    openMenu("Blocked in the launch");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from my sidebar" }));
    expect(rowNames()).toEqual(["Urgent and mine", "Design in review"]);
    expect(getSavedView("sv-demo-blocked")!.pinned).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" }).slice(-1)[0]!);
    expect(rowNames()).toContain("Blocked in the launch");
  });

  it("reorders from the keyboard (⌥↓ / Move up) and says where it went", async () => {
    await renderViews();
    const first = screen.getByRole("button", { name: /^Urgent and mine/ });
    first.focus();
    await act(async () => { fireEvent.keyDown(first, { key: "ArrowDown", altKey: true }); await Promise.resolve(); });
    expect(rowNames()).toEqual(["Blocked in the launch", "Urgent and mine", "Design in review"]);
    expect(screen.getByRole("button", { name: /^Urgent and mine/ })).toHaveFocus();
    expect(group().querySelector("[aria-live]")).toHaveTextContent("Moved Urgent and mine to position 2 of 3");
    openMenu("Design in review");
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: /Move up/ })); await Promise.resolve(); });
    expect(rowNames()).toEqual(["Blocked in the launch", "Design in review", "Urgent and mine"]);
    expect(JSON.parse(localStorage.getItem("kanbo-views-order:m-self")!).slice(0, 3)).toEqual(["sv-demo-blocked", "sv-demo-design", "sv-demo-urgent"]);
  });

  it("reorders by dragging with a mouse (Escape cancels; the drop never opens the view)", async () => {
    const s = await renderViews();
    const rows = () => ["Urgent and mine", "Blocked in the launch", "Design in review"].map((n) => screen.getByRole("button", { name: new RegExp(`^${n}`) }));
    rows().forEach((el, i) => { el.getBoundingClientRect = () => ({ top: i * 32, bottom: i * 32 + 32, height: 32, left: 0, right: 200, width: 200, x: 0, y: i * 32, toJSON: () => ({}) }); });
    // cancelled
    fireEvent.pointerDown(rows()[0], { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 90 });
    expect(group()).toHaveAttribute("data-reordering");
    fireEvent.keyDown(window, { key: "Escape" });
    expect(group()).not.toHaveAttribute("data-reordering");
    expect(rowNames()).toEqual(["Urgent and mine", "Blocked in the launch", "Design in review"]);
    // dropped below the last row
    fireEvent.pointerDown(rows()[0], { button: 0, pointerType: "mouse", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 30 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 90 });
    expect(rowNames()).toEqual(["Blocked in the launch", "Design in review", "Urgent and mine"]);
    await act(async () => { fireEvent.pointerUp(window, { clientX: 10, clientY: 90 }); await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: /^Urgent and mine/ }));
    expect(s.setRoute).not.toHaveBeenCalled();
    expect(rowNames()).toEqual(["Blocked in the launch", "Design in review", "Urgent and mine"]);
    expect(group().querySelector("[aria-live]")).toHaveTextContent("Moved Urgent and mine to position 3 of 3");
    // touch never starts a reorder (the ⋯ menu's Move up / down does it there)
    fireEvent.pointerDown(rows()[0], { button: 0, pointerType: "touch", clientX: 10, clientY: 10 });
    fireEvent.pointerMove(window, { clientX: 10, clientY: 90 });
    expect(group()).not.toHaveAttribute("data-reordering");
  });

  it("“Edit view…” hands over to the host when it asks", async () => {
    const onEditView = vi.fn();
    await renderViews({ onEditView });
    openMenu("Urgent and mine");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit view…" }));
    expect(onEditView).toHaveBeenCalledWith(expect.objectContaining({ id: "sv-demo-urgent" }));
  });
});

describe("Sidebar › Views (lazy sheets)", () => {
  beforeEach(() => { vi.useRealTimers(); });

  it("opens its own editor for “Edit view…”", async () => {
    await renderViews();
    openMenu("Urgent and mine");
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit view…" }));
    expect(await screen.findByRole("dialog", { name: "Edit view" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "View name" })).toHaveValue("Urgent and mine");
  });

  it("“Change icon…” opens the editor on its icon picker", async () => {
    await renderViews();
    openMenu("Design in review");
    fireEvent.click(screen.getByRole("menuitem", { name: "Change icon…" }));
    expect(await screen.findByRole("dialog", { name: "Choose an icon" })).toBeInTheDocument();
  });

  it("All views lists every view: pin one back, or show a hidden one again", async () => {
    await renderViews();
    fireEvent.click(screen.getByRole("button", { name: "All views, 2 more" }));
    const dlg = await screen.findByRole("dialog", { name: "All views" });
    expect(within(dlg).getByRole("heading", { name: "In your sidebar" })).toBeInTheDocument();
    expect(within(dlg).getByRole("heading", { name: "Not in your sidebar" })).toBeInTheDocument();
    const pin = within(dlg).getByRole("button", { name: "Pin Due this week to the sidebar" });
    expect(pin).toHaveAttribute("aria-pressed", "false");
    await act(async () => { fireEvent.click(pin); await Promise.resolve(); });
    expect(rowNames()).toContain("Due this week");
    expect(screen.getByRole("button", { name: "All views, 1 more" })).toBeInTheDocument();
    // a teammate's shared view: an admin pins it for everyone
    expect(within(dlg).getByRole("button", { name: "Pin Engineering in infra to the sidebar for everyone" })).toBeInTheDocument();
  });

  it("a view you hid comes back from All views", async () => {
    await renderViews({ myRole: "member" });
    openMenu("Blocked in the launch");
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide from my sidebar" }));
    expect(rowNames()).not.toContain("Blocked in the launch");
    fireEvent.click(screen.getByRole("button", { name: "All views, 3 more" }));
    const dlg = await screen.findByRole("dialog", { name: "All views" });
    expect(within(dlg).getByRole("button", { name: /^Blocked in the launch, .*hidden from your sidebar$/ })).toBeInTheDocument();
    const show = within(dlg).getByRole("button", { name: "Show Blocked in the launch in my sidebar" });
    expect(show).toHaveAttribute("aria-pressed", "false");
    await act(async () => { fireEvent.click(show); await Promise.resolve(); });
    expect(rowNames()).toContain("Blocked in the launch");
  });
});

describe("Sidebar › project rows take dropped tasks", () => {
  it("each listed project registers as a target; a drop goes to the host", async () => {
    const onDropTasksOnProject = vi.fn();
    await renderViews({ onDropTasksOnProject });
    const launch = targets.filter((t) => t.target.kind === "project" && t.target.id === "p-launch").slice(-1)[0]!;
    expect(launch.target.label).toBe("Q3 Product Launch");
    expect(launch.disabled).toBe(false);
    launch.onDrop({ payload: { taskIds: ["t1"], source: "today", originId: "t1" }, target: launch.target, point: null, within: null, via: "keyboard" });
    expect(onDropTasksOnProject).toHaveBeenCalledWith(["t1"], "p-launch");
    expect(document.querySelector('.kproj-item[data-kdnd-target="project"]')).not.toBeNull();
  });

  it("guests, or a host without a handler, get rows that take nothing", async () => {
    await renderViews({ myRole: "guest", onDropTasksOnProject: vi.fn() });
    expect(targets.filter((t) => t.target.kind === "project").every((t) => t.disabled)).toBe(true);
    targets.length = 0;
    await renderViews({});
    expect(targets.filter((t) => t.target.kind === "project").every((t) => t.disabled)).toBe(true);
  });
});
