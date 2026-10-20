/* lib/slackApp in demo mode (no Supabase) and its pure parts: the status /
   preview parsers, the failure sentences, the one-time link kept through
   signing in. The backend calls are in slackApp.remote.test.ts. */
import { describe, it, expect, beforeEach } from "vitest";
import {
  claimSlackLink, forgetSlackLink, isSlackLinkPath, isSlackPermalink, loadSlackAppStatus, parseSlackAppStatus, parseSlackLinkPreview, pendingSlackLink,
  previewSlackLink, rememberSlackLink, resetSlackAppDemo, setSlackDefaultWorkspace, SLACK_APP_COPY, slackAppFailure, slackLinkToOpen,
  slackLinkTokenFromUrl, slackTeamLabel, unlinkSlackAccount,
} from "./slackApp";

const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg";
beforeEach(() => { resetSlackAppDemo({ delayMs: 0 }); forgetSlackLink(); });

describe("parsers", () => {
  it("slack_app_status() JSON", () => {
    const s = parseSlackAppStatus({
      workspace_id: "w1", can_manage: true,
      teams: [{ team_id: "TACME", team_name: "acme", connected_at: "2026-10-20T10:00:00Z", is_default_here: true, default_workspace_id: "w1",
        default_workspace_name: "Acme", default_elsewhere: false, linked: true, slack_admin: true, can_set_default: true, can_clear: true }, { team_name: "no id" }],
      links: [{ team_id: "TACME", team_name: "acme", slack_user_id: "U1", slack_user_name: "Mia", linked_at: "2026-10-20T10:00:00Z" }, { team_id: "T" }],
    });
    expect(s).toEqual({
      workspaceId: "w1", canManage: true,
      teams: [{ teamId: "TACME", teamName: "acme", connectedAt: "2026-10-20T10:00:00Z", isDefaultHere: true, defaultWorkspaceId: "w1",
        defaultWorkspaceName: "Acme", defaultElsewhere: false, linked: true, slackAdmin: true, canSetDefault: true, canClear: true }],
      links: [{ teamId: "TACME", teamName: "acme", slackUserId: "U1", slackUserName: "Mia", linkedAt: "2026-10-20T10:00:00Z" }],
    });
    expect(parseSlackAppStatus(null)).toBeNull();
    expect(parseSlackAppStatus({ teams: "x" })).toBeNull();
    // a server before these fields: nobody is taken for a Slack admin
    expect(parseSlackAppStatus({ teams: [{ team_id: "T1", linked: true, can_set_default: true }], links: [] })?.teams[0])
      .toMatchObject({ slackAdmin: false, canSetDefault: true, canClear: false });
  });
  it("slack_link_preview() JSON", () => {
    expect(parseSlackLinkPreview({ status: "ok", team_id: "T", team_name: "acme", slack_user_name: "Mia", has_email: true, email_matches: false, already_linked: false }))
      .toMatchObject({ status: "ok", teamName: "acme", slackUserName: "Mia", hasEmail: true, emailMatches: false, alreadyLinked: false });
    expect(parseSlackLinkPreview({ status: "used" })).toMatchObject({ status: "used", emailMatches: false });
    expect(parseSlackLinkPreview({ status: "weird" })).toBeNull();
    expect(parseSlackLinkPreview(null)).toBeNull();
  });
  it("database errors → sentences", () => {
    expect(slackAppFailure({ message: "link already used" })).toMatchObject({ reason: "used", message: SLACK_APP_COPY.used });
    expect(slackAppFailure({ message: "link expired" }).reason).toBe("expired");
    expect(slackAppFailure({ message: "invalid link" }).reason).toBe("invalid_link");
    expect(slackAppFailure({ message: "email mismatch" }).reason).toBe("email_mismatch");
    expect(slackAppFailure({ message: "not allowed" }).reason).toBe("not_allowed");
    expect(slackAppFailure({ code: "PGRST202", message: "Could not find the function public.slack_app_status" }).reason).toBe("unavailable");
    expect(slackAppFailure(new TypeError("Failed to fetch")).reason).toBe("network");
    expect(slackAppFailure({ message: "boom" }).reason).toBe("unknown");
  });
  it("Slack workspace labels", () => {
    expect(slackTeamLabel("acme")).toBe("acme.slack.com");
    expect(slackTeamLabel("Acme Ltd")).toBe("Acme Ltd");
    expect(slackTeamLabel(null, "T1")).toBe("Slack workspace T1");
    expect(slackTeamLabel("")).toBe("your Slack workspace");
  });
  it("permalinks: only Slack message links", () => {
    expect(isSlackPermalink("https://acme.slack.com/archives/C1/p1700000000000100")).toBe(true);
    expect(isSlackPermalink("https://evil.test/archives/C1/p1")).toBe(false);
  });
});

describe("the one-time link survives signing in", () => {
  it("reads only /link/slack?t=<token>", () => {
    expect(slackLinkTokenFromUrl(`https://www.kanbo.co.uk/link/slack?t=${TOKEN}`)).toBe(TOKEN);
    expect(slackLinkTokenFromUrl(`/link/slack/?t=${TOKEN}`)).toBe(TOKEN);
    expect(slackLinkTokenFromUrl(`/today?t=${TOKEN}`)).toBeNull();
    expect(slackLinkTokenFromUrl("/link/slack?t=short")).toBeNull();
    expect(slackLinkTokenFromUrl(`/link/slack?t=${TOKEN}<script>`)).toBeNull();
    expect(isSlackLinkPath("/link/slack/")).toBe(true);
    expect(isSlackLinkPath("/link/slackx")).toBe(false);
  });
  it("kept for 15 minutes in this tab, then forgotten", () => {
    const now = Date.now();
    rememberSlackLink(TOKEN, now);
    expect(pendingSlackLink(now + 60_000)).toBe(TOKEN);
    expect(slackLinkToOpen("https://www.kanbo.co.uk/", now + 60_000)).toBe(TOKEN);
    expect(pendingSlackLink(now + 16 * 60_000)).toBeNull();
    expect(sessionStorage.getItem("kanbo:slack-link")).toBeNull();
    rememberSlackLink("bad");
    expect(pendingSlackLink()).toBeNull();
  });
  it("the address wins over a remembered one; forget clears it", () => {
    rememberSlackLink(TOKEN);
    const other = "b".repeat(43);
    expect(slackLinkToOpen(`https://www.kanbo.co.uk/link/slack?t=${other}`)).toBe(other);
    forgetSlackLink();
    expect(slackLinkToOpen("https://www.kanbo.co.uk/")).toBeNull();
  });
  it("a tampered stored value is ignored", () => {
    sessionStorage.setItem("kanbo:slack-link", JSON.stringify({ t: "<img src=x>", at: Date.now() }));
    expect(pendingSlackLink()).toBeNull();
    sessionStorage.setItem("kanbo:slack-link", "not json");
    expect(pendingSlackLink()).toBeNull();
    sessionStorage.setItem("kanbo:slack-link", JSON.stringify({ t: TOKEN, at: Date.now() + 3_600_000 }));
    expect(pendingSlackLink()).toBeNull();
  });
});

describe("demo mode", () => {
  it("a Slack workspace connected to the demo team workspace, with one linked account", async () => {
    const s = await loadSlackAppStatus("ws-foundrise");
    expect(s?.teams[0]).toMatchObject({ teamName: "foundrise", isDefaultHere: true, linked: true, canSetDefault: true });
    expect(s?.links).toHaveLength(1);
  });
  it("choose none, then back; unlink; link again", async () => {
    await setSlackDefaultWorkspace("T0FOUNDRISE", null);
    expect((await loadSlackAppStatus("ws-foundrise"))?.teams[0].isDefaultHere).toBe(false);
    await setSlackDefaultWorkspace("T0FOUNDRISE", "ws-foundrise");
    expect((await loadSlackAppStatus("ws-foundrise"))?.teams[0].isDefaultHere).toBe(true);
    await unlinkSlackAccount("T0FOUNDRISE", "U0DEMO");
    expect((await loadSlackAppStatus("ws-foundrise"))?.links).toEqual([]);
    expect((await previewSlackLink(TOKEN))?.status).toBe("ok");
    await claimSlackLink(TOKEN);
    expect((await loadSlackAppStatus("ws-foundrise"))?.links).toHaveLength(1);
  });
  it("a malformed token is refused before anything is asked", async () => {
    expect(await previewSlackLink("nope")).toBeNull();
    await expect(claimSlackLink("nope")).rejects.toMatchObject({ reason: "invalid_link" });
  });
});
