/* The app split by screen (lazyViews.ts), without loading everything up front:
   a place whose code hasn't arrived shows a skeleton of its page, then the page;
   pointing at a place starts fetching it; the task panel and ⌘K are fetched the
   first time they open. (Every other App test loads all chunks first.) */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { chunksFor, CommandPalette, TaskDetail } from "./lazyViews";

const SLOW = { timeout: 10_000 }; // the first import of a screen is transformed on the spot
afterEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });

const boot = async () => {
  render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
  await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
};
const navButton = (name: RegExp) => within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name });

describe("App, split by screen", () => {
  it("boots on Today with no other place's code loaded", async () => {
    await boot();
    expect(screen.getByRole("heading", { level: 1, name: "Today" })).toBeInTheDocument();
    for (const view of ["inbox", "tasks", "projects", "pulse"] as const) expect(chunksFor({ view }).every((c) => c.loaded === null), view).toBe(true);
    expect(TaskDetail.chunk.loaded).toBeNull();
    expect(CommandPalette.chunk.loaded).toBeNull();
  });

  it("a place whose code is still arriving shows a skeleton of its page (with a status line), then the page", async () => {
    await boot();
    fireEvent.click(navButton(/^Inbox/));
    // the header has already moved on; the page below is its silhouette
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByText("Loading Inbox…")).toBeInTheDocument();
    expect(document.querySelector(".kpskel[data-kind='list']")).not.toBeNull();
    expect(await screen.findByRole("group", { name: "Show" }, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Loading Inbox…")).toBeNull();
    expect(document.querySelector(".kpskel")).toBeNull();
  });

  it("pointing at a place in the sidebar fetches it, so it opens without a skeleton", async () => {
    await boot();
    const projects = navButton(/^Projects/);
    fireEvent.pointerEnter(projects);
    await waitFor(() => expect(chunksFor({ view: "projects" })[0].loaded).not.toBeNull(), SLOW);
    fireEvent.click(projects);
    expect(screen.queryByText("Loading Projects…")).toBeNull();
    expect(screen.getByLabelText("Filter projects")).toBeInTheDocument();
  });

  it("the task panel is fetched the first time a task opens (its place held meanwhile)", async () => {
    await boot();
    fireEvent.click(navButton(/^My tasks/));
    fireEvent.click((await screen.findAllByText("Finalise Q3 launch narrative deck", undefined, SLOW))[0]);
    expect(screen.getByText("Loading task…")).toBeInTheDocument();
    expect(await screen.findByRole("dialog", { name: "Task: Finalise Q3 launch narrative deck" }, SLOW)).toBeInTheDocument();
    expect(screen.queryByText("Loading task…")).toBeNull();
  });

  it("⌘K's palette is fetched when it first opens, and stays mounted after", async () => {
    await boot();
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" }, SLOW)).toBeInTheDocument();
    expect(CommandPalette.chunk.loaded).not.toBeNull();
  });
});
