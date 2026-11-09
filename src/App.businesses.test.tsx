/* One view across your businesses, wired through the whole app in demo mode (Foundrise and Reco HQ are
   yours, you're an admin at Courtside Padel and a member at Harbour Advisory): the switcher's dots, the
   time planned in other businesses on Today, All businesses on Today, Inbox and My tasks, Projects ›
   Group, and a Personal portfolio across businesses. */
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
const allBusinesses = () => screen.getByRole("button", { name: "All businesses" });

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
  vi.useRealTimers();
  refreshClock();
  localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/");
});

describe("App · across businesses", () => {
  it("the switcher says what's unread and what needs you in each workspace", async () => {
    await boot();
    const switcher = within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Foundrise/ });
    await waitFor(() => expect(switcher).toHaveAccessibleName(/other workspaces have something for you$/));
    fireEvent.click(switcher);
    const menu = await screen.findByRole("dialog", { name: "Workspaces" });
    await waitFor(() => expect(within(menu).getByRole("button", { name: "Courtside Padel, 2 unread, needs you: 1 approval · 1 overdue" })).toBeInTheDocument());
    expect(within(menu).getByRole("button", { name: /^Harbour Advisory, 1 unread/ })).toBeInTheDocument();
  });

  it("Today keeps the time you've planned in another business free, and names it", async () => {
    await boot();
    expect(await screen.findByText("Reco HQ · Investor call prep")).toBeInTheDocument();
    // one workspace's day by default: Courtside Padel's overdue order isn't on it
    expect(screen.queryByText("Sign the clubhouse lighting order")).toBeNull();
    expect(allBusinesses()).toHaveAttribute("aria-pressed", "false");
  });

  it("All businesses on Today: every business's work, led by the one that needs you most; then Inbox and My tasks follow", async () => {
    await boot();
    fireEvent.click(allBusinesses());
    await waitFor(() => expect(allBusinesses()).toHaveAttribute("aria-pressed", "true"));
    expect(await screen.findByRole("note", { name: "Across your businesses" })).toHaveTextContent(/needs you most today/);
    expect((await screen.findAllByText("Sign the clubhouse lighting order")).length).toBeGreaterThan(0);
    // its block is on the day itself now, not a busy stretch from elsewhere
    expect(screen.queryByText("Reco HQ · Investor call prep")).toBeNull();

    // the Inbox: every business's items, each with its business
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^Inbox/ }));
    await waitFor(() => expect(address()).toBe("/inbox"));
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    const mention = await screen.findByRole("button", { name: /Theo Vance mentioned you in Sign the clubhouse lighting order/ });
    expect(mention.closest(".kinbox-row")).toHaveTextContent("In Courtside Padel");
    expect(allBusinesses()).toHaveAttribute("aria-pressed", "true");

    // My tasks: yours everywhere
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^My tasks/ }));
    await waitFor(() => expect(address()).toBe("/tasks"));
    await waitFor(() => expect(screen.getByText(/^All businesses · \d+ open$/)).toBeInTheDocument());
    const row = (await screen.findAllByText("Sign the clubhouse lighting order"))[0].closest("[data-task-id], .ktv-row, li, [role='row']");
    expect(row).toHaveTextContent("In Courtside Padel");

    // switched off: one workspace again (the Inbox's default)
    fireEvent.click(allBusinesses());
    await waitFor(() => expect(screen.queryByText("Sign the clubhouse lighting order")).toBeNull());
    expect(screen.getByText(/^Foundrise · \d+ open$/)).toBeInTheDocument();
  });

  it("the single-workspace Inbox stays the default: another business's items never show there", async () => {
    at("/inbox");
    await boot();
    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeInTheDocument();
    await screen.findByRole("button", { name: /Sana Rao mentioned you in Define design tokens v2/ });
    expect(screen.queryByText(/Sign the clubhouse lighting order/)).toBeNull();
    expect(screen.queryByText(/Read the Northwind board pack/)).toBeNull();
  });

  it("Projects › Group: the businesses you run, side by side; clicking one goes there and opens it", async () => {
    at("/projects/group");
    await boot();
    expect(await screen.findByRole("link", { name: "Group" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual(expect.arrayContaining(["Foundrise", "Reco HQ", "Courtside Padel"])));
    expect(screen.queryByRole("heading", { level: 2, name: "Harbour Advisory" })).toBeNull();    // only a member there
    const court = screen.getByRole("region", { name: "Courtside Padel" });
    fireEvent.click(within(court).getByRole("button", { name: "Clubhouse Fit-out" }));
    await waitFor(() => expect(address()).toMatch(/^\/p\/p-clubhouse/));
    expect(within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Courtside Padel/ })).toBeInTheDocument();
  });

  it("a Personal portfolio holds projects from every business, says only you can see it, and flags one you can't see", async () => {
    await boot();
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^Switch workspace/ }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Workspaces" })).getByRole("button", { name: /^Personal/ }));
    await waitFor(() => expect(within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Personal/ })).toBeInTheDocument());
    fireEvent.click(within(sidebar()).getByRole("button", { name: /^Projects/ }));
    fireEvent.click(await screen.findByRole("link", { name: "Portfolios" }));
    const card = await screen.findByRole("article", { name: "Portfolio Every opening this quarter" });
    expect(within(card).getByText("Only you can see this")).toBeInTheDocument();
    expect(within(card).getByText("No longer visible to you")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: "Open project Clubhouse Fit-out" })).toBeInTheDocument();
    // opening one goes to its business
    fireEvent.click(within(card).getByRole("button", { name: "Open project Clubhouse Fit-out" }));
    await waitFor(() => expect(address()).toMatch(/^\/p\/p-clubhouse/));
    expect(within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Courtside Padel/ })).toBeInTheDocument();
  });
});
