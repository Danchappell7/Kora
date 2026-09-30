import { StrictMode } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import { offlineQueue, type DeadLetter } from "./lib/offlineQueue";
import { isTaskId } from "./lib/taskOps";
import { pushUndo, clearUndo } from "./lib/undoStack";
import { toLocalISO, KANBO_TODAY } from "./data/data";

const renderApp = () => render(
  <ToastProvider>
    <AuthProvider>
      <App />
    </AuthProvider>
  </ToastProvider>,
);
// bootstrap is async; wait for the sidebar nav to appear
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });
const openTask = async (title: string) => { fireEvent.click((await screen.findAllByText(title))[0]); return screen.findByRole("dialog", { name: `Task: ${title}` }); };
const DECK = "Finalize Q3 launch narrative deck"; // seeded demo task t-1, mine, in Foundrise
const lastOf = <T,>(xs: T[]): T => xs[xs.length - 1];
const projectButton = (name: string) => {
  const btn = screen.getAllByText(name, { selector: ".kproj *" })[0]?.closest("button");
  if (!btn) throw new Error(`no sidebar project “${name}”`);
  return btn;
};

// restore only our own spies (restoreAllMocks would also wipe the test setup's matchMedia mock)
const spies: { mockRestore: () => void }[] = [];
const track = <T extends { mockRestore: () => void }>(s: T): T => { spies.push(s); return s; };
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  localStorage.clear();
  clearUndo();
  window.history.replaceState(null, "", "/"); // every test opens the app at the root address
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
/** Open the app at an address (before rendering). */
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;

describe("App (demo mode)", () => {
  it("boots on Today, at its own address, with the places in the sidebar", async () => {
    await boot();
    const nav = screen.getByRole("navigation", { name: "Main" });
    expect(within(nav).getByText("My tasks")).toBeInTheDocument();
    expect(within(nav).getByText("Inbox")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe("/today"));
    expect(document.title).toMatch(/^(\(\d+\) )?Today · Kanbo$/);
  });

  it("quick capture saves a task with a stable id, the parsed estimate, and keeps it out of today's plan", async () => {
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    key("g"); key("t"); // (on Today, q goes to Today's own capture field)
    key("q");
    const input = await screen.findByLabelText("Quick capture a task");
    fireEvent.change(input, { target: { value: "Write board memo 90m" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    const t = create.mock.calls[0][0];
    expect(isTaskId(t.id)).toBe(true);
    expect(t).toMatchObject({ title: "Write board memo", focusMin: 90, dur: 90, planToday: false, workspaceId: "ws-foundrise" });
    expect(t.energy).toBeTruthy();
  });

  it("emails the assignee when a task is created for someone else", async () => {
    const notify = track(vi.spyOn(store, "notify"));
    await boot();
    key("g"); key("t");
    key("q");
    const input = await screen.findByLabelText("Quick capture a task");
    fireEvent.change(input, { target: { value: "Call supplier @maya" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "assigned", recipientIds: ["m-1"] })));
  });

  it("pauses single-key shortcuts while a dialog is open (? opens Settings, at Shortcuts)", async () => {
    await boot();
    key("?");
    const settings = await screen.findByRole("dialog", { name: /settings/i });
    key("c");
    expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    fireEvent.keyDown(settings, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /settings/i })).not.toBeInTheDocument());
    key("c");
    expect(await screen.findByRole("dialog", { name: "New task" })).toBeInTheDocument();
  });

  it("Escape closes only the top-most overlay, not the task panel underneath", async () => {
    await boot();
    key("g"); key("t");
    await openTask(DECK);
    key("k", { ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeInTheDocument();
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: `Task: ${DECK}` })).toBeInTheDocument();
  });

  const deleteDeck = async () => {
    key("g"); key("t");
    await openTask(DECK);
    fireEvent.click(await screen.findByTitle("Delete task"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Task: ${DECK}` })).not.toBeInTheDocument());
  };
  const hideTab = () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
  };
  /** Pretend to be a phone (touch screen, no hover) for effects that read it on mount. */
  const asPhone = () => {
    const orig = window.matchMedia;
    window.matchMedia = ((q: string) => ({ ...orig(q), matches: q.includes("pointer: coarse") })) as typeof window.matchMedia;
    track({ mockRestore: () => { window.matchMedia = orig; } });
  };

  it("sends a pending delete straight away when the page is closed", async () => {
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    const del = track(vi.spyOn(store, "deleteTask"));
    await boot();
    await deleteDeck();
    expect(del).not.toHaveBeenCalled(); // still inside the Undo window
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("t-1"));
  });

  it("a quick switch to another tab on a computer keeps Undo lossless (nothing is sent or re-created)", async () => {
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    const del = track(vi.spyOn(store, "deleteTask"));
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    await deleteDeck();
    hideTab();
    await new Promise((r) => setTimeout(r, 20));
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findAllByText(DECK)).not.toHaveLength(0);
    expect(create).not.toHaveBeenCalled();
  });

  it("on a phone a hidden tab sends the delete; Undo restores a copy with its checklist and blocked-by links, and says so", async () => {
    asPhone();
    const real = store.bootstrap.bind(store);
    // t-3 is blocked by the deck
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, tasks: b.tasks.map((t) => (t.id === "t-3" ? { ...t, dependencies: ["t-1"] } : t)) };
    }));
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    const del = track(vi.spyOn(store, "deleteTask"));
    const create = track(vi.spyOn(store, "createTask"));
    const addSub = track(vi.spyOn(store, "addSubtask"));
    const tick = track(vi.spyOn(store, "setSubtaskDone"));
    const link = track(vi.spyOn(store, "addDependency"));
    await boot();
    await deleteDeck();
    hideTab();
    await waitFor(() => expect(del).toHaveBeenCalledWith("t-1"));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText(`Restored “${DECK}” as a copy — it has a new link, and its comments, attachments and history couldn't be recovered.`)).toBeInTheDocument();
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: DECK, comments: 0 }), expect.anything()));
    await waitFor(() => expect(addSub).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(tick).toHaveBeenCalledTimes(2)); // the two ticked checklist items stay ticked
    const newId = create.mock.calls.find((c) => c[0].title === DECK)![0].id;
    await waitFor(() => expect(link).toHaveBeenCalledWith("t-3", newId));
  });

  it("Undo after an early send doesn't re-create a task whose delete failed (it's still on the server)", async () => {
    asPhone();
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    const del = track(vi.spyOn(store, "deleteTask")).mockRejectedValue(new Error("permission denied"));
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    await deleteDeck();
    hideTab();
    await waitFor(() => expect(del).toHaveBeenCalledWith("t-1"));
    fireEvent.click(screen.getAllByRole("button", { name: "Undo" })[0]);
    expect(await screen.findAllByText(DECK)).not.toHaveLength(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(create).not.toHaveBeenCalled();
  });

  it("Escape cancels an inline “Add task” draft instead of saving it", async () => {
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    key("g"); key("t");
    fireEvent.click((await screen.findAllByText("Add task"))[0].closest("button")!);
    const input = await screen.findByPlaceholderText("Task name, then Enter…");
    input.focus();
    fireEvent.change(input, { target: { value: "Draft I meant to cancel" } });
    // real browser order: React's root listener, then the window listener, for the same event
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
    await new Promise((r) => setTimeout(r, 30));
    expect(create).not.toHaveBeenCalled();
    expect(screen.queryByText("Draft I meant to cancel")).not.toBeInTheDocument();
  });

  it("Home shows the team's projects to a member with nothing assigned yet (not the empty-account screen)", async () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, tasks: b.tasks.map((t) => ({ ...t, assigneeId: t.assigneeId === "m-self" ? "m-1" : t.assigneeId, collaborators: [] })) };
    }));
    await boot();
    key("g"); key("h"); // Today › Overview (the classic Home)
    expect(await screen.findByText("Active projects")).toBeInTheDocument();
    expect(screen.queryByText(/Your workspace is a clean slate/)).not.toBeInTheDocument();
    expect(address()).toBe("/today/overview");
  });

  it("Overview's “Start focus block” starts the timer", async () => {
    await boot();
    key("g"); key("h");
    fireEvent.click((await screen.findByText("Start focus block")).closest("button")!);
    expect(await screen.findByText(/Deep Work · Focus mode/)).toBeInTheDocument();
    expect(screen.getByText(/In flow/)).toBeInTheDocument();
  });

  const importText = async (text: string) => {
    key("g"); key("t");
    fireEvent.click(await screen.findByTitle(/Import tasks/));
    const dialog = await screen.findByRole("dialog", { name: "Import tasks" });
    fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: text } });
    // My tasks has no project of its own: the modal asks where the rows go
    const into = within(dialog).getByLabelText("Import into") as HTMLSelectElement;
    fireEvent.change(into, { target: { value: Array.from(into.options).find((o) => o.value)!.value } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /^Import \d+ tasks?$/ })); });
  };

  it("import: one failed row is flagged on its own, and Retry sends only that row", async () => {
    const real = store.createTask.bind(store);
    let n = 0;
    const create = track(vi.spyOn(store, "createTask").mockImplementation(async (t, u) => { n++; if (n === 2) throw new Error("boom"); return real(t, u); }));
    await boot();
    await importText("Alpha import row\nBeta import row\nGamma import row");
    expect(await screen.findByText(/^1 task couldn't be saved/)).toBeInTheDocument();
    expect(create.mock.calls.map((c) => c[0].title).sort()).toEqual(["Alpha import row", "Beta import row", "Gamma import row"]);
    await act(async () => { fireEvent.click(within(screen.getByText(/^1 task couldn't be saved/).parentElement!).getByRole("button", { name: "Retry" })); });
    await waitFor(() => expect(create).toHaveBeenCalledTimes(4));
    expect(create.mock.calls[3][0].title).toBe("Beta import row");
    await waitFor(() => expect(screen.queryByText(/couldn't be saved/)).not.toBeInTheDocument());
  });

  it("a task imported as done keeps its completion date on the server", async () => {
    const update = track(vi.spyOn(store, "updateTask"));
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    await importText("Title,Status\nShipped the thing,done\nPlan the next thing,todo");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const shipped = create.mock.calls.find((c) => c[0].title === "Shipped the thing")![0];
    await waitFor(() => expect(update).toHaveBeenCalledWith(shipped.id, { completedAt: shipped.completedAt }));
    expect(shipped.completedAt).toBeTruthy();
    expect(update.mock.calls.some((c) => c[0] === create.mock.calls.find((x) => x[0].title === "Plan the next thing")![0].id)).toBe(false);
  });

  it("a completion that fails to save takes back its next recurrence and logs nothing", async () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, tasks: b.tasks.map((t) => (t.id === "t-1" ? { ...t, recurrence: "weekly" as const } : t)) };
    }));
    track(vi.spyOn(store, "updateTask")).mockRejectedValue(new Error("502"));
    const create = track(vi.spyOn(store, "createTask"));
    const del = track(vi.spyOn(store, "deleteTask"));
    const logged = track(vi.spyOn(store, "logActivity"));
    await boot();
    key("g"); key("t");
    const panel = await openTask(DECK);
    const status = within(panel).getAllByRole("combobox").find((el) => (el as HTMLSelectElement).value === "progress")!;
    fireEvent.change(status, { target: { value: "done" } });
    expect(await screen.findByText(/Couldn't save — change undone/)).toBeInTheDocument();
    await waitFor(() => expect(create).toHaveBeenCalledWith(expect.objectContaining({ title: DECK, status: "todo" }), expect.anything()));
    const next = create.mock.calls.find((c) => c[0].title === DECK)![0];
    await waitFor(() => expect(del).toHaveBeenCalledWith(next.id));
    expect((status as HTMLSelectElement).value).toBe("progress");
    expect(logged.mock.calls.some((c) => c[0].kind === "completed")).toBe(false);
  });

  it("members can archive a team project and post updates; guests can do neither", async () => {
    const real = store.bootstrap.bind(store);
    let role: "member" | "guest" = "member";
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      const brand = b.projects.find((p) => p.name === "Brand Refresh")!;
      return {
        ...b,
        projects: b.projects.map((p) => (p.id === brand.id ? { ...p, ownerId: "m-1" } : p)),
        members: b.members.map((m) => (m.userId === "m-self" ? { ...m, role } : m)),
        statusUpdates: [{ id: "su-1", projectId: brand.id, summary: "Logo round two is with the client", status: "on_track" as const, createdAt: new Date().toISOString() }],
      };
    }));
    const { unmount } = renderApp();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    fireEvent.click(projectButton("Brand Refresh"));
    expect(await screen.findByRole("heading", { level: 1, name: "Brand Refresh" })).toBeInTheDocument();
    expect(within(projectButton("Brand Refresh").parentElement!).getByRole("button", { name: "Archive project Brand Refresh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Post update" })).toBeInTheDocument();
    unmount();
    role = "guest";
    await boot();
    fireEvent.click(projectButton("Brand Refresh"));
    expect(await screen.findByRole("heading", { level: 1, name: "Brand Refresh" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Post update" })).not.toBeInTheDocument();
    expect(within(projectButton("Brand Refresh").parentElement!).queryByRole("button", { name: "Archive project Brand Refresh" })).not.toBeInTheDocument();
  });

  it("keeps filters per page: a filter set in My tasks doesn't hide a project's tasks", async () => {
    await boot();
    key("g"); key("t");
    fireEvent.click(await screen.findByRole("button", { name: "High priority" }));
    expect(screen.getByRole("button", { name: /Filter · on/ })).toBeInTheDocument();
    fireEvent.click(projectButton("Brand Refresh"));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Filter$/ })).toBeInTheDocument());
    key("g"); key("t");
    expect(await screen.findByRole("button", { name: /Filter · on/ })).toBeInTheDocument();
  });

  it("keeps a status update draft until it is actually saved", async () => {
    const post = track(vi.spyOn(store, "createStatusUpdate")).mockRejectedValueOnce(new Error("offline"));
    await boot();
    fireEvent.click(projectButton("Brand Refresh"));
    fireEvent.click(await screen.findByRole("button", { name: "Post update" }));
    const box = screen.getByPlaceholderText(/What's the latest/);
    fireEvent.change(box, { target: { value: "Logo round two is with the client" } });
    fireEvent.click(lastOf(screen.getAllByRole("button", { name: "Post update" })));
    expect(await screen.findByText(/Couldn't post the update — your text is still there/)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/What's the latest/)).toHaveValue("Logo round two is with the client");
    fireEvent.click(lastOf(screen.getAllByRole("button", { name: "Post update" })));
    await waitFor(() => expect(screen.queryByPlaceholderText(/What's the latest/)).not.toBeInTheDocument());
    expect(post).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ summary: "Logo round two is with the client" }), expect.anything());
  });

  it("deletes a project first and only then its tasks — a refused delete changes nothing", async () => {
    const delProject = track(vi.spyOn(store, "deleteProject")).mockRejectedValueOnce(new Error("permission denied"));
    const delTask = track(vi.spyOn(store, "deleteTask"));
    await boot();
    const tryDelete = async () => {
      fireEvent.click(within(projectButton("Brand Refresh").parentElement!).getByTitle("Delete project"));
      const dialog = await screen.findByRole("dialog", { name: "Delete project" });
      fireEvent.click(within(dialog).getByText(/too$/));
      // the delete is async (server first, then tasks) — let it settle inside act
      await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Delete project/ })); });
    };
    await tryDelete();
    expect(await screen.findByText(/Couldn't delete “Brand Refresh” — nothing was changed/)).toBeInTheDocument();
    expect(projectButton("Brand Refresh")).toBeInTheDocument();
    expect(delTask).not.toHaveBeenCalled();
    await tryDelete();
    await waitFor(() => expect(screen.queryByText("Brand Refresh", { selector: ".kproj *" })).not.toBeInTheDocument());
    expect(delProject).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(delTask).toHaveBeenCalled());
    expect(await screen.findByText(/^Deleted “Brand Refresh” and \d+ tasks?$/)).toBeInTheDocument();
  });

  const asGuest = () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, members: b.members.map((m) => (m.userId === "m-self" ? { ...m, role: "guest" as const } : m)) };
    }));
  };

  it("a guest's list and task panel are read-only (no inline add, no delete)", async () => {
    asGuest();
    await boot();
    key("g"); key("t");
    const panel = await openTask(DECK);
    expect(within(panel).queryByTitle("Delete task")).not.toBeInTheDocument();
    expect(screen.queryByText("Add task")).not.toBeInTheDocument();
  });

  it("a filter that hides every task says so, and Clear filters brings them back", async () => {
    await boot();
    key("g"); key("t");
    await screen.findAllByText(DECK);
    fireEvent.change(screen.getByLabelText("Filter tasks by title"), { target: { value: "zzz no such task" } });
    expect(await screen.findByText("No tasks match these filters")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Clear filters/ }));
    expect(await screen.findAllByText(DECK)).not.toHaveLength(0);
  });

  it("deleting a project offers Archive instead first, and the archive can be undone", async () => {
    const del = track(vi.spyOn(store, "deleteProject"));
    const arch = track(vi.spyOn(store, "setProjectArchived"));
    await boot();
    // (an earlier test deleted Brand Refresh from the shared demo data)
    fireEvent.click(within(projectButton("Platform Infra").parentElement!).getByTitle("Delete project"));
    const dialog = await screen.findByRole("dialog", { name: "Delete project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Archive project" }));
    await waitFor(() => expect(arch).toHaveBeenCalledWith("p-infra", true));
    expect(del).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText("Platform Infra", { selector: ".kproj *" })).not.toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Archived “Platform Infra”").parentElement!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(arch).toHaveBeenCalledWith("p-infra", false));
    expect(await screen.findByText("Platform Infra", { selector: ".kproj *" })).toBeInTheDocument();
  });

  it("the ⌘K palette opens a project in another workspace by switching to it", async () => {
    await boot();
    key("k", { ctrlKey: true });
    const input = await screen.findByRole("combobox");
    fireEvent.change(input, { target: { value: "Growth" } });
    fireEvent.click(within(screen.getByRole("group", { name: "Projects" })).getByRole("option"));
    expect(await screen.findByText("Growth Experiments", { selector: ".kproj *" })).toBeInTheDocument();
    expect(screen.queryByText("Brand Refresh", { selector: ".kproj *" })).not.toBeInTheDocument(); // now in Reco HQ
    expect(await screen.findByRole("heading", { name: /Growth Experiments/ })).toBeInTheDocument();
  });

  it("the palette hands its text to Search", async () => {
    await boot();
    key("k", { ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "narrative" } });
    fireEvent.click(screen.getByRole("option", { name: /See all results for “narrative” in Search/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument());
    expect(await screen.findByDisplayValue("narrative")).toBeInTheDocument();
    expect(await screen.findAllByText(DECK)).not.toHaveLength(0);
  });

  it("archiving a notification can be undone", async () => {
    const item = { id: "a-1", taskId: "t-1", taskTitle: DECK, kind: "assigned" as const, detail: "Maya assigned this to you", createdAt: new Date().toISOString() };
    track(vi.spyOn(store, "listActivity")).mockResolvedValue([item]);
    const archive = track(vi.spyOn(store, "archiveActivity")).mockResolvedValue();
    const unarchive = track(vi.spyOn(store, "unarchiveActivity")).mockResolvedValue();
    await boot();
    key("g"); key("i");
    fireEvent.click(await screen.findByRole("button", { name: `Archive “${DECK}”` }));
    await waitFor(() => expect(archive).toHaveBeenCalledWith("a-1"));
    await waitFor(() => expect(screen.queryByRole("button", { name: `Archive “${DECK}”` })).not.toBeInTheDocument());
    fireEvent.click(within(screen.getByText("Notification archived").parentElement!).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledWith(["a-1"]));
    expect(await screen.findByRole("button", { name: `Archive “${DECK}”` })).toBeInTheDocument();
  });

  it("archiving one notification after another keeps a single Undo toast that brings them all back", async () => {
    const items = [0, 1, 2].map((i) => ({ id: `a-${i}`, taskId: "t-1", taskTitle: `Inbox note ${i}`, kind: "assigned" as const, detail: "Maya assigned this to you", createdAt: new Date(Date.now() - i * 1000).toISOString() }));
    track(vi.spyOn(store, "listActivity")).mockResolvedValue(items);
    track(vi.spyOn(store, "archiveActivity")).mockResolvedValue();
    const unarchive = track(vi.spyOn(store, "unarchiveActivity")).mockResolvedValue();
    await boot();
    key("g"); key("i");
    for (const i of [0, 1, 2]) fireEvent.click(await screen.findByRole("button", { name: `Archive “Inbox note ${i}”` }));
    const toast = (await screen.findByText("Archived 3 notifications")).parentElement!;
    expect(screen.queryByText("Notification archived")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
    fireEvent.click(within(toast).getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(unarchive).toHaveBeenCalledTimes(1));
    expect([...unarchive.mock.calls[0][0]].sort()).toEqual(["a-0", "a-1", "a-2"]);
    for (const i of [0, 1, 2]) expect(await screen.findByRole("button", { name: `Archive “Inbox note ${i}”` })).toBeInTheDocument();
  });

  it("import nests sub-tasks under their parent row and creates the sections and tags the file names", async () => {
    const create = track(vi.spyOn(store, "createTask"));
    const section = track(vi.spyOn(store, "createSection"));
    const tag = track(vi.spyOn(store, "createTag"));
    const update = track(vi.spyOn(store, "updateTask"));
    await boot();
    await importText("Name,Section/Column,Tags,Parent task\nLaunch site,Kickoff,,\nWrite copy,,Fresh tag,Launch site");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    const parent = create.mock.calls.find((c) => c[0].title === "Launch site")![0];
    const child = create.mock.calls.find((c) => c[0].title === "Write copy")![0];
    expect(child.parentId).toBe(parent.id);
    expect(child.projectId).toBe(parent.projectId);
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ name: "Kickoff", projectId: parent.projectId }), expect.anything());
    const sec = await section.mock.results[0].value;
    expect(parent.sectionId).toBe(sec.id); // the insert waited for the section's real id
    expect(tag).toHaveBeenCalledWith("Fresh tag", expect.any(String), expect.anything(), "ws-foundrise");
    const made = await tag.mock.results[0].value;
    await waitFor(() => expect(update).toHaveBeenCalledWith(child.id, { tags: [made.id] }));
  });

  it("a completion date read from the imported file is kept", async () => {
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    await importText("Name,Completed At\nShipped long ago,2026-09-10");
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0][0]).toMatchObject({ status: "done", completedAt: "2026-09-10" });
  });

  it("following a task saves normally when the follow RPC isn't available (demo mode, or before 0042)", async () => {
    const follow = track(vi.spyOn(store, "setTaskFollow"));
    const update = track(vi.spyOn(store, "updateTask"));
    await boot();
    key("g"); key("t");
    const panel = await openTask(DECK);
    fireEvent.click(within(panel).getByRole("button", { name: /^Follow/ }));
    await waitFor(() => expect(follow).toHaveBeenCalledWith("t-1", true));
    await waitFor(() => expect(update).toHaveBeenCalledWith("t-1", { followers: expect.arrayContaining(["m-self"]) }));
  });

  it("Settings can follow the device's theme", async () => {
    await boot();
    key("k", { ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "settings" } });
    fireEvent.click(screen.getByRole("option", { name: /Open settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: /System/ }));
    // the test browser reports a light system theme
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    expect(localStorage.getItem("kanbo-theme")).toBe("system");
  });

  it("a project started from a template gets its sections and starter tasks", async () => {
    const section = track(vi.spyOn(store, "createSection"));
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    key("k", { ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "new project" } });
    fireEvent.click(screen.getByRole("option", { name: /New project/ }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.change(within(dialog).getByLabelText("Start from template"), { target: { value: "builtin-launch" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /Create/ }));
    await waitFor(() => expect(section).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(10));
    const plan = (await section.mock.results[0].value).id;
    expect(create.mock.calls.find((c) => c[0].title === "Define launch goals and success metrics")![0]).toMatchObject({ sectionId: plan, status: "todo", workspaceId: "ws-foundrise" });
  });

  it("changes the queue gave up on are shown, with Retry and Discard", async () => {
    const parked = [{ op: { id: "op-1", kind: "update", taskId: "t-1", patch: { priority: "high" } }, failedAt: Date.now(), error: "permission denied" }] as unknown as DeadLetter[];
    track(vi.spyOn(offlineQueue, "subscribeDeadLetters").mockImplementation((fn) => { fn(parked); return () => {}; }));
    const retry = track(vi.spyOn(offlineQueue, "retryDeadLetters")).mockReturnValue(1);
    const discard = track(vi.spyOn(offlineQueue, "discardDeadLetters")).mockReturnValue(1);
    track(vi.spyOn(offlineQueue, "deadLetters")).mockReturnValue(parked);
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    await boot();
    const banner = screen.getByText(/^1 change couldn't be synced — the server turned it down/).parentElement!;
    fireEvent.click(within(banner).getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalled();
    fireEvent.click(within(banner).getByRole("button", { name: "Discard" }));
    expect(discard).toHaveBeenCalled();
  });

  it("the quick theme toggle flips light and dark every time (also under StrictMode)", async () => {
    render(<StrictMode><ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider></StrictMode>);
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    const toggle = async () => {
      key("k", { ctrlKey: true });
      fireEvent.change(await screen.findByRole("combobox"), { target: { value: "theme" } });
      fireEvent.click(screen.getByRole("option", { name: /Toggle .*theme/i }));
    };
    await toggle();
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("light"));
    await toggle();
    await waitFor(() => expect(document.documentElement.getAttribute("data-theme")).toBe("dark"));
    expect(localStorage.getItem("kanbo-theme")).toBe("dark");
  });

  it("guests can look but not edit: no optimistic change, one friendly toast", async () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, members: b.members.map((m) => (m.userId === "m-self" ? { ...m, role: "guest" as const } : m)) };
    }));
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
    expect(screen.getByText(/You're a guest in Foundrise/)).toBeInTheDocument();
    key("c");
    expect(await screen.findByText(/Guests can view and comment — ask a workspace admin/)).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("“Move tasks & delete” moves the tasks first — a refused move keeps the project, and Retry finishes the job", async () => {
    let refuse = true;
    const real = store.updateTask.bind(store);
    const upd = track(vi.spyOn(store, "updateTask")).mockImplementation(async (id, patch) => { if (refuse) throw new Error("permission denied"); return real(id, patch); });
    const delProject = track(vi.spyOn(store, "deleteProject"));
    await boot();
    fireEvent.click(within(projectButton("Platform Infra").parentElement!).getByTitle("Delete project"));
    const dialog = await screen.findByRole("dialog", { name: "Delete project" });
    fireEvent.click(within(dialog).getByText(/^Move \d+ tasks? to another project$/));
    fireEvent.change(within(dialog).getByLabelText("Move tasks from Platform Infra to"), { target: { value: "p-launch" } });
    await act(async () => { fireEvent.click(within(dialog).getByRole("button", { name: /Move tasks & delete/ })); });
    const failed = (await screen.findByText(/^Couldn't move \d+ tasks? — “Platform Infra” was not deleted$/)).parentElement!;
    expect(upd).toHaveBeenCalled();
    expect(delProject).not.toHaveBeenCalled();
    expect(projectButton("Platform Infra")).toBeInTheDocument();
    const moves = upd.mock.calls.length;
    refuse = false;
    await act(async () => { fireEvent.click(within(failed).getByRole("button", { name: "Retry" })); });
    await waitFor(() => expect(delProject).toHaveBeenCalledWith("p-infra"));
    expect(upd.mock.calls.length).toBe(moves * 2);
    expect(upd.mock.calls.slice(moves).every(([, p]) => p.projectId === "p-launch")).toBe(true);
    // every move landed before the project was deleted
    expect(Math.max(...upd.mock.invocationCallOrder)).toBeLessThan(delProject.mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.queryByText("Platform Infra", { selector: ".kproj *" })).not.toBeInTheDocument());
    expect(await screen.findByText(/^Deleted “Platform Infra” — \d+ tasks? moved to “Q3 Product Launch”$/)).toBeInTheDocument();
  });

  /* ---- addresses, history and the plan-state guard ---- */

  it("an address opens its page: /p/p-launch/board is the project, on Board", async () => {
    at("/p/p-launch/board");
    await boot();
    expect(await screen.findByRole("heading", { level: 1, name: "Q3 Product Launch" })).toBeInTheDocument();
    expect(await screen.findByRole("group", { name: "To do column" })).toBeInTheDocument();
    expect(address()).toBe("/p/p-launch/board");
    expect(document.title).toMatch(/Q3 Product Launch · Kanbo$/);
  });

  it("Back and Forward follow the address: Today, then My tasks, then Back is Today again", async () => {
    await boot();
    await waitFor(() => expect(address()).toBe("/today"));
    key("g"); key("t");
    expect(await screen.findByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
    expect(address()).toBe("/tasks");
    act(() => { window.history.back(); });
    expect(await screen.findByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    expect(address()).toBe("/today");
    act(() => { window.history.forward(); });
    expect(await screen.findByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
  });

  it("an old address is rewritten to its new one: /home is /today, /calendar is /today/month", async () => {
    at("/home");
    const first = renderApp();
    await waitFor(() => expect(address()).toBe("/today"));
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    first.unmount();
    at("/calendar?billing=cancelled");
    renderApp();
    await waitFor(() => expect(window.location.pathname).toBe("/today/month"));
  });

  it("?task= opens that task's panel on its page, and closing the panel takes it off the address", async () => {
    at("/tasks?task=t-1");
    await boot();
    expect(await screen.findByRole("dialog", { name: `Task: ${DECK}` })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
    expect(address()).toBe("/tasks?task=t-1");
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Task: ${DECK}` })).not.toBeInTheDocument());
    expect(address()).toBe("/tasks");
  });

  it("Search keeps the text it was handed in the address", async () => {
    at("/search?q=narrative");
    await boot();
    expect(await screen.findByDisplayValue("narrative")).toBeInTheDocument();
    expect(address()).toBe("/search?q=narrative");
  });

  it("opening a project's address in another workspace switches to that workspace", async () => {
    at("/p/p-growth");
    await boot();
    expect(await screen.findByRole("heading", { level: 1, name: "Growth Experiments" })).toBeInTheDocument();
    expect(await screen.findByText("Growth Experiments", { selector: ".kproj *" })).toBeInTheDocument();
    expect(address()).toBe("/p/p-growth");
  });

  it("a project address that leads nowhere says so and lands on Today", async () => {
    at("/p/p-nope/board");
    await boot();
    expect(await screen.findByText(/That project was deleted, or you no longer have access to it/)).toBeInTheDocument();
    await waitFor(() => expect(address()).toBe("/today"));
  });

  it("switching workspace keeps your place when it makes sense there", async () => {
    await boot();
    key("g"); key("t");
    expect(await screen.findByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Switch workspace/ }));
    fireEvent.click(screen.getAllByText("Reco HQ").map((el) => el.closest("button")).find(Boolean)!);
    expect(await screen.findByText("Growth Experiments", { selector: ".kproj *" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
    expect(address()).toBe("/tasks");
  });

  it("planning a teammate's task from Today keeps it in your own plan, never on their row", async () => {
    const real = store.bootstrap.bind(store);
    track(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      // t-2 is Maya's; you collaborate on it
      return { ...b, tasks: b.tasks.map((t) => (t.id === "t-2" ? { ...t, assigneeId: "m-1", collaborators: ["m-self"], status: "todo" as const, dependencies: [], scheduled: null, planToday: false } : t)) };
    }));
    const today = toLocalISO(KANBO_TODAY);
    // you've put it on your day (in your own plan)
    localStorage.setItem("kanbo-plan-overlay:m-self", JSON.stringify({ [today]: { "t-2": { planToday: true } } }));
    const update = track(vi.spyOn(store, "updateTask"));
    await boot();
    fireEvent.click(within(screen.getByRole("main")).getAllByRole("button", { name: /plan my day/i })[0]);
    await waitFor(() => expect(JSON.parse(localStorage.getItem("kanbo-plan-overlay:m-self") || "{}")[today]?.["t-2"]?.scheduled).toEqual(expect.any(Number)), { timeout: 4000 });
    expect(update.mock.calls.some(([id, patch]) => id === "t-2" && ("scheduled" in patch || "planToday" in patch))).toBe(false);
  });

  it("⌘Z takes back the newest undoable change, once, and says so", async () => {
    await boot();
    const undo = vi.fn();
    pushUndo("Moved 3 tasks to Monday", undo);
    key("z", { metaKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Undone: Moved 3 tasks to Monday")).toBeInTheDocument();
    key("z", { ctrlKey: true });
    expect(undo).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("Nothing to undo")).toBeInTheDocument();
  });

  it("the new keys: g o is Projects, g e is Team, ⌘, is Settings", async () => {
    await boot();
    key("g"); key("o");
    expect(await screen.findByRole("heading", { level: 1, name: "Projects" })).toBeInTheDocument();
    expect(address()).toBe("/projects");
    key("g"); key("e");
    expect(await screen.findByRole("heading", { level: 1, name: "Team" })).toBeInTheDocument();
    expect(address()).toBe("/team");
    key(",", { metaKey: true });
    expect(await screen.findByRole("dialog", { name: /settings/i })).toBeInTheDocument();
  });
});
