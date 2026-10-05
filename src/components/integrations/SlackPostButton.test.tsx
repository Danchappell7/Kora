/* "Post to Slack", in demo mode (lib/slack's in-memory fake). */
import { StrictMode } from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ToastProvider } from "../Toast";
import { SlackPostButton } from "./SlackPostButton";
import * as slack from "../../lib/slack";

vi.mock("../../lib/slack", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../lib/slack")>();
  return { ...real, postToSlack: vi.fn(real.postToSlack) };
});

const HOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";
const WS = "ws-acme";

beforeEach(() => {
  slack.resetSlackState({ demoDelayMs: 0 });
  vi.mocked(slack.postToSlack).mockClear();
});

describe("SlackPostButton", () => {
  it("renders nothing without a connected workspace", async () => {
    const { container, rerender } = render(<SlackPostButton workspaceId={WS} kind="standup" getText={() => "x"} />);
    await act(async () => { await slack.getSlackStatus(WS); });
    expect(container).toBeEmptyDOMElement();
    await act(async () => { rerender(<SlackPostButton workspaceId={null} kind="standup" getText={() => "x"} />); });
    expect(container).toBeEmptyDOMElement();
  });

  it("posts the text read at click time, then says where it went", async () => {
    await slack.connectSlack(WS, HOOK, "#team");
    let text = "first";
    const onPosted = vi.fn();
    render(<ToastProvider><SlackPostButton workspaceId={WS} kind="status" projectId="p1" status="at_risk" getText={() => text} onPosted={onPosted} /></ToastProvider>);
    const btn = await screen.findByRole("button", { name: "Post to Slack, #team" });
    text = "  Copy is late.  ";
    fireEvent.click(btn);
    expect(await screen.findByText("Posted to #team")).toBeInTheDocument();
    expect(slack.postToSlack).toHaveBeenCalledWith(WS, { kind: "status", text: "Copy is late.", projectId: "p1", status: "at_risk", title: undefined });
    expect(onPosted).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Posted to #team" })).toBeInTheDocument();
  });

  it("nothing to post: says so and doesn't call Slack", async () => {
    await slack.connectSlack(WS, HOOK);
    render(<ToastProvider><SlackPostButton workspaceId={WS} kind="standup" getText={() => "  "} /></ToastProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Post to Slack" }));
    expect(await screen.findByText(slack.SLACK_COPY.nothingToPost)).toBeInTheDocument();
    expect(slack.postToSlack).not.toHaveBeenCalled();
  });

  it("shows why a post failed (inline without a toast provider)", async () => {
    await slack.connectSlack(WS, HOOK);
    vi.mocked(slack.postToSlack).mockResolvedValueOnce({ ok: false, reason: "rate_limited", retryAfter: 300, message: "That's a lot of posts in a short time. Try again in 5 minutes." });
    render(<SlackPostButton workspaceId={WS} kind="risks" getText={() => "• late"} label="Share risks" />);
    const btn = await screen.findByRole("button", { name: "Share risks" });
    // the live region is already there, empty, before anything is said into it
    const region = btn.closest(".kslk-post")!.querySelector("[role='status']")!;
    expect(region).toBeEmptyDOMElement();
    fireEvent.click(btn);
    const note = await screen.findByText("That's a lot of posts in a short time. Try again in 5 minutes.");
    expect(note.closest("[role='status']")).toBe(region);
    expect(region).toHaveAttribute("data-tone", "signal");
    expect(screen.getByRole("button", { name: "Share risks" })).not.toBeDisabled();
  });

  it("one click, one post (a second click while posting is ignored)", async () => {
    await slack.connectSlack(WS, HOOK);
    let finish!: (v: { ok: true }) => void;
    vi.mocked(slack.postToSlack).mockReturnValueOnce(new Promise((r) => { finish = r; }));
    render(<SlackPostButton workspaceId={WS} kind="standup" getText={() => "x"} />);
    const btn = await screen.findByRole("button", { name: "Post to Slack" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-busy", "true");
    fireEvent.click(btn);
    expect(slack.postToSlack).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
    expect(await screen.findByText("Posted to Slack")).toBeInTheDocument();
  });

  it("hides itself when Slack is disconnected, shows itself when connected", async () => {
    render(<SlackPostButton workspaceId={WS} kind="standup" getText={() => "x"} />);
    await act(async () => { await slack.getSlackStatus(WS); });
    expect(screen.queryByRole("button")).toBeNull();
    await act(async () => { await slack.connectSlack(WS, HOOK); });
    expect(await screen.findByRole("button", { name: "Post to Slack" })).toBeInTheDocument();
    await act(async () => { await slack.disconnectSlack(WS); });
    await waitFor(() => expect(screen.queryByRole("button")).toBeNull());
  });
});

/* `npx vite` renders under <StrictMode>, which mounts, unmounts and remounts
   every effect once: the button must still finish posting and settle back. */
describe("SlackPostButton under StrictMode (dev builds)", () => {
  it("posts, says where it went, then goes back to the button", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await slack.connectSlack(WS, HOOK, "#launch-team");
      render(<StrictMode><SlackPostButton workspaceId={WS} kind="standup" getText={() => "Shipped the hero."} /></StrictMode>);
      fireEvent.click(await screen.findByRole("button", { name: "Post to Slack, #launch-team" }));
      expect(await screen.findByText("Posted to #launch-team")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Posted to #launch-team" })).not.toHaveAttribute("aria-busy", "true");
      await act(async () => { vi.advanceTimersByTime(3000); });
      expect(screen.getByRole("button", { name: "Post to Slack, #launch-team" })).not.toBeDisabled();
      expect(screen.queryByText("Posted to #launch-team")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a refused post frees the button and says why", async () => {
    await slack.connectSlack(WS, HOOK);
    vi.mocked(slack.postToSlack).mockResolvedValueOnce({ ok: false, reason: "network", message: "Kanbo couldn't reach Slack. Try again in a moment." });
    render(<StrictMode><SlackPostButton workspaceId={WS} kind="risks" getText={() => "• late"} label="Share risks" /></StrictMode>);
    fireEvent.click(await screen.findByRole("button", { name: "Share risks" }));
    expect(await screen.findByText("Kanbo couldn't reach Slack. Try again in a moment.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Share risks" })).not.toHaveAttribute("aria-busy", "true");
  });
});
