// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  clampWindow, cleanIdentity, dedupeEvents, distinctColours, eventId, fetchTargets, idTokenIdentity, isUuid, mapLimit, missingSelectionColumn,
  normaliseGoogleCalendars, normaliseMicrosoftCalendars, paintCalendars, PALETTE, parseSelected, primarySelection, safeColour,
  sameEmail, selectionFrom, TimeoutError, unsavedPrimaryColours, validateSelection, withTimeout, MAX_SELECTED,
} from "./calendars";

afterEach(() => { vi.useRealTimers(); });

describe("safeColour", () => {
  it("takes #rgb and #rrggbb, lower-cased; refuses anything that could reach CSS as more than a colour", () => {
    expect(safeColour("#ABC")).toBe("#aabbcc");
    expect(safeColour(" #9FE1E7 ")).toBe("#9fe1e7");
    for (const bad of ["red", "rgb(1,2,3)", "url(https://evil.example/x.png)", "#12345", "#1234567", "", null, 42, "#abc;background:red"]) {
      expect(safeColour(bad)).toBeNull();
    }
  });
});

describe("normaliseGoogleCalendars", () => {
  it("reads calendarList items: primary first, override names, colours, roles; skips deleted ones", () => {
    const list = normaliseGoogleCalendars([
      { id: "team@group.calendar.google.com", summary: "Launch team", backgroundColor: "#7AE7BF", accessRole: "writer" },
      { id: "ada@work.example", summary: "ada@work.example", summaryOverride: "Work", backgroundColor: "#9fe1e7", primary: true, accessRole: "owner" },
      { id: "gone@group.calendar.google.com", summary: "Old", deleted: true },
      { id: "en.uk#holiday@group.v.calendar.google.com", summary: "Holidays in the United Kingdom", backgroundColor: "javascript:alert(1)", accessRole: "reader" },
      { summary: "no id" },
    ]);
    expect(list.map((c) => c.name)).toEqual(["Work", "Holidays in the United Kingdom", "Launch team"]);
    expect(list[0]).toEqual({ id: "ada@work.example", name: "Work", color: "#9fe1e7", primary: true, accessRole: "owner" });
    expect(list[1].color).toBe("");          // an unsafe colour is dropped (a palette one is given later)
    expect(list[2].accessRole).toBe("writer");
  });
  it("tolerates a missing or odd list", () => {
    expect(normaliseGoogleCalendars(undefined)).toEqual([]);
    expect(normaliseGoogleCalendars({ items: [] })).toEqual([]);
  });
});

describe("normaliseMicrosoftCalendars", () => {
  it("uses hexColor, else Outlook's named colour; the default calendar is primary; others' calendars are read-only", () => {
    const list = normaliseMicrosoftCalendars([
      { id: "AAMk-family=", name: "Family", color: "lightPink", hexColor: "", isDefaultCalendar: false, canEdit: true, owner: { address: "ADA@outlook.example" } },
      { id: "AAMk-default=", name: "Calendar", color: "auto", hexColor: "#E8A33D", isDefaultCalendar: true, canEdit: true, owner: { address: "ada@outlook.example" } },
      { id: "AAMk-shared=", name: "Sam's calendar", color: "lightTeal", isDefaultCalendar: false, canEdit: false, owner: { address: "sam@outlook.example" } },
      { id: "AAMk-auto=", name: "", color: "auto" },
    ], "ada@outlook.example");
    expect(list.map((c) => [c.name, c.color, c.primary, c.accessRole])).toEqual([
      ["Calendar", "#e8a33d", true, "owner"],
      ["Calendar", "", false, "owner"],
      ["Family", "#d45a93", false, "owner"],
      ["Sam's calendar", "#2a9fa6", false, "reader"],
    ]);
  });
});

describe("distinctColours", () => {
  it("keeps a calendar's own colour unless it's missing or already used, then hands out free palette colours", () => {
    const out = distinctColours([{ color: "#3f7fe0" }, { color: "#3F7FE0" }, { color: "" }, { color: "#e0663a" }], ["#2e9d6a"]);
    expect(out.map((c) => c.color)).toEqual(["#3f7fe0", "#e0663a", "#a35bc4", "#c98a1b"]);
    expect(new Set(out.map((c) => c.color)).size).toBe(4);
  });
  it("never crashes when the palette runs out", () => {
    const out = distinctColours(Array.from({ length: 14 }, () => ({ color: "" })));
    expect(out).toHaveLength(14);
    expect(out.slice(0, PALETTE.length).map((c) => c.color)).toEqual(PALETTE);
  });
});

describe("parseSelected", () => {
  it("null stays null (primary only); bad entries are dropped; duplicates once; at most 25", () => {
    expect(parseSelected(null)).toBeNull();
    expect(parseSelected(undefined)).toBeNull();
    expect(parseSelected("not json")).toBeNull();
    expect(parseSelected({ id: "x" })).toBeNull();
    expect(parseSelected([])).toEqual([]);
    expect(parseSelected([{ id: "a", name: "A", color: "#ABC", primary: true }, { id: "a" }, { name: "no id" }, 5, { id: "b", color: "url(x)" }]))
      .toEqual([{ id: "a", name: "A", color: "#aabbcc", primary: true }, { id: "b", name: "b", color: "", primary: false }]);
    expect(parseSelected(Array.from({ length: 30 }, (_, i) => ({ id: `c${i}` })))).toHaveLength(MAX_SELECTED);
    expect(parseSelected(JSON.stringify([{ id: "z" }]))).toEqual([{ id: "z", name: "z", color: "", primary: false }]);
  });
});

const ACCOUNT = normaliseGoogleCalendars([
  { id: "ada@work.example", summary: "Work", backgroundColor: "#3f7fe0", primary: true, accessRole: "owner" },
  { id: "team@g", summary: "Launch team", backgroundColor: "#3f7fe0", accessRole: "writer" },
  { id: "hol@g", summary: "Holidays", accessRole: "reader" },
]);

describe("paintCalendars / selectionFrom", () => {
  it("chosen calendars keep their saved colour; the rest get colours nobody else uses", () => {
    const painted = paintCalendars(ACCOUNT, [{ id: "team@g", name: "Launch team", color: "#2e9d6a", primary: false }], ["#3f7fe0"]);
    const by = Object.fromEntries(painted.map((c) => [c.id, c.color]));
    expect(by["team@g"]).toBe("#2e9d6a");                      // saved
    expect(by["ada@work.example"]).not.toBe("#3f7fe0");        // another account already shows blue
    expect(new Set(Object.values(by)).size).toBe(3);
    // (in the account's own order: primary first, then by name)
    expect(selectionFrom(["team@g", "hol@g"], painted)).toEqual([
      { id: "hol@g", name: "Holidays", color: by["hol@g"], primary: false },
      { id: "team@g", name: "Launch team", color: "#2e9d6a", primary: false },
    ]);
  });
  it("with nothing chosen yet, two calendars with the same provider colour still differ", () => {
    const painted = paintCalendars(ACCOUNT, null);
    expect(painted[0].color).toBe("#3f7fe0");
    expect(new Set(painted.map((c) => c.color)).size).toBe(3);
  });
});

describe("validateSelection", () => {
  it("accepts ids from the account's own list (deduplicated), and an empty choice", () => {
    expect(validateSelection(["team@g", "ada@work.example", "team@g"], ACCOUNT)).toEqual({ ok: true, ids: ["team@g", "ada@work.example"] });
    expect(validateSelection([], ACCOUNT)).toEqual({ ok: true, ids: [] });
  });
  it("refuses unknown ids, non-strings, non-lists and more than 25", () => {
    expect(validateSelection(["someone-else@g"], ACCOUNT)).toMatchObject({ ok: false, error: expect.stringMatching(/isn't in this account/) });
    expect(validateSelection([42], ACCOUNT).ok).toBe(false);
    expect(validateSelection([""], ACCOUNT).ok).toBe(false);
    expect(validateSelection(["x".repeat(1025)], ACCOUNT).ok).toBe(false);
    expect(validateSelection("team@g", ACCOUNT).ok).toBe(false);
    const many = Array.from({ length: 26 }, (_, i) => ({ id: `c${i}`, name: `C${i}`, color: "", primary: false, accessRole: "reader" }));
    expect(validateSelection(many.map((c) => c.id), many)).toMatchObject({ ok: false, error: "Choose up to 25 calendars per account." });
    expect(validateSelection(many.slice(0, 25).map((c) => c.id), many).ok).toBe(true);
  });
});

describe("fetchTargets", () => {
  it("NULL reads just the primary, in the fallback name and colour; a choice reads each chosen calendar", () => {
    expect(fetchTargets(null, { name: "ada@work.example", color: "#3f7fe0" })).toEqual([{ id: "primary", name: "ada@work.example", color: "#3f7fe0", primary: true }]);
    expect(fetchTargets([], { name: "x", color: "#3f7fe0" })).toEqual([]);
    expect(fetchTargets([{ id: "a", name: "A", color: "", primary: false }], { name: "x", color: "#2e9d6a" })).toEqual([{ id: "a", name: "A", color: "#2e9d6a", primary: false }]);
  });
});

describe("event ids and de-duplication", () => {
  it("ids differ by account and calendar for the same provider event", () => {
    const a = eventId("google", "11111111-aaaa", "work@g", "evt1");
    const b = eventId("google", "11111111-aaaa", "team@g", "evt1");
    const c = eventId("google", "22222222-bbbb", "work@g", "evt1");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a.startsWith("g-11111111-")).toBe(true);
    expect(eventId("microsoft", "33333333", "primary", "x").startsWith("m-33333333-")).toBe(true);
  });
  it("the same meeting (iCal UID + start) in two calendars shows once; recurring instances and UID-less events stay", () => {
    const evs = [
      { id: "1", uid: "standup@x", start: "2026-10-05T08:00:00Z" },
      { id: "2", uid: "standup@x", start: "2026-10-05T08:00:00.000Z" },
      { id: "3", uid: "standup@x", start: "2026-10-06T08:00:00Z" },
      { id: "4", uid: null, start: "2026-10-05T08:00:00Z" },
      { id: "5", start: "2026-10-05T08:00:00Z" },
    ];
    expect(dedupeEvents(evs).map((e) => e.id)).toEqual(["1", "3", "4", "5"]);
  });
});

describe("withTimeout / mapLimit", () => {
  it("aborts a call that takes too long", async () => {
    vi.useFakeTimers();
    let aborted = false;
    const p = withTimeout((signal) => new Promise((_, reject) => { signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }); }), 50);
    const check = expect(p).rejects.toBeInstanceOf(TimeoutError);
    await vi.advanceTimersByTimeAsync(60);
    await check;
    expect(aborted).toBe(true);
  });
  it("passes a quick result through", async () => {
    await expect(withTimeout(async () => 7, 1000)).resolves.toBe(7);
  });
  it("runs at most `limit` at once, keeps order, and one failure doesn't stop the rest", async () => {
    let running = 0, peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 2));
      running--;
      if (n === 4) throw new Error("four");
      return n * 10;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(out.map((r) => (r.status === "fulfilled" ? r.value : "x"))).toEqual([10, 20, 30, "x", 50, 60, 70]);
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe("small helpers", () => {
  it("clampWindow: valid, ordered, at most 100 days", () => {
    const now = Date.parse("2026-10-05T00:00:00Z");
    expect(clampWindow(null, null, now)).toEqual({ start: "2026-10-05T00:00:00.000Z", end: "2026-11-05T00:00:00.000Z" });
    expect(clampWindow("2026-10-01T00:00:00Z", "2026-09-01T00:00:00Z", now).end).toBe("2026-11-01T00:00:00.000Z");
    expect(clampWindow("2026-10-01T00:00:00Z", "2027-10-01T00:00:00Z", now).end).toBe("2027-01-09T00:00:00.000Z");
    expect(clampWindow("garbage", "2026-10-02T00:00:00Z", now).start).toBe("2026-10-05T00:00:00.000Z");
  });
  it("sameEmail / isUuid / missingSelectionColumn", () => {
    expect(sameEmail(" Ada@Work.example", "ada@work.EXAMPLE ")).toBe(true);
    // not knowing who an account is never matches anything, not even another unknown
    expect(sameEmail("", null)).toBe(false);
    expect(sameEmail("", "")).toBe(false);
    expect(sameEmail("  ", "")).toBe(false);
    expect(sameEmail("ada@work.example", "")).toBe(false);
    expect(isUuid("aaaaaaaa-0000-4000-8000-000000000001")).toBe(true);
    expect(isUuid("google")).toBe(false);
    expect(isUuid("aaaaaaaa-0000-4000-8000-000000000001' or 1=1")).toBe(false);
    expect(missingSelectionColumn({ code: "42703", message: "column calendar_connections.selected_calendars does not exist" })).toBe(true);
    expect(missingSelectionColumn({ code: "PGRST204", message: "Could not find the 'selected_calendars' column" })).toBe(true);
    expect(missingSelectionColumn({ code: "23505", message: "duplicate key" })).toBe(false);
    expect(missingSelectionColumn(null)).toBe(false);
  });
});

describe("which account: idTokenIdentity", () => {
  const b64url = (v: string) => Buffer.from(v).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const jwt = (claims: unknown) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

  it("reads the email claim, and Microsoft's preferred_username, trimmed", () => {
    expect(idTokenIdentity(jwt({ sub: "1", email: " Ada@Work.example " }))).toEqual({ email: "Ada@Work.example", username: "" });
    expect(idTokenIdentity(jwt({ sub: "1", preferred_username: "ada@contoso.example" }))).toEqual({ email: "", username: "ada@contoso.example" });
    // base64url payloads that need padding, and non-ASCII names, decode
    expect(idTokenIdentity(jwt({ email: "zoë@exämple.co.uk", name: "Zoë Ångström ✓" })).email).toBe("zoë@exämple.co.uk");
  });

  it("is empty for anything missing or malformed, never a throw", () => {
    const none = { email: "", username: "" };
    for (const bad of [undefined, null, 42, "", "abc", "a.b.c", "a..c", `${b64url("{}")}.${b64url("[1,2]")}.s`, `x.${b64url("null")}.s`,
      jwt({ email: 7, preferred_username: { x: 1 } }), `x.${"A".repeat(20_000)}.s`]) {
      expect(idTokenIdentity(bad)).toEqual(none);
    }
  });

  it("cleanIdentity: strings only, trimmed, capped", () => {
    expect(cleanIdentity("  a@b.example ")).toBe("a@b.example");
    expect(cleanIdentity(null)).toBe("");
    expect(cleanIdentity(["a@b"])).toBe("");
    expect(cleanIdentity("x".repeat(400))).toHaveLength(320);
  });
});

describe("an account still on \"primary only\": one colour everywhere", () => {
  const LIST = normaliseGoogleCalendars([
    { id: "me@gmail.example", summary: "me@gmail.example", backgroundColor: "#9fc6e7", primary: true },
    { id: "club", summary: "Running club", backgroundColor: "#9fc6e7" },
  ]);

  it("primarySelection saves the primary in exactly the colour the list shows it in", () => {
    // its own colour when nothing else uses it (not one of Kanbo's palette)
    expect(primarySelection(LIST)).toEqual([{ id: "me@gmail.example", name: "me@gmail.example", color: "#9fc6e7", primary: true }]);
    expect(primarySelection(LIST)![0].color).toBe(paintCalendars(LIST, null)[0].color);
    // another account already shows that colour: the first free one, as paintCalendars would
    const taken = ["#9fc6e7", PALETTE[0]];
    expect(primarySelection(LIST, taken)![0].color).toBe(paintCalendars(LIST, null, taken)[0].color);
    expect(primarySelection(LIST, taken)![0].color).toBe(PALETTE[1]);
    // nothing marked primary: nothing to save
    expect(primarySelection(LIST.map((c) => ({ ...c, primary: false })))).toBeNull();
  });

  it("unsavedPrimaryColours: oldest first, never a saved colour or each other's", () => {
    const rows = [
      { id: "a", selected_calendars: null },
      { id: "b", selected_calendars: [{ id: "x", name: "X", color: PALETTE[0], primary: true }] },
      { id: "c" }, // before 0045: no column at all
      { id: "d", selected_calendars: [] },
    ];
    const got = unsavedPrimaryColours(rows);
    expect([...got.keys()]).toEqual(["a", "c"]);
    expect(got.get("a")).toBe(PALETTE[1]);
    expect(got.get("c")).toBe(PALETTE[2]);
    // the same rows always give the same colours (events and the calendar list agree)
    expect(unsavedPrimaryColours(rows)).toEqual(got);
  });
});
