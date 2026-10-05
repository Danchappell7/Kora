// ============================================================
// KANBO — Notion: reading and writing Notion objects (0046).          [a3]
//
// Pure (no Deno globals, no network): shared by the notion edge function,
// vitest and the app (the Import wizard's suggested mapping). Everything
// Notion sends is treated as untrusted data: every reader tolerates missing
// or odd fields and caps what it keeps.
//
// The sync compares the two sides in Kanbo's terms, field by field:
//   planSync(task, page, baseline)   which fields go which way (below)
//   pullPatch(page, task, fields)   what Kanbo should change to match the page
//   pushProperties(task, page, fields)   what Notion should change to match the task
// planSync is a three-way merge per field. The baseline is a fingerprint of
// each field's value as both sides last agreed it (notion_link_state). A
// field only Kanbo changed goes to Notion; one only Notion changed comes to
// Kanbo; one both changed goes the way of the later edit (a tie goes to
// Kanbo); one neither changed is left alone. So an edit to anything else
// (priority, position, an unmapped Notion property, the page body) never
// carries a stale field across.
// A field takes part only when it reads cleanly on both sides (a status
// option with no Kanbo status, a person who isn't a member, a Kanbo status
// with no Notion option… are left alone), so neither side is ever
// overwritten with something the other side can't express.
//
// Field rules (NotionFieldMapping, _shared/notion.ts):
//   title        the title property ↔ task title (blank → "Untitled")
//   status       a status or select property; options map to Kanbo
//                statuses (many to one). Pushing keeps the page's option
//                when it already means the task's status, else the first
//                mapped option that does
//   due          a date property: a range (start → end) ↔ start date →
//                due date; a single date ↔ due date (no start date). A task
//                with only a start date doesn't show in Notion
//   assignee     a people property ↔ assignee, matched by email to active
//                members (needs the integration's "user information
//                including email addresses" capability)
//   tags         a multi-select property ↔ tags, by label (missing
//                workspace tags are created)
//   description  a text property's first paragraph ↔ the description's
//                first paragraph; the rest of each side is left as it is
// ============================================================
import type { NotionFieldMapping } from "./notion.ts";

export type KanboStatus = "todo" | "progress" | "review" | "blocked" | "done";
export const KANBO_STATUSES: readonly KanboStatus[] = ["todo", "progress", "review", "blocked", "done"];
export const isKanboStatus = (v: unknown): v is KanboStatus => typeof v === "string" && (KANBO_STATUSES as readonly string[]).includes(v);

export const LIMITS = {
  title: 500,
  description: 20_000,
  tagLabel: 60,
  tags: 50,
  optionName: 100,
  statusValues: 100,
  previewText: 200,
  previewList: 10,
  databaseTitle: 300,
  pageTitle: 500,
  icon: 1000,
  url: 1000,
  mappingBytes: 16_000,
  /** Notion: one rich-text object holds at most 2,000 characters, a property at most 100 objects */
  richTextChunk: 2000,
  richTextParts: 100,
} as const;

/* ------------------------------------------------------------ Notion shapes (the parts read) */

export interface NRichText { plain_text?: string; type?: string; text?: { content?: string } | null }
export interface NOption { id?: string; name: string; color?: string }
export interface NUser { object?: string; id: string; name?: string | null; type?: string; person?: { email?: string | null } | null; bot?: Record<string, unknown> | null }
export type NIcon = { type?: string; emoji?: string; external?: { url?: string }; file?: { url?: string } } | null | undefined;
export interface NProp { id?: string; type: string; [k: string]: unknown }
export interface NPage {
  object?: "page";
  id: string;
  created_time?: string;
  last_edited_time: string;
  archived?: boolean;
  in_trash?: boolean;
  icon?: NIcon;
  url?: string;
  parent?: { type?: string; database_id?: string; page_id?: string };
  properties?: Record<string, NProp>;
}
export interface NDbProp {
  id?: string;
  name?: string;
  type: string;
  status?: { options?: NOption[]; groups?: { name?: string; option_ids?: string[] }[] };
  select?: { options?: NOption[] };
  multi_select?: { options?: NOption[] };
}
export interface NDatabase {
  object?: "database";
  id: string;
  title?: NRichText[];
  icon?: NIcon;
  url?: string;
  last_edited_time?: string;
  archived?: boolean;
  in_trash?: boolean;
  properties?: Record<string, NDbProp>;
}

/* ------------------------------------------------------------ the app's shapes (= src/data/types.ts) */

export type PropType =
  | "title" | "rich_text" | "status" | "select" | "multi_select" | "date" | "people"
  | "checkbox" | "number" | "url" | "email" | "phone_number" | "other";
const KNOWN_TYPES: readonly PropType[] = ["title", "rich_text", "status", "select", "multi_select", "date", "people", "checkbox", "number", "url", "email", "phone_number"];

export interface PropSchema {
  id: string;
  name: string;
  type: PropType;
  /** status / select / multi_select option names */
  options?: string[];
  /** status properties: option name → its group ("To-do", "In progress", "Complete") */
  groups?: Record<string, string>;
}
export interface DbSchema { id: string; title: string; properties: PropSchema[] }
export interface DbSummary { id: string; title: string; icon: string | null; url: string | null; lastEditedTime: string | null }
export interface PreviewRow { pageId: string; values: Record<string, string | string[] | null> }
export interface PageMeta { title: string; icon: string | null; url: string | null; last_edited_time: string | null; archived: boolean }

/* ------------------------------------------------------------ small readers */

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
/** Text Notion sent, as Kanbo keeps it: no control characters (tabs and newlines stay), capped. */
export const cleanText = (s: string, n: number) => cap(s.replace(CONTROL, ""), n);
/** One line (titles, labels, option names). */
export const oneLine = (s: string, n: number) => cap(s.replace(CONTROL, " ").replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim(), n);

/** A rich-text array → its plain text. */
export function plain(rt: unknown): string {
  if (!Array.isArray(rt)) return "";
  let out = "";
  for (const r of rt) {
    if (!isObj(r)) continue;
    out += typeof r.plain_text === "string" ? r.plain_text : isObj(r.text) ? str(r.text.content) : "";
    if (out.length > LIMITS.description * 2) break;
  }
  return out;
}

/** Text → a rich-text array Notion accepts (2,000-character pieces, at most 100). */
export function richText(text: string): { type: "text"; text: { content: string } }[] {
  const out: { type: "text"; text: { content: string } }[] = [];
  let s = text;
  while (s.length && out.length < LIMITS.richTextParts) {
    let piece = s.slice(0, LIMITS.richTextChunk);
    // never split a surrogate pair
    if (piece.length === LIMITS.richTextChunk && /[\uD800-\uDBFF]$/.test(piece)) piece = piece.slice(0, -1);
    out.push({ type: "text", text: { content: piece } });
    s = s.slice(piece.length);
  }
  return out;
}

/** An emoji, or an https image address; null otherwise. */
export function iconOf(icon: NIcon): string | null {
  if (!isObj(icon)) return null;
  if (icon.type === "emoji" && typeof icon.emoji === "string" && icon.emoji.trim()) return cap(icon.emoji.trim(), 16);
  const url = icon.type === "external" ? str(icon.external?.url) : icon.type === "file" ? str(icon.file?.url) : "";
  return httpsUrl(url);
}

/** An https address Kanbo may show (≤ 1,000 characters, no spaces, quotes or brackets); null otherwise. */
export function httpsUrl(u: unknown): string | null {
  const s = str(u).trim();
  if (!s || s.length > LIMITS.url || !/^https:\/\/[^\s"'<>\\]+$/i.test(s)) return null;
  try { return new URL(s).protocol === "https:" ? s : null; } catch { return null; }
}

/** "2026-10-07T09:00:00.000+01:00" → "2026-10-07"; null for anything else (including impossible dates). */
export function dayOf(v: unknown): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(str(v));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** ISO time → ms since the epoch (NaN when it isn't one). */
export const ms = (v: unknown): number => (typeof v === "string" ? Date.parse(v) : v instanceof Date ? v.getTime() : NaN);

/* ------------------------------------------------------------ databases and pages */

export function databaseTitle(db: Pick<NDatabase, "title">): string {
  return oneLine(plain(db.title), LIMITS.databaseTitle) || "Untitled database";
}

/** The page's title (the property of type "title"); "" when it has none. */
export function pageTitleRaw(page: Pick<NPage, "properties">): string {
  for (const p of Object.values(page.properties ?? {})) {
    if (isObj(p) && p.type === "title") return oneLine(plain(p.title), LIMITS.pageTitle);
  }
  return "";
}
export const pageTitle = (page: Pick<NPage, "properties">) => pageTitleRaw(page) || "Untitled";

export function summariseDatabase(db: NDatabase): DbSummary {
  return {
    id: db.id,
    title: databaseTitle(db),
    icon: iconOf(db.icon),
    url: httpsUrl(db.url),
    lastEditedTime: typeof db.last_edited_time === "string" ? db.last_edited_time : null,
  };
}

/** What the page cache keeps about a page (or a database linked like one). */
export function pageMeta(obj: NPage | NDatabase): PageMeta {
  const isDb = (obj as NDatabase).object === "database";
  return {
    title: isDb ? databaseTitle(obj as NDatabase) : pageTitle(obj as NPage),
    icon: iconOf(obj.icon),
    url: httpsUrl(obj.url),
    last_edited_time: typeof obj.last_edited_time === "string" && Number.isFinite(ms(obj.last_edited_time)) ? obj.last_edited_time : null,
    archived: obj.archived === true || obj.in_trash === true,
  };
}

const optionNames = (o: unknown): string[] =>
  Array.isArray(o) ? o.filter(isObj).map((x) => oneLine(str(x.name), LIMITS.optionName)).filter(Boolean).slice(0, 200) : [];

/** A database's properties, the title first, then by name. */
export function schemaOf(db: NDatabase): DbSchema {
  const props: PropSchema[] = [];
  for (const [key, p] of Object.entries(db.properties ?? {})) {
    if (!isObj(p)) continue;
    const name = oneLine(str(p.name) || key, 200);
    const type: PropType = (KNOWN_TYPES as readonly string[]).includes(p.type) ? (p.type as PropType) : "other";
    const out: PropSchema = { id: str(p.id) || name, name, type };
    if (type === "status") {
      out.options = optionNames(p.status?.options);
      const byId = new Map<string, string>();
      for (const o of p.status?.options ?? []) if (isObj(o) && o.id) byId.set(String(o.id), oneLine(str(o.name), LIMITS.optionName));
      const groups: Record<string, string> = {};
      for (const g of p.status?.groups ?? []) {
        if (!isObj(g)) continue;
        for (const id of Array.isArray(g.option_ids) ? g.option_ids : []) {
          const n = byId.get(String(id));
          if (n) groups[n] = oneLine(str(g.name), 60);
        }
      }
      if (Object.keys(groups).length) out.groups = groups;
    } else if (type === "select") out.options = optionNames(p.select?.options);
    else if (type === "multi_select") out.options = optionNames(p.multi_select?.options);
    props.push(out);
  }
  props.sort((a, b) => (a.type === "title" ? -1 : b.type === "title" ? 1 : a.name.localeCompare(b.name)));
  return { id: db.id, title: databaseTitle(db), properties: props };
}

/** A property's value as display text (the Import preview). */
export function displayValue(p: unknown): string | string[] | null {
  if (!isObj(p)) return null;
  const t = str(p.type);
  const v = p[t];
  const txt = (s: string) => oneLine(s, LIMITS.previewText) || null;
  switch (t) {
    case "title": case "rich_text": return txt(plain(v));
    case "status": case "select": return isObj(v) ? txt(str(v.name)) : null;
    case "multi_select": return Array.isArray(v) ? v.filter(isObj).map((o) => oneLine(str(o.name), LIMITS.optionName)).filter(Boolean).slice(0, LIMITS.previewList) : null;
    case "date": {
      if (!isObj(v)) return null;
      const s = str(v.start), e = str(v.end);
      return s ? txt(e ? `${s} → ${e}` : s) : null;
    }
    case "people": return Array.isArray(v) ? v.filter(isObj).map((u) => oneLine(str(u.name) || str((u.person as Record<string, unknown> | undefined)?.email) || "Someone", 80)).slice(0, LIMITS.previewList) : null;
    case "checkbox": return v === true ? "Yes" : "No";
    case "number": return typeof v === "number" && Number.isFinite(v) ? String(v) : null;
    case "url": case "email": case "phone_number": return typeof v === "string" ? txt(v) : null;
    case "created_time": case "last_edited_time": return typeof v === "string" ? txt(v) : null;
    case "formula": {
      if (!isObj(v)) return null;
      const ft = str(v.type), fv = v[ft];
      if (ft === "boolean") return fv === true ? "Yes" : "No";
      if (ft === "date") return isObj(fv) ? txt(str(fv.start)) : null;
      return typeof fv === "string" || typeof fv === "number" ? txt(String(fv)) : null;
    }
    default: return null;
  }
}

export function previewRow(page: NPage): PreviewRow {
  const values: Record<string, string | string[] | null> = {};
  for (const [name, p] of Object.entries(page.properties ?? {})) values[oneLine(name, 200)] = displayValue(p);
  return { pageId: page.id, values };
}

/* ------------------------------------------------------------ mapping: suggest + check */

/** The Kanbo status a Notion option most likely means (its status group helps). */
export function guessStatus(option: string, group?: string | null): KanboStatus {
  const s = option.toLowerCase();
  if (/\b(done|complete[d]?|published|shipped|closed|finished|resolved|live|launched|archived)\b/.test(s)) return "done";
  if (/\b(block(ed)?|stuck|on hold|waiting|paused)\b/.test(s)) return "blocked";
  if (/\b(review|approv\w*|qa|check(ing)?|feedback|scheduled|ready)\b/.test(s)) return "review";
  if (/\b(in progress|progress|doing|draft\w*|writing|active|started|building|wip|editing|design(ing)?)\b/.test(s)) return "progress";
  const g = (group ?? "").toLowerCase();
  if (g === "complete" || g === "completed" || g === "done") return "done";
  if (g === "in progress") return "progress";
  return "todo";
}

const pick = (props: PropSchema[], types: PropType[], prefer: RegExp) =>
  props.find((p) => types.includes(p.type) && prefer.test(p.name)) ?? props.find((p) => types.includes(p.type));

/** A first guess at the mapping, for the wizard to show (people confirm it). */
export function suggestMapping(schema: Pick<DbSchema, "properties">): NotionFieldMapping {
  const props = schema.properties;
  const title = props.find((p) => p.type === "title")?.name ?? "Name";
  const status = props.find((p) => p.type === "status") ?? pick(props, ["select"], /status|stage|state|progress/i);
  const due = pick(props, ["date"], /due|deadline|publish|date|when/i);
  const assignee = pick(props, ["people"], /assign|owner|person|lead|who/i);
  const tags = pick(props, ["multi_select"], /tag|label|channel|categor|topic|type/i);
  const description = pick(props, ["rich_text"], /desc|summary|notes?|detail|brief|about/i);
  const m: NotionFieldMapping = { title };
  if (status) {
    const values: Record<string, KanboStatus> = {};
    for (const o of status.options ?? []) values[o] = guessStatus(o, status.groups?.[o]);
    m.status = { property: status.name, values };
  }
  if (due) m.due = { property: due.name };
  if (assignee) m.assignee = { property: assignee.name };
  if (tags) m.tags = { property: tags.name };
  if (description) m.description = { property: description.name };
  return m;
}

/** A mapping from the wizard, checked against the database's schema → the
 *  mapping to store (only the known keys), or a sentence saying what's wrong. */
export function checkMapping(raw: unknown, schema: Pick<DbSchema, "properties">): { ok: true; mapping: NotionFieldMapping } | { ok: false; error: string } {
  if (!isObj(raw)) return { ok: false, error: "Choose which Notion fields to bring in." };
  const byName = new Map(schema.properties.map((p) => [p.name, p]));
  const prop = (key: string, types: PropType[], label: string): { property: string } | null | string => {
    const v = raw[key];
    if (v == null) return null;
    if (!isObj(v) || typeof v.property !== "string") return `${label}: choose a Notion field.`;
    const p = byName.get(v.property);
    if (!p) return `${label}: “${oneLine(v.property, 80)}” isn't in this database any more.`;
    if (!types.includes(p.type)) return `${label}: “${p.name}” isn't the right kind of field.`;
    return { property: p.name };
  };
  const titleProp = schema.properties.find((p) => p.type === "title");
  if (!titleProp || raw.title !== titleProp.name) return { ok: false, error: "The task title comes from the database's title field." };
  const m: NotionFieldMapping = { title: titleProp.name };

  const st = prop("status", ["status", "select"], "Status");
  if (typeof st === "string") return { ok: false, error: st };
  if (st) {
    const vals = (raw.status as Record<string, unknown>).values;
    if (!isObj(vals)) return { ok: false, error: "Status: say which Kanbo status each option means." };
    const entries = Object.entries(vals);
    if (entries.length > LIMITS.statusValues) return { ok: false, error: "Status: that's more options than Kanbo can map." };
    const values: Record<string, KanboStatus> = {};
    for (const [k, v] of entries) {
      const key = oneLine(k, LIMITS.optionName);
      if (!key) continue;
      if (!isKanboStatus(v)) return { ok: false, error: `Status: choose a Kanbo status for “${key}”.` };
      values[key] = v;
    }
    m.status = { property: st.property, values };
  }
  for (const [key, types, label] of [
    ["due", ["date"], "Due date"], ["assignee", ["people"], "Assignee"],
    ["tags", ["multi_select"], "Tags"], ["description", ["rich_text"], "Description"],
  ] as const) {
    const r = prop(key, [...types], label);
    if (typeof r === "string") return { ok: false, error: r };
    if (r) (m as unknown as Record<string, unknown>)[key] = r;
  }
  if (new TextEncoder().encode(JSON.stringify(m)).length > LIMITS.mappingBytes) return { ok: false, error: "That mapping is too big to save." };
  return { ok: true, mapping: m };
}

/** A stored mapping (notion_syncs.mapping) read defensively: unknown keys and bad shapes dropped. */
export function readMapping(raw: unknown): NotionFieldMapping | null {
  if (!isObj(raw) || typeof raw.title !== "string" || !raw.title) return null;
  const m: NotionFieldMapping = { title: raw.title };
  const p = (v: unknown) => (isObj(v) && typeof v.property === "string" && v.property ? { property: v.property } : null);
  if (isObj(raw.status) && typeof raw.status.property === "string" && isObj(raw.status.values)) {
    const values: Record<string, KanboStatus> = {};
    for (const [k, v] of Object.entries(raw.status.values)) if (isKanboStatus(v)) values[k] = v;
    m.status = { property: raw.status.property, values };
  }
  const due = p(raw.due), assignee = p(raw.assignee), tags = p(raw.tags), description = p(raw.description);
  if (due) m.due = due;
  if (assignee) m.assignee = assignee;
  if (tags) m.tags = tags;
  if (description) m.description = description;
  return m;
}

/* ------------------------------------------------------------ a page's mapped fields */

export interface PeopleValue { id: string; email: string | null; name: string | null }
export interface TagValue { name: string; color: string | null }
/** A page's mapped fields. `undefined` = not mapped, or the page's property is
 *  missing / of another type (the field then takes no part). */
export interface PageFields {
  title: string;
  status?: { type: "status" | "select"; option: string | null };
  date?: { start: string | null; end: string | null } | null;
  people?: PeopleValue[];
  tags?: TagValue[];
  description?: string;
}

export function readPage(page: NPage, m: NotionFieldMapping): PageFields {
  const props = page.properties ?? {};
  const get = (name: string | undefined, types: string[]): NProp | undefined => {
    if (!name) return undefined;
    const p = props[name];
    return isObj(p) && types.includes(p.type) ? p : undefined;
  };
  const f: PageFields = { title: (() => { const t = get(m.title, ["title"]); return t ? oneLine(plain(t.title), LIMITS.title) || "Untitled" : pageTitle(page); })() };
  const st = get(m.status?.property, ["status", "select"]);
  if (st) {
    const v = st[st.type];
    f.status = { type: st.type as "status" | "select", option: isObj(v) ? oneLine(str(v.name), LIMITS.optionName) || null : null };
  }
  const dt = get(m.due?.property, ["date"]);
  if (dt) {
    const v = dt.date;
    f.date = isObj(v) && typeof v.start === "string" ? { start: v.start, end: typeof v.end === "string" ? v.end : null } : null;
  }
  const pp = get(m.assignee?.property, ["people"]);
  if (pp) {
    f.people = (Array.isArray(pp.people) ? pp.people : []).filter(isObj).filter((u) => typeof u.id === "string").slice(0, 50).map((u) => ({
      id: String(u.id),
      email: isObj(u.person) && typeof u.person.email === "string" && u.person.email.includes("@") ? u.person.email.trim().toLowerCase() : null,
      name: typeof u.name === "string" ? oneLine(u.name, 80) : null,
    }));
  }
  const tg = get(m.tags?.property, ["multi_select"]);
  if (tg) {
    f.tags = (Array.isArray(tg.multi_select) ? tg.multi_select : []).filter(isObj).map((o) => ({
      name: oneLine(str(o.name), LIMITS.tagLabel), color: typeof o.color === "string" ? o.color : null,
    })).filter((t) => t.name).slice(0, LIMITS.tags);
  }
  const ds = get(m.description?.property, ["rich_text"]);
  if (ds) f.description = cleanText(plain(ds.rich_text), LIMITS.description);
  return f;
}

/* ------------------------------------------------------------ Kanbo's side */

/** A task as the sync reads it (dates as YYYY-MM-DD, tags as tag ids). */
export interface SyncTask {
  id: string;
  title: string;
  description: string;
  status: KanboStatus;
  due_date: string | null;
  start_date: string | null;
  assignee_id: string;
  tags: string[];
}

export interface MapContext {
  /** lower-case email → user id (active members of the workspace) */
  memberByEmail: ReadonlyMap<string, string>;
  /** user id → lower-case email */
  emailByMember: ReadonlyMap<string, string>;
  /** workspace tag id → label */
  tagLabelById: ReadonlyMap<string, string>;
  /** lower-case email → Notion user id (only needed to push an assignee) */
  notionUserByEmail?: ReadonlyMap<string, string>;
}

/** Text → [first paragraph, the rest]. Paragraphs are split at a blank line. */
export function splitFirstParagraph(text: string): [string, string] {
  const s = String(text ?? "").replace(/\r\n?/g, "\n").replace(/^\s*\n/, "");
  const m = /\n[ \t]*\n/.exec(s);
  if (!m) return [s.trim(), ""];
  return [s.slice(0, m.index).trim(), s.slice(m.index + m[0].length).replace(/^\s*\n/, "").replace(/\s+$/, "")];
}
export const firstParagraph = (text: string) => splitFirstParagraph(text)[0];
/** Put `first` in place of the first paragraph, keeping the rest. */
export function withFirstParagraph(text: string, first: string): string {
  const rest = splitFirstParagraph(text)[1];
  const f = first.trim();
  return rest ? (f ? `${f}\n\n${rest}` : rest) : f;
}
const sameText = (a: string, b: string) => a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

/** The two dates in their one Notion shape: a range (start < due) or just a due date. */
export interface Dates { start: string | null; due: string | null }
export function canonNotionDate(d: PageFields["date"]): Dates {
  if (!d) return { start: null, due: null };
  const s = dayOf(d.start), e = dayOf(d.end);
  if (s && e) return s < e ? { start: s, due: e } : { start: null, due: e };
  return { start: null, due: s ?? e };
}
export function canonTaskDate(t: Pick<SyncTask, "due_date" | "start_date">): Dates {
  const due = dayOf(t.due_date), start = dayOf(t.start_date);
  if (!due) return { start: null, due: null };
  return start && start < due ? { start, due } : { start: null, due };
}
const sameDates = (a: Dates, b: Dates) => a.start === b.start && a.due === b.due;

/** A tag label / option name as compared (case and spacing don't matter). */
export const tagKey = (s: string) => s.replace(/,/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
/** A Kanbo tag label as a Notion option name (no commas, ≤ 100). */
export const optionName = (s: string) => oneLine(s.replace(/,/g, " "), LIMITS.optionName);
const sameSet = (a: string[], b: string[]) => {
  const x = new Set(a.map(tagKey).filter(Boolean)), y = new Set(b.map(tagKey).filter(Boolean));
  if (x.size !== y.size) return false;
  for (const k of x) if (!y.has(k)) return false;
  return true;
};
const taskTagLabels = (t: SyncTask, ctx: MapContext) => t.tags.map((id) => ctx.tagLabelById.get(id)).filter((l): l is string => !!l);

/** Notion's tag colours as Kanbo tag colours. */
const TAG_COLOURS: Record<string, string> = {
  default: "oklch(0.7 0.02 240)", gray: "oklch(0.7 0.02 240)", brown: "oklch(0.66 0.07 55)", orange: "oklch(0.76 0.15 60)",
  yellow: "oklch(0.82 0.14 90)", green: "oklch(0.75 0.13 155)", blue: "oklch(0.74 0.14 230)", purple: "oklch(0.74 0.16 305)",
  pink: "oklch(0.76 0.14 350)", red: "oklch(0.66 0.2 20)",
};
export const tagColour = (notionColour: string | null | undefined) => TAG_COLOURS[String(notionColour ?? "").replace(/_background$/, "")] ?? TAG_COLOURS.default;

/** What changes on the Kanbo task so it matches the page. `tags` holds the
 *  page's options (the caller turns labels into tag ids, creating missing ones). */
export interface PullPatch {
  title?: string;
  status?: KanboStatus;
  due_date?: string | null;
  start_date?: string | null;
  assignee_id?: string;
  tags?: TagValue[];
  description?: string;
}

/** The assignee the page names, in Kanbo terms: "" = nobody; undefined = can't tell (people who aren't members). */
function pageAssignee(people: PeopleValue[], current: string, ctx: MapContext): string | undefined {
  if (!people.length) return "";
  const ids = people.map((p) => (p.email ? ctx.memberByEmail.get(p.email) : undefined)).filter((x): x is string => !!x);
  if (!ids.length) return undefined;
  return ids.includes(current) ? current : ids[0];
}

/** `only`: the fields to consider (planSync's pull list); every mapped field when left out. */
export function pullPatch(f: PageFields, t: SyncTask, m: NotionFieldMapping, ctx: MapContext, only?: readonly SyncField[]): { patch: PullPatch; changed: string[] } {
  const patch: PullPatch = {};
  const want = (k: SyncField) => !only || only.includes(k);
  if (want("title") && f.title && f.title !== (oneLine(t.title, LIMITS.title) || "Untitled")) patch.title = f.title;
  if (want("status") && m.status && f.status) {
    const s = f.status.option ? m.status.values[f.status.option] : undefined;
    if (isKanboStatus(s) && s !== t.status) patch.status = s;
  }
  if (want("due") && m.due && f.date !== undefined) {
    const n = canonNotionDate(f.date), k = canonTaskDate(t);
    if (!sameDates(n, k)) { patch.due_date = n.due; patch.start_date = n.start; }
  }
  if (want("assignee") && m.assignee && f.people) {
    const a = pageAssignee(f.people, t.assignee_id, ctx);
    if (a !== undefined && a !== t.assignee_id) patch.assignee_id = a;
  }
  if (want("tags") && m.tags && f.tags && !sameSet(f.tags.map((x) => x.name), taskTagLabels(t, ctx))) patch.tags = f.tags;
  if (want("description") && m.description && f.description !== undefined) {
    const np = firstParagraph(f.description), kp = firstParagraph(t.description);
    if (!sameText(np, kp)) patch.description = cap(withFirstParagraph(t.description, np), LIMITS.description);
  }
  return { patch, changed: Object.keys(patch) };
}

/** A new task's fields from a page (import, or a page added to a synced database). */
export function taskFromPage(f: PageFields, m: NotionFieldMapping, ctx: MapContext): Required<Omit<PullPatch, "tags">> & { tags: TagValue[] } {
  const status = m.status && f.status?.option ? m.status.values[f.status.option] : undefined;
  const dates = m.due ? canonNotionDate(f.date ?? null) : { start: null, due: null };
  return {
    title: f.title || "Untitled",
    status: isKanboStatus(status) ? status : "todo",
    due_date: dates.due,
    start_date: dates.start,
    assignee_id: m.assignee && f.people ? pageAssignee(f.people, "", ctx) ?? "" : "",
    tags: m.tags && f.tags ? f.tags : [],
    description: m.description && f.description ? cap(firstParagraph(f.description), LIMITS.description) : "",
  };
}

/** What Notion should change so the page matches the task: a PATCH /pages
 *  `properties` body (empty when nothing differs or nothing can be said). */
export function pushProperties(t: SyncTask, f: PageFields, m: NotionFieldMapping, ctx: MapContext, only?: readonly SyncField[]): { properties: Record<string, unknown>; changed: SyncField[] } {
  const properties: Record<string, unknown> = {};
  const changed: SyncField[] = [];
  const want = (k: SyncField) => !only || only.includes(k);
  const title = oneLine(t.title, LIMITS.title) || "Untitled";
  if (want("title") && title !== f.title) { properties[m.title] = { title: richText(title) }; changed.push("title"); }
  if (want("status") && m.status && f.status) {
    const now = f.status.option ? m.status.values[f.status.option] : undefined;
    // an option Kanbo has no status for is left alone; an empty status is filled in
    if (now !== t.status && !(f.status.option && now === undefined)) {
      const option = Object.keys(m.status.values).find((k) => m.status!.values[k] === t.status);
      if (option) {
        properties[m.status.property] = f.status.type === "status" ? { status: { name: option } } : { select: { name: optionName(option) } };
        changed.push("status");
      }
    }
  }
  if (want("due") && m.due && f.date !== undefined) {
    const k = canonTaskDate(t);
    if (!sameDates(k, canonNotionDate(f.date))) {
      properties[m.due.property] = { date: k.due ? (k.start ? { start: k.start, end: k.due } : { start: k.due, end: null }) : null };
      changed.push("due");
    }
  }
  if (want("assignee") && m.assignee && f.people) {
    const n = pageAssignee(f.people, t.assignee_id, ctx);
    if (n !== undefined && n !== t.assignee_id) {
      if (!t.assignee_id) { properties[m.assignee.property] = { people: [] }; changed.push("assignee"); }
      else {
        const email = ctx.emailByMember.get(t.assignee_id);
        const nid = email ? ctx.notionUserByEmail?.get(email) : undefined;
        if (nid) { properties[m.assignee.property] = { people: [{ object: "user", id: nid }] }; changed.push("assignee"); }
      }
    }
  }
  if (want("tags") && m.tags && f.tags) {
    const labels = taskTagLabels(t, ctx);
    if (!sameSet(labels, f.tags.map((x) => x.name))) {
      const seen = new Set<string>();
      const opts = labels.map(optionName).filter((n) => n && !seen.has(tagKey(n)) && seen.add(tagKey(n))).slice(0, 100);
      properties[m.tags.property] = { multi_select: opts.map((name) => ({ name })) };
      changed.push("tags");
    }
  }
  if (want("description") && m.description && f.description !== undefined) {
    const kp = firstParagraph(t.description), np = firstParagraph(f.description);
    if (!sameText(kp, np)) {
      properties[m.description.property] = { rich_text: richText(withFirstParagraph(f.description, kp)) };
      changed.push("description");
    }
  }
  return { properties, changed };
}

/* ------------------------------------------------------------ the per-field merge */

/** The fields a sync carries (the names pushProperties reports). */
export type SyncField = "title" | "status" | "due" | "assignee" | "tags" | "description";
export const SYNC_FIELDS: readonly SyncField[] = ["title", "status", "due", "assignee", "tags", "description"];
/** Each field's value as both sides last agreed it, as a fingerprint
 *  (notion_link_state.synced). A field with no entry has no agreed value yet. */
export type Baseline = Partial<Record<SyncField, string>>;

const textKey = (s: string) => s.replace(/\s+/g, " ").trim();
const setKey = (names: string[]) => [...new Set(names.map(tagKey).filter(Boolean))].sort().join("\n");
const datesKey = (d: Dates) => `${d.start ?? ""}/${d.due ?? ""}`;

/** The Notion property behind a field (null: not mapped). */
function propertyOf(field: SyncField, m: NotionFieldMapping): string | null {
  switch (field) {
    case "title": return m.title;
    case "status": return m.status?.property ?? null;
    case "due": return m.due?.property ?? null;
    case "assignee": return m.assignee?.property ?? null;
    case "tags": return m.tags?.property ?? null;
    case "description": return m.description?.property ?? null;
  }
}

/** Kanbo's side of every mapped field, in the one form both sides compare in. */
export function kanboValues(t: SyncTask, m: NotionFieldMapping, ctx: MapContext): Partial<Record<SyncField, string>> {
  const v: Partial<Record<SyncField, string>> = { title: oneLine(t.title, LIMITS.title) || "Untitled" };
  if (m.status) v.status = t.status;
  if (m.due) v.due = datesKey(canonTaskDate(t));
  if (m.assignee) v.assignee = t.assignee_id;
  if (m.tags) v.tags = setKey(taskTagLabels(t, ctx));
  if (m.description) v.description = textKey(firstParagraph(t.description));
  return v;
}

/** The page's side, in Kanbo's terms. A field is left out when the page can't
 *  say it: its property is missing or of another kind, a status option means no
 *  Kanbo status, or its people aren't members. An empty status is "". */
export function notionValues(f: PageFields, t: SyncTask, m: NotionFieldMapping, ctx: MapContext): Partial<Record<SyncField, string>> {
  const v: Partial<Record<SyncField, string>> = { title: f.title };
  if (m.status && f.status) {
    if (!f.status.option) v.status = "";
    else { const s = m.status.values[f.status.option]; if (isKanboStatus(s)) v.status = s; }
  }
  if (m.due && f.date !== undefined) v.due = datesKey(canonNotionDate(f.date));
  if (m.assignee && f.people) { const a = pageAssignee(f.people, t.assignee_id, ctx); if (a !== undefined) v.assignee = a; }
  if (m.tags && f.tags) v.tags = setKey(f.tags.map((x) => x.name));
  if (m.description && f.description !== undefined) v.description = textKey(firstParagraph(f.description));
  return v;
}

/** A short, stable fingerprint of a field's value (cyrb53, 53 bits, base 36).
 *  The property's name is part of it, so remapping a field starts it afresh. */
export function fingerprint(field: SyncField, property: string, value: string): string {
  const s = `${field}\u0000${property}\u0000${value}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** The baseline for a task Kanbo has just made from a page (or that both sides now agree on). */
export function baselineOf(t: SyncTask, m: NotionFieldMapping, ctx: MapContext): Baseline {
  const b: Baseline = {};
  const k = kanboValues(t, m, ctx);
  for (const field of SYNC_FIELDS) {
    const p = propertyOf(field, m), v = k[field];
    if (p && v !== undefined) b[field] = fingerprint(field, p, v);
  }
  return b;
}

/** A stored baseline read defensively: known fields with short string values only. */
export function readBaseline(raw: unknown): Baseline | null {
  if (!isObj(raw)) return null;
  const b: Baseline = {};
  for (const field of SYNC_FIELDS) {
    const v = raw[field];
    if (typeof v === "string" && v.length > 0 && v.length <= 24) b[field] = v;
  }
  return b;
}

export interface SyncPlan {
  /** Notion → Kanbo */
  pull: SyncField[];
  /** Kanbo → Notion (two-way only) */
  push: SyncField[];
  /** fields the two sides already agree on */
  same: SyncField[];
  /** each taking-part field's fingerprint on each side now */
  k: Baseline;
  n: Baseline;
}

/** Which way each field goes. `notionLater`: the page was edited after the
 *  task's last change (Notion's whole-minute times make a tie Kanbo's). */
export function planSync(t: SyncTask, f: PageFields, m: NotionFieldMapping, ctx: MapContext, base: Baseline | null,
  o: { notionLater: boolean; twoWay: boolean }): SyncPlan {
  const plan: SyncPlan = { pull: [], push: [], same: [], k: {}, n: {} };
  const kv = kanboValues(t, m, ctx), nv = notionValues(f, t, m, ctx);
  for (const field of SYNC_FIELDS) {
    const p = propertyOf(field, m), a = kv[field], b = nv[field];
    if (!p || a === undefined || b === undefined) continue;   // this field takes no part
    const kf = fingerprint(field, p, a), nf = fingerprint(field, p, b);
    plan.k[field] = kf;
    plan.n[field] = nf;
    if (a === b) { plan.same.push(field); continue; }
    const was = base?.[field];
    const kChanged = was === undefined || kf !== was, nChanged = was === undefined || nf !== was;
    if (!kChanged && !nChanged) continue;
    // an empty Notion status can't be brought into Kanbo: it's filled in instead
    const toNotion = (field === "status" && b === "") || (kChanged && !nChanged) || (kChanged && nChanged && !o.notionLater);
    if (!toNotion) plan.pull.push(field);
    else if (o.twoWay) plan.push.push(field);
  }
  return plan;
}

/** The baseline after a run: agreed fields, what came in and what went out.
 *  A field that couldn't be written keeps its old fingerprint. */
export function nextBaseline(base: Baseline | null, plan: SyncPlan, pulled: readonly SyncField[], pushed: readonly SyncField[]): Baseline {
  const out: Baseline = { ...(base ?? {}) };
  for (const f of plan.same) out[f] = plan.k[f];
  for (const f of pulled) if (plan.n[f]) out[f] = plan.n[f];
  for (const f of pushed) if (plan.k[f]) out[f] = plan.k[f];
  return out;
}
export const sameBaseline = (a: Baseline | null, b: Baseline) => !!a && SYNC_FIELDS.every((f) => a[f] === b[f]);

/* ------------------------------------------------------------ the sync's place in the database */

/** notion_syncs.last_cursor: where the next run starts (≤ 200 characters).
 *  since = the newest last_edited_time already read; next = Notion's cursor
 *  when a run stopped part-way through the same query. */
export interface SyncCursor { since: string | null; next: string | null }
export function parseCursor(raw: unknown): SyncCursor {
  if (typeof raw !== "string" || !raw) return { since: null, next: null };
  if (Number.isFinite(Date.parse(raw)) && !raw.startsWith("{")) return { since: new Date(raw).toISOString(), next: null };
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const since = typeof o.s === "string" && Number.isFinite(Date.parse(o.s)) ? new Date(o.s).toISOString() : null;
    const next = typeof o.n === "string" && /^[A-Za-z0-9-]{1,120}$/.test(o.n) ? o.n : null;
    return { since, next };
  } catch { return { since: null, next: null }; }
}
export function formatCursor(c: SyncCursor): string | null {
  if (!c.since && !c.next) return null;
  const s = JSON.stringify({ s: c.since, n: c.next && c.next.length <= 120 ? c.next : null });
  return s.length <= 200 ? s : JSON.stringify({ s: c.since, n: null });
}
/** Notion's last_edited_time is rounded to the minute: read from two minutes before. */
export const OVERLAP_MS = 2 * 60_000;
