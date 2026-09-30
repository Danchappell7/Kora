/* App: whose plan each surface shows, and what Ask Kanbo's Apply and Undo write.
   The palette and Team › Pulse are stood in for, so the tests can hand App the
   changes Ask proposes and see exactly what Pulse is given. */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import { clearUndo } from "./lib/undoStack";
import { toLocalISO, KANBO_TODAY } from "./data/data";
import type { Task } from "./data/types";
import type { AskAction } from "./lib/askTypes";

const seen = vi.hoisted(() => ({
  palette: null as null | { tasks?: Task[]; onApplyAsk?: (a: AskAction[]) => void },
  pulse: null as null | { tasks: Task[]; onPatch?: (id: string, patch: Partial<Task>) => void },
}));
vi.mock("./components/CommandPalette", () => ({
  CommandPalette: (p: { tasks?: Task[]; onApplyAsk?: (a: AskAction[]) => void }) => { seen.palette = p; return null; },
}));
vi.mock("./components/views/TeamPulse", () => ({
  TeamPulse: (p: { tasks: Task[]; onPatch?: (id: string, patch: Partial<Task>) => void }) => { seen.pulse = p; return <p>Team pulse stand-in</p>; },
}));

const today = toLocalISO(KANBO_TODAY);
const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  localStorage.clear();
  clearUndo();
  window.history.replaceState(null, "", "/");
  seen.palette = null; seen.pulse = null;
});

/** t-2 is Maya's (m-1), with her own plan on it (on today, at 10:00); you collaborate on it. */
function mayasTask(row: Partial<Task> = {}) {
  const real = store.bootstrap.bind(store);
  spies.push(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
    const b = await real(u);
    return { ...b, tasks: b.tasks.map((t) => (t.id === "t-2" ? { ...t, assigneeId: "m-1", collaborators: ["m-self"], status: "todo" as const, dependencies: [], planToday: true, scheduled: 600, ...row } : t)) };
  }));
}
const boot = async () => {
  render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
  await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
};
const key = (k: string) => fireEvent.keyDown(document.body, { key: k });
const ask = (actions: AskAction[]) => act(() => { seen.palette!.onApplyAsk!(actions); });
const seenTask = (id: string) => seen.palette!.tasks!.find((t) => t.id === id)!;
const myPlan = () => JSON.parse(localStorage.getItem("kanbo-plan-overlay:m-self") || "{}")[today] ?? {};

describe("App: your plan and theirs", () => {
  it("your own surfaces show your plan on a teammate's task; Team › Pulse shows theirs", async () => {
    mayasTask();
    await boot();
    // yours: not on your day (you haven't planned it)
    expect(seenTask("t-2")).toMatchObject({ planToday: false, scheduled: null });
    key("g"); key("e");
    expect(await screen.findByText("Team pulse stand-in")).toBeInTheDocument();
    // Maya's row keeps Maya's plan: she's on it today, at 10:00
    expect(seen.pulse!.tasks.find((t) => t.id === "t-2")).toMatchObject({ planToday: true, scheduled: 600 });
  });

  it("Ask's Undo puts back what you saw on a task you only collaborate on", async () => {
    // Maya hasn't planned it; you have (in your own plan)
    mayasTask({ planToday: false, scheduled: null });
    localStorage.setItem("kanbo-plan-overlay:m-self", JSON.stringify({ [today]: { "t-2": { planToday: true } } }));
    const update = vi.spyOn(store, "updateTask"); spies.push(update);
    await boot();
    expect(seenTask("t-2").planToday).toBe(true);
    ask([{ op: "update", id: "t-2", patch: { planToday: false } }]);
    await waitFor(() => expect(seenTask("t-2").planToday).toBe(false));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(seenTask("t-2").planToday).toBe(true));
    expect(myPlan()["t-2"]).toMatchObject({ planToday: true });
    // and Maya's row was never touched
    expect(update.mock.calls.some(([id]) => id === "t-2")).toBe(false);
  });

  it("taking a task and planning it in one go puts it on your day; Undo hands it back with Maya's plan", async () => {
    mayasTask();
    const update = vi.spyOn(store, "updateTask"); spies.push(update);
    await boot();
    ask([{ op: "update", id: "t-2", patch: { assigneeId: "m-self", planToday: true } }]);
    await waitFor(() => expect(seenTask("t-2")).toMatchObject({ assigneeId: "m-self", planToday: true }));
    await waitFor(() => expect(update).toHaveBeenCalledWith("t-2", expect.objectContaining({ assigneeId: "m-self", planToday: true })));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(update).toHaveBeenLastCalledWith("t-2", expect.objectContaining({ assigneeId: "m-1" })));
    key("g"); key("e");
    await screen.findByText("Team pulse stand-in");
    await waitFor(() => expect(seen.pulse!.tasks.find((t) => t.id === "t-2")).toMatchObject({ assigneeId: "m-1", planToday: true, scheduled: 600 }));
  });

  it("a task Ask creates for a teammate from Today never plans their day", async () => {
    const create = vi.spyOn(store, "createTask"); spies.push(create);
    await boot();
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    ask([
      { op: "create", task: { title: "Call supplier", assigneeId: "m-1" } },
      { op: "create", task: { title: "Book the venue", assigneeId: "m-1", planToday: true } },
      { op: "create", task: { title: "Draft the agenda", planToday: true } },
    ]);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    const made = create.mock.calls.map(([t]) => t as Task);
    expect(made.find((t) => t.title === "Call supplier")).toMatchObject({ assigneeId: "m-1", planToday: false });
    expect(made.find((t) => t.title === "Book the venue")).toMatchObject({ assigneeId: "m-1", planToday: false });
    expect(made.find((t) => t.title === "Draft the agenda")).toMatchObject({ assigneeId: "m-self", planToday: true });
    // "on today" for Maya's new task went to your own plan instead
    const venue = made.find((t) => t.title === "Book the venue")!;
    expect(myPlan()[venue.id]).toMatchObject({ planToday: true });
  });
});

describe("App: a task's plan goes with its assignee", () => {
  /** t-2 is yours, planned for 10:00 today in one of your My-tasks sections */
  function myPlannedTask() {
    const real = store.bootstrap.bind(store);
    spies.push(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      return { ...b, tasks: b.tasks.map((t) => (t.id === "t-2" ? { ...t, assigneeId: "m-self", collaborators: [], status: "todo" as const, dependencies: [], planToday: true, scheduled: 600, mySectionId: "ms-1", aiScore: 91 } : t)) };
    }));
  }
  const pulseRow = async (id: string) => {
    key("g"); key("e");
    await screen.findByText("Team pulse stand-in");
    return seen.pulse!.tasks.find((t) => t.id === id)!;
  };

  it("handing on a task you'd planned never puts it in your slot on their day; Undo gives you your plan back", async () => {
    myPlannedTask();
    const update = vi.spyOn(store, "updateTask"); spies.push(update);
    await boot();
    ask([{ op: "update", id: "t-2", patch: { assigneeId: "m-1" } }]);
    await waitFor(() => expect(update).toHaveBeenCalledWith("t-2", expect.objectContaining({ assigneeId: "m-1", planToday: false, scheduled: null, mySectionId: undefined })));
    expect(await pulseRow("t-2")).toMatchObject({ assigneeId: "m-1", planToday: false, scheduled: null, mySectionId: undefined });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(seen.pulse!.tasks.find((t) => t.id === "t-2")).toMatchObject({ assigneeId: "m-self", planToday: true, scheduled: 600, mySectionId: "ms-1" }));
  });

  it("Radar's Assign hands the task on without its old plan", async () => {
    myPlannedTask();
    await boot();
    const row = await pulseRow("t-2");
    expect(row).toMatchObject({ planToday: true, scheduled: 600 });
    act(() => { seen.pulse!.onPatch!("t-2", { assigneeId: "m-1" }); });
    await waitFor(() => expect(seen.pulse!.tasks.find((t) => t.id === "t-2")).toMatchObject({ assigneeId: "m-1", planToday: false, scheduled: null }));
  });

  it("taking a teammate's task doesn't bring their plan with it", async () => {
    mayasTask();
    await boot();
    ask([{ op: "update", id: "t-2", patch: { assigneeId: "m-self" } }]);
    await waitFor(() => expect(seenTask("t-2")).toMatchObject({ assigneeId: "m-self", planToday: false, scheduled: null }));
  });
});

describe("App: Today's capture", () => {
  it("a rule that hands the new task to someone else never plans their day", async () => {
    const real = store.bootstrap.bind(store);
    spies.push(vi.spyOn(store, "bootstrap").mockImplementation(async (u) => {
      const b = await real(u);
      const automationRules = b.projects.map((p, i) => ({ id: `r-maya-${i}`, projectId: p.id, name: "To Maya", trigger: "task_created", enabled: true, actions: [{ type: "set_assignee", value: "m-1" }] }));
      return { ...b, automationRules } as typeof b;
    }));
    const create = vi.spyOn(store, "createTask"); spies.push(create);
    await boot();
    const input = await screen.findByLabelText("Capture a task for today");
    fireEvent.change(input, { target: { value: "Order the banners" } });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Order the banners", assigneeId: "m-1", planToday: false, scheduled: null });
  });

  it("@person hands the task to them (off everyone's day) with the name out of its title", async () => {
    const create = vi.spyOn(store, "createTask"); spies.push(create);
    await boot();
    const input = await screen.findByLabelText("Capture a task for today");
    fireEvent.change(input, { target: { value: "@Maya call the printer" } });
    expect(document.querySelector(".krail-parse-bits")?.textContent).toContain("Maya Lin");
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ title: "Call the printer", assigneeId: "m-1", planToday: false });
    expect(await screen.findByText("Added “Call the printer” for Maya Lin.")).toBeInTheDocument();
  });

  it("the placeholder's own example is filed as it reads: “Call Sana”, Friday at 15:00, a 30-minute estimate", async () => {
    const create = vi.spyOn(store, "createTask"); spies.push(create);
    await boot();
    const input = await screen.findByLabelText("Capture a task for today");
    fireEvent.change(input, { target: { value: "call Sana fri 3pm ~30m" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(create).toHaveBeenCalled());
    const t = create.mock.calls[0][0] as Task;
    expect(t).toMatchObject({ title: "Call Sana", dueTime: "15:00", effortHours: 0.5, focusMin: 30, assigneeId: "m-self" });
    expect(new Date(t.dueDate + "T00:00:00").getDay()).toBe(5);
  });
});
