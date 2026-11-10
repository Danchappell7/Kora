/* People & access (0058): who can see a project, its people and their roles, adding someone, and
   narrowing that asks first. Read-only for anyone who can't manage it. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { PeopleAccess, narrowingQuestion } from "./PeopleAccess";
import type { AccessCtx } from "../../lib/projectAccess";
import type { Project, ProjectMember, WorkspaceMember } from "../../data/types";

const W = "ws-x";
const wm = (userId: string, role: WorkspaceMember["role"], name: string): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: W, userId, email: `${userId}@x.co`, name, role, status: "active" });
const project = (o: Partial<Project> = {}): Project => ({ id: "p1", name: "Seed round", emoji: "", color: "", workspaceId: W, ownerId: "o", visibility: "members", ...o });
const ctx = (me: string, members: ProjectMember[], extra: { memberPrivate?: boolean } = {}): AccessCtx => ({
  me,
  workspaces: [{ id: W, name: "Foundrise", kind: "team", ownerId: "o", projectAccess: { on: true, defaultVisibility: "workspace", membersMayMakePrivate: !!extra.memberPrivate } }],
  projects: [project()],
  wsMembers: [wm("o", "owner", "Olive Owner"), wm("me", "member", "Mo Member"), wm("m2", "member", "Theo Vance"), wm("g", "guest", "Ana Ruiz")],
  members,
});
const pm = (userId: string, role: ProjectMember["role"]): ProjectMember => ({ id: `pm-${userId}`, projectId: "p1", workspaceId: W, userId, role });
const names: Record<string, string> = { o: "Olive Owner", me: "Mo Member", m2: "Theo Vance", g: "Ana Ruiz" };
const setup = (c: AccessCtx, p = project()) => {
  const props = { onSetVisibility: vi.fn(async () => true), onSetMember: vi.fn(async () => true), onRemoveMember: vi.fn(async () => true), onInviteGuest: vi.fn() };
  render(<PeopleAccess project={p} ctx={c} workspaceName="Foundrise" tasks={[{ projectId: "p1", assigneeId: "m2", status: "todo" }]} nameOf={(id) => names[id] ?? id} {...props} />);
  return { props, panel: screen.getByRole("region", { name: "People & access" }) };
};

describe("PeopleAccess", () => {
  it("shows who can see it, with counts that include the implicit owners and admins", () => {
    const { panel } = setup(ctx("o", [pm("me", "editor"), pm("g", "commenter")]));
    expect(within(panel).getByRole("radio", { name: /Members only/ })).toBeChecked();
    expect(within(panel).getByRole("radio", { name: /Whole workspace/ }).closest("label")?.textContent).toMatch(/4 people can see it/);
    expect(within(panel).getByRole("radio", { name: /^Private/ }).closest("label")?.textContent).toMatch(/3 people can see it/);
    expect(within(panel).getByText("Owner")).toBeInTheDocument();
    expect(within(panel).getByText("Guest")).toBeInTheDocument();
    // a guest's roles stop at commenting
    expect([...within(panel).getByRole("combobox", { name: "Ana Ruiz's role" }).querySelectorAll("option")].map((o) => o.value)).toEqual(["commenter", "viewer"]);
  });

  it("widening goes straight through; narrowing asks first, naming who'd lose it", async () => {
    const { panel, props } = setup(ctx("o", [pm("me", "editor")]), project({ visibility: "workspace" }));
    fireEvent.click(within(panel).getByRole("radio", { name: /^Private/ }));
    const ask = within(panel).getByRole("alertdialog");
    expect(ask.querySelector("p")?.textContent).toBe("Make Seed round private? Theo Vance will lose access. Theo has 1 open task here.");
    expect(props.onSetVisibility).not.toHaveBeenCalled();
    fireEvent.click(within(ask).getByRole("button", { name: "Make it private" }));
    await vi.waitFor(() => expect(props.onSetVisibility).toHaveBeenCalledWith("p1", "private"));
  });

  it("adds people (a guest as a commenter), changes a role and removes someone", async () => {
    const { panel, props } = setup(ctx("o", [pm("me", "editor")]));
    fireEvent.change(within(panel).getByRole("combobox", { name: "Add someone to this project" }), { target: { value: "g" } });
    fireEvent.click(within(panel).getByRole("button", { name: "Add" }));
    await vi.waitFor(() => expect(props.onSetMember).toHaveBeenCalledWith("p1", "g", "commenter"));
    await vi.waitFor(() => expect(within(panel).getByRole("combobox", { name: "Mo Member's role" })).not.toBeDisabled());
    fireEvent.change(within(panel).getByRole("combobox", { name: "Mo Member's role" }), { target: { value: "viewer" } });
    await vi.waitFor(() => expect(props.onSetMember).toHaveBeenCalledWith("p1", "me", "viewer"));
    await vi.waitFor(() => expect(within(panel).getByRole("button", { name: "Remove Mo Member" })).not.toBeDisabled());
    fireEvent.click(within(panel).getByRole("button", { name: "Remove Mo Member" }));
    await vi.waitFor(() => expect(props.onRemoveMember).toHaveBeenCalledWith("p1", "me"));
    fireEvent.click(within(panel).getByRole("button", { name: "Invite a guest" }));
    expect(props.onInviteGuest).toHaveBeenCalledWith("p1");
  });

  it("someone who can't manage it reads it; members can't pick Private unless an owner allows it", () => {
    const { panel } = setup(ctx("m2", []), project({ visibility: "workspace" }));
    expect(within(panel).queryByRole("combobox", { name: "Add someone to this project" })).toBeNull();
    expect(within(panel).getByText("Only its owner and editors can change who has access.")).toBeInTheDocument();
    expect(within(panel).getByRole("radio", { name: /^Private/ })).toBeDisabled();
    expect(panel.textContent).toMatch(/An owner can let members make projects private\./);
  });

  it("the question says nobody loses it when nobody does", () => {
    expect(narrowingQuestion("Payroll", "members", [])).toBe("Make Payroll members only?");
    expect(narrowingQuestion("Payroll", "private", [{ name: "Theo Vance", openTasks: 3 }, { name: "Maya Lin", openTasks: 0 }, { name: "Sana Rao", openTasks: 0 }]))
      .toBe("Make Payroll private? Theo Vance and 2 others will lose access. Theo has 3 open tasks here.");
  });
});
