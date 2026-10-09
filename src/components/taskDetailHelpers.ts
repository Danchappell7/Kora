/* ============================================================
   KANBO — pure helpers behind the task detail panel (kept out of
   the component so they can be unit-tested).
   ============================================================ */
import type { Activity, Attachment, Comment, Task } from "../data/types";
import { STATUS_META, PRIORITY_META, KANBO_TODAY, toLocalISO } from "../data/data";
import { approvalActivityVerb, approvalEventText } from "../lib/approvals";
import { DRAFT_PREFIX, UNSAVED_PREFIX } from "../lib/taskDrafts";

export { clearTaskDrafts } from "../lib/taskDrafts";

export interface MentionCandidate { id: string; name: string }

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// a name token must not run on into more letters/digits ("@Dan" ≠ "@Daniel")
const WORD = "[\\p{L}\\p{N}_]";

/**
 * Work out who a comment mentions.
 *
 * `picked` are the people chosen from the @ autocomplete (their ids are
 * authoritative, so two teammates who share a name can't be confused). Names
 * typed by hand still count when they match exactly one teammate. A token only
 * counts while "@Name" is still in the text, followed by a word boundary, and
 * longer names win ("@Sam Reed" is Sam Reed, not also Sam).
 */
export function resolveMentions(text: string, picked: MentionCandidate[], members: MentionCandidate[]): string[] {
  const group = (list: MentionCandidate[]) => {
    const m = new Map<string, Set<string>>();
    for (const p of list) {
      const key = p.name.trim().toLowerCase();
      if (!key) continue;
      if (!m.has(key)) m.set(key, new Set());
      m.get(key)!.add(p.id);
    }
    return m;
  };
  const pickedByName = group(picked);
  const memberByName = group(members);
  const names = [...new Set([...pickedByName.keys(), ...memberByName.keys()])].sort((a, b) => b.length - a.length);
  const lower = text.toLowerCase();
  const taken = new Uint8Array(lower.length);
  const out = new Set<string>();
  for (const name of names) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_@])@${escapeRe(name)}(?!${WORD})`, "gu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower))) {
      const start = m.index + m[1].length;
      const end = start + 1 + name.length;
      let overlaps = false;
      for (let i = start; i < end; i++) if (taken[i]) { overlaps = true; break; }
      if (overlaps) continue;
      taken.fill(1, start, end);
      const ids = pickedByName.get(name) ?? memberByName.get(name);
      // an ambiguous hand-typed name (two "Alex"es) notifies nobody rather than the wrong person
      if (ids && (pickedByName.has(name) || ids.size === 1)) ids.forEach((id) => out.add(id));
    }
  }
  return [...out];
}

/** Would making `taskId` blocked-by `dependsOn` close a loop? (DFS over dependencies) */
export function wouldCreateCycle(tasks: Pick<Task, "id" | "dependencies">[], taskId: string, dependsOn: string): boolean {
  if (taskId === dependsOn) return true;
  const deps = new Map(tasks.map((t) => [t.id, t.dependencies ?? []]));
  const seen = new Set<string>();
  const todo = [dependsOn];
  while (todo.length) {
    const cur = todo.pop()!;
    if (cur === taskId) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const d of deps.get(cur) ?? []) todo.push(d);
  }
  return false;
}

/** Tasks the open task could be made to depend on: same workspace, still
 *  open, not archived, not already a blocker, and no dependency loops. */
export function dependencyCandidates(task: Task, tasks: Task[], query: string, limit = 8): Task[] {
  const q = query.trim().toLowerCase();
  const ws = task.workspaceId ?? null;
  const out: Task[] = [];
  for (const t of tasks) {
    if (out.length >= limit) break;
    if (t.id === task.id || task.dependencies.includes(t.id)) continue;
    if ((t.workspaceId ?? null) !== ws) continue;
    if (t.status === "done" || t.archivedAt) continue;
    if (q && !t.title.toLowerCase().includes(q)) continue;
    if (wouldCreateCycle(tasks, task.id, t.id)) continue;
    out.push(t);
  }
  return out;
}

/**
 * One line for the panel's Activity list. `assigned` and `mention` rows are
 * written by the notification triggers with the actor's name in `detail`.
 * `comment` rows come from two places: the trigger (the commenter's name) and
 * your own comment, which is logged with its text — so a comment row only reads
 * "X commented" when `detail` is a known teammate, and is otherwise quoted.
 */
export function activityLine(a: Pick<Activity, "kind" | "detail" | "meta">, knownNames: string[] = []): string {
  const who = a.detail?.trim() || "Someone";
  if (a.kind === "mention") return `${who} mentioned you`;
  // 0047: "Sana asked for your approval on this task" · "Olive approved this task"
  if (a.kind === "approval") return `${who} ${approvalActivityVerb(a.meta)} this task`;
  if (a.kind === "assigned") return `${who} assigned you`;
  if (a.kind === "comment") {
    const lc = who.toLowerCase();
    const isPerson = who === "Someone" || knownNames.some((n) => n.trim().toLowerCase() === lc);
    return isPerson ? `${who} commented` : `Comment: “${who}”`;
  }
  return a.detail;
}

// input types you type into (Escape there means "done typing", not "close")
const TEXT_INPUT_TYPES = new Set(["", "text", "search", "email", "url", "tel", "password", "number"]);
export function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.tagName === "TEXTAREA") return true;
  return t.tagName === "INPUT" && TEXT_INPUT_TYPES.has(((t as HTMLInputElement).getAttribute("type") ?? "").toLowerCase());
}

/** Who may delete a file: its owner — `attachments.user_id` when the row
 *  carries it (account deletion hands files to the task owner), else the
 *  uploader, the first segment of `<uploader uid>/<task id>/<file>`. */
export function attachmentOwnerId(a: Pick<Attachment, "path"> & { userId?: string | null }): string {
  return a.userId || ((a.path ?? "").split("/")[0] ?? "");
}
export function canDeleteAttachment(a: Pick<Attachment, "path"> & { userId?: string | null }, userId: string, demo: boolean): boolean {
  return demo || (!!userId && attachmentOwnerId(a) === userId);
}

/* Unsent comment drafts survive switching task or closing the panel (per tab).
   Keyed by the signed-in user too, so someone else signing in on the same tab
   never finds (and posts) another person's draft. */
const draftKey = (userId: string, taskId: string) => `${DRAFT_PREFIX}${userId}:${taskId}`;
export function readDraft(userId: string, taskId: string): string {
  try { return sessionStorage.getItem(draftKey(userId, taskId)) ?? ""; } catch { return ""; }
}
export function writeDraft(userId: string, taskId: string, text: string): void {
  try {
    if (text.trim()) sessionStorage.setItem(draftKey(userId, taskId), text);
    else sessionStorage.removeItem(draftKey(userId, taskId));
  } catch { /* storage blocked — the draft just won't persist */ }
}

/* Title/description text that couldn't be saved because the page was closing
   (the save may not have reached the server, or someone else had changed it).
   The panel offers it back the next time you open that task. */
export type UnsavedField = "title" | "description";
const unsavedKey = (userId: string, taskId: string, field: UnsavedField) => `${UNSAVED_PREFIX}${userId}:${taskId}:${field}`;
export function stashUnsaved(userId: string, taskId: string, field: UnsavedField, text: string): void {
  try { sessionStorage.setItem(unsavedKey(userId, taskId, field), text); } catch { /* storage blocked */ }
}
export function dropUnsaved(userId: string, taskId: string, field: UnsavedField): void {
  try { sessionStorage.removeItem(unsavedKey(userId, taskId, field)); } catch { /* storage blocked */ }
}
/** read and forget */
export function takeUnsaved(userId: string, taskId: string, field: UnsavedField): string | null {
  try {
    const k = unsavedKey(userId, taskId, field);
    const v = sessionStorage.getItem(k);
    if (v != null) sessionStorage.removeItem(k);
    return v;
  } catch { return null; }
}


/* ============================================================
   Dates, durations and the words the panel uses for them.
   en-GB and deterministic (never the browser's locale): "Wed 30 Sep".
   ============================================================ */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86400000;

/** "YYYY-MM-DD" as a local date (never UTC), or null */
export function parseDay(iso: string | null | undefined): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(d.getTime()) ? null : d;
}
const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayDiff = (from: Date, to: Date) => Math.round((midnight(to).getTime() - midnight(from).getTime()) / DAY_MS);
const asDay = (today: Date | string): Date => (typeof today === "string" ? parseDay(today) ?? midnight(new Date()) : midnight(today));

/** "Wed 30 Sep" (the year is added when it isn't this year's) */
export function dayLabel(iso: string, today: Date | string = KANBO_TODAY): string {
  const d = parseDay(iso);
  if (!d) return iso;
  const s = `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]}`;
  return d.getFullYear() === asDay(today).getFullYear() ? s : `${s} ${d.getFullYear()}`;
}
/** "30 Sep" (plus the year when it isn't this year's) */
export function shortDay(iso: string, today: Date | string = KANBO_TODAY): string {
  const d = parseDay(iso);
  if (!d) return iso;
  const s = `${d.getDate()} ${MO[d.getMonth()]}`;
  return d.getFullYear() === asDay(today).getFullYear() ? s : `${s} ${d.getFullYear()}`;
}

/** A compact age for timelines: "now", "5m", "3h", "2d", then "30 Sep". */
export function ago(iso: string, now: number = Date.now()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return shortDay(toLocalISO(new Date(then)), toLocalISO(new Date(now)));
}

/** Hours as the panel shows them: 1.5 → "1h 30m", 2 → "2h", 0.25 → "15m". */
export function fmtHours(h: number | null | undefined): string {
  if (h == null || !Number.isFinite(h)) return "";
  const total = Math.max(0, Math.round(h * 60));
  const hh = Math.floor(total / 60), mm = total % 60;
  if (!hh) return `${mm}m`;
  return mm ? `${hh}h ${mm}m` : `${hh}h`;
}
/** What someone typed as a duration, in hours: "1h 30m", "90m", "1.5", "1:30",
 *  "2 hours". Blank clears it (undefined); anything unreadable is null. */
export function parseHours(text: string): number | undefined | null {
  const s = text.trim().toLowerCase().replace(/,/g, ".");
  if (!s) return undefined;
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return +m[1];
  m = /^(\d+):([0-5]\d)$/.exec(s);
  if (m) return +m[1] + +m[2] / 60;
  // "1h 30m", "1h30", "45 mins" (bare minutes need their unit, or they'd read as hours)
  m = /^(?:(\d+(?:\.\d+)?)\s*(?:h|hr|hrs|hours?))?\s*(?:(\d+)\s*(m|min|mins|minutes?)?)?$/.exec(s);
  if (!m || (!m[1] && !m[2]) || (m[2] && !m[1] && !m[3])) return null;
  return Math.round(((m[1] ? +m[1] : 0) + (m[2] ? +m[2] / 60 : 0)) * 100) / 100;
}

const firstName = (name: string | undefined) => name?.trim().split(/\s+/)[0] || undefined;
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/* ============================================================
   "Kanbo suggests": the one sentence that says why this task matters now.
   Deterministic — built from the task graph, never model-written.
   ============================================================ */
export interface Consequence {
  kind: "blocking" | "blocked" | "overdue" | "reason";
  text: string;
  /** the first open blocker, for "Open blocker" */
  blockerId?: string;
}

/**
 * In order: it holds others up and is due today or overdue · it's waiting on
 * an open blocker · it's overdue · Kanbo's saved reason. Done tasks have none.
 * `blockedSince` (when it was marked blocked, from its history) lets the
 * blocked sentence say for how long.
 */
export function consequenceOf(
  task: Task,
  all: Task[],
  today: Date | string = KANBO_TODAY,
  opts: { nameOf?: (id: string) => string | undefined; blockedSince?: string } = {},
): Consequence | null {
  if (task.status === "done") return null;
  const day = asDay(today);
  const due = parseDay(task.dueDate);
  const late = due ? dayDiff(due, day) : null;          // > 0 overdue · 0 due today
  const who = (id: string) => firstName(opts.nameOf?.(id));
  const open = (t: Task) => t.status !== "done" && !t.archivedAt;

  const dependants = all
    .filter((t) => t.id !== task.id && open(t) && t.dependencies?.includes(task.id))
    .sort((a, b) => (a.dueDate ?? "9999-12-31").localeCompare(b.dueDate ?? "9999-12-31") || a.title.localeCompare(b.title));
  if (dependants.length && late != null && late >= 0) {
    const first = dependants[0];
    const name = who(first.assigneeId);
    const them = `${first.title}${name ? ` (${name})` : ""}`;
    const n = plural(dependants.length, "task");
    return late === 0
      ? { kind: "blocking", text: `Blocks ${n} and is due today. If it slips, ${them} starts late.` }
      : { kind: "blocking", text: `Blocks ${n} and is ${plural(late, "day")} overdue. ${them} is waiting on it.` };
  }

  const byId = new Map(all.map((t) => [t.id, t]));
  const blockers = (task.dependencies ?? []).map((id) => byId.get(id)).filter((t): t is Task => !!t && open(t));
  const since = opts.blockedSince ? new Date(opts.blockedSince) : null;
  const days = since && !Number.isNaN(since.getTime()) ? dayDiff(since, day) : 0;
  if (blockers.length) {
    const b = blockers[0];
    const name = who(b.assigneeId);
    const more = blockers.length > 1 ? ` and ${blockers.length - 1} more` : "";
    const lead = days >= 1 ? `Blocked for ${plural(days, "day")} by` : "Blocked by";
    return { kind: "blocked", blockerId: b.id, text: `${lead} “${b.title}”${name ? ` (${name})` : ""}${more}.` };
  }
  if (task.status === "blocked" && days >= 1) return { kind: "blocked", text: `Blocked for ${plural(days, "day")}.` };

  if (due && late != null && late > 0) return { kind: "overdue", text: `Overdue since ${dayLabel(task.dueDate!, day)}.` };
  const reason = task.aiReason?.trim();
  return reason ? { kind: "reason", text: reason } : null;
}

/* ============================================================
   Slip history for the due date, and the change-history wording.
   ============================================================ */
/** the minimal shape of a change-history row (store.TaskEvent / WorkspaceEvent) */
export interface HistoryEvent { id: string; actorName: string; field: string; oldValue: string | null; newValue: string | null; createdAt: string }

/** How many times the due date really moved (one date to another; setting a
 *  first date or clearing it isn't a move). */
export function dueMoves(events: Pick<HistoryEvent, "field" | "oldValue" | "newValue">[]): number {
  return events.filter((e) => e.field === "due" && !!e.oldValue && !!e.newValue && e.oldValue !== e.newValue).length;
}

/** "Moved 2× · first due Fri 2 Oct", "Brought forward from Fri 2 Oct" — or
 *  nothing. A repeating task's originalDueDate is its series' anchor, not a
 *  slip, so repeating tasks never get one. */
export function slipNote(task: Pick<Task, "dueDate" | "originalDueDate" | "recurrence">, moves: number, today: Date | string = KANBO_TODAY): string | null {
  if (!task.dueDate || (task.recurrence && task.recurrence !== "none")) return null;
  const first = task.originalDueDate && parseDay(task.originalDueDate) && task.originalDueDate !== task.dueDate ? task.originalDueDate : undefined;
  if (moves > 0) return `Moved ${moves}×${first ? ` · first due ${dayLabel(first, today)}` : ""}`;
  if (!first) return null;
  return first > task.dueDate ? `Brought forward from ${dayLabel(first, today)}` : `Pushed back from ${dayLabel(first, today)}`;
}

/** One change-history row in words, without the actor: "moved due Fri 2 Oct → Wed 30 Sep". */
export function eventText(e: Pick<HistoryEvent, "field" | "oldValue" | "newValue">, nameOf: (id: string) => string | undefined = () => undefined, today: Date | string = KANBO_TODAY): string {
  const v = e.newValue;
  if (e.field === "status") {
    if (v === "done") return "completed it";
    return `changed status to ${STATUS_META[v as Task["status"]]?.label ?? v}`;
  }
  if (e.field === "priority") return `set priority to ${PRIORITY_META[v as Task["priority"]]?.label ?? v}`;
  if (e.field === "assignee") return v ? `assigned ${nameOf(v) ?? "someone"}` : "unassigned it";
  if (e.field === "due") {
    if (e.oldValue && v) return `moved due ${dayLabel(e.oldValue, today)} → ${dayLabel(v, today)}`;
    return v ? `set due ${dayLabel(v, today)}` : "cleared the due date";
  }
  // 0047: new_value = what happened, old_value = the request's status after it
  if (e.field === "approval") return approvalEventText(v, e.oldValue);
  return `updated ${e.field}`;
}

/* ============================================================
   The activity timeline: comments (with their replies), change history
   and your notifications about this task, oldest first.
   ============================================================ */
export type TimelineItem =
  | { kind: "comment"; id: string; at: string; comment: Comment; depth: 0 | 1 }
  | { kind: "event"; id: string; at: string; event: HistoryEvent }
  | { kind: "activity"; id: string; at: string; activity: Activity };

const NEAR_MS = 5 * 60 * 1000;
const time = (iso: string) => { const t = Date.parse(iso); return Number.isNaN(t) ? Infinity : t; };

export function buildTimeline(comments: Comment[], events: HistoryEvent[], activity: Activity[], taskId: string): TimelineItem[] {
  // replies stay with their thread (one level); a reply whose parent has gone
  // (deleted) is promoted so it can never silently disappear
  const topIds = new Set(comments.filter((c) => !c.parentId).map((c) => c.id));
  const isTop = (c: Comment) => !c.parentId || !topIds.has(c.parentId);
  const repliesOf = (id: string) => comments.filter((r) => r.parentId === id && !isTop(r)).sort((a, b) => time(a.createdAt) - time(b.createdAt));

  const near = (field: string, at: string, match?: (v: string | null) => boolean) =>
    events.some((e) => e.field === field && Math.abs(time(e.createdAt) - time(at)) <= NEAR_MS && (!match || match(e.newValue)));
  // a notification that repeats a history row (same change, same moment) is left out;
  // comments are already in the thread
  const notes = activity
    .filter((a) => a.taskId === taskId && a.kind !== "comment")
    .filter((a) => !(a.kind === "assigned" && near("assignee", a.createdAt)))
    .filter((a) => !(a.kind === "completed" && near("status", a.createdAt, (v) => v === "done")))
    .filter((a) => !((a.kind === "status" || a.kind === "reopened") && near("status", a.createdAt)))
    // an approval notice repeats the history row the same request or decision wrote
    .filter((a) => !(a.kind === "approval" && near("approval", a.createdAt)))
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))
    .slice(0, 8);

  type Top = { at: string; order: number; items: TimelineItem[] };
  const tops: Top[] = [];
  let order = 0;
  for (const c of comments.filter(isTop)) {
    tops.push({ at: c.createdAt, order: order++, items: [
      { kind: "comment", id: c.id, at: c.createdAt, comment: c, depth: 0 },
      ...repliesOf(c.id).map((r) => ({ kind: "comment" as const, id: r.id, at: r.createdAt, comment: r, depth: 1 as const })),
    ] });
  }
  for (const e of events) tops.push({ at: e.createdAt, order: order++, items: [{ kind: "event", id: `e-${e.id}`, at: e.createdAt, event: e }] });
  for (const a of notes) tops.push({ at: a.createdAt, order: order++, items: [{ kind: "activity", id: `a-${a.id}`, at: a.createdAt, activity: a }] });
  return tops.sort((a, b) => time(a.at) - time(b.at) || a.order - b.order).flatMap((t) => t.items);
}
