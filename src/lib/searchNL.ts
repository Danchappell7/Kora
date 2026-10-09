/* ============================================================
   KANBO — natural-language search filters (0048).      [0048 contract → u2]
   "Maya's overdue tasks in Launch"  → assignee Maya · overdue · project Launch
   "docs mentioning pricing"         → kinds [doc] · text "pricing"
   "blocked this week"               → status blocked · due this week
   "assigned to me due friday"       → assignee me · due Friday
   "comments by Theo about the deck" → kinds [comment] · author Theo · text "deck"
   Each filter found becomes a removable chip (SearchChip.patch is what it
   adds); what's left is the text to search. Dates are worked out in the
   person's timezone from `today` (pin it in tests). Names match members
   and projects (accents and case folded; "Maya's" / "Maya’s"). Words
   that are only filler ("tasks", "show me", "all") vanish. British
   English ("colour"), both spellings accepted where it matters. Never
   throws; unknown input is all text. "Quoted words" are always text.

   How it reads: the input is split into tokens (words, and "quoted
   phrases" that no rule may touch). Rules run in a fixed order, each
   claiming the tokens it understands — possessives, kinds, people,
   statuses, archived, dates, projects — and recording where they were
   (ParsedSearchNL.spans), so a chip can be taken back out of the input
   (removeChipFromInput). What nobody claimed, minus filler, is the text.

   Words that are everyday English as well as filters need a cue, so
   titles stay titles: kind words need a connector or (the app's own
   plural nouns) to lead with who or where ("docs mentioning…",
   "comments by Theo"; not "user research", "project plan"); status and
   date adjectives count alone or beside another filter or "tasks"
   ("Maya's done tasks", "late tasks"; not "closed beta", "late fees",
   "today page redesign"); a weekday's short name needs "due", "by", "on",
   "this" or "next" ("due sat"; not "sat nav"). Dates joined by "or" /
   "and" are either-or ("today or tomorrow"); side by side they narrow.
   ============================================================ */
import type { Member, ParsedSearch, Project, SearchChip, SearchChipKind, SearchFilters, SearchHitKind, Status } from "../data/types";
import { foldText } from "./searchQuery";

export interface SearchNLContext {
  members: Pick<Member, "id" | "name">[];
  projects: Pick<Project, "id" | "name">[];
  currentUserId: string;
  /** "today" for relative dates (a Date, or YYYY-MM-DD) */
  today: Date | string;
  /** the person's timezone (default Europe/London) */
  timezone?: string;
}

/** Where each chip's words sit in the input ([start, end) offsets), so the chip can be taken back out. */
export interface ParsedSearchNL extends ParsedSearch {
  spans: Record<string, [number, number][]>;
}

/* ------------------------------------------------------------------ dates (plain YYYY-MM-DD maths, no DST) */

const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const parseYmd = (s: string): Date => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
export const addDaysISO = (s: string, n: number): string => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
/** Monday = 0 … Sunday = 6 */
const dowMon = (s: string) => (parseYmd(s).getUTCDay() + 6) % 7;
const validYmd = (y: number, m: number, d: number): string | null => {
  const x = new Date(Date.UTC(y, m, d));
  return x.getUTCFullYear() === y && x.getUTCMonth() === m && x.getUTCDate() === d ? ymd(x) : null;
};

/** Today's date (YYYY-MM-DD) in a timezone. A string is taken as already being that date. */
export function todayIn(today: Date | string, timezone = "Europe/London"): string {
  if (typeof today === "string" && /^\d{4}-\d{2}-\d{2}/.test(today)) return today.slice(0, 10);
  const d = typeof today === "string" ? new Date(today) : today;
  if (Number.isNaN(d.getTime())) return ymd(new Date());
  try {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}`;
  } catch {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
}

/** a lookup table with no prototype: "constructor" or "toString" typed in the box is just a word */
const table = <V,>(entries: Record<string, V>): Record<string, V> => Object.freeze(Object.assign(Object.create(null) as Record<string, V>, entries));
const WEEKDAYS: Record<string, number> = table({
  mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, weds: 2, wednesday: 2,
  thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6,
});
/** the short names, which are everyday words too ("sat nav", "sun cream") */
const WEEKDAY_FULL = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);
const MONTHS: Record<string, number> = table({
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4, jun: 5, june: 5,
  jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
});
const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Fri 16 Oct" (with the year when it isn't this one) */
export function dayLabel(iso: string, today: string): string {
  const d = parseYmd(iso);
  const base = `${DAY_NAMES[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTH_NAMES[d.getUTCMonth()]}`;
  return iso.slice(0, 4) === today.slice(0, 4) ? base : `${base} ${iso.slice(0, 4)}`;
}

/* ------------------------------------------------------------------ tokens */

interface Tok {
  /** the token's text as typed (without surrounding punctuation; quotes kept for a phrase) */
  raw: string;
  /** folded: lower case, accents off, straight apostrophes */
  n: string;
  start: number;
  end: number;
  quoted: boolean;
  used: boolean;
}

const QUOTES_OPEN = /["“„‟″]/;
const QUOTE_CLOSE = /["”″]/;
const EDGE_PUNCT = /^[\s.,;:!?()[\]{}<>]+|[\s.,;:!?()[\]{}<>]+$/g;

function tokenise(input: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = input.length;
  while (i < n) {
    const ch = input[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (QUOTES_OPEN.test(ch)) {
      let j = i + 1;
      while (j < n && !QUOTE_CLOSE.test(input[j])) j++;
      const end = Math.min(n, j + 1);
      const raw = input.slice(i, end);
      const inner = raw.replace(/^["“„‟″]|["”″]$/g, "").trim();
      if (inner) out.push({ raw, n: foldText(inner), start: i, end, quoted: true, used: false });
      i = end;
      continue;
    }
    let j = i;
    while (j < n && !/\s/.test(input[j]) && !QUOTES_OPEN.test(input[j])) j++;
    const chunk = input.slice(i, j);
    // trim surrounding punctuation but keep offsets exact
    const lead = chunk.length - chunk.replace(/^[.,;:!?()[\]{}<>]+/, "").length;
    const core = chunk.replace(EDGE_PUNCT, "");
    if (core) {
      const start = i + lead;
      out.push({ raw: core, n: foldText(core), start, end: start + core.length, quoted: false, used: false });
    }
    i = j;
  }
  return out;
}

/** "maya's" / "maya’s" (folded to a straight apostrophe) / "james'" → the name; null when not a possessive */
const possessiveBase = (n: string): string | null => {
  const m = /^(.+?)(?:'s|')$/.exec(n);
  return m && /\p{L}/u.test(m[1]) ? m[1] : null;
};
/** letters and digits only (for name comparison) */
const bare = (s: string) => foldText(s).replace(/[^\p{L}\p{N}]+/gu, "");
const nameWords = (s: string) => foldText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/* ------------------------------------------------------------------ vocabulary */

/** words that never name a person or a project on their own */
const STOP = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "by", "with", "and", "or", "me", "my", "mine", "i", "all", "any", "it",
  "is", "are", "be", "at", "from", "this", "that", "these", "those", "next", "last", "due", "not", "no", "new", "old", "about",
  "task", "tasks", "doc", "docs", "comment", "comments", "project", "projects", "people", "open", "done", "blocked", "review",
  "today", "tomorrow", "yesterday", "week", "month", "overdue", "archived", "show", "find", "search", "everything", "anything",
]);
const KIND_WORDS: Record<string, SearchHitKind> = table({
  task: "task", tasks: "task", todos: "task",
  comment: "comment", comments: "comment", reply: "comment", replies: "comment",
  doc: "doc", docs: "doc", document: "doc", documents: "doc", page: "doc", pages: "doc", wiki: "doc",
  project: "project", projects: "project",
  people: "person", person: "person", member: "person", members: "person", teammate: "person", teammates: "person",
  colleague: "person", colleagues: "person", user: "person", users: "person",
});
const KIND_LABEL: Record<SearchHitKind, string> = { task: "Tasks", comment: "Comments", doc: "Docs", project: "Projects", person: "People" };
/** the app's own nouns. The other kind words (user, page, document, reply, member, wiki…) are everyday words
 *  in titles ("user research", "page speed", "reply to client"), so they're a filter only before a clear
 *  connector ("pages mentioning…", "users named…") */
const STRONG_KINDS = new Set(["task", "tasks", "comment", "comments", "doc", "docs", "project", "projects", "people", "person"]);
/** …and the plural ones, which may lead with who or where ("comments by Theo", "docs in Launch") */
const PLURAL_KINDS = new Set(["tasks", "comments", "docs", "projects", "people"]);
const KIND_PREPS = new Set(["by", "from", "in", "on", "for", "within", "under", "across"]);
/** after a kind word: "docs mentioning…", "comments about…", "people named…" */
const CONNECTORS = new Set(["mentioning", "mention", "mentions", "about", "containing", "contain", "contains", "with", "saying", "says",
  "named", "called", "regarding", "re", "matching", "match", "matches", "like", "including"]);
/** the connectors that are clear enough after an everyday kind word ("page with broken links" is a title) */
const WEAK_CONNECTORS = new Set([...CONNECTORS].filter((w) => !["with", "like", "including", "re"].includes(w)));
/** a kind word that would be read as a filter after a possessive ("Theo's comments", "Maya's replies"; "Maya's page" is hers) */
const possessiveKind = (w: string): SearchHitKind | undefined => (STRONG_KINDS.has(w) || KIND_WORDS[w] === "comment" ? KIND_WORDS[w] : undefined);
/** the cues that make a weekday abbreviation a date ("due fri", "by sat"; "sat nav" and "sun cream" are words) */
const ABBR_CUES = new Set(["due", "by", "on", "before", "after", "until", "till", "from", "since"]);
/** dropped from the text once a filter has been read */
const SOFT_FILLER = new Set(["task", "tasks", "item", "items", "thing", "things", "stuff", "ones", "one", "work", "everything", "anything", "todos"]);
/** always dropped from the text (they'd only narrow a word search) */
const FILLER = new Set([
  "show", "find", "search", "list", "get", "give", "fetch", "display", "see", "view", "look",
  "the", "a", "an", "all", "any", "every", "please", "that", "which", "who", "whose", "what", "whats", "what's", "where", "when",
  "are", "is", "was", "were", "be", "being", "been", "has", "have", "had", "and", "or", "of", "to", "for", "in", "on", "at", "by", "from",
  "with", "due", "assigned", "assignee", "mentioning", "mention", "mentions", "about", "containing", "contain", "contains",
  "regarding", "re", "saying", "says", "named", "called", "matching", "match", "matches", "including", "include", "incl", "also",
  "my", "me", "mine", "our", "ours", "i", "status", "statuses", "whos", "who's", "?",
]);

/* ------------------------------------------------------------------ the parser */

type ChipAcc = { kind: SearchChipKind; label: string; patch: SearchFilters; ranges: [number, number][]; at: number };

/** Parse a search box's input into text + filters + chips. */
export function parseSearchNL(input: string, ctx: SearchNLContext): ParsedSearchNL {
  try { return parse(input ?? "", ctx); }
  catch { return { input: input ?? "", text: (input ?? "").trim(), filters: {}, chips: [], spans: {} }; }
}

function parse(input: string, ctx: SearchNLContext): ParsedSearchNL {
  const toks = tokenise(input);
  const today = todayIn(ctx.today, ctx.timezone);
  const me = ctx.currentUserId;
  const chips = new Map<SearchChipKind, ChipAcc>();

  const free = (i: number) => i >= 0 && i < toks.length && !toks[i].used && !toks[i].quoted;
  const is = (i: number, ...words: string[]) => free(i) && words.includes(toks[i].n);
  const take = (from: number, to: number): [number, number] => {
    for (let k = from; k <= to; k++) toks[k].used = true;
    return [toks[from].start, toks[to].end];
  };
  /** first free, non-filler token index (where the input "starts") */
  const firstContent = () => {
    for (let k = 0; k < toks.length; k++) {
      if (toks[k].quoted) return k;
      if (toks[k].used) continue;
      if (!FILLER.has(toks[k].n)) return k;
    }
    return -1;
  };
  const add = (kind: SearchChipKind, label: string, patch: SearchFilters, range: [number, number]) => {
    const prev = chips.get(kind);
    if (prev) { prev.ranges.push(range); prev.at = Math.min(prev.at, range[0]); return prev; }
    const c: ChipAcc = { kind, label, patch, ranges: [range], at: range[0] };
    chips.set(kind, c);
    return c;
  };

  /* ---- people: a member by name at token i (1–3 words); "me", "myself", "i" are you */
  const memberAt = (i: number, opts: { possessive?: boolean; allowMe?: boolean } = {}): { id: string; name: string; last: number } | null => {
    if (!free(i)) return null;
    if (opts.allowMe && ["me", "myself", "mine", "i"].includes(toks[i].n) && me) return { id: me, name: "Me", last: i };
    for (let len = 3; len >= 1; len--) {
      const last = i + len - 1;
      if (last >= toks.length) continue;
      let ok = true;
      for (let k = i; k <= last; k++) if (!free(k)) ok = false;
      if (!ok) continue;
      const words = toks.slice(i, last + 1).map((t) => t.n);
      if (opts.possessive) {
        const base = possessiveBase(words[words.length - 1]);
        if (!base) continue;
        words[words.length - 1] = base;
      } else if (possessiveBase(words[words.length - 1])) continue;
      if (len === 1 && STOP.has(words[0])) continue;
      const phrase = bare(words.join(""));
      if (!phrase) continue;
      const hit = matchPerson(phrase, words, ctx.members);
      if (hit) return { id: hit.id, name: hit.name, last };
    }
    if (opts.possessive && free(i) && possessiveBase(toks[i].n) === "my" && me) return { id: me, name: "Me", last: i };
    return null;
  };

  /* ---- projects: "Q3 Product Launch", "launch", "the launch project" */
  const projectAt = (i: number): { id: string; name: string; last: number } | null => {
    let s = i;
    if (is(s, "the")) s++;
    if (!free(s)) return null;
    // "#launch"
    if (toks[s].n.startsWith("#") && toks[s].n.length > 1) {
      const p = matchProjectName(toks[s].n.slice(1), [toks[s].n.slice(1)], ctx.projects, true);
      return p ? { ...p, last: s } : null;
    }
    for (let len = 5; len >= 1; len--) {
      const last = s + len - 1;
      if (last >= toks.length) continue;
      let ok = true;
      for (let k = s; k <= last; k++) if (!free(k)) ok = false;
      if (!ok) continue;
      const words = toks.slice(s, last + 1).map((t) => t.n);
      if (len === 1 && STOP.has(words[0])) continue;
      const p = matchProjectName(words.join(" "), words, ctx.projects, false);
      if (p) {
        // "the launch project"
        const end = is(last + 1, "project") ? last + 1 : last;
        return { ...p, last: end };
      }
    }
    return null;
  };

  /* ---- 1. possessives: "Maya's", "my", "today's" (and "Theo's comments": the author) */
  for (let i = 0; i < toks.length; i++) {
    if (!free(i)) continue;
    const n = toks[i].n;
    const base = possessiveBase(n);
    if (base === "today" || base === "tomorrow") continue;   // read by the dates
    if (n === "my" || n === "mine" || n === "our") {
      if (n === "our") continue;
      const nextKind = free(i + 1) ? possessiveKind(toks[i + 1].n) : undefined;
      if (nextKind === "comment") { add("author", "By me", { authorId: me }, take(i, i)); continue; }
      if (nextKind && nextKind !== "task") continue;                       // "my docs": just docs
      if (n === "my" && !me) continue;
      add("assignee", "Assigned to me", { assigneeId: me }, take(i, i));
      continue;
    }
    if (!base) continue;
    const m = memberAt(i, { possessive: true });
    if (!m) continue;
    const nextKind = free(m.last + 1) ? possessiveKind(toks[m.last + 1].n) : undefined;
    if (nextKind === "comment") {
      add("author", `By ${m.name}`, { authorId: m.id }, take(i, m.last));
    } else if (!nextKind || nextKind === "task") {
      if (!chips.has("assignee")) add("assignee", m.id === me ? "Assigned to me" : m.name, { assigneeId: m.id }, take(i, m.last));
    }
  }

  /* ---- 2. kinds: "docs mentioning…", "comments by Theo", "pricing in docs", "docs and comments about…".
     A kind word is a filter only with a cue: a connector after it, "in" before it, a possessive, or (the
     app's own plural nouns) leading the search with who or where, or standing alone. Bare everyday words
     ("user research", "project plan", "reply to client") stay words. */
  const kinds: SearchHitKind[] = [];
  const first = firstContent();
  /** connectors taken into a kind chip: what follows them is the subject, never a filter's neighbour */
  const connectorAt = new Set<number>();
  for (let i = 0; i < toks.length; i++) {
    if (!free(i) || !KIND_WORDS[toks[i].n]) continue;
    // "docs and comments", "docs or pages": one chain, one cue
    const chain = [i];
    for (let j = i; is(j + 1, "and", "or") && free(j + 2) && KIND_WORDS[toks[j + 2].n]; j += 2) chain.push(j + 2);
    const last = chain[chain.length - 1];
    const words = chain.map((k) => toks[k].n);
    const nx = free(last + 1) ? toks[last + 1].n : "";
    const connector = !!nx && (STRONG_KINDS.has(toks[last].n) ? CONNECTORS : WEAK_CONNECTORS).has(nx);
    // "docs that mention…", "pages which mention…"
    const thatConnector = !connector && (nx === "that" || nx === "which") && free(last + 2) && CONNECTORS.has(toks[last + 2].n);
    const strong = words.every((w) => STRONG_KINDS.has(w));
    const plural = words.every((w) => PLURAL_KINDS.has(w));
    const lead = i === first;
    const alone = strong && toks.filter((t) => !t.quoted && !t.used && !FILLER.has(t.n)).length === chain.length;
    const afterIn = plural && i > 0 && is(i - 1, "in", "within", "among", "across");
    const prevPossessive = i > 0 && toks[i - 1].used && (!!possessiveBase(toks[i - 1].n) || ["my", "mine"].includes(toks[i - 1].n))
      && words.every((w) => !!possessiveKind(w));
    // "comments by Theo", "docs in Launch", "projects for Q4"
    const leadCue = lead && plural && KIND_PREPS.has(nx);
    // "comment by Theo"
    const personCue = lead && strong && (nx === "by" || nx === "from") && !!memberAt(last + 2, { allowMe: true });
    if (!(connector || thatConnector || alone || afterIn || prevPossessive || leadCue || personCue)) { i = last; continue; }
    // tasks are a filter only when asked for outright ("tasks mentioning…", "tasks and docs…"); otherwise they're filler
    const found = words.map((w) => KIND_WORDS[w]).filter((k) => k !== "task" || connector || thatConnector || chain.length > 1);
    if (!found.length) { i = last; continue; }
    for (const k of found) if (!kinds.includes(k)) kinds.push(k);
    const to = connector ? last + 1 : thatConnector ? last + 2 : last;
    if (connector) connectorAt.add(last + 1);
    if (thatConnector) connectorAt.add(last + 2);
    add("kind", "", {}, take(afterIn ? i - 1 : i, to));
    i = to;
  }
  if (kinds.length) {
    const c = chips.get("kind")!;
    c.patch = { kinds };
    c.label = kinds.length === 1 ? KIND_LABEL[kinds[0]] : kinds.map((k, ix) => (ix === 0 ? KIND_LABEL[k] : KIND_LABEL[k].toLowerCase())).join(" and ");
  }
  const commentsOnly = kinds.length > 0 && kinds.every((k) => k === "comment");

  /* ---- 3. people: "assigned to Maya", "for Theo", "by Theo", "from Sana", "with Idris", "mine" */
  for (let i = 0; i < toks.length; i++) {
    if (!free(i)) continue;
    const n = toks[i].n;
    const from = i;
    let at = -1, role: "assignee" | "author" | null = null;
    if (n === "assigned" || n === "assignee" || n === "owned") {
      at = is(i + 1, "to", "by") ? i + 2 : i + 1;
      role = "assignee";
    } else if (n === "for" || n === "with") {
      at = i + 1; role = "assignee";
    } else if (n === "by" || n === "from" || n === "author" || n === "written") {
      at = is(i + 1, "by") ? i + 2 : i + 1;
      role = commentsOnly ? "author" : "assignee";
    } else if (n === "mine") {
      if (me && !chips.has("assignee")) add("assignee", "Assigned to me", { assigneeId: me }, take(i, i));
      continue;
    }
    if (!role || at < 0) continue;
    const m = memberAt(at, { allowMe: true });
    if (!m) continue;
    if (chips.has(role)) continue;
    const isMe = m.id === me;
    if (role === "author") add("author", isMe ? "By me" : `By ${m.name}`, { authorId: m.id }, take(from, m.last));
    else add("assignee", isMe ? "Assigned to me" : m.name, { assigneeId: m.id }, take(from, m.last));
  }

  /* ---- 4. statuses. The names ("blocked", "in review", "to do") count anywhere; the everyday adjectives
     ("done", "closed", "started", "pending"…) wait for step 8, which reads them as filters only in context
     ("closed beta", "definition of done" and "pending invoices" are titles) */
  const statuses: { s: Status; at: number }[] = [];
  const addStatus = (s: Status, from: number, to: number) => {
    if (!statuses.some((x) => x.s === s)) statuses.push({ s, at: toks[from].start });
    // "blocked or in review": the "or" between two statuses goes with them
    const ranges = chips.get("status")?.ranges ?? [];
    if (from > 1 && is(from - 1, "or", "and") && toks[from - 2].used && ranges.some((r) => r[1] === toks[from - 2].end)) from -= 1;
    else if (to + 2 < toks.length && is(to + 1, "or", "and") && toks[to + 2].used && ranges.some((r) => r[0] === toks[to + 2].start)) to += 1;
    add("status", "", {}, take(from, to));
  };
  const addOpen = (from: number, to: number) => add("open", "Open", { excludeDone: true }, take(from, to));
  /** words that are a filter only in context (step 8): [from, to] and what they'd add */
  const pending: { from: number; to: number; apply: () => void }[] = [];
  const later = (from: number, to: number, apply: () => void) => pending.push({ from, to, apply });
  for (let i = 0; i < toks.length; i++) {
    if (!free(i)) continue;
    const n = toks[i].n;
    const nx = free(i + 1) ? toks[i + 1].n : "";
    const at = i;
    if (n === "blocked") addStatus("blocked", i, i);
    else if (n === "stuck") later(at, at, () => addStatus("blocked", at, at));
    else if ((n === "on" && nx === "hold")) addStatus("blocked", i, i + 1);
    else if ((n === "in" || n === "under" || n === "awaiting" || n === "needs") && (nx === "review" || nx === "reviews")) addStatus("review", i, i + 1);
    else if (n === "for" && (nx === "review" || nx === "reviews")) later(at, at + 1, () => addStatus("review", at, at + 1));
    else if (n === "in-review") addStatus("review", i, i);
    else if (n === "reviewing") later(at, at, () => addStatus("review", at, at));
    else if (n === "in" && nx === "progress") addStatus("progress", i, i + 1);
    else if (["in-progress", "wip"].includes(n)) addStatus("progress", i, i);
    else if (["ongoing", "started", "underway", "doing"].includes(n)) later(at, at, () => addStatus("progress", at, at));
    else if (n === "under" && nx === "way") later(at, at + 1, () => addStatus("progress", at, at + 1));
    else if (n === "to" && nx === "do") addStatus("todo", i, i + 1);
    else if (["todo", "to-do", "unstarted"].includes(n)) addStatus("todo", i, i);
    else if (n === "not" && (nx === "started" || nx === "begun")) addStatus("todo", i, i + 1);
    else if (["done", "completed", "finished", "closed", "complete"].includes(n) && !(n === "complete" && i === firstContent())) {
      if (n === "done" && is(i - 1, "not")) continue;
      later(at, at, () => addStatus("done", at, at));
    } else if (n === "not" && (nx === "done" || nx === "finished" || nx === "completed" || nx === "closed")) {
      addOpen(i, i + 1);
    } else if (["incomplete", "unfinished", "outstanding", "remaining", "pending", "unresolved"].includes(n)) {
      later(at, at, () => addOpen(at, at));
    } else if (n === "open") {
      // "open" is a filter before a noun ("open tasks"), after a possessive, or at the very end; "open bank account" is a title
      const end = !toks.slice(i + 1).some((t) => t.quoted || (!t.used && !FILLER.has(t.n) && !SOFT_FILLER.has(t.n)));
      if (SOFT_FILLER.has(nx) || end || (i > 0 && toks[i - 1].used)) add("open", "Open", { excludeDone: true }, take(i, i));
    }
  }
  /* ---- 5. archived */
  for (let i = 0; i < toks.length; i++) {
    if (!free(i) || !["archived", "archive", "archives"].includes(toks[i].n)) continue;
    let from = i;
    if (is(i - 1, "including", "incl", "include", "with", "and", "plus", "also")) from = i - 1;
    if (is(i - 1, "in", "the") && toks[i].n !== "archived") from = i - 1;
    const to = is(i + 1, "too", "as", "also") ? (is(i + 1, "as") && is(i + 2, "well") ? i + 2 : i + 1) : i;
    add("archived", "Including archived", { includeArchived: true }, take(from, to));
  }

  /* ---- 6. dates. Explicit ones ("due today", "by friday", "next week", "16 oct", "overdue") count
     anywhere; everyday words ("today", "late", "upcoming", "friday") wait for step 8; a weekday's short
     name ("sat", "sun") needs a cue ("due sat", "by fri", "this wed"). */
  const dueParts: { range: DueRange; from: number; to: number }[] = [];
  const addDue = (r: DueRange, from: number, to: number) => {
    dueParts.push({ range: r, from, to });
    add("due", "", {}, take(from, to));
  };
  for (let i = 0; i < toks.length; i++) {
    if (!free(i)) continue;
    let s = i;
    let lead: "due" | "by" | "after" | null = null;
    const n0 = toks[s].n;
    if (n0 === "due" || n0 === "on" || n0 === "for" || n0 === "dated") { lead = "due"; s++; if (is(s, "on", "for", "by", "before", "until", "till", "after")) { lead = ["by", "before", "until", "till"].includes(toks[s].n) ? "by" : toks[s].n === "after" ? "after" : "due"; s++; } }
    else if (["by", "before", "until", "till"].includes(n0)) { lead = "by"; s++; }
    else if (n0 === "after" || n0 === "since" || n0 === "from") { lead = "after"; s++; }
    const r = readDate(s, today);
    if (!r) continue;
    // "sat nav", "sun cream", "for sat"… a short weekday name is a date only after a cue
    if (r.abbr && !(lead && (ABBR_CUES.has(n0) || ABBR_CUES.has(toks[s - 1]?.n ?? "")))) continue;
    let range: DueRange = r.range;
    const kind = r.range.kind;
    if (lead === "by" && kind !== "overdue") {
      const before = n0 === "before" || (s > 0 && toks[s - 1].n === "before");
      const end = range.to ?? range.from!;
      range = { from: undefined, to: before ? addDaysISO(range.from ?? end, -1) : end, label: `Due ${before ? "before" : "by"} ${r.phrase}`, kind: "by" };
    } else if (lead === "after" && kind !== "overdue") {
      const startDay = n0 === "after" || toks[s - 1]?.n === "after" ? addDaysISO(range.to ?? range.from!, 1) : range.from!;
      range = { from: startDay, to: undefined, label: `Due ${n0 === "after" || toks[s - 1]?.n === "after" ? "after" : "from"} ${r.phrase}`, kind: "after" };
    }
    if (!lead && r.soft) { const rr = range, at = i, last = r.last; later(at, last, () => addDue(rr, at, last)); i = last; continue; }
    addDue(range, i, r.last);
  }

  /** A date phrase at token s: its range, last token and words. `soft`: an everyday word (a filter only in
   *  context, step 8); `abbr`: a weekday's short name (a filter only after a cue). */
  function readDate(s: number, t: string): { range: DueRange; last: number; phrase: string; soft?: boolean; abbr?: boolean } | null {
    if (!free(s)) return null;
    const w = (k: number) => (free(k) ? toks[k].n : "");
    const a = w(s), b = w(s + 1), c = w(s + 2);
    const one = (from: string, to: string, label: string, phrase: string, last: number, kind: DueKind = "day"): { range: DueRange; last: number; phrase: string } =>
      ({ range: { from, to, label, kind }, last, phrase });
    const soft = <T extends object>(x: T) => ({ ...x, soft: true });
    const overdue = (last: number) => ({ range: { to: addDaysISO(t, -1), open: true, label: "Overdue", kind: "overdue" as DueKind }, last, phrase: "overdue" });
    if (a === "overdue") return overdue(s);
    if (a === "late") return soft(overdue(s));
    if (a === "past" && b === "due") return overdue(s + 1);
    if (a === "eod") return one(t, t, "Due today", "today", s);
    if (["today", "today's", "tonight", "tod"].includes(a)) return soft(one(t, t, "Due today", "today", s));
    if (["tomorrow", "tomorrow's", "tmrw", "tmr"].includes(a)) return soft(one(addDaysISO(t, 1), addDaysISO(t, 1), "Due tomorrow", "tomorrow", s));
    if (a === "yesterday" || a === "yesterday's") return soft(one(addDaysISO(t, -1), addDaysISO(t, -1), "Due yesterday", "yesterday", s));
    if (a === "soon" || a === "upcoming") return soft(one(t, addDaysISO(t, 7), "Due soon", "soon", s, "range"));
    if (a === "coming" && b === "up") return soft(one(t, addDaysISO(t, 7), "Due soon", "soon", s + 1, "range"));
    const mon = addDaysISO(t, -dowMon(t));
    const weekOffset = (x: string) => (x === "this" || x === "the" ? 0 : x === "next" ? 1 : x === "last" ? -1 : null);
    // "friday next week", "next week fri": that week's day
    const dayInWeek = (offset: number, wd: string, last: number) => {
      const day = addDaysISO(mon, 7 * offset + WEEKDAYS[wd]);
      return one(day, day, `Due ${dayLabel(day, t)}`, dayLabel(day, t), last);
    };
    if (a in WEEKDAYS && weekOffset(b) !== null && (c === "week" || c === "wk")) return dayInWeek(weekOffset(b)!, a, s + 2);
    if (weekOffset(a) !== null && a !== "the" && (b === "week" || b === "wk") && c in WEEKDAYS) return dayInWeek(weekOffset(a)!, c, s + 2);
    const weekRange = (offset: number, label: string, phrase: string, last: number) => one(addDaysISO(mon, 7 * offset), addDaysISO(mon, 7 * offset + 6), label, phrase, last, "range");
    const monthRange = (offset: number, label: string, phrase: string, last: number) => {
      const d = parseYmd(t);
      const f = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1));
      const l = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset + 1, 0));
      return one(ymd(f), ymd(l), label, phrase, last, "range");
    };
    if ((a === "this" || a === "the") && (b === "week" || b === "wk")) return weekRange(0, "Due this week", "this week", s + 1);
    if (a === "next" && (b === "week" || b === "wk")) return weekRange(1, "Due next week", "next week", s + 1);
    if (a === "last" && (b === "week" || b === "wk")) return weekRange(-1, "Due last week", "last week", s + 1);
    if (a === "eow" || (a === "end" && b === "of" && (c === "week" || (c === "the" && w(s + 3) === "week")))) {
      const fri = addDaysISO(mon, 4);
      return one(fri, fri, `Due ${dayLabel(fri, t)}`, dayLabel(fri, t), a === "eow" ? s : c === "the" ? s + 3 : s + 2);
    }
    if ((a === "this" || a === "the") && b === "month") return monthRange(0, "Due this month", "this month", s + 1);
    if (a === "next" && b === "month") return monthRange(1, "Due next month", "next month", s + 1);
    if (a === "last" && b === "month") return monthRange(-1, "Due last month", "last month", s + 1);
    if (a === "weekend" || ((a === "this" || a === "the") && b === "weekend") || (a === "next" && b === "weekend")) {
      const sat = addDaysISO(mon, a === "next" ? 12 : 5);
      const r = one(sat, addDaysISO(sat, 1), a === "next" ? "Due next weekend" : "Due this weekend", a === "next" ? "next weekend" : "this weekend", a === "weekend" ? s : s + 1, "range");
      return a === "weekend" ? soft(r) : r;
    }
    // "next 7 days", "the next 2 weeks", "last 3 days"
    {
      let k = s;
      if (w(k) === "in" && w(k + 1) === "the") k += 2;
      else if (w(k) === "the") k += 1;
      const dir = w(k);
      const num = Number(w(k + 1));
      const unit = w(k + 2);
      if ((dir === "next" || dir === "last" || dir === "past") && Number.isInteger(num) && num > 0 && num <= 366 && /^(days?|weeks?|wks?)$/.test(unit)) {
        const span = /^d/.test(unit) ? num : num * 7;
        const label = `${dir === "next" ? "Due in the next" : "Due in the last"} ${num} ${/^d/.test(unit) ? (num === 1 ? "day" : "days") : (num === 1 ? "week" : "weeks")}`;
        return dir === "next" ? one(t, addDaysISO(t, span), label, label.slice(4), k + 2, "range") : one(addDaysISO(t, -span), addDaysISO(t, -1), label, label.slice(4), k + 2, "range");
      }
    }
    // weekdays: "friday" (the next one, today included), "this fri", "next tue" (next week's)
    {
      const pre = a === "this" || a === "next" || a === "last" ? a : "";
      const wd = pre ? b : a;
      if (wd in WEEKDAYS) {
        const target = WEEKDAYS[wd];
        const td = dowMon(t);
        let day: string;
        if (pre === "next") day = addDaysISO(mon, 7 + target);
        else if (pre === "last") day = addDaysISO(t, -(((td - target + 7) % 7) || 7));
        else day = addDaysISO(t, (target - td + 7) % 7);
        const r = one(day, day, `Due ${dayLabel(day, t)}`, dayLabel(day, t), pre ? s + 1 : s);
        // "this fri", "next tue": a date. "friday" alone: in context ("Friday standup" is a title); "sat": after a cue
        return pre ? r : WEEKDAY_FULL.has(wd) ? soft(r) : { ...r, soft: true, abbr: true };
      }
    }
    // dates: 2026-10-16 · 16/10(/2026) · 16 oct (2026) · 16th of October · oct 16(th)
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(a);
    if (m) { const d = validYmd(+m[1], +m[2] - 1, +m[3]); if (d) return one(d, d, `Due ${dayLabel(d, t)}`, dayLabel(d, t), s); }
    m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/.exec(a);
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : +t.slice(0, 4);
      const d = validYmd(y, +m[2] - 1, +m[1]);
      if (d) return one(d, d, `Due ${dayLabel(d, t)}`, dayLabel(d, t), s);
    }
    const dayNum = (x: string) => { const r = /^(\d{1,2})(?:st|nd|rd|th)?$/.exec(x); return r ? +r[1] : null; };
    const yearAt = (k: number) => (/^\d{4}$/.test(w(k)) ? +w(k) : null);
    {
      const dn = dayNum(a);
      if (dn !== null) {
        let k = s + 1;
        if (w(k) === "of") k++;
        const mo = w(k).replace(/\.$/, "");
        if (mo in MONTHS) {
          const yr = yearAt(k + 1);
          const d = validYmd(yr ?? +t.slice(0, 4), MONTHS[mo], dn);
          if (d) return one(d, d, `Due ${dayLabel(d, t)}`, dayLabel(d, t), yr ? k + 1 : k);
        }
      }
      const mo = a.replace(/\.$/, "");
      if (mo in MONTHS && !STOP.has(mo)) {
        const dn2 = dayNum(b);
        if (dn2 !== null) {
          const yr = yearAt(s + 2);
          const d = validYmd(yr ?? +t.slice(0, 4), MONTHS[mo], dn2);
          if (d) return one(d, d, `Due ${dayLabel(d, t)}`, dayLabel(d, t), yr ? s + 2 : s + 1);
        }
      }
    }
    return null;
  }

  /* ---- 7. projects: "in Launch", "for Brand Refresh", "#launch", "project Launch" */
  for (let i = 0; i < toks.length; i++) {
    if (!free(i) || chips.has("project")) continue;
    const n = toks[i].n;
    if (n.startsWith("#")) {
      const p = projectAt(i);
      if (p) add("project", `In ${p.name}`, { projectId: p.id }, take(i, p.last));
      continue;
    }
    if (!["in", "for", "on", "within", "under", "inside", "from", "project", "across"].includes(n)) continue;
    const p = projectAt(i + 1);
    if (p) add("project", `In ${p.name}`, { projectId: p.id }, take(i, p.last));
  }

  /* ---- 8. the everyday words ("done", "closed", "pending", "late", "upcoming", "today", "friday"): a
     filter when they stand alone, or sit next to another filter, a word like "tasks", or each other
     ("Maya's done tasks", "done last week", "blocked today", "today or tomorrow"). Otherwise they're
     words: "definition of done", "closed beta", "late fees", "upcoming webinar", "today page redesign". */
  {
    const open = pending.filter((p) => toks.slice(p.from, p.to + 1).every((t) => !t.used));
    const inOpen = (k: number) => open.some((p) => k >= p.from && k <= p.to && !toks[k].used);
    // alone: every word left (fillers aside) is one of them ("done", "today", "monday or tuesday")
    const content = toks.map((t, k) => ({ t, k })).filter(({ t }) => t.quoted || (!t.used && !FILLER.has(t.n) && !SOFT_FILLER.has(t.n)));
    const alone = content.length > 0 && content.every(({ t, k }) => !t.quoted && inOpen(k));
    const besideFilter = (p: { from: number; to: number }): boolean => {
      for (const [start, step] of [[p.from - 1, -1], [p.to + 1, 1]] as const) {
        for (let k = start; k >= 0 && k < toks.length; k += step) {
          const t = toks[k];
          if (t.quoted || connectorAt.has(k)) break;          // "comments about closed beta": the subject
          if (t.used || SOFT_FILLER.has(t.n) || inOpen(k)) return true;
          if (FILLER.has(t.n)) continue;                       // "the", "and", "or", "of"…
          break;
        }
      }
      return false;
    };
    const ok = open.filter((p) => alone || besideFilter(p));
    for (const p of ok) if (toks.slice(p.from, p.to + 1).every((t) => !t.used)) p.apply();
  }
  if (statuses.length) {
    const c = chips.get("status")!;
    const ordered = [...statuses].sort((x, y) => x.at - y.at).map((x) => x.s);
    c.patch = { statuses: ordered };
    c.label = ordered.map((s, ix) => (ix === 0 ? STATUS_WORD[s] : STATUS_WORD[s].toLowerCase())).join(" or ");
  }
  if (dueParts.length) {
    const c = chips.get("due")!;
    const { patch, label, joiners } = combineDue(dueParts.sort((x, y) => x.from - y.from), toks, input);
    for (const k of joiners) if (free(k)) add("due", "", {}, take(k, k));
    c.patch = patch;
    c.label = label;
  }

  /* ---- leftovers → text */
  const anyChip = chips.size > 0;
  const keep = toks.filter((t) => !t.used && (t.quoted || !(FILLER.has(t.n) || (anyChip && SOFT_FILLER.has(t.n)))));
  let text = keep.map((t) => t.raw).join(" ").replace(/\s+/g, " ").trim();
  if (!anyChip && !text) text = input.trim().replace(/\s+/g, " ");
  // a stray possessive "'s" left on a name we didn't know stays as typed

  const list: SearchChip[] = [...chips.values()]
    .filter((c) => c.label)
    .sort((x, y) => x.at - y.at)
    .map((c) => ({ id: c.kind, kind: c.kind, label: c.label, patch: c.patch, source: joinRanges(c.ranges, input) }));
  const spans: Record<string, [number, number][]> = {};
  for (const c of chips.values()) if (c.label) spans[c.kind] = c.ranges.slice().sort((x, y) => x[0] - y[0]);
  return { input, text, filters: chipsToFilters(list), chips: list, spans };
}

/** a chip's words as typed: touching ranges run together ("today or tomorrow"), others are joined with " … " */
function joinRanges(ranges: [number, number][], input: string): string {
  const sorted = ranges.slice().sort((x, y) => x[0] - y[0]);
  let out = "";
  let end = -1;
  for (const [a, b] of sorted) {
    if (!out) out = input.slice(a, b);
    else out += (/^\s*$/.test(input.slice(end, a)) ? input.slice(end, a) : " … ") + input.slice(a, b);
    end = b;
  }
  return out;
}

type DueKind = "day" | "range" | "overdue" | "by" | "after";
interface DueRange { from?: string; to?: string; open?: boolean; label: string; kind: DueKind }

/** Several date phrases → one range. Joined by "or" / "and" / a comma ("today or tomorrow", "overdue or due
 *  today", "this week or next week") they're either-or: the span that covers them all. Side by side they
 *  narrow each other ("overdue this week") — unless that leaves nothing, when they're either-or too.
 *  An explicit bound ("by friday", "after 16 oct") always narrows. Open work only (excludeDone) is kept if any
 *  part asks for it: an either-or with "overdue" without it would list every finished task in history. */
function combineDue(parts: { range: DueRange; from: number; to: number }[], toks: Tok[], input: string): { patch: SearchFilters; label: string; joiners: number[] } {
  const minS = (a?: string, b?: string) => (a && b ? (a < b ? a : b) : undefined);
  const maxS = (a?: string, b?: string) => (a && b ? (a > b ? a : b) : undefined);
  let from = parts[0].range.from, to = parts[0].range.to, open = !!parts[0].range.open;
  let label = parts[0].range.label;
  let lastLabel = label;
  const joiners: number[] = [];
  for (let k = 1; k < parts.length; k++) {
    const prev = parts[k - 1], cur = parts[k].range;
    const between = input.slice(toks[prev.to].end, toks[parts[k].from].start);
    const joined = /^(?:\s|,|&|\/|\bor\b|\band\b|\beither\b)+$/i.test(between) && /,|&|\/|\bor\b|\band\b/i.test(between);
    const bound = cur.kind === "by" || cur.kind === "after" || prev.range.kind === "by" || prev.range.kind === "after";
    // narrowed: the later start, the earlier end (an open end takes the other's)
    const nFrom = from && cur.from ? (from > cur.from ? from : cur.from) : from ?? cur.from;
    const nTo = to && cur.to ? (to < cur.to ? to : cur.to) : to ?? cur.to;
    const empty = !!(nFrom && nTo && nFrom > nTo);
    const either = !bound && (joined || empty);
    if (either) {
      from = minS(from, cur.from); to = maxS(to, cur.to);
      // "Due today or tomorrow", "Overdue or due today"
      label += " or " + (lastLabel.startsWith("Due ") && cur.label.startsWith("Due ") ? cur.label.slice(4) : lower(cur.label));
      if (joined) for (let j = prev.to + 1; j < parts[k].from; j++) if (["or", "and", "either"].includes(toks[j].n)) joiners.push(j);
    } else {
      from = nFrom; to = nTo;
      label += ", " + lower(cur.label);
    }
    open = open || !!cur.open;
    lastLabel = cur.label;
  }
  const patch: SearchFilters = {};
  if (from) patch.dueFrom = from;
  if (to) patch.dueTo = to;
  if (open) patch.excludeDone = true;
  return { patch, label, joiners };
}
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

const STATUS_WORD: Record<Status, string> = { todo: "To do", progress: "In progress", review: "In review", blocked: "Blocked", done: "Done" };

/** a person by name: full name, first or last name exactly, or (4+ letters) the start of one */
function matchPerson<M extends { id: string; name: string }>(phrase: string, words: string[], members: M[]): M | undefined {
  const c = members.map((m) => ({ m, full: bare(m.name), ws: nameWords(m.name).map(bare).filter(Boolean) }));
  const exact = c.find((x) => x.full === phrase) ?? (words.length === 1 ? c.find((x) => x.ws.includes(phrase)) : undefined);
  if (exact) return exact.m;
  if (words.length === 1 && phrase.length >= 4) {
    const pre = c.filter((x) => x.full.startsWith(phrase) || x.ws.some((w) => w.startsWith(phrase)));
    if (pre.length === 1) return pre[0].m;
  }
  if (words.length > 1) {
    const pre = c.filter((x) => x.full.startsWith(phrase) && phrase.length >= 4);
    if (pre.length === 1) return pre[0].m;
  }
  return undefined;
}

/** a project by name: the whole name, its start (3+ letters), or (one word) a word of it */
function matchProjectName<P extends { id: string; name: string }>(phrase: string, words: string[], projects: P[], hash: boolean): P | undefined {
  const p = bare(phrase);
  if (!p) return undefined;
  const c = projects.map((x) => ({ x, full: bare(x.name), ws: nameWords(x.name).map(bare).filter(Boolean) }));
  const exact = c.find((y) => y.full === p);
  if (exact) return exact.x;
  if (p.length >= 3) {
    const pre = c.filter((y) => y.full.startsWith(p));
    if (pre.length >= 1 && (pre.length === 1 || words.length > 1)) return pre[0].x;
  }
  if (words.length === 1 && p.length >= 3) {
    const word = c.filter((y) => y.ws.includes(p));
    if (word.length >= 1) return word[0].x;
    if (p.length >= 4 || hash) {
      const pre = c.filter((y) => y.ws.some((w) => w.startsWith(p)));
      if (pre.length === 1 || (hash && pre.length >= 1)) return pre[0].x;
    }
  } else if (words.length > 1) {
    // "product launch" → "Q3 Product Launch": the words run together inside the name
    const run = c.filter((y) => y.full.includes(p) && p.length >= 6);
    if (run.length === 1) return run[0].x;
  }
  return undefined;
}

/** Every chip's patch merged (later chips win on the same field).  [final] */
export function chipsToFilters(chips: readonly SearchChip[], base: SearchFilters = {}): SearchFilters {
  const out: SearchFilters = { ...base };
  for (const c of chips) Object.assign(out, c.patch);
  return out;
}

/** The same search without one chip (its words are gone from the text too).  [final] */
export function removeSearchChip(parsed: ParsedSearch, chipId: string, base: SearchFilters = {}): ParsedSearch {
  const chips = parsed.chips.filter((c) => c.id !== chipId);
  return { ...parsed, chips, filters: chipsToFilters(chips, base) };
}

/** The input with one chip's words taken out (so typing on doesn't bring the chip back). */
export function removeChipFromInput(parsed: ParsedSearchNL, chipId: string): string {
  const ranges = parsed.spans[chipId];
  if (!ranges?.length) return parsed.input;
  let out = "";
  let at = 0;
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a < at) continue;
    out += parsed.input.slice(at, a);
    at = b;
  }
  out += parsed.input.slice(at);
  // tidy: no doubled spaces, no stranded commas or leading/trailing joiners
  return out.replace(/\s+([,.;:!?])/g, "$1").replace(/\s{2,}/g, " ").replace(/^[\s,;]+|[\s,;]+$/g, "")
    .replace(/^(?:and|or)\s+/i, "").replace(/\s+(?:and|or)$/i, "").trim();
}

/** Old saved-search text, made safe for the parser: any word it would read as a filter is quoted, so it stays text. */
export function protectLiteral(text: string, ctx: SearchNLContext): string {
  const parsed = parseSearchNL(text, ctx);
  if (!parsed.chips.length) return text;
  const ranges = Object.values(parsed.spans).flat().sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    if (a < at) continue;
    out += text.slice(at, a) + `"${text.slice(a, b).replace(/["“”]/g, "")}"`;
    at = b;
  }
  return out + text.slice(at);
}

/** Do these filters only make sense for tasks? (assignee, status, due, open) — then other kinds are left out unless asked for. */
export function hasTaskOnlyFilters(f: SearchFilters): boolean {
  return !!(f.assigneeId || f.statuses?.length || f.excludeDone || f.dueFrom || f.dueTo);
}

/** The kinds a search should show: what was asked for, or tasks alone when only task filters narrow it. */
export function effectiveKinds(f: SearchFilters): SearchHitKind[] {
  if (f.kinds?.length) return f.kinds;
  if (f.authorId) return ["comment"];
  if (hasTaskOnlyFilters(f)) return ["task"];
  return ["task", "comment", "doc", "project", "person"];
}
