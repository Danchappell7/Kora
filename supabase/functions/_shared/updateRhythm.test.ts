import { describe, expect, it } from "vitest";
import {
  addWorkingDays, anchorFrom, DEFAULT_RHYTHM, dueBefore, dueDayWords, dueOnOrAfter, dueOnOrBefore, effectiveRhythm, isReminderDay, isoWeekday,
  parseRhythm, readsMissing, rhythmLabel, rhythmRow, rhythmState, workingDaysAfter, type UpdateRhythm,
} from "./updateRhythm.ts";

const weekly: UpdateRhythm = { cadence: "weekly", weekday: 5 };

describe("parseRhythm / effectiveRhythm", () => {
  it("reads what the database stores, and nothing else", () => {
    expect(parseRhythm({ cadence: "monthly", weekday: 2 })).toEqual({ cadence: "monthly", weekday: 2 });
    expect(parseRhythm({ cadence: "fortnightly", weekday: 5, anchor: "2026-11-13" })).toEqual({ cadence: "fortnightly", weekday: 5, anchor: "2026-11-13" });
    // an anchor only means something fortnightly; a bad one is dropped
    expect(parseRhythm({ cadence: "weekly", weekday: 5, anchor: "2026-11-13" })).toEqual(weekly);
    expect(parseRhythm({ cadence: "fortnightly", weekday: 5, anchor: "2026-02-30" })).toEqual({ cadence: "fortnightly", weekday: 5 });
    // an unreadable day falls back to Friday; an unknown cadence or shape is "unset"
    expect(parseRhythm({ cadence: "weekly", weekday: 9 })).toEqual(weekly);
    for (const bad of [null, undefined, "weekly", [], { cadence: "daily", weekday: 1 }, { weekday: 3 }]) expect(parseRhythm(bad)).toBeNull();
  });
  it("a project's own choice wins, then its workspace's, then weekly on Friday", () => {
    expect(effectiveRhythm({ cadence: "never", weekday: 5 }, { cadence: "monthly", weekday: 1 }).cadence).toBe("never");
    expect(effectiveRhythm(null, { cadence: "monthly", weekday: 1 })).toEqual({ cadence: "monthly", weekday: 1 });
    expect(effectiveRhythm(null, null)).toEqual(DEFAULT_RHYTHM);
  });
  it("stores an anchor only for fortnightly", () => {
    expect(rhythmRow({ cadence: "weekly", weekday: 4, anchor: "2026-11-12" })).toEqual({ cadence: "weekly", weekday: 4 });
    expect(rhythmRow({ cadence: "fortnightly", weekday: 4, anchor: "2026-11-12" })).toEqual({ cadence: "fortnightly", weekday: 4, anchor: "2026-11-12" });
  });
});

describe("due days", () => {
  it("weekly: the latest Friday, today included", () => {
    expect(isoWeekday("2026-11-10")).toBe(2); // a Tuesday
    expect(dueOnOrBefore(weekly, "2026-11-10")).toBe("2026-11-06");
    expect(dueOnOrBefore(weekly, "2026-11-13")).toBe("2026-11-13");
    expect(dueBefore(weekly, "2026-11-13")).toBe("2026-11-06");
    expect(dueOnOrAfter(weekly, "2026-11-10")).toBe("2026-11-13");
    expect(dueOnOrAfter(weekly, "2026-11-13")).toBe("2026-11-13");
  });
  it("fortnightly: every other week from its anchor, either way", () => {
    const r: UpdateRhythm = { cadence: "fortnightly", weekday: 5, anchor: "2026-11-13" };
    expect(dueOnOrBefore(r, "2026-11-13")).toBe("2026-11-13");
    expect(dueOnOrBefore(r, "2026-11-20")).toBe("2026-11-13");
    expect(dueOnOrBefore(r, "2026-11-27")).toBe("2026-11-27");
    expect(dueOnOrBefore(r, "2026-11-12")).toBe("2026-10-30");
    expect(dueOnOrAfter(r, "2026-11-14")).toBe("2026-11-27");
    expect(anchorFrom("2026-11-10", 5)).toBe("2026-11-13");
    expect(anchorFrom("2026-11-13", 5)).toBe("2026-11-13");
  });
  it("monthly: the last Friday of the month (into the month before when it's still ahead)", () => {
    const r: UpdateRhythm = { cadence: "monthly", weekday: 5 };
    expect(dueOnOrBefore(r, "2026-11-30")).toBe("2026-11-27");
    expect(dueOnOrBefore(r, "2026-11-10")).toBe("2026-10-30");
    expect(dueOnOrBefore(r, "2026-01-05")).toBe("2025-12-26");
    expect(dueOnOrAfter(r, "2026-11-28")).toBe("2026-12-25");
    expect(dueBefore(r, "2026-11-27")).toBe("2026-10-30");
  });
  it("never: no due days", () => {
    const r: UpdateRhythm = { cadence: "never", weekday: 5 };
    expect(dueOnOrBefore(r, "2026-11-10")).toBeNull();
    expect(dueOnOrAfter(r, "2026-11-10")).toBeNull();
  });
  it("working days skip the weekend", () => {
    expect(addWorkingDays("2026-11-13", 2)).toBe("2026-11-17"); // Fri → Tue
    expect(addWorkingDays("2026-11-14", 1)).toBe("2026-11-16"); // Sat → Mon
    expect(workingDaysAfter("2026-11-13", "2026-11-15")).toBe(0);
    expect(workingDaysAfter("2026-11-13", "2026-11-16")).toBe(1);
    expect(workingDaysAfter("2026-11-13", "2026-11-18")).toBe(3);
  });
});

describe("rhythmState", () => {
  const base = { rhythm: weekly, startedOn: "2026-09-01" };
  it("due on the day, then two working-day follow-ups, then missing", () => {
    const at = (today: string, lastUpdate: string | null = "2026-11-06") => rhythmState({ ...base, today, lastUpdate });
    expect(at("2026-11-12")).toMatchObject({ kind: "ok", next: "2026-11-13" });
    expect(at("2026-11-13")).toEqual({ kind: "due", due: "2026-11-13", followUp: 0, lapsed: false });
    expect(at("2026-11-14")).toEqual({ kind: "due", due: "2026-11-13", followUp: 0, lapsed: false }); // Saturday: no new follow-up
    expect(at("2026-11-16")).toMatchObject({ kind: "due", followUp: 1 });
    expect(at("2026-11-17")).toMatchObject({ kind: "due", followUp: 2 });
    expect(at("2026-11-18")).toEqual({ kind: "missing", due: "2026-11-13" });
  });
  it("an update posted after the previous due day covers this one; one on it doesn't", () => {
    expect(rhythmState({ ...base, today: "2026-11-13", lastUpdate: "2026-11-07" }).kind).toBe("ok");
    expect(rhythmState({ ...base, today: "2026-11-13", lastUpdate: "2026-11-13" }).kind).toBe("ok");
    expect(rhythmState({ ...base, today: "2026-11-13", lastUpdate: "2026-11-06" }).kind).toBe("due");
    // posted late, after the follow-ups: it's in
    expect(rhythmState({ ...base, today: "2026-11-19", lastUpdate: "2026-11-19" }).kind).toBe("ok");
  });
  it("a round that went without one before reads as lapsed (a leader sees it missing)", () => {
    const s = rhythmState({ ...base, today: "2026-11-13", lastUpdate: null });
    expect(s).toMatchObject({ kind: "due", lapsed: true });
    expect(readsMissing(s)).toBe(true);
    expect(readsMissing(rhythmState({ ...base, today: "2026-11-13", lastUpdate: "2026-10-31" }))).toBe(false);
  });
  it("skips Never, paused projects and projects with no tasks; a brand-new project isn't expected yet", () => {
    expect(rhythmState({ ...base, rhythm: { cadence: "never", weekday: 5 }, today: "2026-11-13", lastUpdate: null })).toEqual({ kind: "off", why: "never" });
    expect(rhythmState({ ...base, today: "2026-11-13", lastUpdate: null, paused: true })).toEqual({ kind: "off", why: "paused" });
    expect(rhythmState({ ...base, startedOn: null, today: "2026-11-13", lastUpdate: null })).toEqual({ kind: "off", why: "empty" });
    expect(rhythmState({ ...base, startedOn: "2026-11-11", today: "2026-11-13", lastUpdate: null }).kind).toBe("ok");
    expect(rhythmState({ ...base, startedOn: "2026-11-09", today: "2026-11-13", lastUpdate: null })).toMatchObject({ kind: "due", lapsed: false });
  });
  it("reminds on the due day and on working follow-up days only", () => {
    const s = (today: string) => rhythmState({ ...base, today, lastUpdate: "2026-11-01" });
    expect(isReminderDay(s("2026-11-13"), "2026-11-13")).toBe(true);
    expect(isReminderDay(s("2026-11-14"), "2026-11-14")).toBe(false);
    expect(isReminderDay(s("2026-11-16"), "2026-11-16")).toBe(true);
    expect(isReminderDay(s("2026-11-17"), "2026-11-17")).toBe(true);
    expect(isReminderDay(s("2026-11-18"), "2026-11-18")).toBe(false);
  });
});

describe("words", () => {
  it("says the rhythm and the day plainly", () => {
    expect(rhythmLabel(weekly)).toBe("Every Friday");
    expect(rhythmLabel({ cadence: "fortnightly", weekday: 1 })).toBe("Every other Monday");
    expect(rhythmLabel({ cadence: "monthly", weekday: 4 })).toBe("The last Thursday of the month");
    expect(rhythmLabel({ cadence: "never", weekday: 5 })).toBe("Never");
    expect(dueDayWords("2026-11-13", "2026-11-13")).toBe("today");
    expect(dueDayWords("2026-11-12", "2026-11-13")).toBe("yesterday");
    expect(dueDayWords("2026-11-06", "2026-11-13")).toBe("Fri 6 Nov");
  });
});
