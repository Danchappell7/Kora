/* Settings › Slack, in demo mode (lib/slack's in-memory fake). */
import { StrictMode } from "react";
import { describe, it, expect, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SlackSettingsPanel } from "./SlackSettingsPanel";
import { connectSlack, getSlackStatus, resetSlackState, setDemoAutopostHealth, setSlackAutopost, SLACK_COPY } from "../../lib/slack";

const HOOK = "https://hooks.slack.com/services/T0001/B0001/abcdefghijklmnopqrstuvwx";
const WS = "ws-acme";

beforeEach(() => resetSlackState({ demoDelayMs: 0 }));

const slackGroup = () => screen.getByRole("region", { name: "Slack" });

describe("SlackSettingsPanel", () => {
  it("explains that Slack is per team workspace in Personal", () => {
    render(<SlackSettingsPanel workspaceId={null} />);
    expect(within(slackGroup()).getByText("Slack is for team workspaces")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("an owner connects a channel; the link is never shown again", async () => {
    const { container } = render(<SlackSettingsPanel workspaceId={WS} workspaceName="Acme" role="owner" />);
    await screen.findByText("Not connected");
    const url = screen.getByLabelText("Webhook link");
    expect(url).toHaveAttribute("type", "url");
    expect(url).toHaveAttribute("autocomplete", "off");

    // empty, then not a Slack link: explained on the field
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText("Paste the webhook link from Slack.")).toBeInTheDocument();
    expect(url).toHaveAttribute("aria-invalid", "true");
    expect(url).toHaveFocus();
    fireEvent.change(url, { target: { value: "https://example.com/hook" } });
    expect(url).not.toHaveAttribute("aria-invalid");
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(SLACK_COPY.invalidUrl)).toBeInTheDocument();

    fireEvent.change(url, { target: { value: HOOK } });
    fireEvent.change(screen.getByLabelText(/Channel name/), { target: { value: "team-updates" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    expect(await within(slackGroup()).findByText("#team-updates")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/Connected to #team-updates\. Send a test to check it\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Send test" })).toHaveFocus());
    expect(screen.queryByLabelText("Webhook link")).toBeNull();
    expect(container.innerHTML).not.toContain("abcdefghijklmnopqrstuvwx");
    expect((await getSlackStatus(WS))?.connected).toBe(true);
  });

  it("sends a test and reports it", async () => {
    await connectSlack(WS, HOOK, "#team");
    const { container } = render(<SlackSettingsPanel workspaceId={WS} workspaceName="Acme" role="admin" />);
    const send = await screen.findByRole("button", { name: "Send test" });
    // the status region exists, empty, before the message arrives (so it's announced)
    const region = container.querySelector(".kslk-live")!;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();
    fireEvent.click(send);
    const msg = await screen.findByText("Test message sent to #team. Have a look in Slack.");
    expect(msg.closest("[role='status']")).toBe(region);
  });

  it("switches the daily stand-up on and picks its time", async () => {
    await connectSlack(WS, HOOK, "#team");
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    const daily = await screen.findByRole("region", { name: "Daily stand-up" });
    const sw = within(daily).getByRole("switch", { name: "Post the stand-up every weekday" });
    expect(sw).toHaveAttribute("aria-checked", "false");
    fireEvent.click(sw);
    expect(sw).toHaveAttribute("aria-checked", "true");
    expect(await within(daily).findByText("Saved")).toBeInTheDocument();
    expect(await getSlackStatus(WS)).toMatchObject({ autopost: true, autopostTime: "09:00" });

    const time = within(daily).getByRole("combobox", { name: "Stand-up time" });
    expect(time).toHaveValue("09:00");
    fireEvent.change(time, { target: { value: "08:30" } });
    await waitFor(async () => expect(await getSlackStatus(WS)).toMatchObject({ autopost: true, autopostTime: "08:30" }));
    expect(sw).not.toBeDisabled();   // stays usable while saving (keeps keyboard focus)
  });

  it("disconnects after asking, and goes back to the form", async () => {
    await connectSlack(WS, HOOK, "#team");
    await setSlackAutopost(WS, true, "09:00");
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    const confirm = screen.getByRole("group", { name: "Disconnect Slack?" });
    expect(within(confirm).getByText(/stops the daily stand-up/)).toBeInTheDocument();
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus());

    // Cancel puts focus back on Disconnect
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Disconnect" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    fireEvent.click(within(screen.getByRole("group", { name: "Disconnect Slack?" })).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText("Webhook link")).toHaveFocus());
    expect(screen.queryByRole("region", { name: "Daily stand-up" })).toBeNull();
    expect(await getSlackStatus(WS)).toMatchObject({ connected: false, autopost: false });
  });

  it("replaces the link without showing the old one", async () => {
    await connectSlack(WS, HOOK, "#team");
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace" }));
    const url = screen.getByLabelText("Webhook link");
    expect(url).toHaveValue("");
    await waitFor(() => expect(url).toHaveFocus());
    expect(screen.getByLabelText(/Channel name/)).toHaveValue("#team");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Replace" })).toHaveFocus());

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Webhook link"), { target: { value: HOOK.replace("B0001", "B0002") } });
    fireEvent.change(screen.getByLabelText(/Channel name/), { target: { value: "launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    expect(await within(slackGroup()).findByText("#launch")).toBeInTheDocument();
  });

  it("members see the connection but can't change it", async () => {
    await connectSlack(WS, HOOK, "#team");
    await setSlackAutopost(WS, true, "08:45");
    render(<SlackSettingsPanel workspaceId={WS} workspaceName="Acme" role="member" />);
    expect(await within(slackGroup()).findByText("#team")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send test" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.getByText("Every weekday at 08:45")).toBeInTheDocument();
  });

  it("members of an unconnected workspace are told who can connect it", async () => {
    render(<SlackSettingsPanel workspaceId={WS} workspaceName="Acme" role="guest" />);
    expect(await screen.findByText("An owner or admin of Acme can connect a Slack channel.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Webhook link")).toBeNull();
  });

  it("follows a change made elsewhere (another panel, another tab)", async () => {
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    await screen.findByText("Not connected");
    await act(async () => { await connectSlack(WS, HOOK, "#elsewhere"); });
    expect(await within(slackGroup()).findByText("#elsewhere")).toBeInTheDocument();
  });

  it("says when the daily post isn't scheduled on Kanbo's server, once it's switched on", async () => {
    await connectSlack(WS, HOOK, "#team");
    setDemoAutopostHealth({ ready: false, lastError: null });
    const { container } = render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    const daily = await screen.findByRole("region", { name: "Daily stand-up" });
    const region = container.querySelector(".kslk-health")!;
    expect(region).toHaveAttribute("role", "status");
    expect(region).toBeEmptyDOMElement();             // off: nothing to say (and the region is there to announce)
    fireEvent.click(within(daily).getByRole("switch", { name: "Post the stand-up every weekday" }));
    const note = await within(daily).findByText(/isn't scheduled on Kanbo's server yet, so nothing will be posted until it is/);
    expect(note.closest("[role='status']")).toBe(region);
    expect(note.closest(".kslk-msg")).toHaveAttribute("data-tone", "warn");
    expect(await getSlackStatus(WS)).toMatchObject({ autopost: true });   // the choice is still saved
    fireEvent.click(within(daily).getByRole("switch", { name: "Post the stand-up every weekday" }));
    await waitFor(() => expect(region).toBeEmptyDOMElement());
  });

  it("says when Slack refused the last stand-up; a test that gets through clears it", async () => {
    await connectSlack(WS, HOOK, "#team");
    await setSlackAutopost(WS, true, "09:00");
    setDemoAutopostHealth({ ready: true, lastError: { detail: "channel_is_archived", at: "2026-10-05T08:05:00.000Z", day: "2026-10-05" } });
    render(<SlackSettingsPanel workspaceId={WS} role="admin" />);
    const daily = await screen.findByRole("region", { name: "Daily stand-up" });
    const note = await within(daily).findByText("Slack refused the stand-up on Mon 5 Oct: the channel has been archived. Replace the link with one for another channel.");
    expect(note.closest(".kslk-msg")).toHaveAttribute("data-tone", "signal");
    fireEvent.click(screen.getByRole("button", { name: "Send test" }));
    await screen.findByText("Test message sent to #team. Have a look in Slack.");
    await waitFor(() => expect(within(daily).queryByText(/Slack refused the stand-up/)).toBeNull());
  });

  it("replacing the link asks again (the old link's refusal no longer applies)", async () => {
    await connectSlack(WS, HOOK, "#team");
    await setSlackAutopost(WS, true, "09:00");
    setDemoAutopostHealth({ ready: true, lastError: { detail: "no_service", at: "2026-10-05T08:05:00.000Z", day: "2026-10-05" } });
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    const daily = await screen.findByRole("region", { name: "Daily stand-up" });
    expect(await within(daily).findByText(/it no longer accepts this webhook link/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Webhook link"), { target: { value: HOOK.replace("B0001", "B0002") } });
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await screen.findByText(/Connected to #team\. Send a test to check it\./);
    await waitFor(() => expect(within(daily).queryByText(/no longer accepts/)).toBeNull());
  });

  it("members don't get the server's view of the daily post", async () => {
    await connectSlack(WS, HOOK, "#team");
    await setSlackAutopost(WS, true, "09:00");
    setDemoAutopostHealth({ ready: false, lastError: null });
    render(<SlackSettingsPanel workspaceId={WS} role="member" />);
    expect(await screen.findByText("Every weekday at 09:00")).toBeInTheDocument();
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(screen.queryByText(/isn't scheduled/)).toBeNull();
  });

  it("says it's a demo", async () => {
    render(<SlackSettingsPanel workspaceId={WS} role="owner" />);
    expect(await screen.findByText("This is a demo: nothing is sent to Slack.")).toBeInTheDocument();
  });
});

/* `npx vite` renders under <StrictMode>, which mounts, unmounts and remounts
   every effect once. A "still mounted?" flag that only its cleanup touches
   stays false after that, and every reply is then dropped on the floor. */
describe("SlackSettingsPanel under StrictMode (dev builds)", () => {
  it("connect, test, the daily stand-up, replace and disconnect all finish", async () => {
    render(<StrictMode><SlackSettingsPanel workspaceId={WS} workspaceName="Acme" role="owner" /></StrictMode>);
    await screen.findByText("Not connected");
    fireEvent.change(screen.getByLabelText("Webhook link"), { target: { value: HOOK } });
    fireEvent.change(screen.getByLabelText(/Channel name/), { target: { value: "launch-team" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/Connected to #launch-team\. Send a test to check it\./)).toBeInTheDocument();

    const test = screen.getByRole("button", { name: "Send test" });
    await waitFor(() => expect(test).not.toBeDisabled());
    await waitFor(() => expect(test).toHaveFocus());
    fireEvent.click(test);
    expect(await screen.findByText("Test message sent to #launch-team. Have a look in Slack.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test" })).not.toHaveAttribute("aria-busy", "true");

    const daily = screen.getByRole("region", { name: "Daily stand-up" });
    fireEvent.click(within(daily).getByRole("switch", { name: "Post the stand-up every weekday" }));
    expect(await within(daily).findByText("Saved")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("Webhook link"), { target: { value: HOOK.replace("B0001", "B0002") } });
    fireEvent.change(screen.getByLabelText(/Channel name/), { target: { value: "launch" } });
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    expect(await within(slackGroup()).findByText("#launch")).toBeInTheDocument();

    const off = screen.getByRole("button", { name: "Disconnect" });
    await waitFor(() => expect(off).not.toBeDisabled());
    fireEvent.click(off);
    const confirm = screen.getByRole("group", { name: "Disconnect Slack?" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect" })).not.toBeDisabled();
    expect(await getSlackStatus(WS)).toMatchObject({ connected: false, autopost: false });
  });
});
