// @vitest-environment node
// slackAppData's pure edges with a scripted database: the card a task becomes
// (link previews are read by the whole channel), the one-time link request's
// Slack admin flag, and keeping that flag current. The SQL itself runs
// against the real migrations in the PGlite replay (scratchpad/pgtest-slack).
import { describe, expect, it } from "vitest";
import { createLinkRequest, loadCard, refreshSlackAdmin, toCard, type CardRow, type SlackDb } from "./slackAppData.ts";
import { cardFacts, taskUnfurl } from "./slackAppBlocks.ts";
import type { Tx } from "./api/types.ts";

const SHARER = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
const TASK = "cccccccc-0000-4000-8000-000000000001";
const WS = "bbbbbbbb-0000-4000-8000-000000000001";
const row = (o: Partial<CardRow> = {}): CardRow => ({
  id: TASK, title: "Ship the deck", status: "todo", priority: "medium", workspace_id: WS, due_date: "2026-10-23", due_time: null,
  assignee_id: SHARER, user_id: SHARER, created_at: new Date("2026-10-20T10:00:00Z"), project_name: "Launch", project_emoji: "🚀",
  assignee_name: "Sana Rao", ...o,
});
function scripted(rows: unknown[] = []) {
  const seen: Array<{ text: string; params: readonly unknown[] }> = [];
  const tx: Tx = { async query<T>(text: string, params: readonly unknown[] = []) { seen.push({ text, params }); return rows as T[]; } };
  const db: SlackDb = { service: tx, withUser: async (_scope, fn) => fn(tx) };
  return { db, tx, seen };
}

describe("cards", () => {
  it("a preview of a task assigned to the sharer names them for the channel (not \"You\")", async () => {
    const { db } = scripted([row()]);
    const card = await loadCard(db, SHARER, WS, TASK);
    expect(card).toMatchObject({ assigneeName: "Sana Rao", assignedToMe: true });
    const u = taskUnfurl(card!, "https://www.kanbo.co.uk") as { blocks: Array<{ fields?: Array<{ text: string }> }> };
    const fields = u.blocks[0].fields!.map((f) => f.text);
    expect(fields).toContain("*Assignee*\nSana Rao");
    expect(JSON.stringify(u)).not.toMatch(/\bYou\b/);
    // …while the card only they see still says "You"
    expect(cardFacts(card!)).toContain("👤 You");
  });
  it("someone else's task: their name everywhere", () => {
    const c = toCard(row({ assignee_id: OTHER, assignee_name: "Theo Hart" }), SHARER);
    expect(c).toMatchObject({ assigneeName: "Theo Hart", assignedToMe: false });
    expect(cardFacts(c)).toContain("👤 Theo Hart");
  });
  it("a Personal-list task (no member name) is \"You\" on your own card", () => {
    const c = toCard(row({ workspace_id: null, assignee_name: null }), SHARER);
    expect(c).toMatchObject({ personal: true, assigneeName: null, assignedToMe: true });
    expect(cardFacts(c)).toContain("👤 You");
  });
});

describe("the Slack admin flag", () => {
  it("the link request records what Slack said (false unless it said so)", async () => {
    const { tx, seen } = scripted();
    const base = { tokenHash: "a".repeat(64), teamId: "TACME", slackUserId: "UOLIVE" };
    await createLinkRequest(tx, { ...base, slackAdmin: true });
    await createLinkRequest(tx, base);
    const inserts = seen.filter((q) => /insert into public\.slack_link_requests/.test(q.text));
    expect(inserts.map((q) => q.params[6])).toEqual([true, false]);
    expect(inserts[0].text).toMatch(/slack_admin/);
  });
  it("refreshing records when Slack said it: on a change, or to bring the time up to date; a late yes never wins; never throws", async () => {
    const { tx, seen } = scripted();
    await refreshSlackAdmin(tx, "TACME", "UOLIVE", false);
    const q = seen[0].text;
    expect(q).toMatch(/update public\.slack_user_links l\s+set slack_admin = \$3, slack_admin_checked_at = s\.at/);
    // users.info (no time given): the database's clock; an event's time is never later than now
    expect(q).toMatch(/least\(coalesce\(\$4::timestamptz, now\(\)\), now\(\)\)/);
    // a "yes" never overwrites a newer answer; a "no" always applies
    expect(q).toMatch(/not \$3 or l\.slack_admin_checked_at is null or l\.slack_admin_checked_at <= s\.at/);
    // writes on a change, or when the time is over 15 minutes old
    expect(q).toMatch(/slack_admin is distinct from \$3[\s\S]*interval '15 minutes'/);
    expect(seen[0].params).toEqual(["TACME", "UOLIVE", false, null]);
    await refreshSlackAdmin(tx, "TACME", "UOLIVE", true, new Date("2026-10-20T09:00:00Z"));
    expect(seen[1].params).toEqual(["TACME", "UOLIVE", true, "2026-10-20T09:00:00.000Z"]);
    await refreshSlackAdmin(tx, "TACME", "UOLIVE", true, new Date("nonsense"));
    expect(seen[2].params[3]).toBeNull();
    const failing: Tx = { async query() { throw new Error("boom"); } };
    await expect(refreshSlackAdmin(failing, "TACME", "UOLIVE", true)).resolves.toBeUndefined();
    await refreshSlackAdmin(tx, "bad id", "UOLIVE", true);
    expect(seen).toHaveLength(3);
  });
});
