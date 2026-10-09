/* Settings › Notifications › delivery, quiet hours and time zone (0048, u4). */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { NotificationPrefsPanel } from "./NotificationPrefsPanel";
import type { NotifyPrefs } from "../../data/types";

function Harness({ initial = {}, device = "Europe/London", onSave }: { initial?: NotifyPrefs; device?: string; onSave: (p: NotifyPrefs) => void }) {
  const [prefs, setPrefs] = useState<NotifyPrefs>(initial);
  return <NotificationPrefsPanel notifyPrefs={prefs} deviceTimeZone={device} onSaveNotifyPrefs={(p) => { onSave(p); setPrefs(p); }} />;
}
const group = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
});
afterEach(() => { vi.useRealTimers(); });

describe("NotificationPrefsPanel", () => {
  it("sums it all up in a line that's announced as it changes", () => {
    render(<Harness onSave={vi.fn()} initial={{ comment_email: false }} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Real time, bundled, London time");
    fireEvent.click(within(group("Delivery")).getByRole("button", { name: "Daily digest" }));
    expect(status).toHaveTextContent("Daily digest at 08:00, London time");
  });

  it("delivery: a daily digest at a time you pick — the whole object is saved, other keys kept", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} initial={{ comment_email: false }} />);
    const delivery = group("Delivery");
    expect(within(delivery).getByRole("group", { name: "How notifications reach you" })).toBeInTheDocument();
    fireEvent.click(within(delivery).getByRole("button", { name: "Daily digest" }));
    expect(onSave).toHaveBeenLastCalledWith({ comment_email: false, delivery: "digest" });
    expect(within(delivery).getByText(/Push only for mentions and approvals/)).toBeInTheDocument();
    const time = within(delivery).getByLabelText("Digest time");
    fireEvent.change(time, { target: { value: "" } });   // half-typed: nothing saved
    expect(onSave).toHaveBeenCalledTimes(1);
    fireEvent.change(time, { target: { value: "17:30" } });
    expect(onSave).toHaveBeenLastCalledWith({ comment_email: false, delivery: "digest", digest_time: "17:30" });
    fireEvent.click(within(delivery).getByRole("button", { name: "Real time" }));
    expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ delivery: "realtime" }));
    expect(within(delivery).queryByLabelText("Digest time")).toBeNull();
  });

  it("bundling: off saves false, on removes the key (it's the default)", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    const sw = screen.getByRole("switch", { name: "Bundle related notifications" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    fireEvent.click(sw);
    expect(onSave).toHaveBeenLastCalledWith({ bundle: false });
    fireEvent.click(sw);
    expect(onSave).toHaveBeenLastCalledWith({});
  });

  it("quiet hours: on with 22:00–07:00 every day; hours and days; off removes them", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} />);
    const quiet = group("Quiet hours");
    fireEvent.click(within(quiet).getByRole("switch", { name: "Quiet hours" }));
    expect(onSave).toHaveBeenLastCalledWith({ quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] } });
    expect(within(quiet).getByText("Overnight: ends at 07:00 the next morning.")).toBeInTheDocument();
    const hours = within(quiet).getByRole("group", { name: "Hours" });
    fireEvent.change(within(hours).getByLabelText("From"), { target: { value: "21:30" } });
    expect(onSave).toHaveBeenLastCalledWith({ quiet_hours: { start: "21:30", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] } });
    // weekends off: Sat and Sun don't start a quiet night
    const days = within(quiet).getByRole("group", { name: "Days" });
    fireEvent.click(within(days).getByRole("button", { name: "Saturday" }));
    fireEvent.click(within(days).getByRole("button", { name: "Sunday" }));
    expect(onSave).toHaveBeenLastCalledWith({ quiet_hours: { start: "21:30", end: "07:00", days: [1, 2, 3, 4, 5] } });
    expect(within(days).getByRole("button", { name: "Sunday" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("quiet 21:30–07:00 on weekdays");
    fireEvent.click(within(quiet).getByRole("switch", { name: "Quiet hours" }));
    expect(onSave).toHaveBeenLastCalledWith({});
    expect(within(quiet).queryByRole("group", { name: "Hours" })).toBeNull();
  });

  it("won't save the same start and end, or no days at all — and says why", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} initial={{ quiet_hours: { start: "22:00", end: "07:00", days: [3] } }} />);
    const quiet = group("Quiet hours");
    fireEvent.change(within(quiet).getByLabelText("to"), { target: { value: "22:00" } });
    expect(onSave).not.toHaveBeenCalled();
    expect(within(quiet).getByText("Pick an end time that's different from the start.")).toBeInTheDocument();
    expect(within(quiet).getByLabelText("to")).toHaveAttribute("aria-invalid", "true");
    fireEvent.click(within(quiet).getByRole("button", { name: "Wednesday" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(within(quiet).getByText("Keep at least one day, or switch quiet hours off.")).toBeInTheDocument();
  });

  it("a digest time inside quiet hours says when it really arrives", () => {
    render(<Harness onSave={vi.fn()} initial={{ delivery: "digest", digest_time: "07:00", quiet_hours: { start: "22:00", end: "08:30" } }} />);
    expect(screen.getByText("Inside your quiet hours, so it arrives when they end, at 08:30.")).toBeInTheDocument();
  });

  it("time zone: pick one, or use this device's", () => {
    const onSave = vi.fn();
    render(<Harness onSave={onSave} device="America/New_York" />);
    const zone = group("Time zone");
    const select = within(zone).getByLabelText("Your time zone") as HTMLSelectElement;
    expect(select.value).toBe("Europe/London");
    expect(within(select).getByRole("option", { name: "London (GMT+1)" })).toBeInTheDocument();
    fireEvent.click(within(zone).getByRole("button", { name: "Use this device's time zone" }));
    expect(onSave).toHaveBeenLastCalledWith({ timezone: "America/New_York" });
    expect(screen.getByRole("status")).toHaveTextContent("New York time");
    expect(within(zone).queryByRole("button", { name: "Use this device's time zone" })).toBeNull();
    fireEvent.change(select, { target: { value: "Asia/Tokyo" } });
    expect(onSave).toHaveBeenLastCalledWith({ timezone: "Asia/Tokyo" });
  });

  it("read-only without a save handler", () => {
    render(<NotificationPrefsPanel notifyPrefs={{ quiet_hours: { start: "22:00", end: "07:00" } }} deviceTimeZone="Europe/London" />);
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Bundle related notifications" })).toBeDisabled();
    expect(screen.getByLabelText("From")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Monday" })).toBeDisabled();
    expect(screen.getByLabelText("Your time zone")).toBeDisabled();
  });

  it("the demo says nothing is sent", () => {
    render(<Harness onSave={vi.fn()} />);
    expect(screen.getByText(/This is the demo/)).toBeInTheDocument();
  });
});
