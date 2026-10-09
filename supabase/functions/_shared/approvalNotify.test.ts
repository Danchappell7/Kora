// @vitest-environment node
// notify kind "approval": who hears about what comes from the approval's rows
// alone, never from the request, and only for something the caller just did.
import { describe, expect, it } from "vitest";
import {
  APPROVAL_EVENT_WINDOW_SEC, approvalEmail, approvalNoticeText, approvalPush, planApprovalNotice, type ApprovalRow, type ReviewerRow,
} from "./approvalNotify.ts";
import { encodePushMessage } from "./webpush.ts";

const NOW = Date.parse("2026-10-09T10:00:00Z");
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const SANA = "11111111-1111-4111-8111-111111111111";
const OLIVE = "22222222-2222-4222-8222-222222222222";
const GUS = "33333333-3333-4333-8333-333333333333";
const EVE = "44444444-4444-4444-8444-444444444444";
const A: ApprovalRow = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", task_id: "t", workspace_id: "w", requested_by: SANA, status: "pending", rule: "all",
  title: "Homepage copy", note: "Is the tone right?", created_at: ago(1), resolved_at: null,
};
const open: ReviewerRow[] = [
  { user_id: OLIVE, decision: null, comment: null, decided_at: null },
  { user_id: GUS, decision: null, comment: null, decided_at: null },
];

describe("planApprovalNotice", () => {
  it("a fresh request by the requester → the reviewers who haven't decided", () => {
    const p = planApprovalNotice(A, open, SANA, NOW);
    expect(p).toEqual({ event: "requested", recipients: [OLIVE, GUS], eventKey: `ap:${A.id}:requested`, status: "pending", rule: "all", quote: "Is the tone right?" });
    const some = planApprovalNotice(A, [{ ...open[0], decision: "approved", decided_at: ago(0) }, open[1]], SANA, NOW);
    expect("recipients" in some && some.recipients).toEqual([GUS]);
  });
  it("an old request, a closed one, or someone else's → nobody", () => {
    expect(planApprovalNotice({ ...A, created_at: ago(APPROVAL_EVENT_WINDOW_SEC / 60 + 1) }, open, SANA, NOW)).toEqual({ skip: "not a new request" });
    expect(planApprovalNotice({ ...A, status: "cancelled" }, open, SANA, NOW)).toEqual({ skip: "no longer open" });
    expect(planApprovalNotice(A, open, EVE, NOW)).toEqual({ skip: "nothing you did" });
    expect(planApprovalNotice(A, open, OLIVE, NOW)).toEqual({ skip: "nothing you did" }); // a reviewer who hasn't decided
    expect(planApprovalNotice({ ...A, created_at: new Date(NOW + 5 * 60_000).toISOString() }, open, SANA, NOW)).toEqual({ skip: "not a new request" });
  });
  it("a reviewer's fresh decision → the requester, with their comment; each decision is its own event", () => {
    const revs: ReviewerRow[] = [{ user_id: OLIVE, decision: "changes_requested", comment: "  Shorter,\n please ", decided_at: ago(2) }, open[1]];
    const p = planApprovalNotice({ ...A, status: "changes_requested" }, revs, OLIVE, NOW);
    expect(p).toEqual({
      event: "changes_requested", recipients: [SANA], eventKey: `ap:${A.id}:${OLIVE}:${ago(2)}`, status: "changes_requested", rule: "all", quote: "Shorter, please",
    });
    // changed their mind: a new decided_at, a new event
    const again = planApprovalNotice(A, [{ ...revs[0], decision: "approved", decided_at: ago(0) }], OLIVE, NOW);
    expect("eventKey" in again && again.eventKey).toBe(`ap:${A.id}:${OLIVE}:${ago(0)}`);
  });
  it("a stale decision, or a requester who's gone → nobody", () => {
    expect(planApprovalNotice(A, [{ user_id: OLIVE, decision: "approved", comment: null, decided_at: ago(30) }], OLIVE, NOW)).toEqual({ skip: "nothing you did" });
    expect(planApprovalNotice({ ...A, requested_by: null }, [{ user_id: OLIVE, decision: "approved", comment: null, decided_at: ago(1) }], OLIVE, NOW)).toEqual({ skip: "no requester to tell" });
  });
  it("long comments are cut to 280 characters", () => {
    const p = planApprovalNotice(A, [{ user_id: OLIVE, decision: "approved", comment: "x".repeat(400), decided_at: ago(1) }], OLIVE, NOW);
    expect("quote" in p && p.quote?.length).toBe(280);
  });
});

describe("the words", () => {
  const plan = (event: "requested" | "approved" | "changes_requested", status = "pending", rule: "any" | "all" = "any") =>
    ({ event, status, rule, recipients: [], eventKey: "k", quote: null as string | null });
  it("say who did what, in British English", () => {
    expect(approvalNoticeText(plan("requested", "pending", "all"), "Sana Malik", "Homepage copy")).toEqual({
      subject: "Sana Malik asked for your approval: Homepage copy", lead: "asked for your approval on", after: "Everyone asked needs to approve it.",
    });
    expect(approvalNoticeText(plan("approved", "approved"), "Olive", "Homepage copy").subject).toBe("Approved: Homepage copy");
    expect(approvalNoticeText(plan("approved", "pending", "all"), "Olive", "Homepage copy").after).toBe("Still waiting on others.");
    expect(approvalNoticeText(plan("changes_requested", "changes_requested"), "Olive", "Homepage copy").subject).toBe("Changes requested: Homepage copy");
  });
  it("the email escapes everything people wrote", () => {
    const p = { ...plan("changes_requested", "changes_requested"), quote: `<img src=x onerror="alert(1)">` };
    const { html } = approvalEmail(p, "<b>Eve</b>", `"><script>x</script>`, "https://www.kanbo.co.uk/?task=t");
    expect(html).not.toMatch(/<script|<img|<b>Eve/);
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("Open in Kanbo");
    expect(approvalEmail(plan("requested"), "Sana", "T", "").html).not.toContain("<a ");
  });
  it("the push links to the task and collapses per request", () => {
    const m = approvalPush(plan("requested"), "Sana", "Homepage copy", "t 1", "ap1");
    expect(m).toEqual({ title: "Sana asked for your approval", body: "Homepage copy", url: "/?task=t%201", tag: "approval-ap1", kind: "approval" });
    expect(approvalPush(plan("approved", "approved"), "Olive", "", "t", "a").title).toBe("Olive approved it");
    expect(approvalPush(plan("approved", "pending"), "Olive", "", "t", "a").body).toBe("A task");
    expect(JSON.parse(new TextDecoder().decode(encodePushMessage(m))).kind).toBe("approval");
  });
});
