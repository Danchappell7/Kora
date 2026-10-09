/* lib/notifyPrefs in demo mode: snooze choices (pinned clock, BST and GMT),
   custom snoozes, the in-memory thread snoozes, moving the old per-device
   snoozes across, and Settings' words. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  customSnoozeUntil, describeNotifyPrefs, isSnoozed, listSnoozes, mergeNotifyPrefs, planLegacySnoozeMigration, quietDaysLabel, quietNow,
  readNotifyPrefs, resetDemoSnoozes, snoozeChoices, snoozeFailure, snoozeFailureMessage, snoozeThread, subscribeSnoozes, timeZoneChoices,
  unsnoozeThread, zoneLabel, zoneOption,
} from "./notifyPrefs";

const LDN = "Europe/London";
const at = (iso: string) => new Date(iso);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  resetDemoSnoozes();
});
afterEach(() => { vi.useRealTimers(); });

describe("snooze choices", () => {
  it("1 hour, tomorrow at nine, next Monday at nine — London time", () => {
    const c = snoozeChoices(at("2026-10-09T09:00:00Z"), LDN);   // Fri 10:00 BST
    expect(c.map((x) => [x.id, x.label, x.hint])).toEqual([
      ["hour", "1 hour", "11:00"],
      ["tomorrow", "Tomorrow 09:00", "Sat"],
      ["next_week", "Next week", "Mon 12 Oct, 09:00"],
    ]);
    expect(c.map((x) => x.until.toISOString())).toEqual(["2026-10-09T10:00:00.000Z", "2026-10-10T08:00:00.000Z", "2026-10-12T08:00:00.000Z"]);
  });

  it("on a Sunday, next week is the Monday after tomorrow", () => {
    const c = snoozeChoices(at("2026-10-11T12:00:00Z"), LDN);
    expect(c[1].until.toISOString()).toBe("2026-10-12T08:00:00.000Z");
    expect(c[2].until.toISOString()).toBe("2026-10-19T08:00:00.000Z");
  });

  it("tomorrow at nine is nine on the wall clock across the change (Sat 24 → Sun 25 Oct)", () => {
    const c = snoozeChoices(at("2026-10-24T20:00:00Z"), LDN);   // Sat 21:00 BST
    expect(c[1].until.toISOString()).toBe("2026-10-25T09:00:00.000Z");   // Sun 09:00 GMT
    expect(c[2].hint).toBe("Mon 26 Oct, 09:00");
  });

  it("in another timezone", () => {
    const c = snoozeChoices(at("2026-10-09T09:00:00Z"), "America/New_York");   // Fri 05:00 EDT
    expect(c[0].hint).toBe("06:00");
    expect(c[1].until.toISOString()).toBe("2026-10-10T13:00:00.000Z");
  });

  it("a custom date and time: later than now, within a year", () => {
    const now = at("2026-10-09T09:00:00Z");
    const ok = customSnoozeUntil("2026-10-12", "14:30", LDN, now);
    expect(ok).toEqual({ ok: true, until: at("2026-10-12T13:30:00Z") });
    expect(customSnoozeUntil("2026-10-09", "09:00", LDN, now)).toEqual({ ok: false, error: "Pick a time later than now." });
    expect(customSnoozeUntil("2027-12-01", "09:00", LDN, now)).toEqual({ ok: false, error: "Snoozes can last up to a year." });
    expect(customSnoozeUntil("", "09:00", LDN, now)).toEqual({ ok: false, error: "Pick a date and a time." });
    expect(customSnoozeUntil("2026-10-12", "9am", LDN, now)).toEqual({ ok: false, error: "Pick a date and a time." });
  });
});

describe("thread snoozes (demo: in memory)", () => {
  it("snooze, list, end — and tell subscribers", async () => {
    const seen = vi.fn();
    const off = subscribeSnoozes("m-self", seen);
    await snoozeThread("t-1", at("2026-10-09T12:00:00Z"));
    expect(seen).toHaveBeenCalledTimes(1);
    expect((await listSnoozes()).map((s) => [s.taskId, s.until])).toEqual([["t-1", "2026-10-09T12:00:00.000Z"]]);
    // a second snooze of the same thread moves it (upsert)
    await snoozeThread("t-1", "2026-10-10T08:00:00Z");
    expect((await listSnoozes()).map((s) => s.until)).toEqual(["2026-10-10T08:00:00.000Z"]);
    await unsnoozeThread("t-1");
    expect(await listSnoozes()).toEqual([]);
    off();
    await snoozeThread("t-2", at("2026-10-09T12:00:00Z"));
    expect(seen).toHaveBeenCalledTimes(3);
  });

  it("an ended snooze stays listed with all (the Inbox brings its thread back) until settled", async () => {
    await snoozeThread("t-1", at("2026-10-09T09:30:00Z"));
    vi.setSystemTime(at("2026-10-09T09:31:00Z"));
    expect(await listSnoozes()).toEqual([]);
    expect((await listSnoozes({ all: true })).map((s) => s.taskId)).toEqual(["t-1"]);
    expect(isSnoozed("t-1", await listSnoozes({ all: true }))).toBe(false);
  });

  it("isSnoozed reads the thread's wake time", () => {
    const s = [{ taskId: "t-1", until: "2026-10-09T12:00:00.000Z", createdAt: "" }];
    expect(isSnoozed("t-1", s, Date.parse("2026-10-09T11:00:00Z"))).toBe(true);
    expect(isSnoozed("t-1", s, Date.parse("2026-10-09T12:00:00Z"))).toBe(false);
    expect([isSnoozed("t-2", s), isSnoozed(null, s)]).toEqual([false, false]);
  });

  it("the demo starts with one realistic snoozed thread", async () => {
    vi.resetModules();
    const fresh = await import("./notifyPrefs");
    const rows = await fresh.listSnoozes();
    expect(rows.map((r) => r.taskId)).toEqual(["t-2"]);
    expect(Date.parse(rows[0].until)).toBeGreaterThan(Date.now());
  });

  it("refuses nonsense", async () => {
    await expect(snoozeThread("", new Date())).rejects.toThrow("invalid snooze");
    await expect(snoozeThread("t-1", "not a date")).rejects.toThrow("invalid snooze");
  });

  it("keeps the database's rule: no further back than a day, no more than a year ahead", async () => {
    await expect(snoozeThread("t-1", at("2026-10-08T08:59:00Z"))).rejects.toThrow("invalid snooze");   // a day and a minute ago
    await expect(snoozeThread("t-1", at("2027-10-11T09:00:00Z"))).rejects.toThrow("invalid snooze");
    expect((await snoozeThread("t-1", at("2026-10-08T10:00:00Z"))).until).toBe("2026-10-08T10:00:00.000Z");   // 23 hours ago: ended
    expect((await snoozeThread("t-1", at("2027-10-09T09:00:00Z"))).until).toBe("2027-10-09T09:00:00.000Z");
  });

  it("names failures", () => {
    expect(snoozeFailure({ code: "42P01", message: 'relation "public.notification_snoozes" does not exist' })).toBe("unavailable");
    expect(snoozeFailure(new Error("too many snoozes"))).toBe("too_many");
    expect(snoozeFailure(new Error("invalid snooze"))).toBe("invalid");
    expect(snoozeFailure({ code: "42501", message: "new row violates row-level security policy" })).toBe("not_allowed");
    expect(snoozeFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(snoozeFailure("boom")).toBe("error");
    expect(snoozeFailureMessage("too_many")).toMatch(/too many snoozes/i);
  });
});

describe("the old per-device snoozes", () => {
  it("running snoozes of items with a task become thread snoozes (latest wins); the rest stay on the device", () => {
    const now = Date.parse("2026-10-09T09:00:00Z");
    const activity = [
      { id: "a1", taskId: "t-1" }, { id: "a2", taskId: "t-1" }, { id: "a3", taskId: "t-2" },
      { id: "d1", taskId: null }, { id: "a4", taskId: "t-4" },
    ];
    const plan = planLegacySnoozeMigration({
      a1: now + 3_600_000, a2: now + 7_200_000,   // the same thread: the later one
      a3: now - 60_000,                            // already ended: stays (flagged back once)
      d1: now + 3_600_000,                         // a doc mention: no thread
      other: now + 3_600_000,                      // another workspace's item
      a4: now + 900 * 86_400_000,                  // beyond a year: capped
      junk: Number.NaN,
    }, activity, now);
    expect(plan.threads).toEqual([
      { taskId: "t-1", until: now + 7_200_000 },
      { taskId: "t-4", until: now + 366 * 86_400_000 - 3_600_000 },
    ]);
    expect(plan.keep).toEqual({ a3: now - 60_000, d1: now + 3_600_000, other: now + 3_600_000 });
  });
});

describe("prefs: saving and words", () => {
  it("merges a patch (null removes) in the demo", async () => {
    expect(await mergeNotifyPrefs({ delivery: "digest", digest_time: "07:30" })).toEqual({ delivery: "digest", digest_time: "07:30" });
    expect(await mergeNotifyPrefs({ digest_time: null, quiet_hours: { start: "22:00", end: "07:00" } }))
      .toEqual({ delivery: "digest", quiet_hours: { start: "22:00", end: "07:00" } });
  });

  it("a plain-English summary", () => {
    expect(describeNotifyPrefs(readNotifyPrefs({}))).toBe("Real time, bundled, London time");
    expect(describeNotifyPrefs(readNotifyPrefs({ bundle: false, quiet_hours: { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5] } })))
      .toBe("Real time, quiet 22:00–07:00 on weekdays, London time");
    expect(describeNotifyPrefs(readNotifyPrefs({ delivery: "digest", digest_time: "17:30", timezone: "America/New_York", quiet_hours: { start: "20:00", end: "08:00", days: [6, 7] } })))
      .toBe("Daily digest at 17:30, quiet 20:00–08:00 at weekends, New York time");
  });

  it("days, zones and the quiet-hours status", () => {
    expect([quietDaysLabel([1, 2, 3, 4, 5, 6, 7]), quietDaysLabel(undefined), quietDaysLabel([5, 1, 3]), quietDaysLabel([2])])
      .toEqual(["every day", "every day", "on Mon, Wed and Fri", "on Tue"]);
    expect([zoneLabel("Europe/London"), zoneLabel("America/Argentina/Buenos_Aires"), zoneLabel("UTC")]).toEqual(["London time", "Buenos Aires time", "UTC"]);
    expect(zoneOption("Europe/London", at("2026-10-09T09:00:00Z"))).toBe("London (GMT+1)");
    expect(zoneOption("Europe/London", at("2026-12-09T09:00:00Z"))).toBe("London (GMT)");
    const zones = timeZoneChoices("Europe/London", "Mars/Olympus");
    expect(zones).toContain("Europe/London");
    expect(zones).not.toContain("Mars/Olympus");
    const p = readNotifyPrefs({ quiet_hours: { start: "22:00", end: "07:00" } });
    expect(quietNow(p, at("2026-10-09T09:00:00Z"))).toBeNull();
    expect(quietNow(p, at("2026-10-09T22:00:00Z"))).toEqual({ until: at("2026-10-10T06:00:00Z") });
  });
});
