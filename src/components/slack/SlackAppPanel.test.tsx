/* Settings › Kanbo for Slack, in demo mode (lib/slackApp's in-memory Slack workspace). */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { SlackAppPanel } from "./SlackAppPanel";
import * as lib from "../../lib/slackApp";
import { resetSlackAppDemo, SlackAppError, SLACK_APP_COPY } from "../../lib/slackApp";

const WS = "ws-foundrise";
const RUNS = [{ id: WS, name: "Foundrise", role: "owner" as const }, { id: "ws-other", name: "Side project", role: "member" as const }];
beforeEach(() => { resetSlackAppDemo({ delayMs: 0 }); vi.restoreAllMocks(); });

const group = (name: string) => screen.getByRole("region", { name });

describe("SlackAppPanel", () => {
  it("an owner sees the Slack workspace, where it adds tasks, and can choose", async () => {
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    expect(await within(g).findByText("foundrise.slack.com")).toBeInTheDocument();
    expect(within(g).getByText(/add tasks to Foundrise/)).toBeInTheDocument();
    const select = within(g).getByLabelText("Adds tasks to") as HTMLSelectElement;
    expect(select.value).toBe(WS);
    // only the workspaces you run (and "none") are offered
    expect([...select.options].map((o) => o.textContent)).toEqual(["Foundrise", "No workspace (Personal lists)"]);
    fireEvent.change(select, { target: { value: "" } });
    expect(await screen.findByText(/now adds tasks to people's Personal lists/)).toBeInTheDocument();
    expect(within(g).getByText(/Not connected to a Kanbo workspace yet/)).toBeInTheDocument();
    fireEvent.change(within(g).getByLabelText("Adds tasks to"), { target: { value: WS } });
    expect(await screen.findByText(/now adds tasks to Foundrise/)).toBeInTheDocument();
  });

  it("a member sees the status, not the picker", async () => {
    render(<SlackAppPanel workspaceId="ws-other" workspaceName="Side project" role="member" workspaces={[RUNS[1]]} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    await within(g).findByText("foundrise.slack.com");
    expect(within(g).queryByLabelText("Adds tasks to")).toBeNull();
  });

  it("your linked accounts: Unlink asks first, then goes; focus lands on the list", async () => {
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const links = await screen.findByRole("region", { name: "Your linked Slack accounts" });
    expect(await within(links).findByText("You (Slack)")).toBeInTheDocument();
    fireEvent.click(within(links).getByRole("button", { name: "Unlink You (Slack) in foundrise.slack.com" }));
    const confirm = within(links).getByRole("group", { name: "Unlink You (Slack)?" });
    await waitFor(() => expect(within(confirm).getByRole("button", { name: "Cancel" })).toHaveFocus());
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    expect(within(links).queryByRole("group")).toBeNull();
    fireEvent.click(within(links).getByRole("button", { name: /Unlink You/ }));
    fireEvent.click(within(within(links).getByRole("group")).getByRole("button", { name: "Unlink" }));
    expect(await within(links).findByText("None yet")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/Unlinked You \(Slack\)/);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Your linked Slack accounts" })).toHaveFocus());
  });

  it("how to use: /kanbo examples, the shortcut, previews", async () => {
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" />);
    const how = await screen.findByRole("region", { name: "How to use Kanbo in Slack" });
    for (const t of ["/kanbo Send the brief fri 3pm", "/kanbo help"]) expect(within(how).getByText(t)).toBeInTheDocument();
    expect(within(how).getByText(/Create a Kanbo task/)).toBeInTheDocument();
  });

  it("before 0049: says it isn't switched on; offline: try again", async () => {
    const spy = vi.spyOn(lib, "loadSlackAppStatus").mockRejectedValueOnce(new SlackAppError("unavailable", SLACK_APP_COPY.unavailable));
    const { unmount } = render(<SlackAppPanel workspaceId={WS} />);
    expect(await screen.findByText("Not switched on yet")).toBeInTheDocument();
    unmount();
    spy.mockRejectedValueOnce(new SlackAppError("network", SLACK_APP_COPY.network));
    render(<SlackAppPanel workspaceId={WS} />);
    expect(await screen.findByText(/You're offline/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("foundrise.slack.com")).toBeInTheDocument();
  });

  it("a refusal is said, and stays", async () => {
    vi.spyOn(lib, "setSlackDefaultWorkspace").mockRejectedValueOnce(new SlackAppError("not_allowed", SLACK_APP_COPY.notAllowed));
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    fireEvent.change(await within(g).findByLabelText("Adds tasks to"), { target: { value: "" } });
    expect(await screen.findByText(SLACK_APP_COPY.notAllowed)).toBeInTheDocument();
    expect(group("Kanbo for Slack")).toBeInTheDocument();
  });
});
