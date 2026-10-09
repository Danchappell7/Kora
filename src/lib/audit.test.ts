/* lib/audit: the sentences, the CSV, UK days, and the demo history's
   filters and keyset paging (demo mode: no Supabase in tests). */
import { beforeEach, describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS, AUDIT_ACTOR_KANBO, auditEventDetails, auditEventsToCsv, auditParts, describeAuditEvent, exportAuditEvents, listAuditEvents,
  londonDay, londonDayStart, londonStamp, nextDay, parseAuditEvent, resetAuditDemo,
} from "./audit";
import type { AuditEvent } from "../data/types";

const WS = "851dadfe-dfce-497d-bf03-4e4a1394ad30";
const OLIVE = "78fc9c29-3f55-427d-bc09-f503e0ddd89e";
const SANA = "228cd532-0fa5-41b7-83d6-4d5cf399b0dd";
const ev = (action: string, detail: Record<string, unknown> = {}, o: Partial<AuditEvent> = {}): AuditEvent => parseAuditEvent({
  id: "c9f6a701-059e-4795-b6cf-8055436f54f8", workspace_id: WS, actor_id: OLIVE, actor_name: "Olive Owner", action,
  target_kind: action.split(".")[0], target_id: SANA, target_title: "Homepage copy", detail, created_at: "2026-10-09T13:05:03.123456+00:00",
  ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`), v])),
})!;

describe("sentences", () => {
  it("says what happened for every action the database writes", () => {
    const lines: Record<string, string> = {
      "task.deleted": describeAuditEvent(ev("task.deleted", { subtasks: 2 })),
      "task.restored": describeAuditEvent(ev("task.restored", { note: null })),
      "task.purged": describeAuditEvent(ev("task.purged", { deleted_by: "Sana Rao" })),
      "project.deleted": describeAuditEvent(ev("project.deleted", { tasks: 12, sections: 3 }, { targetTitle: "Old site" })),
      "project.purged": describeAuditEvent(ev("project.purged", { expired: true }, { actorId: null, actorName: "Kanbo", targetTitle: "Old site" })),
      "project.archived": describeAuditEvent(ev("project.archived", {}, { targetTitle: "Old site" })),
      "member.invited": describeAuditEvent(ev("member.invited", { email: "jo@acme.test", role: "admin" }, { targetTitle: "jo@acme.test" })),
      "member.joined (self)": describeAuditEvent(ev("member.joined", { role: "member" }, { actorId: SANA, actorName: "Sana Rao", targetTitle: "Sana Rao" })),
      "member.joined (added)": describeAuditEvent(ev("member.joined", { role: "guest" }, { targetTitle: "Gus Guest" })),
      "member.removed": describeAuditEvent(ev("member.removed", { email: "s@a.test", role: "member" }, { targetTitle: "Sana Rao" })),
      "member.removed (left)": describeAuditEvent(ev("member.removed", { self: true }, { actorId: SANA, actorName: "Sana Rao", targetTitle: "Sana Rao" })),
      "member.removed (invite)": describeAuditEvent(ev("member.removed", { invite: true }, { targetTitle: "jo@acme.test" })),
      "member.removed (account)": describeAuditEvent(ev("member.removed", { account_deleted: true }, { actorId: null, actorName: "Kanbo", targetTitle: "Sana Rao" })),
      "role.changed": describeAuditEvent(ev("role.changed", { from: "member", to: "admin" }, { targetTitle: "Sana Rao" })),
      "workspace.renamed": describeAuditEvent(ev("workspace.renamed", { from: "Acme", to: "Acme Ltd" }, { targetTitle: "Acme Ltd" })),
      "integration.connected": describeAuditEvent(ev("integration.connected", { provider: "slack", channel: "#launch" }, { targetTitle: "Slack" })),
      "integration.connected (notion)": describeAuditEvent(ev("integration.connected", { provider: "notion", notion_workspace: "Wiki" }, { targetTitle: "Notion" })),
      "integration.disconnected": describeAuditEvent(ev("integration.disconnected", { provider: "notion" }, { targetTitle: "Notion" })),
      "api_key.created": describeAuditEvent(ev("api_key.created", { access: "write", prefix: "kb_live_7Hq2" }, { targetTitle: "Zapier" })),
      "api_key.revoked": describeAuditEvent(ev("api_key.revoked", {}, { targetTitle: "Zapier" })),
      "webhook.created": describeAuditEvent(ev("webhook.created", { host: "hooks.zapier.com", events: ["task.created"] }, { targetTitle: "hooks.zapier.com" })),
      "webhook.deleted": describeAuditEvent(ev("webhook.deleted", { host: "hooks.zapier.com" })),
      "later action": describeAuditEvent(ev("doc.shared", {}, { targetTitle: "Brief" })),
    };
    expect(lines).toEqual({
      "task.deleted": "Olive Owner deleted the task “Homepage copy” and 2 sub-tasks",
      "task.restored": "Olive Owner restored the task “Homepage copy” from the recycle bin",
      "task.purged": "Olive Owner deleted the task “Homepage copy” for good",
      "project.deleted": "Olive Owner deleted the project “Old site” and its 12 tasks",
      "project.purged": "Kanbo cleared the project “Old site” from the recycle bin after 30 days",
      "project.archived": "Olive Owner archived the project “Old site”",
      "member.invited": "Olive Owner invited jo@acme.test as an admin",
      "member.joined (self)": "Sana Rao joined the workspace as a member",
      "member.joined (added)": "Olive Owner added Gus Guest as a guest",
      "member.removed": "Olive Owner removed Sana Rao from the workspace",
      "member.removed (left)": "Sana Rao left the workspace",
      "member.removed (invite)": "Olive Owner cancelled the invitation for jo@acme.test",
      "member.removed (account)": "Sana Rao left: their account was deleted",
      "role.changed": "Olive Owner changed Sana Rao’s role from member to admin",
      "workspace.renamed": "Olive Owner renamed the workspace from “Acme” to “Acme Ltd”",
      "integration.connected": "Olive Owner connected Slack (#launch)",
      "integration.connected (notion)": "Olive Owner connected Notion (“Wiki”)",
      "integration.disconnected": "Olive Owner disconnected Notion",
      "api_key.created": "Olive Owner created the API key “Zapier”",
      "api_key.revoked": "Olive Owner revoked the API key “Zapier”",
      "webhook.created": "Olive Owner added a webhook to hooks.zapier.com",
      "webhook.deleted": "Olive Owner deleted the webhook to hooks.zapier.com",
      "later action": "Olive Owner · doc.shared · Brief",
    });
  });
  it("covers every catalogued action with a real sentence (never the fallback)", () => {
    for (const a of AUDIT_ACTIONS) expect(describeAuditEvent(ev(a)), a).not.toContain(" · ");
  });
  it("your own actions read “You”, and a change to your role reads “your”", () => {
    expect(describeAuditEvent(ev("task.deleted"), { you: OLIVE })).toBe("You deleted the task “Homepage copy”");
    expect(describeAuditEvent(ev("role.changed", { from: "member", to: "admin" }, { targetId: SANA }), { you: SANA })).toBe("Olive Owner changed your role from member to admin");
    expect(auditParts(ev("member.removed"))[0]).toEqual({ strong: "Olive Owner" });
  });
  it("details: what the sentence leaves out", () => {
    expect(auditEventDetails(ev("task.restored", { note: "Its project was deleted, so it's back in “Marketing”." }))).toBe("Its project was deleted, so it's back in “Marketing”.");
    expect(auditEventDetails(ev("task.purged", { deleted_at: "2026-09-01T10:00:00Z", deleted_by: "Sana Rao", expired: true }))).toBe("Deleted 1 Sept 2026 by Sana Rao");
    expect(auditEventDetails(ev("api_key.created", { access: "write", prefix: "kb_live_7Hq2", expires_at: "2027-01-01T00:00:00Z" }))).toBe("Read and write · kb_live_7Hq2… · Expires 1 Jan 2027");
    expect(auditEventDetails(ev("webhook.created", { host: "x", events: ["task.created", "task.completed"] }))).toBe("task.created, task.completed");
    expect(auditEventDetails(ev("member.removed", { email: "s@a.test", role: "admin" }, { targetTitle: "Sana Rao" }))).toBe("s@a.test · Was an admin");
    expect(auditEventDetails(ev("role.changed", { email: "s@a.test" }, { targetTitle: "s@a.test" }))).toBe("");
  });
});

describe("UK days", () => {
  it("midnight in London as a UTC instant, BST and GMT, and on both clock-change days", () => {
    expect(londonDayStart("2026-07-01")).toBe("2026-06-30T23:00:00.000Z");
    expect(londonDayStart("2026-12-01")).toBe("2026-12-01T00:00:00.000Z");
    expect(londonDayStart("2026-03-29")).toBe("2026-03-29T00:00:00.000Z");   // clocks go forward at 01:00 GMT
    expect(londonDayStart("2026-10-25")).toBe("2026-10-24T23:00:00.000Z");   // still BST at midnight
    expect(londonDayStart("2026-10-26")).toBe("2026-10-26T00:00:00.000Z");
    expect(londonDayStart("9 Oct")).toBeNull();
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });
  it("the London day and wall-clock time of an instant", () => {
    expect(londonDay("2026-06-30T23:30:00Z")).toBe("2026-07-01");
    expect(londonDay("2026-12-31T23:30:00Z")).toBe("2026-12-31");
    expect(londonStamp("2026-10-09T13:05:03.123456+00:00")).toBe("2026-10-09 14:05:03");
    expect(londonStamp("2026-01-09T13:05:03Z")).toBe("2026-01-09 13:05:03");
    expect(londonDay("nonsense")).toBe("");
  });
});

describe("CSV", () => {
  it("a header row, UTC and UK time, quoted cells, CRLF and a BOM", () => {
    const csv = auditEventsToCsv([ev("task.deleted", { subtasks: 1 }), ev("webhook.created", { host: "hooks.zapier.com", events: ["task.created", "task.updated"] }, { targetTitle: "hooks.zapier.com" })]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"Time (UTC)","Time (UK)","Who","Action","What","Summary","Details"');
    expect(lines[1]).toBe('"2026-10-09T13:05:03.123Z","2026-10-09 14:05:03","Olive Owner","Task deleted","Homepage copy","Olive Owner deleted the task “Homepage copy” and 1 sub-task",""');
    expect(lines[2]).toContain('"task.created, task.updated"');
    expect(lines[3]).toBe("");
  });
  it("quotes quotes and commas, keeps newlines inside the cell, and defuses formulas", () => {
    const nasty = ev("task.deleted", {}, { targetTitle: '=HYPERLINK("http://evil","Click"), now', actorName: "@Mallory\nJones" });
    const csv = auditEventsToCsv([nasty]);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""Click""), now"`);
    expect(csv).toContain(`"'@Mallory\nJones"`);
    for (const lead of ["+", "-", "@", "="]) {
      expect(auditEventsToCsv([ev("task.deleted", {}, { targetTitle: `${lead}cmd` })])).toContain(`"'${lead}cmd"`);
    }
  });
  it("an empty export is just the header", () => {
    expect(auditEventsToCsv([])).toBe('﻿"Time (UTC)","Time (UK)","Who","Action","What","Summary","Details"\r\n');
  });
});

describe("demo history: filters and keyset paging", () => {
  beforeEach(() => resetAuditDemo({ demoDelayMs: 0 }));
  it("about twenty events, newest first, every page joining up with no gaps or repeats", async () => {
    const all = await listAuditEvents({ workspaceId: "ws-foundrise", limit: 500 });
    expect(all.events.length).toBeGreaterThanOrEqual(20);
    expect(all.next).toBeNull();
    const times = all.events.map((e) => e.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
    const paged: string[] = [];
    let before = null as Parameters<typeof listAuditEvents>[0]["before"];
    for (let i = 0; i < 20; i++) {
      const p = await listAuditEvents({ workspaceId: "ws-foundrise", limit: 6, before });
      paged.push(...p.events.map((e) => e.id));
      if (!p.next) break;
      before = p.next;
    }
    expect(paged).toEqual(all.events.map((e) => e.id));
  });
  it("person, Kanbo, action and date filters", async () => {
    const mine = await listAuditEvents({ workspaceId: "ws-foundrise", actorId: "m-self" });
    expect(mine.events.length).toBeGreaterThan(3);
    expect(mine.events.every((e) => e.actorId === "m-self")).toBe(true);
    const kanbo = await listAuditEvents({ workspaceId: "ws-foundrise", actorId: AUDIT_ACTOR_KANBO });
    expect(kanbo.events.length).toBeGreaterThan(0);
    expect(kanbo.events.every((e) => e.actorId === null && e.actorName === "Kanbo")).toBe(true);
    const people = await listAuditEvents({ workspaceId: "ws-foundrise", actions: ["member.invited", "member.joined", "member.removed", "role.changed"] });
    expect(people.events.every((e) => e.action.startsWith("member.") || e.action === "role.changed")).toBe(true);
    const today = londonDay(Date.now());
    const week = await listAuditEvents({ workspaceId: "ws-foundrise", from: londonDay(Date.now() - 6 * 864e5), to: today });
    expect(week.events.length).toBeGreaterThan(0);
    expect(week.events.every((e) => Date.now() - Date.parse(e.createdAt) < 8 * 864e5)).toBe(true);
  });
  it("exports every page", async () => {
    const { events, truncated } = await exportAuditEvents({ workspaceId: "ws-foundrise" });
    expect(truncated).toBe(false);
    expect(events.length).toBeGreaterThanOrEqual(20);
    expect(auditEventsToCsv(events).split("\r\n").length).toBe(events.length + 2);
  });
  it("another workspace has its own, smaller history", async () => {
    const reco = await listAuditEvents({ workspaceId: "ws-reco" });
    expect(reco.events.length).toBeGreaterThan(3);
    expect(reco.events.every((e) => e.workspaceId === "ws-reco")).toBe(true);
  });
});
