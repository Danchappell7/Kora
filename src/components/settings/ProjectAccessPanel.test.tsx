/* Settings › Workspace › Project access (0058): the owner's only; off, it says what turning it on
   would do for each guest; on or off asks first; the defaults save at once. Nothing before 0058. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ProjectAccessPanel } from "./ProjectAccessPanel";
import { noteAccessSchema, resetAccessSchema, type AccessCtx } from "../../lib/projectAccess";
import type { Workspace, WorkspaceMember } from "../../data/types";

const W = "ws-r";
const wm = (userId: string, role: WorkspaceMember["role"], name: string): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: W, userId, email: `${userId}@x.co`, name, role, status: "active" });
const ws = (on: boolean): Workspace => ({ id: W, name: "Reco HQ", kind: "team", ownerId: "me", projectAccess: { on, defaultVisibility: "workspace", membersMayMakePrivate: false } });
const ctx = (me: string, on: boolean): AccessCtx => ({
  me, workspaces: [ws(on)],
  projects: [{ id: "p1", name: "Customer Onboarding", emoji: "", color: "", workspaceId: W, ownerId: "me" }, { id: "p2", name: "Growth", emoji: "", color: "", workspaceId: W, ownerId: "me", visibility: "private" }],
  wsMembers: [wm("me", "owner", "Daniel"), wm("a", "admin", "Ada"), wm("leah", "guest", "Leah Price"), wm("ana", "guest", "Ana Ruiz")],
  members: [{ id: "pm1", projectId: "p1", workspaceId: W, userId: "leah", role: "commenter" }],
});

afterEach(() => resetAccessSchema());

describe("ProjectAccessPanel", () => {
  it("is the owner's: admins and members don't see it, nor does anyone before 0058", () => {
    const { container, rerender } = render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("a", false)} onChange={vi.fn()} />);
    expect(container.textContent).toBe("");
    noteAccessSchema(false);
    rerender(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} onChange={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("off: what turning it on does, guest by guest, and it asks before switching", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} onChange={onChange} />);
    expect(screen.getByText("When you turn it on:")).toBeInTheDocument();
    expect(screen.getByText(/Leah Price · Customer Onboarding/)).toBeInTheDocument();
    expect(screen.getByText(/Ana Ruiz · none yet \(add them to a project first\)/)).toBeInTheDocument();
    expect(screen.getByText("You can turn it off any time. Nothing is lost.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" }));
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toMatch(/^Turn on project access for Reco HQ\? Guests will only see the projects they're on\./);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Turn it on" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(W, { on: true }));
  });

  it("off, with a Members only or Private project that still connects to Notion: the preview lists it and what to do, and \"Turn it on\" waits until they're cleared (0058's containment rule)", async () => {
    const onChange = vi.fn(async () => true);
    const blockers = [
      { projectId: "p2", name: "Growth", visibility: "private" as const, syncs: 1, linkedTasks: 3 },
      { projectId: "p9", name: null, visibility: null, syncs: 0, linkedTasks: 1 },
    ];
    const load = vi.fn(async () => blockers);
    const { rerender } = render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} onChange={onChange} loadNotionBlockers={load} />);
    expect(await screen.findByText("“Growth” is Private and still has 1 Notion sync and 3 tasks with Notion links.")).toBeInTheDocument();
    expect(screen.getByText("A Members only or Private project that's been deleted or moved and still has 1 task with Notion links.")).toBeInTheDocument();
    expect(screen.getByText(/^Members only and Private projects don't connect to Notion yet\. Before turning this on, remove their Notion syncs \(Settings › Notion\)/)).toBeInTheDocument();
    expect(load).toHaveBeenCalledWith(W);
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" })); });
    const ask = screen.getByRole("alertdialog");
    expect(ask.textContent).toMatch(/^2 Members only or Private projects still connect to Notion, so project access can't be turned on yet\./);
    expect(within(ask).getByRole("button", { name: "Turn it on" })).toBeDisabled();
    expect(onChange).not.toHaveBeenCalled();
    // cleared (asked again when the question opens): it goes on
    load.mockResolvedValue([]);
    await act(async () => { fireEvent.click(within(ask).getByRole("button", { name: "Cancel" })); });
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" })); });
    await waitFor(() => expect(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Turn it on" })).toBeEnabled());
    expect(screen.queryByText(/still has 1 Notion sync/)).toBeNull();
    // (nobody but the owner asks)
    load.mockClear();
    rerender(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("a", false)} onChange={onChange} loadNotionBlockers={load} />);
    expect(load).not.toHaveBeenCalled();
  });

  it("on: the counts, the default for new projects, and whether members may make projects private", async () => {
    const onChange = vi.fn(async () => true);
    render(<ProjectAccessPanel workspace={ws(true)} ctx={ctx("me", true)} onChange={onChange} />);
    expect(screen.getByText("1 private · 0 members only · 1 whole workspace")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "New projects start as" }), { target: { value: "members" } });
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(W, { defaultVisibility: "members" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Members can make projects private" }));
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledWith(W, { membersMayMakePrivate: true }));
    fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/^Turn off project access\? Everyone at Reco HQ, guests included, will see every project again\./);
  });

  it("the default for new projects says what it does while the switch is off (it applies already; nobody is asked)", () => {
    const { rerender } = render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} onChange={vi.fn()} />);
    expect(screen.getByText(/Projects made from now on start as this, even before you turn it on/)).toBeInTheDocument();
    expect(screen.queryByText("Anyone making a project can change it in its About tab.")).toBeNull();
    rerender(<ProjectAccessPanel workspace={ws(true)} ctx={ctx("me", true)} onChange={vi.fn()} />);
    expect(screen.getByText("Anyone making a project can change it in its About tab.")).toBeInTheDocument();
  });

  it("off: a project already set Members only or Private names who'd lose it, and the question says so too", () => {
    render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} onChange={vi.fn()} />);
    expect(screen.queryByText(/nothing changes until a project is Members only or Private/)).toBeNull();
    expect(screen.getByText("Already set: 1 private · 0 members only.")).toBeInTheDocument();
    expect(screen.getByText("Growth is Private: Ada won't see it.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/Guests will only see the projects they're on\. 1 member won't see the Members only or Private projects they're not on\./);
  });

  it("off: a guest's own open tasks in projects they're not on are named before they go out of sight", () => {
    const tasks = [
      { workspaceId: W, projectId: "p1", assigneeId: "ana", status: "todo" as const },
      { workspaceId: W, projectId: "p1", assigneeId: "x", status: "todo" as const, collaborators: ["ana"] },
      { workspaceId: W, projectId: "p1", assigneeId: "ana", status: "done" as const },
      { workspaceId: W, projectId: "p1", assigneeId: "leah", status: "todo" as const },   // (Leah is on it)
    ];
    render(<ProjectAccessPanel workspace={ws(false)} ctx={ctx("me", false)} tasks={tasks} onChange={vi.fn()} />);
    expect(screen.getByText("Ana Ruiz has 2 open tasks in Customer Onboarding. Add them to it first, or they won't see them.")).toBeInTheDocument();
    expect(screen.queryByText(/Leah Price has/)).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Turn on project access" }));
    expect(screen.getByRole("alertdialog").textContent).toMatch(/1 guest won't see some of their own open tasks\./);
  });

  it("off, every project Whole workspace: members and admins lose nothing", () => {
    const c = ctx("me", false);
    render(<ProjectAccessPanel workspace={ws(false)} ctx={{ ...c, projects: c.projects.map((p) => ({ ...p, visibility: "workspace" as const })) }} onChange={vi.fn()} />);
    expect(screen.getByText("Members and admins: nothing changes until a project is Members only or Private.")).toBeInTheDocument();
    expect(screen.queryByText(/Already set/)).toBeNull();
  });
});
