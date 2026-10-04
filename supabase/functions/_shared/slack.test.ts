// @vitest-environment node
/* Slack messages (pure): the webhook rule, escaping, Block Kit limits, Slack's
   replies, London time and the daily stand-up text. */
import { describe, it, expect } from "vitest";
import {
  addDaysIso, buildSlackMessage, buildStandupText, classifySlackResponse, clip, escapeMrkdwn, fmtDay,
  isSlackWebhookUrl, isStandupDue, isWeekday, lastWorkdayIso, oneLine, parseHhMm, safeErrorNote, safeLinkUrl, slackLink,
  SLACK_LIMITS, SLACK_WEBHOOK_RE, splitSections, tidyText, zonedNow, type SlackBlock, type StandupTaskRow,
} from "./slack.ts";
import { SLACK_WEBHOOK_RE as APP_RE, isSlackWebhookUrl as appIsSlack } from "../../../src/lib/slack";

const HOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";
const texts = (blocks: SlackBlock[]) => blocks.map((b) =>
  b.type === "header" || b.type === "section" ? b.text.text : b.type === "context" ? b.elements.map((e) => e.text).join(" ") : "---");

describe("webhook rule", () => {
  it("is the app's rule too (one copy)", () => {
    expect(APP_RE).toBe(SLACK_WEBHOOK_RE);
    expect(appIsSlack(HOOK)).toBe(true);
  });
  it("accepts hooks.slack.com/services URLs only", () => {
    expect(isSlackWebhookUrl(HOOK)).toBe(true);
    expect(isSlackWebhookUrl(`  ${HOOK}  `)).toBe(true);
    for (const bad of [
      "http://hooks.slack.com/services/T/B/x", "https://hooks.slack.com.evil.io/services/T/B/x",
      "https://hooks.slack.com/services/T/B/x?x=1", "https://hooks.slack.com/services/T/B/x#y",
      "https://user@hooks.slack.com/services/T/B/x", "https://hooks.slack.com:444/services/T/B/x",
      "https://hooks.slack.com/services/T/B/x\nhttps://evil.io", "https://hooks.slack.com/services/" + "a".repeat(500),
      "", null, undefined, 42,
    ]) expect(isSlackWebhookUrl(bad)).toBe(false);
  });
});

describe("text helpers", () => {
  it("escapes the three mrkdwn control characters", () => {
    expect(escapeMrkdwn("<!channel> & <@U123> <https://evil.io|click>")).toBe("&lt;!channel&gt; &amp; &lt;@U123&gt; &lt;https://evil.io|click&gt;");
    expect(escapeMrkdwn("*bold* _it_ ~s~ `c`")).toBe("*bold* _it_ ~s~ `c`");
  });
  it("clips without splitting an emoji", () => {
    expect(clip("abcdef", 4)).toBe("abc…");
    expect(clip("abc", 3)).toBe("abc");
    const s = "ab😀cd";
    expect(clip(s, 4)).toBe("ab…");       // the emoji's two halves stay together
    expect(oneLine("  a\n\tb  c ", 10)).toBe("a b c");
  });
  it("tidies typed text", () => {
    expect(tidyText("a\r\nb  \n\n\n\nc\u0007")).toEqual({ text: "a\nb\n\nc", cut: false });
    const long = tidyText("x".repeat(20), 10);
    expect(long.cut).toBe(true);
    expect(long.text.length).toBe(10);
  });
  it("links only http(s) URLs and can't be broken out of", () => {
    expect(safeLinkUrl("javascript:alert(1)")).toBeNull();
    expect(safeLinkUrl("https://a.b/p?x=1&y=2|z>")).toBe("https://a.b/p?x=1&amp;y=2%7Cz%3E");
    expect(slackLink("https://www.kanbo.co.uk/p/1", "Open <it> | now")).toBe("<https://www.kanbo.co.uk/p/1|Open &lt;it&gt; / now>");
    expect(slackLink(null, "Open")).toBe("Open");
  });
  it("formats days", () => {
    expect(fmtDay("2026-10-05")).toBe("Mon 5 Oct");
    expect(fmtDay("nope")).toBe("nope");
  });
});

describe("splitSections", () => {
  it("packs lines up to the section limit, never over", () => {
    const text = Array.from({ length: 300 }, (_, i) => `• line ${i} ${"word ".repeat(10)}`).join("\n");
    const parts = splitSections(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(SLACK_LIMITS.section);
    expect(parts.join("\n").replace(/\s+/g, " ").trim()).toBe(text.replace(/\s+/g, " ").trim());
  });
  it("splits a very long line at a space and never inside an entity", () => {
    const text = ("a & b ".repeat(800)).trim();
    const parts = splitSections(text, 100);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(100);
      expect(p).not.toMatch(/&(?!amp;)/);   // every & is a whole &amp;
    }
  });
  it("gives nothing for empty text", () => {
    expect(splitSections("")).toEqual([]);
    expect(splitSections("\n\n  \n")).toEqual([]);
  });
});

describe("buildSlackMessage", () => {
  it("a stand-up: Pulse's bold first line becomes the header; words escaped; link back", () => {
    const m = buildSlackMessage({
      kind: "standup", workspaceName: "Acme", actorName: "Maya Patel", url: "https://www.kanbo.co.uk/team/pulse",
      text: "*Pulse — Mon 5 Oct*\nSince Friday the team finished 3 tasks.\n\n• *Maya* — done: <script> & co",
    });
    expect(m.blocks[0]).toEqual({ type: "header", text: { type: "plain_text", text: "Pulse — Mon 5 Oct", emoji: true } });
    const t = texts(m.blocks);
    expect(t[1]).toContain("Since Friday the team finished 3 tasks.");
    expect(t[1]).toContain("• *Maya* — done: &lt;script&gt; &amp; co");
    expect(t[t.length - 1]).toBe("Posted from Kanbo by Maya Patel · Acme · <https://www.kanbo.co.uk/team/pulse|Open Pulse in Kanbo>");
    expect(m.text).toBe("Pulse — Mon 5 Oct: Since Friday the team finished 3 tasks.");
    expect(m.unfurl_links).toBe(false);
  });
  it("a stand-up without a heading uses the title or the day", () => {
    expect(texts(buildSlackMessage({ kind: "standup", text: "hello", day: "2026-10-05" }).blocks)[0]).toBe("Stand-up · Mon 5 Oct");
    expect(texts(buildSlackMessage({ kind: "standup", text: "*Pulse*\nhi", title: "Morning" }).blocks)[0]).toBe("Morning");
  });
  it("a status update names the project and its status", () => {
    const m = buildSlackMessage({ kind: "status", projectName: "Website relaunch", status: "at_risk", text: "Copy is late.", actorName: "Tom", url: "https://k.test/p/abc" });
    const t = texts(m.blocks);
    expect(t[0]).toBe("Website relaunch · status update");
    expect(t[1]).toBe(":large_yellow_circle: *At risk*");
    expect(t[2]).toBe("Copy is late.");
    expect(t[3]).toContain("<https://k.test/p/abc|Open the project in Kanbo>");
    expect(m.text).toBe("Website relaunch · status update (At risk): Copy is late.");
  });
  it("risks and the test message", () => {
    expect(texts(buildSlackMessage({ kind: "risks", workspaceName: "Acme", text: "• late" }).blocks)[0]).toBe("Risks on the Radar · Acme");
    const test = buildSlackMessage({ kind: "test", workspaceName: "Acme & Co", channelLabel: "#team", text: "ignored <!here>" });
    const t = texts(test.blocks);
    expect(t[0]).toBe("Kanbo is connected");
    expect(t[1]).toContain("*Acme &amp; Co* will post stand-ups");
    expect(t[1]).toContain("in #team");
    expect(t.join(" ")).not.toContain("here>");
    expect(t[t.length - 1]).toBe("Sent from Kanbo");
  });
  it("posted by the daily job says so", () => {
    const t = texts(buildSlackMessage({ kind: "standup", text: "x", actorName: null, workspaceName: "Acme" }).blocks);
    expect(t[t.length - 1]).toBe("Posted automatically by Kanbo · Acme");
  });
  it("names can't inject mentions or links", () => {
    const t = texts(buildSlackMessage({ kind: "risks", text: "x", actorName: "<!channel>", workspaceName: "<https://evil|x>" }).blocks);
    expect(t[t.length - 1]).toBe("Posted from Kanbo by &lt;!channel&gt; · &lt;https://evil|x&gt;");
  });
  it("keeps every Slack limit, however long the text", () => {
    const huge = Array.from({ length: 4000 }, (_, i) => `line ${i} ${"z".repeat(40)}`).join("\n");
    const m = buildSlackMessage({ kind: "status", projectName: "P".repeat(400), status: "on_track", text: huge, title: "" });
    expect(m.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    for (const b of m.blocks) {
      if (b.type === "header") expect(b.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.header);
      if (b.type === "section") expect(b.text.text.length).toBeLessThanOrEqual(SLACK_LIMITS.section);
    }
    expect(texts(m.blocks).join(" ")).toContain("Cut short to fit Slack");
    expect(m.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallback + 20);
  });
  it("text over the cap is cut, so a post stays well inside 50 blocks", () => {
    const many = Array.from({ length: 200 }, () => "y".repeat(2990)).join("\n");
    const m = buildSlackMessage({ kind: "risks", text: many });
    expect(m.blocks.length).toBeLessThanOrEqual(SLACK_LIMITS.blocks);
    const body = m.blocks.filter((b) => b.type === "section").reduce((n, b) => n + (b.type === "section" ? b.text.text.length : 0), 0);
    expect(body).toBeLessThanOrEqual(SLACK_LIMITS.text);
    expect(m.blocks[m.blocks.length - 1].type).toBe("context");
  });
  it("an empty post still says something", () => {
    expect(texts(buildSlackMessage({ kind: "risks", text: "   " }).blocks)[1]).toBe("_Nothing was written._");
  });
});

describe("classifySlackResponse", () => {
  it("2xx is delivered", () => expect(classifySlackResponse(200, "ok")).toEqual({ ok: true }));
  it("429 waits", () => {
    expect(classifySlackResponse(429, "rate_limited", "12")).toEqual({ ok: false, reason: "rate_limited", detail: "rate_limited", retryAfter: 12 });
    expect(classifySlackResponse(429, "", null)).toMatchObject({ retryAfter: 30 });
  });
  it("a revoked webhook or archived channel is gone", () => {
    expect(classifySlackResponse(404, "no_service")).toEqual({ ok: false, reason: "slack_rejected", detail: "no_service", gone: true });
    expect(classifySlackResponse(410, "channel_is_archived")).toMatchObject({ gone: true, detail: "channel_is_archived" });
    expect(classifySlackResponse(403, "invalid_token")).toMatchObject({ gone: true });
  });
  it("other refusals", () => {
    expect(classifySlackResponse(400, "invalid_payload")).toEqual({ ok: false, reason: "slack_rejected", detail: "invalid_payload" });
    expect(classifySlackResponse(302, "")).toMatchObject({ detail: "redirect" });
    expect(classifySlackResponse(503, "x")).toMatchObject({ detail: "slack_unavailable" });
    expect(classifySlackResponse(400, "<html>nope</html>")).toMatchObject({ detail: "http_400" });
  });
});

describe("safeErrorNote (what the functions log)", () => {
  const SECRET = "abcdefghijklmnopqrstuvwx";
  const leaks = (note: string) => note.includes(SECRET) || /hooks\.slack\.com\/services|T0001\/B0001/.test(note);

  it("never includes the webhook, whatever shape Deno's error takes", () => {
    for (const e of [
      new TypeError(`error sending request for url (${HOOK}): client error (Connect): dns error: failed to lookup address information`),
      new TypeError(`error sending request from 10.0.0.1:50000 for ${HOOK} (54.1.2.3:443): client error (Connect): tcp connect error`),
      new TypeError(`invalid peer certificate for ${HOOK.replace("https://", "")}`),
      new Error(`POST /services/T0001/B0001/${SECRET} failed`),
      new Error(`token ${SECRET} rejected`),
      `${HOOK} went away`,
      { name: "TypeError", message: `fetch failed: ${HOOK}?x=1` },
    ]) {
      const note = safeErrorNote(e, [HOOK]);
      expect(leaks(note), note).toBe(false);
      expect(note.length).toBeLessThanOrEqual(200);
    }
    expect(safeErrorNote(new TypeError(`error sending request for url (${HOOK}): connection refused`), [HOOK]))
      .toBe("TypeError: error sending request for url ([webhook]): connection refused");
  });

  it("cuts the exact secret even without a scheme or path around it", () => {
    expect(safeErrorNote(new Error(`bad ${SECRET.slice(0, 18)}x`), [SECRET.slice(0, 18) + "x"])).toBe("Error: bad [webhook]");
  });

  it("timeouts are just 'timeout'; odd throws still give a line", () => {
    const timeout = Object.assign(new Error("The operation timed out."), { name: "TimeoutError" });
    expect(safeErrorNote(timeout)).toBe("timeout");
    expect(safeErrorNote(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("timeout");
    expect(safeErrorNote(null)).toBe("Error");
    expect(safeErrorNote(undefined)).toBe("Error");
    expect(safeErrorNote(42)).toBe("Error");
    expect(safeErrorNote({ get message() { throw new Error("no"); } })).toBe("Error");
    expect(safeErrorNote(new Error('relation "workspace_integrations" does not exist'))).toBe('Error: relation "workspace_integrations" does not exist');
    expect(safeErrorNote(new Error("x".repeat(500))).length).toBeLessThanOrEqual(200);
  });
});

describe("London time", () => {
  it("knows BST from GMT", () => {
    expect(zonedNow(new Date("2026-07-01T08:30:00Z"))).toEqual({ day: "2026-07-01", minutes: 9 * 60 + 30, weekday: 3 });
    expect(zonedNow(new Date("2026-12-01T08:30:00Z"))).toEqual({ day: "2026-12-01", minutes: 8 * 60 + 30, weekday: 2 });
    // 23:30 UTC on Sat 31 Oct 2026 is still Saturday in London (GMT from 25 Oct)
    expect(zonedNow(new Date("2026-10-31T23:30:00Z"))).toMatchObject({ day: "2026-10-31", weekday: 6 });
    // midnight in BST is 23:00 UTC the day before
    expect(zonedNow(new Date("2026-06-01T23:15:00Z"))).toMatchObject({ day: "2026-06-02", minutes: 15 });
  });
  it("reads HH:MM", () => {
    expect(parseHhMm("09:05")).toBe(545);
    for (const bad of ["9:05", "24:00", "09:60", "", null, "0905"]) expect(parseHhMm(bad)).toBeNull();
  });
  it("a time is due on the first run at or after it (20-minute window)", () => {
    const at = (h: number, m: number) => h * 60 + m;
    expect(isStandupDue("09:00", at(9, 0))).toBe(true);
    expect(isStandupDue("09:05", at(9, 15))).toBe(true);
    expect(isStandupDue("09:05", at(9, 0))).toBe(false);
    expect(isStandupDue("09:00", at(9, 19))).toBe(true);
    expect(isStandupDue("09:00", at(9, 20))).toBe(false);
    expect(isStandupDue(null, at(9, 0))).toBe(false);
  });
  it("weekdays and the last workday", () => {
    expect([0, 1, 5, 6].map(isWeekday)).toEqual([false, true, true, false]);
    expect(lastWorkdayIso("2026-10-05")).toBe("2026-10-02");   // Mon → Fri
    expect(lastWorkdayIso("2026-10-06")).toBe("2026-10-05");
    expect(lastWorkdayIso("2026-10-04")).toBe("2026-10-02");   // Sun → Fri
    expect(addDaysIso("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("buildStandupText", () => {
  const members = [{ id: "u1", name: "Maya Patel" }, { id: "u2", name: "Tom Reed" }, { id: "u3", name: "Guest Person", guest: true }, { id: "u4", name: "Quiet One" }];
  const t = (id: string, patch: Partial<StandupTaskRow>): StandupTaskRow => ({ id, title: `Task ${id}`, status: "todo", assignee_id: "u1", ...patch });
  const today = "2026-10-06"; // Tuesday
  it("lists each person's finished, in-progress, due, overdue and blocked work", () => {
    const text = buildStandupText({
      today, members,
      tasks: [
        t("a", { status: "done", completed_at: "2026-10-05" }),
        t("b", { status: "done", completed_at: "2026-09-30" }),                    // too old
        t("c", { status: "done", completed_at: null }),                            // done by event
        t("d", { status: "progress", assignee_id: "u2" }),
        t("e", { due_date: today, assignee_id: "u2" }),
        t("f", { due_date: "2026-10-01", status: "progress", assignee_id: "u2" }), // overdue beats doing
        t("g", { status: "blocked", assignee_id: "u3" }),
        t("h", { status: "done", completed_at: "2026-10-05", archived_at: "2026-10-05T10:00:00Z" }),
      ],
      events: [{ task_id: "c", field: "status", new_value: "done", created_at: "2026-10-05T16:00:00Z" }],
    });
    const lines = text.split("\n");
    expect(lines[0]).toBe("*Stand-up — Tue 6 Oct*");
    expect(lines[1]).toBe("Since yesterday the team finished 2 tasks. 1 is in progress, 1 is due today, 1 is overdue and 1 is blocked.");
    expect(lines).toContain("• *Maya* — done: Task a, Task c");
    expect(lines).toContain("• *Tom* — doing: Task d; due today: Task e; overdue: Task f");
    expect(lines[lines.length - 1]).toBe("• *Guest* — blocked: Task g");   // guests last
    expect(text).not.toContain("Quiet");
    expect(text).not.toContain("Task b");
    expect(text).not.toContain("Task h");
  });
  it("Monday looks back to Friday; a quiet team says so", () => {
    const text = buildStandupText({ today: "2026-10-05", members, tasks: [] });
    expect(text).toContain("Nothing has been finished since Friday. Nothing is in progress and nothing is blocked.");
    expect(text.endsWith("Nobody has anything to report yet.")).toBe(true);
  });
  it("caps long lists and disambiguates first names", () => {
    const many = Array.from({ length: 8 }, (_, i) => t(`x${i}`, { status: "progress" }));
    const text = buildStandupText({ today, members: [{ id: "u1", name: "Sam Lee" }, { id: "u2", name: "Sam Cole" }], tasks: many });
    expect(text).toContain("• *Sam Lee* — doing: Task x0, Task x1, Task x2, Task x3, Task x4 +3 more");
  });
});
