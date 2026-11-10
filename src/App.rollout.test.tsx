/* Rolling Kanbo out (0058), through the whole app in demo mode: the first run's team path (/?first-run
   in the demo), "Welcome to Harbour Advisory" for Daniel, who joined it three days ago, Team › People ›
   Workspace health for Foundrise's owner, and Kanbo noticed's one next fix at Courtside Padel. */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { __resetOnboardingMemory } from "./lib/onboarding";
import { resetUpdateAsks } from "./lib/updateAsks";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const at = (url: string) => window.history.replaceState(null, "", url);
const sidebar = () => screen.getByRole("complementary", { name: "Sidebar" });
const switchTo = async (name: RegExp) => {
  fireEvent.click(within(sidebar()).getByRole("button", { name: /^Switch workspace/ }));
  fireEvent.click(within(await screen.findByRole("dialog", { name: "Workspaces" })).getByRole("button", { name }));
  await waitFor(() => expect(within(sidebar()).getByRole("button", { name: new RegExp(`^Switch workspace, current: ${name.source.replace(/^\^/, "")}`) })).toBeInTheDocument());
};
const onboarded = () => { localStorage.setItem("kanbo-onboarded", "1"); localStorage.setItem("kanbo-onboarded:m-self", "1"); localStorage.setItem("kanbo-tour-done", "1"); };
beforeEach(() => { __resetOnboardingMemory(); resetUpdateAsks(); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); at("/"); });

describe("App · rolling Kanbo out", () => {
  it("a new member is welcomed to Harbour Advisory once: their project, their people, where to start", async () => {
    onboarded();
    at("/today");
    await boot();
    await switchTo(/^Harbour Advisory/);
    const card = await screen.findByRole("region", { name: "Welcome to Harbour Advisory" });
    expect(within(card).getByRole("button", { name: /Northwind Review/ })).toBeInTheDocument();
    expect(within(card).getByText("Sana Rao")).toBeInTheDocument();
    expect(within(card).getByText(/Ask Sana, who runs Harbour Advisory, anything/)).toBeInTheDocument();
    // the brief says it's there (on a phone the brief fills the first screen)
    expect(screen.getByText(/Here's who's who and where to start\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show me" })).toBeInTheDocument();
    // not in a business you own
    await switchTo(/^Foundrise/);
    expect(screen.queryByRole("region", { name: /^Welcome to/ })).toBeNull();
    await switchTo(/^Harbour Advisory/);
    fireEvent.click(within(await screen.findByRole("region", { name: "Welcome to Harbour Advisory" })).getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Welcome to Harbour Advisory" })).toBeNull());
    await switchTo(/^Foundrise/);
    await switchTo(/^Harbour Advisory/);
    expect(screen.queryByRole("region", { name: "Welcome to Harbour Advisory" })).toBeNull();
  });

  it("Foundrise's owner sees its health on Team › People, and resends the waiting invites from there", async () => {
    onboarded();
    at("/team/people");
    await boot();
    const card = await screen.findByRole("region", { name: "Workspace health" });
    expect(within(card).getByText("2 people invited but not joined")).toBeInTheDocument();
    expect(within(card).getByText("Priya Shah and Jonas Berg haven't signed in yet.")).toBeInTheDocument();
    expect(await within(card).findByText(/people active in the last 7 days/)).toBeInTheDocument();
    expect(within(card).getByText("Maya Lin is your champion")).toBeInTheDocument();
    await act(async () => { fireEvent.click(within(card).getByRole("button", { name: "Resend all" })); });
    expect(await within(card).findByText("Sent 2 fresh invites.")).toBeInTheDocument();
    // the rollout plan saves to the workspace
    fireEvent.change(within(card).getByLabelText("Go-live date"), { target: { value: "2026-12-01" } });
    expect(await within(card).findByText(/Going live on/)).toBeInTheDocument();
  });

  it("a member never sees the health card", async () => {
    onboarded();
    at("/team/people");
    await boot();
    await switchTo(/^Harbour Advisory/);
    expect(screen.queryByRole("region", { name: "Workspace health" })).toBeNull();
  });

  it("a lead's one next fix in Kanbo noticed: Courtside Padel's missing update, asked for in one tap", async () => {
    onboarded();
    at("/today");
    await boot();
    await switchTo(/^Courtside Padel/);
    const ask = await screen.findByRole("button", { name: "Ask for it" });
    expect(screen.getByText("Clubhouse Fit-out has no update")).toBeInTheDocument();
    await act(async () => { fireEvent.click(ask); });
    expect(await screen.findByText(/Asked 1 owner/)).toBeInTheDocument();
  });

  it("the first run asks who it's for; a team gets its workspace and one sheet to set it up", async () => {
    at("/today?first-run");
    await boot();
    const sheet = await screen.findByRole("dialog", { name: "Welcome to Kanbo" });
    fireEvent.click(within(sheet).getByRole("button", { name: /Get started/ }));
    fireEvent.click(within(sheet).getByRole("button", { name: /My team/ }));
    fireEvent.change(within(sheet).getByLabelText("Team name"), { target: { value: "Studio Ops" } });
    await act(async () => { fireEvent.click(within(sheet).getByRole("button", { name: "Create workspace" })); });
    expect(await within(sheet).findByRole("heading", { name: "Set up Studio Ops" })).toBeInTheDocument();
    expect(within(sidebar()).getByRole("button", { name: /^Switch workspace, current: Studio Ops/ })).toBeInTheDocument();
    // the pack opens New project's packs for it, and the first-run sheet steps aside meanwhile
    fireEvent.click(within(sheet).getByRole("button", { name: "Pick a pack" }));
    expect(await screen.findByText("Business packs")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Set up Studio Ops" })).toBeNull();
  });
});
