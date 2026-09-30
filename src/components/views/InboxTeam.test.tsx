import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { InboxView, TeamView } from "./InboxTeam";
import type { Activity, Task, WorkspaceMember } from "../../data/types";

const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const act_ = (p: Partial<Activity> & { id: string }): Activity => ({
  taskId: "t1", taskTitle: "Q3 budget", kind: "comment", detail: "", createdAt: iso(60_000), readAt: iso(), ...p,
});
const task = { id: "t1", title: "Q3 budget", projectId: "p-launch", status: "todo", assigneeId: "m-1", aiScore: 1 } as unknown as Task;

function inbox(activity: Activity[], extra: Partial<Parameters<typeof InboxView>[0]> = {}) {
  const props = { activity, tasks: [task], onOpen: vi.fn(), onArchive: vi.fn(), onClearAll: vi.fn(), ...extra };
  const utils = render(<InboxView {...props} />);
  return { ...utils, props };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.useRealTimers(); });

describe("InboxView — who did what", () => {
  it("renders a teammate's comment as '<name> commented on <task>', not 'You commented'", () => {
    inbox([act_({ id: "a1", kind: "comment", detail: "Maya Lin" })]);   // Maya Lin is a known member
    const row = screen.getByRole("button", { name: /Maya Lin commented on Q3 budget/ });
    expect(row).toBeInTheDocument();
    expect(screen.queryByText(/You commented/)).toBeNull();
    expect(screen.queryByText("“Maya Lin”")).toBeNull();
  });

  it("treats an email or a departed teammate's full name as the commenter too", () => {
    inbox([
      act_({ id: "a1", detail: "sam@partner.io" }),
      act_({ id: "a2", detail: "Priya Natarajan" }),
    ]);
    expect(screen.getByRole("button", { name: /sam@partner\.io commented on/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Priya Natarajan commented on/ })).toBeInTheDocument();
  });

  it("keeps legacy self-logged comment rows as 'You commented on' with the excerpt", () => {
    inbox([act_({ id: "a1", detail: "Looks great, ship it!" })]);
    expect(screen.getByRole("button", { name: /You commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.getByText("“Looks great, ship it!”")).toBeInTheDocument();
  });

  // rows from before the release that stops self-logged comment rows are a mix;
  // from it on, every comment row is a teammate's
  const OLD = "2026-09-20T10:00:00.000Z", NEW = "2026-10-13T10:00:00.000Z";

  it("older rows: a single-word name is the commenter, a stock reply in Title Case is your own comment", () => {
    inbox([
      act_({ id: "a1", detail: "Priya", createdAt: OLD }),
      act_({ id: "a2", detail: "Great Work", createdAt: OLD, taskTitle: "Brief" }),
      act_({ id: "a3", detail: "Sounds Good.", createdAt: OLD, taskTitle: "Roadmap" }),
    ]);
    expect(screen.getByRole("button", { name: /Priya commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.queryByText("“Priya”")).toBeNull();
    expect(screen.getByRole("button", { name: /You commented on Brief/ })).toBeInTheDocument();
    expect(screen.getByText("“Great Work”")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /You commented on Roadmap/ })).toBeInTheDocument();
  });

  it("newer rows: any name shape is the commenter, but a sentence still reads as your own", () => {
    inbox([
      act_({ id: "a1", detail: "priya", createdAt: NEW }),
      act_({ id: "a2", detail: "Looks great, ship it!", createdAt: NEW, taskTitle: "Brief" }),
    ]);
    expect(screen.getByRole("button", { name: /priya commented on Q3 budget/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /You commented on Brief/ })).toBeInTheDocument();
  });

  it("labels row actions with the item name", () => {
    inbox([act_({ id: "a1", kind: "assigned", detail: "Theo Vance" })]);
    expect(screen.getByRole("button", { name: "Archive “Q3 budget”" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Snooze “Q3 budget”" })).toBeInTheDocument();
  });
});

describe("InboxView — unread snapshot", () => {
  it("keeps the unread marker for items that were unread on arrival, even after they're marked read", () => {
    const rows = [act_({ id: "u1", kind: "mention", detail: "Theo Vance", readAt: undefined }), act_({ id: "r1", kind: "assigned", detail: "Sana Rao" })];
    const { rerender, props } = inbox(rows);
    expect(screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Sana Rao assigned you/ })).toBeInTheDocument();
    // App marks everything read right after the inbox opens
    rerender(<InboxView {...props} activity={rows.map((a) => ({ ...a, readAt: iso() }))} />);
    expect(screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ })).toBeInTheDocument();
  });

  it("flags items that arrive while the inbox is open, and clears the flag when opened", () => {
    const { rerender, props } = inbox([act_({ id: "r1", kind: "assigned", detail: "Sana Rao" })]);
    const next = [act_({ id: "n1", kind: "mention", detail: "Theo Vance", readAt: undefined, createdAt: iso() }), ...props.activity];
    rerender(<InboxView {...props} activity={next} />);
    const row = screen.getByRole("button", { name: /^Unread: Theo Vance mentioned you in/ });
    fireEvent.click(row);
    expect(props.onOpen).toHaveBeenCalledWith("t1");
    expect(screen.getByRole("button", { name: /^Theo Vance mentioned you in/ })).toBeInTheDocument();
  });
});

describe("InboxView — archive all", () => {
  it("confirms, then archives only what's shown (active filter, minus snoozed)", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ c2: Date.now() + 3_600_000 }));
    const { props } = inbox([
      act_({ id: "c1", detail: "Maya Lin" }),
      act_({ id: "c2", detail: "Theo Vance" }),              // snoozed
      act_({ id: "m1", kind: "mention", detail: "Sana Rao" }), // other filter
    ]);
    fireEvent.click(screen.getByRole("button", { name: /^Comments/ }));
    fireEvent.click(screen.getByRole("button", { name: /Archive all/ }));
    expect(props.onClearAll).not.toHaveBeenCalled();
    expect(screen.getByText(/Archive 1 comment\?/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Archive$/ }));
    expect(props.onClearAll).toHaveBeenCalledWith(["c1"]);
  });

  it("can be cancelled with Escape", () => {
    const { props } = inbox([act_({ id: "c1", detail: "Maya Lin" })]);
    fireEvent.click(screen.getByRole("button", { name: /Archive all/ }));
    fireEvent.keyDown(screen.getByRole("button", { name: /^Archive$/ }), { key: "Escape" });
    expect(screen.getByRole("button", { name: /Archive all/ })).toBeInTheDocument();
    expect(props.onClearAll).not.toHaveBeenCalled();
  });
});

describe("InboxView — snooze", () => {
  it("opens the snooze menu in a portal (outside the clipping card) and hides the snoozed row", () => {
    const { container } = inbox([act_({ id: "a1", detail: "Maya Lin" }), act_({ id: "a2", kind: "assigned", detail: "Sana Rao", taskTitle: "Brief" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Q3 budget”" }));
    const menu = screen.getByRole("menu", { name: /Snooze “Q3 budget”/ });
    expect(container.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(3);
    fireEvent.click(within(menu).getByRole("menuitem", { name: /Tomorrow, 9am/ }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /commented on Q3 budget/ })).toBeNull();
    expect(screen.getByText(/1 snoozed/)).toBeInTheDocument();
    const saved = JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}");
    expect(saved.a1).toBeGreaterThan(Date.now());
  });

  it("opens upward when the trigger sits near the bottom of the viewport", () => {
    const h = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(130);
    const w = vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(208);
    try {
      inbox([act_({ id: "a1", detail: "Maya Lin" })]);
      const trigger = screen.getByRole("button", { name: "Snooze “Q3 budget”" });
      trigger.getBoundingClientRect = () => ({ top: window.innerHeight - 40, bottom: window.innerHeight - 10, left: 500, right: 530, width: 30, height: 30, x: 500, y: window.innerHeight - 40, toJSON: () => ({}) });
      fireEvent.click(trigger);
      const menu = screen.getByRole("menu");
      expect(menu.style.top).toBe(`${window.innerHeight - 40 - 6 - 130}px`);
      expect(menu.style.transformOrigin).toBe("100% 100%");
    } finally { h.mockRestore(); w.mockRestore(); }
  });

  it("closes the menu on Escape and returns focus to the trigger", () => {
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    const trigger = screen.getByRole("button", { name: "Snooze “Q3 budget”" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("brings expired snoozes back at the top, flagged, and only once", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ old: Date.now() - 1000 }));
    inbox([act_({ id: "new", kind: "assigned", detail: "Sana Rao", taskTitle: "Fresh" }), act_({ id: "old", detail: "Maya Lin", createdAt: iso(3 * 86400000) })]);
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /^Unread: Maya Lin commented on/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({});
  });

  it("'Bring back now' only unsnoozes this inbox's items, and brings them back at the top", () => {
    const later = Date.now() + 3_600_000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: later, otherWsItem: later }));
    inbox([act_({ id: "a1", detail: "Maya Lin" }), act_({ id: "a2", kind: "assigned", detail: "Theo Vance", taskTitle: "Brief" })]);
    expect(screen.getByText(/1 snoozed/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Bring back now" }));
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /Maya Lin commented on Q3 budget/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({ otherWsItem: later });
  });

  it("keeps an ended snooze for another workspace's item until that inbox shows it", () => {
    const ended = Date.now() - 1000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ x9: ended }));
    const first = inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("region", { name: "Back from snooze" })).toBeNull();
    first.unmount();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({ x9: ended });
    inbox([act_({ id: "x9", kind: "assigned", detail: "Theo Vance", taskTitle: "Other" })]);
    const back = screen.getByRole("region", { name: "Back from snooze" });
    expect(within(back).getByRole("button", { name: /^Unread: Theo Vance assigned you Other/ })).toBeInTheDocument();
  });

  it("drops snoozes that ended long ago without flagging them", () => {
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() - 20 * 86400000, gone: Date.now() - 20 * 86400000 }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("region", { name: "Back from snooze" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Maya Lin commented on/ })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}")).toEqual({});
  });

  it("snoozing again keeps other inboxes' ended snoozes", () => {
    const ended = Date.now() - 1000;
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ x9: ended }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    fireEvent.click(screen.getByRole("button", { name: "Snooze “Q3 budget”" }));
    fireEvent.click(within(screen.getByRole("menu")).getByRole("menuitem", { name: /In 3 hours/ }));
    const saved = JSON.parse(localStorage.getItem("kanbo-inbox-snooze") || "{}");
    expect(saved.x9).toBe(ended);
    expect(saved.a1).toBeGreaterThan(Date.now());
  });

  it("wakes a snooze while the inbox stays open", () => {
    vi.useFakeTimers();
    localStorage.setItem("kanbo-inbox-snooze", JSON.stringify({ a1: Date.now() + 5000 }));
    inbox([act_({ id: "a1", detail: "Maya Lin" })]);
    expect(screen.queryByRole("button", { name: /commented on Q3 budget/ })).toBeNull();
    act(() => { vi.advanceTimersByTime(6000); });
    expect(screen.getByRole("region", { name: "Back from snooze" })).toBeInTheDocument();
  });
});

/* ---------------- Team ---------------- */
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
