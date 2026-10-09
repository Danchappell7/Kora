/* ============================================================
   KANBO — the block model for project docs.                  [0047, w5]
   Pure (no DOM, no network): spans and their marks, blocks and the
   edits the editor makes to them (split, merge, change type, indent,
   Markdown shortcuts, the slash menu's commands), list numbering,
   the starter templates, and Markdown import / export.

   A doc body is DocBlock[] (data/types). A text block holds spans:
   runs of text with marks (b, i, code), an optional link (http(s) /
   mailto only) or an @mention (an atomic span: its text is "@Name").
   Offsets are UTF-16 positions in the block's plain text (a mention
   counts as its text). Every function returns new objects and never
   changes its arguments. lib/docs re-exports the public names.
   ============================================================ */
import type { DocBlock, DocBlockType, DocMark, DocSpan, DocTemplateId } from "../data/types";

/* ------------------------------------------------------------ ids */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** A block id unique within a doc ("b" + 10 random base-36 characters). */
export function newBlockId(): string {
  const bytes = new Uint8Array(10);
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = "b";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

/* ------------------------------------------------------------ spans */

const MARK_ORDER: readonly DocMark[] = ["b", "i", "code"];
const sortMarks = (m: readonly DocMark[] | undefined): DocMark[] => MARK_ORDER.filter((x) => m?.includes(x));
const sameMarks = (a: readonly DocMark[] | undefined, b: readonly DocMark[] | undefined) => sortMarks(a).join() === sortMarks(b).join();
/** Two spans can join into one run: same marks, same link, neither a mention. */
const joinable = (a: DocSpan, b: DocSpan) => !a.mention && !b.mention && (a.href ?? "") === (b.href ?? "") && sameMarks(a.marks, b.marks);

function cleanSpan(s: DocSpan): DocSpan {
  const out: DocSpan = { text: s.text };
  const marks = sortMarks(s.marks);
  if (marks.length) out.marks = marks;
  if (s.href) out.href = s.href;
  if (s.mention) out.mention = s.mention;
  return out;
}

/** Canonical spans: empty runs dropped, marks in one order, neighbours with the same formatting joined. */
export function normaliseSpans(spans: readonly DocSpan[] | undefined): DocSpan[] {
  const out: DocSpan[] = [];
  for (const raw of spans ?? []) {
    if (!raw || typeof raw.text !== "string" || !raw.text) continue;
    const s = cleanSpan(raw);
    const prev = out[out.length - 1];
    if (prev && joinable(prev, s)) out[out.length - 1] = { ...prev, text: prev.text + s.text };
    else out.push(s);
  }
  return out;
}

export function spansText(spans: readonly DocSpan[] | undefined): string {
  let t = "";
  for (const s of spans ?? []) t += s.text;
  return t;
}
export const spansLength = (spans: readonly DocSpan[] | undefined): number => spansText(spans).length;

/** The spans covering [start, end). A mention is atomic: it goes wherever its first character goes. */
export function sliceSpans(spans: readonly DocSpan[] | undefined, start: number, end = Infinity): DocSpan[] {
  const out: DocSpan[] = [];
  let pos = 0;
  for (const s of spans ?? []) {
    const a = pos, b = pos + s.text.length;
    pos = b;
    if (s.mention) {
      if (a >= start && a < end) out.push(cleanSpan(s));
      continue;
    }
    const from = Math.max(a, start), to = Math.min(b, end);
    if (to > from) out.push({ ...cleanSpan(s), text: s.text.slice(from - a, to - a) });
  }
  return normaliseSpans(out);
}

export const concatSpans = (...parts: Array<readonly DocSpan[] | undefined>): DocSpan[] => normaliseSpans(parts.flatMap((p) => p ?? []));

/** Insert spans at an offset. */
export function insertSpans(spans: readonly DocSpan[] | undefined, at: number, ins: readonly DocSpan[]): DocSpan[] {
  return concatSpans(sliceSpans(spans, 0, at), ins, sliceSpans(spans, at));
}

/** The span a character belongs to, and where it starts. */
function spanAt(spans: readonly DocSpan[] | undefined, index: number): { span: DocSpan; start: number } | null {
  let pos = 0;
  for (const s of spans ?? []) {
    if (index >= pos && index < pos + s.text.length) return { span: s, start: pos };
    pos += s.text.length;
  }
  return null;
}

/** Type text at an offset: it takes the marks of the character before it (never a mention), and a link only from inside one. */
export function insertText(spans: readonly DocSpan[] | undefined, at: number, text: string, marks?: DocMark[]): DocSpan[] {
  if (!text) return normaliseSpans(spans);
  const before = at > 0 ? spanAt(spans, at - 1)?.span : undefined;
  const after = spanAt(spans, at)?.span;
  const piece: DocSpan = { text };
  const m = marks ?? (before && !before.mention ? before.marks : undefined);
  if (m?.length) piece.marks = sortMarks(m);
  if (before?.href && after?.href === before.href) piece.href = before.href;
  return insertSpans(spans, at, [piece]);
}

export function deleteRange(spans: readonly DocSpan[] | undefined, start: number, end: number): DocSpan[] {
  if (end <= start) return normaliseSpans(spans);
  return concatSpans(sliceSpans(spans, 0, start), sliceSpans(spans, end));
}

/** Change every non-mention run in [start, end) with fn. */
function mapRange(spans: readonly DocSpan[] | undefined, start: number, end: number, fn: (s: DocSpan) => DocSpan): DocSpan[] {
  const out: DocSpan[] = [];
  let pos = 0;
  for (const s of spans ?? []) {
    const a = pos, b = pos + s.text.length;
    pos = b;
    if (s.mention || b <= start || a >= end) { out.push(s); continue; }
    const from = Math.max(a, start), to = Math.min(b, end);
    if (from > a) out.push({ ...s, text: s.text.slice(0, from - a) });
    out.push(fn({ ...s, text: s.text.slice(from - a, to - a) }));
    if (to < b) out.push({ ...s, text: s.text.slice(to - a) });
  }
  return normaliseSpans(out);
}

/** Is every (non-mention) character in [start, end) marked? A collapsed range asks about the character before it. */
export function hasMark(spans: readonly DocSpan[] | undefined, start: number, end: number, mark: DocMark): boolean {
  if (end <= start) {
    const s = start > 0 ? spanAt(spans, start - 1)?.span : undefined;
    return !!s && !s.mention && !!s.marks?.includes(mark);
  }
  let pos = 0, any = false;
  for (const s of spans ?? []) {
    const a = pos, b = pos + s.text.length;
    pos = b;
    if (s.mention || b <= start || a >= end) continue;
    any = true;
    if (!s.marks?.includes(mark)) return false;
  }
  return any;
}

/** ⌘B / ⌘I / ⌘E: add the mark to [start, end), or take it off when the whole range already has it. */
export function toggleMark(spans: readonly DocSpan[] | undefined, start: number, end: number, mark: DocMark): DocSpan[] {
  if (end <= start) return normaliseSpans(spans);
  const on = !hasMark(spans, start, end, mark);
  return mapRange(spans, start, end, (s) => {
    const marks = on ? sortMarks([...(s.marks ?? []), mark]) : (s.marks ?? []).filter((m) => m !== mark);
    const out: DocSpan = { text: s.text };
    if (marks.length) out.marks = marks;
    if (s.href) out.href = s.href;
    return out;
  });
}

/** Link [start, end) to href, or unlink it (null). */
export function setLink(spans: readonly DocSpan[] | undefined, start: number, end: number, href: string | null): DocSpan[] {
  if (end <= start) return normaliseSpans(spans);
  return mapRange(spans, start, end, (s) => {
    const out: DocSpan = { text: s.text };
    if (s.marks?.length) out.marks = s.marks;
    if (href) out.href = href;
    return out;
  });
}

/** The whole link around an offset (the character before or after it): its range and address. */
export function linkAt(spans: readonly DocSpan[] | undefined, offset: number): { start: number; end: number; href: string } | null {
  const hit = (offset > 0 ? spanAt(spans, offset - 1) : null) ?? spanAt(spans, offset);
  if (!hit?.span.href) return null;
  const href = hit.span.href;
  // runs with the same link but different marks sit side by side: take them all
  const list = spans ?? [];
  let pos = 0;
  const ranges: { a: number; b: number; href?: string }[] = list.map((s) => { const r = { a: pos, b: pos + s.text.length, href: s.href }; pos = r.b; return r; });
  let i = ranges.findIndex((r) => r.a === hit.start);
  let j = i;
  while (i > 0 && ranges[i - 1].href === href) i--;
  while (j < ranges.length - 1 && ranges[j + 1].href === href) j++;
  return { start: ranges[i].a, end: ranges[j].b, href };
}

/** A link address someone typed (⌘K): http(s) and mailto only; "acme.com" gets https://, an email mailto:. */
export function cleanLinkInput(raw: string): string | null {
  // controls and invisible characters out first, so "java\tscript:" can't pass as anything
  // eslint-disable-next-line no-control-regex
  const s = String(raw ?? "").replace(/[\u0000-\u001F\u007F-\u009F­​-‏‪-‮⁠-⁤﻿]/g, "").trim();
  if (!s || /\s/.test(s)) return null;
  if (/^https?:\/\/[^/?#\\\s]+/i.test(s)) return s;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:/]+\.[a-z]{2,}(:\d+)?([/?#]|$)/i.test(s)) return null; // another scheme
  if (/^[^\s@/:]+@[^\s@/]+\.[a-z]{2,}$/i.test(s)) return "mailto:" + s;
  if (/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:[/?#]\S*)?$/i.test(s)) return "https://" + s;
  return null;
}

/* ------------------------------------------------------------ blocks */

export const LIST_TYPES: ReadonlySet<DocBlockType> = new Set<DocBlockType>(["bullet", "numbered", "todo"]);
export const isListType = (t: DocBlockType) => LIST_TYPES.has(t);
export const isHeading = (t: DocBlockType) => t === "h1" || t === "h2" || t === "h3";
export const MAX_INDENT = 3;
export const DEFAULT_CALLOUT_ICON = "💡";

/** What each block type is called (menus, screen readers). */
export const BLOCK_LABEL: Readonly<Record<DocBlockType, string>> = {
  p: "Text", h1: "Heading 1", h2: "Heading 2", h3: "Heading 3", bullet: "Bulleted list", numbered: "Numbered list",
  todo: "Checklist", quote: "Quote", divider: "Divider", callout: "Callout",
};

export function emptyBlock(type: DocBlockType = "p", extra: Partial<DocBlock> = {}): DocBlock {
  const b: DocBlock = { id: newBlockId(), type };
  if (type !== "divider") b.spans = [];
  if (type === "todo") b.checked = false;
  if (type === "callout") b.icon = DEFAULT_CALLOUT_ICON;
  return { ...b, ...extra };
}

export const blockText = (b: DocBlock): string => spansText(b.spans);
export const isBlockEmpty = (b: DocBlock): boolean => b.type !== "divider" && !blockText(b);

/** Turn a block into another type, keeping its text (and its task link). */
export function changeBlockType(b: DocBlock, type: DocBlockType): DocBlock {
  const out: DocBlock = { id: b.id, type };
  if (type !== "divider") out.spans = normaliseSpans(b.spans);
  if (type === "todo") out.checked = b.type === "todo" ? !!b.checked : false;
  if (type === "callout") out.icon = b.icon || DEFAULT_CALLOUT_ICON;
  if (isListType(type) && b.indent && isListType(b.type)) out.indent = b.indent;
  if (b.taskId && type !== "divider") out.taskId = b.taskId;
  return out;
}

export function withSpans(b: DocBlock, spans: readonly DocSpan[]): DocBlock {
  return { ...b, spans: normaliseSpans(spans) };
}

/** Indent / outdent a list item (0–3). Other blocks don't nest. */
export function indentBlock(b: DocBlock, delta: number): DocBlock {
  if (!isListType(b.type)) return b;
  const indent = Math.max(0, Math.min(MAX_INDENT, (b.indent ?? 0) + delta));
  const out = { ...b };
  if (indent) out.indent = indent; else delete out.indent;
  return out;
}

/** Enter at an offset. Lists carry on (a checklist item starts unticked); headings, quotes and callouts are
 *  followed by text. Enter at the very start of a non-empty block opens an empty one above instead, and the
 *  caret stays with the text (the second block keeps the original id and task link). */
export function splitBlock(b: DocBlock, offset: number): [DocBlock, DocBlock] {
  const text = blockText(b);
  const nextType: DocBlockType = isListType(b.type) ? b.type : "p";
  if (offset <= 0 && text) {
    const above: DocBlock = { id: newBlockId(), type: isListType(b.type) ? b.type : "p", spans: [] };
    if (above.type === "todo") above.checked = false;
    if (b.indent && isListType(b.type)) above.indent = b.indent;
    return [above, b];
  }
  const left: DocBlock = { ...b, spans: sliceSpans(b.spans, 0, offset) };
  const right: DocBlock = { id: newBlockId(), type: nextType, spans: sliceSpans(b.spans, offset) };
  if (nextType === "todo") right.checked = false;
  if (b.indent && isListType(b.type)) right.indent = b.indent;
  return [left, right];
}

/** Backspace at the start of `cur`: its text joins the end of `prev` (which keeps its type, id and task link). */
export function mergeBlocks(prev: DocBlock, cur: DocBlock): DocBlock {
  const out: DocBlock = { ...prev, spans: concatSpans(prev.spans, cur.spans) };
  if (!out.taskId && cur.taskId) out.taskId = cur.taskId;
  return out;
}

/** Markdown typed at the start of a text block ("# ", "- ", "1. ", "[] ", "> ", "---"): the block it becomes, with
 *  the trigger removed, or null. Only fires on a plain paragraph (and turns a list item into another list). */
export function markdownShortcut(b: DocBlock): { block: DocBlock; removed: number } | null {
  if (b.type === "divider") return null;
  const text = blockText(b);
  if (b.type === "p" && text === "---") return { block: { id: b.id, type: "divider" }, removed: 3 };
  const rules: [RegExp, DocBlockType, boolean?][] = [
    [/^#\s/, "h1"], [/^##\s/, "h2"], [/^###\s/, "h3"],
    [/^[-*+]\s/, "bullet"], [/^1[.)]\s/, "numbered"],
    [/^\[\s?\]\s/, "todo"], [/^\[[xX]\]\s/, "todo", true],
    [/^>\s/, "quote"], [/^!\s/, "callout"],
  ];
  for (const [re, type, checked] of rules) {
    const m = text.match(re);
    if (!m) continue;
    if (b.type !== "p" && !(isListType(b.type) && isListType(type))) return null;
    if (b.type === type) return null;
    const removed = m[0].length;
    const next = changeBlockType({ ...b, spans: sliceSpans(b.spans, removed) }, type);
    if (type === "todo") next.checked = !!checked;
    if (isListType(type) && b.indent) next.indent = b.indent;
    return { block: next, removed };
  }
  return null;
}

/** The number a numbered-list item shows: it counts back over the items at its own level, through deeper ones. */
export function listNumber(blocks: readonly DocBlock[], index: number): number {
  const b = blocks[index];
  if (!b || b.type !== "numbered") return 0;
  const level = b.indent ?? 0;
  let n = 1;
  for (let i = index - 1; i >= 0; i--) {
    const p = blocks[i];
    const pl = p.indent ?? 0;
    if (!isListType(p.type)) break;
    if (pl > level) continue;
    if (pl < level) break;
    if (p.type !== "numbered") break;
    n++;
  }
  return n;
}

/** A body ready to edit: at least one block, every id present and unique. */
export function ensureEditable(blocks: readonly DocBlock[] | undefined): DocBlock[] {
  const seen = new Set<string>();
  const out = (blocks ?? []).map((b) => {
    let id = b.id;
    while (!id || seen.has(id)) id = newBlockId();
    seen.add(id);
    const copy: DocBlock = { ...b, id };
    if (copy.type !== "divider") copy.spans = normaliseSpans(copy.spans);
    return copy;
  });
  return out.length ? out : [emptyBlock()];
}

/** For "have the contents changed?": the title and blocks as one string. */
export const docKey = (title: string, blocks: readonly DocBlock[]): string => JSON.stringify([title, blocks]);

/** The body's JSON size in bytes (the server takes 1 MB). */
export function bodyBytes(blocks: readonly DocBlock[]): number {
  const json = JSON.stringify(blocks);
  if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(json).length;
  return unescape(encodeURIComponent(json)).length;
}

/** Every member id the doc @mentions, in order (send as DocSaveInput.mentions). */
export function mentionsIn(blocks: readonly DocBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) for (const s of b.spans ?? []) if (s.mention && !out.includes(s.mention)) out.push(s.mention);
  return out;
}

/** Every task id a "Make task" line links to, in order. */
export function taskLinksIn(blocks: readonly DocBlock[]): string[] {
  const out: string[] = [];
  for (const b of blocks) if (b.taskId && !out.includes(b.taskId)) out.push(b.taskId);
  return out;
}

/** A block's words for a task title or a search: mentions as the name ("Sana"), line breaks as spaces. */
export function blockPlainText(b: DocBlock, memberName?: (id: string) => string | undefined): string {
  return (b.spans ?? []).map((s) => (s.mention ? memberName?.(s.mention) ?? s.text.replace(/^@/, "") : s.text)).join("").replace(/\s+/g, " ").trim();
}

export function docWordCount(blocks: readonly DocBlock[]): number {
  let n = 0;
  for (const b of blocks) n += (blockText(b).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
  return n;
}

/* ------------------------------------------------------------ the slash menu */

export interface SlashCommand {
  id: string;
  label: string;
  /** one line under the label */
  hint: string;
  /** what typing finds it by (besides its label) */
  keywords: string[];
  /** the block type it turns the line into */
  type?: DocBlockType;
  /** an action instead of a type */
  action?: "task" | "mention";
  /** the Markdown that does the same, shown on the right */
  shortcut?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { id: "p", label: "Text", hint: "Plain writing", keywords: ["paragraph", "plain", "body"], type: "p" },
  { id: "h1", label: "Heading 1", hint: "A big section heading", keywords: ["title", "h1", "heading"], type: "h1", shortcut: "#" },
  { id: "h2", label: "Heading 2", hint: "A medium heading", keywords: ["subtitle", "h2", "heading"], type: "h2", shortcut: "##" },
  { id: "h3", label: "Heading 3", hint: "A small heading", keywords: ["h3", "heading"], type: "h3", shortcut: "###" },
  { id: "bullet", label: "Bulleted list", hint: "A simple list", keywords: ["bullet", "unordered", "ul", "list"], type: "bullet", shortcut: "-" },
  { id: "numbered", label: "Numbered list", hint: "A list in order", keywords: ["ordered", "number", "ol", "list"], type: "numbered", shortcut: "1." },
  { id: "todo", label: "Checklist", hint: "Items to tick off", keywords: ["todo", "to-do", "check", "checkbox", "list"], type: "todo", shortcut: "[]" },
  { id: "quote", label: "Quote", hint: "Someone's words", keywords: ["quote", "blockquote", "citation"], type: "quote", shortcut: ">" },
  { id: "callout", label: "Callout", hint: "Make a note stand out", keywords: ["note", "info", "tip", "warning", "highlight"], type: "callout" },
  { id: "divider", label: "Divider", hint: "A line between sections", keywords: ["hr", "rule", "separator", "line"], type: "divider", shortcut: "---" },
  { id: "task", label: "Make task", hint: "Turn this line into a task", keywords: ["task", "todo", "action", "assign"], action: "task" },
  { id: "mention", label: "Mention someone", hint: "Let them know in their Inbox", keywords: ["mention", "person", "people", "at", "notify"], action: "mention" },
];

/** The commands matching what's typed after "/" (label words first, then keywords). */
export function filterSlashCommands(query: string, opts: { canMakeTask?: boolean; canMention?: boolean } = {}): SlashCommand[] {
  const q = query.trim().toLowerCase();
  const pool = SLASH_COMMANDS.filter((c) => (c.action !== "task" || opts.canMakeTask !== false) && (c.action !== "mention" || opts.canMention !== false));
  if (!q) return [...pool];
  const scored: { c: SlashCommand; score: number }[] = [];
  for (const c of pool) {
    const label = c.label.toLowerCase();
    let score = -1;
    if (label.startsWith(q)) score = 0;
    else if (label.split(/\s+/).some((w) => w.startsWith(q))) score = 1;
    else if (c.keywords.some((k) => k.startsWith(q))) score = 2;
    else if (label.replace(/\s+/g, "").includes(q.replace(/\s+/g, ""))) score = 3;
    if (score >= 0) scored.push({ c, score });
  }
  return scored.sort((a, b) => a.score - b.score).map((x) => x.c);
}

/** The people matching what's typed after "@" (first or last name, then anywhere in the name). */
export function filterMembers<M extends { id: string; name: string }>(members: readonly M[], query: string, limit = 6): M[] {
  const q = query.trim().toLowerCase();
  if (!q) return members.slice(0, limit);
  const starts = members.filter((m) => m.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || m.name.toLowerCase().startsWith(q));
  const rest = members.filter((m) => !starts.includes(m) && m.name.toLowerCase().includes(q));
  return [...starts, ...rest].slice(0, limit);
}

/* ------------------------------------------------------------ templates */

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-09" → "9 October 2026" (as written, whatever the time zone). */
export function longDate(isoDay: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDay ?? "");
  if (!m) return isoDay ?? "";
  return `${+m[3]} ${MONTHS[+m[2] - 1] ?? ""} ${m[1]}`;
}

const T = (text: string, marks?: DocMark[]): DocSpan => (marks ? { text, marks } : { text });
const blk = (type: DocBlockType, spans: DocSpan[] | string = [], extra: Partial<DocBlock> = {}): DocBlock => {
  const b = emptyBlock(type, extra);
  if (type !== "divider") b.spans = typeof spans === "string" ? (spans ? [T(spans)] : []) : normaliseSpans(spans);
  return b;
};

/** A starter doc: its title, icon and blocks (British English copy; dates for `today`, YYYY-MM-DD). */
export function docTemplate(id: DocTemplateId, ctx: { projectName: string; today: string }): { title: string; icon: string; body: DocBlock[] } {
  const day = longDate(ctx.today);
  const project = (ctx.projectName ?? "").trim() || "this project";
  switch (id) {
    case "brief":
      return {
        title: `${project}: project brief`, icon: "🧭",
        body: [
          blk("callout", `One page on why ${project} exists, what done looks like and who's involved. Keep it short, and keep it current.`, { icon: "🧭" }),
          blk("h2", "Why we're doing this"),
          blk("p", "The problem, who has it, and why now."),
          blk("h2", "What done looks like"),
          blk("bullet", "The outcome we want, and how we'll know we got there"),
          blk("bullet", "The number we'll watch"),
          blk("h2", "Not doing"),
          blk("bullet", "What's out of scope, so nobody wonders"),
          blk("h2", "Milestones"),
          blk("todo", "First milestone, and its date"),
          blk("todo", "Launch"),
          blk("h2", "People"),
          blk("bullet", [T("Owner: ", ["b"])]),
          blk("bullet", [T("Working on it: ", ["b"])]),
          blk("bullet", [T("Signs it off: ", ["b"])]),
          blk("h2", "Risks and open questions"),
          blk("bullet", "What could go wrong, and what we still need to find out"),
        ],
      };
    case "meeting":
      return {
        title: `Meeting notes, ${day}`, icon: "🗒️",
        body: [
          blk("p", [T("Date: ", ["b"]), T(day)]),
          blk("p", [T("Attendees: ", ["b"])]),
          blk("h2", "Agenda"),
          blk("numbered", ""),
          blk("h2", "Notes"),
          blk("bullet", ""),
          blk("h2", "Decisions"),
          blk("bullet", ""),
          blk("h2", "Actions"),
          blk("todo", "Who does what, by when"),
          blk("callout", "Turn an action into a task with Make task (type / on the line), so it lands on someone's list.", { icon: "✅" }),
        ],
      };
    case "decisions":
      return {
        title: `${project}: decision log`, icon: "⚖️",
        body: [
          blk("callout", "One entry per decision, newest at the top: what we decided, why, what else we looked at, and who made the call.", { icon: "⚖️" }),
          blk("h3", `${day}: what we decided`),
          blk("bullet", [T("Decision: ", ["b"])]),
          blk("bullet", [T("Why: ", ["b"])]),
          blk("bullet", [T("Options we considered: ", ["b"])]),
          blk("bullet", [T("Decided by: ", ["b"])]),
          blk("divider"),
        ],
      };
    case "retro":
      return {
        title: `Retro, ${day}`, icon: "🔁",
        body: [
          blk("p", `How the last stretch of ${project} went. Everyone adds a line or two before the call.`),
          blk("h2", "What went well"),
          blk("bullet", ""),
          blk("h2", "What didn't go so well"),
          blk("bullet", ""),
          blk("h2", "What we'll try next"),
          blk("todo", ""),
          blk("h2", "Thank-yous"),
          blk("bullet", ""),
        ],
      };
    case "blank":
    default:
      return { title: "", icon: "📄", body: [blk("p")] };
  }
}

/* ------------------------------------------------------------ Markdown out */

/** Backslash the characters our importer would read as Markdown. */
function escapeInline(text: string): string {
  return text.replace(/([\\`*_[\]])/g, "\\$1");
}
function escapeLineStart(line: string): string {
  return line.replace(/^(\s*)(#{1,6}\s|[-+]\s|>|\d+[.)]\s|!\s|---)/, "$1\\$2");
}

/** Spans → inline Markdown. */
export function spansToMarkdown(spans: readonly DocSpan[] | undefined, memberName?: (id: string) => string | undefined): string {
  let out = "";
  for (const s of spans ?? []) {
    if (s.mention) {
      const name = memberName?.(s.mention);
      out += name ? `@${name}` : s.text;
      continue;
    }
    if (!s.text) continue;
    const code = s.marks?.includes("code");
    // whitespace at either end stays outside the markers, or "** bold**" wouldn't read back
    const lead = code ? "" : (s.text.match(/^\s+/)?.[0] ?? "");
    const trail = code ? "" : (s.text.match(/\s+$/)?.[0] ?? "");
    const core = code ? s.text : s.text.slice(lead.length, s.text.length - trail.length);
    if (!core) { out += s.text; continue; }
    let t = code ? "`" + core.replace(/`/g, "ˋ") + "`" : escapeInline(core);
    if (s.marks?.includes("i")) t = `*${t}*`;
    if (s.marks?.includes("b")) t = `**${t}**`;
    if (s.href) t = `[${t}](${s.href.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : encodeURIComponent(c)))})`;
    out += lead + t + trail;
  }
  return out;
}

/** Markdown export ("Export as Markdown"). Mentions as @Name, Make-task lines as - [ ] / - [x]. */
export function blocksToMarkdown(title: string, blocks: readonly DocBlock[], ctx: { memberName?: (id: string) => string | undefined; taskDone?: (id: string) => boolean | undefined } = {}): string {
  const lines: string[] = [];
  const t = (title ?? "").trim();
  if (t) lines.push(`# ${escapeInline(t)}`, "");
  let prevList = false;
  blocks.forEach((b, i) => {
    const pad = "  ".repeat(isListType(b.type) || b.taskId ? b.indent ?? 0 : 0);
    const text = spansToMarkdown(b.spans, ctx.memberName).replace(/\n/g, "  \n" + pad + (b.type === "quote" || b.type === "callout" ? "> " : ""));
    let line: string;
    let isList = false;
    if (b.taskId && b.type !== "divider") {
      const done = ctx.taskDone?.(b.taskId) ?? !!b.checked;
      line = `${pad}- [${done ? "x" : " "}] ${text}`;
      isList = true;
    } else {
      switch (b.type) {
        case "h1": line = `# ${text}`; break;
        case "h2": line = `## ${text}`; break;
        case "h3": line = `### ${text}`; break;
        case "bullet": line = `${pad}- ${text}`; isList = true; break;
        case "numbered": line = `${pad}${listNumber(blocks, i)}. ${text}`; isList = true; break;
        case "todo": line = `${pad}- [${b.checked ? "x" : " "}] ${text}`; isList = true; break;
        case "quote": line = `> ${text}`; break;
        case "callout": line = `> ${b.icon || DEFAULT_CALLOUT_ICON} ${text}`; break;
        case "divider": line = "---"; break;
        default: line = escapeLineStart(text);
      }
    }
    // a blank line between blocks; list items stay together
    if (lines.length && !(isList && prevList)) lines.push("");
    lines.push(line.replace(/\s+$/, (m) => (m.includes("\n") ? m : "")));
    prevList = isList;
  });
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

/* ------------------------------------------------------------ Markdown in */

const PUNCT = /[\\`*_[\]()#+\-.!>~|{}]/;

/** Inline Markdown → spans: **b** / __b__, *i* / _i_, `code`, [text](url), bare http(s) links, \-escapes. */
export function inlineMarkdownToSpans(src: string, marks: DocMark[] = []): DocSpan[] {
  const out: DocSpan[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push(marks.length ? { text: buf, marks: sortMarks(marks) } : { text: buf }); buf = ""; } };
  const add = (m: DocMark) => (marks.includes(m) ? marks : [...marks, m]);
  /** the closing delimiter: not escaped, not right after a space */
  const closing = (delim: string, from: number): number => {
    for (let j = from; j <= src.length - delim.length; j++) {
      if (src[j] === "\\") { j++; continue; }
      if (src[j] === "`") { const k = src.indexOf("`", j + 1); if (k > 0) { j = k; continue; } }
      if (src.startsWith(delim, j) && j > from && !/\s/.test(src[j - 1])) {
        if (delim.length === 1 && src[j + 1] === delim) { j++; continue; } // ** inside *…*
        return j;
      }
    }
    return -1;
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "\\" && i + 1 < src.length && PUNCT.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === "`") {
      const j = src.indexOf("`", i + 1);
      if (j > i + 1) { flush(); out.push({ text: src.slice(i + 1, j), marks: sortMarks(add("code")) }); i = j + 1; continue; }
    }
    if (src.startsWith("***", i) && !/\s/.test(src[i + 3] ?? " ")) {
      const j = closing("***", i + 3);
      if (j > 0) { flush(); out.push(...inlineMarkdownToSpans(src.slice(i + 3, j), add("b").includes("i") ? add("b") : [...add("b"), "i"])); i = j + 3; continue; }
    }
    if ((src.startsWith("**", i) || src.startsWith("__", i)) && !/\s/.test(src[i + 2] ?? " ")) {
      const d = src.slice(i, i + 2);
      const j = closing(d, i + 2);
      if (j > 0 && (d === "**" || !/[\p{L}\p{N}]/u.test(src[j + 2] ?? ""))) {
        flush(); out.push(...inlineMarkdownToSpans(src.slice(i + 2, j), add("b"))); i = j + 2; continue;
      }
    }
    if ((c === "*" || c === "_") && !/\s/.test(src[i + 1] ?? " ") && !(c === "_" && /[\p{L}\p{N}]/u.test(src[i - 1] ?? ""))) {
      const j = closing(c, i + 1);
      if (j > 0 && (c === "*" || !/[\p{L}\p{N}]/u.test(src[j + 1] ?? ""))) {
        flush(); out.push(...inlineMarkdownToSpans(src.slice(i + 1, j), add("i"))); i = j + 1; continue;
      }
    }
    if (c === "[") {
      // [label](address) — the label may hold marks; brackets in it must balance
      let depth = 0, k = i;
      for (; k < src.length; k++) {
        if (src[k] === "\\") { k++; continue; }
        if (src[k] === "[") depth++;
        else if (src[k] === "]" && --depth === 0) break;
      }
      if (k < src.length && src[k + 1] === "(") {
        const close = src.indexOf(")", k + 2);
        if (close > k + 1) {
          const label = src.slice(i + 1, k);
          const href = cleanLinkInput(decodeURIComponentSafe(src.slice(k + 2, close).trim().replace(/^<|>$/g, "").split(/\s+"/)[0]));
          flush();
          const inner = inlineMarkdownToSpans(label, marks);
          out.push(...(href ? inner.map((s) => (s.mention ? s : { ...s, href })) : inner));
          i = close + 1;
          continue;
        }
      }
    }
    if ((c === "h" || c === "H") && /^https?:\/\//i.test(src.slice(i, i + 8)) && (i === 0 || /[\s(]/.test(src[i - 1]))) {
      let j = i;
      while (j < src.length && !/\s/.test(src[j])) j++;
      let url = src.slice(i, j);
      // sentence punctuation at the end isn't part of the address
      url = url.replace(/[.,;:!?'"]+$/, "");
      // a closing bracket the address didn't open belongs to the sentence
      const count = (re: RegExp) => (url.match(re) ?? []).length;
      while (url.endsWith(")") && count(/\)/g) > count(/\(/g)) url = url.slice(0, -1);
      const href = cleanLinkInput(url);
      if (href) { flush(); out.push({ text: url, ...(marks.length ? { marks: sortMarks(marks) } : {}), href }); i += url.length; continue; }
    }
    buf += c;
    i++;
  }
  flush();
  return normaliseSpans(out);
}

function decodeURIComponentSafe(s: string): string {
  try { return /%[0-9a-f]{2}/i.test(s) ? decodeURIComponent(s) : s; } catch { return s; }
}

const EMOJI_LEAD = /^(\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*)\s+/u;

/** Paste / import: plain text or Markdown → blocks (#, ##, ###, -, *, 1., [ ], [x], >, ---, **b**, *i*, `code`, [text](url)).
 *  Each line of plain text becomes its own paragraph (a line ending in two spaces carries on in the same block,
 *  as Markdown's soft break); blank lines are dropped. */
export function markdownToBlocks(text: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  let fence = false;
  /** the line before was a quote line / ended with a soft break (and made the last block) */
  let prevQuote = false, prevSoft = false;
  const listItem = (type: DocBlockType, spans: DocSpan[], indent: number, extra: Partial<DocBlock> = {}) => {
    const b = blk(type, spans, extra);
    if (indent) b.indent = indent;
    out.push(b);
  };
  for (const raw of lines) {
    const soft = / {2,}$/.test(raw);
    const wasQuote = prevQuote, wasSoft = prevSoft;
    prevQuote = false; prevSoft = false;
    // code fences: the lines inside are kept as code
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue; }
    if (fence) { if (raw.trim()) out.push(blk("p", [{ text: raw, marks: ["code"] }])); continue; }
    if (!raw.trim()) continue;
    const lead = raw.match(/^[ \t]*/)![0];
    const indent = Math.min(MAX_INDENT, Math.floor(lead.replace(/\t/g, "  ").length / 2));
    const line = raw.slice(lead.length).replace(/\s+$/, "");
    const prev = out[out.length - 1];
    let m: RegExpMatchArray | null;
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(line.replace(/\s/g, ""))) { out.push(blk("divider")); continue; }
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      const level = m[1].length;
      out.push(blk(level === 1 ? "h1" : level === 2 ? "h2" : "h3", inlineMarkdownToSpans(m[2].replace(/\s+#+$/, ""))));
      continue;
    }
    if ((m = line.match(/^(?:[-*+]\s+)?\[([ xX])\](?:\s+(.*))?$/))) {
      listItem("todo", inlineMarkdownToSpans(m[2] ?? ""), indent, { checked: m[1].toLowerCase() === "x" });
      prevSoft = soft;
      continue;
    }
    if ((m = line.match(/^[-*+•](?:\s+(.*))?$/))) { listItem("bullet", inlineMarkdownToSpans(m[1] ?? ""), indent); prevSoft = soft; continue; }
    if ((m = line.match(/^\d{1,9}[.)](?:\s+(.*))?$/))) { listItem("numbered", inlineMarkdownToSpans(m[1] ?? ""), indent); prevSoft = soft; continue; }
    if ((m = line.match(/^>\s?(.*)$/))) {
      const body = m[1];
      const e = body.match(EMOJI_LEAD);
      prevQuote = true;
      // a quote that carries on over the next line stays one block
      if (wasQuote && prev && (prev.type === "quote" || prev.type === "callout")) {
        out[out.length - 1] = withSpans(prev, concatSpans(prev.spans, [{ text: "\n" }], inlineMarkdownToSpans(body)));
        continue;
      }
      // "> 💡 text" is how a callout goes out
      if (e) out.push(blk("callout", inlineMarkdownToSpans(body.slice(e[0].length)), { icon: e[1] }));
      else out.push(blk("quote", inlineMarkdownToSpans(body)));
      continue;
    }
    const spans = inlineMarkdownToSpans(line);
    if (wasSoft && prev && prev.type !== "divider") {
      out[out.length - 1] = withSpans(prev, concatSpans(prev.spans, [{ text: "\n" }], spans));
    } else out.push(blk("p", spans));
    prevSoft = soft;
  }
  return out;
}
