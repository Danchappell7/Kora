/* Business packs through the whole app (demo mode): New workspace and
   New project › From a pack or template set up the projects, tasks, docs,
   goals (owned by you, for the quarter, linked to their work), a portfolio,
   a request form and the update day through the store's own creates, show
   them at once, and Undo takes it all back. */
import { describe, it, expect, vi, afterEach, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { store } from "./data/store";
import * as docs from "./lib/docs";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });
const spies: { mockRestore: () => void }[] = [];
const track = <T extends { mockRestore: () => void }>(s: T): T => { spies.push(s); return s; };
afterEach(() => {
  spies.splice(0).forEach((s) => s.mockRestore());
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
});
const card = (within_: HTMLElement, name: string) => within(within_).getByRole("heading", { name }).closest("li")!;

describe("App · business packs", () => {
  it("a new workspace set up from the fitness pack gets all of it, owned by you, and Undo takes it back", async () => {
    const goal = track(vi.spyOn(store, "createGoal"));
    const link = track(vi.spyOn(store, "addGoalLink"));
    const portfolio = track(vi.spyOn(store, "createPortfolio"));
    const rhythm = track(vi.spyOn(store, "setUpdateRhythm"));
    const form = track(vi.spyOn(store, "createForm"));
    const doc = track(vi.spyOn(docs, "saveProjectDoc"));
    const del = track(vi.spyOn(store, "deleteProject"));
    await boot();
    fireEvent.click(screen.getByRole("button", { name: /^Switch workspace/ }));
    fireEvent.click(await screen.findByRole("button", { name: "New workspace…" }));
    const named = await screen.findByRole("dialog", { name: "New workspace" });
    fireEvent.change(within(named).getByRole("textbox", { name: "Workspace name" }), { target: { value: "Acme" } });
    fireEvent.click(within(named).getByRole("button", { name: "Next" }));
    const setup = await screen.findByRole("dialog", { name: "Set up Acme" });
    fireEvent.click(within(card(setup, "Boutique fitness group")).getByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("dialog", { name: "Boutique fitness group for Acme" });
    await act(async () => { fireEvent.click(within(preview).getByRole("button", { name: "Set up Boutique fitness group" })); });
    const done = await screen.findByRole("dialog", { name: "Acme is set up" }, { timeout: 5000 });
    expect(within(done).getByRole("heading", { name: "Boutique fitness group is set up" })).toBeInTheDocument();
    expect(within(done).getByText("5 projects and 34 starter tasks")).toBeInTheDocument();
    // in Acme, under you
    expect(screen.getByRole("button", { name: /^Switch workspace, current: Acme/ })).toBeInTheDocument();
    const me = goal.mock.calls[0][1];
    const ws = goal.mock.calls[0][0].workspaceId;
    expect(goal).toHaveBeenCalledTimes(9);
    expect(goal.mock.calls[0][0]).toMatchObject({ name: "Full classes, every week", extra: { kind: "objective", ownerId: me, period: expect.stringMatching(/^\d{4}-Q[1-4]$/) } });
    expect(goal.mock.calls.every((c) => c[0].workspaceId === ws)).toBe(true);
    expect(link).toHaveBeenCalled();
    expect(portfolio.mock.calls[0][0]).toMatchObject({ workspaceId: ws, name: "Studio growth" });
    expect(portfolio.mock.calls[0][0].projectIds).toHaveLength(3);
    expect(rhythm).toHaveBeenCalledWith(ws, { cadence: "weekly", weekday: 1 });
    expect(form.mock.calls[0][0]).toMatchObject({ workspaceId: ws, name: "Report a maintenance problem" });
    expect(doc.mock.calls.map((c) => c[0].title)).toEqual(["Studio opening checklist", "Instructor handbook", "Opening and closing checklist", "Weekly studio meeting"]);
    // the projects are on screen at once
    const sidebar = screen.getByRole("navigation", { name: "Main" }).closest("aside") ?? document.body;
    expect(within(sidebar).getAllByText("New studio opening").length).toBeGreaterThan(0);
    // Undo: off the screen, and deleted
    await act(async () => { fireEvent.click(within(done).getByRole("button", { name: "Undo setup" })); });
    expect(await screen.findByRole("heading", { name: "Taken back" })).toBeInTheDocument();
    expect(del).toHaveBeenCalledTimes(5);
    expect(rhythm).toHaveBeenLastCalledWith(ws, null);
    expect(screen.queryAllByText("New studio opening", { selector: ".kproj *" })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Acme/ })).not.toBeInTheDocument());
  }, 30_000);

  it("New project › From a pack or template adds a pack to the workspace you're in, and its goals show on the Goals page", async () => {
    const rhythm = track(vi.spyOn(store, "setUpdateRhythm"));
    await boot();
    key("k", { ctrlKey: true });
    fireEvent.change(await screen.findByRole("combobox"), { target: { value: "new project" } });
    fireEvent.click(screen.getByRole("option", { name: /New project/ }));
    const dialog = await screen.findByRole("dialog", { name: "New project" });
    fireEvent.click(within(dialog).getByRole("button", { name: "From a pack or template" }));
    const gallery = await screen.findByRole("dialog", { name: "Packs and templates" });
    fireEvent.click(within(card(gallery, "Padel or sports venue")).getByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("dialog", { name: "Padel or sports venue" });
    // Foundrise keeps its own update day unless it's ticked
    expect(within(preview).getByRole("checkbox", { name: /Project updates every Monday/ })).not.toBeChecked();
    await act(async () => { fireEvent.click(within(preview).getByRole("button", { name: "Set up Padel or sports venue" })); });
    const done = await screen.findByRole("dialog", { name: "Padel or sports venue is set up" }, { timeout: 5000 });
    expect(within(done).getByText("4 projects and 24 starter tasks")).toBeInTheDocument();
    expect(rhythm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Switch workspace, current: Foundrise/ })).toBeInTheDocument();
    fireEvent.click(within(done).getByRole("button", { name: /^Open 3 goals/ }));
    expect(await screen.findByText("Busy courts at every hour")).toBeInTheDocument();
  }, 30_000);
});
