/* New project's "Who can see this?" (0058): asked only where the workspace has project access on,
   starting at the workspace's default; Private only for those allowed; Members only and Private
   take their people in the same create. */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { NewProjectModal } from "./NewProjectModal";
import type { AccessCtx } from "../lib/projectAccess";
import type { ProjectVisibility, WorkspaceMember } from "../data/types";

const W = "ws-1";
const wm = (userId: string, role: WorkspaceMember["role"], name: string): WorkspaceMember => ({ id: `wm-${userId}`, workspaceId: W, userId, email: `${userId}@x.co`, name, role, status: "active" });
const ctx = (me: string, on: boolean, def: ProjectVisibility = "workspace", memberPrivate = false): AccessCtx => ({
  me, workspaces: [{ id: W, name: "Foundrise", kind: "team", projectAccess: { on, defaultVisibility: def, membersMayMakePrivate: memberPrivate } }],
  projects: [], members: [], wsMembers: [wm("o", "owner", "Olive"), wm("me", "member", "Mo"), wm("g", "guest", "Ana Ruiz")],
});
const names: Record<string, string> = { o: "Olive", me: "Mo", g: "Ana Ruiz" };
const open = (c: AccessCtx, onCreate = vi.fn()) => {
  render(<NewProjectModal open onClose={vi.fn()} onCreate={onCreate} workspaceId={W} access={{ ctx: c, workspaceName: "Foundrise", nameOf: (id) => names[id] ?? id }} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project name" }), { target: { value: "Board pack" } });
  return onCreate;
};

describe("NewProjectModal · Who can see this?", () => {
  it("isn't asked where project access is off", () => {
    const onCreate = open(ctx("o", false));
    expect(screen.queryByRole("radiogroup", { name: "Who can see this?" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate.mock.calls[0][0]).not.toHaveProperty("visibility");
  });

  it("starts at the workspace's default and sends the choice and its people with the create", () => {
    const onCreate = open(ctx("o", true, "members"));
    const group = screen.getByRole("radiogroup", { name: "Who can see this?" });
    expect(within(group).getByRole("radio", { name: /Members only/ })).toBeChecked();
    fireEvent.click(within(group).getByRole("radio", { name: /^Private/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ana Ruiz (guest)" }));
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ name: "Board pack", workspaceId: W, visibility: "private", memberIds: ["g"] });
  });

  it("a member can't pick Private unless an owner allows it (a private default starts as members only)", () => {
    open(ctx("me", true, "private"));
    const group = screen.getByRole("radiogroup", { name: "Who can see this?" });
    expect(within(group).queryByRole("radio", { name: /^Private/ })).toBeNull();
    expect(within(group).getByRole("radio", { name: /Members only/ })).toBeChecked();
    expect(screen.getByText("An owner can let members make projects private.")).toBeInTheDocument();
  });

  it("Whole workspace offers just the guests (everyone else here sees it anyway), sent with the create", () => {
    const onCreate = open(ctx("o", true));
    const guests = screen.getByRole("group", { name: "Guests on it" });
    expect(within(guests).getAllByRole("button").map((b) => b.textContent)).toEqual(["Ana Ruiz (guest)"]);
    fireEvent.click(within(guests).getByRole("button", { name: "Ana Ruiz (guest)" }));
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    expect(onCreate.mock.calls[0][0]).toMatchObject({ visibility: "workspace", memberIds: ["g"] });
  });
});

