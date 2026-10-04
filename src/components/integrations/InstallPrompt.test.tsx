/* InstallPrompt: the Settings row in each install state, and the one-time sidebar nudge. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { InstallState } from "../../lib/install";

const h = vi.hoisted(() => ({
  state: "unavailable" as InstallState,
  standalone: false,
  family: "chromium" as "safari-mac" | "firefox" | "chromium" | "other",
  outcome: "accepted" as "accepted" | "dismissed" | "unavailable",
  listeners: new Set<(s: InstallState) => void>(),
}));
vi.mock("../../lib/install", () => ({
  installState: () => h.state,
  isStandalone: () => h.standalone,
  browserFamily: () => h.family,
  onInstallStateChange: (fn: (s: InstallState) => void) => { h.listeners.add(fn); return () => h.listeners.delete(fn); },
  promptInstall: vi.fn(async () => h.outcome),
}));

import { InstallPrompt, INSTALL_NUDGE_KEY } from "./InstallPrompt";
import { promptInstall } from "../../lib/install";

const setState = (s: InstallState) => act(() => { h.state = s; for (const fn of h.listeners) fn(s); });

beforeEach(() => {
  h.state = "unavailable"; h.standalone = false; h.family = "chromium"; h.outcome = "accepted";
  h.listeners.clear();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("InstallPrompt (settings)", () => {
  it("offers the browser's install when there is one", async () => {
    h.state = "available";
    render(<InstallPrompt variant="settings" />);
    fireEvent.click(screen.getByRole("button", { name: "Install" }));
    await waitFor(() => expect(promptInstall).toHaveBeenCalledTimes(1));
  });

  it("follows the state live (prompt arrives, app installed)", () => {
    render(<InstallPrompt variant="settings" />);
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull();
    setState("available");
    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
    setState("installed");
    expect(screen.getByText("Installed")).toBeInTheDocument();
    expect(screen.getByText(/Open Kanbo from your dock/)).toBeInTheDocument();
  });

  it("running installed says so", () => {
    h.state = "installed"; h.standalone = true;
    render(<InstallPrompt variant="settings" />);
    expect(screen.getByText("You're using the installed app.")).toBeInTheDocument();
  });

  it("iPhone and iPad: Share, then Add to Home Screen", () => {
    h.state = "ios";
    render(<InstallPrompt variant="settings" />);
    expect(screen.getByText("Add Kanbo to your Home Screen")).toBeInTheDocument();
    expect(screen.getByText(/then Add to Home Screen/)).toBeInTheDocument();
  });

  it("no prompt: how to install from this browser", () => {
    h.family = "safari-mac";
    const { unmount } = render(<InstallPrompt variant="settings" />);
    expect(screen.getByText("In Safari, choose File, then Add to Dock.")).toBeInTheDocument();
    unmount();
    h.family = "firefox";
    render(<InstallPrompt variant="settings" />);
    expect(screen.getByText(/Firefox doesn't install web apps/)).toBeInTheDocument();
  });
});

describe("InstallPrompt (sidebar nudge)", () => {
  it("shows only when the browser offers an install", () => {
    const { container } = render(<InstallPrompt variant="nudge" />);
    expect(container).toBeEmptyDOMElement();
    setState("available");
    expect(screen.getByRole("group", { name: "Install Kanbo" })).toBeInTheDocument();
    setState("installed");
    expect(container).toBeEmptyDOMElement();
  });

  it("'Not now' hides it for good on this device", () => {
    h.state = "available";
    const onDismiss = vi.fn();
    const { container, unmount } = render(<InstallPrompt variant="nudge" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(container).toBeEmptyDOMElement();
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INSTALL_NUDGE_KEY)).toBe("dismissed");
    unmount();
    const again = render(<InstallPrompt variant="nudge" />);
    expect(again.container).toBeEmptyDOMElement();
  });

  it("installing from it is the one time too", async () => {
    h.state = "available"; h.outcome = "dismissed";
    const onDismiss = vi.fn();
    const { container } = render(<InstallPrompt variant="nudge" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: /^Install Kanbo/ }));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(promptInstall).toHaveBeenCalledTimes(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(INSTALL_NUDGE_KEY)).toBe("dismissed");
  });
});
