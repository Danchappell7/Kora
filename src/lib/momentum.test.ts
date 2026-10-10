/* lib/momentum — the pure parts: working days (weekends, bank holidays, days off), streaks,
   the recap windows (pinned times, in BST and GMT), the recap builder and its text, kudos
   helpers; then the demo data functions and this device's planned days / focus log. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Kudos, Task } from "../data/types";
import {
  activeDaysFor, addDaysISO, buildWinsRecap, canGiveKudos, computeStreak, dayLabel, dayOffReason, focusLabel, giveKudos, isBankHoliday,
  isoWeekday, isWorkingDay, kudosErrorText, kudosOnTask, listKudos, localDayOf, localMoment, markDayPlanned, momentumPatch, mondayOf, nameList,
  noteFocusToday, plannedToday, rangeLabel, readFocusLog, readPlannedDays, recapHeadline, recapTitle, recapWindow, rememberKudosTask,
  replaceTaskKudos, resetKudosDemo, streakWeek, subscribeKudos, takeBackKudos, tidyDaysOff, UK_BANK_HOLIDAYS, ukBankHolidays, winsRecapText,
  demoKudosActivity, kudosCounts,
} from "./momentum";

const at = (iso: string) => new Date(iso);
const done = (completedAt: string) => ({ completedAt });

let n = 0;
const task = (o: Partial<Task>): Task => ({
  id: "t" + (++n), title: "Task " + n, description: "", status: "done", priority: "medium", projectId: "p-launch", assigneeId: "me",
  tags: [], dependencies: [], subtasks: [], focusMin: 0, comments: 0, aiScore: 0, workspaceId: "ws", ...o,
});
const kudo = (o: Partial<Kudos>): Kudos => ({
  id: "k" + (++n), taskId: "x", workspaceId: "ws", fromUser: "maya", toUser: "me", emoji: "🎉", note: null, createdAt: "2026-10-07T10:00:00Z", ...o,
});
const NAMES: Record<string, string> = { me: "Daniel Okai", maya: "Maya Lin", theo: "Theo Vance", sana: "Sana Rao", idris: "Idris Bell" };
const nameOf = (id: string) => NAMES[id] ?? "Someone";
const PROJECTS = [
  { id: "p-launch", name: "Q3 Product Launch", emoji: "🚀", color: "#38f" },
  { id: "p-brand", name: "Brand Refresh", emoji: "🎨", color: "#a3f" },
  { id: "p-infra", name: "Platform Infra", emoji: "⚙️", color: "#3a8" },
];

beforeEach(() => {
  // every expectation passes its own `now`; the demo's "minutes ago" and defaults read this pinned clock
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-09T10:00:00+01:00"));
  localStorage.clear();
  resetKudosDemo({ demoDelayMs: 0 });
});
afterEach(() => { vi.useRealTimers(); });

describe("dates in the person's timezone", () => {
  it("reads the local date and hour across BST and GMT", () => {
    expect(localMoment(at("2026-10-09T23:30:00Z"))).toMatchObject({ date: "2026-10-10", hour: 0, weekday: 6 });   // BST: 00:30 Saturday
    expect(localMoment(at("2026-11-06T23:30:00Z"))).toMatchObject({ date: "2026-11-06", hour: 23, weekday: 5 });  // GMT: 23:30 Friday
    expect(localMoment(at("2026-10-09T23:30:00Z"), "America/New_York")).toMatchObject({ date: "2026-10-09", hour: 19 });
    expect(localMoment(at("2026-10-09T12:00:00Z"), "Not/AZone").date).toBe("2026-10-09");   // unknown: London
  });
  it("turns completedAt into a local day (dates stay dates)", () => {
    expect(localDayOf("2026-10-09")).toBe("2026-10-09");
    expect(localDayOf("2026-10-09T23:30:00Z")).toBe("2026-10-10");
    expect(localDayOf("2026-10-09T23:30:00Z", "UTC")).toBe("2026-10-09");
    expect(localDayOf("nope")).toBeNull();
    expect(localDayOf(undefined)).toBeNull();
  });
  it("day arithmetic and labels", () => {
    expect(addDaysISO("2026-10-30", 3)).toBe("2026-11-02");
    expect(addDaysISO("2026-03-01", -1)).toBe("2026-02-28");
    expect(isoWeekday("2026-10-09")).toBe(5);
    expect(isoWeekday("2026-10-11")).toBe(7);
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(rangeLabel("2026-10-05", "2026-10-09")).toBe("5–9 Oct");
    expect(rangeLabel("2026-09-28", "2026-10-04")).toBe("28 Sep – 4 Oct");
    expect(rangeLabel("2026-12-28", "2027-01-03")).toBe("28 Dec 2026 – 3 Jan 2027");
    expect(dayLabel("2026-10-16")).toBe("Fri 16 Oct");
    expect(focusLabel(570)).toBe("9h 30m");
    expect(focusLabel(45)).toBe("45m");
    expect(focusLabel(120)).toBe("2h");
    expect(nameList(["Sana"])).toBe("Sana");
    expect(nameList(["Sana", "Maya", "Theo", "Idris"])).toBe("Sana, Maya and 2 others");
  });
});

describe("working days", () => {
  it("lists England & Wales bank holidays for 2026–2027, and the rules agree with them", () => {
    expect(UK_BANK_HOLIDAYS).toHaveLength(16);
    expect(ukBankHolidays(2026)).toEqual(["2026-01-01", "2026-04-03", "2026-04-06", "2026-05-04", "2026-05-25", "2026-08-31", "2026-12-25", "2026-12-28"]);
    // the rules on their own (2028, a leap year with Christmas on a Monday; 2022's New Year on a Saturday)
    expect(ukBankHolidays(2028)).toEqual(["2028-01-03", "2028-04-14", "2028-04-17", "2028-05-01", "2028-05-29", "2028-08-28", "2028-12-25", "2028-12-26"]);
    expect(ukBankHolidays(2022).slice(0, 3)).toEqual(["2022-01-03", "2022-04-15", "2022-04-18"]);
    // and 2027's Christmas (Saturday → Monday 27, Boxing Day Sunday → Tuesday 28)
    expect(UK_BANK_HOLIDAYS.filter((d) => d.startsWith("2027-12"))).toEqual(["2027-12-27", "2027-12-28"]);
  });
  it("Mon–Fri, not bank holidays, not your days off", () => {
    expect(isWorkingDay("2026-10-09")).toBe(true);           // Friday
    expect(isWorkingDay("2026-10-10")).toBe(false);          // Saturday
    expect(isWorkingDay("2026-12-25")).toBe(false);          // Christmas
    expect(isBankHoliday("2026-08-31")).toBe(true);
    expect(isWorkingDay("2026-10-16", { daysOff: ["2026-10-16"] })).toBe(false);
    expect(isWorkingDay("nope")).toBe(false);
    expect(dayOffReason("2026-10-11")).toBe("weekend");
    expect(dayOffReason("2026-04-03")).toBe("bank_holiday");
    expect(dayOffReason("2026-10-16", { daysOff: ["2026-10-16"] })).toBe("day_off");
    expect(dayOffReason("2026-10-15")).toBeNull();
  });
});

describe("the streak", () => {
  const now = at("2026-10-09T10:00:00+01:00");   // Friday 9 Oct, 10:00 BST
  it("counts the working days in a row you planned or finished something", () => {
    const s = computeStreak({ now, plannedDays: ["2026-10-06", "2026-10-07"], completed: [done("2026-10-08T15:00:00Z"), done("2026-10-05")] });
    expect(s).toEqual({ days: 4, today: "pending", since: "2026-10-05" });
    // today counts once something happens
    expect(computeStreak({ now, plannedDays: ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"], completed: [] }))
      .toEqual({ days: 5, today: "done", since: "2026-10-05" });
  });
  it("skips weekends (neither a break nor a bonus)", () => {
    const mon = at("2026-10-12T09:00:00+01:00");
    // Thu, Fri, then the weekend (Saturday's work doesn't add), Monday still open
    const s = computeStreak({ now: mon, plannedDays: ["2026-10-08", "2026-10-09", "2026-10-10"], completed: [] });
    expect(s).toEqual({ days: 2, today: "pending", since: "2026-10-08" });
  });
  it("bank holidays and days off don't break it", () => {
    // Easter 2026: Thu 2 Apr, (Good Friday 3), (Easter Monday 6), Tue 7 Apr
    const tue = at("2026-04-07T12:00:00+01:00");
    expect(computeStreak({ now: tue, plannedDays: ["2026-04-01", "2026-04-02", "2026-04-07"], completed: [] }))
      .toEqual({ days: 3, today: "done", since: "2026-04-01" });
    // a day off on Wednesday
    const thu = at("2026-10-08T09:00:00+01:00");
    expect(computeStreak({ now: thu, plannedDays: ["2026-10-05", "2026-10-06"], completed: [], prefs: { daysOff: ["2026-10-07"] } }))
      .toEqual({ days: 2, today: "pending", since: "2026-10-05" });
    // …without it, Wednesday breaks the run
    expect(computeStreak({ now: thu, plannedDays: ["2026-10-05", "2026-10-06"], completed: [] })).toEqual({ days: 0, today: "pending", since: null });
  });
  it("a day off today, or the weekend: today is 'off' and the run waits", () => {
    expect(computeStreak({ now: at("2026-10-10T11:00:00+01:00"), plannedDays: ["2026-10-08", "2026-10-09"], completed: [] }))
      .toEqual({ days: 2, today: "off", since: "2026-10-08" });
    expect(computeStreak({ now, plannedDays: ["2026-10-08"], completed: [], prefs: { daysOff: ["2026-10-09"] } }))
      .toEqual({ days: 1, today: "off", since: "2026-10-08" });
  });
  it("finishing late at night counts for the local day (GMT and BST)", () => {
    // 23:30 UTC on Thu 29 Oct (GMT) is still Thursday; 23:30 UTC on Thu 8 Oct (BST) is Friday
    expect(computeStreak({ now: at("2026-10-30T10:00:00Z"), plannedDays: [], completed: [done("2026-10-29T23:30:00Z")] }).since).toBe("2026-10-29");
    expect(computeStreak({ now, plannedDays: [], completed: [done("2026-10-08T23:30:00Z")] })).toEqual({ days: 1, today: "done", since: "2026-10-09" });
  });
  it("nothing at all: 0 days", () => {
    expect(computeStreak({ now, plannedDays: [], completed: [] })).toEqual({ days: 0, today: "pending", since: null });
    expect(computeStreak({ now, plannedDays: ["junk", "2026-13-45"], completed: [{ completedAt: undefined }] }).days).toBe(0);
  });
  it("this week's strip", () => {
    const s = computeStreak({ now, plannedDays: ["2026-10-07", "2026-10-08"], completed: [] });
    expect(streakWeek(s, now).map((d) => d.state)).toEqual(["missed", "missed", "done", "done", "pending"]);
    const prefs = { daysOff: ["2026-10-06"] };
    const s2 = computeStreak({ now, plannedDays: ["2026-10-05", "2026-10-07", "2026-10-08", "2026-10-09"], completed: [], prefs });
    expect(streakWeek(s2, now, undefined, prefs).map((d) => d.state)).toEqual(["done", "off", "done", "done", "done"]);
    // a run broken earlier in the week still shows the days that counted, when they're known
    const wed = at("2026-10-07T09:00:00+01:00");
    const s3 = computeStreak({ now: wed, plannedDays: ["2026-10-05"], completed: [] });
    expect(s3.days).toBe(0);
    expect(streakWeek(s3, wed, undefined, null, activeDaysFor(["2026-10-05"], [])).map((d) => d.state)).toEqual(["done", "missed", "pending", "future", "future"]);
  });
});

describe("the recap window", () => {
  it("Friday from 14:00 (BST): this week", () => {
    expect(recapWindow(at("2026-10-09T12:59:00Z"))).toBeNull();                    // 13:59 BST
    expect(recapWindow(at("2026-10-09T13:00:00Z"))).toEqual({ kind: "friday", from: "2026-10-05", to: "2026-10-09" });
    expect(recapWindow(at("2026-10-09T22:30:00Z"))).toEqual({ kind: "friday", from: "2026-10-05", to: "2026-10-09" });
    expect(recapWindow(at("2026-10-09T23:30:00Z"))).toBeNull();                    // Saturday 00:30 BST
  });
  it("Friday from 14:00 (GMT, after the clocks go back)", () => {
    expect(recapWindow(at("2026-10-30T13:59:00Z"))).toBeNull();
    expect(recapWindow(at("2026-10-30T14:00:00Z"))).toEqual({ kind: "friday", from: "2026-10-26", to: "2026-10-30" });
  });
  it("Monday until 12:00: last week, Monday to Sunday", () => {
    expect(recapWindow(at("2026-10-05T10:59:00Z"))).toEqual({ kind: "monday", from: "2026-09-28", to: "2026-10-04" });   // 11:59 BST
    expect(recapWindow(at("2026-10-05T11:00:00Z"))).toBeNull();                                                         // 12:00 BST
    expect(recapWindow(at("2026-11-02T11:59:00Z"))).toEqual({ kind: "monday", from: "2026-10-26", to: "2026-11-01" });   // GMT
    expect(recapWindow(at("2026-11-02T12:00:00Z"))).toBeNull();
  });
  it("other days and times: none", () => {
    expect(recapWindow(at("2026-10-07T15:00:00Z"))).toBeNull();   // Wednesday
    expect(recapWindow(at("2026-10-10T15:00:00Z"))).toBeNull();   // Saturday
  });
  it("a bank holiday or a day off moves it", () => {
    // Good Friday 2026 → Thursday afternoon; Easter Monday → Tuesday morning
    expect(recapWindow(at("2026-04-02T13:30:00Z"))).toEqual({ kind: "friday", from: "2026-03-30", to: "2026-04-02" });
    expect(recapWindow(at("2026-04-03T13:30:00Z"))).toBeNull();
    expect(recapWindow(at("2026-04-07T08:00:00Z"))).toEqual({ kind: "monday", from: "2026-03-30", to: "2026-04-05" });
    // your Friday off → Thursday
    expect(recapWindow(at("2026-10-15T14:30:00Z"), undefined, { daysOff: ["2026-10-16"] })).toEqual({ kind: "friday", from: "2026-10-12", to: "2026-10-15" });
  });
  it("another timezone", () => {
    // 14:00 in New York on Friday is 19:00 in London
    expect(recapWindow(at("2026-10-09T18:00:00Z"), "America/New_York")).toEqual({ kind: "friday", from: "2026-10-05", to: "2026-10-09" });
    expect(recapWindow(at("2026-10-09T17:59:00Z"), "America/New_York")).toBeNull();
  });
});

describe("the wins recap", () => {
  const friday = at("2026-10-09T15:00:00+01:00");
  const tasks = () => {
    n = 0;
    return [
      task({ id: "deck", title: "Finalise launch deck", completedAt: "2026-10-08T16:00:00Z", focusMin: 90 }),
      task({ id: "budget", title: "Approve launch budget", completedAt: "2026-10-06", focusMin: 20 }),
      task({ id: "tokens", title: "Define design tokens v2", projectId: "p-brand", assigneeId: "sana", collaborators: ["me"], completedAt: "2026-10-07T11:00:00Z", focusMin: 45 }),
      task({ id: "edge", title: "Migrate auth to edge sessions", projectId: "p-infra", completedAt: "2026-10-05T09:00:00Z", loggedHours: 2 }),
      task({ id: "old", title: "Last week's thing", completedAt: "2026-10-02T09:00:00Z" }),
      task({ id: "theirs", title: "Theo's demo", assigneeId: "theo", completedAt: "2026-10-08T09:00:00Z" }),
      task({ id: "open", title: "Still going", status: "progress" }),
      task({ id: "onb", title: "Ship onboarding", status: "blocked", assigneeId: "maya", dependencies: ["deck"] }),
    ];
  };
  const kudos = [
    kudo({ taskId: "budget", fromUser: "maya", toUser: "me", emoji: "👏", note: "So quick", createdAt: "2026-10-06T15:00:00Z" }),
    kudo({ taskId: "deck", fromUser: "sana", toUser: "me", emoji: "🎉", createdAt: "2026-10-08T17:00:00Z" }),
    kudo({ taskId: "theirs", fromUser: "me", toUser: "theo", emoji: "🔥", createdAt: "2026-10-08T10:00:00Z" }),
    kudo({ taskId: "budget", fromUser: "theo", toUser: "me", createdAt: "2026-09-30T10:00:00Z" }),   // last week: not counted
  ];
  const input = () => ({ now: friday, currentUserId: "me", tasks: tasks(), projects: PROJECTS, kudos, plannedDays: ["2026-10-09"], nameOf });

  it("Friday afternoon: what you finished, by project, with focus, streak and moments", () => {
    const r = buildWinsRecap(input())!;
    expect(r).not.toBeNull();
    expect([r.kind, r.from, r.to, r.total]).toEqual(["friday", "2026-10-05", "2026-10-09", 4]);
    expect(r.byProject.map((p) => [p.projectId, p.count])).toEqual([["p-launch", 2], ["p-brand", 1], ["p-infra", 1]]);
    expect(r.byProject[0].tasks.map((t) => t.id)).toEqual(["deck", "budget"]);   // newest first
    // no focus timer: logged time, else the focus estimate, to the quarter hour (90 + 20 + 45 + 120 = 275 → 270)
    expect([r.focusMinutes, r.focusFrom]).toEqual([270, "tasks"]);
    // (last Friday's finished task carries the run across the weekend)
    expect(r.streak).toEqual({ days: 6, today: "done", since: "2026-10-02" });
    expect(r.kudosReceived).toBe(2);
    expect(r.moments.map((m) => m.kind)).toEqual(["kudos_received", "kudos_received", "unblocked"]);
    expect(r.moments[0].text).toBe("Maya sent you 👏 for “Approve launch budget” — “So quick”");
    expect(r.moments[1].text).toBe("Sana sent you 🎉 for “Finalise launch deck”");
    expect(r.moments[2].text).toBe("You unblocked Maya: “Finalise launch deck” was holding up “Ship onboarding”");
    expect(recapTitle(r)).toBe("Your week's wins");
    expect(recapHeadline(r)).toBe("This week you finished 4 things across Q3 Product Launch, Brand Refresh and Platform Infra.");
  });
  it("the focus timer wins when it was used", () => {
    const r = buildWinsRecap({ ...input(), focusLog: { "2026-10-05": 95, "2026-10-06": 140, "2026-10-02": 300 } })!;
    expect([r.focusMinutes, r.focusFrom]).toEqual([235, "timer"]);
  });
  it("helped, approvals and kudos you gave fill in when there's room", () => {
    const r = buildWinsRecap({ ...input(), kudos: kudos.slice(2), approvals: [{ taskId: "x", title: "Homepage copy", requesterId: "sana", decidedAt: "2026-10-07T10:00:00Z", decision: "approved" }] })!;
    expect(r.moments.map((m) => m.text)).toEqual([
      "You unblocked Maya: “Finalise launch deck” was holding up “Ship onboarding”",
      "You helped Sana finish “Define design tokens v2”",
      "You turned round Sana's approval on “Homepage copy”",
    ]);
    const only = buildWinsRecap({ ...input(), tasks: tasks().filter((t) => t.id === "theirs"), kudos: kudos.slice(2, 3) })!;
    expect(only.moments.map((m) => m.text)).toEqual(["You thanked Theo for “Theo's demo”"]);
    expect(only.total).toBe(0);
    expect(recapHeadline(only)).toBe("A week more about the people than the list.");
  });
  it("lots of kudos fold into one line", () => {
    const many = ["maya", "theo", "sana", "idris"].map((u, i) => kudo({ taskId: "deck", fromUser: u, createdAt: `2026-10-0${5 + i}T10:00:00Z` }));
    const r = buildWinsRecap({ ...input(), kudos: many })!;
    expect(r.moments[0].text).toMatch(/^Idris sent you 🎉/);
    expect(r.moments[1].text).toBe("3 more kudos from Sana, Theo and Maya");
  });
  it("Monday morning: last week", () => {
    const r = buildWinsRecap({ ...input(), now: at("2026-10-12T08:30:00+01:00") })!;
    expect([r.kind, r.from, r.to, r.total]).toEqual(["monday", "2026-10-05", "2026-10-11", 4]);
    expect(recapTitle(r)).toBe("Last week's wins");
    expect(recapHeadline(r)).toMatch(/^Last week you finished 4 things/);
  });
  it("no window, or nothing to say: null; a window can be given (the preview)", () => {
    expect(buildWinsRecap({ ...input(), now: at("2026-10-07T15:00:00+01:00") })).toBeNull();
    expect(buildWinsRecap({ ...input(), tasks: [], kudos: [] })).toBeNull();
    expect(buildWinsRecap({ ...input(), currentUserId: "" })).toBeNull();
    const p = buildWinsRecap({ ...input(), now: at("2026-10-07T15:00:00+01:00"), window: { kind: "friday", from: "2026-10-05", to: "2026-10-07" } })!;
    expect([p.preview, p.total]).toEqual([true, 3]);
    expect(recapTitle(p)).toBe("Your week so far");
  });
  it("as text for Slack: a bold heading line, counts, titles by project — no one's notes", () => {
    const r = buildWinsRecap(input())!;
    const text = winsRecapText(r, { name: "Daniel Okai" });
    expect(text.split("\n")[0]).toBe("*Daniel's week · 5–9 Oct*");
    expect(text).toContain("✅ 4 done across Q3 Product Launch (2), Brand Refresh (1) and Platform Infra (1)");
    expect(text).toContain("⏱️ 4h 30m of focus time");
    expect(text).toContain("📅 6 working days in a row");
    expect(text).toContain("🎉 2 kudos from the team");
    expect(text).toContain("• Q3 Product Launch: Finalise launch deck, Approve launch budget");
    expect(text).not.toContain("So quick");
    expect(winsRecapText(r, { showStreak: false })).not.toContain("in a row");
    expect(winsRecapText(r).split("\n")[0]).toBe("*My week · 5–9 Oct*");
    const long = { ...r, byProject: [{ projectId: "p-launch", count: 6, tasks: Array.from({ length: 6 }, (_, i) => ({ id: "x" + i, title: "T" + i })) }] };
    expect(winsRecapText(long)).toContain("• Q3 Product Launch: T0, T1, T2, T3 +2 more");
  });
});

describe("kudos helpers", () => {
  it("counts per person since a moment", () => {
    const list = [kudo({ fromUser: "a", toUser: "b", createdAt: "2026-10-09T09:00:00Z" }), kudo({ fromUser: "c", toUser: "b", createdAt: "2026-10-01T09:00:00Z" })];
    expect(kudosCounts(list, "2026-10-05T00:00:00Z")).toEqual({ a: { received: 0, given: 1 }, b: { received: 1, given: 0 } });
  });
  it("per task, replacing one task's, and who may give", () => {
    const a = kudo({ id: "a", taskId: "t1", createdAt: "2026-10-09T10:00:00Z" }), b = kudo({ id: "b", taskId: "t1", createdAt: "2026-10-08T10:00:00Z" }), c = kudo({ id: "c", taskId: "t2" });
    expect(kudosOnTask([a, b, c], "t1").map((k) => k.id)).toEqual(["b", "a"]);
    expect(replaceTaskKudos([a, b, c], "t1", [a]).map((k) => k.id).sort()).toEqual(["a", "c"]);
    const t = { status: "done" as const, assigneeId: "sana", workspaceId: "ws" };
    expect(canGiveKudos(t, "me")).toBe(true);
    expect(canGiveKudos({ ...t, assigneeId: "me" }, "me")).toBe(false);
    expect(canGiveKudos({ ...t, status: "review" }, "me")).toBe(false);
    expect(canGiveKudos({ ...t, workspaceId: null }, "me")).toBe(false);
    expect(canGiveKudos({ ...t, assigneeId: "" }, "me")).toBe(false);
    expect(kudosErrorText("too_many")).toMatch(/tomorrow/);
    expect(kudosErrorText("self")).toBe("Kudos are for your teammates.");
  });
  it("the prefs patch and tidy days off", () => {
    expect(momentumPatch({ streakHidden: true, daysOff: ["2026-10-16", "x", "2026-10-16", "2026-10-02"] }))
      .toEqual({ momentum: { streakHidden: true, daysOff: ["2026-10-02", "2026-10-16"] } });
    expect(tidyDaysOff(["2026-01-01", "2026-10-01", "2026-12-24", "bad"], "2026-10-09")).toEqual(["2026-10-01", "2026-12-24"]);
  });
});

describe("this device: planned days and focus", () => {
  it("records a planned day once, in order", () => {
    expect(readPlannedDays("u1")).toEqual([]);
    markDayPlanned("u1", "2026-10-08");
    markDayPlanned("u1", "2026-10-06");
    expect(markDayPlanned("u1", "2026-10-08")).toEqual(["2026-10-06", "2026-10-08"]);
    expect(readPlannedDays("u1")).toEqual(["2026-10-06", "2026-10-08"]);
    expect(markDayPlanned("u1", undefined, at("2026-10-09T23:30:00Z"))).toContain("2026-10-10");
  });
  it("planned today = one of your tasks planned or scheduled", () => {
    expect(plannedToday([{ assigneeId: "me", planToday: true }], "me")).toBe(true);
    expect(plannedToday([{ assigneeId: "x", collaborators: ["me"], scheduled: 540 }], "me")).toBe(true);
    expect(plannedToday([{ assigneeId: "me", scheduled: null, planToday: false }], "me")).toBe(false);
    expect(plannedToday([{ assigneeId: "x", planToday: true }], "me")).toBe(false);
  });
  it("copies the focus timer's daily total into a day-by-day log", () => {
    localStorage.setItem("kanbo-focus-stat:u1", JSON.stringify({ date: "2026-10-9", cycles: 2, min: 50 }));
    expect(noteFocusToday("u1")).toEqual({ "2026-10-09": 50 });
    localStorage.setItem("kanbo-focus-stat:u1", JSON.stringify({ date: "2026-10-12", cycles: 1, min: 25 }));
    noteFocusToday("u1");
    expect(readFocusLog("u1")).toEqual({ "2026-10-09": 50, "2026-10-12": 25 });
    localStorage.setItem("kanbo-focus-stat:u1", "garbage");
    expect(noteFocusToday("u1")).toEqual({ "2026-10-09": 50, "2026-10-12": 25 });
  });
  it("the demo person has a believable history", () => {
    const now = at("2026-10-09T10:00:00+01:00");
    expect(readPlannedDays("m-self", now)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
    expect(Object.keys(readFocusLog("m-self", now))).toContain("2026-10-06");
  });
});

describe("kudos in the demo (no backend)", () => {
  it("lists a workspace's kudos with names, newest first", async () => {
    const all = await listKudos("ws-foundrise");
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.every((k) => k.workspaceId === "ws-foundrise")).toBe(true);
    expect(all[0].createdAt >= all[all.length - 1].createdAt).toBe(true);
    expect(all.find((k) => k.taskId === "t-12")).toMatchObject({ fromName: "Maya Lin", toName: "Daniel Okai", emoji: "👏" });
    expect(await listKudos("ws-foundrise", { taskIds: ["t-16"] })).toHaveLength(2);
    expect(await listKudos("")).toEqual([]);
  });
  it("gives (once), takes back, and tells subscribers", async () => {
    const heard = vi.fn();
    const off = subscribeKudos("ws-foundrise", heard);
    const k = await giveKudos("t-24", "🚀", "  Lovely  ");
    expect(k).toMatchObject({ taskId: "t-24", fromUser: "m-self", toUser: "m-2", emoji: "🚀", note: "Lovely", toName: "Theo Vance" });
    expect((await giveKudos("t-24")).id).toBe(k.id);   // idempotent
    expect(heard).toHaveBeenCalledTimes(1);
    expect(await takeBackKudos("t-24")).toBe(true);
    expect(await takeBackKudos("t-24")).toBe(false);
    expect(heard).toHaveBeenCalledTimes(2);
    off();
  });
  it("follows the database's rules", async () => {
    await expect(giveKudos("t-1")).rejects.toThrow("task not done");
    await expect(giveKudos("t-12")).rejects.toThrow("not for yourself");
    await expect(giveKudos("t-27")).rejects.toThrow();   // not done
    await expect(giveKudos("nope")).rejects.toThrow("task not found");
    await expect(giveKudos("t-24", "💩" as never)).rejects.toThrow("invalid emoji");
    await expect(giveKudos("t-24", "🎉", "x".repeat(141))).rejects.toThrow("invalid note");
    await expect(giveKudos("t-24", "🎉", null, "m-3")).rejects.toThrow("invalid recipient");
    // a task finished in this session (the button tells the fakes)
    rememberKudosTask({ id: "t-new", title: "New", status: "done", assigneeId: "m-3", workspaceId: "ws-foundrise" });
    expect((await giveKudos("t-new")).toUser).toBe("m-3");
    rememberKudosTask({ id: "t-mine", title: "Mine", status: "done", assigneeId: "m-1", workspaceId: null });
    await expect(giveKudos("t-mine")).rejects.toThrow("kudos need a team task");
  });
  it("demo Inbox items for the kudos you got", () => {
    const items = demoKudosActivity();
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]).toMatchObject({ kind: "kudos", taskId: "t-12", detail: "Maya Lin", meta: { emoji: "👏" } });
    expect(items[0].readAt).toBeUndefined();
    expect(items[1].readAt).toBeTruthy();
  });
});
