// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  ACTIONS, cardFacts, createdMessage, createModal, decodeMeta, descriptionFromMessage, dueLabel, encodeMeta, helpMessage, homeView, link,
  linkPromptMessage, LIMITS, noticeMessage, optionsPayload, projectUnfurl, publicName, readModal, taskUnfurl, taskUrl, titleFromMessage, undoneMessage,
  updatedMessage, type TaskCard,
} from "./slackAppBlocks.ts";

const APP = "https://www.kanbo.co.uk";
const ID = "5b2484e9-79b1-4e86-9488-dc2b6a68e0ee";
const EVIL = "<!channel> <@U123> <https://evil.test|click> & *bold*|pipe";
const card: TaskCard = { id: ID, title: EVIL, projectName: "<!here> Launch", projectEmoji: "🚀", dueDate: "2026-10-23", dueTime: "15:00", assigneeName: "<@U999>", priority: "high" };

/** every mrkdwn text in a Block Kit structure */
function mrkdwnTexts(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => mrkdwnTexts(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "mrkdwn" && typeof o.text === "string") out.push(o.text);
    Object.values(o).forEach((x) => mrkdwnTexts(x, out));
  }
  return out;
}
/** every plain_text text */
function plainTexts(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => plainTexts(x, out));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.type === "plain_text" && typeof o.text === "string") out.push(o.text);
    Object.values(o).forEach((x) => plainTexts(x, out));
  }
  return out;
}
/** no mention, broadcast or foreign link can come out of what people typed */
function assertNoInjection(v: unknown) {
  for (const t of mrkdwnTexts(v)) {
    expect(t).not.toMatch(/<!(channel|here|everyone)/);
    expect(t).not.toMatch(/<@U/);
    expect(t).not.toMatch(/<https?:\/\/evil/);
    // every "<" opens one of our own links (Kanbo's address)
    for (const m of t.matchAll(/<([^>]*)>/g)) expect(m[1]).toMatch(/^https:\/\/www\.kanbo\.co\.uk[/|]/);
  }
}

describe("escaping (mrkdwn injection)", () => {
  it("links: label escaped, | removed, only http(s) targets", () => {
    expect(link(`${APP}/?task=${ID}`, "a <b> & c|d")).toBe(`<${APP}/?task=${ID}|a &lt;b&gt; &amp; c/d>`);
    expect(link("javascript:alert(1)", "x")).toBe("x");
    expect(link(null, "<!channel>")).toBe("&lt;!channel&gt;");
  });
  it("the confirmation card, the updated card, the unfurl and the Home tab never let typed text mention or link", () => {
    assertNoInjection(createdMessage(card, { appUrl: APP, canUndo: true, notes: [EVIL] }).blocks);
    assertNoInjection(updatedMessage(card, { appUrl: APP, note: "Assigned to you:" }).blocks);
    assertNoInjection(taskUnfurl(card, APP));
    assertNoInjection(projectUnfurl({ id: ID, name: EVIL, emoji: "<!here>", description: EVIL, openCount: 2, doneCount: 1 }, APP));
    assertNoInjection(homeView({ linked: true, tasks: [{ ...card, overdue: true }], appUrl: APP, workspaceName: EVIL, today: "2026-10-20" }));
    assertNoInjection(undoneMessage(EVIL).blocks);
    assertNoInjection(noticeMessage(EVIL).blocks);
  });
  it("fallback texts are escaped too", () => {
    expect(createdMessage(card, { appUrl: APP, canUndo: false }).text).not.toMatch(/<!channel>/);
    expect(undoneMessage("<!here>").text).toContain("&lt;!here&gt;");
  });
  it("facts line: project, due, assignee, priority", () => {
    expect(cardFacts(card)).toBe("🚀 &lt;!here&gt; Launch  ·  📅 Due Fri 23 Oct, 15:00  ·  👤 &lt;@U999&gt;  ·  ⚑ High priority");
    expect(cardFacts({ id: ID, title: "x", personal: true })).toBe("📥 Your Personal list  ·  📅 No due date  ·  👤 Unassigned");
    expect(cardFacts({ id: ID, title: "x", assigneeName: "Ada", assignedToMe: true })).toContain("👤 You");
    // a Personal-list task is yours even with no member name
    expect(cardFacts({ id: ID, title: "x", personal: true, assignedToMe: true })).toContain("👤 You");
  });
  it("a link preview names the assignee for the channel: never \"You\", never an email", () => {
    const fields = (t: TaskCard) => JSON.stringify((taskUnfurl(t, APP).blocks as Array<{ fields?: unknown }>)[0].fields);
    expect(fields({ id: ID, title: "x", assigneeName: "Sana Rao", assignedToMe: true })).toContain("*Assignee*\\nSana Rao");
    expect(fields({ id: ID, title: "x", assigneeName: "sana.rao@acme.test" })).toContain("*Assignee*\\nsana.rao");
    expect(fields({ id: ID, title: "x", assigneeName: "sana.rao@acme.test" })).not.toContain("acme.test");
    expect(fields({ id: ID, title: "x" })).toContain("*Assignee*\\nUnassigned");
    expect(publicName("<@U999>")).toBe("<@U999>");
    expect(publicName("  ")).toBeNull();
  });
});

describe("the confirmation card", () => {
  it("Open in Kanbo (the task's address) · Assign to me · Undo", () => {
    const m = createdMessage(card, { appUrl: APP, canUndo: true });
    expect(m.response_type).toBe("ephemeral");
    const actions = m.blocks!.find((b) => b.type === "actions") as { elements: Array<Record<string, unknown>> };
    expect(actions.elements.map((e) => e.action_id)).toEqual([ACTIONS.open, ACTIONS.assignMe, ACTIONS.undo]);
    expect(actions.elements[0].url).toBe(`${APP}/?task=${ID}`);
    expect(actions.elements[1].value).toBe(ID);
    expect(actions.elements[2]).toMatchObject({ value: ID, style: "danger" });
  });
  it("no Assign to me when it's yours or personal; no Undo when not offered", () => {
    const mine = createdMessage({ ...card, assignedToMe: true }, { appUrl: APP, canUndo: false });
    const ids = (mine.blocks!.find((b) => b.type === "actions") as { elements: Array<{ action_id: string }> }).elements.map((e) => e.action_id);
    expect(ids).toEqual([ACTIONS.open]);
    const personal = createdMessage({ ...card, personal: true }, { appUrl: APP, canUndo: true });
    expect(JSON.stringify(personal)).not.toContain(ACTIONS.assignMe);
  });
  it("button and option text stay within Slack's 75 characters", () => {
    const long = "x".repeat(500);
    for (const t of plainTexts(createdMessage({ ...card, title: long }, { appUrl: APP, canUndo: true }).blocks)) expect(t.length).toBeLessThanOrEqual(LIMITS.button);
    const opts = optionsPayload([{ text: long, value: "v".repeat(400) }]) as { options: Array<{ text: { text: string }; value: string }> };
    expect(opts.options[0].text.text.length).toBeLessThanOrEqual(75);
    expect(opts.options[0].value.length).toBeLessThanOrEqual(150);
    expect((optionsPayload(Array.from({ length: 150 }, (_, i) => ({ text: `${i}`, value: `${i}` }))) as { options: unknown[] }).options).toHaveLength(100);
  });
  it("only Kanbo's own address is ever linked", () => {
    expect(taskUrl(APP, ID)).toBe(`${APP}/?task=${ID}`);
    expect(taskUrl("javascript:", ID)).toBeNull();
    expect(taskUrl(APP, "../admin")).toBeNull();
  });
});

describe("link prompt and help", () => {
  it("one URL button, said to be single-use", () => {
    const m = linkPromptMessage({ url: `${APP}/link/slack?t=abc` });
    expect(m.response_type).toBe("ephemeral");
    expect(JSON.stringify(m)).toContain(`${APP}/link/slack?t=abc`);
    expect(JSON.stringify(m)).toMatch(/works once, for 15 minutes/);
  });
  it("help explains the syntax and the shortcut", () => {
    const s = JSON.stringify(helpMessage());
    for (const bit of ["#project", "@person", "!high", "~30m", "Create a Kanbo task", "fri 3pm"]) expect(s).toContain(bit);
  });
});

describe("the create modal", () => {
  const meta = { c: "C1", ts: "1700000000.000100", pl: "https://acme.slack.com/archives/C1/p1700000000000100", ru: "https://hooks.slack.com/app/T/1/x", d: "acme" };
  const view = createModal({ title: "Fix it", description: "Body", meta, workspaceName: "Acme" });
  it("callback id, ≤ 24-character title, prefilled fields, Personal by default, external pickers", () => {
    expect(view).toMatchObject({ type: "modal", callback_id: "create_kanbo_task" });
    expect((view.title as { text: string }).text.length).toBeLessThanOrEqual(24);
    const blocks = view.blocks as Array<{ block_id?: string; element?: Record<string, unknown>; optional?: boolean }>;
    const by = (id: string) => blocks.find((b) => b.block_id === id)!;
    expect(by("title").element).toMatchObject({ initial_value: "Fix it", max_length: 200 });
    expect(by("description").element).toMatchObject({ initial_value: "Body", multiline: true });
    expect(by("project").element).toMatchObject({ type: "external_select", min_query_length: 0, initial_option: { value: "p-personal" } });
    expect(by("assignee").element).toMatchObject({ type: "external_select" });
    expect(by("due").element).toMatchObject({ type: "datepicker" });
    expect(by("priority").element).toMatchObject({ type: "static_select", initial_option: { value: "medium" } });
    expect(by("title").optional).toBeUndefined();
    expect(by("description").optional).toBe(true);
  });
  it("metadata round-trips and stays under 3,000 characters", () => {
    expect(decodeMeta(view.private_metadata)).toEqual(meta);
    expect(decodeMeta("not json")).toEqual({});
    expect(decodeMeta(JSON.stringify({ c: 7, pl: "x".repeat(700) }))).toEqual({ c: undefined, ts: undefined, tt: undefined, pl: undefined, ru: undefined, d: undefined });
    expect(encodeMeta({ ...meta, pl: "x".repeat(3000) }).length).toBeLessThanOrEqual(3000);
  });
  it("reads the submitted values", () => {
    const state = { values: {
      title: { title: { value: "  Ship it  " } }, description: { description: { value: "Notes" } },
      project: { project: { selected_option: { value: "p1" } } }, assignee: { assignee: { selected_option: null } },
      due: { due: { selected_date: "2026-11-03" } }, priority: { priority: { selected_option: { value: "high" } } },
    } };
    expect(readModal({ state })).toEqual({ title: "Ship it", description: "Notes", projectId: "p1", assigneeId: null, dueDate: "2026-11-03", priority: "high" });
    expect(readModal({})).toEqual({ title: "", description: "", projectId: null, assigneeId: null, dueDate: null, priority: null });
    expect(readModal({ state: { values: { due: { due: { selected_date: "tomorrow" } } } } }).dueDate).toBeNull();
  });
  it("a message's first line → the title (≤ 200); its text + the permalink → the description", () => {
    expect(titleFromMessage("\n\n  First line here  \nsecond")).toBe("First line here");
    expect(titleFromMessage("y".repeat(400)).length).toBeLessThanOrEqual(200);
    expect(descriptionFromMessage("Hello\r\nworld", "https://acme.slack.com/archives/C1/p1")).toBe("Hello\nworld\n\nFrom Slack: https://acme.slack.com/archives/C1/p1");
    expect(descriptionFromMessage("", "https://acme.slack.com/archives/C1/p1")).toBe("From Slack: https://acme.slack.com/archives/C1/p1");
    expect(descriptionFromMessage("z".repeat(5000), null).length).toBeLessThanOrEqual(3000);
  });
});

describe("unfurls and Home", () => {
  it("task preview: title link, project, status, assignee, due; Complete unless done", () => {
    const u = taskUnfurl({ ...card, title: "Ship it", status: "progress" }, APP);
    const s = JSON.stringify(u);
    for (const bit of ["Ship it", "In progress", "Fri 23 Oct, 15:00", ACTIONS.complete, `${APP}/?task=${ID}`]) expect(s).toContain(bit);
    expect(JSON.stringify(taskUnfurl({ ...card, status: "done" }, APP))).not.toContain(ACTIONS.complete);
  });
  it("Home: unlinked people see how to link, never tasks", () => {
    const v = homeView({ linked: false, appUrl: APP });
    expect(v.type).toBe("home");
    expect(JSON.stringify(v)).toMatch(/Link your Kanbo account/);
  });
  it("Home: at most 20 tasks, overdue said so", () => {
    const tasks = Array.from({ length: 30 }, (_, i) => ({ id: ID, title: `T${i}`, dueDate: "2026-10-18", overdue: i === 0 }));
    const v = homeView({ linked: true, tasks, appUrl: APP, more: 1 });
    const s = JSON.stringify(v);
    expect(s).toContain("T19");
    expect(s).not.toContain("T20");
    expect(s).toContain("was due");
    expect((v.blocks as unknown[]).length).toBeLessThanOrEqual(100);
  });
  it("due labels", () => {
    expect(dueLabel("2026-10-23", "15:00:00")).toBe("Fri 23 Oct, 15:00");
    expect(dueLabel("2026-10-23", null)).toBe("Fri 23 Oct");
    expect(dueLabel(null, "15:00")).toBeNull();
  });
});
