/* lib/updateInbox + inboxTriage + activityMeta (0054): a project update in the Inbox says what it asks of you, opens
   where it lives, belongs to its project's workspace, and only an Ask (or a reply that mentions you) needs your reply. */
import { describe, it, expect } from "vitest";
import { isUpdateAsk, updateItemRoute, updateItemWorkspace, updateVerb } from "./updateInbox";
import { groupOf } from "./inboxTriage";
import { parseActivityMeta } from "./activityMeta";
import type { Activity } from "../data/types";

const item = (meta: Activity["meta"]): Activity => ({ id: "a", taskId: null, taskTitle: "Brand Refresh", kind: "update", detail: "Sana Rao", createdAt: "2026-11-10T09:00:00Z", meta });

describe("update items", () => {
  it("reads the database's meta", () => {
    expect(parseActivityMeta({ status_update_id: "su-1", project_id: "p1", update_event: "posted", update_status: "at_risk", ask: true, comment_id: "c1" }))
      .toEqual({ statusUpdateId: "su-1", projectId: "p1", updateEvent: "posted", updateStatus: "at_risk", ask: true, commentId: "c1" });
    expect(parseActivityMeta({ portfolio_id: "pf", portfolio_update_id: "pu", update_event: "portfolio", ask: false }))
      .toEqual({ portfolioId: "pf", portfolioUpdateId: "pu", updateEvent: "portfolio", ask: false });
    expect(parseActivityMeta({ update_event: "gossip", update_status: "great" })).toBeUndefined();
  });
  it("says what happened", () => {
    expect(updateVerb(item({ updateEvent: "posted" }))).toBe("posted an update on");
    expect(updateVerb(item({ updateEvent: "posted", ask: true }))).toBe("asked you something in the update on");
    expect(updateVerb(item({ updateEvent: "asked", ask: true }))).toBe("asked you something in the update on");
    expect(updateVerb(item({ updateEvent: "comment" }))).toBe("replied to your update on");
    expect(updateVerb(item({ updateEvent: "comment", ask: true }))).toBe("mentioned you in a reply on the update on");
    expect(updateVerb(item({ updateEvent: "portfolio" }))).toBe("posted a portfolio update on");
  });
  it("an Ask, or a reply that mentions you, needs your reply; the rest is FYI", () => {
    expect(groupOf(item({ updateEvent: "posted", ask: true }), {})).toBe("reply");
    expect(groupOf(item({ updateEvent: "comment", ask: true }), {})).toBe("reply");
    expect(groupOf(item({ updateEvent: "posted", ask: false }), {})).toBe("fyi");
    expect(groupOf(item({ updateEvent: "comment" }), {})).toBe("fyi");
    expect(isUpdateAsk(item({ ask: true }))).toBe(true);
  });
  it("opens the project's Updates tab, or the portfolio's page; belongs to its workspace", () => {
    expect(updateItemRoute(item({ projectId: "p1" }))).toEqual({ view: "project", projectId: "p1", tab: "updates" });
    expect(updateItemRoute(item({ portfolioId: "pf" }))).toEqual({ view: "portfolios", portfolioId: "pf", tab: "updates" });
    expect(updateItemRoute(item({}))).toBeNull();
    const projects = [{ id: "p1", workspaceId: "ws-a" }, { id: "p2", workspaceId: null }];
    expect(updateItemWorkspace(item({ projectId: "p1" }), projects)).toBe("ws-a");
    expect(updateItemWorkspace(item({ projectId: "p2" }), projects)).toBeNull();
    expect(updateItemWorkspace(item({ projectId: "gone" }), projects)).toBeUndefined();
    expect(updateItemWorkspace(item({ portfolioId: "pf" }), projects, [{ id: "pf", workspaceId: "ws-b" }])).toBe("ws-b");
  });
});
