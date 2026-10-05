/* PushSettingsPanel against a controllable lib/push: hidden when push isn't
   configured, the explained states, the switch, the test, the per-kind prefs. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PushAvailability } from "../../data/types";

const h = vi.hoisted(() => ({
  avail: "ready" as PushAvailability,
  on: false,
  demo: false,
  enable: null as null | (() => Promise<unknown>),
  test: null as null | (() => Promise<{ ok: boolean; message: string }>),
}));
vi.mock("../../lib/push", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/push")>();
  return {
    ...real,
    isPushDemo: () => h.demo,
    pushAvailability: () => h.avail,
    isPushOnHere: vi.fn(async () => h.on),
    enablePush: vi.fn(async () => (h.enable ? h.enable() : (h.on = true, { ok: true }))),
    disablePush: vi.fn(async () => { h.on = false; }),
    sendTestPush: vi.fn(async () => (h.test ? h.test() : { ok: true, message: "Test sent. It should arrive in a few seconds." })),
    deniedMessage: () => "Notifications are blocked for Kanbo in this browser.",
    unsupportedMessage: () => "On iPhone and iPad, add Kanbo to your Home Screen first.",
  };
});

import { PushSettingsPanel } from "./PushSettingsPanel";
import * as push from "../../lib/push";

beforeEach(() => {
  h.avail = "ready"; h.on = false; h.demo = false; h.enable = null; h.test = null;
  vi.clearAllMocks();
});
afterEach(() => vi.useRealTimers());

const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("PushSettingsPanel", () => {
  it("renders nothing when push isn't configured (no VAPID key)", async () => {
    h.avail = "unconfigured";
    const { container } = render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    await settle();
    expect(container).toBeEmptyDOMElement();
  });

  it("switches this device on from the click, then offers a test", async () => {
    render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Push notifications on this device" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("button", { name: "Send test" })).toBeNull();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    expect(push.enablePush).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Notifications are on for this device.");

    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await waitFor(() => expect(push.sendTestPush).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText("Test sent. It should arrive in a few seconds.", { selector: "span:not(.sr-only)" })).toBeInTheDocument());

    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(push.disablePush).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Send test" })).toBeNull();
  });

  it("says why it couldn't switch on", async () => {
    h.enable = async () => ({ ok: false, reason: "save_failed", message: "Push notifications aren't switched on for Kanbo yet." });
    render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    const sw = screen.getByRole("switch", { name: "Push notifications on this device" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByText("Push notifications aren't switched on for Kanbo yet.", { selector: "span:not(.sr-only)" })).toBeInTheDocument());
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("explains a blocked browser instead of offering a switch", async () => {
    h.avail = "denied";
    render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    await settle();
    expect(screen.queryByRole("switch", { name: "Push notifications on this device" })).toBeNull();
    expect(screen.getByText("Blocked")).toBeInTheDocument();
    expect(screen.getByText("Notifications are blocked for Kanbo in this browser.")).toBeInTheDocument();
  });

  it("explains an unsupported browser (iPhone: add to Home Screen first)", async () => {
    h.avail = "unsupported";
    render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    await settle();
    expect(screen.getByText("Not available")).toBeInTheDocument();
    expect(screen.getByText(/add Kanbo to your Home Screen first/)).toBeInTheDocument();
  });

  it("per-kind switches save notify_prefs '<kind>_push' (unset = on) and keep the other prefs", async () => {
    const save = vi.fn();
    render(<PushSettingsPanel notifyPrefs={{ assigned_email: false, due_push: false }} onSaveNotifyPrefs={save} />);
    await settle();
    const due = screen.getByRole("switch", { name: "Due-date reminders" });
    expect(due).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("switch", { name: "Mentions" })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(screen.getByRole("switch", { name: "Mentions" }));
    expect(save).toHaveBeenCalledWith({ assigned_email: false, due_push: false, mention_push: false });
    fireEvent.click(due);
    expect(save).toHaveBeenLastCalledWith({ assigned_email: false, due_push: true });
  });

  it("shows it's the demo", async () => {
    h.demo = true; h.avail = "unconfigured";
    render(<PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} />);
    await settle();
    expect(screen.getByText("Demo")).toBeInTheDocument();
    expect(screen.getByText(/nothing leaves your browser/)).toBeInTheDocument();
  });
});
