/* Settings › Notifications against a (mocked) real backend: each change is
   saved as a patch through merge_notify_prefs, one after another, so a stale
   tab or another device is never overwritten and a slow reply can't undo a
   newer choice; a change that can't be saved is put back and said; quiet
   hours, time zone and delivery changes re-plan what's already held. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import type { NotifyPrefs } from "../../data/types";

const { merge, replan } = vi.hoisted(() => ({ merge: vi.fn(), replan: vi.fn(async () => undefined) }));
vi.mock("../../lib/backend", () => ({ isSupabaseConfigured: true }));
vi.mock("../../lib/supabase", () => ({ supabase: null, isSupabaseConfigured: true }));
vi.mock("../../lib/notifyPrefs", async (orig) => ({
  ...(await orig<typeof import("../../lib/notifyPrefs")>()), mergeNotifyPrefs: merge, rescheduleHeldNotices: replan,
}));

import { NotificationPrefsPanel } from "./NotificationPrefsPanel";

/** the database's notify_prefs, as merge_notify_prefs merges into it (null removes a key) */
let server: NotifyPrefs = {};
const mergeLikeTheDatabase = async (patch: NotifyPrefs) => {
  const out: NotifyPrefs = { ...server };
  for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
  server = out;
  return { ...server };
};

function Harness({ initial = {}, onStored, onSave, wireStored = true }: {
  initial?: NotifyPrefs; onStored?: (p: NotifyPrefs) => void; onSave?: (p: NotifyPrefs) => void; wireStored?: boolean;
}) {
  const [prefs, setPrefs] = useState<NotifyPrefs>(initial);
  return (
    <NotificationPrefsPanel notifyPrefs={prefs} deviceTimeZone="Europe/London"
      onSaveNotifyPrefs={(p) => { onSave?.(p); setPrefs(p); }}
      onNotifyPrefsStored={wireStored ? (p) => { onStored?.(p); setPrefs(p); } : undefined} />
  );
}
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  merge.mockReset().mockImplementation(mergeLikeTheDatabase);
  replan.mockClear();
  server = {};
});
afterEach(() => { vi.useRealTimers(); });

describe("NotificationPrefsPanel with a backend", () => {
  it("saves the change alone, never the whole object: a stale tab keeps another device's quiet hours", async () => {
    // this tab loaded before quiet hours were set on the phone
    server = { comment_email: false, quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5] } };
    const onStored = vi.fn(), onSave = vi.fn();
    render(<Harness initial={{ comment_email: false }} onStored={onStored} onSave={onSave} />);
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute("aria-checked", "false");
    fireEvent.click(screen.getByRole("switch", { name: "Bundle related notifications" }));
    // shown at once
    expect(screen.getByRole("switch", { name: "Bundle related notifications" })).toHaveAttribute("aria-checked", "false");
    await settle();
    expect(merge).toHaveBeenCalledTimes(1);
    expect(merge).toHaveBeenCalledWith({ bundle: false });
    expect(server.quiet_hours).toEqual({ start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5] });
    // the stored prefs keep the profile in step (nothing saved twice)
    expect(onStored).toHaveBeenLastCalledWith(server);
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("switch", { name: "Quiet hours" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Real time, quiet 22:00–07:00 on weekdays, London time");
  });

  it("quick changes go one after another, in order; a slow reply can't undo a newer choice", async () => {
    server = { quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] } };
    const replies: (() => void)[] = [];
    merge.mockImplementation((patch: NotifyPrefs) => new Promise((res) => { replies.push(() => { void mergeLikeTheDatabase(patch).then(res); }); }));
    render(<Harness initial={server} />);
    const days = screen.getByRole("group", { name: "Days" });
    fireEvent.click(within(days).getByRole("button", { name: "Saturday" }));
    fireEvent.click(within(days).getByRole("button", { name: "Sunday" }));
    expect(within(days).getByRole("button", { name: "Saturday" })).toHaveAttribute("aria-pressed", "false");
    expect(within(days).getByRole("button", { name: "Sunday" })).toHaveAttribute("aria-pressed", "false");
    await settle();
    expect(merge).toHaveBeenCalledTimes(1);   // the second waits for the first
    replies.shift()!();
    await settle();
    // the first answer (Sat off, Sun still on) doesn't flash Sunday back on
    expect(within(days).getByRole("button", { name: "Sunday" })).toHaveAttribute("aria-pressed", "false");
    expect(merge).toHaveBeenCalledTimes(2);
    expect(merge.mock.calls.map((c) => (c[0] as { quiet_hours: { days: number[] } }).quiet_hours.days)).toEqual([[1, 2, 3, 4, 5, 7], [1, 2, 3, 4, 5]]);
    replies.shift()!();
    await settle();
    expect((server.quiet_hours as { days: number[] }).days).toEqual([1, 2, 3, 4, 5]);
    expect(screen.getByRole("status")).toHaveTextContent("on weekdays");
  });

  it("a change that can't be saved is put back, and the panel says so", async () => {
    merge.mockRejectedValueOnce(new Error("Failed to fetch"));
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Daily digest" }));
    expect(screen.getByRole("status")).toHaveTextContent("Daily digest at 08:00");
    await settle();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn't save that change, so it's back as it was.");
    expect(screen.getByRole("status")).toHaveTextContent("Real time, bundled, London time");
    // the next change clears it
    fireEvent.click(screen.getByRole("button", { name: "Daily digest" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await settle();
    expect(screen.getByRole("status")).toHaveTextContent("Daily digest at 08:00");
  });

  it("quiet hours, time zone or delivery: what's already held is planned again, once a burst settles; bundling doesn't", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("switch", { name: "Bundle related notifications" }));
    await settle();
    expect(replan).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Days" })).getByRole("button", { name: "Sunday" }));
    await settle();
    expect(replan).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("switch", { name: "Quiet hours" }));   // off: release what waited
    await settle();
    expect(replan).toHaveBeenCalledTimes(2);
    expect(server).toEqual({ bundle: false });
  });

  it("only the old callback wired: it's told the stored prefs once, when the changes settle", async () => {
    server = { quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] } };
    const onSave = vi.fn();
    render(<Harness initial={{}} onSave={onSave} wireStored={false} />);
    fireEvent.click(screen.getByRole("switch", { name: "Bundle related notifications" }));
    fireEvent.click(screen.getByRole("button", { name: "Daily digest" }));
    await settle();
    expect(merge.mock.calls.map((c) => c[0])).toEqual([{ bundle: false }, { delivery: "digest" }]);
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({ quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] }, bundle: false, delivery: "digest" });
  });

  it("a typed time is one patch, after the pause", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
    render(<Harness initial={{ quiet_hours: { start: "22:00", end: "07:00" } }} />);
    const from = within(screen.getByRole("group", { name: "Hours" })).getByLabelText("From");
    for (const v of ["21:00", "21:15", "21:30"]) fireEvent.change(from, { target: { value: v } });
    await settle();
    expect(merge).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(650); });
    await settle();
    expect(merge.mock.calls).toEqual([[{ quiet_hours: { start: "21:30", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] } }]]);
  });
});
