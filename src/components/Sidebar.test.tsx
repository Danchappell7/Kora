import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within } from "@testing-library/react";
import { Sidebar } from "./Sidebar";
import { ToastProvider, ACTION_TOAST_MIN_MS } from "./Toast";
import type { FocusTimer } from "../hooks/useFocusTimer";
import type { Project, Task, Workspace, Role, SavedSearch } from "../data/types";
import type { Route } from "../app-types";
import { WORKSPACES as DEMO_WORKSPACES, PROJECTS as DEMO_PROJECTS } from "../data/data";
import { listenForInstallPrompt, __resetInstallForTests } from "../lib/install";

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

type Opts = {
  route?: Route; workspace?: string | null; myRole?: Role; tasks?: Task[]; saved?: SavedSearch[]; savedCounts?: Record<string, number>;
  onDeleteSavedSearch?: (id: string) => void | Promise<unknown>; projects?: Project[]; workspaces?: Workspace[]; currentUserId?: string;
  guardRoute?: boolean; focus?: FocusTimer; inboxCount?: number; teamBadge?: number; theme?: "light" | "dark"; withShortcuts?: boolean;
};
function renderSidebar(opts: Opts = {}) {
  const props = {
    setRoute: vi.fn(), setWorkspace: vi.fn(), onDeleteProject: vi.fn(), onArchiveProject: vi.fn(), onRestoreProject: vi.fn(), onSignOut: vi.fn(),
    openFocus: vi.fn(), onNewProject: vi.fn(), onNewWorkspace: vi.fn(), onToggleTheme: vi.fn(), onOpenSettings: vi.fn(), onOpenShortcuts: vi.fn(), onOpenSearch: vi.fn(),
  };
  const ui = (o: Opts) => (
    <ToastProvider>
      <Sidebar route={o.route ?? { view: "plan" }} workspace={o.workspace === undefined ? "ws-1" : o.workspace} workspaces={o.workspaces ?? workspaces}
        focus={o.focus ?? focus} tasks={o.tasks ?? []} projects={o.projects ?? projects} inboxCount={o.inboxCount ?? 0} currentUserId={o.currentUserId ?? "u-me"}
        onUpgrade={() => {}} onManageBilling={() => {}} myRole={o.myRole} guardRoute={o.guardRoute}
        savedSearches={o.saved} savedSearchCounts={o.savedCounts} onDeleteSavedSearch={o.onDeleteSavedSearch} teamBadge={o.teamBadge} theme={o.theme}
        {...props} onOpenShortcuts={o.withShortcuts === false ? undefined : props.onOpenShortcuts} />
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

  it("keeps demo mode fully manageable with App's props (Daniel owns the demo workspace)", () => {
    const archived = DEMO_PROJECTS.map((p) => p.id === "p-infra" ? { ...p, archivedAt: "2026-09-30" } : p);
    renderSidebar({ workspaces: DEMO_WORKSPACES, projects: archived, workspace: "ws-foundrise", currentUserId: "m-self", myRole: "owner" });
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

  it("wears each project's identity: a 20px tile (its emoji), and the open one's colour as an edge", () => {
    renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "owner" });
    const row = screen.getByRole("button", { name: /^Q4 Launch/ });
    expect(row.querySelector(".kptile[data-size='20']")?.textContent).toBe("🚀");
    expect(row).toHaveClass("kp");
    expect(row.style.getPropertyValue("--p-h")).toMatch(/^\d+$/);
    expect(row.querySelector(".kpdot")).toBeNull();
    const css = Array.from(document.querySelectorAll("style")).map((el) => el.textContent ?? "").join("\n");
    expect(css).toMatch(/\.ksb \.kproj\.kp\[data-active="true"\] \{ box-shadow: inset 2px 0 0 var\(--p-fill\)/);
  });

  it("marks the open project with aria-current (its row, not Projects or Today)", () => {
    renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "owner" });
    expect(screen.getByRole("button", { name: /^Q4 Launch/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: /^Today$/ })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: /^Projects$/ })).not.toHaveAttribute("aria-current");
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
    expect(setRoute).toHaveBeenCalledWith({ view: "plan" });
  });

  it("leaves a project a teammate archived, and says why", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    expect(s.setRoute).not.toHaveBeenCalled();
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", projects: projects.map((p) => p.id === "p-launch" ? { ...p, archivedAt: "2026-09-30" } : p) });
    expect(s.setRoute).toHaveBeenCalledWith({ view: "plan" });
    expect(screen.getByRole("status")).toHaveTextContent("“Q4 Launch” was archived");
  });

  it("doesn't bounce you out when a refetch comes back empty", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", projects: [] });
    expect(s.setRoute).not.toHaveBeenCalled();
  });

  it("follows a project opened from another workspace (palette, search) instead of bouncing to Today", () => {
    const s = renderSidebar({ workspace: null, myRole: "member" });
    s.rerender({ workspace: null, myRole: "member", route: { view: "project", projectId: "p-launch" } });
    expect(s.setWorkspace).toHaveBeenCalledWith("ws-1");
    expect(s.setRoute).not.toHaveBeenCalled();
  });

  it("leaves the open project, quietly, when the workspace changes elsewhere", () => {
    const s = renderSidebar({ route: { view: "project", projectId: "p-launch" }, myRole: "member" });
    s.rerender({ route: { view: "project", projectId: "p-launch" }, myRole: "member", workspace: null });
    expect(s.setWorkspace).not.toHaveBeenCalled();
    expect(s.setRoute).toHaveBeenCalledWith({ view: "plan" });
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
    fireEvent.click(screen.getByRole("button", { name: "You, account" }));
    await act(async () => { fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" })); await Promise.resolve(); });
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

describe("Sidebar Focus pill", () => {
  const timer = (over: Partial<FocusTimer>) => ({ ...focus, seconds: 125, phase: "work", targetMin: 25, ...over }) as FocusTimer;

  it("idles as “Focus” with its F key, and opens Focus mode", () => {
    const s = renderSidebar();
    const pill = screen.getByRole("button", { name: /^Focus/ });
    expect(pill).toHaveAttribute("aria-keyshortcuts", "F");
    fireEvent.click(pill);
    expect(s.openFocus).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "End focus session" })).not.toBeInTheDocument();
  });

  it("shows the running time and task, and pauses", () => {
    const setRunning = vi.fn();
    renderSidebar({ focus: timer({ running: true, setRunning, taskId: "t1" }), tasks: [task("t1", { title: "Launch deck" })] });
    expect(screen.getByText("02:05")).toBeInTheDocument();
    expect(screen.getByText("Launch deck")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Pause focus" }));
    expect(setRunning).toHaveBeenCalled();
  });

  it("says a break ended rather than calling it too short to bank", () => {
    renderSidebar({ focus: timer({ phase: "break", endSession: () => 0 }) });
    fireEvent.click(screen.getByRole("button", { name: "End focus session" }));
    expect(screen.getByText("Break ended")).toBeInTheDocument();
    expect(screen.queryByText("Too short to bank")).not.toBeInTheDocument();
  });

  it("banks a work session, and calls a zero-minute one too short", () => {
    const s = renderSidebar({ focus: timer({ endSession: () => 25 }) });
    fireEvent.click(screen.getByRole("button", { name: "End focus session" }));
    expect(screen.getByText("Banked 25m of deep work")).toBeInTheDocument();
    s.rerender({ focus: timer({ endSession: () => 0 }) });
    fireEvent.click(screen.getByRole("button", { name: "End focus session" }));
    expect(screen.getByText("Too short to bank")).toBeInTheDocument();
  });
});

describe("Sidebar places", () => {
  it("lists Today, Inbox and My tasks, then Team's Projects and Team, inside the Main nav", () => {
    renderSidebar();
    const nav = screen.getByRole("navigation", { name: "Main" });
    const names = within(nav).getAllByRole("button").map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(names).toEqual(["Today", "Inbox", "My tasks", "Projects", "Team"]);
    expect(within(nav).getByRole("heading", { name: "Team" })).toBeInTheDocument();
    for (const gone of [/^Home$/, /^Analytics$/, /^Assigned to me/, /^Automations$/]) expect(screen.queryByRole("button", { name: gone })).not.toBeInTheDocument();
  });

  it("goes to each place's route", () => {
    const s = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    expect(s.setRoute).toHaveBeenLastCalledWith({ view: "plan" });
    fireEvent.click(screen.getByRole("button", { name: "Team" }));
    expect(s.setRoute).toHaveBeenLastCalledWith({ view: "pulse" });
    fireEvent.click(screen.getByRole("button", { name: /^All projects/ }));
    expect(s.setRoute).toHaveBeenLastCalledWith({ view: "projects" });
  });

  it("highlights the place a view belongs to (Search is My tasks, Goals is Projects)", () => {
    const s = renderSidebar({ route: { view: "search" } });
    expect(screen.getByRole("button", { name: "My tasks" })).toHaveAttribute("aria-current", "page");
    s.rerender({ route: { view: "goals" } });
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "My tasks" })).not.toHaveAttribute("aria-current");
  });

  it("names the Inbox badge with the unread count", () => {
    renderSidebar({ inboxCount: 5 });
    expect(screen.getByRole("button", { name: "Inbox, 5 unread" })).toHaveTextContent("5");
  });

  it("shows Team's risk count in team workspaces", () => {
    renderSidebar({ teamBadge: 2 });
    expect(screen.getByRole("button", { name: "Team, 2 at risk" })).toHaveTextContent("2");
  });

  it("shows Insights instead of Team in the Personal workspace", () => {
    const s = renderSidebar({ workspace: null, teamBadge: 2 });
    expect(screen.queryByRole("button", { name: /^Team/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Insights" }));
    expect(s.setRoute).toHaveBeenCalledWith({ view: "analytics" });
    s.rerender({ workspace: null, route: { view: "reports" } });
    expect(screen.getByRole("button", { name: "Insights" })).toHaveAttribute("aria-current", "page");
  });
});

describe("Sidebar saved views", () => {
  const saved: SavedSearch[] = ["Urgent bugs", "Launch", "Waiting on legal", "Design QA", "Backlog"].map((name, i) => ({ id: `ss-${i}`, name, query: {} }));

  it("nests up to three under My tasks, with “More…” opening the palette", () => {
    const s = renderSidebar({ saved, savedCounts: { "ss-0": 4 } });
    expect(screen.getByRole("button", { name: "Urgent bugs, 4 tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Waiting on legal/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Design QA/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^More saved views/ }));
    expect(s.onOpenSearch).toHaveBeenCalled();
  });

  it("marks an open saved view as the current page instead of My tasks", () => {
    renderSidebar({ saved, route: { view: "search", list: "ss-1" } });
    expect(screen.getByRole("button", { name: /^Launch/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "My tasks" })).not.toHaveAttribute("aria-current");
  });
});

describe("Sidebar projects list", () => {
  const many: Project[] = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: `Project ${i}`, emoji: "", color: "oklch(0.7 0.14 230)", workspaceId: "ws-1" }));
  const listed = () => within(screen.getByRole("list", { name: "Projects" })).getAllByRole("listitem").map((li) => li.querySelector(".kproj-name")!.textContent);

  it("lists at most eight, always including the open project, and keeps their order", () => {
    renderSidebar({ projects: many, route: { view: "project", projectId: "p10" } });
    const rows = listed();
    expect(rows).toHaveLength(8);
    expect(rows).toContain("Project 10");
    expect(rows.indexOf("Project 10")).toBe(rows.length - 1); // in its own place, not jumped to the top
    expect(screen.getByRole("button", { name: /^All projects/ })).toHaveTextContent("11");
  });

  it("fills the list with pinned, then recently opened, projects", () => {
    localStorage.setItem("kanbo-pinned-projects", JSON.stringify(["p9"]));
    localStorage.setItem("kanbo-recent-projects:u-me", JSON.stringify(["p8"]));
    renderSidebar({ projects: many });
    const rows = listed();
    expect(rows[0]).toBe("Project 9");
    expect(rows).toContain("Project 8");
    expect(rows).not.toContain("Project 7");
  });

  it("offers to create the first project, except to guests", () => {
    const s = renderSidebar({ projects: [] });
    fireEvent.click(screen.getByRole("button", { name: "Create one" }));
    expect(s.onNewProject).toHaveBeenCalled();
    s.rerender({ projects: [], myRole: "guest" });
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create one" })).not.toBeInTheDocument();
  });
});

describe("Sidebar footer", () => {
  it("names the theme button after the theme it switches to", () => {
    const s = renderSidebar({ theme: "dark" });
    fireEvent.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(s.onToggleTheme).toHaveBeenCalled();
    s.rerender({ theme: "light" });
    expect(screen.getByRole("button", { name: "Switch to dark theme" })).toBeInTheDocument();
  });

  it("has no theme button without a theme", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /^Switch to/ })).not.toBeInTheDocument();
  });

  it("opens an account menu with Settings, Keyboard shortcuts and Sign out", () => {
    const s = renderSidebar();
    const me = screen.getByRole("button", { name: "You, account" });
    expect(me).toHaveAttribute("aria-haspopup", "menu");
    fireEvent.click(me);
    const menu = screen.getByRole("menu", { name: "Account" });
    expect(within(menu).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Settings⌘,", "Keyboard shortcuts?", "Sign out"]);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Keyboard shortcuts" }));
    expect(s.onOpenShortcuts).toHaveBeenCalled();
    expect(screen.queryByRole("menu", { name: "Account" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(s.onOpenSettings).toHaveBeenCalled();
  });

  it("keeps the account menu a pure menu: the name card is visual, and every owned element is an item or a separator", () => {
    renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "You, account" }));
    const menu = screen.getByRole("menu", { name: "Account" });
    const card = menu.querySelector(".ksb-acct-head")!;
    expect(card).toHaveAttribute("aria-hidden", "true");
    // everything else the menu holds is an item or a separator
    const owned = Array.from(menu.querySelectorAll("*")).filter((el) => !el.closest("[aria-hidden='true']") && el.getAttribute("role"));
    expect(new Set(owned.map((el) => el.getAttribute("role")))).toEqual(new Set(["menuitem", "separator"]));
  });

  it("leaves Keyboard shortcuts out of the account menu when nothing opens them", () => {
    renderSidebar({ withShortcuts: false });
    fireEvent.click(screen.getByRole("button", { name: "You, account" }));
    expect(within(screen.getByRole("menu", { name: "Account" })).getAllByRole("menuitem").map((m) => m.textContent)).toEqual(["Settings⌘,", "Sign out"]);
  });
});

describe("Sidebar workspace switcher", () => {
  it("lists the workspaces with the current one marked, and New workspace…", () => {
    const s = renderSidebar();
    fireEvent.click(screen.getByRole("button", { name: "Switch workspace, current: Acme" }));
    const menu = screen.getByRole("dialog", { name: "Workspaces" });
    expect(within(menu).getByRole("button", { name: "Acme" })).toHaveAttribute("aria-current", "true");
    expect(within(menu).getByRole("button", { name: "Acme" })).toHaveFocus();
    fireEvent.keyDown(within(menu).getByRole("button", { name: "Acme" }), { key: "ArrowDown" });
    expect(within(menu).getByRole("button", { name: "New workspace…" })).toHaveFocus();
    fireEvent.click(within(menu).getByRole("button", { name: "New workspace…" }));
    expect(s.onNewWorkspace).toHaveBeenCalled();
  });
});

describe("Sidebar row-action styles", () => {
  const sidebarCss = () => Array.from(document.querySelectorAll("style")).map((el) => el.textContent ?? "").find((t) => t.includes(".kproj-acts"))!;

  it("hides the one-tap Archive on touch, where it would sit permanently beside Delete", () => {
    renderSidebar({ myRole: "admin" });
    expect(screen.getByRole("button", { name: "Archive project Q4 Launch" })).toHaveAttribute("data-kind", "archive");
    const touch = sidebarCss().match(/@media \(hover: none\), \(pointer: coarse\) \{([\s\S]*?)\n\}/)![1];
    expect(touch).toMatch(/\.kproj-act\[data-kind="archive"\]\s*\{\s*display:\s*none/);
  });

  it("reveals row actions for keyboard focus only — never :focus-within on the whole row (a mouse click would leave them stuck)", () => {
    renderSidebar({ myRole: "admin" });
    const css = sidebarCss();
    expect(css).not.toMatch(/\.kproj-item:focus-within|\.ksaved-row:focus-within/);
    expect(css).toMatch(/\.kproj-item:has\(:focus-visible\) \.kproj-acts\s*\{[^}]*opacity:\s*1/);
    // :has() never shares a selector list with :hover (an unsupported selector drops the whole rule)
    for (const rule of css.match(/[^{}]+\{/g) ?? []) if (/:hover/.test(rule)) expect(rule).not.toMatch(/:has\(/);
  });
});

describe("Sidebar › Install Kanbo nudge", () => {
  afterEach(() => { __resetInstallForTests(); });

  it("shows once the browser offers an install, above the focus pill, and Not now puts it away for good", () => {
    listenForInstallPrompt();
    renderSidebar();
    expect(screen.queryByRole("group", { name: "Install Kanbo" })).toBeNull();
    const offer = Object.assign(new Event("beforeinstallprompt", { cancelable: true }), { prompt: vi.fn(async () => {}), userChoice: Promise.resolve({ outcome: "dismissed" }) });
    act(() => { window.dispatchEvent(offer); });
    const nudge = screen.getByRole("group", { name: "Install Kanbo" });
    expect(nudge.closest(".ksb-foot")?.firstElementChild).toBe(nudge);
    fireEvent.click(within(nudge).getByRole("button", { name: "Not now" }));
    expect(screen.queryByRole("group", { name: "Install Kanbo" })).toBeNull();
  });
});
