/* Task templates through the whole app (demo mode), as App wires New task and
   Quick capture today: a template's sub-tasks reach the store pointing at the
   id their parent was saved under (tasks.parent_id is a real foreign key, so
   a dangling one would fail every sub-task's insert). */
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import { isTaskId } from "./lib/taskOps";
import { resetLibraryTemplates } from "./lib/templates";
import type { Task } from "./data/types";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });

const spies: { mockRestore: () => void }[] = [];
let saved: Task[] = [];
beforeEach(() => {
  resetLibraryTemplates({ demoDelayMs: 0 });
  saved = [];
  const real = store.createTask.bind(store);
  spies.push(vi.spyOn(store, "createTask").mockImplementation((t, uid) => { saved.push(t); return real(t, uid); }));
});
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
});

/** the parent and its sub-tasks as they reached the store */
const family = (title: string) => {
  const parent = saved.find((t) => t.title === title && !t.parentId)!;
  return { parent, kids: saved.filter((t) => t.parentId && t.parentId === parent?.id) };
};

describe("App · task templates", () => {
  it("New task: a template's sub-tasks are saved under the id their task was saved with", async () => {
    await boot();
    key("c");
    await screen.findByRole("dialog", { name: "New task" });
    const title = screen.getByRole("textbox", { name: "Task title" });
    fireEvent.change(title, { target: { value: "/expense" } });
    fireEvent.click(await screen.findByRole("option", { name: /Expense claim/ }));
    fireEvent.change(title, { target: { value: "Expense claim: September" } });
    fireEvent.click(screen.getByRole("button", { name: /create task/i }));
    await waitFor(() => expect(saved).toHaveLength(5));
    const { parent, kids } = family("Expense claim: September");
    expect(isTaskId(parent.id)).toBe(true);
    expect(kids.map((k) => k.title)).toEqual(["Gather the receipts", "Fill in the claim form", "Get it approved", "Send it to finance"]);
    expect(kids.every((k) => isTaskId(k.id) && !k.planToday)).toBe(true);
    expect(saved.filter((t) => t.parentId && !isTaskId(t.parentId))).toEqual([]);
  });

  it("Quick capture away from a project finds the workspace's shared templates, and saves the sub-tasks under their task", async () => {
    await boot();
    key("g"); key("t"); // My tasks (on Today, q goes to Today's own capture field)
    key("q");
    const field = await screen.findByLabelText("Quick capture a task");
    fireEvent.change(field, { target: { value: "/release" } });
    fireEvent.click(await screen.findByRole("option", { name: /Release checklist/ }));
    fireEvent.change(field, { target: { value: "Release 4.2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    await waitFor(() => expect(saved).toHaveLength(6));
    const { parent, kids } = family("Release 4.2");
    expect(isTaskId(parent.id)).toBe(true);
    expect(kids.map((k) => k.title)).toEqual([
      "Freeze the release branch", "Run the regression suite", "Write the release notes", "Go / no-go check", "Ship it and watch the dashboards",
    ]);
  });
});
