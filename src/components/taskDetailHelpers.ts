/* ============================================================
   KANBO — pure helpers behind the task detail panel (kept out of
   the component so they can be unit-tested).
   ============================================================ */
import type { Activity, Attachment, Task } from "../data/types";

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
export function activityLine(a: Pick<Activity, "kind" | "detail">, knownNames: string[] = []): string {
  const who = a.detail?.trim() || "Someone";
  if (a.kind === "mention") return `${who} mentioned you`;
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
const DRAFT_PREFIX = "kanbo-draft:";
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
const UNSAVED_PREFIX = "kanbo-unsaved:";
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

/** Forget every unsent comment draft and unsaved edit in this tab (call on sign-out). */
export function clearTaskDrafts(): void {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && (k.startsWith(DRAFT_PREFIX) || k.startsWith(UNSAVED_PREFIX))) doomed.push(k);
    }
    doomed.forEach((k) => sessionStorage.removeItem(k));
  } catch { /* storage blocked */ }
}
