/* 0049: /link/slack opens "Link Slack account X in Y to Kanbo?" over the app
   (demo mode), the token leaves the address at once, and the task panel shows
   "From Slack" for a task made from a Slack message. */
import { describe, it, expect, afterEach, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import App from "./App";
import { loadAllChunks } from "./lib/lazyLoad";
import { AuthProvider } from "./auth/AuthProvider";
import { ToastProvider } from "./components/Toast";
import { pendingSlackLink, rememberSlackLink, resetSlackAppDemo } from "./lib/slackApp";

beforeAll(loadAllChunks, 60_000);
beforeEach(() => resetSlackAppDemo({ delayMs: 0 }));
afterEach(() => { localStorage.clear(); sessionStorage.clear(); window.history.replaceState(null, "", "/"); });

const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg";
const renderApp = () => render(<ToastProvider><AuthProvider><App /></AuthProvider></ToastProvider>);

describe("/link/slack", () => {
  it("asks, links, and takes the token out of the address straight away", async () => {
    window.history.replaceState(null, "", `/link/slack?t=${TOKEN}`);
    renderApp();
    const dialog = await screen.findByRole("dialog", { name: /Link Slack account You \(Slack\) in foundrise\.slack\.com to Kanbo\?/ });
    expect(window.location.href).not.toContain(TOKEN);
    expect(dialog).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(await screen.findByRole("heading", { name: "Slack is linked" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open Kanbo" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Slack/ })).toBeNull());
    expect(pendingSlackLink()).toBeNull();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
  });

  it("a link kept through signing in (Google comes back to /) opens too; Cancel drops it", async () => {
    rememberSlackLink(TOKEN);
    renderApp();
    expect(await screen.findByRole("dialog", { name: /Link Slack account/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: /Link Slack account/ })).toBeNull());
    expect(pendingSlackLink()).toBeNull();
  });

  it("anywhere else, nothing opens", async () => {
    window.history.replaceState(null, "", `/today?t=${TOKEN}`);
    renderApp();
    await waitFor(() => expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: /Link Slack account/ })).toBeNull();
  });
});
