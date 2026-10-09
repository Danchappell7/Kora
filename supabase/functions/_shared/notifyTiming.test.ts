// When a notification may go out: quiet hours, digests and bundling, with the
// clocks changing (London: 29 March / 25 October 2026; New York: 8 March /
// 1 November 2026). Every test names its instants; nothing reads the real date.
import { describe, expect, it } from "vitest";
import {
  addDays, digestDue, digestMoment, hhmmToMinutes, inQuietHours, localParts, minutesToHHMM, nextDigestAt, NOTIFY_BUNDLE_WINDOW_SEC,
  planDelivery, quietHoursEnd, resolveNotifyPrefs, zonedInstants, zonedTime, type DeliveryInput,
} from "./notifyTiming";

const LDN = "Europe/London", NYC = "America/New_York";
const at = (iso: string) => new Date(iso);
const z = (d: Date) => d.toISOString().replace(".000", "");
const NIGHTS = { start: "22:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] };

describe("local time in a timezone", () => {
  it("reads the wall clock, weekday and date", () => {
    expect(localParts(at("2026-10-09T09:00:00Z"), LDN)).toEqual({ date: "2026-10-09", weekday: 5, minutes: 600 });   // Fri 10:00 BST
    expect(localParts(at("2026-12-09T09:00:00Z"), LDN)).toEqual({ date: "2026-12-09", weekday: 3, minutes: 540 });   // Wed 09:00 GMT
    expect(localParts(at("2026-10-09T03:30:00Z"), NYC)).toEqual({ date: "2026-10-08", weekday: 4, minutes: 23 * 60 + 30 });
    expect(localParts(at("2026-10-11T23:00:00Z"), LDN).weekday).toBe(1);   // Monday 00:00 BST
    expect(localParts(at("2026-10-09T09:00:00Z"), "Mars/Olympus").date).toBe("2026-10-09");   // unknown zone → London
  });

  it("finds the instant for a local time — once, twice (clocks back) or past the gap (clocks forward)", () => {
    expect(zonedInstants("2026-10-09", 9 * 60, LDN).map(z)).toEqual(["2026-10-09T08:00:00Z"]);
    expect(zonedInstants("2026-12-01", 9 * 60, LDN).map(z)).toEqual(["2026-12-01T09:00:00Z"]);
    // 25 Oct 2026: 01:30 happens in BST and again in GMT
    expect(zonedInstants("2026-10-25", 90, LDN).map(z)).toEqual(["2026-10-25T00:30:00Z", "2026-10-25T01:30:00Z"]);
    expect(z(zonedTime("2026-10-25", 90, LDN))).toBe("2026-10-25T00:30:00Z");
    // 29 Mar 2026: 01:30 never happens → 02:30 BST
    expect(zonedInstants("2026-03-29", 90, LDN).map(z)).toEqual(["2026-03-29T01:30:00Z"]);
    expect(z(zonedTime("2026-03-29", 3 * 60, LDN))).toBe("2026-03-29T02:00:00Z");
    expect(z(zonedTime("2026-03-08", 2 * 60 + 30, NYC))).toBe("2026-03-08T07:30:00Z");   // NY gap → 03:30 EDT
    expect(zonedInstants("2026-11-01", 90, NYC).map(z)).toEqual(["2026-11-01T05:30:00Z", "2026-11-01T06:30:00Z"]);
  });

  it("small helpers", () => {
    expect([hhmmToMinutes("07:30"), hhmmToMinutes("24:00"), hhmmToMinutes(7)]).toEqual([450, NaN, NaN]);
    expect([minutesToHHMM(450), minutesToHHMM(1440 + 5), minutesToHHMM(-30)]).toEqual(["07:30", "00:05", "23:30"]);
    expect([addDays("2026-10-31", 1), addDays("2026-03-01", -1), addDays("2028-02-28", 1)]).toEqual(["2026-11-01", "2026-02-28", "2028-02-29"]);
  });
});

describe("quiet hours", () => {
  it("an overnight span: evening and early morning, not the day", () => {
    expect(inQuietHours(at("2026-10-09T21:00:00Z"), NIGHTS, LDN)).toBe(true);    // 22:00 BST
    expect(inQuietHours(at("2026-10-09T20:59:00Z"), NIGHTS, LDN)).toBe(false);   // 21:59
    expect(inQuietHours(at("2026-10-10T05:59:00Z"), NIGHTS, LDN)).toBe(true);    // 06:59
    expect(inQuietHours(at("2026-10-10T06:00:00Z"), NIGHTS, LDN)).toBe(false);   // 07:00: over
    expect(inQuietHours(at("2026-10-09T12:00:00Z"), NIGHTS, LDN)).toBe(false);
    expect(inQuietHours(at("2026-10-09T12:00:00Z"), null, LDN)).toBe(false);
  });

  it("days are the days a span starts on (weeknights: Fri night is quiet into Sat, Sun night isn't)", () => {
    const weeknights = { ...NIGHTS, days: [1, 2, 3, 4, 5] };
    expect(inQuietHours(at("2026-10-09T22:00:00Z"), weeknights, LDN)).toBe(true);    // Fri 23:00
    expect(inQuietHours(at("2026-10-10T05:00:00Z"), weeknights, LDN)).toBe(true);    // Sat 06:00 (Friday's span)
    expect(inQuietHours(at("2026-10-10T22:00:00Z"), weeknights, LDN)).toBe(false);   // Sat 23:00
    expect(inQuietHours(at("2026-10-11T22:00:00Z"), weeknights, LDN)).toBe(false);   // Sun 23:00
    expect(inQuietHours(at("2026-10-12T05:00:00Z"), weeknights, LDN)).toBe(false);   // Mon 06:00 (Sunday's span: off)
    expect(inQuietHours(at("2026-10-12T22:00:00Z"), weeknights, LDN)).toBe(true);    // Mon 23:00
  });

  it("a daytime span (focus time) on weekdays", () => {
    const focus = { start: "09:00", end: "12:30", days: [1, 2, 3, 4, 5] };
    expect(inQuietHours(at("2026-10-09T10:00:00Z"), focus, LDN)).toBe(true);    // Fri 11:00
    expect(inQuietHours(at("2026-10-09T11:30:00Z"), focus, LDN)).toBe(false);   // 12:30: over
    expect(inQuietHours(at("2026-10-10T10:00:00Z"), focus, LDN)).toBe(false);   // Sat
    expect(z(quietHoursEnd(at("2026-10-09T08:15:00Z"), focus, LDN))).toBe("2026-10-09T11:30:00Z");
  });

  it("ends at the right instant across the clocks going forward (a 7-hour night)", () => {
    // Sat 28 Mar 23:00 GMT → Sun 29 Mar 07:00 BST
    const end = quietHoursEnd(at("2026-03-28T23:00:00Z"), NIGHTS, LDN);
    expect(z(end)).toBe("2026-03-29T06:00:00Z");
    expect((end.getTime() - at("2026-03-28T23:00:00Z").getTime()) / 3600000).toBe(7);
    // and from inside the morning part
    expect(z(quietHoursEnd(at("2026-03-29T03:00:00Z"), NIGHTS, LDN))).toBe("2026-03-29T06:00:00Z");
  });

  it("ends at the right instant across the clocks going back (a 9-hour night)", () => {
    // Sat 24 Oct 23:00 BST → Sun 25 Oct 07:00 GMT
    const from = at("2026-10-24T22:00:00Z");
    const end = quietHoursEnd(from, NIGHTS, LDN);
    expect(z(end)).toBe("2026-10-25T07:00:00Z");
    expect((end.getTime() - from.getTime()) / 3600000).toBe(9);
  });

  it("New York's own change dates (8 March, 1 November)", () => {
    expect(z(quietHoursEnd(at("2026-03-08T03:30:00Z"), NIGHTS, NYC))).toBe("2026-03-08T11:00:00Z");   // Sat 22:30 EST → Sun 07:00 EDT
    expect(z(quietHoursEnd(at("2026-11-01T03:30:00Z"), NIGHTS, NYC))).toBe("2026-11-01T12:00:00Z");   // Sat 23:30 EDT → Sun 07:00 EST
    // the week London has gone back and New York hasn't yet
    expect(inQuietHours(at("2026-10-29T03:00:00Z"), NIGHTS, NYC)).toBe(true);    // 23:00 EDT
    expect(inQuietHours(at("2026-10-29T03:00:00Z"), NIGHTS, LDN)).toBe(true);    // 03:00 GMT
    expect(inQuietHours(at("2026-10-29T12:00:00Z"), NIGHTS, NYC)).toBe(false);
  });

  it("a span that ends in the skipped hour ends just past it; the repeated hour counts twice", () => {
    const late = { start: "23:00", end: "01:30", days: [6] };   // Saturday nights
    expect(z(quietHoursEnd(at("2026-03-28T23:30:00Z"), late, LDN))).toBe("2026-03-29T01:30:00Z");   // 02:30 BST
    const early = { start: "00:00", end: "01:30", days: [7] };   // Sunday, 00:00–01:30
    expect(inQuietHours(at("2026-10-24T23:15:00Z"), early, LDN)).toBe(true);    // 00:15 BST
    expect(z(quietHoursEnd(at("2026-10-24T23:15:00Z"), early, LDN))).toBe("2026-10-25T00:30:00Z");   // 01:30 BST
    expect(inQuietHours(at("2026-10-25T00:45:00Z"), early, LDN)).toBe(false);   // 01:45 BST
    expect(inQuietHours(at("2026-10-25T01:15:00Z"), early, LDN)).toBe(true);    // 01:15 GMT, the second time round
    expect(z(quietHoursEnd(at("2026-10-25T01:15:00Z"), early, LDN))).toBe("2026-10-25T01:30:00Z");   // 01:30 GMT, never earlier
  });

  it("outside quiet hours the end is the same instant", () => {
    const t = at("2026-10-09T12:00:00Z");
    expect(quietHoursEnd(t, NIGHTS, LDN)).toBe(t);
  });
});

describe("the daily digest", () => {
  it("the next digest strictly after a moment", () => {
    expect(z(nextDigestAt(at("2026-10-09T09:00:00Z"), "08:00", LDN))).toBe("2026-10-10T07:00:00Z");
    expect(z(nextDigestAt(at("2026-10-09T06:00:00Z"), "08:00", LDN))).toBe("2026-10-09T07:00:00Z");
    expect(z(nextDigestAt(at("2026-10-09T07:00:00Z"), "08:00", LDN))).toBe("2026-10-10T07:00:00Z");   // strictly after
    expect(z(nextDigestAt(at("2026-10-09T06:00:00Z"), "nonsense", LDN))).toBe("2026-10-09T07:00:00Z");  // default 08:00
  });

  it("keeps the wall-clock time across both changes (a 25-hour and a 23-hour day)", () => {
    const sat = at("2026-10-24T08:00:00Z");   // Sat 09:00 BST
    const sun = nextDigestAt(sat, "08:00", LDN);
    expect(z(sun)).toBe("2026-10-25T08:00:00Z");   // Sun 08:00 GMT
    expect((sun.getTime() - at("2026-10-24T07:00:00Z").getTime()) / 3600000).toBe(25);
    expect(z(nextDigestAt(at("2026-03-28T09:00:00Z"), "08:00", LDN))).toBe("2026-03-29T07:00:00Z");   // Sun 08:00 BST
    expect(z(nextDigestAt(at("2026-03-28T09:00:00Z"), "01:30", LDN))).toBe("2026-03-29T01:30:00Z");   // the gap → 02:30 BST
    expect(z(nextDigestAt(at("2026-10-24T09:00:00Z"), "01:30", LDN))).toBe("2026-10-25T00:30:00Z");   // repeated → the first
  });

  it("is due from its time for the catch-up window, once per local date", () => {
    const p = { digestTime: "08:00", quietHours: null, timezone: LDN };
    expect(digestDue(at("2026-10-09T06:50:00Z"), p).due).toBe(false);   // 07:50
    expect(digestDue(at("2026-10-09T07:10:00Z"), p)).toMatchObject({ due: true, date: "2026-10-09" });
    expect(digestDue(at("2026-10-09T08:59:00Z"), p).due).toBe(true);    // 09:59: still catching up
    expect(digestDue(at("2026-10-09T09:01:00Z"), p).due).toBe(false);   // 10:01: missed, wait for tomorrow
    // a different timezone: 08:00 in New York
    expect(digestDue(at("2026-10-09T12:05:00Z"), { ...p, timezone: NYC })).toMatchObject({ due: true, date: "2026-10-09" });
  });

  it("waits for quiet hours to end, even into the next day", () => {
    const morning = { digestTime: "08:00", quietHours: { start: "22:00", end: "09:00", days: [1, 2, 3, 4, 5, 6, 7] }, timezone: LDN };
    expect(z(digestMoment("2026-10-09", morning))).toBe("2026-10-09T08:00:00Z");   // 09:00 BST
    expect(digestDue(at("2026-10-09T07:30:00Z"), morning).due).toBe(false);
    expect(digestDue(at("2026-10-09T08:05:00Z"), morning)).toMatchObject({ due: true, date: "2026-10-09" });
    const late = { digestTime: "23:30", quietHours: { start: "23:00", end: "07:00", days: [1, 2, 3, 4, 5, 6, 7] }, timezone: LDN };
    // Friday's 23:30 digest goes at Saturday 07:00, keyed to Friday
    expect(digestDue(at("2026-10-10T06:10:00Z"), late)).toMatchObject({ due: true, date: "2026-10-09" });
  });
});

describe("planDelivery", () => {
  const base = (over: Partial<DeliveryInput> & { raw?: Record<string, unknown> } = {}): DeliveryInput => {
    const { raw, ...rest } = over;
    return { kind: "comment", channel: "push", now: at("2026-10-09T09:00:00Z"), prefs: resolveNotifyPrefs(raw ?? {}), ...rest };
  };

  it("sends straight away by default", () => {
    expect(planDelivery(base())).toEqual({ action: "send" });
    expect(planDelivery(base({ channel: "email" }))).toEqual({ action: "send" });
  });

  it("respects the switch for that kind and channel", () => {
    expect(planDelivery(base({ raw: { comment_push: false } }))).toEqual({ action: "skip", reason: "pref_off" });
    expect(planDelivery(base({ raw: { comment_push: false }, channel: "email" }))).toEqual({ action: "send" });
  });

  it("a snoozed thread sends nothing, mentions included, until the snooze ends", () => {
    const snoozedUntil = at("2026-10-09T10:00:00Z");
    expect(planDelivery(base({ snoozedUntil }))).toEqual({ action: "skip", reason: "snoozed" });
    expect(planDelivery(base({ snoozedUntil, kind: "mention" }))).toEqual({ action: "skip", reason: "snoozed" });
    expect(planDelivery(base({ snoozedUntil: at("2026-10-09T08:59:00Z") }))).toEqual({ action: "send" });
  });

  it("daily digest: email waits for it; push only for mentions and approvals", () => {
    const raw = { delivery: "digest" };
    expect(planDelivery(base({ raw, channel: "email", kind: "mention" }))).toEqual({ action: "digest" });
    expect(planDelivery(base({ raw, kind: "comment" }))).toEqual({ action: "skip", reason: "digest_mode" });
    expect(planDelivery(base({ raw, kind: "assigned" }))).toEqual({ action: "skip", reason: "digest_mode" });
    expect(planDelivery(base({ raw, kind: "mention" }))).toEqual({ action: "send" });
    expect(planDelivery(base({ raw, kind: "approval" }))).toEqual({ action: "send" });
  });

  it("quiet hours hold push and email to their end (and come before bundling)", () => {
    const raw = { quiet_hours: NIGHTS };
    const now = at("2026-10-09T22:30:00Z");   // 23:30 BST
    const plan = planDelivery(base({ raw, now, lastSentForTask: at("2026-10-09T22:29:00Z") }));
    expect(plan).toEqual({ action: "hold", until: at("2026-10-10T06:00:00Z"), reason: "quiet_hours" });
    expect(planDelivery(base({ raw, now, kind: "mention", channel: "email" }))).toMatchObject({ action: "hold", reason: "quiet_hours" });
    // a mention in digest mode still waits for the morning
    expect(planDelivery(base({ raw: { ...raw, delivery: "digest" }, now, kind: "mention" }))).toMatchObject({ action: "hold", reason: "quiet_hours" });
  });

  it("bundles: within 2 minutes of the last one sent, hold to the window's end", () => {
    const now = at("2026-10-09T09:00:30Z");
    const last = at("2026-10-09T09:00:00Z");
    expect(planDelivery(base({ now, lastSentForTask: last }))).toEqual({
      action: "hold", until: new Date(last.getTime() + NOTIFY_BUNDLE_WINDOW_SEC * 1000), reason: "bundle",
    });
    expect(planDelivery(base({ now: at("2026-10-09T09:02:00Z"), lastSentForTask: last }))).toEqual({ action: "send" });
    // bundling off: every notice on its own
    expect(planDelivery(base({ now, lastSentForTask: last, raw: { bundle: false } }))).toEqual({ action: "send" });
  });

  it("joins notices already waiting for the task, so they go as one", () => {
    const now = at("2026-10-09T06:00:20Z");
    expect(planDelivery(base({ now, pendingUntil: at("2026-10-09T06:00:00Z") }))).toEqual({ action: "hold", until: now, reason: "bundle" });
    expect(planDelivery(base({ now, pendingUntil: at("2026-10-09T06:01:30Z") }))).toEqual({ action: "hold", until: at("2026-10-09T06:01:30Z"), reason: "bundle" });
    expect(planDelivery(base({ now, pendingUntil: at("2026-10-09T06:02:20Z") }))).toEqual({ action: "hold", until: at("2026-10-09T06:02:20Z"), reason: "bundle" });
  });

  it("never joins a longer wait: held for quiet hours since switched off, a mention goes now", () => {
    // a comment was held at 23:00 to 07:00; quiet hours are off by 05:30
    const now = at("2026-10-09T04:30:00Z");
    const pendingUntil = at("2026-10-09T06:00:00Z");
    expect(planDelivery(base({ now, pendingUntil, kind: "mention" }))).toEqual({ action: "send" });
    // just past the window: on its own too (a window it opens, if one was just sent)
    expect(planDelivery(base({ now, pendingUntil: at("2026-10-09T04:32:01Z") }))).toEqual({ action: "send" });
    expect(planDelivery(base({ now, pendingUntil, lastSentForTask: at("2026-10-09T04:29:30Z") }))).toEqual({
      action: "hold", until: at("2026-10-09T04:31:30Z"), reason: "bundle",
    });
    // still in (new, shorter) quiet hours: their end, not the old one
    expect(planDelivery(base({ now, pendingUntil, raw: { quiet_hours: { start: "22:00", end: "06:00" } } }))).toEqual({
      action: "hold", until: at("2026-10-09T05:00:00Z"), reason: "quiet_hours",
    });
  });
});
