/* The UX wave (0048), wired through the whole app in demo mode: saved views in the
   sidebar and where they open, the Help menu and its tour, "Get set up" on Today,
   templates from New task and the task panel, the calmer-notifications panel in
   Settings, the streak on Today and kudos in the Inbox. */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { refreshClock } from "./data/data";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { resetSavedViewsForTests } from "./lib/views";
import { resetLibraryTemplates } from "./lib/templates";
import { __resetOnboardingMemory, __resetTourBus } from "./lib/onboarding";

beforeAll(loadAllChunks, 60_000);

const NOW = new Date("2026-10-09T10:00:00+01:00");
const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string, opts: Record<string, unknown> = {}) => fireEvent.keyDown(document.body, { key: k, ...opts });
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;
const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
  refreshClock(NOW);
  resetSavedViewsForTests();
  resetLibraryTemplates({ demoDelayMs: 0 });
  __resetOnboardingMemory();
  __resetTourBus();
});
afterEach(() => {
  vi.useRealTimers();
  refreshClock();
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
});

describe("App · saved views (0048)", () => {
  it("the sidebar lists the pinned views; a My tasks view opens on its own address, filtered as saved", async () => {
    await boot();
    const row = await within(sidebar()).findByRole("button", { name: /^Urgent and mine/ });
    fireEvent.click(row);
    await waitFor(() => expect(address()).toBe("/tasks?view=sv-demo-urgent"));
    expect(await screen.findByRole("heading", { level: 1, name: "My tasks" })).toBeInTheDocument();
    // the view's filter is on (and isn't written over your own My tasks filters)
    expect(await screen.findByRole("button", { name: "Remove filter: Urgent priority" })).toBeInTheDocument();
    expect(localStorage.getItem("kanbo-filters:my")).toBeNull();
  });

  it("a search view opens Search with its query", async () => {
    await boot();
    fireEvent.click(await within(sidebar()).findByRole("button", { name: /^Design in review/ }));
    await waitFor(() => expect(address()).toBe("/search/list/sv-demo-design"));
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeInTheDocument();
  });
});

describe("App · first run (0048)", () => {
  it("Help (?) offers the tour, shortcuts and the sample project; Take the tour starts it", async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByRole("button", { name: "Help" }));
    const menu = await screen.findByRole("menu", { name: "Help" });
    expect(within(menu).getByRole("menuitem", { name: /Try the sample project/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Take the tour/ }));
    // the coach mark: a non-modal dialog on the first step
    expect(await screen.findByRole("dialog", { name: /Your five places/ })).toBeInTheDocument();
  });

  it("Today shows the Get set up card in place of the old chip", async () => {
    await boot();
    expect(await screen.findByRole("heading", { level: 2, name: "Get set up" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /set up$/ })).toBeNull();
  });
});

describe("App · Today keeps its day (QA)", () => {
  it("beside the rail Get set up and the week's wins are folded to a row each; Set-up steps opens the list", async () => {
    await boot();
    const setup = await screen.findByRole("region", { name: "Get set up" });
    expect(setup).toHaveAttribute("data-folded");
    const wins = await screen.findByRole("region", { name: /^Your week so far/ });
    expect(wins).toHaveAttribute("data-folded");
    // side by side, under the brief: the day itself is still there below them
    expect(setup.parentElement).toBe(wins.parentElement);
    expect(document.querySelector(".kday-scroll .kday-canvas")).toBeInTheDocument();
    const steps = within(setup).getByRole("button", { name: "Set-up steps" });
    fireEvent.click(steps);
    await waitFor(() => expect(within(screen.getByRole("region", { name: "Get set up" })).getByRole("button", { name: "Set-up steps" })).toHaveAttribute("aria-expanded", "true"));
    expect(screen.getByRole("region", { name: "Get set up" })).not.toHaveAttribute("data-folded");
  });

  it("the week's wins name the task you thanked a teammate for (it's theirs, not yours)", async () => {
    await boot();
    const wins = await screen.findByRole("region", { name: /^Your week so far/ });
    fireEvent.click(within(wins).getByRole("button", { name: "Your week in full" }));
    const open = await screen.findByRole("region", { name: "Your week so far" });
    await waitFor(() => expect(within(open).getByRole("list", { name: "With your team" })).toHaveTextContent(/You thanked Sana for “Refresh brand colour palette”/));
    expect(open).not.toHaveTextContent("“a task”");
  });
});

describe("App · templates from anywhere (QA)", () => {
  it("⌘K › “template” offers New task from a template…, which opens the library", async () => {
    await boot();
    key("k", { metaKey: true });
    const input = await screen.findByRole("combobox", { name: "Search or ask Kanbo" });
    fireEvent.change(input, { target: { value: "template" } });
    fireEvent.click(await screen.findByRole("option", { name: /New task from a template…/ }));
    expect(await screen.findByRole("dialog", { name: "Template library" })).toBeInTheDocument();
  });
});

describe("App · templates (0048)", () => {
  it("New task ▾ › From a template… opens the library; Use template opens New task with it", async () => {
    await boot();
    fireEvent.click(screen.getByRole("button", { name: "More ways to create" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "From a template…" }));
    const lib = await screen.findByRole("dialog", { name: "Template library" });
    fireEvent.click(await within(lib).findByRole("option", { name: /Bug report/ }));
    fireEvent.click(await within(lib).findByRole("button", { name: "Use template" }));
    const form = await screen.findByRole("dialog", { name: "New task" });
    await waitFor(() => expect((within(form).getByRole("textbox", { name: "Task title" }) as HTMLTextAreaElement).value).toMatch(/^Bug/));
  });

  it("the task panel's ⋯ › Save as template… opens Save as template", async () => {
    at("/today?task=t-1");
    await boot();
    const panel = await screen.findByRole("dialog", { name: /^Task:/ });
    fireEvent.click(within(panel).getByRole("button", { name: "More actions" }));
    fireEvent.click(within(panel).getByRole("menuitem", { name: "Save as template…" }));
    expect(await screen.findByRole("dialog", { name: "Save as template" })).toBeInTheDocument();
  });
});

describe("App · notifications and momentum (0048)", () => {
  it("Settings › Notifications has delivery, quiet hours and time zone", async () => {
    await boot();
    key(",", { metaKey: true });
    const settings = await screen.findByRole("dialog", { name: /Settings/ });
    fireEvent.click(within(settings).getByRole("tab", { name: /^Notifications/ }));
    expect(await within(settings).findByRole("heading", { name: "Quiet hours" })).toBeInTheDocument();
    expect(within(settings).getByRole("heading", { name: "Delivery" })).toBeInTheDocument();
  });

  it("Settings › Appearance has the streak and wins rows", async () => {
    await boot();
    key(",", { metaKey: true });
    const settings = await screen.findByRole("dialog", { name: /Settings/ });
    expect(await within(settings).findByText("Show my streak on Today")).toBeInTheDocument();
    expect(within(settings).getByText("Show my week's wins")).toBeInTheDocument();
  });

  it("the Inbox shows the demo's kudos", async () => {
    await boot();
    key("g"); key("i");
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    expect(await screen.findByText(/sent you/)).toBeInTheDocument();
  });
});
