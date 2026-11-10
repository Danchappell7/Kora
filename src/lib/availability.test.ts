import { afterEach, describe, expect, it } from "vitest";
import {
  availabilityOn, awayNote, backOn, canEditTimeOff, canEditWeek, canSeeRates, capacityInWeek, capacityUploads, daysOffInWeek, EMPTY_AVAILABILITY,
  getAvailability, hoursWords, myWorkingDay, offOnDayNote, offShare, rateFor, resetAvailability, seesTimeOff, spanWords, updateAvailability,
  weekCapacities, workDaysWords, type AvailabilityState, type TimeOff,
} from "./availability";

// Tuesday 10 November 2026; its week starts Monday 9 November
const MON = new Date(2026, 10, 9);
const off = (userId: string, startsOn: string, endsOn: string, halfDay: "am" | "pm" | null = null, reason?: string): TimeOff =>
  ({ id: `off-${userId}-${startsOn}`, userId, startsOn, endsOn, halfDay, ...(reason ? { reason } : {}) });
const state = (o: Partial<AvailabilityState> = {}): AvailabilityState => ({
  ...EMPTY_AVAILABILITY, status: "on", me: "me", activeWs: "ws",
  roles: { ws: { me: "owner", maya: "member", sana: "member", gus: "guest" }, other: { me: "member", maya: "admin", tom: "member" } },
  ...o,
});

afterEach(() => resetAvailability());

describe("capacity", () => {
  it("is the person's weekly hours less the share of their working days they're off", () => {
    const s = state({
      weeks: [{ workspaceId: "ws", userId: "maya", weeklyHours: 32, workDays: [1, 2, 3, 4], dayStart: 540, dayEnd: 1050 }],
      timeOff: [off("maya", "2026-11-12", "2026-11-13"), off("sana", "2026-11-10", "2026-11-10", "pm")],
    });
    // Maya works Mon–Thu: Thursday off (Friday isn't hers) is a quarter of her 32h
    expect(capacityInWeek("ws", "maya", MON, s)).toBe(24);
    expect(daysOffInWeek("ws", "maya", MON, s)).toEqual({ off: 1, working: 4 });
    // Sana keeps the 40h default, less half a day
    expect(capacityInWeek("ws", "sana", MON, s)).toBe(36);
    expect(capacityInWeek("ws", "me", MON, s)).toBe(40);
  });
  it("is 0 for a week someone's off every working day of", () => {
    const s = state({ timeOff: [off("sana", "2026-11-07", "2026-11-16")] });
    expect(capacityInWeek("ws", "sana", MON, s)).toBe(0);
    expect(offShare("sana", "2026-11-16", s)).toBe(1);
  });
  it("covers a business's owners, admins and members (never its guests) and anyone with a week there", () => {
    const s = state({ weeks: [{ workspaceId: "ws", userId: "left", weeklyHours: 10, workDays: [1], dayStart: 480, dayEnd: 1080 }] });
    expect(weekCapacities("ws", MON, s)).toEqual({ me: 40, maya: 40, sana: 40, left: 10 });
    expect(weekCapacities(null, MON, s)).toEqual({});
  });
});

describe("time off in words", () => {
  const today = "2026-11-10";
  it("says Off today for one day, and names the day they're back for longer", () => {
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", today, today, null, "Dentist")] }))).toMatchObject({ label: "Off today", now: true, reason: "Dentist" });
    // Tue–Fri: back on Monday
    const long = awayNote("sana", today, {}, state({ timeOff: [off("sana", "2026-11-09", "2026-11-13")] }))!;
    expect(long.label).toBe("Off until Mon");
    expect(long.title).toBe("Off 9–13 Nov · back Monday 16 Nov");
    // back-to-back entries read as one stretch
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", today, "2026-11-11"), off("sana", "2026-11-12", "2026-11-20")] }))!.label).toBe("Off until 23 Nov");
  });
  it("names the morning or the afternoon of a half day", () => {
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", today, today, "pm")] }))!.label).toBe("Off this afternoon");
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", today, today, "am")] }))!.label).toBe("Off this morning");
  });
  it("says when time off starts within the week, and nothing further out", () => {
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", "2026-11-11", "2026-11-15")] }))).toMatchObject({ label: "Off from tomorrow", now: false });
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", "2026-11-12", "2026-11-12", "pm")] }))!.label).toBe("Off Thu afternoon");
    expect(awayNote("sana", today, {}, state({ timeOff: [off("sana", "2026-11-30", "2026-12-02")] }))).toBeNull();
  });
  it("comes back on the person's next working day at that business", () => {
    const s = state({ weeks: [{ workspaceId: "ws", userId: "maya", weeklyHours: 32, workDays: [2, 3, 4, 5], dayStart: 480, dayEnd: 1080 }] });
    expect(backOn("maya", "2026-11-13", "ws", s)).toBe("2026-11-17");   // Tue (she doesn't work Mondays)
    expect(backOn("maya", "2026-11-13", null, s)).toBe("2026-11-16");
  });
  it("warns the assignee picker when someone's off the day the work's due", () => {
    const s = state({ timeOff: [off("sana", "2026-11-12", "2026-11-13"), off("maya", "2026-11-11", "2026-11-11", "am")] });
    expect(offOnDayNote("sana", "2026-11-12", today, s)).toBe("Off Thu");
    expect(offOnDayNote("maya", "2026-11-11", today, s)).toBe("Off tomorrow morning");
    expect(offOnDayNote("sana", "2026-11-14", today, s)).toBeNull();
    expect(offOnDayNote("sana", null, today, s)).toBeNull();
    expect(offOnDayNote("sana", "2026-11-01", today, s)).toBeNull();   // already past
  });
  it("reads dates and weeks the way the app does", () => {
    expect(spanWords(off("x", "2026-11-30", "2026-12-02"))).toBe("30 Nov – 2 Dec");
    expect(spanWords(off("x", "2026-11-12", "2026-11-12", "am"))).toBe("Thu 12 Nov (morning)");
    expect(workDaysWords([5, 1, 2, 3, 4])).toBe("Mon–Fri");
    expect(workDaysWords([1, 3, 5])).toBe("Mon, Wed, Fri");
    expect(workDaysWords([1, 2, 3, 4, 5, 6, 7])).toBe("Every day");
    expect(hoursWords({ dayStart: 570, dayEnd: 1440 })).toBe("09:30–24:00");
  });
});

describe("who may see and change what", () => {
  it("you set your own week; owners and admins set anyone's but a guest's", () => {
    const s = state();
    expect(canEditWeek("ws", "me", s)).toBe(true);
    expect(canEditWeek("ws", "maya", s)).toBe(true);
    expect(canEditWeek("ws", "gus", s)).toBe(false);
    expect(canEditWeek("other", "tom", s)).toBe(false);   // a member there
    expect(canEditWeek("other", "me", s)).toBe(true);
    expect(canEditWeek("ws", "maya", state({ status: "off" }))).toBe(false);
  });
  it("you record your own time off, and that of anyone in a business you own or run", () => {
    const s = state();
    expect(canEditTimeOff("me", s)).toBe(true);
    expect(canEditTimeOff("sana", s)).toBe(true);
    expect(canEditTimeOff("tom", s)).toBe(false);   // only a fellow member at "other"
  });
  it("time off shows to the team, never to a guest; rates only to owners and admins", () => {
    const s = state({ roles: { ws: { me: "member" }, g: { me: "guest" }, lead: { me: "admin" } }, rates: [{ workspaceId: "lead", projectId: null, rate: 80 }, { workspaceId: "lead", projectId: "p1", rate: 95 }] });
    expect(seesTimeOff("ws", s)).toBe(true);
    expect(seesTimeOff("g", s)).toBe(false);
    expect(canSeeRates("ws", s)).toBe(false);
    expect(canSeeRates("lead", s)).toBe(true);
    expect(rateFor("lead", "p1", s)).toBe(95);
    expect(rateFor("lead", "p2", s)).toBe(80);
    expect(rateFor("ws", "p2", s)).toBe(0);
  });
});

describe("Today's working day", () => {
  it("is your week at the business on screen, the span of your weeks in Personal, and 08:00–18:00 before 0055", () => {
    const weeks = [
      { workspaceId: "ws", userId: "me", weeklyHours: null, workDays: [1, 2, 3, 4, 5], dayStart: 450, dayEnd: 990 },
      { workspaceId: "other", userId: "me", weeklyHours: 8, workDays: [5], dayStart: 600, dayEnd: 1200 },
    ];
    expect(myWorkingDay(state({ weeks }))).toEqual({ start: 450, end: 990 });
    expect(myWorkingDay(state({ weeks, activeWs: null }))).toEqual({ start: 450, end: 1200 });
    expect(myWorkingDay(state({ weeks, activeWs: null, roles: {} }))).toEqual({ start: 480, end: 1080 });
    expect(myWorkingDay(state({ weeks, status: "off" }))).toEqual({ start: 480, end: 1080 });
  });
});

describe("capacities saved on this device", () => {
  it("go up once, only where nobody has set one and only what you may set", () => {
    const s = state({
      roles: { ws: { me: "owner", maya: "member", gus: "guest" }, other: { me: "member", maya: "admin" } },
      weeks: [{ workspaceId: "ws", userId: "me", weeklyHours: 30, workDays: [1, 2, 3, 4, 5], dayStart: 480, dayEnd: 1080 }],
    });
    expect(capacityUploads({ me: 24, maya: 32, gus: 10, stranger: 20, bad: 900 }, s)).toEqual([
      { workspaceId: "ws", userId: "maya", hours: 32 },          // you own ws: Maya's goes up; yours is set already
      { workspaceId: "other", userId: "me", hours: 24 },         // a member at "other": only your own
    ]);
  });
});

describe("the store", () => {
  it("starts unknown, and says when it's on", () => {
    expect(availabilityOn()).toBe(false);
    updateAvailability({ status: "on" });
    expect(getAvailability().status).toBe("on");
    expect(availabilityOn()).toBe(true);
  });
});
