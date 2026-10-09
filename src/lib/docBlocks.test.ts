/* The pure block model behind project docs (lib/docBlocks, re-exported by lib/docs). */
import { describe, expect, it } from "vitest";
import type { DocBlock, DocSpan } from "../data/types";
import {
  blockPlainText, bodyBytes, changeBlockType, cleanLinkInput, concatSpans, deleteRange, docKey, docWordCount, emptyBlock, ensureEditable,
  filterMembers, filterSlashCommands, hasMark, indentBlock, inlineMarkdownToSpans, insertSpans, insertText, isBlockEmpty, linkAt, listNumber,
  longDate, markdownShortcut, mergeBlocks, normaliseSpans, setLink, sliceSpans, spansLength, spansText, spansToMarkdown, splitBlock, toggleMark,
  SLASH_COMMANDS,
} from "./docBlocks";
import { blocksToMarkdown, docTemplate, markdownToBlocks, mentionsIn, newBlockId, taskLinksIn } from "./docs";
import { parseDocBody } from "./docs";

const p = (spans: DocSpan[] | string, extra: Partial<DocBlock> = {}): DocBlock => ({ id: extra.id ?? newBlockId(), type: "p", spans: typeof spans === "string" ? [{ text: spans }] : spans, ...extra });
const strip = (b: DocBlock[]) => b.map(({ id: _id, ...rest }) => rest);

describe("ids", () => {
  it("are short, prefixed and unique", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newBlockId()));
    expect(ids.size).toBe(2000);
    for (const id of [...ids].slice(0, 20)) expect(id).toMatch(/^b[0-9a-z]{10}$/);
  });
});

describe("spans", () => {
  const S: DocSpan[] = [{ text: "Hello " }, { text: "bold", marks: ["b"] }, { text: " and " }, { text: "@Sana", mention: "m-3" }, { text: " end" }];

  it("normalise: drop empties, order marks, join like runs, never join mentions", () => {
    expect(normaliseSpans([{ text: "" }, { text: "a", marks: ["i", "b"] }, { text: "b", marks: ["b", "i"] }, { text: "@A", mention: "1" }, { text: "@A", mention: "1" }, { text: "c", marks: [] }]))
      .toEqual([{ text: "ab", marks: ["b", "i"] }, { text: "@A", mention: "1" }, { text: "@A", mention: "1" }, { text: "c" }]);
    expect(normaliseSpans(undefined)).toEqual([]);
    expect(normaliseSpans([{ text: "x", href: "https://a.com" }, { text: "y", href: "https://b.com" }])).toHaveLength(2);
  });

  it("text, length and slices (a mention goes with its first character)", () => {
    expect(spansText(S)).toBe("Hello bold and @Sana end");
    expect(spansLength(S)).toBe(24);
    expect(sliceSpans(S, 3, 8)).toEqual([{ text: "lo " }, { text: "bo", marks: ["b"] }]);
    expect(sliceSpans(S, 15)).toEqual([{ text: "@Sana", mention: "m-3" }, { text: " end" }]);
    expect(sliceSpans(S, 16)).toEqual([{ text: " end" }]);            // inside the mention: it stays left
    expect(sliceSpans(S, 0, 16).slice(-1)).toEqual([{ text: "@Sana", mention: "m-3" }]);
    expect(sliceSpans(S, 5, 5)).toEqual([]);
  });

  it("insert text: takes the marks before it, a link only from inside", () => {
    expect(insertText([{ text: "ab", marks: ["b"] }], 2, "c")).toEqual([{ text: "abc", marks: ["b"] }]);
    expect(insertText([{ text: "ab", marks: ["b"] }], 0, "c")).toEqual([{ text: "c" }, { text: "ab", marks: ["b"] }]);
    const link: DocSpan[] = [{ text: "site", href: "https://a.com" }, { text: " x" }];
    expect(insertText(link, 2, "Z")[0]).toEqual({ text: "siZte", href: "https://a.com" });
    expect(insertText(link, 4, "Z")).toEqual([{ text: "site", href: "https://a.com" }, { text: "Z x" }]);
    expect(insertText([{ text: "@A", mention: "1" }], 2, "!")).toEqual([{ text: "@A", mention: "1" }, { text: "!" }]);
    expect(insertText([{ text: "a" }], 1, "")).toEqual([{ text: "a" }]);
    expect(insertSpans([{ text: "ac" }], 1, [{ text: "b", marks: ["i"] }])).toEqual([{ text: "a" }, { text: "b", marks: ["i"] }, { text: "c" }]);
  });

  it("delete a range", () => {
    expect(deleteRange(S, 0, 6)).toEqual(S.slice(1));
    expect(spansText(deleteRange(S, 6, 15))).toBe("Hello @Sana end");
    expect(deleteRange(S, 4, 4)).toEqual(S);
  });

  it("toggle a mark on a range: on when any of it lacks the mark, off when all has it; mentions untouched", () => {
    const on = toggleMark([{ text: "Hello world" }], 6, 11, "b");
    expect(on).toEqual([{ text: "Hello " }, { text: "world", marks: ["b"] }]);
    expect(toggleMark(on, 6, 11, "b")).toEqual([{ text: "Hello world" }]);
    const mixed = toggleMark(on, 0, 11, "b");
    expect(mixed).toEqual([{ text: "Hello world", marks: ["b"] }]);
    expect(toggleMark(mixed, 2, 4, "i")).toEqual([{ text: "He", marks: ["b"] }, { text: "ll", marks: ["b", "i"] }, { text: "o world", marks: ["b"] }]);
    expect(toggleMark(S, 0, 24, "code").find((s) => s.mention)).toEqual({ text: "@Sana", mention: "m-3" });
    expect(toggleMark(S, 3, 3, "b")).toEqual(S);
    expect(hasMark(on, 6, 11, "b")).toBe(true);
    expect(hasMark(on, 5, 11, "b")).toBe(false);
    expect(hasMark(on, 11, 11, "b")).toBe(true); // a caret asks about the character before it
    expect(hasMark([{ text: "@A", mention: "1" }], 0, 2, "b")).toBe(false);
  });

  it("links: set, find the whole link around a caret, unlink", () => {
    const l = setLink([{ text: "see the spec now" }], 8, 12, "https://acme.com/spec");
    expect(l).toEqual([{ text: "see the " }, { text: "spec", href: "https://acme.com/spec" }, { text: " now" }]);
    expect(linkAt(l, 10)).toEqual({ start: 8, end: 12, href: "https://acme.com/spec" });
    expect(linkAt(l, 12)).toEqual({ start: 8, end: 12, href: "https://acme.com/spec" });
    expect(linkAt(l, 2)).toBeNull();
    const bolded = toggleMark(l, 10, 12, "b");
    expect(linkAt(bolded, 9)).toEqual({ start: 8, end: 12, href: "https://acme.com/spec" });
    expect(setLink(l, 8, 12, null)).toEqual([{ text: "see the spec now" }]);
  });

  it("cleans what people type as a link: http(s) and mailto only", () => {
    expect(cleanLinkInput("https://acme.com/a?b=1#c")).toBe("https://acme.com/a?b=1#c");
    expect(cleanLinkInput(" acme.co.uk/spec ")).toBe("https://acme.co.uk/spec");
    expect(cleanLinkInput("acme.com:8080/x")).toBe("https://acme.com:8080/x");
    expect(cleanLinkInput("sana@acme.com")).toBe("mailto:sana@acme.com");
    expect(cleanLinkInput("mailto:sana@acme.com")).toBe("mailto:sana@acme.com");
    for (const bad of ["javascript:alert(1)", "java\tscript:alert(1)", "data:text/html,x", "vbscript:x", "file:///etc/passwd", "my notes", "", "localhost:3000", "https://"]) {
      expect(cleanLinkInput(bad), bad).toBeNull();
    }
  });
});

describe("blocks", () => {
  it("empty blocks of each type", () => {
    expect(emptyBlock("todo")).toMatchObject({ type: "todo", spans: [], checked: false });
    expect(emptyBlock("callout")).toMatchObject({ type: "callout", icon: "💡" });
    expect(emptyBlock("divider").spans).toBeUndefined();
    expect(isBlockEmpty(emptyBlock())).toBe(true);
    expect(isBlockEmpty(emptyBlock("divider"))).toBe(false);
  });

  it("change type keeps the text and task link; lists keep their indent", () => {
    const b: DocBlock = { id: "x", type: "bullet", spans: [{ text: "Ship it" }], indent: 2, taskId: "t-1" };
    expect(changeBlockType(b, "todo")).toEqual({ id: "x", type: "todo", spans: [{ text: "Ship it" }], checked: false, indent: 2, taskId: "t-1" });
    expect(changeBlockType(b, "h2")).toEqual({ id: "x", type: "h2", spans: [{ text: "Ship it" }], taskId: "t-1" });
    expect(changeBlockType(b, "divider")).toEqual({ id: "x", type: "divider" });
    expect(changeBlockType({ id: "c", type: "p", spans: [] }, "callout").icon).toBe("💡");
  });

  it("indent: lists only, 0–3", () => {
    const b: DocBlock = { id: "x", type: "bullet", spans: [] };
    expect(indentBlock(b, 1).indent).toBe(1);
    expect(indentBlock(indentBlock(indentBlock(indentBlock(b, 1), 1), 1), 1).indent).toBe(3);
    expect(indentBlock({ ...b, indent: 1 }, -1).indent).toBeUndefined();
    expect(indentBlock({ id: "p", type: "p", spans: [] }, 1)).toEqual({ id: "p", type: "p", spans: [] });
  });

  it("split at the caret: lists carry on (unticked), headings are followed by text", () => {
    const todo: DocBlock = { id: "t", type: "todo", spans: [{ text: "Call Sana" }], checked: true, taskId: "t-9", indent: 1 };
    const [a, b] = splitBlock(todo, 4);
    expect(a).toEqual({ id: "t", type: "todo", spans: [{ text: "Call" }], checked: true, taskId: "t-9", indent: 1 });
    expect(b).toMatchObject({ type: "todo", spans: [{ text: " Sana" }], checked: false, indent: 1 });
    expect(b.taskId).toBeUndefined();
    const [, h] = splitBlock({ id: "h", type: "h1", spans: [{ text: "Goals" }] }, 5);
    expect(h).toMatchObject({ type: "p", spans: [] });
    const [, q] = splitBlock({ id: "q", type: "quote", spans: [{ text: "ab" }] }, 1);
    expect(q.type).toBe("p");
  });

  it("Enter at the start of a line opens an empty one above and keeps the original (id, task) below", () => {
    const b: DocBlock = { id: "keep", type: "bullet", spans: [{ text: "x" }], taskId: "t-1" };
    const [above, below] = splitBlock(b, 0);
    expect(below).toBe(b);
    expect(above).toMatchObject({ type: "bullet", spans: [] });
    expect(above.id).not.toBe("keep");
  });

  it("merge: the text joins the line before, which keeps its type and id", () => {
    const m = mergeBlocks({ id: "a", type: "h2", spans: [{ text: "Plan", marks: ["b"] }] }, { id: "b", type: "p", spans: [{ text: " B", marks: ["b"] }], taskId: "t-2" });
    expect(m).toEqual({ id: "a", type: "h2", spans: [{ text: "Plan B", marks: ["b"] }], taskId: "t-2" });
  });

  it("Markdown shortcuts at the start of a paragraph", () => {
    const cases: [string, string, Partial<DocBlock>, number][] = [
      ["# Goals", "h1", { spans: [{ text: "Goals" }] }, 2],
      ["## Goals", "h2", {}, 3],
      ["### Goals", "h3", {}, 4],
      ["- milk", "bullet", { spans: [{ text: "milk" }] }, 2],
      ["* milk", "bullet", {}, 2],
      ["1. first", "numbered", {}, 3],
      ["[] buy", "todo", { checked: false }, 3],
      ["[ ] buy", "todo", { checked: false }, 4],
      ["[x] bought", "todo", { checked: true }, 4],
      ["> said", "quote", {}, 2],
      ["! note", "callout", { icon: "💡" }, 2],
    ];
    for (const [text, type, extra, removed] of cases) {
      const r = markdownShortcut(p(text, { id: "k" }))!;
      expect(r, text).not.toBeNull();
      expect(r.block, text).toMatchObject({ id: "k", type, ...extra });
      expect(r.removed, text).toBe(removed);
    }
    expect(markdownShortcut(p("---", { id: "d" }))).toEqual({ block: { id: "d", type: "divider" }, removed: 3 });
    expect(markdownShortcut(p("#hashtag"))).toBeNull();
    expect(markdownShortcut(p("2. second"))).toBeNull();
    expect(markdownShortcut({ id: "h", type: "h1", spans: [{ text: "- not a list" }] })).toBeNull();
    // a list item can become another kind of list
    expect(markdownShortcut({ id: "l", type: "bullet", spans: [{ text: "[] x" }], indent: 1 })?.block).toMatchObject({ type: "todo", indent: 1 });
    expect(markdownShortcut({ id: "l", type: "bullet", spans: [{ text: "- x" }] })).toBeNull();
    // marks after the trigger survive
    expect(markdownShortcut(p([{ text: "# " }, { text: "Bold", marks: ["b"] }]))?.block.spans).toEqual([{ text: "Bold", marks: ["b"] }]);
  });

  it("numbers numbered lists per level, through deeper items, restarting after anything else", () => {
    const L = (type: DocBlock["type"], indent = 0): DocBlock => ({ id: newBlockId(), type, spans: [], ...(indent ? { indent } : {}) });
    const list = [L("numbered"), L("numbered"), L("bullet", 1), L("numbered", 1), L("numbered", 1), L("numbered"), L("p"), L("numbered"), L("bullet"), L("numbered")];
    expect(list.map((_, i) => listNumber(list, i))).toEqual([1, 2, 0, 1, 2, 3, 0, 1, 0, 1]);
  });

  it("ensureEditable: one empty paragraph for an empty doc; duplicate or missing ids replaced", () => {
    expect(ensureEditable([])).toHaveLength(1);
    const fixed = ensureEditable([{ id: "a", type: "p", spans: [{ text: "x" }, { text: "y" }] }, { id: "a", type: "p" }, { id: "", type: "divider" }]);
    expect(new Set(fixed.map((b) => b.id)).size).toBe(3);
    expect(fixed[0]).toEqual({ id: "a", type: "p", spans: [{ text: "xy" }] });
    expect(fixed[1].spans).toEqual([]);
  });

  it("mentions and task links, in order, once each", () => {
    const body: DocBlock[] = [
      p([{ text: "@Sana", mention: "m-3" }, { text: " and " }, { text: "@Maya", mention: "m-1" }]),
      p([{ text: "@Sana", mention: "m-3" }], { taskId: "t-2" }),
      { id: "x", type: "todo", spans: [{ text: "x" }], taskId: "t-1" },
      { id: "y", type: "todo", spans: [{ text: "y" }], taskId: "t-2" },
    ];
    expect(mentionsIn(body)).toEqual(["m-3", "m-1"]);
    expect(taskLinksIn(body)).toEqual(["t-2", "t-1"]);
  });

  it("plain text of a line (task titles): names, no line breaks", () => {
    const b = p([{ text: "Ask " }, { text: "@Sana", mention: "m-3" }, { text: " about\nthe  tokens" }]);
    expect(blockPlainText(b)).toBe("Ask Sana about the tokens");
    expect(blockPlainText(b, (id) => (id === "m-3" ? "Sana Rao" : undefined))).toBe("Ask Sana Rao about the tokens");
  });

  it("word count, size and change key", () => {
    expect(docWordCount([p("It's the team’s launch-day plan, v2."), { id: "d", type: "divider" }])).toBe(6);
    const body = [p("é")];
    expect(bodyBytes(body)).toBe(new TextEncoder().encode(JSON.stringify(body)).length);
    expect(docKey("a", body)).not.toBe(docKey("b", body));
  });
});

describe("the slash menu and @people", () => {
  it("finds commands by label, word and keyword", () => {
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands("head").map((c) => c.id)).toEqual(["h1", "h2", "h3"]);
    expect(filterSlashCommands("todo")[0].id).toBe("todo");
    expect(filterSlashCommands("list").map((c) => c.id)).toEqual(expect.arrayContaining(["bullet", "numbered", "todo"]));
    expect(filterSlashCommands("task")[0].id).toBe("task");
    expect(filterSlashCommands("hr")[0].id).toBe("divider");
    expect(filterSlashCommands("zzz")).toEqual([]);
    expect(filterSlashCommands("", { canMakeTask: false, canMention: false }).some((c) => c.action)).toBe(false);
  });
  it("finds people by any name, starts first", () => {
    const people = [{ id: "1", name: "Maya Lin" }, { id: "2", name: "Sana Rao" }, { id: "3", name: "Theo Vance" }, { id: "4", name: "Rasa Lindqvist" }];
    expect(filterMembers(people, "ra").map((m) => m.id)).toEqual(["2", "4"]);
    expect(filterMembers(people, "lin").map((m) => m.id)).toEqual(["1", "4"]);
    expect(filterMembers(people, "").length).toBe(4);
    expect(filterMembers(people, "", 2).length).toBe(2);
  });
});

describe("templates", () => {
  const ctx = { projectName: "Q3 Product Launch", today: "2026-10-09" };
  it("each has a title, an icon and valid blocks with unique ids", () => {
    for (const id of ["blank", "brief", "meeting", "decisions", "retro"] as const) {
      const t = docTemplate(id, ctx);
      expect(t.icon, id).toBeTruthy();
      expect(t.body.length, id).toBeGreaterThan(0);
      expect(new Set(t.body.map((b) => b.id)).size, id).toBe(t.body.length);
      expect(parseDocBody(JSON.parse(JSON.stringify(t.body))), id).toEqual(t.body); // survives storage untouched
    }
  });
  it("writes dates the British way and names the project", () => {
    expect(longDate("2026-10-09")).toBe("9 October 2026");
    expect(docTemplate("meeting", ctx).title).toBe("Meeting notes, 9 October 2026");
    expect(docTemplate("brief", ctx).title).toBe("Q3 Product Launch: project brief");
    expect(docTemplate("retro", ctx).title).toBe("Retro, 9 October 2026");
    expect(docTemplate("decisions", ctx).body.some((b) => b.type === "h3" && spansText(b.spans).startsWith("9 October 2026"))).toBe(true);
    expect(docTemplate("blank", ctx)).toMatchObject({ title: "", icon: "📄" });
    expect(docTemplate("brief", { projectName: "  ", today: "2026-10-09" }).title).toBe("this project: project brief");
  });
  it("fresh ids every time", () => {
    expect(docTemplate("brief", ctx).body[0].id).not.toBe(docTemplate("brief", ctx).body[0].id);
  });
});

describe("Markdown out", () => {
  const names = (id: string) => ({ "m-3": "Sana Rao" } as Record<string, string>)[id];
  it("inline marks, links, code and mentions", () => {
    expect(spansToMarkdown([{ text: "a " }, { text: "b", marks: ["b"] }, { text: " " }, { text: "i", marks: ["i"] }, { text: " " }, { text: "x*y", marks: ["code"] }])).toBe("a **b** *i* `x*y`");
    expect(spansToMarkdown([{ text: "both", marks: ["b", "i"] }])).toBe("***both***");
    expect(spansToMarkdown([{ text: "spec", href: "https://a.com/(x) y" }])).toBe("[spec](https://a.com/%28x%29%20y)");
    expect(spansToMarkdown([{ text: "@Sana", mention: "m-3" }], names)).toBe("@Sana Rao");
    expect(spansToMarkdown([{ text: "@Gone", mention: "m-x" }], names)).toBe("@Gone");
    expect(spansToMarkdown([{ text: " padded ", marks: ["b"] }])).toBe(" **padded** ");
    expect(spansToMarkdown([{ text: "2*3 = [6]_" }])).toBe("2\\*3 = \\[6\\]\\_");
  });
  it("a whole doc: title, headings, lists (nested and numbered), checklists, quote, callout, divider, tasks", () => {
    const body: DocBlock[] = [
      { id: "1", type: "h1", spans: [{ text: "Why" }] },
      { id: "2", type: "p", spans: [{ text: "Because " }, { text: "now", marks: ["b"] }, { text: "." }] },
      { id: "3", type: "bullet", spans: [{ text: "one" }] },
      { id: "4", type: "bullet", spans: [{ text: "nested" }], indent: 1 },
      { id: "5", type: "numbered", spans: [{ text: "first" }] },
      { id: "6", type: "numbered", spans: [{ text: "second" }] },
      { id: "7", type: "todo", spans: [{ text: "done thing" }], checked: true },
      { id: "8", type: "quote", spans: [{ text: "Ship it" }] },
      { id: "9", type: "callout", spans: [{ text: "Heads up" }], icon: "⚠️" },
      { id: "10", type: "divider" },
      { id: "11", type: "p", spans: [{ text: "Ask " }, { text: "@Sana", mention: "m-3" }], taskId: "t-1" },
      { id: "12", type: "h3", spans: [{ text: "# not a heading" }] },
      { id: "13", type: "p", spans: [{ text: "- not a list" }] },
    ];
    const md = blocksToMarkdown("Launch brief", body, { memberName: names, taskDone: (t) => t === "t-1" });
    expect(md).toBe([
      "# Launch brief", "",
      "# Why", "",
      "Because **now**.", "",
      "- one",
      "  - nested",
      "1. first",
      "2. second",
      "- [x] done thing", "",
      "> Ship it", "",
      "> ⚠️ Heads up", "",
      "---", "",
      "- [x] Ask @Sana Rao", "",
      "### # not a heading", "",
      "\\- not a list", "",
    ].join("\n"));
  });
  it("an open task line is unticked; an untitled doc has no title line", () => {
    expect(blocksToMarkdown("", [p("Do it", { taskId: "t-9" })], { taskDone: () => false })).toBe("- [ ] Do it\n");
    expect(blocksToMarkdown("", [{ id: "x", type: "todo", spans: [{ text: "Kept" }], checked: true, taskId: "t-gone" }])).toBe("- [x] Kept\n");
  });
});

describe("Markdown in (paste / import)", () => {
  it("inline: bold, italic, both, code, links (safe only), bare links, escapes, snake_case left alone", () => {
    expect(inlineMarkdownToSpans("a **b** *i* _j_ __k__ `c*d`")).toEqual([
      { text: "a " }, { text: "b", marks: ["b"] }, { text: " " }, { text: "i", marks: ["i"] }, { text: " " }, { text: "j", marks: ["i"] }, { text: " " },
      { text: "k", marks: ["b"] }, { text: " " }, { text: "c*d", marks: ["code"] },
    ]);
    expect(inlineMarkdownToSpans("***both***")).toEqual([{ text: "both", marks: ["b", "i"] }]);
    expect(inlineMarkdownToSpans("**_both_**")).toEqual([{ text: "both", marks: ["b", "i"] }]);
    expect(inlineMarkdownToSpans("see [the **spec**](https://acme.com/spec)")).toEqual([
      { text: "see " }, { text: "the ", href: "https://acme.com/spec" }, { text: "spec", marks: ["b"], href: "https://acme.com/spec" },
    ]);
    expect(inlineMarkdownToSpans("[x](javascript:alert(1))")).toEqual([{ text: "x)" }]); // the label stays, unlinked
    expect(inlineMarkdownToSpans("go to https://acme.com/a.")).toEqual([{ text: "go to " }, { text: "https://acme.com/a", href: "https://acme.com/a" }, { text: "." }]);
    expect(inlineMarkdownToSpans("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { text: "(" }, { text: "https://en.wikipedia.org/wiki/Foo_(bar)", href: "https://en.wikipedia.org/wiki/Foo_(bar)" }, { text: ")" },
    ]);
    expect(inlineMarkdownToSpans("2\\*3 \\[x\\]")).toEqual([{ text: "2*3 [x]" }]);
    expect(inlineMarkdownToSpans("snake_case_name and 2 * 3 * 4")).toEqual([{ text: "snake_case_name and 2 * 3 * 4" }]);
    expect(inlineMarkdownToSpans("**unclosed")).toEqual([{ text: "**unclosed" }]);
  });

  it("blocks: headings, lists with nesting, checklists, quotes, callouts, rules, code fences, plain lines", () => {
    const md = [
      "# Title", "## Sub", "### Small", "#### Smaller", "",
      "- a", "  - b", "    * c", "+ d", "1. one", "2) two",
      "- [ ] open", "- [x] done", "[ ] bare",
      "> quoted", "> carries on", "",
      "> 💡 a callout",
      "***",
      "```", "const x = 1;", "```",
      "Plain line one", "Plain line two",
      "Soft break  ", "same block",
    ].join("\n");
    const out = markdownToBlocks(md);
    expect(strip(out)).toEqual([
      { type: "h1", spans: [{ text: "Title" }] },
      { type: "h2", spans: [{ text: "Sub" }] },
      { type: "h3", spans: [{ text: "Small" }] },
      { type: "h3", spans: [{ text: "Smaller" }] },
      { type: "bullet", spans: [{ text: "a" }] },
      { type: "bullet", spans: [{ text: "b" }], indent: 1 },
      { type: "bullet", spans: [{ text: "c" }], indent: 2 },
      { type: "bullet", spans: [{ text: "d" }] },
      { type: "numbered", spans: [{ text: "one" }] },
      { type: "numbered", spans: [{ text: "two" }] },
      { type: "todo", spans: [{ text: "open" }], checked: false },
      { type: "todo", spans: [{ text: "done" }], checked: true },
      { type: "todo", spans: [{ text: "bare" }], checked: false },
      { type: "quote", spans: [{ text: "quoted\ncarries on" }] },
      { type: "callout", spans: [{ text: "a callout" }], icon: "💡" },
      { type: "divider" },
      { type: "p", spans: [{ text: "const x = 1;", marks: ["code"] }] },
      { type: "p", spans: [{ text: "Plain line one" }] },
      { type: "p", spans: [{ text: "Plain line two" }] },
      { type: "p", spans: [{ text: "Soft break\nsame block" }] },
    ]);
    expect(new Set(out.map((b) => b.id)).size).toBe(out.length);
  });

  it("CRLF, tabs, blank lines and nothing at all", () => {
    expect(strip(markdownToBlocks("a\r\n\r\n\tb"))).toEqual([{ type: "p", spans: [{ text: "a" }] }, { type: "p", spans: [{ text: "b" }] }]);
    expect(markdownToBlocks("")).toEqual([]);
    expect(markdownToBlocks("   \n\n")).toEqual([]);
    expect(strip(markdownToBlocks("-\n1.")).map((b) => b.type)).toEqual(["bullet", "numbered"]);
  });

  it("round trip: export then import gives the same blocks (bar ids, mentions as text, task lines as checklists)", () => {
    const body: DocBlock[] = [
      { id: "1", type: "h1", spans: [{ text: "Goals" }] },
      { id: "2", type: "h2", spans: [{ text: "Now" }] },
      { id: "3", type: "p", spans: [{ text: "Plain " }, { text: "bold", marks: ["b"] }, { text: " " }, { text: "it", marks: ["i"] }, { text: " " }, { text: "both", marks: ["b", "i"] }, { text: " " }, { text: "code", marks: ["code"] }, { text: " " }, { text: "link", href: "https://acme.com/x" }, { text: " 2*3_4 [x]" }] },
      { id: "4", type: "bullet", spans: [{ text: "a" }] },
      { id: "5", type: "bullet", spans: [{ text: "b" }], indent: 2 },
      { id: "6", type: "numbered", spans: [{ text: "n1" }] },
      { id: "7", type: "numbered", spans: [{ text: "n2" }] },
      { id: "8", type: "todo", spans: [{ text: "t" }], checked: false },
      { id: "9", type: "todo", spans: [{ text: "u" }], checked: true, indent: 1 },
      { id: "10", type: "quote", spans: [{ text: "q1\nq2" }] },
      { id: "11", type: "callout", spans: [{ text: "c" }], icon: "⚖️" },
      { id: "12", type: "divider" },
      { id: "13", type: "p", spans: [{ text: "# hash, - dash, > angle" }] },
      { id: "14", type: "p", spans: [{ text: "line\nbreak" }] },
    ];
    const back = markdownToBlocks(blocksToMarkdown("Doc", body));
    expect(strip(back)).toEqual([{ type: "h1", spans: [{ text: "Doc" }] }, ...strip(body)]);
  });

  it("whatever comes in parses as a valid stored body", () => {
    const nasty = "<script>alert(1)</script>\n[a](data:text/html,x)\n- [ ] `\n> \n# \n\u0000\n" + "x".repeat(5000);
    const out = markdownToBlocks(nasty);
    expect(parseDocBody(JSON.parse(JSON.stringify(out)))).toEqual(out);
    expect(out.flatMap((b) => b.spans ?? []).some((s) => s.href)).toBe(false);
    expect(spansText(out[0].spans)).toBe("<script>alert(1)</script>"); // text, never markup
  });
});

describe("concat", () => {
  it("joins and normalises", () => {
    expect(concatSpans([{ text: "a", marks: ["b"] }], undefined, [{ text: "b", marks: ["b"] }])).toEqual([{ text: "ab", marks: ["b"] }]);
  });
});
