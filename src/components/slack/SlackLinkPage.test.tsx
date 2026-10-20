/* /link/slack: "Link your Slack account?" (demo mode, and with
   lib/slackApp's calls stubbed for the refusals). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SlackLinkPage } from "./SlackLinkPage";
import * as lib from "../../lib/slackApp";
import { rememberSlackLink, pendingSlackLink, resetSlackAppDemo, SlackAppError, SLACK_APP_COPY } from "../../lib/slackApp";

const TOKEN = "Zm9vYmFyYmF6cXV4cXV1eGZvb2JhcmJhenF1eHF1dXg";
beforeEach(() => { resetSlackAppDemo({ delayMs: 0 }); vi.restoreAllMocks(); sessionStorage.clear(); });

const preview = (over: Partial<lib.SlackLinkPreview> = {}): lib.SlackLinkPreview => ({
  status: "ok", teamId: "TACME", teamName: "acme", slackUserName: "Mia Member", expiresAt: null, hasEmail: true, emailMatches: true, alreadyLinked: false, ...over,
});

describe("SlackLinkPage", () => {
  it("asks first, links, then says what to do next", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview());
    const claim = vi.spyOn(lib, "claimSlackLink").mockResolvedValue({ teamId: "TACME", teamName: "acme", slackUserId: "U1", slackUserName: "Mia Member", linkedAt: null });
    rememberSlackLink(TOKEN);
    const onDone = vi.fn();
    render(<SlackLinkPage token={TOKEN} onDone={onDone} />);
    const dialog = await screen.findByRole("dialog", { name: "Link your Slack account? Mia Member in acme.slack.com" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 })).toHaveFocus());
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(await screen.findByRole("heading", { name: "Slack is linked" })).toBeInTheDocument();
    expect(claim).toHaveBeenCalledWith(TOKEN, false);
    expect(pendingSlackLink()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Kanbo" }));
    expect(onDone).toHaveBeenCalled();
  });

  it("a Slack account with another email needs an explicit 'this is mine'", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview({ emailMatches: false }));
    const claim = vi.spyOn(lib, "claimSlackLink").mockResolvedValue({ teamId: "TACME", teamName: "acme", slackUserId: "U1", slackUserName: "Mia", linkedAt: null });
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    expect(await screen.findByText(/isn't the one you use for Kanbo/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Tick the box to confirm this Slack account is yours.");
    expect(claim).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: "This Slack account is mine" }));
    fireEvent.click(screen.getByRole("button", { name: "Link account" }));
    await screen.findByRole("heading", { name: "Slack is linked" });
    expect(claim).toHaveBeenCalledWith(TOKEN, true);
  });

  it("no email from Slack: also needs the tick, and says why", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview({ hasEmail: false, emailMatches: false }));
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    expect(await screen.findByText(/Slack didn't share this account's email/)).toBeInTheDocument();
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });

  it("used, expired and unknown links explain themselves", async () => {
    const spy = vi.spyOn(lib, "previewSlackLink");
    for (const [p, title] of [[preview({ status: "used" }), "This link has been used"], [preview({ status: "expired" }), "This link has expired"], [null, "This link isn't valid"]] as const) {
      spy.mockResolvedValueOnce(p);
      const { unmount } = render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
      expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Back to Kanbo" })).toBeInTheDocument();
      unmount();
    }
  });

  it("a link used meanwhile (claimed in another tab) says so", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview());
    vi.spyOn(lib, "claimSlackLink").mockRejectedValue(new SlackAppError("used", SLACK_APP_COPY.used));
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Link account" }));
    expect(await screen.findByRole("heading", { name: "This link has been used" })).toBeInTheDocument();
  });

  it("already linked: nothing to do", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview({ alreadyLinked: true }));
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    expect(await screen.findByRole("heading", { name: "Slack is already linked" })).toBeInTheDocument();
  });

  it("Cancel (and Escape) close it and forget the token", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview());
    rememberSlackLink(TOKEN);
    const onDone = vi.fn();
    render(<SlackLinkPage token={TOKEN} onDone={onDone} />);
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(pendingSlackLink()).toBeNull();
  });
  it("Escape is Cancel", async () => {
    vi.spyOn(lib, "previewSlackLink").mockResolvedValue(preview());
    const onDone = vi.fn();
    render(<SlackLinkPage token={TOKEN} onDone={onDone} />);
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.keyDown(cancel, { key: "Escape" });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it("a network problem offers Try again", async () => {
    const spy = vi.spyOn(lib, "previewSlackLink").mockRejectedValueOnce(new SlackAppError("network", SLACK_APP_COPY.network));
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    expect(await screen.findByText(SLACK_APP_COPY.network)).toBeInTheDocument();
    spy.mockResolvedValueOnce(preview());
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Link account" })).toBeInTheDocument();
  });

  it("demo mode works end to end", async () => {
    render(<SlackLinkPage token={TOKEN} onDone={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Link account" }));
    expect(await screen.findByRole("heading", { name: "Slack is linked" })).toBeInTheDocument();
  });
});
