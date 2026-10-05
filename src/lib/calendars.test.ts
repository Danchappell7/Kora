import { describe, it, expect, beforeEach } from "vitest";
import {
  calendarKey, calendarLegend, eventCalendarKey, eventColour, HIDDEN_CALENDARS_KEY, loadHiddenCalendars,
  saveHiddenCalendars, shownSummary, warningText,
} from "./calendars";
import type { CalendarConnection, ExternalEvent } from "../data/types";

const ev = (over: Partial<ExternalEvent>): ExternalEvent => ({ id: "e", title: "Meeting", start: "2026-10-05T08:00:00Z", end: "2026-10-05T08:30:00Z", allDay: false, provider: "google", ...over });

describe("calendar keys and colours", () => {
  it("an event's calendar: its account and calendar; an older server's event: provider + primary", () => {
    expect(eventCalendarKey(ev({ connectionId: "c1", calendarId: "team@g" }))).toBe("c1|team@g");
    expect(eventCalendarKey(ev({}))).toBe("google|primary");
    expect(calendarKey("c1", "primary")).toBe("c1|primary");
  });
  it("an event's colour is its calendar's (a plain hex), else its provider's", () => {
    expect(eventColour(ev({ color: "#2e9d6a" }))).toBe("#2e9d6a");
    expect(eventColour(ev({ color: "url(x)" }))).toBe("#3f7fe0");
    expect(eventColour(ev({ provider: "microsoft" }))).toBe("#c98a1b");
    expect(eventColour(ev({ provider: "other" }))).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("calendarLegend", () => {
  const conns: CalendarConnection[] = [
    { id: "c1", provider: "google", accountEmail: "ada@work.example", canChoose: true, selectedCalendars: [
      { id: "ada@work.example", name: "Work", color: "#3f7fe0", primary: true }, { id: "team@g", name: "Launch team", color: "#2e9d6a", primary: false }] },
    { id: "c2", provider: "microsoft", accountEmail: "ada@outlook.example", canChoose: true, selectedCalendars: null },
    { id: "c3", provider: "google", accountEmail: "ada@gmail.example", canChoose: true, selectedCalendars: [] },
  ];
  it("one entry per calendar shown, in account order; an account on 'primary only' takes its events' name and colour", () => {
    const legend = calendarLegend(conns, [ev({ provider: "microsoft", connectionId: "c2", calendarId: "primary", calendarName: "ada@outlook.example", color: "#a35bc4" })]);
    expect(legend.map((e) => [e.key, e.name, e.color])).toEqual([
      ["c1|ada@work.example", "Work", "#3f7fe0"],
      ["c1|team@g", "Launch team", "#2e9d6a"],
      ["c2|primary", "ada@outlook.example", "#a35bc4"],
    ]);
    expect(legend[0].accountEmail).toBe("ada@work.example");
  });
  it("calendars only the events mention (an older server) still get an entry", () => {
    const legend = calendarLegend([], [ev({}), ev({ id: "2", provider: "microsoft" })]);
    expect(legend.map((e) => [e.key, e.name])).toEqual([["google|primary", "Google"], ["microsoft|primary", "Outlook"]]);
  });
});

describe("words", () => {
  it("how many calendars an account shows", () => {
    expect(shownSummary({ selectedCalendars: null })).toBe("Main calendar shown");
    expect(shownSummary({ selectedCalendars: [] })).toBe("No calendars shown");
    expect(shownSummary({ selectedCalendars: [{ id: "a", name: "A", color: "", primary: true }] })).toBe("1 calendar shown");
    expect(shownSummary({ selectedCalendars: Array.from({ length: 3 }, (_, i) => ({ id: `${i}`, name: "", color: "", primary: false })) })).toBe("3 calendars shown");
  });
  it("what went wrong, in plain words", () => {
    const base = { connectionId: "c", provider: "google", accountEmail: "a@b" };
    expect(warningText({ ...base, reason: "reconnect" })).toMatch(/Disconnect it and add it again/);
    expect(warningText({ ...base, calendarName: "Family", reason: "unavailable" })).toBe("Couldn't load “Family” just now. Kanbo will try again.");
    expect(warningText({ ...base, reason: "timeout" })).toBe("This account took too long to load. Kanbo will try again.");
    expect(warningText({ ...base, calendarName: "Team", reason: "timeout" })).toBe("“Team” took too long to load. Kanbo will try again.");
  });
});

describe("hidden calendars (per device)", () => {
  beforeEach(() => localStorage.clear());
  it("round-trips, clears itself when empty, and survives junk", () => {
    expect(loadHiddenCalendars().size).toBe(0);
    saveHiddenCalendars(new Set(["c1|team@g"]));
    expect([...loadHiddenCalendars()]).toEqual(["c1|team@g"]);
    saveHiddenCalendars(new Set());
    expect(localStorage.getItem(HIDDEN_CALENDARS_KEY)).toBeNull();
    localStorage.setItem(HIDDEN_CALENDARS_KEY, "{not json");
    expect(loadHiddenCalendars().size).toBe(0);
    localStorage.setItem(HIDDEN_CALENDARS_KEY, JSON.stringify(["ok", 5, null]));
    expect([...loadHiddenCalendars()]).toEqual(["ok"]);
  });
});
