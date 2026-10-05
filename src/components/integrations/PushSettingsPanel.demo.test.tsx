/* PushSettingsPanel with the real lib/push in demo mode (tests run without
   Supabase): a local stand-in that never touches a server. */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PushSettingsPanel } from "./PushSettingsPanel";
import { ToastProvider } from "../Toast";

describe("PushSettingsPanel in demo mode", () => {
  it("switches on, sends a test (toasted), switches off", async () => {
    render(<ToastProvider><PushSettingsPanel notifyPrefs={{}} onSaveNotifyPrefs={() => {}} /></ToastProvider>);
    expect(screen.getByText("Demo")).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: "Push notifications on this device" });
    await waitFor(() => expect(sw).not.toBeDisabled());
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "true"));
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    // jsdom has no Notification API: the demo says what would happen
    await waitFor(() => expect(screen.getAllByText("In the demo, your test notification would arrive on this device now.").length).toBeGreaterThan(0));
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
  });
});
