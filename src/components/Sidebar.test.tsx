import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { ToastProvider, ACTION_TOAST_MIN_MS } from "./Toast";
import type { FocusTimer } from "../hooks/useFocusTimer";
import type { Project, Task, Workspace, Role, SavedSearch } from "../data/types";
import type { Route } from "../app-types";
import { WORKSPACES as DEMO_WORKSPACES, PROJECTS as DEMO_PROJECTS } from "../data/data";

const focus = { running: false, setRunning: vi.fn(), seconds: 0, endSession: () => 0, focusMinToday: 0 } as unknown as FocusTimer;
const workspaces: Workspace[] = [
  { id: null, name: "Personal", kind: "personal" },
  { id: "ws-1", name: "Acme", kind: "team", ownerId: "u-boss" },
];
const projects: Project[] = [
  { id: "p-launch", name: "Q4 Launch", emoji: "🚀", color: "blue", workspaceId: "ws-1", ownerId: "u-other" },
  { id: "p-mine", name: "My Project", emoji: "📁", color: "red", workspaceId: "ws-1", ownerId: "u-me" },
  { id: "p-home", name: "Home stuff", emoji: "🏠", color: "green", workspaceId: null },
];
const task = (id: string, extra: Partial<Task>): Task => ({
  id, title: id, description: "", status: "todo", priority: "medium", projectId: "p-launch", assigneeId: "u-other",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws-1", ...extra,
});

function renderSidebar(opts: { route?: Route; workspace?: string | null; myRole?: Role; tasks?: Task[]; saved?: SavedSearch[]; onDeleteSavedSearch?: (id: string) => void | Promise<unknown>; projects?: Project[]; workspaces?: Workspace[]; currentUserId?: string; guardRoute?: boolean } = {}) {
  const props = {
    setRoute: vi.fn(), setWorkspace: vi.fn(), onDeleteProject: vi.fn(), onArchiveProject: vi.fn(), onRestoreProject: vi.fn(), onSignOut: vi.fn(),
  };
  const ui = (o: typeof opts) => (
    <ToastProvider>
      <Sidebar route={o.route ?? { view: "home" }} workspace={o.workspace === undefined ? "ws-1" : o.workspace} workspaces={o.workspaces ?? workspaces} onNewWorkspace={() => {}}
        focus={focus} openFocus={() => {}} tasks={o.tasks ?? []} projects={o.projects ?? projects} inboxCount={0} currentUserId={o.currentUserId ?? "u-me"}
        onNewProject={() => {}} onUpgrade={() => {}} onManageBilling={() => {}} myRole={o.myRole} guardRoute={o.guardRoute}
        savedSearches={o.saved} onDeleteSavedSearch={o.onDeleteSavedSearch} {...props} />
    </ToastProvider>
  );
  const r = render(ui(opts));
  return { ...props, rerender: (o: typeof opts) => r.rerender(ui({ ...opts, ...o })) };
}

beforeEach(() => { try { localStorage.clear(); } catch { /* ignore */ } });

describe("Sidebar project actions", () => {
  it("gives owners/admins pin, archive and delete, all named after the project", () => {
    const { onDeleteProject, onArchiveProject } = renderSidebar({ myRole: "admin" });
    fireEvent.click(screen.getByRole("button", { name: "Delete project Q4 Launch" }));
    expect(onDeleteProject).toHaveBeenCalledWith("p-launch");
    fireEvent.click(screen.getByRole("button", { name: "Archive project Q4 Launch" }));
    expect(onArchiveProject).toHaveBeenCalledWith("p-launch");
    expect(screen.getByRole("button", { name: "Pin project Q4 Launch" })).toBeInTheDocument();
  });

  it("pinning never opens delete, and the pinned project moves to the top", () => {
    const { onDeleteProject } = renderSidebar({ myRole: "owner" });
    const pin = screen.getByRole("button", { name: "Pin project My Project" });
    fireEvent.click(pin);
    expect(onDeleteProject).not.toHaveBeenCalled();
    expect(pin).toHaveAttribute("aria-pressed", "true");
    const rows = within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("My Project");
  });

  it("members can only delete projects they own, but can archive any (0041 lets every writer update)", () => {
    const { onArchiveProject } = renderSidebar({ myRole: "member" });
    expect(screen.queryByRole("button", { name: "Delete project Q4 Launch" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Archive project Q4 Launch" }));
    expect(onArchiveProject).toHaveBeenCalledWith("p-launch");
    expect(screen.getByRole("button", { name: "Delete project My Project" })).toBeInTheDocument();
  });

  it("lets a member restore a project they don't own; guests can't", () => {
    const archived = projects.map((p) => p.id === "p-launch" ? { ...p, archivedAt: "2026-09-30" } : p);
    const s = renderSidebar({ myRole: "member", projects: archived });
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    fireEvent.click(screen.getByRole("button", { name: "Restore project Q4 Launch" }));
    expect(s.onRestoreProject).toHaveBeenCalledWith("p-launch");
    s.rerender({ myRole: "guest", projects: archived });
    expect(screen.queryByRole("button", { name: "Restore project Q4 Launch" })).not.toBeInTheDocument();
  });

  it("keeps demo mode fully manageable with App's current props (no myRole, demo data has no owners)", () => {
    const archived = DEMO_PROJECTS.map((p) => p.id === "p-infra" ? { ...p, archivedAt: "2026-09-30" } : p);
    renderSidebar({ workspaces: DEMO_WORKSPACES, projects: archived, workspace: "ws-foundrise", currentUserId: "m-self" });
    for (const name of ["Q3 Product Launch", "Brand Refresh"]) {
      expect(screen.getByRole("button", { name: `Delete project ${name}` })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: `Archive project ${name}` })).toBeInTheDocument();
    }
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    expect(screen.getByRole("button", { name: "Restore project Platform Infra" })).toBeInTheDocument();
  });

  it("guests see no delete, archive or new-project controls", () => {
    renderSidebar({ myRole: "guest" });
    expect(screen.queryByRole("button", { name: /^Delete project/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Archive project/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pin project Q4 Launch" })).toBeInTheDocument();
  });

  it("marks the open project and view with aria-current", () => {
    renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "owner" });
    expect(screen.getByRole("button", { name: /^Q4 Launch/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^Home$/ })).not.toHaveAttribute("aria-current");
  });

  it("counts only open top-level tasks in a project badge, and assignee-or-collaborator tasks for My tasks", () => {
    const tasks = [
      task("a", {}), task("b", { parentId: "a" }), task("c", { status: "done" }), task("d", {}),
      task("m1", { assigneeId: "u-me" }), task("m2", { collaborators: ["u-me"] }), task("m3", { assigneeId: "u-me", parentId: "m1" }),
    ];
    renderSidebar({ tasks, myRole: "owner" });
    // a, d, m1, m2 are open + top-level in Q4 Launch
    expect(screen.getByRole("button", { name: /^Q4 Launch/ })).toHaveTextContent("4");
    // m1 + m2 (m3 nests under m1)
    expect(screen.getByRole("button", { name: /My tasks/ })).toHaveTextContent("2");
  });
});

describe("Sidebar navigation safety", () => {
  it("switching workspace leaves a project from the old workspace", () => {
    const { setWorkspace, setRoute } = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "owner" });
    fireEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    fireEvent.click(screen.getByRole("button", { name: "Personal" }));
    expect(setWorkspace).toHaveBeenCalledWith(null);
    expect(setRoute).toHaveBeenCalledWith({ view: "home" });
  });

  it("leaves a project a teammate archived, and says why", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    expect(s.setRoute).not.toHaveBeenCalled();
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", projects: projects.map((p) => p.id === "p-launch" ? { ...p, archivedAt: "2026-09-30" } : p) });
    expect(s.setRoute).toHaveBeenCalledWith({ view: "home" });
    expect(screen.getByRole("status")).toHaveTextContent("“Q4 Launch” was archived");
  });

  it("doesn't bounce you out when a refetch comes back empty", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", projects: [] });
    expect(s.setRoute).not.toHaveBeenCalled();
  });

  it("follows a project opened from another workspace (palette, search) instead of bouncing Home", () => {
    const s = renderSidebar({ workspace: null, myRole: "member" });
    s.rerender({ workspace: null, myRole: "member", route: { view: "project", projectId: "p-launch" } });
    expect(s.setWorkspace).toHaveBeenCalledWith("ws-1");
    expect(s.setRoute).not.toHaveBeenCalled();
  });

  it("leaves the open project, quietly, when the workspace changes elsewhere", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", workspace: null });
    expect(s.setWorkspace).not.toHaveBeenCalled();
    expect(s.setRoute).toHaveBeenCalledWith({ view: "home" });
    expect(screen.getByRole("status")).toBeEmptyDOMElement();
  });

  it("does nothing when App owns the route guard (guardRoute={false})", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member", guardRoute: false });
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", guardRoute: false, projects: projects.map((p) => p.id === "p-launch" ? { ...p, archivedAt: "2026-09-30" } : p) });
    expect(s.setRoute).not.toHaveBeenCalled();
    expect(s.setWorkspace).not.toHaveBeenCalled();
  });
});

describe("Sidebar saved lists", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const saved: SavedSearch[] = [{ id: "ss-1", name: "Urgent bugs", query: {} }];

  it("removes with Undo, and only deletes for real when the Undo window closes", async () => {
    const onDeleteSavedSearch = vi.fn();
    renderSidebar({ saved, onDeleteSavedSearch });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved list Urgent bugs" }));
    expect(screen.queryByRole("button", { name: /^Urgent bugs/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.getByRole("button", { name: /^Urgent bugs/ })).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS * 2); });
    expect(onDeleteSavedSearch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove saved list Urgent bugs" }));
    await act(async () => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS); await Promise.resolve(); });
    expect(onDeleteSavedSearch).toHaveBeenCalledWith("ss-1");
  });

  it("signing out inside the Undo window still removes the list", async () => {
    const onDeleteSavedSearch = vi.fn();
    const s = renderSidebar({ saved, onDeleteSavedSearch });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved list Urgent bugs" }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Sign out" })); await Promise.resolve(); });
    expect(onDeleteSavedSearch).toHaveBeenCalledWith("ss-1");
    expect(s.onSignOut).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
  });

  it("shows an error and brings the list back if the delete fails", async () => {
    const onDeleteSavedSearch = vi.fn(() => Promise.reject(new Error("nope")));
    renderSidebar({ saved, onDeleteSavedSearch });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved list Urgent bugs" }));
    await act(async () => { vi.advanceTimersByTime(ACTION_TOAST_MIN_MS); await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByRole("status")).toHaveTextContent("Couldn't remove “Urgent bugs”");
    expect(screen.getByRole("button", { name: /^Urgent bugs/ })).toBeInTheDocument();
  });
});
