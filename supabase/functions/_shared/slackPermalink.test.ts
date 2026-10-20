// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isSlackPermalink, SLACK_PERMALINK_MAX, SLACK_PERMALINK_RE, slackPermalinkOf } from "./slackPermalink.ts";

const nodeFs = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ nodeFs)) as { readFileSync: (p: string, enc: string) => string };
const { cwd } = (globalThis as unknown as { process: { cwd(): string } }).process;

describe("Slack message links (tasks.slack_permalink)", () => {
  it("accepts chat.getPermalink's shapes", () => {
    for (const ok of [
      "https://acme.slack.com/archives/C024BE91L/p1700000000123456",
      "https://acme-co.slack.com/archives/G0123ABC/p1700000000123456?thread_ts=1700000000.123456&cid=G0123ABC",
      "https://bigco.enterprise.slack.com/archives/C024BE91L/p1700000000123456",
      "https://acme.slack.com/archives/D024BE91L/p1700000000123456",
    ]) expect(isSlackPermalink(ok)).toBe(true);
  });
  it("refuses everything else", () => {
    for (const bad of [
      "http://acme.slack.com/archives/C1/p1", "https://acme.slack.com.evil.test/archives/C1/p1", "https://evil.test/archives/C1/p1",
      "https://acme.slack.com/archives/C1/p1 ", "https://acme.slack.com/archives/C1/p1\nx", "https://acme.slack.com/archives/c1/p1",
      "https://acme.slack.com/archives/C1/p1?x=<script>", "https://acme.slack.com/archives/C1/p1#x", "javascript:alert(1)",
      "https://user@acme.slack.com/archives/C1/p1", `https://acme.slack.com/archives/C1/p1?${"a".repeat(SLACK_PERMALINK_MAX)}`, "", null, 7,
    ]) expect(isSlackPermalink(bad)).toBe(false);
    expect(slackPermalinkOf("nope")).toBeNull();
  });
  it("is the same rule as the database's check (0049)", () => {
    const sql = readFileSync(`${cwd()}/supabase/migrations/0049_slack_app.sql`, "utf8");
    const m = /slack_permalink ~ '([^']+)'/.exec(sql);
    expect(m).not.toBeNull();
    expect(new RegExp(m![1]).source).toBe(SLACK_PERMALINK_RE.source);
    expect(sql).toContain(`length(slack_permalink) <= ${SLACK_PERMALINK_MAX}`);
  });
});
