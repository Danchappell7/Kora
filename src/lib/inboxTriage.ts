/* ============================================================
   KANBO — Inbox triage: the feed sorted by what it asks of you.
   · Needs your reply — someone mentioned you (until you archive it,
     or the task is done)
   · New to you — work handed to you: assignments, and requests
     that arrived through a project's request form assigned to you
   · FYI — everything else (comments, updates, your own history)
   Pure: no React, no storage. Order within a group is the feed's
   own order (newest first).
   ============================================================ */
import type { Activity, ActivityKind, Task } from "../data/types";

/** Activity the signed-in user wrote about their own actions: history, never
 *  a notification (it doesn't count as new, and never asks anything of you). */
export const SELF_KINDS: ReadonlySet<ActivityKind> = new Set<ActivityKind>(["created", "status", "completed", "reopened", "deleted"]);

export type TriageGroup = "reply" | "newToYou" | "fyi";

export interface Triage {
  reply: Activity[];
  newToYou: Activity[];
  fyi: Activity[];
}

export interface TriageContext {
  /** the signed-in user's id; without it, a request is taken to be yours */
  me?: string;
  tasks: Task[] | ReadonlyMap<string, Task>;
}

/** The groups in the order the Inbox shows them. */
export const TRIAGE_GROUPS: { id: TriageGroup; label: string }[] = [
  { id: "reply", label: "Needs your reply" },
  { id: "newToYou", label: "New to you" },
  { id: "fyi", label: "FYI" },
];

const REQUEST_RE = /^\s*Request via\b/i;

/** A task that came in through a request form: it carries the form's id when
 *  the row has one, or the "Request via {form}" line a submission writes. */
export function isRequestTask(t: Pick<Task, "description"> & { formId?: string | null } | undefined): boolean {
  if (!t) return false;
  if (typeof t.formId === "string" && t.formId) return true;
  return REQUEST_RE.test(t.description || "");
}

/** "Launch requests" from "Request via Launch requests…", or null. */
export function requestSource(t: Pick<Task, "description"> | undefined): string | null {
  const m = /^\s*Request via\s+([^\n.]+)/i.exec(t?.description || "");
  return m ? m[1].trim() || null : null;
}

const taskLookup = (tasks: TriageContext["tasks"]): ReadonlyMap<string, Task> =>
  tasks instanceof Map ? tasks : new Map((tasks as Task[]).map((t) => [t.id, t]));

/** Which group one item belongs to. */
export function groupOf(a: Activity, ctx: { me?: string; task?: Task }): TriageGroup {
  // a mention on a finished (or archived) task no longer waits on you; one whose
  // task isn't loaded yet still does
  if (a.kind === "mention") return ctx.task && (ctx.task.status === "done" || ctx.task.archivedAt) ? "fyi" : "reply";
  if (a.kind === "assigned") return "newToYou";
  // 0047: a doc @mention is new work for you; "changes requested" on your approval request
  // sends the task back to you. Other approval notices (a request already decided, or a
  // reviewer's approval) are FYI: open requests waiting on you show in "Approvals for you".
  if (a.kind === "doc_mention") return "newToYou";
  if (a.kind === "approval") return a.meta?.event === "changes_requested" ? "newToYou" : "fyi";
  if (a.kind === "created" && isRequestTask(ctx.task) && (!ctx.me || ctx.task?.assigneeId === ctx.me)) return "newToYou";
  return "fyi";
}

/** Split the feed into the three triage groups (each keeps the feed's order). */
export function triage(activity: Activity[], ctx: TriageContext): Triage {
  const byId = taskLookup(ctx.tasks);
  const out: Triage = { reply: [], newToYou: [], fyi: [] };
  for (const a of activity) {
    const task = a.taskId ? byId.get(a.taskId) : undefined;
    out[groupOf(a, { me: ctx.me, task })].push(a);
  }
  return out;
}

/** An item that is a notification (from someone else), not your own history. */
export const isNotification = (a: Pick<Activity, "kind">): boolean => !SELF_KINDS.has(a.kind);

/** Unread notifications: not read on any device, and not your own actions. */
export function unreadCount(activity: Activity[]): number {
  let n = 0;
  for (const a of activity) if (!a.readAt && isNotification(a)) n++;
  return n;
}

/* ---------- bundles (0048)                         [0048 contract → u4] ----------
   Related items fold into one row: "3 comments on Launch deck from Sana and
   Theo", expandable to the items. Same task + same kind family (comments and
   replies together; a mention stays its own row so it's never buried),
   newest first, within the triage group. */

export interface InboxBundle {
  /** stable: `${group}:${taskId}:${family}` (or the single item's id) */
  key: string;
  taskId: string | null;
  /** newest first; a bundle of one is a plain row */
  items: Activity[];
  /** "3 comments on Launch deck from Sana and Theo" */
  summary: string;
  /** distinct actors, newest first ("Sana", "Theo") */
  actors: string[];
  unread: number;
  latestAt: string;
}

/** Fold one triage group's items into bundles (order: each bundle at its newest item's place). */
export function bundleInbox(items: Activity[], _ctx: { tasks: Task[] | ReadonlyMap<string, Task> }): InboxBundle[] {
  return items.map((a) => ({ key: a.id, taskId: a.taskId, items: [a], summary: a.taskTitle, actors: a.detail ? [a.detail] : [], unread: a.readAt ? 0 : 1, latestAt: a.createdAt }));
}
