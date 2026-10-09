/* ============================================================
   KANBO — approvals (TaskDetail panel, row/card badges, Inbox
   "Approvals for you", My tasks › Waiting on).  [0047 contract → w4]

   Contract (database 0047):
     tables approvals, approval_reviewers — select only (RLS: anyone who
       can see the task); realtime streams both.
       Badges: approvals?workspace_id=eq.<ws>&select=id,task_id,status,rule,
               created_at,approval_reviewers(decision)  (latest per task wins)
     rpc request_approval(p_task, p_reviewers uuid[], p_note?, p_rule 'any'|'all',
                          p_title?, p_attachment?) → approval JSON
         people who can edit the task (never guests); team tasks only;
         1–10 reviewers, active in the task's workspace (guests may review), not you;
         one open request per task
     rpc decide_approval(p_approval, p_decision 'approved'|'changes_requested', p_comment?)
         → approval JSON (your own review only; open requests only; you can change
           your mind until it resolves)
     rpc cancel_approval(p_approval) → approval JSON (the requester, or an owner/admin)
     rpc task_approvals(p_task) → approval JSON[] (newest first, ≤ 20)
     rpc list_my_approvals() → { to_review: [...], requested: [...] }  (each with `task`)
     errors: 'not authorized' · 'task not found' · 'approvals need a team task' ·
             'invalid rule' · 'invalid reviewers' · 'invalid note' · 'invalid comment' ·
             'invalid decision' · 'invalid attachment' · 'already pending' ·
             'approval not found' · 'approval closed'
   Side effects (server): Inbox activity kind 'approval' with meta
     { approval_id, event, status } — a request → each reviewer (pref
     'approval'); a decision → the requester. task_events field 'approval':
     new_value = the event, old_value = the request's status after it.
     Webhooks approval.requested / approval.decided (cancel = decided with
     decision 'cancelled'). Email/push: notify kind 'approval' (w4).

   Package w4 implements the async functions (real + demo fakes) and the
   components; parsers, resolveApprovalStatus and summaries are final.
   ============================================================ */
import type {
  Activity, ActivityMeta, Approval, ApprovalDecision, ApprovalFailure, ApprovalReviewer, ApprovalRule, ApprovalStatus, ApprovalSummary,
  ApprovalWithTask, IconName, MyApprovals, NewApprovalInput, Status, Task,
} from "../data/types";
import { MEMBERS, PROJECTS, TASKS } from "../data/data";
import { supabase } from "./supabase";

export const APPROVAL_LIMITS = { reviewers: 10, title: 200, note: 2000, comment: 2000 } as const;

const STATUSES = new Set<ApprovalStatus>(["pending", "approved", "changes_requested", "cancelled"]);
const DECISIONS = new Set<ApprovalDecision>(["approved", "changes_requested"]);
const TASK_STATUSES = new Set<Status>(["todo", "progress", "review", "blocked", "done"]);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const pick = (r: Record<string, unknown>, snake: string, camel: string) => (r[snake] !== undefined ? r[snake] : r[camel]);

function parseReviewer(raw: unknown): ApprovalReviewer | null {
  const r = obj(raw);
  const userId = r && str(pick(r, "user_id", "userId"));
  if (!r || !userId) return null;
  const d = r.decision;
  return {
    userId,
    name: str(r.name) ?? "Someone",
    decision: typeof d === "string" && DECISIONS.has(d as ApprovalDecision) ? (d as ApprovalDecision) : null,
    comment: str(r.comment),
    decidedAt: str(pick(r, "decided_at", "decidedAt")),
  };
}

/** An approval JSON object (snake_case; camelCase also read) → Approval; null if malformed. */
export function parseApproval(raw: unknown): Approval | null {
  const r = obj(raw);
  if (!r) return null;
  const id = str(r.id), taskId = str(pick(r, "task_id", "taskId")), workspaceId = str(pick(r, "workspace_id", "workspaceId"));
  const status = r.status, rule = r.rule;
  if (!id || !taskId || !workspaceId) return null;
  if (typeof status !== "string" || !STATUSES.has(status as ApprovalStatus) || (rule !== "any" && rule !== "all")) return null;
  return {
    id, taskId, workspaceId,
    requestedBy: str(pick(r, "requested_by", "requestedBy")),
    requestedByName: str(pick(r, "requested_by_name", "requestedByName")),
    title: typeof r.title === "string" ? r.title : "",
    note: str(r.note),
    attachmentId: str(pick(r, "attachment_id", "attachmentId")),
    status: status as ApprovalStatus,
    rule,
    createdAt: str(pick(r, "created_at", "createdAt")) ?? "",
    updatedAt: str(pick(r, "updated_at", "updatedAt")) ?? "",
    resolvedAt: str(pick(r, "resolved_at", "resolvedAt")),
    reviewers: (Array.isArray(r.reviewers) ? r.reviewers : []).map(parseReviewer).filter((x): x is ApprovalReviewer => !!x),
    canDecide: pick(r, "can_decide", "canDecide") === true,
    canCancel: pick(r, "can_cancel", "canCancel") === true,
  };
}

/** list_my_approvals() items: an approval plus its `task`. */
export function parseApprovalWithTask(raw: unknown): ApprovalWithTask | null {
  const a = parseApproval(raw);
  if (!a) return null;
  const t = obj((raw as Record<string, unknown>).task);
  const tid = t && str(t.id);
  const st = t?.status;
  return {
    ...a,
    task: t && tid ? {
      id: tid,
      title: typeof t.title === "string" ? t.title : "",
      projectId: str(pick(t, "project_id", "projectId")) ?? "",
      workspaceId: str(pick(t, "workspace_id", "workspaceId")),
      status: typeof st === "string" && TASK_STATUSES.has(st as Status) ? (st as Status) : "todo",
      dueDate: str(pick(t, "due_date", "dueDate")),
    } : null,
  };
}

export function parseMyApprovals(raw: unknown): MyApprovals {
  const r = obj(raw) ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map(parseApprovalWithTask).filter((x): x is ApprovalWithTask => !!x);
  return { toReview: list(pick(r, "to_review", "toReview")), requested: list(r.requested) };
}

/** The status the server resolves to from these reviews (mirrors approval_resolve()). */
export function resolveApprovalStatus(rule: ApprovalRule, decisions: (ApprovalDecision | null)[]): ApprovalStatus {
  if (decisions.some((d) => d === "changes_requested")) return "changes_requested";
  if (rule === "any" && decisions.some((d) => d === "approved")) return "approved";
  if (rule === "all" && decisions.length > 0 && decisions.every((d) => d === "approved")) return "approved";
  return "pending";
}

/** An approval → its badge numbers. */
export function approvalSummary(a: Pick<Approval, "id" | "taskId" | "status" | "rule" | "reviewers">): ApprovalSummary {
  return {
    approvalId: a.id, taskId: a.taskId, status: a.status, rule: a.rule,
    approved: a.reviewers.filter((r) => r.decision === "approved").length,
    total: a.reviewers.length,
  };
}

/** The badge's words: "Pending 1/2" (everyone must approve) · "Pending" (anyone may) ·
 *  "Approved" · "Changes requested" · "Cancelled". */
export function approvalBadgeLabel(s: Pick<ApprovalSummary, "status" | "approved" | "total" | "rule">): string {
  switch (s.status) {
    case "approved": return "Approved";
    case "changes_requested": return "Changes requested";
    case "cancelled": return "Cancelled";
    default: return s.rule === "all" ? `Pending ${s.approved}/${s.total}` : "Pending";
  }
}

/** An Inbox approval item's verb, after the actor's name (activity.detail) and before the task's title:
 *  "Sana asked for your approval on Homepage copy" · "Olive approved Homepage copy". */
export function approvalActivityVerb(meta: ActivityMeta | undefined): string {
  switch (meta?.event) {
    case "approved": return meta.status === "approved" ? "approved" : "approved their part of";
    case "changes_requested": return "asked for changes on";
    case "cancelled": return "cancelled the approval request on";
    default: return "asked for your approval on";
  }
}

/** A database / network error → why (the messages the 0047 functions raise). */
export function approvalFailure(e: unknown): ApprovalFailure {
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  const code = String((e as { code?: unknown })?.code ?? "");
  if (code === "42883" || code === "PGRST202" || /could not find the function|does not exist/i.test(msg)) return "unavailable";
  if (/failed to fetch|network|load failed/i.test(msg)) return "network";
  if (/already pending/i.test(msg)) return "already_pending";
  if (/approval closed/i.test(msg)) return "closed";
  if (/^invalid |invalid (rule|reviewers|note|comment|decision|attachment)|need a team task/i.test(msg)) return "invalid";
  if (/not authorized|not allowed|permission denied/i.test(msg)) return "not_allowed";
  if (/not found/i.test(msg)) return "not_found";
  return "error";
}


/* ============================================================
   w4 — the data functions (Supabase, or the demo's in-memory fakes),
   the words the panel, badges and Inbox group use, and the pure helpers
   the integrator wires in (My tasks › Waiting on approval, the task
   timeline, Settings › Notifications).
   ============================================================ */

/* ------------------------------------------------------------ words */

/** Each status's chip: its words, tone (a kit Pill tone) and icon. Cancelled requests show no badge. */
export const APPROVAL_STATUS_INFO: Readonly<Record<ApprovalStatus, { label: string; tone: "accent" | "ok" | "warn" | "neutral"; icon: IconName }>> = {
  pending: { label: "Pending", tone: "accent", icon: "hourglass" },
  approved: { label: "Approved", tone: "ok", icon: "check" },
  changes_requested: { label: "Changes requested", tone: "warn", icon: "refresh" },
  cancelled: { label: "Cancelled", tone: "neutral", icon: "x" },
};

/** "Anyone can approve" · "Everyone must approve" */
export const APPROVAL_RULE_LABEL: Readonly<Record<ApprovalRule, string>> = {
  any: "Anyone can approve",
  all: "Everyone must approve",
};

/** What a screen reader hears for a badge: "Approval pending, 1 of 2 approved" · "Approved" · "Changes requested". */
export function approvalBadgeAria(s: Pick<ApprovalSummary, "status" | "approved" | "total" | "rule">): string {
  if (s.status === "pending") return s.rule === "all" ? `Approval pending, ${s.approved} of ${s.total} approved` : "Approval pending";
  return s.status === "approved" ? "Approved" : s.status === "changes_requested" ? "Changes requested" : "Approval cancelled";
}

/** Settings › Notifications: the row for approvals (in-app pref "approval", email "approval_email",
 *  push "approval_push"; the database and the notify function both read these keys). */
export const APPROVAL_NOTIFY_ROW = {
  key: "approval",
  label: "Approvals",
  hint: "Someone asks for your approval, or decides on a request you made.",
} as const;

/** "Sana Malik" → "Sana"; an email stays whole. */
export function firstNameOf(name: string | null | undefined): string {
  const n = String(name ?? "").trim();
  if (!n) return "Someone";
  return n.includes("@") ? n : n.split(/\s+/)[0];
}

/** "Sana" · "Sana and Maya" · "Sana, Maya and Theo" · "Sana and 3 others" (or: "Sana or Maya"). */
export function nameList(names: string[], joiner: "and" | "or" = "and"): string {
  const n = names.filter(Boolean);
  if (n.length <= 1) return n[0] ?? "";
  if (n.length === 2) return `${n[0]} ${joiner} ${n[1]}`;
  if (n.length === 3) return `${n[0]}, ${n[1]} ${joiner} ${n[2]}`;
  return `${n[0]} ${joiner} ${n.length - 1} others`;
}

/** The reviewers an open request still waits for. */
export function approvalWaitingOn(a: Pick<Approval, "status" | "reviewers">): ApprovalReviewer[] {
  return a.status === "pending" ? a.reviewers.filter((r) => r.decision === null) : [];
}

/** One line for an open request you made: "Waiting on Sana" · "Waiting on Sana or Maya" (anyone may) ·
 *  "1 of 2 approved · waiting on Sana" (everyone must). Resolved requests: their status. */
export function approvalWaitingNote(a: Pick<Approval, "status" | "rule" | "reviewers">): string {
  if (a.status !== "pending") return APPROVAL_STATUS_INFO[a.status].label;
  const waiting = approvalWaitingOn(a).map((r) => firstNameOf(r.name));
  const approved = a.reviewers.filter((r) => r.decision === "approved").length;
  if (!waiting.length) return "Waiting on a decision";
  if (a.rule === "all" && approved > 0) return `${approved} of ${a.reviewers.length} approved · waiting on ${nameList(waiting)}`;
  return `Waiting on ${nameList(waiting, a.rule === "any" ? "or" : "and")}`;
}

/** My tasks › Waiting on › "Waiting on approval": the tasks with an open request you made. */
export function waitingOnApprovalTaskIds(my: Pick<MyApprovals, "requested">): Set<string> {
  return new Set(my.requested.filter((a) => a.status === "pending").map((a) => a.taskId));
}

/** The "Waiting on approval" filter's rows: your open requests' tasks (newest request first), each with its
 *  line ("1 of 2 approved · waiting on Sana"). Tasks you can't see here (not in `tasks`) are left out. */
export function waitingOnApproval(my: Pick<MyApprovals, "requested">, tasks: Task[]): { key: "approval"; label: string; items: Task[]; notes: Map<string, string> } {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const notes = new Map<string, string>();
  const items: Task[] = [];
  for (const a of my.requested) {
    const t = byId.get(a.taskId);
    if (!t || a.status !== "pending" || notes.has(t.id)) continue;
    notes.set(t.id, approvalWaitingNote(a));
    items.push(t);
  }
  return { key: "approval", label: "Waiting on approval", items, notes };
}

/** InboxView: an approval notice's words — who (activity.detail), the verb that goes before the task's
 *  title (approvalActivityVerb), and the reviewer's comment to quote under it (decisions only). */
export function approvalInboxLine(a: Pick<Activity, "detail" | "meta">): { actor: string; verb: string; quote: string | null } {
  const ev = a.meta?.event;
  return {
    actor: (a.detail ?? "").trim() || "Someone",
    verb: approvalActivityVerb(a.meta),
    quote: ev === "approved" || ev === "changes_requested" ? (a.meta?.comment ?? "").trim() || null : null,
  };
}

/** InboxView: a request notice whose request still waits in "Approvals for you" (that group shows it,
 *  with its buttons), so the triage list can leave it out rather than show it twice. */
export function shownInApprovalsGroup(a: Pick<Activity, "kind" | "meta">, toReview: readonly Pick<Approval, "id">[]): boolean {
  return a.kind === "approval" && a.meta?.event === "requested" && !!a.meta.approvalId && toReview.some((x) => x.id === a.meta!.approvalId);
}

/** The task timeline's words for a task_events row with field "approval" (after the actor's name):
 *  new_value = what happened, old_value = the request's status after it. */
export function approvalEventText(newValue: string | null, oldValue: string | null): string {
  switch (newValue) {
    case "requested": return "asked for approval";
    case "approved": return oldValue === "approved" ? "approved it" : "approved it, still waiting on others";
    case "changes_requested": return "asked for changes";
    case "cancelled": return "cancelled the approval request";
    default: return "updated the approval request";
  }
}

/** A sentence for a failure (British English). `action` picks the wording for the refusals. */
export function approvalErrorText(e: unknown, action: "load" | "request" | "decide" | "cancel" = "load"): string {
  const reason = approvalFailure(e);
  const msg = String((e as { message?: unknown })?.message ?? e ?? "");
  switch (reason) {
    case "already_pending": return "This task already has an open request. Cancel it first, or wait for the decision.";
    case "closed": return "This request has already been decided or cancelled.";
    case "invalid":
      if (/need a team task/i.test(msg)) return "Approvals are for tasks in a team workspace.";
      if (/invalid note/i.test(msg)) return `The note is too long (${APPROVAL_LIMITS.note.toLocaleString("en-GB")} characters at most).`;
      if (/invalid comment/i.test(msg)) return `The comment is too long (${APPROVAL_LIMITS.comment.toLocaleString("en-GB")} characters at most).`;
      if (/invalid attachment/i.test(msg)) return "That file isn't on this task any more. Choose another, or ask about the whole task.";
      if (/invalid reviewers/i.test(msg)) return `Choose 1 to ${APPROVAL_LIMITS.reviewers} people from this workspace (not yourself).`;
      return "Something in the request wasn't right. Check it and try again.";
    case "not_allowed":
      return action === "request" ? "Only people who can edit this task can ask for approval."
        : action === "cancel" ? "Only the person who asked, or a workspace owner or admin, can cancel this request."
        : "You can't do that here.";
    case "not_found":
      return action === "request" ? "This task isn't there any more, or you can't edit it."
        : "This request isn't there any more. It may have been cancelled, or its task deleted.";
    case "unavailable": return "Approvals aren't switched on yet.";
    case "network": return "You're offline. Check your connection and try again.";
    default:
      return action === "load" ? "Couldn't load approvals. Try again." : "Something went wrong. Try again.";
  }
}

/* ------------------------------------------------------------ Supabase */

let schemaMissing = false;
let channelSeq = 0;
/** what the definer functions raise when 0047 hasn't been run (so a caller can say "not switched on yet") */
const unavailable = () => Object.assign(new Error("could not find the function (0047 not run)"), { code: "PGRST202" });

async function call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (schemaMissing) throw unavailable();
  const { data, error } = await supabase!.rpc(fn, args);
  if (error) {
    if (approvalFailure(error) === "unavailable") schemaMissing = true;
    throw error;
  }
  return data as T;
}

/** Email + push for a request / decision: best-effort, never blocks or fails the change (the Inbox
 *  notice is written by the database either way). The notify function reads who and what from the
 *  approval itself, so all it's told is which one. */
function notifyApproval(approvalId: string): void {
  if (!supabase) return;
  try {
    void supabase.functions.invoke("notify", { body: { kind: "approval", approvalId } }).then(() => undefined, () => undefined);
  } catch { /* not deployed: in-app still works */ }
}

const isMissingTable = (e: unknown) => {
  const code = String((e as { code?: unknown })?.code ?? "");
  const msg = String((e as { message?: unknown })?.message ?? "");
  return code === "42P01" || code === "PGRST205" || code === "PGRST200" || /does not exist|schema cache|could not find (the|a) (table|relationship)/i.test(msg);
};

/** How many requests listApprovalSummaries reads (newest first; a task's latest wins). */
export const APPROVAL_SUMMARY_LIMIT = 1000;

/* ------------------------------------------------------------ demo */

/** the demo's signed-in person (store.ts: currentUserId "m-self") */
const DEMO_ME = "m-self";
let DEMO_DELAY_MS = 250;
const wait = (ms: number) => (ms > 0 ? new Promise<void>((r) => setTimeout(r, ms)) : Promise.resolve());

interface DemoRow {
  id: string; taskId: string; workspaceId: string; requestedBy: string | null; title: string; note: string | null;
  attachmentId: string | null; status: ApprovalStatus; rule: ApprovalRule; createdAt: string; updatedAt: string;
  resolvedAt: string | null; reviewers: ApprovalReviewer[];
}
type DemoTask = { id: string; title: string; projectId: string; workspaceId: string | null; status: Status; dueDate: string | null };

let demoRows: DemoRow[] | null = null;
let demoSeq = 0;
const demoTasks = new Map<string, DemoTask>();
export type ApprovalChange = { table: "approvals" | "approval_reviewers"; approvalId: string; taskId: string | null };
const listeners = new Set<(change: ApprovalChange) => void>();
const tell = (c: ApprovalChange) => { for (const l of [...listeners]) { try { l(c); } catch { /* a listener's problem */ } } };

const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const memberName = (id: string | null) => (id ? MEMBERS.find((m) => m.id === id)?.name ?? "Someone" : "Someone");
const wsOfProject = (projectId: string) => PROJECTS.find((p) => p.id === projectId)?.workspaceId ?? null;

function demoTask(taskId: string): DemoTask | null {
  const seen = demoTasks.get(taskId);
  if (seen) return seen;
  const t = TASKS.find((x) => x.id === taskId);
  return t ? { id: t.id, title: t.title, projectId: t.projectId, workspaceId: t.workspaceId ?? wsOfProject(t.projectId), status: t.status, dueDate: t.dueDate ?? null } : null;
}

/** Demo mode: tell the fakes about a task they haven't seen (a task made in this session), so a
 *  request on it knows its workspace and title. The panel calls it; real mode ignores it. */
export function rememberApprovalTask(t: Pick<Task, "id" | "title" | "projectId" | "status"> & { workspaceId?: string | null; dueDate?: string | null }): void {
  if (supabase) return;
  demoTasks.set(t.id, {
    id: t.id, title: t.title, projectId: t.projectId, workspaceId: t.workspaceId ?? wsOfProject(t.projectId), status: t.status, dueDate: t.dueDate ?? null,
  });
}

const reviewer = (userId: string, decision: ApprovalDecision | null = null, comment: string | null = null, minutesAgo?: number): ApprovalReviewer => ({
  userId, name: memberName(userId), decision, comment, decidedAt: decision && minutesAgo !== undefined ? agoIso(minutesAgo) : null,
});

/* Two requests waiting on you (Sana's design tokens: anyone may approve; Maya's analytics events),
   one you made (the launch deck: everyone must approve, Maya has, Sana hasn't), and Sana's hero
   illustration, where you asked for changes yesterday (after an earlier request she withdrew). */
function seedDemo(): DemoRow[] {
  const row = (o: Omit<DemoRow, "workspaceId" | "title" | "updatedAt"> & { updatedAt?: string }): DemoRow => {
    const t = demoTask(o.taskId);
    return { ...o, workspaceId: t?.workspaceId ?? "ws-foundrise", title: t?.title ?? "", updatedAt: o.updatedAt ?? o.resolvedAt ?? o.createdAt };
  };
  return [
    row({ id: "ap-demo-1", taskId: "t-4", requestedBy: "m-3", rule: "any", status: "pending", createdAt: agoIso(95), resolvedAt: null, attachmentId: null,
      note: "Final pass on contrast and the type scale. Happy for this to go to engineering?",
      reviewers: [reviewer(DEMO_ME), reviewer("m-1")] }),
    row({ id: "ap-demo-2", taskId: "t-10", requestedBy: "m-1", rule: "any", status: "pending", createdAt: agoIso(260), resolvedAt: null, attachmentId: null,
      note: "Event names follow the tracking plan. Can you sign them off before I merge?",
      reviewers: [reviewer(DEMO_ME), reviewer("m-2")] }),
    row({ id: "ap-demo-3", taskId: "t-1", requestedBy: DEMO_ME, rule: "all", status: "pending", createdAt: agoIso(330), resolvedAt: null, attachmentId: null,
      note: "Final cut is 14 slides. Sign-off before Thursday's review, please.",
      reviewers: [reviewer("m-1", "approved", "Strong opening. The traction chart lands.", 70), reviewer("m-3")], updatedAt: agoIso(70) }),
    row({ id: "ap-demo-4", taskId: "t-9", requestedBy: "m-3", rule: "any", status: "changes_requested", createdAt: agoIso(26 * 60), resolvedAt: agoIso(22 * 60), attachmentId: null,
      note: "Second round: brighter sky, fewer clouds.",
      reviewers: [reviewer(DEMO_ME, "changes_requested", "Love the composition. Can we try a warmer palette so it sits with the new tokens?", 22 * 60), reviewer("m-4")] }),
    row({ id: "ap-demo-5", taskId: "t-9", requestedBy: "m-3", rule: "any", status: "cancelled", createdAt: agoIso(3 * 24 * 60), resolvedAt: agoIso(3 * 24 * 60 - 45), attachmentId: null,
      note: "First sketch for a gut check.",
      reviewers: [reviewer(DEMO_ME)] }),
  ];
}
const rows = () => (demoRows ??= seedDemo());

const byDecided = (a: ApprovalReviewer, b: ApprovalReviewer) =>
  (a.decidedAt === null ? 1 : 0) - (b.decidedAt === null ? 1 : 0) || (a.decidedAt ?? "").localeCompare(b.decidedAt ?? "") || a.name.localeCompare(b.name);

function demoView(r: DemoRow): Approval {
  const open = r.status === "pending";
  return {
    id: r.id, taskId: r.taskId, workspaceId: r.workspaceId, requestedBy: r.requestedBy,
    requestedByName: r.requestedBy ? memberName(r.requestedBy) : null, title: r.title, note: r.note, attachmentId: r.attachmentId,
    status: r.status, rule: r.rule, createdAt: r.createdAt, updatedAt: r.updatedAt, resolvedAt: r.resolvedAt,
    reviewers: [...r.reviewers].sort(byDecided).map((x) => ({ ...x })),
    canDecide: open && r.reviewers.some((x) => x.userId === DEMO_ME),
    canCancel: open && r.requestedBy === DEMO_ME,
  };
}
function demoWithTask(r: DemoRow): ApprovalWithTask {
  const t = demoTask(r.taskId);
  return { ...demoView(r), task: t ? { ...t } : null };
}
const newest = (a: { createdAt: string; id: string }, b: { createdAt: string; id: string }) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
const err = (message: string) => new Error(message);

/** Tests: forget the demo's changes (and, optionally, make it answer at once). */
export function resetApprovalsDemo(opts: { demoDelayMs?: number } = {}): void {
  demoRows = null; demoSeq = 0; demoTasks.clear(); schemaMissing = false;
  if (opts.demoDelayMs !== undefined) DEMO_DELAY_MS = opts.demoDelayMs;
}

/** Demo Inbox items to go with the fakes (kind "approval", newest first): Sana and Maya asking you,
 *  Maya approving her part of your deck, and (read) your own request on the hero illustration being
 *  decided — store.ts can add these to its demo activity. */
export const DEMO_APPROVAL_ACTIVITY: Activity[] = ([
  { id: "a-demo-ap-1", taskId: "t-4", taskTitle: "Define design tokens v2", kind: "approval", detail: "Sana Rao", createdAt: agoIso(95),
    meta: { approvalId: "ap-demo-1", event: "requested", status: "pending", rule: "any" } },
  { id: "a-demo-ap-2", taskId: "t-1", taskTitle: "Finalise Q3 launch narrative deck", kind: "approval", detail: "Maya Lin", createdAt: agoIso(70),
    meta: { approvalId: "ap-demo-3", event: "approved", status: "pending", comment: "Strong opening. The traction chart lands." } },
  { id: "a-demo-ap-3", taskId: "t-10", taskTitle: "Set up usage analytics events", kind: "approval", detail: "Maya Lin", createdAt: agoIso(260), readAt: agoIso(240),
    meta: { approvalId: "ap-demo-2", event: "requested", status: "pending", rule: "any" } },
] satisfies Activity[]).sort((x, y) => y.createdAt.localeCompare(x.createdAt));

/** A task_events row with field "approval" (WorkspaceEvent's shape). */
export interface ApprovalHistoryEvent {
  id: string; taskId: string; actorId: string | null; actorName: string; field: "approval";
  oldValue: string | null; newValue: string | null; createdAt: string;
}

/** Demo task history rows (field "approval") for the fakes, newest first. */
export function demoApprovalEvents(taskId: string): ApprovalHistoryEvent[] {
  const out: ApprovalHistoryEvent[] = [];
  for (const r of rows().filter((x) => x.taskId === taskId)) {
    const ev = (suffix: string, actorId: string | null, newValue: string, oldValue: string, at: string) =>
      out.push({ id: `${r.id}-${suffix}`, taskId, actorId, actorName: memberName(actorId), field: "approval", oldValue, newValue, createdAt: at });
    ev("req", r.requestedBy, "requested", "pending", r.createdAt);
    let decided = 0;
    for (const x of [...r.reviewers].filter((v) => v.decision && v.decidedAt).sort(byDecided)) {
      decided++;
      const after = resolveApprovalStatus(r.rule, r.reviewers.map((v) => (v.decidedAt && x.decidedAt && v.decidedAt <= x.decidedAt ? v.decision : null)));
      ev(`d${decided}`, x.userId, x.decision!, after, x.decidedAt!);
    }
    if (r.status === "cancelled" && r.resolvedAt) ev("cancel", r.requestedBy, "cancelled", "cancelled", r.resolvedAt);
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/* ------------------------------------------------------------ the functions */

/** A task's requests, newest first (at most 20). */
export async function listTaskApprovals(taskId: string): Promise<Approval[]> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    return rows().filter((r) => r.taskId === taskId).sort(newest).slice(0, 20).map(demoView);
  }
  const data = await call<unknown>("task_approvals", { p_task: taskId });
  return (Array.isArray(data) ? data : []).map(parseApproval).filter((x): x is Approval => !!x);
}

/** Waiting on you, and waiting on others for you. Demo mode: realistic fakes. */
export async function listMyApprovals(): Promise<MyApprovals> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    const open = rows().filter((r) => r.status === "pending").sort(newest);
    return {
      toReview: open.filter((r) => r.reviewers.some((x) => x.userId === DEMO_ME && x.decision === null)).map(demoWithTask),
      requested: open.filter((r) => r.requestedBy === DEMO_ME).map(demoWithTask),
    };
  }
  return parseMyApprovals(await call<unknown>("list_my_approvals", {}));
}

/** Badges for a workspace: task id → its latest request's summary (a cancelled one too: the badge
 *  shows nothing for it). Reads the newest APPROVAL_SUMMARY_LIMIT requests. Before 0047: {}. */
export async function listApprovalSummaries(workspaceId: string): Promise<Record<string, ApprovalSummary>> {
  const out: Record<string, ApprovalSummary> = {};
  const add = (a: Pick<Approval, "id" | "taskId" | "status" | "rule" | "reviewers">) => { if (!out[a.taskId]) out[a.taskId] = approvalSummary(a); };
  if (!supabase) {
    await wait(DEMO_DELAY_MS / 2);
    for (const r of rows().filter((x) => x.workspaceId === workspaceId).sort(newest)) add(r);
    return out;
  }
  if (schemaMissing || !workspaceId) return out;
  const { data, error } = await supabase.from("approvals")
    .select("id,task_id,status,rule,created_at,approval_reviewers(decision)")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false })
    .limit(APPROVAL_SUMMARY_LIMIT);
  if (error) {
    if (isMissingTable(error)) { schemaMissing = true; return out; }
    throw error;
  }
  for (const r of (data as Record<string, unknown>[] | null) ?? []) {
    const id = str(r.id), taskId = str(r.task_id), status = r.status, rule = r.rule;
    if (!id || !taskId || typeof status !== "string" || !STATUSES.has(status as ApprovalStatus) || (rule !== "any" && rule !== "all")) continue;
    const reviews = Array.isArray(r.approval_reviewers) ? r.approval_reviewers as { decision?: unknown }[] : [];
    add({
      id, taskId, status: status as ApprovalStatus, rule,
      reviewers: reviews.map((x, i) => ({
        userId: String(i), name: "", comment: null, decidedAt: null,
        decision: x?.decision === "approved" || x?.decision === "changes_requested" ? x.decision : null,
      })),
    });
  }
  return out;
}

export async function requestApproval(input: NewApprovalInput): Promise<Approval> {
  const reviewerIds = [...new Set((input.reviewerIds ?? []).filter((x) => typeof x === "string" && x))];
  const note = (input.note ?? "").trim() || null;
  const title = (input.title ?? "").trim() || null;
  if (input.rule !== "any" && input.rule !== "all") throw err("invalid rule");
  if (note && note.length > APPROVAL_LIMITS.note) throw err("invalid note");
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const t = demoTask(input.taskId);
    if (!t) throw err("task not found");
    if (!t.workspaceId) throw err("approvals need a team task");
    const rv = reviewerIds.filter((x) => x !== DEMO_ME);
    if (rv.length < 1 || rv.length > APPROVAL_LIMITS.reviewers) throw err("invalid reviewers");
    if (rows().some((r) => r.taskId === t.id && r.status === "pending")) throw err("already pending");
    const now = new Date().toISOString();
    const row: DemoRow = {
      id: `ap-demo-new-${++demoSeq}`, taskId: t.id, workspaceId: t.workspaceId, requestedBy: DEMO_ME,
      title: (title ?? t.title).slice(0, APPROVAL_LIMITS.title), note, attachmentId: input.attachmentId ?? null,
      status: "pending", rule: input.rule, createdAt: now, updatedAt: now, resolvedAt: null, reviewers: rv.map((x) => reviewer(x)),
    };
    rows().push(row);
    tell({ table: "approvals", approvalId: row.id, taskId: row.taskId });
    return demoView(row);
  }
  if (reviewerIds.length < 1 || reviewerIds.length > APPROVAL_LIMITS.reviewers) throw err("invalid reviewers");
  const data = await call<unknown>("request_approval", {
    p_task: input.taskId, p_reviewers: reviewerIds, p_note: note, p_rule: input.rule,
    p_title: title ? title.slice(0, APPROVAL_LIMITS.title) : null, p_attachment: input.attachmentId ?? null,
  });
  const a = parseApproval(data);
  if (!a) throw err("approval not found");
  notifyApproval(a.id);
  return a;
}

export async function decideApproval(approvalId: string, decision: ApprovalDecision, comment?: string | null): Promise<Approval> {
  const c = (comment ?? "").trim() || null;
  if (decision !== "approved" && decision !== "changes_requested") throw err("invalid decision");
  if (c && c.length > APPROVAL_LIMITS.comment) throw err("invalid comment");
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const r = rows().find((x) => x.id === approvalId);
    const mine = r?.reviewers.find((x) => x.userId === DEMO_ME);
    if (!r || !mine) throw err("approval not found");
    if (r.status !== "pending") throw err("approval closed");
    const now = new Date().toISOString();
    mine.decision = decision; mine.comment = c; mine.decidedAt = now;
    r.status = resolveApprovalStatus(r.rule, r.reviewers.map((x) => x.decision));
    r.updatedAt = now;
    r.resolvedAt = r.status === "pending" ? null : now;
    tell({ table: "approval_reviewers", approvalId: r.id, taskId: r.taskId });
    return demoView(r);
  }
  const a = parseApproval(await call<unknown>("decide_approval", { p_approval: approvalId, p_decision: decision, p_comment: c }));
  if (!a) throw err("approval not found");
  notifyApproval(a.id);
  return a;
}

export async function cancelApproval(approvalId: string): Promise<Approval> {
  if (!supabase) {
    await wait(DEMO_DELAY_MS);
    const r = rows().find((x) => x.id === approvalId);
    if (!r || r.requestedBy !== DEMO_ME) throw err("approval not found");
    if (r.status !== "pending") throw err("approval closed");
    const now = new Date().toISOString();
    r.status = "cancelled"; r.updatedAt = now; r.resolvedAt = now;
    tell({ table: "approvals", approvalId: r.id, taskId: r.taskId });
    return demoView(r);
  }
  const a = parseApproval(await call<unknown>("cancel_approval", { p_approval: approvalId }));
  if (!a) throw err("approval not found");
  return a;
}

/** Live changes to approvals / reviews the person can see (realtime, RLS-scoped). Returns unsubscribe.
 *  Demo mode: told about the fakes' own changes (so badges and the Inbox group follow the panel). */
export function subscribeApprovals(onChange: (change: ApprovalChange) => void): () => void {
  listeners.add(onChange);
  const off = () => { listeners.delete(onChange); };
  if (!supabase || schemaMissing) return off;
  const client = supabase;
  const rowOf = (p: { new?: unknown; old?: unknown }) => {
    const n = obj(p.new);
    return n && Object.keys(n).length ? n : obj(p.old) ?? {};
  };
  const ch = client.channel(`approvals-${++channelSeq}`)
    .on("postgres_changes", { event: "*", schema: "public", table: "approvals" }, (p: { new?: unknown; old?: unknown }) => {
      const r = rowOf(p);
      const id = str(r.id);
      if (id) onChange({ table: "approvals", approvalId: id, taskId: str(r.task_id) });
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "approval_reviewers" }, (p: { new?: unknown; old?: unknown }) => {
      const r = rowOf(p);
      const id = str(r.approval_id);
      if (id) onChange({ table: "approval_reviewers", approvalId: id, taskId: null });
    })
    .subscribe();
  return () => { off(); void client.removeChannel(ch); };
}
