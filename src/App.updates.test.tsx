/* Project updates people reply to, and portfolio pages (0054), wired through the whole app in demo mode: Sana's
   update that asks you something waits in your Inbox and opens the brand project's Updates with its replies open; a
   portfolio opens its own page at /projects/portfolios/:id (Personal's in its own workspace); an author edits their
   update; Insights narrows to a portfolio. */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { resetUpdateConversation } from "./lib/updateConversation";
import { resetPortfolioUpdates } from "./lib/portfolioUpdates";

beforeAll(loadAllChunks, 60_000);

const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);
const boot = async () => { renderApp(); await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument()); };
const at = (url: string) => window.history.replaceState(null, "", url);
const address = () => window.location.pathname + window.location.search;

beforeEach(() => { resetUpdateConversation(); resetPortfolioUpdates(); localStorage.setItem("kanbo-onboarded", "1"); localStorage.setItem("kanbo-tour-done", "1"); });
afterEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

describe("App · project updates in the Inbox (0054)", () => {
  it("an Ask for you waits under Needs your reply, and opens the project's Updates with its replies", async () => {
    at("/inbox");
    await boot();
    const reply = await screen.findByRole("region", { name: "Needs your reply" });
    fireEvent.click(within(reply).getByRole("button", { name: /Sana Rao asked you something in the update on Brand Refresh/ }));
    await waitFor(() => expect(address()).toBe("/p/p-brand/updates"));
    expect(await screen.findByRole("textbox", { name: "Reply to Sana Rao" })).toBeInTheDocument();
    expect(screen.getByText("The hero copy is in the brand doc now.")).toBeInTheDocument();
  });

  it("the Inbox's Updates shows just the project updates", async () => {
    at("/inbox");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: /^Updates/ }));
    const list = screen.getByRole("region", { name: "Updates" });
    expect(within(list).getAllByRole("listitem").length).toBe(2);
  });
});

describe("App · an author edits their own update (0054)", () => {
  it("your launch update has Edit; Sana's brand update doesn't (you're the owner: you may delete it)", async () => {
    at("/p/p-launch/updates");
    await boot();
    const mine = await screen.findByText("Deck is the critical path; onboarding is blocked on tokens.");
    const li = mine.closest("li") as HTMLElement;
    fireEvent.click(within(li).getByRole("button", { name: "Update actions" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit update" }));
    fireEvent.change(within(li).getByRole("textbox", { name: "Update" }), { target: { value: "Deck is the critical path." } });
    fireEvent.click(within(li).getByRole("button", { name: "Save" }));
    // (saved: the history re-renders with the new words, marked edited)
    await waitFor(() => expect(within(screen.getByText("Deck is the critical path.").closest("li") as HTMLElement).getByText("· edited")).toBeInTheDocument());
  });
});

describe("App · portfolio pages (0054)", () => {
  it("a portfolio opens its own page from the list, with its sentence and its Updates", async () => {
    at("/projects/portfolios");
    await boot();
    fireEvent.click(await screen.findByRole("button", { name: "Open portfolio Q3 launch" }));
    await waitFor(() => expect(address()).toBe("/projects/portfolios/pf-q3"));
    expect(await screen.findByText(/^3 projects: /)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Updates" }));
    await waitFor(() => expect(address()).toBe("/projects/portfolios/pf-q3/updates"));
    expect(await screen.findByRole("textbox", { name: "Portfolio update" })).toBeInTheDocument();
  });

  it("a Personal portfolio's address opens in Personal; an unknown one says it isn't here", async () => {
    at("/projects/portfolios/pf-openings");
    await boot();
    expect(await screen.findByText(/only you can see it/)).toBeInTheDocument();
    expect(screen.getByDisplayValue("Every opening this quarter")).toBeInTheDocument();
  });

  it("an unknown portfolio says it isn't here, with the way back", async () => {
    at("/projects/portfolios/pf-nope");
    await boot();
    expect(await screen.findByText("This portfolio isn't here")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "All portfolios" }));
    await waitFor(() => expect(address()).toBe("/projects/portfolios"));
  });
});
