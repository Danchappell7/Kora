import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TeamView, WorkspaceSettingsPanel } from "./TeamView";
import type { Task, WorkspaceMember } from "../../data/types";

const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

const WS = "ws-foundrise";
const member = (p: Partial<WorkspaceMember> & { id: string }): WorkspaceMember => ({
  workspaceId: WS, userId: null, email: "x@kanbo.app", name: "", role: "member", status: "active", ...p,
});
function team(members: WorkspaceMember[], extra: Partial<Parameters<typeof TeamView>[0]> = {}) {
  const props = {
    tasks: [task], workspace: WS, currentUserId: "m-self", myRole: "owner" as const,
    workspaces: [{ id: WS, name: "Foundrise", ownerId: "m-self" }],
    members, onInvite: vi.fn(), onRemoveMember: vi.fn(), onNewWorkspace: vi.fn(), ...extra,
  };
  const utils = render(<TeamView {...props} />);
  return { ...utils, props };
}

describe("TeamView", () => {
  it("shows the live profile name before the invite-row name or email", () => {
    team([member({ id: "w1", userId: "m-1", email: "maya@kanbo.app", name: "maya" })]);
    expect(screen.getByText("Maya Lin")).toBeInTheDocument();
  });

  it("shows the server's reason inline when an invite fails, and keeps the email", async () => {
    const onInvite = vi.fn().mockRejectedValue(new Error("already a member — change their role from the team list"));
    team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "Sam@Partner.io" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Invite$/ })); });
    expect(onInvite).toHaveBeenCalledWith(WS, "sam@partner.io", "member");
    expect(screen.getByRole("status")).toHaveTextContent("sam@partner.io is already a member");
    expect(input).toHaveValue("Sam@Partner.io");
  });

  it("stops before calling the server when the email is already an active member", async () => {
    const onInvite = vi.fn();
    team([member({ id: "w1", userId: "m-1", email: "maya@kanbo.app" })], { onInvite });
    fireEvent.change(screen.getByLabelText("Invite email"), { target: { value: "maya@kanbo.app" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Invite$/ })); });
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Maya Lin is already a member");
  });

  it("confirms a successful invite inline and clears the field", async () => {
    const onInvite = vi.fn().mockResolvedValue({});
    team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "new@kanbo.app" } });
    fireEvent.change(screen.getByLabelText("Invite as role"), { target: { value: "admin" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(screen.getByRole("status")).toHaveTextContent("Invited new@kanbo.app as an admin");
    expect(input).toHaveValue("");
  });

  it("says 'sign up or sign in' — invitees who already have an account join on their next sign-in", async () => {
    const onInvite = vi.fn().mockResolvedValue({});
    team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "new@kanbo.app" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(screen.getByRole("status")).toHaveTextContent("They'll join when they sign up or sign in with that email.");
  });

  it("shows the store's rewritten server messages as plain sentences", async () => {
    const onInvite = vi.fn()
      .mockRejectedValueOnce(new Error("Only the workspace owner can add admins."))
      .mockRejectedValueOnce(new Error("Only workspace owners and admins can invite people."))
      .mockRejectedValueOnce(new Error("Couldn't create the invite. Please try again."));
    team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    const send = async () => {
      fireEvent.change(input, { target: { value: "new@kanbo.app" } });
      await act(async () => { fireEvent.submit(input.closest("form")!); });
      return screen.getByRole("status").textContent;
    };
    expect(await send()).toBe("Only the workspace owner can invite admins.");
    expect(await send()).toBe("Only owners and admins can invite people to this workspace.");
    expect(await send()).toBe("Couldn't create the invite. Please try again.");
  });

  it("claims nothing when onInvite doesn't return a promise (the caller reports failures itself)", async () => {
    const toastError = vi.fn();
    // shaped like an App handler that catches its own error and returns nothing
    const onInvite = vi.fn(() => { Promise.reject(new Error("not authorized")).catch((e: Error) => toastError(e.message)); });
    team([member({ id: "p1", email: "guest@partner.io", role: "guest", status: "invited" })], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "new@kanbo.app" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(onInvite).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(/^$/);
    expect(input).toHaveValue("");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(onInvite).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/Invite refreshed|Invite re-sent/)).toBeNull();
    expect(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })).not.toBeDisabled();
    expect(toastError).toHaveBeenCalled();
  });

  it("pending invites can be re-sent (then wait a minute) and their sign-up link copied", async () => {
    const onInvite = vi.fn().mockResolvedValue({});
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    team([member({ id: "p1", email: "guest@partner.io", role: "guest", status: "invited" })], { onInvite });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(onInvite).toHaveBeenCalledWith(WS, "guest@partner.io", "guest");
    // no promise that an email went out: the send may be skipped or not set up
    expect(screen.getByText("Invite refreshed")).toBeInTheDocument();
    expect(screen.getByText(/If the email doesn't reach them, copy the sign-up link/)).toBeInTheDocument();
    const cooling = screen.getByRole("button", { name: /Invite refreshed \(guest@partner\.io\) — you can resend in a minute/ });
    expect(cooling).toBeDisabled();
    fireEvent.click(cooling);
    expect(onInvite).toHaveBeenCalledTimes(1);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy sign-up link for guest@partner.io" })); });
    expect(writeText).toHaveBeenCalledWith(window.location.origin + "/");
    expect(screen.getByText("Link copied")).toBeInTheDocument();
  });

  it("a failed resend shows the reason and can be retried", async () => {
    const onInvite = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch")).mockResolvedValueOnce({});
    team([member({ id: "p1", email: "guest@partner.io", role: "guest", status: "invited" })], { onInvite });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(screen.getByText(/You seem to be offline/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(screen.getByText("Invite refreshed")).toBeInTheDocument();
  });

  it("with onResendInvite, Resend only re-sends the email and says how it went", async () => {
    const onInvite = vi.fn();
    const onResendInvite = vi.fn()
      .mockResolvedValueOnce({ sent: false, reason: "not_sent" })
      .mockResolvedValueOnce({ sent: true });
    team([member({ id: "p1", email: "guest@partner.io", role: "guest", status: "invited" })], { onInvite, onResendInvite });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(onResendInvite).toHaveBeenCalledWith("p1");
    expect(onInvite).not.toHaveBeenCalled();
    expect(screen.getByText(/the email couldn't be sent\. Share the sign-up link or resend it later/)).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(screen.getByText("Invite sent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Invite sent \(guest@partner\.io\) — you can resend in a minute/ })).toBeDisabled();
  });

  it("a resend the server throttled waits out the minute and says why", async () => {
    const onResendInvite = vi.fn().mockResolvedValue({ sent: false, reason: "throttled", retryAfter: 40 });
    team([member({ id: "p1", email: "guest@partner.io", role: "guest", status: "invited" })], { onResendInvite });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Resend invite to guest@partner.io" })); });
    expect(screen.getByText(/An invite email went to them less than a minute ago/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Recently sent \(guest@partner\.io\)/ })).toBeDisabled();
  });

  it("a new invite whose email couldn't go says so next to the field (the invite still stands)", async () => {
    const onInvite = vi.fn().mockResolvedValue({ id: "p9", email: "sam@partner.io", inviteEmail: { sent: false, reason: "email_not_configured" } });
    team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "sam@partner.io" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    expect(screen.getByText(/^Invite saved, but invite emails aren't set up yet/)).toBeInTheDocument();
    expect(input).toHaveValue("");
  });

  it("a fresh invite's card holds Resend off for a minute", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const onInvite = vi.fn().mockResolvedValue({});
    const { props, rerender } = team([], { onInvite });
    const input = screen.getByLabelText("Invite email");
    fireEvent.change(input, { target: { value: "New@Kanbo.app" } });
    await act(async () => { fireEvent.submit(input.closest("form")!); });
    rerender(<TeamView {...props} members={[member({ id: "p1", email: "new@kanbo.app", status: "invited" })]} />);
    expect(screen.getByRole("button", { name: /Just invited \(new@kanbo\.app\)/ })).toBeDisabled();
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(screen.getByRole("button", { name: "Resend invite to new@kanbo.app" })).not.toBeDisabled();
  });

  it("members who can't manage people don't get invite actions", () => {
    team([member({ id: "p1", email: "guest@partner.io", status: "invited" })], { myRole: "member", workspaces: [{ id: WS, name: "Foundrise", ownerId: "someone-else" }] });
    expect(screen.queryByRole("button", { name: /Resend invite/ })).toBeNull();
    expect(screen.queryByLabelText("Invite email")).toBeNull();
  });

  it("describes the guest role as view-and-comment across every project", () => {
    team([]);
    fireEvent.change(screen.getByLabelText("Invite as role"), { target: { value: "guest" } });
    expect(screen.getByText("Can view and comment — sees every project in this workspace", { exact: false })).toBeInTheDocument();
  });

  it("warns that removing someone also takes them off tasks they follow or collaborate on", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { props } = team([member({ id: "w1", userId: "m-1", email: "maya@kanbo.app" })]);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    fireEvent.click(screen.getByRole("button", { name: /Remove from workspace/ }));
    expect(confirm).toHaveBeenCalledWith("Remove Maya Lin from this workspace? They'll also be taken off tasks they collaborate on or follow.");
    expect(props.onRemoveMember).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it("the logo picker only offers types the avatars bucket takes, and refuses an SVG with a clear message", () => {
    const onUploadLogo = vi.fn();
    team([], { onUploadLogo });
    const input = screen.getByLabelText("Workspace logo image");
    expect(input).toHaveAttribute("accept", "image/png,image/jpeg,image/gif,image/webp");
    const svg = new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" });
    fireEvent.change(input, { target: { files: [svg] } });
    expect(screen.getByRole("alert")).toHaveTextContent("Choose a PNG, JPG, GIF or WebP image for the logo.");
    expect(screen.queryByRole("dialog", { name: "Adjust logo" })).toBeNull();
    // a PNG goes on to the cropper and clears the message
    fireEvent.change(input, { target: { files: [new File(["x"], "logo.png", { type: "image/png" })] } });
    expect(screen.getByRole("dialog", { name: "Adjust logo" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(onUploadLogo).not.toHaveBeenCalled();
  });

  it("opens the profile drawer, and Escape closes it", () => {
    team([member({ id: "w1", userId: "m-1", email: "maya@kanbo.app" })]);
    fireEvent.click(screen.getByRole("button", { name: /Maya Lin/ }));
    const dialog = screen.getByRole("dialog", { name: "Maya Lin profile" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("WorkspaceSettingsPanel", () => {
  const workspaces = [{ id: WS, name: "Foundrise", ownerId: "m-self" }];
  it("shows only to people who can manage the workspace", () => {
    const { unmount } = render(<WorkspaceSettingsPanel workspace={WS} workspaces={workspaces} myRole="member" />);
    expect(screen.queryByText("Workspace settings")).toBeNull();
    unmount();
    render(<WorkspaceSettingsPanel workspace={WS} workspaces={workspaces} myRole="admin" />);
    expect(screen.getByText("Workspace settings")).toBeInTheDocument();
    // closing the workspace is the owner's alone
    expect(screen.queryByRole("button", { name: /Close workspace/ })).toBeNull();
  });

  it("lets the owner rename the workspace, and offers Close workspace", () => {
    const onUpdateWorkspace = vi.fn();
    render(<WorkspaceSettingsPanel workspace={WS} workspaces={workspaces} myRole="owner" onUpdateWorkspace={onUpdateWorkspace} />);
    expect(screen.getByRole("button", { name: /Close workspace/ })).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue("Foundrise"), { target: { value: "Foundrise Labs" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onUpdateWorkspace).toHaveBeenCalledWith(WS, "Foundrise Labs", null);
  });

  it("shows nothing in Personal, or for a workspace it doesn't know", () => {
    const { container, unmount } = render(<WorkspaceSettingsPanel workspace={null} workspaces={[{ id: null, name: "Personal" }]} myRole="owner" />);
    expect(container).toBeEmptyDOMElement();
    unmount();
    const other = render(<WorkspaceSettingsPanel workspace="ws-elsewhere" workspaces={workspaces} myRole="owner" />);
    expect(other.container).toBeEmptyDOMElement();
  });
});
