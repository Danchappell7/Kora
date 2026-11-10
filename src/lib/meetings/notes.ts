/* ============================================================
   KANBO — a meeting's notes (0056): the doc it leaves behind, and the
   text Extract tasks reads.
   · meetingDoc: the "Meeting notes" template (lib/docBlocks) filled in:
     the date, who came, the agenda Kanbo built, the notes by agenda
     item, the decisions, and the actions as to-dos (an action that's
     a task links to it, so the doc shows its live status). Owners are
     named in words, never @mentioned (they already have the task and
     the recap).
   · extractLine / extractText: an item as a line the Extract sheet
     reads ("Maya to book the review by 13 Nov"), under the headings it
     knows, so owners and dates come through to the review.
   · linkCreated: which item each task Extract made belongs to.
   Pure: no React, no I/O.
   ============================================================ */
import type { DocBlock, DocSpan } from "../../data/types";
import { docTemplate, newBlockId, normaliseSpans, longDate } from "../docBlocks";
import type { AgendaItem, Meeting, MeetingItem } from "./types";
import { dayLabel } from "./agenda";

const firstName = (name: string) => name.trim().split(/\s+/)[0] || name;
const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) ? s.charAt(0).toLowerCase() + s.slice(1) : s);
const listWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
const T = (text: string, marks?: DocSpan["marks"]): DocSpan => (marks ? { text, marks } : { text });
const blk = (type: DocBlock["type"], spans: DocSpan[] | string = [], extra: Partial<DocBlock> = {}): DocBlock => {
  const b: DocBlock = { id: newBlockId(), type, ...extra };
  if (type !== "divider") b.spans = normaliseSpans(typeof spans === "string" ? (spans ? [T(spans)] : []) : spans);
  return b;
};

export interface NotesContext {
  /** a person's name (from the members you have) */
  nameOf: (id: string) => string | undefined;
  /** who came (names, in order) */
  attendees: string[];
  /** YYYY-MM-DD the meeting was on */
  day: string;
  /** the notes doc's project (the template's wording) */
  projectName: string;
}

/** "Maya · by 13 Nov" (the owner and day an action carries) */
export function actionTail(it: Pick<MeetingItem, "ownerId" | "due">, nameOf: (id: string) => string | undefined): string {
  const who = it.ownerId ? nameOf(it.ownerId) : undefined;
  return [who ? firstName(who) : "", it.due ? `by ${dayLabel(it.due)}` : ""].filter(Boolean).join(" · ");
}

/** The meeting's notes doc: the Meeting notes template, filled in. */
export function meetingDoc(m: Pick<Meeting, "title" | "agenda">, items: readonly MeetingItem[], ctx: NotesContext): { title: string; icon: string; body: DocBlock[] } {
  const base = docTemplate("meeting", { projectName: ctx.projectName, today: ctx.day });
  const agendaTitle = new Map(m.agenda.map((a) => [a.key, a.title]));
  const notes = items.filter((i) => i.kind === "note");
  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action");
  const where = (i: MeetingItem): DocSpan[] => {
    const t = i.agendaKey ? agendaTitle.get(i.agendaKey) : undefined;
    return t && i.agendaKey !== "overview" && i.agendaKey !== "wrap" ? [T(`${t}: `, ["b"])] : [];
  };
  const fill: Record<string, DocBlock[]> = {
    Agenda: m.agenda.filter((a) => a.kind !== "wrap").map((a: AgendaItem) => blk("numbered", a.title)),
    Notes: notes.map((i) => blk("bullet", [...where(i), T(i.body)])),
    Decisions: decisions.map((i) => blk("bullet", [...where(i), T(i.body)])),
    Actions: actions.map((i) => {
      const tail = actionTail(i, ctx.nameOf);
      return blk("todo", [T(i.body), ...(tail ? [T(` (${tail})`, ["i"])] : [])], i.taskId ? { taskId: i.taskId } : {});
    }),
  };
  const body: DocBlock[] = [];
  const filled = new Set<string>();
  let section = "";
  for (const b of base.body) {
    const text = (b.spans ?? []).map((s) => s.text).join("");
    if (b.type === "h2") { section = text; body.push({ ...b, id: newBlockId() }); continue; }
    if (b.type === "p" && /^Date:/.test(text)) { body.push(blk("p", [T("Date: ", ["b"]), T(longDate(ctx.day))])); continue; }
    if (b.type === "p" && /^Attendees:/.test(text)) { body.push(blk("p", [T("Attendees: ", ["b"]), T(listWords(ctx.attendees))])); continue; }
    // the template's line under each heading: what was said there, or an empty line to write in
    if (section in fill && b.type !== "callout") {
      if (filled.has(section)) continue;
      filled.add(section);
      body.push(...(fill[section].length ? fill[section] : [blk(b.type)]));
      continue;
    }
    body.push({ ...b, id: newBlockId() });
  }
  return { title: m.title, icon: base.icon, body };
}

/** An item as a line Extract tasks reads: "Maya to book the review by 13 Nov" (an action), else its words. */
export function extractLine(it: Pick<MeetingItem, "body" | "ownerId" | "due">, nameOf: (id: string) => string | undefined): string {
  const body = it.body.replace(/\s+/g, " ").trim().replace(/[.]+$/, "");
  const who = it.ownerId ? nameOf(it.ownerId) : undefined;
  const what = who ? `${firstName(who)} to ${lowerFirst(body)}` : body;
  return `${what}${it.due ? ` by ${dayLabel(it.due)}` : ""}`;
}

/** The text for Extract tasks: the actions that aren't tasks yet under "Actions", then the decisions and notes
 *  (under their own headings, so only an AI read picks anything out of them). */
export function extractText(items: readonly MeetingItem[], nameOf: (id: string) => string | undefined): string {
  const open = items.filter((i) => i.kind === "action" && !i.taskId);
  const decisions = items.filter((i) => i.kind === "decision");
  const notes = items.filter((i) => i.kind === "note");
  const out: string[] = [];
  if (open.length) out.push("Actions", ...open.map((i) => `- ${extractLine(i, nameOf)}`), "");
  if (decisions.length) out.push("Decisions", ...decisions.map((i) => `- ${i.body}`), "");
  if (notes.length) out.push("Notes", ...notes.map((i) => `- ${i.body}`), "");
  return out.join("\n").trim();
}

/** The one line a single item's "Make task" sends: an action line (with its owner and day, so the review has them). */
export function makeTaskText(it: Pick<MeetingItem, "body" | "ownerId" | "due">, nameOf: (id: string) => string | undefined): string {
  return `Actions\n- ${extractLine(it, nameOf)}`;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Which open action each task Extract made belongs to (by its words), or null: a new action. */
export function linkCreated(created: readonly { id: string; title: string }[], items: readonly MeetingItem[]): { taskId: string; itemId: string | null }[] {
  const free = items.filter((i) => i.kind === "action" && !i.taskId);
  const used = new Set<string>();
  return created.map((t) => {
    const k = norm(t.title);
    const hit = free.find((i) => !used.has(i.id) && k.length > 2 && (norm(i.body).includes(k) || k.includes(norm(i.body))));
    if (hit) used.add(hit.id);
    return { taskId: t.id, itemId: hit?.id ?? null };
  });
}
