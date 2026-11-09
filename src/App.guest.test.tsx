/* The app for a guest, in demo mode: Daniel is a guest in Northlight Studio.
   The team's reporting (Pulse, Workload, Insights, Trends with Time & billing)
   is hidden AND route-guarded; Goals and Portfolios read calmly, with nothing
   to edit. (An interface gate: until private projects land, a guest can still
   read the workspace's tasks.) */
import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const key = (k: string) => fireEvent.keyDown(document.body, { key: k });
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;
/** Open the app in Northlight Studio, where the demo person is a guest. */
const asGuest = (url: string) => { localStorage.setItem("kanbo-last-ws:m-self", "ws-northlight"); at(url); };
/** The page header's tabs (links), by id. */
const tabIds = () => [...document.querySelectorAll<HTMLElement>(".ktab[data-tab-id]")].map((el) => el.dataset.tabId);

afterEach(() => { localStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("App · a guest", () => {
  it("never opens the team's reporting: an address to Trends (Time & billing) lands on People", async () => {
    asGuest("/team/insights/trends");
    await boot();
    await waitFor(() => expect(address()).toBe("/team/people"));
    expect(await screen.findByRole("heading", { level: 1, name: "Team" })).toBeInTheDocument();
    await waitFor(() => expect(tabIds()).toEqual(["team"]));
    expect(screen.queryByText("Time & billing")).toBeNull();
  });

  it("g-keys and the sidebar's Team go to People too", async () => {
    asGuest("/today");
    await boot();
    key("g"); key("a");
    await waitFor(() => expect(address()).toBe("/team/people"));
    key("g"); key("t");
    await waitFor(() => expect(address()).toBe("/tasks"));
    fireEvent.click(within(screen.getByRole("navigation", { name: "Main" })).getByRole("button", { name: /^Team/ }));
    await waitFor(() => expect(address()).toBe("/team/people"));
    for (const path of ["/team", "/team/workload", "/team/insights"]) {
      window.history.pushState(null, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
      await waitFor(() => expect(address()).toBe("/team/people"));
    }
  });

  it("reads Goals and Portfolios calmly: who they're for, nothing to create or edit", async () => {
    asGuest("/projects/goals");
    await boot();
    expect(await screen.findByText("Goals are for members")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New goal" })).toBeNull();
    expect(tabIds()).toEqual(["projects", "portfolios", "goals", "forms"]);   // (no Rules either)
    fireEvent.click(document.querySelector<HTMLElement>('.ktab[data-tab-id="portfolios"]')!);
    expect(await screen.findByText("Portfolios are for members")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New portfolio" })).toBeNull();
  });

  it("a member keeps the whole Team place", async () => {
    at("/team/insights");
    await boot();
    expect(await screen.findByRole("heading", { level: 1, name: "Team" })).toBeInTheDocument();
    await waitFor(() => expect(tabIds()).toEqual(["pulse", "team", "workload", "analytics"]));
    expect(address()).toBe("/team/insights");
  });
});
