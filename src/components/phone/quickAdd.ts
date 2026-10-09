/* ============================================================
   KANBO — the phone quick add's reading of a sentence (pure).     [u7]
   lib/nlp parseTask reads it; this adds what a phone needs on top:
   • "keep as words": a token the person tapped (a "May" that's a
     name, a "Friday drinks" that's a title) stays in the title and
     isn't read, wherever it sits as they keep typing;
   • dictation: the keyboard's microphone ends a sentence with a full
     stop and may say "new line" — neither belongs in a title;
   • recent projects for the chips (newest first).
   ============================================================ */
import { parseTask, type NlpContext, type NlpKind, type NlpSpan, type ParsedTask } from "../../lib/nlp";
import type { Status, Task } from "../../data/types";

/** a token tapped back to words: its text (any case) and what it had been read as */
export interface KeptToken { text: string; kind: NlpKind }

export interface QuickAddReading extends ParsedTask {
  /** where the kept tokens sit in the text (for the field's quiet marks) */
  kept: { start: number; end: number; text: string; kind: NlpKind }[];
}

/** private-use characters stand in for kept tokens while the grammar reads (the same length, so offsets hold) */
const MASK_BASE = 0xe000;
const MASK_MAX = 64;
const MASK_RUN = /([-])\1*/g;

const same = (a: string, b: string) => a.toLocaleLowerCase("en-GB") === b.toLocaleLowerCase("en-GB");

/**
 * Read a quick-add sentence, leaving every kept token as words. A kept token
 * is matched by its text and kind, so "fri" kept as words stays words when
 * more is typed before or after it; the same words elsewhere stay words too.
 */
export function parseQuickAdd(text: string, ctx: NlpContext, kept: KeptToken[] = []): QuickAddReading {
  const masks: { start: number; end: number; text: string; kind: NlpKind; ch: string }[] = [];
  let masked = text;
  let p = parseTask(masked, ctx);
  // each round shields one token the person kept, then reads again (a shield can free other words)
  for (let round = 0; kept.length && round < MASK_MAX; round++) {
    const hit = p.spans.find((sp) => kept.some((k) => k.kind === sp.kind && same(k.text, text.slice(sp.start, sp.end))));
    if (!hit) break;
    const ch = String.fromCharCode(MASK_BASE + masks.length);
    masks.push({ start: hit.start, end: hit.end, text: text.slice(hit.start, hit.end), kind: hit.kind, ch });
    masked = masked.slice(0, hit.start) + ch.repeat(hit.end - hit.start) + masked.slice(hit.end);
    p = parseTask(masked, ctx);
  }
  if (!masks.length) return { ...p, kept: [] };
  const byCh = new Map(masks.map((m) => [m.ch, m.text]));
  const title = p.title.replace(MASK_RUN, (run) => byCh.get(run[0]) ?? run);
  return { ...p, title, kept: masks.map(({ ch: _ch, ...m }) => m).sort((a, b) => a.start - b.start) };
}

/** What dictation leaves behind in a title: a closing full stop (not an ellipsis), line breaks, doubled spaces. */
export function tidyDictation(title: string): string {
  let t = title.replace(/[\r\n]+/g, " ").replace(/[ \t]{2,}/g, " ").trim();
  if (/[^.]\.$/.test(t) && !/\b(?:etc|e\.g|i\.e|approx|incl|vs|no)\.$/i.test(t)) t = t.slice(0, -1).trimEnd();
  // punctuation on its own isn't a title (an emoji is)
  return /^[\s\p{P}]*$/u.test(t) ? "" : t;
}

/** A pasted or dictated "new line" is a space in a one-line title. */
export const oneLine = (v: string): string => v.replace(/[ \t]*[\r\n]+[ \t]*/g, " ");

/** The task a reading makes (the same fields Quick capture sends). Null when there's no title left. */
export function quickAddTask(r: ParsedTask, projectId?: string): (Partial<Task> & { title: string }) | null {
  const title = tidyDictation(r.title);
  if (!title) return null;
  const partial: Partial<Task> & { title: string } = { title, priority: r.priority ?? "medium", status: "todo" as Status };
  if (r.dueDate) partial.dueDate = r.dueDate;
  if (r.dueTime) partial.dueTime = r.dueTime;
  if (r.assigneeId) partial.assigneeId = r.assigneeId;
  if (projectId) partial.projectId = projectId;
  if (r.startDate) partial.startDate = r.startDate;
  if (r.recurrence) partial.recurrence = r.recurrence;
  if (r.focusMin) partial.focusMin = r.focusMin;
  if (r.effortHours) partial.effortHours = r.effortHours;
  if (r.tags?.length) partial.tags = r.tags;
  if (r.energy) partial.energy = r.energy;
  if (r.planToday) partial.planToday = true;
  return partial;
}

/** How a token reads aloud and on its chip's label: "Due", "For", "Project"… */
export const TOKEN_WORDS: Record<NlpKind, string> = {
  date: "Due", time: "At", repeat: "Repeats", start: "Starts", priority: "Priority", project: "Project",
  person: "For", tag: "Label", duration: "Focus", estimate: "Estimate", energy: "Energy",
};

/** A token as it's read aloud: "Due: Sat 10 Oct", "For: Sana Rao" — or just its label where that already
 *  says what it is ("High priority", "1h estimate", "Every Monday", "Starts Mon 12 Oct"). */
export function tokenWords(sp: Pick<NlpSpan, "kind" | "label">): string {
  return sp.kind === "priority" || sp.kind === "estimate" || sp.kind === "repeat" || sp.kind === "start" ? sp.label : `${TOKEN_WORDS[sp.kind]}: ${sp.label}`;
}

/** "a due date", "a person"… for "Read “fri” as a due date again" */
export const TOKEN_NOUN: Record<NlpKind, string> = {
  date: "a due date", time: "a time", repeat: "a repeat", start: "a start date", priority: "a priority", project: "a project",
  person: "a person", tag: "a label", duration: "focus time", estimate: "an estimate", energy: "deep work",
};

/** The kept tokens still in the text (the rest are forgotten as soon as their words are gone). */
export function liveKept(text: string, kept: KeptToken[]): KeptToken[] {
  const low = text.toLocaleLowerCase("en-GB");
  return kept.filter((k) => low.includes(k.text.toLocaleLowerCase("en-GB")));
}

/** Projects for the chips, newest first: this session's own picks, then the ones handed in, then the
 *  projects of the person's newest tasks. Only projects that exist; at most `limit` (5). */
export function recentProjectIds(
  tasks: Pick<Task, "projectId" | "createdAt" | "assigneeId" | "createdBy" | "archivedAt">[],
  opts: { userId?: string; projects?: { id: string; archivedAt?: string }[]; limit?: number } = {},
): string[] {
  const limit = opts.limit ?? 5;
  const live = opts.projects ? new Set(opts.projects.filter((p) => !p.archivedAt).map((p) => p.id)) : null;
  const mine = (t: Pick<Task, "assigneeId" | "createdBy">) => !opts.userId || t.assigneeId === opts.userId || t.createdBy === opts.userId;
  const sorted = tasks
    .filter((t) => !t.archivedAt && mine(t) && (!live || live.has(t.projectId)))
    .map((t, i) => ({ t, at: t.createdAt ? Date.parse(t.createdAt) || 0 : 0, i }))
    .sort((a, b) => b.at - a.at || b.i - a.i);
  const out: string[] = [];
  for (const { t } of sorted) {
    if (!out.includes(t.projectId)) out.push(t.projectId);
    if (out.length >= limit) break;
  }
  return out;
}

/** The chips to show: the default (the project you're in) first, then the recents, then this
 *  session's picks — de-duplicated, existing projects only, at most `limit`. */
export function projectChips(ids: { picked?: string[]; recent?: string[]; defaultId?: string }, exists: (id: string) => boolean, limit = 5): string[] {
  const out: string[] = [];
  for (const id of [ids.defaultId, ...(ids.picked ?? []), ...(ids.recent ?? [])]) {
    if (id && exists(id) && !out.includes(id)) out.push(id);
    if (out.length >= limit) break;
  }
  return out;
}

/** The spoken summary: "Due Fri 10 Oct at 15:00 · High priority · In Launch · For you". */
export function readingSummary(r: ParsedTask, names: { project?: string; person?: string; you?: boolean }): string {
  const parts: string[] = [];
  const has = (k: NlpKind) => r.spans.some((s: NlpSpan) => s.kind === k);
  const label = (k: NlpKind) => r.spans.find((s) => s.kind === k)?.label;
  if (has("date") || has("time")) parts.push(`Due ${label("date") ?? "today"}${r.dueTime ? ` at ${r.dueTime}` : ""}`);
  if (r.recurrence) parts.push(label("repeat") ?? "Repeats");
  if (r.startDate) parts.push(label("start") ?? "Has a start date");
  if (r.priority) parts.push(`${r.priority[0].toUpperCase()}${r.priority.slice(1)} priority`);
  if (r.effortHours) parts.push(label("estimate") ?? "Estimated");
  if (r.focusMin) parts.push(`${label("duration") ?? ""} focus`.trim());
  if (r.tags?.length) parts.push(`${r.tags.length === 1 ? "1 label" : `${r.tags.length} labels`}`);
  if (names.project) parts.push(`In ${names.project}`);
  if (names.person) parts.push(names.you ? "For you" : `For ${names.person}`);
  return parts.join(" · ");
}
