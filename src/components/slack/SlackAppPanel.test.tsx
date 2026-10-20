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

  it("linked, but not a Slack admin: can only set it back to Personal lists from the workspace it points at", async () => {
    const team = { teamId: "TACME", teamName: "acme", connectedAt: null, isDefaultHere: true, defaultWorkspaceId: WS, defaultWorkspaceName: "Foundrise",
      defaultElsewhere: false, linked: true, slackAdmin: false, slackAdminStale: false, canSetDefault: false, canClear: true };
    vi.spyOn(lib, "loadSlackAppStatus").mockResolvedValue({ workspaceId: WS, canManage: true, teams: [team], links: [] });
    const runs = [...RUNS, { id: "ws-mine", name: "My other team", role: "owner" as const }];
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={runs} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    const select = await within(g).findByLabelText("Adds tasks to") as HTMLSelectElement;
    // not "My other team": pointing it elsewhere is the Slack workspace's owners' and admins' call
    expect([...select.options].map((o) => o.textContent)).toEqual(["Foundrise", "No workspace (Personal lists)"]);
    expect(within(g).getByText(/Only an owner or admin of the Slack workspace can point it at a different workspace/)).toBeInTheDocument();
  });

  it("linked, not a Slack admin, nothing to clear: no picker, and why", async () => {
    const team = { teamId: "TACME", teamName: "acme", connectedAt: null, isDefaultHere: false, defaultWorkspaceId: null, defaultWorkspaceName: null,
      defaultElsewhere: false, linked: true, slackAdmin: false, slackAdminStale: false, canSetDefault: false, canClear: false };
    vi.spyOn(lib, "loadSlackAppStatus").mockResolvedValue({ workspaceId: WS, canManage: true, teams: [team], links: [] });
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    expect(await within(g).findByText(/Only an owner or admin of the Slack workspace, who also runs a Kanbo workspace, can choose it/)).toBeInTheDocument();
    expect(within(g).queryByLabelText("Adds tasks to")).toBeNull();
  });

  it("a Slack admin can take it back from a workspace someone else pointed it at", async () => {
    const team = { teamId: "TACME", teamName: "acme", connectedAt: null, isDefaultHere: false, defaultWorkspaceId: null, defaultWorkspaceName: null,
      defaultElsewhere: true, linked: true, slackAdmin: true, slackAdminStale: false, canSetDefault: true, canClear: true };
    vi.spyOn(lib, "loadSlackAppStatus").mockResolvedValue({ workspaceId: WS, canManage: true, teams: [team], links: [] });
    const set = vi.spyOn(lib, "setSlackDefaultWorkspace").mockResolvedValue(null);
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    const select = await within(g).findByLabelText("Adds tasks to") as HTMLSelectElement;
    expect([...select.options].map((o) => [o.textContent, o.disabled])).toEqual([["Another workspace", true], ["Foundrise", false], ["No workspace (Personal lists)", false]]);
    fireEvent.change(select, { target: { value: WS } });
    await waitFor(() => expect(set).toHaveBeenCalledWith("TACME", WS));
  });

  it("Slack's word is over a day old: why, and Check again (after the Home tab or /kanbo), then the picker", async () => {
    const base = { teamId: "TACME", teamName: "acme", connectedAt: null, isDefaultHere: false, defaultWorkspaceId: null, defaultWorkspaceName: null,
      defaultElsewhere: true, linked: true, canClear: false };
    const stale = { ...base, slackAdmin: false, slackAdminStale: true, canSetDefault: false };
    const fresh = { ...base, slackAdmin: true, slackAdminStale: false, canSetDefault: true, canClear: true };
    const load = vi.spyOn(lib, "loadSlackAppStatus")
      .mockResolvedValueOnce({ workspaceId: WS, canManage: true, teams: [stale], links: [] })
      .mockResolvedValueOnce({ workspaceId: WS, canManage: true, teams: [stale], links: [] })
      .mockResolvedValueOnce({ workspaceId: WS, canManage: true, teams: [fresh], links: [] });
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    expect(await within(g).findByText(/Slack last confirmed over a day ago that you're an owner or admin there/)).toBeInTheDocument();
    expect(within(g).queryByLabelText("Adds tasks to")).toBeNull();
    const check = within(g).getByRole("button", { name: "Check again whether you're an owner or admin of acme.slack.com" });
    check.focus();
    // Slack hasn't been asked again yet: said so, and the button keeps focus
    fireEvent.click(check);
    expect(await screen.findByText(/Slack hasn't confirmed it again yet/)).toBeInTheDocument();
    expect(check).toHaveFocus();
    // …now it has: the picker, focused
    fireEvent.click(check);
    expect(await screen.findByText("Slack says you're an owner or admin of acme.slack.com. You can choose where its tasks go.")).toBeInTheDocument();
    const select = within(g).getByLabelText("Adds tasks to");
    await waitFor(() => expect(select).toHaveFocus());
    expect(within(g).queryByRole("button", { name: /Check again/ })).toBeNull();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("choosing with Slack's word gone out of date: said how to fix it, and the row offers Check again", async () => {
    const team = { teamId: "TACME", teamName: "acme", connectedAt: null, isDefaultHere: false, defaultWorkspaceId: null, defaultWorkspaceName: null,
      defaultElsewhere: true, linked: true, canClear: false };
    vi.spyOn(lib, "loadSlackAppStatus")
      .mockResolvedValueOnce({ workspaceId: WS, canManage: true, teams: [{ ...team, slackAdmin: true, slackAdminStale: false, canSetDefault: true }], links: [] })
      .mockResolvedValueOnce({ workspaceId: WS, canManage: true, teams: [{ ...team, slackAdmin: false, slackAdminStale: true, canSetDefault: false }], links: [] });
    vi.spyOn(lib, "setSlackDefaultWorkspace").mockRejectedValueOnce(new SlackAppError("recheck", SLACK_APP_COPY.recheck));
    render(<SlackAppPanel workspaceId={WS} workspaceName="Foundrise" role="owner" workspaces={RUNS} />);
    const g = await screen.findByRole("region", { name: "Kanbo for Slack" });
    fireEvent.change(await within(g).findByLabelText("Adds tasks to"), { target: { value: WS } });
    expect(await screen.findByText(SLACK_APP_COPY.recheck)).toBeInTheDocument();
    const check = await within(g).findByRole("button", { name: /Check again/ });
    await waitFor(() => expect(check).toHaveFocus());
    expect(within(g).queryByLabelText("Adds tasks to")).toBeNull();
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
