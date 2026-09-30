import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import { isTaskId } from "./lib/taskOps";

const renderApp = () => render(
  <ToastProvider>
    <AuthProvider>
      <App />
    </AuthProvider>
  </ToastProvider>,
);
// bootstrap is async; wait for the sidebar nav to appear
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByText("Plan my day")).toBeInTheDocument()); };
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
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

describe("App (demo mode)", () => {
  it("boots and renders the workspace shell", async () => {
    await boot();
    expect(screen.getByText("My tasks")).toBeInTheDocument();
    expect(screen.getByText("Analytics")).toBeInTheDocument();
  });

  it("quick capture saves a task with a stable id, the parsed estimate, and keeps it out of today's plan", async () => {
    const create = track(vi.spyOn(store, "createTask"));
    await boot();
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
    key("q");
    const input = await screen.findByLabelText("Quick capture a task");
    fireEvent.change(input, { target: { value: "Call supplier @maya" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "assigned", recipientIds: ["m-1"] })));
  });

  it("pauses single-key shortcuts while a dialog is open", async () => {
    await boot();
    key("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
    key("c");
    expect(screen.queryByRole("dialog", { name: "New task" })).not.toBeInTheDocument();
    key("Escape");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).not.toBeInTheDocument());
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

  it("sends a pending delete straight away when the tab is hidden", async () => {
    track(vi.spyOn(window, "confirm").mockReturnValue(true));
    const del = track(vi.spyOn(store, "deleteTask"));
    await boot();
    key("g"); key("t");
    await openTask(DECK);
    fireEvent.click(await screen.findByTitle("Delete task"));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: `Task: ${DECK}` })).not.toBeInTheDocument());
    expect(del).not.toHaveBeenCalled(); // still inside the Undo window
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    await waitFor(() => expect(del).toHaveBeenCalledWith("t-1"));
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
    expect(screen.getByText("Logo round two is with the client")).toBeInTheDocument();
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
});
