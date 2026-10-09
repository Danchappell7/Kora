// ============================================================
// KANBO — approval emails and pushes (0047; notify kind "approval").   [w4]
//
// The app calls notify with { kind: "approval", approvalId } straight
// after it asks for approval or decides. Nothing else comes from the
// request: the notify function loads the approval, its reviews and its
// task with the service role, and this module decides who hears what —
//   • the caller asked (they're the requester, it's still open, and it was
//     made in the last 10 minutes) → every reviewer who hasn't decided;
//   • the caller decided (their own review, decided in the last 10
//     minutes) → the requester.
// Anything else (a replay much later, someone naming an approval they
// have nothing to do with) tells nobody. Each recipient hears about each
// event once (eventKey), by email and/or push per their prefs
// ("approval_email" / "approval_push", on unless switched off). The Inbox
// notice is the database's own (0047), whatever happens here.
//
// Pure module (no Deno globals, no remote imports): approvalNotify.test.ts.
// ============================================================
import type { PushMessage } from "./webpush.ts";

/** How recent the event must be (the app calls notify straight after the change). */
export const APPROVAL_EVENT_WINDOW_SEC = 600;

/** public.approvals, the columns notify reads. */
export interface ApprovalRow {
  id: string;
  task_id: string;
  workspace_id: string;
  requested_by: string | null;
  status: string;
  rule: string;
  title: string | null;
  note: string | null;
  created_at: string;
  resolved_at?: string | null;
}
/** public.approval_reviewers, the columns notify reads. */
export interface ReviewerRow {
  user_id: string;
  decision: string | null;
  comment: string | null;
  decided_at: string | null;
}

export type ApprovalNoticeEvent = "requested" | "approved" | "changes_requested";

export interface ApprovalNoticePlan {
  event: ApprovalNoticeEvent;
  /** who to tell (the caller filters to active, unsuspended members and drops the actor) */
  recipients: string[];
  /** names this one event: a recipient hears about it once */
  eventKey: string;
  /** the request's status now */
  status: string;
  rule: "any" | "all";
  /** the reviewer's comment (decisions) or the request's note (requests) */
  quote: string | null;
}

const fresh = (iso: string | null | undefined, now: number) => {
  const t = Date.parse(String(iso ?? ""));
  return Number.isFinite(t) && t <= now + 60_000 && now - t <= APPROVAL_EVENT_WINDOW_SEC * 1000;
};

/** What this caller's notify call is about, from the rows alone (or why it tells nobody). */
export function planApprovalNotice(a: ApprovalRow, reviewers: readonly ReviewerRow[], actorId: string, now = Date.now()): ApprovalNoticePlan | { skip: string } {
  const rule = a.rule === "all" ? "all" : "any";
  const mine = reviewers.find((r) => r.user_id === actorId);
  if (mine && (mine.decision === "approved" || mine.decision === "changes_requested") && fresh(mine.decided_at, now)) {
    if (!a.requested_by || a.requested_by === actorId) return { skip: "no requester to tell" };
    return {
      event: mine.decision, recipients: [a.requested_by], eventKey: `ap:${a.id}:${actorId}:${mine.decided_at}`,
      status: a.status, rule, quote: oneLine(mine.comment ?? "", 280) || null,
    };
  }
  if (a.requested_by === actorId) {
    if (a.status !== "pending") return { skip: "no longer open" };
    if (!fresh(a.created_at, now)) return { skip: "not a new request" };
    const waiting = reviewers.filter((r) => r.decision == null && r.user_id !== actorId).map((r) => r.user_id);
    if (!waiting.length) return { skip: "nobody left to ask" };
    return { event: "requested", recipients: [...new Set(waiting)], eventKey: `ap:${a.id}:requested`, status: a.status, rule, quote: oneLine(a.note ?? "", 280) || null };
  }
  return { skip: "nothing you did" };
}

function oneLine(s: string, max: number): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
}
const esc = (s: string) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] || c));

/** What the notice says: "Sana asked for your approval on Homepage copy" · "Olive approved Homepage copy" ·
 *  "Olive approved Homepage copy. Still waiting on others." · "Olive asked for changes on Homepage copy". */
export function approvalNoticeText(plan: Pick<ApprovalNoticePlan, "event" | "status" | "rule">, actorName: string, taskTitle: string): { subject: string; lead: string; after: string } {
  const who = oneLine(actorName, 60) || "Someone";
  const title = oneLine(taskTitle, 140) || "a task";
  switch (plan.event) {
    case "requested":
      return { subject: `${who} asked for your approval: ${title}`, lead: "asked for your approval on", after: plan.rule === "all" ? "Everyone asked needs to approve it." : "" };
    case "approved":
      return plan.status === "approved"
        ? { subject: `Approved: ${title}`, lead: "approved", after: "" }
        : { subject: `${who} approved: ${title}`, lead: "approved", after: "Still waiting on others." };
    default:
      return { subject: `Changes requested: ${title}`, lead: "asked for changes on", after: "" };
  }
}

/** The email: subject and HTML (everything user-written escaped). */
export function approvalEmail(plan: ApprovalNoticePlan, actorName: string, taskTitle: string, link: string): { subject: string; html: string } {
  const text = approvalNoticeText(plan, actorName, taskTitle);
  const quote = plan.quote
    ? `<p style="margin:12px 0;padding:8px 12px;border-left:3px solid #d6d9e6;color:#3d4250;font-size:14px">${esc(plan.quote)}</p>` : "";
  const html = `<div style="font-family:-apple-system,Segoe UI,sans-serif;color:#1a1a1a">
        <p style="font-size:15px"><strong>${esc(oneLine(actorName, 60) || "Someone")}</strong> ${text.lead} <strong>${esc(oneLine(taskTitle, 140) || "a task")}</strong>.${text.after ? ` ${esc(text.after)}` : ""}</p>
        ${quote}
        ${link ? `<p><a href="${esc(link)}" style="display:inline-block;background:#6a5cff;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-size:14px">${plan.event === "requested" ? "Review in Kanbo" : "Open in Kanbo"}</a></p>` : ""}
        <p style="font-size:12px;color:#888">Manage notification emails in Kanbo → Settings.</p>
      </div>`;
  return { subject: text.subject, html };
}

/** The push: who did what as the title, the task as the body; one per request on the lock screen. */
export function approvalPush(plan: Pick<ApprovalNoticePlan, "event" | "status" | "rule">, actorName: string, taskTitle: string, taskId: string, approvalId: string): PushMessage {
  const who = oneLine(actorName, 60) || "Someone";
  const title = plan.event === "requested" ? `${who} asked for your approval`
    : plan.event === "approved" ? (plan.status === "approved" ? `${who} approved it` : `${who} approved, others still to decide`)
    : `${who} asked for changes`;
  return { title, body: oneLine(taskTitle, 200) || "A task", url: `/?task=${encodeURIComponent(taskId)}`, tag: `approval-${approvalId}`, kind: "approval" };
}
