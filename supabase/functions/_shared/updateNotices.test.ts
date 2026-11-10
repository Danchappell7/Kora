// @vitest-environment node
// notify's project-update kinds (0053 update_ask, 0054 status_update): who's
// told, and when nobody is. The clock is a parameter.
import { describe, expect, it } from "vitest";
import { ASK_FRESH_MS, askOwnerVerdict, askVerdict, POSTED_FRESH_MS, postedRecipients, postedVerdict, type AskRow, type UpdateProjectRow } from "./updateNotices.ts";

const LEAD = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const ADA = "33333333-3333-4333-8333-333333333333";
const W1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const P1 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NOW = Date.parse("2026-11-13T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const ask: AskRow = { id: "ask-1", project_id: P1, workspace_id: W1, asked_by: LEAD, owner_id: OWNER, created_at: ago(60_000) };
const project: UpdateProjectRow = { id: P1, name: "Launch", workspace_id: W1, owner_id: OWNER, archived_at: null };
const roles = new Map([[LEAD, "admin"], [OWNER, "member"], [ADA, "member"]]);

describe("an ask for an update", () => {
  it("only its asker sends it, while it's fresh; anyone else hears nothing of it", () => {
    expect(askVerdict(ask, LEAD, NOW)).toBe("ok");
    expect(askVerdict(ask, ADA, NOW)).toBeNull();
    expect(askVerdict(null, LEAD, NOW)).toBeNull();
    expect(askVerdict({ ...ask, created_at: ago(ASK_FRESH_MS + 1000) }, LEAD, NOW)).toBe("not new");
  });
  it("the owner hears while they still own the live project and can post its update", () => {
    expect(askOwnerVerdict(ask, project, roles, LEAD)).toBe("ok");
    expect(askOwnerVerdict(ask, { ...project, owner_id: ADA }, roles, LEAD)).toBe("project changed");
    expect(askOwnerVerdict(ask, { ...project, archived_at: "2026-11-12T00:00:00Z" }, roles, LEAD)).toBe("project changed");
    expect(askOwnerVerdict(ask, null, roles, LEAD)).toBe("project changed");
    expect(askOwnerVerdict(ask, project, new Map([[LEAD, "admin"]]), LEAD)).toBe("not a member");
    expect(askOwnerVerdict(ask, project, new Map([[OWNER, "member"]]), LEAD)).toBe("not a member");
  });
  it("a guest owner is never asked: they can't post one", () => {
    expect(askOwnerVerdict(ask, project, new Map([[LEAD, "admin"], [OWNER, "guest"]]), LEAD)).toBe("guest");
  });
});

describe("a posted update", () => {
  const u = { id: "su-1", project_id: P1, workspace_id: W1, author_id: OWNER, ask_user_ids: [ADA, LEAD, OWNER, ADA, "not-a-uuid"], created_at: ago(30_000) };
  it("only its author sends it, while it's fresh, for a team project", () => {
    expect(postedVerdict(u, OWNER, NOW)).toBe("ok");
    expect(postedVerdict(u, ADA, NOW)).toBeNull();
    expect(postedVerdict({ ...u, workspace_id: null }, OWNER, NOW)).toBe("personal");
    expect(postedVerdict({ ...u, created_at: ago(POSTED_FRESH_MS + 1000) }, OWNER, NOW)).toBe("not new");
    expect(postedVerdict({ ...u, project_id: "p-personal" }, OWNER, NOW)).toBe("no project");
  });
  it("push and email go to the people its Ask names who are still here, never its author; FYI readers aren't on the list", () => {
    const members = new Set([LEAD, OWNER, ADA]);
    expect(postedRecipients(u, OWNER, members, 50)).toEqual([ADA, LEAD]);
    expect(postedRecipients(u, OWNER, new Set([OWNER, LEAD]), 50)).toEqual([LEAD]);
    expect(postedRecipients({ ask_user_ids: null }, OWNER, members, 50)).toEqual([]);
    expect(postedRecipients(u, OWNER, members, 1)).toEqual([ADA]);
  });
});
