// @vitest-environment node
// The calendar feed's iCalendar builder (RFC 5545) and its "what goes in the
// feed" rules. Pure: the same module runs in the ics-feed edge function.
import { describe, expect, it } from "vitest";
import {
  addIcsDays, buildIcs, escapeIcsText, feedDayLabel, feedDuration, feedEvents, feedStamp, foldIcsLine,
  FEED_MAX_EVENTS, icsDate, icsUtc, isBritishSummerTime, isIcsDay, londonWallTimeToUtc,
  type FeedInput, type FeedStateRow, type FeedTaskRow, type IcsEvent,
} from "./ics.ts";

const enc = new TextEncoder();
const octets = (s: string) => enc.encode(s).length;

/** RFC 5545 §3.1 unfolding, then a tiny parser: [{ name, params, value }]. */
function unfold(ics: string): string[] {
  return ics.replace(/\r\n[ \t]/g, "").split("\r\n").filter((l, i, a) => !(l === "" && i === a.length - 1));
}
function props(ics: string) {
  return unfold(ics).map((l) => {
    const colon = l.indexOf(":");
    const head = l.slice(0, colon);
    const [name, ...params] = head.split(";");
    return { name, params, value: l.slice(colon + 1) };
  });
}
/** The VEVENTs as name → value maps. */
function vevents(ics: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let cur: Record<string, string> | null = null;
  for (const p of props(ics)) {
    if (p.name === "BEGIN" && p.value === "VEVENT") cur = {};
    else if (p.name === "END" && p.value === "VEVENT") { if (cur) out.push(cur); cur = null; }
    else if (cur) cur[p.name + (p.params.length ? ";" + p.params.join(";") : "")] = p.value;
  }
  return out;
}
/** Undo TEXT escaping (for round-trip checks). */
const unescape = (s: string) => s.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));

describe("escapeIcsText", () => {
  it("escapes backslash, semicolon, comma and newline (backslash first)", () => {
    expect(escapeIcsText("a\\b;c,d\ne")).toBe("a\\\\b\\;c\\,d\\ne");
    expect(escapeIcsText("\\n")).toBe("\\\\n"); // a literal backslash-n stays literal
  });
  it("turns every newline style into \\n", () => {
    expect(escapeIcsText("one\r\ntwo\rthree\nfour")).toBe("one\\ntwo\\nthree\\nfour");
  });
  it("drops control characters but keeps tabs and ordinary text", () => {
    expect(escapeIcsText("a\u0000b\u0007c\u001Fd\u007Fe\tf")).toBe("abcde\tf");
    expect(escapeIcsText("Café — 東京 🚀")).toBe("Café — 東京 🚀");
  });
  it("replaces lone surrogates (which can't be UTF-8) and keeps real pairs", () => {
    expect(escapeIcsText("x\uD83Dy")).toBe("x�y");
    expect(escapeIcsText("x\uDE80y")).toBe("x�y");
    expect(escapeIcsText("🚀")).toBe("🚀");
  });
  it("round-trips through unescaping", () => {
    const s = "Plan: ship, test; review\\merge\nthen rest";
    expect(unescape(escapeIcsText(s))).toBe(s);
  });
  it("copes with empty and non-string input", () => {
    expect(escapeIcsText("")).toBe("");
    expect(escapeIcsText(undefined as unknown as string)).toBe("");
  });
});

describe("foldIcsLine", () => {
  it("leaves a line of up to 75 octets alone", () => {
    const l = "X".repeat(75);
    expect(foldIcsLine(l)).toBe(l);
    expect(foldIcsLine("")).toBe("");
  });
  it("folds at 75 octets with CRLF + one space, each physical line ≤ 75 octets", () => {
    const l = "SUMMARY:" + "abcdefghij".repeat(30);
    const folded = foldIcsLine(l);
    const lines = folded.split("\r\n");
    expect(lines.length).toBeGreaterThan(1);
    expect(octets(lines[0])).toBe(75);
    for (const [i, x] of lines.entries()) {
      expect(octets(x)).toBeLessThanOrEqual(75);
      if (i > 0) expect(x.startsWith(" ")).toBe(true);
    }
    expect(folded.replace(/\r\n /g, "")).toBe(l);
  });
  it("never splits a multi-byte character (2, 3 and 4-byte UTF-8)", () => {
    for (const ch of ["é", "東", "🚀", "👩🏽‍💻"]) {
      const l = "DESCRIPTION:" + ch.repeat(60);
      const folded = foldIcsLine(l);
      for (const x of folded.split("\r\n")) {
        expect(octets(x)).toBeLessThanOrEqual(75);
        // a split character would decode to U+FFFD
        expect(new TextDecoder().decode(enc.encode(x))).toBe(x);
        expect(x).not.toMatch(/[\uD800-\uDBFF]$/); // no dangling high surrogate
      }
      expect(folded.replace(/\r\n /g, "")).toBe(l);
    }
  });
  it("fills a line exactly when a 3-byte character lands on the boundary", () => {
    // 73 ASCII + one 3-byte char = 76 octets → the char moves to the next line
    const l = "A".repeat(73) + "東";
    const [a, b] = foldIcsLine(l).split("\r\n");
    expect(a).toBe("A".repeat(73));
    expect(b).toBe(" 東");
  });
});

describe("dates", () => {
  it("icsUtc writes a basic-format UTC date-time", () => {
    expect(icsUtc(new Date("2026-10-04T09:00:00Z"))).toBe("20261004T090000Z");
    expect(icsUtc(new Date("2026-01-02T03:04:05.678Z"))).toBe("20260102T030405Z");
    expect(() => icsUtc(new Date("nope"))).toThrow(RangeError);
  });
  it("icsDate writes a basic-format date and refuses non-days", () => {
    expect(icsDate("2026-10-04")).toBe("20261004");
    expect(() => icsDate("2026-02-30")).toThrow(RangeError);
    expect(() => icsDate("04/10/2026")).toThrow(RangeError);
  });
  it("isIcsDay / addIcsDays do calendar arithmetic across months, years and leap days", () => {
    expect(isIcsDay("2028-02-29")).toBe(true);
    expect(isIcsDay("2026-02-29")).toBe(false);
    expect(isIcsDay(20261004)).toBe(false);
    expect(addIcsDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addIcsDays("2028-02-28", 1)).toBe("2028-02-29");
    expect(addIcsDays("2026-10-04", 14)).toBe("2026-10-18");
    expect(addIcsDays("2026-03-01", -1)).toBe("2026-02-28");
  });
  it("labels days and durations the en-GB way", () => {
    expect(feedDayLabel("2026-10-07")).toBe("Wed 7 Oct");
    expect(feedDayLabel("2027-01-01")).toBe("Fri 1 Jan");
    expect(feedDuration(45)).toBe("45m");
    expect(feedDuration(90)).toBe("1h 30m");
    expect(feedDuration(120)).toBe("2h");
  });
  it("feedStamp is midnight UTC on the day (stable all day)", () => {
    expect(feedStamp("2026-10-04").toISOString()).toBe("2026-10-04T00:00:00.000Z");
  });
});

describe("londonWallTimeToUtc (Europe/London, BST-aware)", () => {
  const at = (day: string, hh: number, mm = 0) => londonWallTimeToUtc(day, hh * 60 + mm).toISOString();
  it("winter is GMT, summer is BST", () => {
    expect(at("2026-01-15", 9)).toBe("2026-01-15T09:00:00.000Z");
    expect(at("2026-07-15", 9)).toBe("2026-07-15T08:00:00.000Z");
    expect(at("2026-10-04", 9, 30)).toBe("2026-10-04T08:30:00.000Z");
    expect(at("2026-12-01", 0)).toBe("2026-12-01T00:00:00.000Z");
  });
  it("spring change day (Sun 29 Mar 2026): before, the missing hour, after", () => {
    expect(at("2026-03-29", 0, 30)).toBe("2026-03-29T00:30:00.000Z");
    // 01:30 doesn't exist: it moves forward to 02:30 BST (= 01:30 UTC)
    expect(at("2026-03-29", 1, 30)).toBe("2026-03-29T01:30:00.000Z");
    expect(at("2026-03-29", 2, 0)).toBe("2026-03-29T01:00:00.000Z");
    expect(at("2026-03-29", 9)).toBe("2026-03-29T08:00:00.000Z");
  });
  it("autumn change day (Sun 25 Oct 2026): the repeated hour takes BST, then GMT", () => {
    expect(at("2026-10-25", 0, 30)).toBe("2026-10-24T23:30:00.000Z");
    expect(at("2026-10-25", 1, 30)).toBe("2026-10-25T00:30:00.000Z");
    expect(at("2026-10-25", 2, 0)).toBe("2026-10-25T02:00:00.000Z");
    expect(at("2026-10-25", 9)).toBe("2026-10-25T09:00:00.000Z");
  });
  it("finds the last Sunday in other years too (2027: 28 Mar and 31 Oct)", () => {
    expect(isBritishSummerTime(Date.parse("2027-03-28T00:59:59Z"))).toBe(false);
    expect(isBritishSummerTime(Date.parse("2027-03-28T01:00:00Z"))).toBe(true);
    expect(isBritishSummerTime(Date.parse("2027-10-31T00:59:59Z"))).toBe(true);
    expect(isBritishSummerTime(Date.parse("2027-10-31T01:00:00Z"))).toBe(false);
  });
  it("agrees with the platform's tz database for every day of 2026–2028", () => {
    const fmt = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
    const wall = (d: Date) => {
      const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
    };
    let day = "2026-01-01";
    let checked = 0;
    while (day < "2029-01-01") {
      for (const m of [0, 7 * 60 + 15, 9 * 60, 12 * 60 + 30, 17 * 60 + 45, 23 * 60 + 59]) {
        const got = londonWallTimeToUtc(day, m);
        expect(wall(got)).toBe(`${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
        checked++;
      }
      day = addIcsDays(day, 1);
    }
    expect(checked).toBeGreaterThan(6000);
  });
  it("refuses a malformed day or minutes", () => {
    expect(() => londonWallTimeToUtc("2026-13-01", 60)).toThrow(RangeError);
    expect(() => londonWallTimeToUtc("2026-10-04", NaN)).toThrow(RangeError);
  });
});

describe("buildIcs", () => {
  const now = new Date("2026-10-04T00:00:00Z");
  const timed: IcsEvent = {
    uid: "plan-1-20261004@kanbo.co.uk", summary: "Write brief · Launch", description: "Line one\nLine, two; three",
    url: "https://www.kanbo.co.uk/?task=1", start: new Date("2026-10-04T08:00:00Z"), end: new Date("2026-10-04T09:30:00Z"),
  };
  const allDay: IcsEvent = { uid: "due-1@kanbo.co.uk", summary: "Due: Write brief", allDay: { date: "2026-10-31" } };

  it("writes a VCALENDAR with the publishing headers, CRLF only", () => {
    const ics = buildIcs({ name: "Kanbo", description: "Your plan", events: [timed, allDay], now, timezone: "Europe/London" });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Kanbo//Calendar feed 1.0//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:PUBLISH\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/); // no bare LF
    expect(ics).not.toMatch(/\r(?!\n)/); // no bare CR
    const names = props(ics).map((p) => p.name);
    for (const n of ["X-WR-CALNAME", "X-WR-CALDESC", "X-WR-TIMEZONE", "REFRESH-INTERVAL", "X-PUBLISHED-TTL"]) expect(names).toContain(n);
    expect(unfold(ics)).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT15M");
    expect(unfold(ics)).toContain("X-PUBLISHED-TTL:PT15M");
    expect(names.filter((n) => n === "BEGIN")).toEqual(["BEGIN", "BEGIN", "BEGIN"]);
  });
  it("timed events: UTC start/end, busy, escaped text, the link", () => {
    const [e] = vevents(buildIcs({ name: "Kanbo", events: [timed], now }));
    expect(e.UID).toBe("plan-1-20261004@kanbo.co.uk");
    expect(e.DTSTAMP).toBe("20261004T000000Z");
    expect(e.DTSTART).toBe("20261004T080000Z");
    expect(e.DTEND).toBe("20261004T093000Z");
    expect(e.TRANSP).toBe("OPAQUE");
    expect(e.DESCRIPTION).toBe("Line one\\nLine\\, two\\; three");
    expect(unescape(e.SUMMARY)).toBe("Write brief · Launch");
    expect(e.URL).toBe("https://www.kanbo.co.uk/?task=1");
  });
  it("all-day events: VALUE=DATE, end is the next day (across a month), free", () => {
    const [e] = vevents(buildIcs({ name: "Kanbo", events: [allDay], now }));
    expect(e["DTSTART;VALUE=DATE"]).toBe("20261031");
    expect(e["DTEND;VALUE=DATE"]).toBe("20261101");
    expect(e.TRANSP).toBe("TRANSPARENT");
    const [y] = vevents(buildIcs({ name: "K", events: [{ uid: "u", summary: "s", allDay: { date: "2026-12-31" } }], now }));
    expect(y["DTEND;VALUE=DATE"]).toBe("20270101");
  });
  it("busy can be overridden either way", () => {
    const ev = vevents(buildIcs({ name: "K", now, events: [{ ...timed, busy: false }, { ...allDay, busy: true }] }));
    expect(ev.map((e) => e.TRANSP)).toEqual(["TRANSPARENT", "OPAQUE"]);
  });
  it("a missing or backwards end becomes 30 minutes", () => {
    const ev = vevents(buildIcs({ name: "K", now, events: [
      { uid: "a", summary: "a", start: new Date("2026-10-04T08:00:00Z") },
      { uid: "b", summary: "b", start: new Date("2026-10-04T08:00:00Z"), end: new Date("2026-10-04T07:00:00Z") },
    ] }));
    expect(ev.map((e) => e.DTEND)).toEqual(["20261004T083000Z", "20261004T083000Z"]);
  });
  it("leaves out events it can't write rather than breaking the file", () => {
    const ics = buildIcs({ name: "K", now, events: [
      { uid: "", summary: "no uid", start: new Date() },
      { uid: "x", summary: "no date" },
      { uid: "y", summary: "bad date", start: new Date("nope") },
      { uid: "z", summary: "bad day", allDay: { date: "2026-02-30" } },
      timed,
    ] });
    expect(vevents(ics).map((e) => e.UID)).toEqual([timed.uid]);
  });
  it("only writes http(s) URLs", () => {
    const ev = vevents(buildIcs({ name: "K", now, events: [
      { ...timed, uid: "a", url: "javascript:alert(1)" },
      { ...timed, uid: "b", url: "not a url" },
      { ...timed, uid: "c", url: "https://www.kanbo.co.uk/?task=a b" },
    ] }));
    expect(ev[0].URL).toBeUndefined();
    expect(ev[1].URL).toBeUndefined();
    expect(ev[2].URL).toBe("https://www.kanbo.co.uk/?task=a%20b");
  });
  it("folds long, multi-byte lines and every physical line is ≤ 75 octets", () => {
    const long = { ...timed, summary: "Réunion d’équipe 🚀 — " + "東京オフィスの計画 ".repeat(20), description: "Ünïcödé; ".repeat(40) };
    const ics = buildIcs({ name: "Kanbo", events: [long], now });
    for (const line of ics.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
    const [e] = vevents(ics);
    expect(unescape(e.SUMMARY)).toBe(long.summary);
    expect(unescape(e.DESCRIPTION)).toBe(long.description);
  });
  it("cannot be broken out of: a newline in a title stays inside SUMMARY", () => {
    const evil = { ...timed, summary: "Hi\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:pwned" };
    const ics = buildIcs({ name: "Kanbo\nX-EVIL:1", events: [evil], now });
    expect(vevents(ics)).toHaveLength(1);
    expect(props(ics).some((p) => p.name === "X-EVIL")).toBe(false);
    expect(unfold(ics).filter((l) => l.startsWith("UID:"))).toEqual(["UID:plan-1-20261004@kanbo.co.uk"]);
  });
  it("honours refreshMinutes and defaults DTSTAMP to now", () => {
    const ics = buildIcs({ name: "K", events: [timed], refreshMinutes: 60 });
    expect(unfold(ics)).toContain("REFRESH-INTERVAL;VALUE=DURATION:PT60M");
    expect(vevents(ics)[0].DTSTAMP).toMatch(/^\d{8}T\d{6}Z$/);
  });
  it("an empty calendar is still valid", () => {
    const ics = buildIcs({ name: "Kanbo", events: [], now });
    expect(vevents(ics)).toEqual([]);
    expect(unfold(ics)[0]).toBe("BEGIN:VCALENDAR");
  });
});

describe("feedEvents", () => {
  const ME = "11111111-1111-4111-8111-111111111111";
  const YOU = "22222222-2222-4222-8222-222222222222";
  const P1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const today = "2026-10-04";
  const task = (over: Partial<FeedTaskRow> & { id: string }): FeedTaskRow => ({
    title: "Task " + over.id, status: "todo", project_id: P1, workspace_id: "ws-1", assignee_id: ME, collaborators: [],
    due_date: null, due_time: null, archived_at: null, scheduled: null, plan_today: false, dur: null, focus_min: 30, ...over,
  });
  const base = (over: Partial<FeedInput> = {}): FeedInput => ({
    userId: ME, tasks: [], states: [], projectNames: { [P1]: "Launch" }, today, days: 14, includeDue: true,
    appUrl: "https://www.kanbo.co.uk/", ...over,
  });
  const st = (task_id: string, plan_day: string, scheduled: number | null = 600, plan_today: boolean | null = true): FeedStateRow =>
    ({ task_id, plan_day, scheduled, plan_today });

  it("my own plan on a task assigned to me: today's busy block, titled Task · Project, with a link", () => {
    const ev = feedEvents(base({ tasks: [task({ id: "t1", title: "Write brief", plan_today: true, scheduled: 9 * 60, dur: 90 })] }));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({
      uid: "plan-t1-20261004@kanbo.co.uk", summary: "Write brief · Launch", busy: true, url: "https://www.kanbo.co.uk/?task=t1",
    });
    expect(ev[0].start!.toISOString()).toBe("2026-10-04T08:00:00.000Z"); // 09:00 BST
    expect(ev[0].end!.toISOString()).toBe("2026-10-04T09:30:00.000Z");
    expect(ev[0].description).toContain("Planned in Kanbo · 1h 30m");
    expect(ev[0].description).toContain("Open in Kanbo: https://www.kanbo.co.uk/?task=t1");
  });
  it("needs both 'on today' and a slot", () => {
    const ev = feedEvents(base({ tasks: [
      task({ id: "a", plan_today: true, scheduled: null }),
      task({ id: "b", plan_today: false, scheduled: 600 }),
      task({ id: "c", plan_today: true, scheduled: -5 }),
      task({ id: "d", plan_today: true, scheduled: 1440 }),
    ] }));
    expect(ev).toEqual([]);
  });
  it("block length: dur, else focus_min, else 30 minutes", () => {
    const ev = feedEvents(base({ includeDue: false, tasks: [
      task({ id: "a", plan_today: true, scheduled: 600, dur: 45 }),
      task({ id: "b", plan_today: true, scheduled: 660, dur: null, focus_min: 25 }),
      task({ id: "c", plan_today: true, scheduled: 720, dur: 0, focus_min: 0 }),
    ] }));
    expect(ev.map((e) => (e.end!.getTime() - e.start!.getTime()) / 60000)).toEqual([45, 25, 30]);
  });
  it("never includes done or archived tasks", () => {
    const ev = feedEvents(base({ tasks: [
      task({ id: "a", status: "done", plan_today: true, scheduled: 600, due_date: today }),
      task({ id: "b", archived_at: "2026-10-01T00:00:00Z", plan_today: true, scheduled: 600, due_date: today }),
    ], states: [st("a", today), st("b", "2026-10-05")] }));
    expect(ev).toEqual([]);
  });
  it("never includes tasks in an archived project (the app hides them everywhere)", () => {
    const P2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const tasks = [
      task({ id: "gone", project_id: P2, plan_today: true, scheduled: 600, due_date: today }),
      task({ id: "gone2", project_id: P2, assignee_id: YOU }),
      task({ id: "kept", plan_today: true, scheduled: 660, due_date: "2026-10-05" }),
      task({ id: "loose", project_id: null, workspace_id: null, assignee_id: null, due_date: "2026-10-06" }),
    ];
    const states = [st("gone", "2026-10-05"), st("gone2", "2026-10-06", 14 * 60), st("kept", "2026-10-07")];
    const all = feedEvents(base({ tasks, states }));
    expect(all.map((e) => e.uid)).toEqual(expect.arrayContaining(["plan-gone-20261004@kanbo.co.uk", "due-gone@kanbo.co.uk", "plan-gone2-20261006@kanbo.co.uk"]));
    for (const archivedProjects of [new Set([P2]), [P2]]) {
      const ev = feedEvents(base({ tasks, states, archivedProjects }));
      expect(ev.map((e) => e.uid).sort()).toEqual([
        "due-kept@kanbo.co.uk", "due-loose@kanbo.co.uk", "plan-kept-20261004@kanbo.co.uk", "plan-kept-20261007@kanbo.co.uk",
      ]);
    }
  });
  it("a teammate's task: never their plan, only mine (task_user_state), on the day it's for", () => {
    const theirs = task({ id: "t2", assignee_id: YOU, plan_today: true, scheduled: 600, collaborators: [ME] });
    expect(feedEvents(base({ includeDue: false, tasks: [theirs] }))).toEqual([]);
    const ev = feedEvents(base({ includeDue: false, tasks: [theirs], states: [st("t2", "2026-10-06", 14 * 60)] }));
    expect(ev).toHaveLength(1);
    expect(ev[0].uid).toBe("plan-t2-20261006@kanbo.co.uk");
    expect(ev[0].start!.toISOString()).toBe("2026-10-06T13:00:00.000Z");
  });
  it("unassigned tasks follow my own plan rows too", () => {
    const t = task({ id: "u", assignee_id: null, workspace_id: null, plan_today: true, scheduled: 600 });
    expect(feedEvents(base({ includeDue: false, tasks: [t] }))).toEqual([]);
    expect(feedEvents(base({ includeDue: false, tasks: [t], states: [st("u", today, 600)] }))).toHaveLength(1);
  });
  it("on my own task the row is today's plan; my plan rows add later days but don't override today", () => {
    const mine = task({ id: "m", plan_today: true, scheduled: 9 * 60 });
    const ev = feedEvents(base({ includeDue: false, tasks: [mine], states: [st("m", today, 15 * 60), st("m", "2026-10-07", 10 * 60)] }));
    expect(ev.map((e) => [e.uid, e.start!.toISOString()])).toEqual([
      ["plan-m-20261004@kanbo.co.uk", "2026-10-04T08:00:00.000Z"],
      ["plan-m-20261007@kanbo.co.uk", "2026-10-07T09:00:00.000Z"],
    ]);
  });
  it("plan rows outside today … today + 14, or not on the plan, are left out", () => {
    const t = task({ id: "x", assignee_id: YOU });
    const ev = feedEvents(base({ includeDue: false, tasks: [t], states: [
      st("x", "2026-10-03"), st("x", "2026-10-18", 600), st("x", "2026-10-19"), st("x", "2026-10-05", 600, false),
      st("x", "2026-10-06", null), { task_id: "x", plan_day: null, scheduled: 600, plan_today: true },
    ] }));
    expect(ev.map((e) => e.uid)).toEqual(["plan-x-20261018@kanbo.co.uk"]);
  });
  it("plan rows for tasks I can't see (not in the list) are ignored", () => {
    expect(feedEvents(base({ states: [st("gone", today)] }))).toEqual([]);
  });
  it("converts slots on clock-change days", () => {
    const t = task({ id: "c", assignee_id: YOU });
    const ev = feedEvents(base({ today: "2026-10-20", includeDue: false, tasks: [t], states: [st("c", "2026-10-26", 9 * 60), st("c", "2026-10-24", 9 * 60)] }));
    expect(ev.map((e) => e.start!.toISOString())).toEqual(["2026-10-24T08:00:00.000Z", "2026-10-26T09:00:00.000Z"]);
  });
  it("due dates: all-day and free, for my tasks, tasks I collaborate on, and my unassigned personal tasks", () => {
    const ev = feedEvents(base({ tasks: [
      task({ id: "mine", due_date: "2026-10-05" }),
      task({ id: "collab", assignee_id: YOU, collaborators: [ME], due_date: "2026-10-06" }),
      task({ id: "personal", assignee_id: null, workspace_id: null, due_date: "2026-10-07" }),
      task({ id: "theirs", assignee_id: YOU, due_date: "2026-10-06" }),
      task({ id: "teamUnassigned", assignee_id: null, workspace_id: "ws-1", due_date: "2026-10-06" }),
    ] }));
    expect(ev.map((e) => e.uid)).toEqual(["due-mine@kanbo.co.uk", "due-collab@kanbo.co.uk", "due-personal@kanbo.co.uk"]);
    expect(ev[0]).toMatchObject({ allDay: { date: "2026-10-05" }, busy: false, summary: "Due: Task mine · Launch", url: "https://www.kanbo.co.uk/?task=mine" });
    expect(ev[0].description).toContain("Due Mon 5 Oct");
    expect(ev[0].description).toContain("Status: To do");
  });
  it("due window is today … today + 14 (no overdue, nothing further out)", () => {
    const ev = feedEvents(base({ tasks: [
      task({ id: "past", due_date: "2026-10-03" }), task({ id: "today", due_date: today }),
      task({ id: "edge", due_date: "2026-10-18" }), task({ id: "far", due_date: "2026-10-19" }),
    ] }));
    expect(ev.map((e) => e.uid)).toEqual(["due-today@kanbo.co.uk", "due-edge@kanbo.co.uk"]);
    expect(ev[0].description).toContain("Due today");
  });
  it("a due time shows in the title and description", () => {
    const [e] = feedEvents(base({ tasks: [task({ id: "t", title: "Send invoice", due_date: "2026-10-06", due_time: "15:00" })] }));
    expect(e.summary).toBe("Due 15:00: Send invoice · Launch");
    expect(e.description).toContain("Due Tue 6 Oct at 15:00");
    const [f] = feedEvents(base({ tasks: [task({ id: "t", due_date: "2026-10-06", due_time: "nonsense" })] }));
    expect(f.summary).toBe("Due: Task t · Launch");
  });
  it("includeDue off: no due events", () => {
    expect(feedEvents(base({ includeDue: false, tasks: [task({ id: "a", due_date: today })] }))).toEqual([]);
  });
  it("titles: no project name → just the task; blank title → Untitled task; very long titles are trimmed", () => {
    const ev = feedEvents(base({ includeDue: false, tasks: [
      task({ id: "a", project_id: "unknown", plan_today: true, scheduled: 600 }),
      task({ id: "b", title: "   ", project_id: null, plan_today: true, scheduled: 660 }),
      task({ id: "c", title: "x".repeat(500), plan_today: true, scheduled: 720 }),
    ] }));
    expect(ev[0].summary).toBe("Task a");
    expect(ev[1].summary).toBe("Untitled task");
    expect(Array.from(ev[2].summary).length).toBeLessThanOrEqual(200 + " · Launch".length);
    expect(ev[2].summary.endsWith("… · Launch")).toBe(true);
  });
  it("UIDs are stable across builds and the order is deterministic", () => {
    const input = base({ tasks: [
      task({ id: "b", plan_today: true, scheduled: 600, due_date: "2026-10-05" }),
      task({ id: "a", plan_today: true, scheduled: 600, due_date: "2026-10-05" }),
    ] });
    const one = feedEvents(input), two = feedEvents({ ...input, tasks: [...input.tasks].reverse() });
    expect(one).toEqual(two);
    expect(one.map((e) => e.uid)).toEqual(["plan-a-20261004@kanbo.co.uk", "plan-b-20261004@kanbo.co.uk", "due-a@kanbo.co.uk", "due-b@kanbo.co.uk"]);
  });
  it("links escape the task id and drop a trailing slash on the app URL", () => {
    const [e] = feedEvents(base({ appUrl: "https://app.example///", tasks: [task({ id: "a b", plan_today: true, scheduled: 600 })] }));
    expect(e.url).toBe("https://app.example/?task=a%20b");
  });
  it("caps a runaway feed", () => {
    const tasks = Array.from({ length: FEED_MAX_EVENTS + 50 }, (_, i) => task({ id: `t${i}`, due_date: today }));
    expect(feedEvents(base({ tasks }))).toHaveLength(FEED_MAX_EVENTS);
  });
  it("a bad 'today' or no user gives nothing rather than throwing", () => {
    expect(feedEvents(base({ today: "soon" }))).toEqual([]);
    expect(feedEvents(base({ userId: "" }))).toEqual([]);
  });
  it("end to end: the events build into a valid calendar", () => {
    const ev = feedEvents(base({ tasks: [
      task({ id: "a", title: "Plan, review; ship", plan_today: true, scheduled: 600, due_date: "2026-10-05" }),
    ] }));
    const ics = buildIcs({ name: "Kanbo", events: ev, now: feedStamp(today) });
    const parsed = vevents(ics);
    expect(parsed.map((e) => e.UID)).toEqual(["plan-a-20261004@kanbo.co.uk", "due-a@kanbo.co.uk"]);
    expect(unescape(parsed[0].SUMMARY)).toBe("Plan, review; ship · Launch");
    for (const line of ics.split("\r\n")) expect(octets(line)).toBeLessThanOrEqual(75);
  });
});
