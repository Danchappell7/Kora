import { describe, it, expect } from "vitest";
import { canDeleteProject, can, ROLE_META } from "./permissions";

const me = "u-me";
const team = { id: "p-launch", workspaceId: "ws-1", ownerId: "u-other" };

describe("canDeleteProject (mirrors 0041's projects DELETE policy)", () => {
  it("never allows deleting the built-in Personal project", () => {
    expect(canDeleteProject({ id: "p-personal", workspaceId: null }, { currentUserId: me, myRole: "owner" })).toBe(false);
  });

  it("lets you delete your own personal projects", () => {
    expect(canDeleteProject({ id: "p-1", workspaceId: null }, { currentUserId: me })).toBe(true);
  });

  it("lets workspace owners and admins delete any team project", () => {
    expect(canDeleteProject(team, { currentUserId: me, myRole: "owner" })).toBe(true);
    expect(canDeleteProject(team, { currentUserId: me, myRole: "admin" })).toBe(true);
  });

  it("lets a member delete only a project they own", () => {
    expect(canDeleteProject(team, { currentUserId: me, myRole: "member" })).toBe(false);
    expect(canDeleteProject({ ...team, ownerId: me }, { currentUserId: me, myRole: "member" })).toBe(true);
  });

  it("never lets a guest delete, even a project they are listed as owning", () => {
    expect(canDeleteProject({ ...team, ownerId: me }, { currentUserId: me, myRole: "guest" })).toBe(false);
  });

  it("errs on the side of caution when the role is unknown", () => {
    expect(canDeleteProject(team, { currentUserId: me })).toBe(false);
    expect(canDeleteProject({ ...team, ownerId: me }, { currentUserId: me })).toBe(true);
    expect(canDeleteProject(team, { currentUserId: me, workspaceOwnerId: me })).toBe(true);
  });

  it("treats a project with no owner as not yours", () => {
    expect(canDeleteProject({ id: "p-x", workspaceId: "ws-1", ownerId: null }, { currentUserId: me, myRole: "member" })).toBe(false);
  });
});

describe("guest capabilities", () => {
  it("guests can view and comment, not edit", () => {
    expect(can("guest", "editContent")).toBe(false);
    expect(can("guest", "createProjects")).toBe(false);
    expect(ROLE_META.guest.blurb).toMatch(/view and comment/i);
  });
});
