/* The 0043 contract pieces the architect wrote as final (the packages fill
   everything else). Kept in its own file so no package edits it. */
import { describe, it, expect } from "vitest";
import { isSlackWebhookUrl, SLACK_WEBHOOK_RE } from "./slack";
import { publicFormTokenFromPath, publicFormUrl, DEMO_PUBLIC_TOKEN, PUBLIC_LIMITS } from "./publicForms";
import { calendarFeedUrl, webcalUrl, googleCalendarSubscribeUrl, outlookSubscribeUrl, DEMO_FEED_TOKEN } from "./calendarFeed";
import { pushPrefKey, PUSH_KINDS, VAPID_PUBLIC_KEY } from "./push";
import * as ics from "./ics";

describe("Slack webhook rule (same as the 0043 database check)", () => {
  it("accepts Slack Incoming Webhook URLs", () => {
    expect(isSlackWebhookUrl("https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX")).toBe(true);
    expect(isSlackWebhookUrl("  https://hooks.slack.com/services/T0_1/B-2/abc  ")).toBe(true);
  });
  it("refuses anything the server would refuse (SSRF shapes)", () => {
    for (const u of [
      "http://hooks.slack.com/services/T/B/x",
      "https://hooks.slack.com.evil.io/services/T/B/x",
      "https://evil.io/?https://hooks.slack.com/services/x",
      "https://hooks.slack.com/workflows/T/B/x",
      "https://hooks.slack.com/services/T/B/x?redirect=https://evil.io",
      "https://hooks.slack.com/services/" + "a".repeat(600),
      "",
    ]) expect(isSlackWebhookUrl(u)).toBe(false);
    expect(SLACK_WEBHOOK_RE.source).toContain("hooks\\.slack\\.com\\/services");
  });
});

describe("public form addresses", () => {
  it("reads the token from /f/<token> only", () => {
    expect(publicFormTokenFromPath("/f/0123456789abcdef0123456789abcdef")).toBe("0123456789abcdef0123456789abcdef");
    expect(publicFormTokenFromPath("/f/demo/")).toBe(DEMO_PUBLIC_TOKEN);
    for (const p of ["/", "/f", "/f/", "/forms", "/f/a/b", "/f/<script>", "/today", "/p/123", "/f/" + "a".repeat(129)]) {
      expect(publicFormTokenFromPath(p)).toBeNull();
    }
  });
  it("builds the shareable link", () => {
    expect(publicFormUrl("abc", "https://www.kanbo.co.uk/")).toBe("https://www.kanbo.co.uk/f/abc");
    expect(PUBLIC_LIMITS.title).toBeGreaterThan(0);
  });
});

describe("calendar feed links", () => {
  const url = calendarFeedUrl("tok123", "https://abc.supabase.co/");
  it("points at the ics-feed function with the token", () => {
    expect(url).toBe("https://abc.supabase.co/functions/v1/ics-feed?t=tok123");
    expect(webcalUrl(url)).toBe("webcal://abc.supabase.co/functions/v1/ics-feed?t=tok123");
    expect(DEMO_FEED_TOKEN).toBe("demo");
  });
  it("one-click Google and Outlook links carry the feed", () => {
    expect(googleCalendarSubscribeUrl(url)).toBe("https://calendar.google.com/calendar/r?cid=" + encodeURIComponent("webcal://abc.supabase.co/functions/v1/ics-feed?t=tok123"));
    expect(outlookSubscribeUrl(url)).toContain(encodeURIComponent(url));
  });
});

describe("push contract", () => {
  it("pref keys reuse notify_prefs with a _push suffix", () => {
    expect(pushPrefKey("assigned")).toBe("assigned_push");
    expect(PUSH_KINDS.map((k) => k.key)).toEqual(["assigned", "mention", "comment", "due"]);
  });
  it("reads the VAPID public key as a string (empty when unset: push stays hidden)", () => {
    expect(typeof VAPID_PUBLIC_KEY).toBe("string");
  });
});

describe("ICS module is shared with the edge function", () => {
  it("re-exports the builder API", () => {
    for (const k of ["buildIcs", "escapeIcsText", "foldIcsLine", "icsUtc", "icsDate", "londonWallTimeToUtc", "feedEvents"]) {
      expect(typeof (ics as Record<string, unknown>)[k]).toBe("function");
    }
    expect(ics.icsDate("2026-10-04")).toBe("20261004");
  });
});
