/* lib/slack in demo mode (no Supabase: the tests' default), plus the pure
   helpers. The real-backend paths are in slack.remote.test.ts. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  autopostNote, connectSlack, disconnectSlack, getSlackStatus, loadSlackAutopostHealth, loadSlackStatus, normaliseChannelLabel,
  onSlackStatusChange, parseAutopostHealth, parseSlackStatus, peekSlackStatus, postToSlack, resetSlackState, risksSlackText,
  setDemoAutopostHealth, setSlackAutopost, SLACK_AUTOPOST_TIMES, SLACK_COPY, slackFailureMessage, testSlack, waitWords,
} from "./slack";

const HOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";
const WS = "ws-demo-1";

beforeEach(() => resetSlackState({ demoDelayMs: 0 }));

describe("parseSlackStatus", () => {
  it("reads slack_status()'s snake_case JSON", () => {
    expect(parseSlackStatus({
      connected: true, channel_label: "#team", autopost: true, autopost_time: "09:15",
      can_manage: true, can_post: true, updated_at: "2026-10-04T10:00:00Z",
    })).toEqual({ connected: true, channelLabel: "#team", autopost: true, autopostTime: "09:15", canManage: true, canPost: true, updatedAt: "2026-10-04T10:00:00Z" });
  });
  it("reads camelCase too, and is strict about everything else", () => {
    expect(parseSlackStatus({ connected: false, channelLabel: " ", autopost: true, autopostTime: "9am", canManage: "yes", canPost: 1 }))
      .toEqual({ connected: false, channelLabel: null, autopost: false, autopostTime: null, canManage: false, canPost: false, updatedAt: null });
    for (const bad of [null, undefined, "x", 1, [], {}, { connected: "true" }]) expect(parseSlackStatus(bad)).toBeNull();
  });
});

describe("normaliseChannelLabel", () => {
  it("shows a channel name the way Slack does", () => {
    expect(normaliseChannelLabel("team-updates")).toBe("#team-updates");
    expect(normaliseChannelLabel("#team-updates")).toBe("#team-updates");
    expect(normaliseChannelLabel("  Marketing   team ")).toBe("Marketing team");
    expect(normaliseChannelLabel("")).toBeNull();
    expect(normaliseChannelLabel(undefined)).toBeNull();
    expect(normaliseChannelLabel("x".repeat(200))!.length).toBe(80);
  });
});

describe("demo mode", () => {
  it("personal workspace: no Slack", async () => {
    expect(await getSlackStatus(null)).toBeNull();
    expect(peekSlackStatus(null)).toBeNull();
  });

  it("starts disconnected, with the owner's view", async () => {
    const s = await getSlackStatus(WS);
    expect(s).toMatchObject({ connected: false, canManage: true, canPost: true, autopost: false });
    expect(peekSlackStatus(WS)).toEqual(s);
  });

  it("refuses anything that isn't a Slack webhook, with a sentence", async () => {
    await expect(connectSlack(WS, "https://example.com/hook")).rejects.toThrow(SLACK_COPY.invalidUrl);
    await expect(connectSlack(WS, "https://hooks.slack.com/services/" + "a".repeat(600))).rejects.toThrow(SLACK_COPY.tooLong);
    expect((await getSlackStatus(WS))!.connected).toBe(false);
  });

  it("connect → test → post → auto-post → disconnect, telling listeners each time", async () => {
    const seen: (boolean | undefined)[] = [];
    const off = onSlackStatusChange((ws, s) => { if (ws === WS) seen.push(s?.connected); });

    const s = await connectSlack(WS, `  ${HOOK} `, "team-updates");
    expect(s).toMatchObject({ connected: true, channelLabel: "#team-updates" });
    expect(JSON.stringify(s)).not.toContain("hooks.slack.com");
    expect(await testSlack(WS)).toEqual({ ok: true });
    expect(await postToSlack(WS, { kind: "standup", text: "*Pulse*\nAll good." })).toEqual({ ok: true });

    const on = await setSlackAutopost(WS, true, "08:45");
    expect(on).toMatchObject({ autopost: true, autopostTime: "08:45" });
    await expect(setSlackAutopost(WS, true, "8:45")).rejects.toThrow(SLACK_COPY.invalidTime);
    expect((await setSlackAutopost(WS, false)).autopostTime).toBe("08:45");   // the time is kept

    const gone = await disconnectSlack(WS);
    expect(gone).toMatchObject({ connected: false, autopost: false });
    expect(await postToSlack(WS, { kind: "standup", text: "x" })).toMatchObject({ ok: false, reason: "not_connected" });
    expect(await testSlack(WS)).toMatchObject({ ok: false, reason: "not_connected" });
    await expect(setSlackAutopost(WS, true, "09:00")).rejects.toThrow(SLACK_COPY.notConnected);

    off();
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
  });

  it("an unsubscribed listener hears nothing more", async () => {
    const fn = vi.fn();
    const off = onSlackStatusChange(fn);
    off();
    await connectSlack(WS, HOOK);
    expect(fn).not.toHaveBeenCalled();
  });

  it("postToSlack checks its input and never throws", async () => {
    await connectSlack(WS, HOOK);
    expect(await postToSlack(WS, { kind: "standup", text: "   " })).toEqual({ ok: false, reason: "invalid", message: SLACK_COPY.nothingToPost });
    expect(await postToSlack(WS, { kind: "status", text: "On track" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await postToSlack(WS, { kind: "nope" as never, text: "x" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await postToSlack("", { kind: "risks", text: "x" })).toMatchObject({ ok: false, reason: "invalid" });
    expect(await postToSlack(WS, { kind: "status", text: "On track", projectId: "p1", status: "on_track" })).toEqual({ ok: true });
  });

  it("loadSlackStatus has no problem to report in demo", async () => {
    expect(await loadSlackStatus(WS)).toEqual({ status: expect.objectContaining({ connected: false }) });
  });
});

describe("words", () => {
  it("waits in words", () => {
    expect(waitWords(5)).toBe("a minute");
    expect(waitWords(60)).toBe("a minute");
    expect(waitWords(61)).toBe("2 minutes");
    expect(waitWords(600)).toBe("10 minutes");
    expect(waitWords(3600)).toBe("an hour");
    expect(waitWords(7200)).toBe("2 hours");
    expect(waitWords(undefined)).toBe("a minute");
  });
  it("explains every failure in a sentence", () => {
    expect(slackFailureMessage("rate_limited", { retryAfter: 180 })).toBe("That's a lot of posts in a short time. Try again in 3 minutes.");
    expect(slackFailureMessage("slack_rejected", { detail: "no_service" })).toMatch(/no longer accepts this webhook link/);
    expect(slackFailureMessage("slack_rejected", { detail: "channel_is_archived" })).toMatch(/archived/);
    expect(slackFailureMessage("slack_rejected", { detail: "slack_unavailable" })).toMatch(/isn't responding/);
    expect(slackFailureMessage("slack_rejected")).toMatch(/didn't accept/);
    expect(slackFailureMessage("not_allowed", { action: "test" })).toBe("Only owners and admins can send a test message.");
    expect(slackFailureMessage("invalid", { serverMessage: "That project isn't in this workspace." })).toBe("That project isn't in this workspace.");
    expect(slackFailureMessage("invalid", { serverMessage: "bad kind" })).toBe("That couldn't be posted.");
    for (const r of ["not_connected", "not_allowed", "unavailable", "network"] as const) {
      const m = slackFailureMessage(r);
      expect(m).toMatch(/^[A-Z].*\.$/);
      expect(m).not.toContain("!");
    }
  });
});

describe("helpers for the integrator", () => {
  it("auto-post times run every 15 minutes from 06:00 to 20:00", () => {
    expect(SLACK_AUTOPOST_TIMES[0]).toBe("06:00");
    expect(SLACK_AUTOPOST_TIMES[1]).toBe("06:15");
    expect(SLACK_AUTOPOST_TIMES[SLACK_AUTOPOST_TIMES.length - 1]).toBe("20:00");
    expect(SLACK_AUTOPOST_TIMES).toContain("09:00");
  });
  it("risksSlackText: most serious first, capped", () => {
    const text = risksSlackText([
      { title: "Quiet for a week", reason: "No changes since Mon", severity: "neutral" },
      { title: "Homepage *copy* is blocked", reason: "Waiting on Tom", severity: "signal" },
      { title: "Launch slipping", severity: "warn" },
    ]);
    expect(text.split("\n")).toEqual([
      "*3 risks on the Radar*",
      "• *Homepage copy is blocked* — Waiting on Tom",
      "• *Launch slipping*",
      "• *Quiet for a week* — No changes since Mon",
    ]);
    const many = risksSlackText(Array.from({ length: 20 }, (_, i) => ({ title: `R${i}` })), { max: 5 });
    expect(many.split("\n")).toHaveLength(7);
    expect(many).toContain("+15 more in Kanbo");
    expect(risksSlackText([])).toContain("Nothing on the Radar");
  });
});

describe("the daily post's health", () => {
  const err = (detail: string) => ({ health: { ready: true, lastError: { detail, at: "2026-10-05T08:05:00.000Z", day: "2026-10-05" } } });

  it("demo: running, nothing refused (or what a test sets)", async () => {
    expect(await loadSlackAutopostHealth(WS)).toEqual({ health: { ready: true, lastError: null } });
    expect(await loadSlackAutopostHealth(null)).toEqual({ health: null });
    setDemoAutopostHealth({ ready: false, lastError: null });
    expect(await loadSlackAutopostHealth(WS)).toEqual({ health: { ready: false, lastError: null } });
  });

  it("demo, like the server: a new link or a delivered test forgets a refused daily post", async () => {
    const refused = { ready: true, lastError: { detail: "no_service", at: "2026-10-05T08:05:00.000Z", day: "2026-10-05" } };
    await connectSlack(WS, HOOK, "#team");
    setDemoAutopostHealth(refused);
    expect((await loadSlackAutopostHealth(WS)).health?.lastError?.detail).toBe("no_service");
    expect(await testSlack(WS)).toEqual({ ok: true });
    expect((await loadSlackAutopostHealth(WS)).health?.lastError).toBeNull();
    setDemoAutopostHealth(refused);
    await connectSlack(WS, HOOK.replace("B0001", "B0002"), "#team");
    expect((await loadSlackAutopostHealth(WS)).health?.lastError).toBeNull();
  });

  it("parseAutopostHealth needs the server's field and a clean failure", () => {
    expect(parseAutopostHealth({ ok: true })).toBeNull();
    expect(parseAutopostHealth(null)).toBeNull();
    expect(parseAutopostHealth({ autopostReady: "yes" })).toEqual({ ready: null, lastError: null });
    expect(parseAutopostHealth({ autopostReady: true, lastAutopostError: { detail: "no_service", at: "2026-10-05T08:05:00Z", day: "2026-10-05" } }))
      .toEqual({ ready: true, lastError: { detail: "no_service", at: "2026-10-05T08:05:00Z", day: "2026-10-05" } });
    expect(parseAutopostHealth({ autopostReady: true, lastAutopostError: { detail: "https://hooks.slack.com/x", at: "x", day: "2026-10-05" } })?.lastError).toBeNull();
  });

  it("says nothing when all is well, offline, or before asking", () => {
    expect(autopostNote(null)).toBeNull();
    expect(autopostNote({ health: { ready: true, lastError: null } })).toBeNull();
    expect(autopostNote({ health: null, problem: "offline" })).toBeNull();
  });

  it("not scheduled on the server yet", () => {
    expect(autopostNote({ health: { ready: false, lastError: null } })).toEqual({
      tone: "warn", text: "The daily post isn't scheduled on Kanbo's server yet, so nothing will be posted until it is. Your choice is saved.",
    });
  });

  it("couldn't check (slack-post not deployed, or another error): a quiet line", () => {
    expect(autopostNote({ health: null, problem: "unavailable" })).toMatchObject({ tone: "quiet", text: expect.stringMatching(/^Kanbo couldn't check that the daily post is running\./) });
    expect(autopostNote({ health: null, problem: "error" })?.tone).toBe("quiet");
  });

  it("Slack refused it: what happened, on which day, and what to do", () => {
    expect(autopostNote(err("no_service"))).toEqual({ tone: "signal", text: "Slack refused the stand-up on Mon 5 Oct: it no longer accepts this webhook link. Replace the link to start posting again." });
    expect(autopostNote(err("http_404"))?.text).toMatch(/no longer accepts this webhook link/);
    expect(autopostNote(err("channel_is_archived"))).toEqual({ tone: "signal", text: "Slack refused the stand-up on Mon 5 Oct: the channel has been archived. Replace the link with one for another channel." });
    expect(autopostNote(err("action_prohibited"))?.text).toMatch(/your Slack admins don't allow posts to that channel/);
    expect(autopostNote(err("invalid_payload"))).toEqual({ tone: "signal", text: "Slack refused the stand-up on Mon 5 Oct. Send a test to check the channel, or replace the link." });
  });

  it("Slack wasn't responding, or Kanbo failed: a warning, it tries again", () => {
    expect(autopostNote(err("slack_unavailable"))).toEqual({ tone: "warn", text: "The stand-up on Mon 5 Oct didn't reach Slack because Slack wasn't responding. Kanbo will post again on the next weekday." });
    expect(autopostNote(err("unreachable"))?.tone).toBe("warn");
    expect(autopostNote(err("kanbo_error"))).toEqual({ tone: "warn", text: "Kanbo couldn't put together the stand-up on Mon 5 Oct. It will try again on the next weekday." });
  });

  it("not running beats a refusal (fix the schedule first)", () => {
    expect(autopostNote({ health: { ready: false, lastError: err("no_service").health.lastError } })?.text).toMatch(/isn't scheduled/);
  });
});
