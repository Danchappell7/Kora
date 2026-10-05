/* Demo mode's connected calendars: two accounts, several calendars, distinct colours,
   a believable month, and the store's demo stand-ins for choosing and disconnecting. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEMO_CAL, DEMO_CAL_ACCOUNT_IDS, demoCalendarAccounts, demoCalendarEvents, demoDayCalendar } from "./demoCalendars";
import { EVENTS, KANBO_TODAY } from "./data";

const monthOf = (today: Date) => {
  const start = new Date(today); start.setDate(1); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setMonth(end.getMonth() + 2);
  return [start.toISOString(), end.toISOString()] as const;
};

describe("demo calendar data", () => {
  it("two accounts (Google and Outlook), several calendars each, every calendar its own colour", () => {
    const accounts = demoCalendarAccounts();
    expect(accounts.map((a) => [a.provider, a.calendars.length])).toEqual([["google", 4], ["microsoft", 3]]);
    const colours = accounts.flatMap((a) => a.calendars.map((c) => c.color));
    expect(new Set(colours).size).toBe(colours.length);
    expect(colours.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(accounts.every((a) => a.calendars.filter((c) => c.primary).length === 1)).toBe(true);
    // some calendars are left un-ticked, so choosing has something to do
    expect(accounts.every((a) => a.selected && a.selected.length < a.calendars.length)).toBe(true);
  });

  it("the demo day on Today is coloured by the calendars its meetings sit in", () => {
    const standup = EVENTS.find((e) => e.id === "e1")!;
    expect(standup).toMatchObject({ color: DEMO_CAL.work.color, calendarName: "Work" });
    expect(EVENTS.find((e) => e.id === "e5")).toMatchObject({ color: DEMO_CAL.launch.color, calendarName: "Launch team" });
    expect(EVENTS.find((e) => e.kind === "break")!.color).toBeUndefined();
    expect(demoDayCalendar("nope")).toBeUndefined();
  });

  it("a month of events from the shown calendars; today's timed meetings are exactly the demo day's", () => {
    const [start, end] = monthOf(KANBO_TODAY);
    const events = demoCalendarEvents(start, end, demoCalendarAccounts(), KANBO_TODAY, EVENTS);
    expect(events.length).toBeGreaterThan(40);
    const shownIds = new Set(demoCalendarAccounts().flatMap((a) => a.selected ?? []));
    expect(events.every((e) => shownIds.has(e.calendarId!))).toBe(true);
    expect(new Set(events.map((e) => e.calendarName)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(events.map((e) => e.connectionId))).toEqual(new Set([DEMO_CAL_ACCOUNT_IDS.work, DEMO_CAL_ACCOUNT_IDS.home]));
    expect(new Set(events.map((e) => e.id)).size).toBe(events.length);
    const sameDay = (iso: string) => { const d = new Date(iso); return d.toDateString() === KANBO_TODAY.toDateString(); };
    const today = events.filter((e) => !e.allDay && sameDay(e.start)).map((e) => e.title);
    expect(today).toEqual(EVENTS.filter((e) => e.kind === "meeting").sort((a, b) => a.start - b.start).map((e) => e.title));
    for (const e of events) expect(Date.parse(e.end) > Date.parse(e.start) || e.allDay).toBe(true);
  });

  it("follows the choice: an unticked calendar's events go, a newly ticked one's appear", () => {
    const [start, end] = monthOf(KANBO_TODAY);
    const accounts = demoCalendarAccounts();
    accounts[0].selected = [DEMO_CAL.work.id];
    accounts[1].selected = null;  // primary only
    const events = demoCalendarEvents(start, end, accounts, KANBO_TODAY, EVENTS);
    expect(new Set(events.map((e) => e.calendarName))).toEqual(new Set(["Work", "Calendar"]));
    accounts[1].selected = [DEMO_CAL.birthdays.id];
    expect(demoCalendarEvents(start, end, accounts, KANBO_TODAY, EVENTS).some((e) => e.calendarName === "Birthdays" && e.allDay)).toBe(true);
  });

  it("an empty or backwards window has nothing", () => {
    expect(demoCalendarEvents("2026-10-10T00:00:00Z", "2026-10-01T00:00:00Z", demoCalendarAccounts(), KANBO_TODAY, EVENTS)).toEqual([]);
    expect(demoCalendarEvents("garbage", "2026-10-01T00:00:00Z", demoCalendarAccounts(), KANBO_TODAY, EVENTS)).toEqual([]);
  });
});

describe("store in demo mode: connected calendars", () => {
  beforeEach(() => { vi.resetModules(); });
  const fresh = async () => (await import("./store")).store;

  it("lists the two example accounts, never a token", async () => {
    const store = await fresh();
    const conns = await store.listCalendarConnections();
    expect(conns.map((c) => [c.provider, c.accountEmail, c.selectedCalendars?.length, c.canChoose])).toEqual([
      ["google", "daniel@foundrise.co", 3, true], ["microsoft", "daniel.okai@outlook.com", 2, true],
    ]);
    expect(JSON.stringify(conns)).not.toMatch(/token/i);
  });

  it("choosing calendars sticks for the session, and Month's events follow", async () => {
    const store = await fresh();
    const [start, end] = monthOf(KANBO_TODAY);
    const list = await store.listAccountCalendars(DEMO_CAL_ACCOUNT_IDS.home);
    expect(list.map((c) => [c.name, c.selected])).toEqual([["Calendar", true], ["Birthdays", false], ["Family", true]]);
    await store.selectCalendars(DEMO_CAL_ACCOUNT_IDS.home, [DEMO_CAL.birthdays.id, "not-a-calendar"]);
    expect((await store.listCalendarConnections())[1].selectedCalendars!.map((c) => c.name)).toEqual(["Birthdays"]);
    const { events, warnings } = await store.loadExternalEvents(start, end);
    expect(warnings).toEqual([]);
    expect(events.some((e) => e.calendarName === "Family")).toBe(false);
    expect(events.some((e) => e.calendarName === "Birthdays")).toBe(true);
  });

  it("disconnecting one account leaves the other; connecting a real one needs an account", async () => {
    const store = await fresh();
    await store.disconnectCalendar(DEMO_CAL_ACCOUNT_IDS.work);
    expect((await store.listCalendarConnections()).map((c) => c.provider)).toEqual(["microsoft"]);
    await expect(store.listAccountCalendars(DEMO_CAL_ACCOUNT_IDS.work)).rejects.toThrow(/isn't connected/);
    await expect(store.getCalendarAuthUrl("google")).rejects.toThrow(/Sign in to Kanbo to connect your own/);
  });
});
