/* CalendarFeedPanel: "Add Kanbo to your calendar" in Settings › Calendar & integrations. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, within, waitFor } from "@testing-library/react";
import type { CalendarFeed } from "../../data/types";
import type { CalendarFeedLoad } from "../../lib/calendarFeed";

const TOKEN = "0123456789abcdef".repeat(4);
const TOKEN2 = "fedcba9876543210".repeat(4);
const BASE = "https://abc.supabase.co";

const lib = vi.hoisted(() => ({
  load: vi.fn<(opts?: { refresh?: boolean }) => Promise<CalendarFeedLoad>>(),
  setDue: vi.fn<(v: boolean) => Promise<CalendarFeed | null>>(),
  reset: vi.fn<() => Promise<CalendarFeed | null>>(),
  copy: vi.fn<(t: string) => Promise<boolean>>(),
}));

vi.mock("../../lib/calendarFeed", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/calendarFeed")>();
  return {
    ...real,
    calendarFeedUrl: (t: string) => real.calendarFeedUrl(t, BASE),
    loadCalendarFeed: lib.load,
    setCalendarFeedIncludeDue: lib.setDue,
    resetCalendarFeed: lib.reset,
  };
});
vi.mock("../rituals/shared", async (importOriginal) => {
  const real = await importOriginal<typeof import("../rituals/shared")>();
  return { ...real, copyText: lib.copy };
});

import { CalendarFeedPanel, maskFeedUrl } from "./CalendarFeedPanel";
import * as feedLib from "../../lib/calendarFeed";

const ready = (over: Partial<CalendarFeed> = {}): CalendarFeedLoad => ({ state: "ready", feed: { token: TOKEN, includeDue: true, ...over } });
const feedUrl = (t = TOKEN) => `${BASE}/functions/v1/ics-feed?t=${t}`;

async function mount(state: CalendarFeedLoad, props: Parameters<typeof CalendarFeedPanel>[0] = {}) {
  lib.load.mockResolvedValue(state);
  const r = render(<CalendarFeedPanel {...props} />);
  await act(async () => { await Promise.resolve(); });
  return r;
}
const field = () => screen.getByLabelText("Your private calendar link") as HTMLInputElement;

beforeEach(() => {
  lib.load.mockReset(); lib.setDue.mockReset(); lib.reset.mockReset(); lib.copy.mockReset();
});

describe("CalendarFeedPanel", () => {
  it("demo: an example link, every action off, and says it works once signed in", async () => {
    await mount({ state: "demo" });
    const group = screen.getByRole("region", { name: "Add Kanbo to your calendar" });
    expect(within(group).getByText("Example")).toBeInTheDocument();
    expect(field().value).toBe(`${feedLib.DEMO_FEED_BASE}/functions/v1/ics-feed?t=demo`);
    expect(screen.getByText(/This is an example\. Your own link appears here once you're signed in/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy calendar link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add to Google Calendar/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to Outlook.com" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add to Outlook for work or school" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Include due dates" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reset link" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Show the link" })).toBeNull();
  });

  it("loading: a skeleton and a status line, actions off", () => {
    lib.load.mockReturnValue(new Promise(() => {}));
    render(<CalendarFeedPanel />);
    expect(screen.getByText("Getting your calendar link…").closest("[role=status]")).toBeInTheDocument();
    expect(screen.getByText("Getting your calendar link…").closest("[aria-busy]")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy calendar link" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Add to Google Calendar/ })).toBeDisabled();
  });

  it("ready: the link is hidden until you ask, then shown in full", async () => {
    await mount(ready());
    expect(within(screen.getByRole("region", { name: "Add Kanbo to your calendar" })).getByText("Private")).toBeInTheDocument();
    expect(field().value).toBe(`…/ics-feed?t=••••••••${TOKEN.slice(-4)}`);
    expect(field()).toHaveAttribute("tabindex", "-1");
    expect(field().value).not.toContain(TOKEN);
    fireEvent.click(screen.getByRole("button", { name: "Show the link" }));
    expect(field().value).toBe(feedUrl());
    expect(field()).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("button", { name: "Hide the link" })).toHaveAttribute("aria-pressed", "true");
  });

  it("copy puts the full link on the clipboard and confirms", async () => {
    lib.copy.mockResolvedValue(true);
    await mount(ready());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy calendar link" })); });
    expect(lib.copy).toHaveBeenCalledWith(feedUrl());
    expect(screen.getByRole("button", { name: "Calendar link copied" })).toHaveTextContent("Copied");
    expect(screen.getByText("Calendar link copied", { selector: "[role=status]" })).toBeInTheDocument();
  });

  it("when the clipboard is blocked: shows and selects the link, and says how to copy it", async () => {
    lib.copy.mockResolvedValue(false);
    await mount(ready());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy calendar link" })); });
    expect(screen.getByText(/Couldn't copy automatically/)).toBeInTheDocument();
    expect(field().value).toBe(feedUrl());
    expect(field().getAttribute("aria-describedby")).toMatch(/ /);
  });

  it("Google, Outlook and the calendar-app link point at the subscription URLs", async () => {
    await mount(ready());
    const g = screen.getByRole("link", { name: /Add to Google Calendar/ });
    expect(g).toHaveAttribute("href", feedLib.googleCalendarSubscribeUrl(feedUrl()));
    expect(g).toHaveAttribute("target", "_blank");
    expect(g.getAttribute("rel")).toContain("noopener");
    expect(g.getAttribute("rel")).toContain("noreferrer");
    expect(g).toHaveTextContent("(opens in a new tab)");
    expect(screen.getByRole("link", { name: "Add to Outlook.com (opens in a new tab)" }))
      .toHaveAttribute("href", feedLib.outlookSubscribeUrl(feedUrl(), "Kanbo"));
    expect(screen.getByRole("link", { name: "Add to Outlook for work or school (opens in a new tab)" }))
      .toHaveAttribute("href", feedLib.outlook365SubscribeUrl(feedUrl(), "Kanbo"));
    const app = screen.getByRole("link", { name: "Open in calendar app" });
    expect(app).toHaveAttribute("href", `webcal://abc.supabase.co/functions/v1/ics-feed?t=${TOKEN}`);
    expect(app).not.toHaveAttribute("target");
    expect(screen.getByText("Apple Calendar, Outlook for Windows and other apps")).toBeInTheDocument();
  });

  it("include due dates: saves the choice", async () => {
    lib.setDue.mockResolvedValue({ token: TOKEN, includeDue: false });
    await mount(ready());
    const sw = screen.getByRole("switch", { name: "Include due dates" });
    expect(sw).toHaveAttribute("aria-checked", "true");
    await act(async () => { fireEvent.click(sw); });
    expect(lib.setDue).toHaveBeenCalledWith(false);
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(sw).not.toBeDisabled();
  });

  it("include due dates: a failed save puts the switch back and says why", async () => {
    lib.setDue.mockRejectedValue(new Error("You're offline. Try again when you're back online."));
    await mount(ready({ includeDue: false }));
    const sw = screen.getByRole("switch", { name: "Include due dates" });
    await act(async () => { fireEvent.click(sw); });
    expect(sw).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("alert")).toHaveTextContent("You're offline. Try again when you're back online.");
  });

  it("reset: asks first, Escape backs out (not the whole sheet) and focus returns", async () => {
    await mount(ready());
    const resetBtn = screen.getByRole("button", { name: "Reset link" });
    fireEvent.click(resetBtn);
    const confirm = screen.getByRole("group", { name: "Reset your calendar link?" });
    expect(resetBtn).toHaveAttribute("aria-expanded", "true");
    expect(within(confirm).getByText(/stops updating/)).toBeInTheDocument();
    const cancel = within(confirm).getByRole("button", { name: "Cancel" });
    await waitFor(() => expect(document.activeElement).toBe(cancel));
    expect(confirm).toHaveAccessibleDescription(/Any calendar using the old one stops updating/);
    const outside = vi.fn();
    document.addEventListener("keydown", outside);
    fireEvent.keyDown(cancel, { key: "Escape" });
    document.removeEventListener("keydown", outside);
    expect(outside).not.toHaveBeenCalled();
    expect(screen.queryByRole("group", { name: "Reset your calendar link?" })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(resetBtn));
    expect(lib.reset).not.toHaveBeenCalled();
  });

  it("reset: makes a new link, tells you to add it again and calls onReset", async () => {
    lib.reset.mockResolvedValue({ token: TOKEN2, includeDue: true });
    const onReset = vi.fn();
    await mount(ready(), { onReset });
    fireEvent.click(screen.getByRole("button", { name: "Reset link" }));
    const confirm = screen.getByRole("group", { name: "Reset your calendar link?" });
    await act(async () => { fireEvent.click(within(confirm).getByRole("button", { name: "Reset link" })); });
    expect(lib.reset).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("group", { name: "Reset your calendar link?" })).toBeNull();
    expect(field().value.endsWith(TOKEN2.slice(-4))).toBe(true);
    expect(screen.getByText("New calendar link ready. Add it to your calendar again.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Add to Google Calendar/ })).toHaveAttribute("href", feedLib.googleCalendarSubscribeUrl(feedUrl(TOKEN2)));
  });

  it("reset: a failure keeps the old link and says why", async () => {
    lib.reset.mockRejectedValue(new Error("Kanbo couldn't reach the server. Try again in a moment."));
    const onReset = vi.fn();
    await mount(ready(), { onReset });
    fireEvent.click(screen.getByRole("button", { name: "Reset link" }));
    await act(async () => { fireEvent.click(within(screen.getByRole("group", { name: "Reset your calendar link?" })).getByRole("button", { name: "Reset link" })); });
    expect(screen.getByRole("alert")).toHaveTextContent("Kanbo couldn't reach the server.");
    expect(onReset).not.toHaveBeenCalled();
    expect(field().value.endsWith(TOKEN.slice(-4))).toBe(true);
  });

  it("before 0043: explains it isn't switched on yet, with no link", async () => {
    await mount({ state: "unavailable" });
    expect(screen.getByText("Not switched on yet")).toBeInTheDocument();
    expect(screen.getByText(/There's nothing you need to do/)).toBeInTheDocument();
    expect(screen.queryByLabelText("Your private calendar link")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("signed out: asks you to sign in", async () => {
    await mount({ state: "signedOut" });
    expect(screen.getByText("Sign in to get your link")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your private calendar link")).toBeNull();
  });

  it("an error: says why, and Try again asks the server again", async () => {
    await mount({ state: "error", message: "You're offline. Try again when you're back online." });
    expect(screen.getByText("Your calendar link didn't load")).toBeInTheDocument();
    expect(screen.getByText("You're offline. Try again when you're back online.")).toBeInTheDocument();
    lib.load.mockResolvedValue(ready());
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Try again" })); });
    expect(lib.load).toHaveBeenLastCalledWith({ refresh: true });
    expect(field()).toBeInTheDocument();
  });

  it("an error retries by itself when the connection comes back", async () => {
    await mount({ state: "error", message: "You're offline. Try again when you're back online." });
    lib.load.mockResolvedValue(ready());
    await act(async () => { window.dispatchEvent(new Event("online")); });
    expect(lib.load).toHaveBeenLastCalledWith({ refresh: true });
    expect(field()).toBeInTheDocument();
  });
});

describe("maskFeedUrl", () => {
  it("hides all but the last four characters of the token", () => {
    expect(maskFeedUrl(`${BASE}/functions/v1/ics-feed?t=${TOKEN}`)).toBe("…/ics-feed?t=••••••••cdef");
    expect(maskFeedUrl(`webcal://x.co/f?a=1&t=${TOKEN}`)).toBe("…/f?t=••••••••cdef");
    expect(maskFeedUrl("https://x.co/no-token")).toBe("https://x.co/no-token");
    expect(maskFeedUrl(`https://x.co/f?t=${TOKEN}`)).not.toContain(TOKEN.slice(0, 8));
  });
});
