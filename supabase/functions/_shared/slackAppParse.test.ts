// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeSlackText, parseSlackTask, readableSlackText, resolveMention, safeTz, slashIntent, SLACK_KINDS, zonedToday } from "./slackAppParse.ts";
import { parseTask, toLocalISO } from "./nlp.ts";

// Tue 20 Oct 2026, local midnight (the grammar's "today")
const TODAY = new Date(2026, 9, 20);
const PROJECTS = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Q4 Product Launch", emoji: "🚀" },
  { id: "22222222-2222-4222-8222-222222222222", name: "Ops" },
];
const MEMBERS = [
  { id: "aaaaaaaa-0000-4000-8000-000000000001", name: "Sana Rao", email: "sana@acme.test" },
  { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "Theo Hart", email: "theo@acme.test" },
  { id: "aaaaaaaa-0000-4000-8000-000000000003", name: "Sam Okafor", email: "sam@acme.test" },
];
const ctx = { today: TODAY, projects: PROJECTS, members: MEMBERS };

describe("Slack's escaped text", () => {
  it("person mentions become handles, recorded once each", () => {
    const d = decodeSlackText("ping <@U024BE7LH|sana> and <@U024BE7LH> and <@W1234ABC>");
    expect(d.mentions.map((m) => m.slackUserId)).toEqual(["U024BE7LH", "W1234ABC"]);
    expect(d.mentions[0].label).toBe("sana");
    expect(d.text).toBe(`ping @${d.mentions[0].handle} and @${d.mentions[0].handle} and @${d.mentions[1].handle}`);
  });
  it("channels read as #name (people type #project and Slack may turn it into a channel link)", () => {
    expect(decodeSlackText("brief <#C024BE7LR|launch> fri").text).toBe("brief #launch fri");
    expect(decodeSlackText("brief <#C024BE7LR> fri").text).toBe("brief  fri");
  });
  it("@here / @channel / user groups never survive as mentions", () => {
    expect(decodeSlackText("tell <!here> and <!channel> and <!subteam^S123|@design>").text).toBe("tell here and channel and design");
    expect(decodeSlackText("<!date^1392734382^{date}|Feb 18, 2014>").text).toBe("Feb 18, 2014");
  });
  it("links read as their label (or address); entities are undone last", () => {
    expect(decodeSlackText("see <https://example.com/a?b=1&amp;c=2|the doc> &amp; <mailto:a@b.com|a@b.com>").text).toBe("see the doc & a@b.com");
    expect(decodeSlackText("<https://example.com>").text).toBe("https://example.com");
    expect(decodeSlackText("if a &lt; b &amp;&amp; c &gt; d").text).toBe("if a < b && c > d");
    // escapes can't be smuggled back into a mention: &lt;!channel&gt; is text
    expect(decodeSlackText("&lt;!channel&gt;").mentions).toEqual([]);
  });
  it("readable text: mentions as names", () => {
    expect(readableSlackText("hey <@U1ABC> and <@U2DEF|theo>", new Map([["U1ABC", "Sana Rao"]]))).toBe("hey @Sana Rao and @theo");
    expect(readableSlackText("hey <@U1ABC>")).toBe("hey @someone");
  });
});

describe("/kanbo sentences (the app's grammar)", () => {
  it("title, day, time, #project, @person, !priority, ~estimate", () => {
    const p = parseSlackTask("Send the brief fri 3pm #launch @sana !high ~2h", ctx);
    expect(p).toMatchObject({
      title: "Send the brief", dueDate: "2026-10-23", dueTime: "15:00", projectId: PROJECTS[0].id, assigneeId: MEMBERS[0].id,
      priority: "high", effortHours: 2, unknownProjects: [], unknownPeople: [],
    });
  });
  it("reads exactly as Quick capture for the kinds /kanbo takes", () => {
    for (const s of ["call Sana fri 3pm ~30m #launch", "Book venue next week !urgent", "Draft update by 3 Nov from mon p2", "Pay rent 1/11 at 9", "Review deck tomorrow 10am @theo #ops"]) {
      const a = parseSlackTask(s, ctx);
      const b = parseTask(s, { today: TODAY, kinds: SLACK_KINDS, projects: PROJECTS, members: MEMBERS });
      expect({ title: a.title, due: a.dueDate, time: a.dueTime, p: a.projectId, who: a.assigneeId, pr: a.priority, est: a.effortHours, start: a.startDate })
        .toEqual({ title: b.title, due: b.dueDate, time: b.dueTime, p: b.projectId, who: b.assigneeId, pr: b.priority, est: b.effortHours, start: b.startDate });
    }
  });
  it("leaves repeats, focus durations, energy and +tags in the title", () => {
    const p = parseSlackTask("Water plants every mon 30m deep work +ops", ctx);
    expect(p.title).toBe("Water plants every mon 30m deep work +ops");
    expect(p.dueDate).toBeUndefined();
  });
  it("a resolved Slack mention assigns that member, whatever their name", () => {
    const resolved = new Map([["U0SAM", MEMBERS[2].id]]);
    const p = parseSlackTask("Fix login <@U0SAM|samo> #ops", { ...ctx, resolved });
    expect(p).toMatchObject({ title: "Fix login", assigneeId: MEMBERS[2].id, projectId: PROJECTS[1].id });
  });
  it("an unresolved Slack mention falls back to the name Slack showed", () => {
    expect(parseSlackTask("Fix login <@U0X|theo>", ctx).assigneeId).toBe(MEMBERS[1].id);
    const p = parseSlackTask("Fix login <@U0X|zed>", ctx);
    expect(p.assigneeId).toBeUndefined();
    expect(p.unknownPeople).toEqual(["zed"]);
    expect(parseSlackTask("Fix login <@U0X>", ctx).unknownPeople).toEqual([]);
  });
  it("two mentions: the first is the assignee, the second stays in the title by name (never the handle)", () => {
    const resolved = new Map([["U01SANA", MEMBERS[0].id], ["U02THEO", MEMBERS[1].id]]);
    const p = parseSlackTask("Sync with <@U01SANA> and <@U02THEO> #launch fri", { ...ctx, resolved });
    expect(p).toMatchObject({ title: "Sync with and @Theo Hart", assigneeId: MEMBERS[0].id, projectId: PROJECTS[0].id, dueDate: "2026-10-23" });
    // Theo is a known member, just not the assignee: not "nobody called…"
    expect(p.unknownPeople).toEqual([]);
    expect(p.title).not.toMatch(/kslk/);
  });
  it("a mention with no label: the name Slack gives (users.info), else @someone; never the handle", () => {
    const names = new Map([["U09XYZ", "Bob Stone"]]);
    const named = parseSlackTask("Review deck <@U09XYZ> #launch", { ...ctx, names });
    expect(named).toMatchObject({ title: "Review deck @Bob Stone", projectId: PROJECTS[0].id, unknownPeople: ["Bob Stone"] });
    expect(named.assigneeId).toBeUndefined();
    const bare = parseSlackTask("Review deck <@U09XYZ> #launch", ctx);
    expect(bare).toMatchObject({ title: "Review deck @someone", unknownPeople: [] });
    // a resolved mention after an unresolved one is still the assignee, and both read as names
    const mixed = parseSlackTask("Pair <@U09XYZ> with <@U0SAM>", { ...ctx, names, resolved: new Map([["U0SAM", MEMBERS[2].id]]) });
    expect(mixed).toMatchObject({ title: "Pair @Bob Stone", assigneeId: MEMBERS[2].id });
  });
  it("one mention is never read as another whose Slack id it starts", () => {
    // U1AB is nobody in Kanbo; U1ABC is Theo: "@U1AB" must not be read as Theo
    const p = parseSlackTask("Ask <@U1AB> and <@U1ABC>", { ...ctx, resolved: new Map([["U1ABC", MEMBERS[1].id]]), names: new Map([["U1AB", "Ann Lee"]]) });
    expect(p).toMatchObject({ title: "Ask @Ann Lee", assigneeId: MEMBERS[1].id, unknownPeople: ["Ann Lee"] });
    expect(readableSlackText("hey <@U1AB> and <@U1ABC>", new Map([["U1AB", "Ann"], ["U1ABC", "Abe"]]))).toBe("hey @Ann and @Abe");
  });
  it("reports #words that named no project", () => {
    const p = parseSlackTask("Plan offsite #nowhere", ctx);
    expect(p.projectId).toBeUndefined();
    expect(p.unknownProjects).toEqual(["nowhere"]);
    // "#123" is an issue number, not a project
    expect(parseSlackTask("Fix bug #123", ctx).unknownProjects).toEqual([]);
  });
  it("a channel link reads as the project it names", () => {
    expect(parseSlackTask("Brief <#C1|launch> fri", ctx).projectId).toBe(PROJECTS[0].id);
  });
});

describe("intent, people, zones", () => {
  it("help / empty / a sentence", () => {
    expect(slashIntent("")).toEqual({ kind: "modal" });
    expect(slashIntent("   ")).toEqual({ kind: "modal" });
    for (const h of ["help", "HELP", "?", "--help"]) expect(slashIntent(h)).toEqual({ kind: "help" });
    expect(slashIntent(" Buy milk ")).toEqual({ kind: "create", text: "Buy milk" });
    expect(slashIntent("help me write the brief")).toEqual({ kind: "create", text: "help me write the brief" });
  });
  it("a Slack profile → a member: email first, then exact names; never a loose first-name guess", () => {
    expect(resolveMention({ email: "SAM@acme.test ", realName: "Someone Else" }, MEMBERS)?.id).toBe(MEMBERS[2].id);
    expect(resolveMention({ email: "nobody@x.test", realName: "Theo Hart" }, MEMBERS)?.id).toBe(MEMBERS[1].id);
    expect(resolveMention({ displayName: "sana rao" }, MEMBERS)?.id).toBe(MEMBERS[0].id);
    expect(resolveMention({ realName: "Theodore Hart" }, MEMBERS)).toBeUndefined();
    expect(resolveMention({ displayName: "sa" }, MEMBERS)).toBeUndefined();
    expect(resolveMention({}, MEMBERS)).toBeUndefined();
  });
  it("today in the person's zone, as a local-midnight Date", () => {
    // 23:30 UTC on 20 Oct is 00:30 on the 21st in London (BST) and Auckland, still the 20th in Los Angeles
    const at = new Date(Date.UTC(2026, 9, 20, 23, 30));
    expect(toLocalISO(zonedToday("Europe/London", at))).toBe("2026-10-21");
    expect(toLocalISO(zonedToday("Pacific/Auckland", at))).toBe("2026-10-21");
    expect(toLocalISO(zonedToday("America/Los_Angeles", at))).toBe("2026-10-20");
    expect(toLocalISO(zonedToday("Not/AZone", new Date(Date.UTC(2026, 9, 20, 12))))).toBe("2026-10-20");
  });
  it("only real IANA zones are used", () => {
    expect(safeTz("Europe/Paris")).toBe("Europe/Paris");
    expect(safeTz("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    for (const bad of ["", "Mars/Olympus", "../etc", 7, null, "Europe/London; drop table"]) expect(safeTz(bad)).toBe("Europe/London");
  });
});
