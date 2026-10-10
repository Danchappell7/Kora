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

/* ---------- bundles (0048, u4) ----------
   Related items fold into one row: "3 comments on Launch deck from Sana and
   Theo", expandable to the items. Same task + same kind family (comments
   and replies together; kudos together; your own updates together), within
   the triage group. Anything that asks something of you — a mention, an
   assignment, an approval, a doc mention, a request — and an integration
   notice is always its own row, so it's never buried. Each bundle sits at
   its newest item's place (the feed is newest first). */

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
  /** (u4) what the bundle holds; null for a bundle of one */
  family?: BundleFamily | null;
}

/** what folds together */
export type BundleFamily = "comment" | "kudos" | "history";

const REQUEST_DETAIL = /^\s*Request via\b/i;

/** The family an item folds into, or null: it always stands alone. */
export function bundleFamily(a: Activity, actor: string | null): BundleFamily | null {
  if (!a.taskId) return null;
  if (REQUEST_DETAIL.test(a.detail || "")) return null;
  if (a.kind === "comment") return actor ? "comment" : "history";
  if (a.kind === "kudos") return "kudos";
  if (SELF_KINDS.has(a.kind)) return a.kind === "created" ? null : "history";
  return null;
}

const NOUN: Record<BundleFamily, [string, string, string]> = {
  // one, many, preposition
  comment: ["comment", "comments", "on"],
  kudos: ["kudos", "kudos", "for"],
  history: ["update", "updates", "to"],
};
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const join = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** "Sana", "Sana and Theo", "Sana, Theo and Maya", "Sana, Theo and 2 others" — first names unless two share one. */
export function actorList(actors: string[]): string {
  const first = (n: string) => (EMAIL.test(n) ? n : n.trim().split(/\s+/)[0] || n);
  const firsts = actors.map(first);
  const names = new Set(firsts).size === firsts.length ? firsts : actors;
  if (names.length <= 3) return join(names);
  return `${names.slice(0, 2).join(", ")} and ${names.length - 2} others`;
}

/** "3 comments on Launch deck from Sana and Theo" */
export function bundleSummary(family: BundleFamily, count: number, title: string, actors: string[]): string {
  const [one, many, prep] = NOUN[family];
  const head = `${count} ${count === 1 ? one : many} ${prep} ${title || "a task"}`;
  return family === "history" || !actors.length ? head : `${head} from ${actorList(actors)}`;
}

/** Fold one triage group's items into bundles (order: each bundle at its newest item's place). */
export function bundleInbox(items: Activity[], ctx: {
  tasks: Task[] | ReadonlyMap<string, Task>;
  /** the triage group (part of each key); default "inbox" */
  group?: string;
  /** who an item is from (the Inbox knows a self-logged comment from a teammate's); default: its detail */
  actorOf?: (a: Activity) => string | null;
  /** false: every item on its own (the person's "bundle" pref) */
  bundle?: boolean;
}): InboxBundle[] {
  const byId = taskLookup(ctx.tasks);
  const group = ctx.group ?? "inbox";
  const actorOf = ctx.actorOf ?? ((a: Activity) => (a.kind === "comment" || a.kind === "kudos" || a.kind === "assigned" ? a.detail?.trim() || null : null));
  const out: InboxBundle[] = [];
  const open = new Map<string, { b: InboxBundle; family: BundleFamily }>();
  for (const a of items) {
    const actor = actorOf(a);
    const family = ctx.bundle === false ? null : bundleFamily(a, actor);
    const key = family ? `${group}:${a.taskId}:${family}` : a.id;
    const hit = family ? open.get(key) : undefined;
    if (hit) {
      hit.b.items.push(a);
      if (actor && !hit.b.actors.includes(actor)) hit.b.actors.push(actor);
      if (!a.readAt) hit.b.unread++;
      continue;
    }
    const b: InboxBundle = {
      key, taskId: a.taskId, items: [a], summary: "", actors: actor ? [actor] : [], unread: a.readAt ? 0 : 1,
      latestAt: a.createdAt, family: null,
    };
    out.push(b);
    if (family) open.set(key, { b, family });
  }
  for (const { b, family } of open.values()) {
    if (b.items.length < 2) continue;
    const title = (b.taskId && byId.get(b.taskId)?.title) || b.items[0].taskTitle;
    b.family = family;
    b.summary = bundleSummary(family, b.items.length, title, b.actors);
  }
  // a bundle of one is a plain row, keyed by its item
  for (const b of out) if (b.items.length === 1) { b.key = b.items[0].id; b.summary = b.items[0].taskTitle; }
  return out;
}
