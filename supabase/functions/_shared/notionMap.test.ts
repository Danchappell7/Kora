// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  canonNotionDate, canonTaskDate, checkMapping, dayOf, displayValue, firstParagraph, formatCursor, guessStatus, httpsUrl, iconOf,
  pageMeta, parseCursor, plain, previewRow, pullPatch, pushProperties, readMapping, readPage, richText, schemaOf,
  splitFirstParagraph, suggestMapping, summariseDatabase, tagColour, taskFromPage, withFirstParagraph,
  type MapContext, type NDatabase, type NPage, type SyncTask,
} from "./notionMap.ts";
import type { NotionFieldMapping } from "./notion.ts";

const rt = (s: string) => [{ type: "text", text: { content: s }, plain_text: s }];
const DB: NDatabase = {
  object: "database", id: "0d0d0d0d-0000-4000-8000-000000000001", title: rt("Content calendar"), icon: { type: "emoji", emoji: "🗓️" },
  url: "https://www.notion.so/0d0d0d0d000040008000000000000001", last_edited_time: "2026-10-01T09:00:00.000Z",
  properties: {
    Name: { id: "title", name: "Name", type: "title" },
    Status: { id: "st", name: "Status", type: "status", status: {
      options: [{ id: "o1", name: "Idea" }, { id: "o2", name: "Drafting" }, { id: "o3", name: "Scheduled" }, { id: "o4", name: "Published" }, { id: "o5", name: "Parked" }],
      groups: [{ name: "To-do", option_ids: ["o1", "o5"] }, { name: "In progress", option_ids: ["o2", "o3"] }, { name: "Complete", option_ids: ["o4"] }] } },
    "Publish date": { id: "pd", name: "Publish date", type: "date" },
    Owner: { id: "ow", name: "Owner", type: "people" },
    Channels: { id: "ch", name: "Channels", type: "multi_select", multi_select: { options: [{ name: "Blog" }, { name: "LinkedIn" }] } },
    Summary: { id: "su", name: "Summary", type: "rich_text" },
    Words: { id: "wd", name: "Words", type: "number" },
    Rollup: { id: "ro", name: "Rollup", type: "rollup" },
  },
};
const MAP: NotionFieldMapping = {
  title: "Name",
  status: { property: "Status", values: { Idea: "todo", Drafting: "progress", Scheduled: "progress", Published: "done" } },
  due: { property: "Publish date" }, assignee: { property: "Owner" }, tags: { property: "Channels" }, description: { property: "Summary" },
};
const ANA = "aaaaaaaa-0000-4000-8000-000000000001", BOB = "bbbbbbbb-0000-4000-8000-000000000002";
const ctx: MapContext = {
  memberByEmail: new Map([["ana@kanbo.test", ANA], ["bob@kanbo.test", BOB]]),
  emailByMember: new Map([[ANA, "ana@kanbo.test"], [BOB, "bob@kanbo.test"]]),
  tagLabelById: new Map([["t-blog", "Blog"], ["t-li", "LinkedIn"], ["t-news", "Newsletter"]]),
  notionUserByEmail: new Map([["ana@kanbo.test", "n-ana"], ["bob@kanbo.test", "n-bob"]]),
};
const person = (id: string, email: string | null) => ({ object: "user", id, name: id, type: "person", person: email ? { email } : {} });
function page(p: { title?: string; status?: string | null; date?: { start: string; end?: string | null } | null; people?: unknown[]; tags?: string[]; summary?: string }): NPage {
  return {
    object: "page", id: "9a9a9a9a-0000-4000-8000-000000000001", last_edited_time: "2026-10-05T10:00:00.000Z", created_time: "2026-10-01T10:00:00.000Z",
    properties: {
      Name: { type: "title", title: rt(p.title ?? "Launch post") },
      Status: { type: "status", status: p.status ? { name: p.status } : null },
      "Publish date": { type: "date", date: p.date ?? null },
      Owner: { type: "people", people: p.people ?? [] },
      Channels: { type: "multi_select", multi_select: (p.tags ?? []).map((name) => ({ name, color: "green" })) },
      Summary: { type: "rich_text", rich_text: p.summary ? rt(p.summary) : [] },
      Words: { type: "number", number: 900 },
    },
  };
}
const task = (t: Partial<SyncTask> = {}): SyncTask => ({
  id: "t1", title: "Launch post", description: "", status: "todo", due_date: null, start_date: null, assignee_id: "", tags: [], ...t,
});

describe("reading Notion objects", () => {
  it("plain text, and rich text in 2,000-character pieces (never splitting an emoji)", () => {
    expect(plain(rt("a").concat(rt("b")))).toBe("ab");
    expect(plain("nope")).toBe("");
    expect(plain([{ text: { content: "x" } }, null, 3])).toBe("x");
    const long = "😀" + "a".repeat(1998) + "😀" + "b".repeat(10);
    const parts = richText(long);
    expect(parts.map((p) => p.text.content).join("")).toBe(long);
    expect(parts.every((p) => p.text.content.length <= 2000)).toBe(true);
    expect(parts[0].text.content.endsWith("a")).toBe(true);
    expect(richText("z".repeat(2000 * 120))).toHaveLength(100);
    expect(richText("")).toEqual([]);
  });
  it("icons: emoji or https only", () => {
    expect(iconOf({ type: "emoji", emoji: "🚀" })).toBe("🚀");
    expect(iconOf({ type: "external", external: { url: "https://cdn.example.com/i.png" } })).toBe("https://cdn.example.com/i.png");
    expect(iconOf({ type: "file", file: { url: "https://s3.amazonaws.com/x.png?sig=1" } })).toMatch(/^https:/);
    expect(iconOf({ type: "external", external: { url: "http://cdn.example.com/i.png" } })).toBeNull();
    expect(iconOf({ type: "external", external: { url: "javascript:alert(1)" } })).toBeNull();
    expect(iconOf({ type: "external", external: { url: 'https://x.com/"><script>' } })).toBeNull();
    expect(iconOf(null)).toBeNull();
    expect(httpsUrl("https://" + "a".repeat(1000))).toBeNull();
  });
  it("days", () => {
    expect(dayOf("2026-10-07T09:00:00.000+01:00")).toBe("2026-10-07");
    expect(dayOf("2026-10-07")).toBe("2026-10-07");
    expect(dayOf("soon")).toBeNull();
    expect(dayOf(null)).toBeNull();
  });
  it("a database's schema: title first, then by name; options, status groups; unknown types are 'other'", () => {
    const s = schemaOf(DB);
    expect(s.title).toBe("Content calendar");
    expect(s.properties.map((p) => p.name)).toEqual(["Name", "Channels", "Owner", "Publish date", "Rollup", "Status", "Summary", "Words"]);
    const st = s.properties.find((p) => p.name === "Status")!;
    expect(st.options).toEqual(["Idea", "Drafting", "Scheduled", "Published", "Parked"]);
    expect(st.groups).toMatchObject({ Idea: "To-do", Drafting: "In progress", Published: "Complete" });
    expect(s.properties.find((p) => p.name === "Rollup")!.type).toBe("other");
    expect(summariseDatabase(DB)).toEqual({ id: DB.id, title: "Content calendar", icon: "🗓️", url: DB.url, lastEditedTime: DB.last_edited_time });
    expect(summariseDatabase({ id: "x", title: [] }).title).toBe("Untitled database");
  });
  it("preview values as text", () => {
    const p = page({ status: "Drafting", date: { start: "2026-10-05", end: "2026-10-12" }, people: [person("u1", "ana@kanbo.test")], tags: ["Blog", "LinkedIn"], summary: "Hello\nthere" });
    const r = previewRow(p);
    expect(r.values).toMatchObject({ Name: "Launch post", Status: "Drafting", "Publish date": "2026-10-05 → 2026-10-12", Owner: ["u1"], Channels: ["Blog", "LinkedIn"], Summary: "Hello there", Words: "900" });
    expect(displayValue({ type: "checkbox", checkbox: true })).toBe("Yes");
    expect(displayValue({ type: "formula", formula: { type: "number", number: 3 } })).toBe("3");
    expect(displayValue({ type: "relation", relation: [] })).toBeNull();
    expect(displayValue({ type: "title", title: rt("x".repeat(500)) })).toHaveLength(200);
  });
  it("page meta for the cache", () => {
    const m = pageMeta({ ...page({ title: "Brief" }), icon: { type: "emoji", emoji: "📄" }, url: "https://www.notion.so/x", in_trash: true });
    expect(m).toEqual({ title: "Brief", icon: "📄", url: "https://www.notion.so/x", last_edited_time: "2026-10-05T10:00:00.000Z", archived: true });
    expect(pageMeta(DB).title).toBe("Content calendar");
    expect(pageMeta({ object: "page", id: "x", last_edited_time: "nope", properties: {} }).title).toBe("Untitled");
  });
});

describe("the mapping", () => {
  it("guesses statuses from names and groups", () => {
    expect(guessStatus("Idea", "To-do")).toBe("todo");
    expect(guessStatus("Drafting")).toBe("progress");
    expect(guessStatus("Scheduled")).toBe("review");
    expect(guessStatus("Published")).toBe("done");
    expect(guessStatus("On hold")).toBe("blocked");
    expect(guessStatus("Shipping soon", "Complete")).toBe("done");
    expect(guessStatus("Something", "In progress")).toBe("progress");
    expect(guessStatus("Whatever")).toBe("todo");
  });
  it("suggests a mapping from the schema", () => {
    const m = suggestMapping(schemaOf(DB));
    expect(m).toMatchObject({ title: "Name", due: { property: "Publish date" }, assignee: { property: "Owner" }, tags: { property: "Channels" }, description: { property: "Summary" } });
    expect(m.status?.values).toEqual({ Idea: "todo", Drafting: "progress", Scheduled: "review", Published: "done", Parked: "todo" });
    expect(suggestMapping({ properties: [{ id: "t", name: "Task", type: "title" }] })).toEqual({ title: "Task" });
  });
  it("checks the wizard's mapping against the schema", () => {
    const s = schemaOf(DB);
    const ok = checkMapping({ ...MAP, junk: 1 }, s);
    expect(ok.ok && ok.mapping).toEqual(MAP);
    const bad = (m: unknown) => { const r = checkMapping(m, s); return r.ok ? "" : r.error; };
    expect(bad(null)).toMatch(/Choose/);
    expect(bad({ ...MAP, title: "Summary" })).toMatch(/title/);
    expect(bad({ ...MAP, due: { property: "Owner" } })).toMatch(/Due date.*right kind/);
    expect(bad({ ...MAP, tags: { property: "Gone" } })).toMatch(/isn't in this database/);
    expect(bad({ ...MAP, status: { property: "Status", values: { Idea: "doing" } } })).toMatch(/Kanbo status for “Idea”/);
    expect(bad({ ...MAP, status: { property: "Status", values: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`o${i}`, "todo"])) } })).toMatch(/more options/);
    expect(bad({ ...MAP, status: { property: "Status" } })).toMatch(/which Kanbo status/);
    expect(bad({ ...MAP, assignee: "Owner" })).toMatch(/Assignee/);
  });
  it("reads a stored mapping defensively", () => {
    expect(readMapping({ title: "Name", status: { property: "S", values: { A: "done", B: "nope" } }, due: { property: "" }, x: 1 }))
      .toEqual({ title: "Name", status: { property: "S", values: { A: "done" } } });
    expect(readMapping({})).toBeNull();
    expect(readMapping("x")).toBeNull();
  });
});

describe("a page's fields", () => {
  it("reads mapped properties; missing or retyped ones take no part", () => {
    const f = readPage(page({ status: "Drafting", people: [person("u1", " Ana@Kanbo.TEST "), person("u2", null)], tags: ["Blog"], summary: "Hi" }), MAP);
    expect(f.title).toBe("Launch post");
    expect(f.status).toEqual({ type: "status", option: "Drafting" });
    expect(f.people).toEqual([{ id: "u1", email: "ana@kanbo.test", name: "u1" }, { id: "u2", email: null, name: "u2" }]);
    expect(f.tags).toEqual([{ name: "Blog", color: "green" }]);
    expect(f.description).toBe("Hi");
    expect(f.date).toBeNull();
    const g = readPage(page({}), { title: "Name", due: { property: "Owner" }, tags: { property: "Gone" } });
    expect(g.date).toBeUndefined();
    expect(g.tags).toBeUndefined();
    expect(readPage(page({ title: "  " }), MAP).title).toBe("Untitled");
  });
  it("a new task from a page", () => {
    const f = readPage(page({ status: "Published", date: { start: "2026-10-05", end: "2026-10-12" }, people: [person("u9", "zed@x.test"), person("u1", "bob@kanbo.test")], tags: ["Blog"], summary: "One.\n\nTwo." }), MAP);
    expect(taskFromPage(f, MAP, ctx)).toEqual({
      title: "Launch post", status: "done", due_date: "2026-10-12", start_date: "2026-10-05", assignee_id: BOB, tags: [{ name: "Blog", color: "green" }], description: "One.",
    });
    expect(taskFromPage(readPage(page({ status: "Parked", people: [person("u9", "zed@x.test")] }), MAP), MAP, ctx)).toMatchObject({ status: "todo", assignee_id: "" });
  });
});

describe("dates have one shape on each side", () => {
  it("canonical forms", () => {
    expect(canonNotionDate(null)).toEqual({ start: null, due: null });
    expect(canonNotionDate({ start: "2026-10-05", end: null })).toEqual({ start: null, due: "2026-10-05" });
    expect(canonNotionDate({ start: "2026-10-05T09:00:00Z", end: "2026-10-07" })).toEqual({ start: "2026-10-05", due: "2026-10-07" });
    expect(canonNotionDate({ start: "2026-10-05", end: "2026-10-05" })).toEqual({ start: null, due: "2026-10-05" });
    expect(canonTaskDate({ due_date: null, start_date: "2026-10-01" })).toEqual({ start: null, due: null });
    expect(canonTaskDate({ due_date: "2026-10-03", start_date: "2026-10-05" })).toEqual({ start: null, due: "2026-10-03" });
  });
});

describe("pull (Notion → Kanbo) and push (Kanbo → Notion)", () => {
  it("only fields that differ are pulled", () => {
    const f = readPage(page({ title: "Launch post v2", status: "Scheduled", date: { start: "2026-10-09" }, people: [person("u1", "ana@kanbo.test")], tags: ["blog", "LinkedIn"], summary: "New intro." }), MAP);
    const t = task({ status: "progress", tags: ["t-blog"], description: "Old intro.\n\nKanbo notes." });
    const { patch, changed } = pullPatch(f, t, MAP, ctx);
    expect(changed.sort()).toEqual(["assignee_id", "description", "due_date", "start_date", "tags", "title"]);
    expect(patch).toMatchObject({ title: "Launch post v2", due_date: "2026-10-09", start_date: null, assignee_id: ANA, description: "New intro.\n\nKanbo notes." });
    expect(patch.status).toBeUndefined();   // Scheduled already means "progress"
  });
  it("what can't be read isn't pulled: unmapped options, empty status, people who aren't members", () => {
    const f = readPage(page({ status: "Parked", people: [person("u9", "zed@x.test")] }), MAP);
    expect(pullPatch(f, task({ status: "blocked", assignee_id: BOB }), MAP, ctx).changed).toEqual([]);
    expect(pullPatch(readPage(page({ status: null }), MAP), task({ status: "review" }), MAP, ctx).changed).toEqual([]);
    expect(pullPatch(readPage(page({ people: [] }), MAP), task({ assignee_id: BOB }), MAP, ctx).patch.assignee_id).toBe("");
  });
  it("only fields that differ are pushed, in Notion's shapes", () => {
    const f = readPage(page({ status: "Scheduled", date: { start: "2026-10-05" }, people: [person("n-bob", "bob@kanbo.test")], tags: ["Blog"], summary: "Intro.\n\nNotion notes." }), MAP);
    const t = task({ title: "Launch post!", status: "done", due_date: "2026-10-12", start_date: "2026-10-05", assignee_id: ANA, tags: ["t-blog", "t-news", "unknown"], description: "Better intro.\n\nKanbo notes." });
    const { properties, changed } = pushProperties(t, f, MAP, ctx);
    expect(changed).toEqual(["title", "status", "due", "assignee", "tags", "description"]);
    expect(properties).toEqual({
      Name: { title: richText("Launch post!") },
      Status: { status: { name: "Published" } },
      "Publish date": { date: { start: "2026-10-05", end: "2026-10-12" } },
      Owner: { people: [{ object: "user", id: "n-ana" }] },
      Channels: { multi_select: [{ name: "Blog" }, { name: "Newsletter" }] },
      Summary: { rich_text: richText("Better intro.\n\nNotion notes.") },
    });
  });
  it("a status option that already means the task's status is kept; one Notion can't say is left alone", () => {
    const f = readPage(page({ status: "Scheduled" }), MAP);
    expect(pushProperties(task({ status: "progress" }), f, MAP, ctx).changed).toEqual([]);
    expect(pushProperties(task({ status: "blocked" }), f, MAP, ctx).changed).toEqual([]);
    expect(pushProperties(task({ status: "review" }), readPage(page({ status: "Parked" }), MAP), MAP, ctx).changed).toEqual([]);
    expect(pushProperties(task({ status: "todo" }), readPage(page({ status: null }), MAP), MAP, ctx).properties.Status).toEqual({ status: { name: "Idea" } });
    const sel = { ...MAP, status: { property: "Stage", values: { Now: "progress" as const } } };
    const p = page({});
    p.properties!.Stage = { type: "select", select: null };
    expect(pushProperties(task({ status: "progress" }), readPage(p, sel), sel, ctx).properties.Stage).toEqual({ select: { name: "Now" } });
  });
  it("an assignee with no Notion account isn't pushed; unassigning clears the people", () => {
    const f = readPage(page({ status: "Idea", people: [person("n-ana", "ana@kanbo.test")] }), MAP);
    expect(pushProperties(task({ assignee_id: BOB }), f, MAP, { ...ctx, notionUserByEmail: new Map() }).changed).toEqual([]);
    expect(pushProperties(task({ assignee_id: "" }), f, MAP, ctx).properties.Owner).toEqual({ people: [] });
    expect(pushProperties(task({ assignee_id: ANA }), f, MAP, ctx).changed).toEqual([]);
  });
  it("a round trip settles: what's pushed reads back as no change", () => {
    const t = task({ title: "Round trip", status: "done", due_date: "2026-10-12", start_date: "2026-10-01", assignee_id: BOB, tags: ["t-li"], description: "Para one.\n\nPara two." });
    const f0 = readPage(page({}), MAP);
    const { properties } = pushProperties(t, f0, MAP, ctx);
    const p = page({});
    for (const [k, v] of Object.entries(properties)) {
      const cur = p.properties![k];
      const val = (v as Record<string, unknown>)[cur.type];
      if (cur.type === "title" || cur.type === "rich_text") cur[cur.type] = (val as { text: { content: string } }[]).map((x) => ({ plain_text: x.text.content }));
      else if (cur.type === "people") cur.people = [person("n-bob", "bob@kanbo.test")];
      else if (cur.type === "multi_select") cur.multi_select = (val as { name: string }[]).map((o) => ({ name: o.name }));
      else cur[cur.type] = val;
    }
    const f1 = readPage(p, MAP);
    expect(pullPatch(f1, t, MAP, ctx).changed).toEqual([]);
    expect(pushProperties(t, f1, MAP, ctx).changed).toEqual([]);
  });
});

describe("text helpers and the cursor", () => {
  it("first paragraphs", () => {
    expect(splitFirstParagraph("One.\nStill one.\n\n\nTwo.\n\nThree.")).toEqual(["One.\nStill one.", "Two.\n\nThree."]);
    expect(splitFirstParagraph("\n\n  Only.  ")).toEqual(["Only.", ""]);
    expect(splitFirstParagraph("A\r\n\r\nB")).toEqual(["A", "B"]);
    expect(firstParagraph("")).toBe("");
    expect(withFirstParagraph("Old.\n\nRest.", "New.")).toBe("New.\n\nRest.");
    expect(withFirstParagraph("Old.\n\nRest.", "")).toBe("Rest.");
    expect(withFirstParagraph("", "New.")).toBe("New.");
  });
  it("tag colours", () => {
    expect(tagColour("green")).toMatch(/^oklch\(0\.75/);
    expect(tagColour("red_background")).toBe(tagColour("red"));
    expect(tagColour("nope")).toBe(tagColour("default"));
  });
  it("cursor round trip (≤ 200 characters)", () => {
    expect(parseCursor(null)).toEqual({ since: null, next: null });
    expect(parseCursor("2026-10-05T10:00:00.000Z")).toEqual({ since: "2026-10-05T10:00:00.000Z", next: null });
    const c = { since: "2026-10-05T10:00:00.000Z", next: "c-200" };
    expect(parseCursor(formatCursor(c))).toEqual(c);
    expect(parseCursor(JSON.stringify({ s: "nope", n: "bad cursor!" }))).toEqual({ since: null, next: null });
    expect(formatCursor({ since: null, next: null })).toBeNull();
    expect(formatCursor({ since: c.since, next: "x".repeat(150) })!.length).toBeLessThanOrEqual(200);
    expect(parseCursor("{not json")).toEqual({ since: null, next: null });
  });
});

describe("dates Notion could never send", () => {
  it("impossible days are not days", () => {
    expect(dayOf("2026-13-45")).toBeNull();
    expect(dayOf("2026-02-29")).toBeNull();
    expect(dayOf("2028-02-29")).toBe("2028-02-29");
  });
});
