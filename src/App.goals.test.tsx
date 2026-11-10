/* Goals wired through the whole app in demo mode: the goal panel and the task panel share the right-hand
   side (one at a time), a goal panel that covers the page (below 1280px) closes when you follow a link out
   of it, and a goal from another business is edited by your role there, not the open business's. */
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { refreshClock } from "./data/data";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { resetSavedViewsForTests } from "./lib/views";
import { resetApprovalsDemo } from "./lib/approvals";
import { __resetOnboardingMemory } from "./lib/onboarding";

beforeAll(loadAllChunks, 60_000);

// 10:00 on the day the demo seed was made (its dates are relative to it)
const NOW = (() => { const d = new Date(); d.setHours(10, 0, 0, 0); return d; })();
const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname;
const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
const goalPanel = (name: string) => screen.queryByRole("dialog", { name: `Goal: ${name}` });
const taskPanels = () => screen.queryAllByRole("dialog", { name: /^Task: / });
const realMatchMedia = window.matchMedia;
/** a wide screen (≥ 1280px): panels dock beside the page */
const wide = () => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: /min-width:\s*1280px/.test(query), media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["Date"] });
  vi.setSystemTime(NOW);
  refreshClock(NOW);
  resetSavedViewsForTests();
  resetApprovalsDemo({ demoDelayMs: 0 });
  __resetOnboardingMemory();
  try { localStorage.setItem("kanbo-what-moved-v1", "1"); } catch { /* ignore */ }
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  vi.useRealTimers();
  refreshClock();
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
});

describe("App · goals", () => {
  it("a task's Serves chip opens the goal in the task panel's place (never hidden underneath it), and a task opened from the goal takes it back", async () => {
    at("/p/p-launch?task=t-21");
    await boot();
    const task = await waitFor(() => { const t = taskPanels(); expect(t).toHaveLength(1); return t[0]; });
    fireEvent.click(within(task).getByRole("button", { name: /^Serves .*Win back 120 lapsed accounts/ }));
    await waitFor(() => expect(goalPanel("Win back 120 lapsed accounts")).toBeInTheDocument());
    expect(taskPanels()).toHaveLength(0);
    // the goal's linked task opens its panel, and the goal panel makes way
    fireEvent.click(within(goalPanel("Win back 120 lapsed accounts")!).getByRole("button", { name: "Open Send the interview brief" }));
    await waitFor(() => expect(taskPanels()).toHaveLength(1));
    expect(goalPanel("Win back 120 lapsed accounts")).toBeNull();
  });

  it("below 1280px the goal panel covers the page, so following a linked project out of it closes it", async () => {
    at("/goals");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Grow weekly actives to 5,000" }));
    const panel = await waitFor(() => { const p = goalPanel("Grow weekly actives to 5,000"); expect(p).toBeInTheDocument(); return p!; });
    fireEvent.click(within(panel).getByRole("button", { name: "Open Q3 Product Launch" }));
    await waitFor(() => expect(address()).toMatch(/^\/p\/p-launch/));
    await waitFor(() => expect(goalPanel("Grow weekly actives to 5,000")).toBeNull());
  });

  it("a goal from a business you own is edited from one where you're a guest (your role in the goal's business decides)", async () => {
    wide();
    at("/goals");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Grow weekly actives to 5,000" }));
    await waitFor(() => expect(goalPanel("Grow weekly actives to 5,000")).toBeInTheDocument());
    // docked beside the page: switch to Northlight Studio, where you're a guest
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^Switch workspace/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Workspaces" })).getByRole("button", { name: /^Northlight Studio/ }));
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Northlight Studio/ })).toBeInTheDocument());
    const panel = goalPanel("Grow weekly actives to 5,000")!;
    expect(panel).toBeInTheDocument();
    const status = within(panel).getByLabelText("Status of Grow weekly actives to 5,000") as HTMLSelectElement;
    fireEvent.change(status, { target: { value: "off_track" } });
    await waitFor(() => expect((within(goalPanel("Grow weekly actives to 5,000")!).getByLabelText("Status of Grow weekly actives to 5,000") as HTMLSelectElement).value).toBe("off_track"));
    expect(screen.queryByText(/Guests can view and comment/)).toBeNull();
  });
});
