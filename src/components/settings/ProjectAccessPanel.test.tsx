/* Settings › Workspace › Project access (0058): the owner's only; off, it says what turning it on
   would do for each guest; on or off asks first; the defaults save at once. Nothing before 0058. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
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
});
