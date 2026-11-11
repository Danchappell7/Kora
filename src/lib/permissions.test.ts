import { describe, it, expect } from "vitest";
import { canDeleteProject, canArchiveProject, can, ROLE_META, GUEST_LINE, removeMemberQuestion } from "./permissions";

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

  it("treats a project with no owner as not yours when you're a known member", () => {
    expect(canDeleteProject({ id: "p-x", workspaceId: "ws-1", ownerId: null }, { currentUserId: me, myRole: "member" })).toBe(false);
  });

  it("leaves an ownerless project to the server when the role is unknown (demo data)", () => {
    // demo workspaces/projects carry no ownerId and demo mode passes no role
    expect(canDeleteProject({ id: "p-launch", workspaceId: "ws-foundrise" }, { currentUserId: "m-self" })).toBe(true);
    expect(canDeleteProject({ id: "p-launch", workspaceId: "ws-foundrise" }, { currentUserId: "m-self", myRole: "guest" })).toBe(false);
  });
});

describe("canArchiveProject (mirrors 0041's UPDATE policy: any writer)", () => {
  it("lets any owner, admin or member archive or restore a team project they don't own", () => {
    for (const myRole of ["owner", "admin", "member"] as const) expect(canArchiveProject(team, { myRole })).toBe(true);
    expect(canArchiveProject(team, {})).toBe(true);
  });

  it("never lets a guest archive, and never archives the built-in Personal project", () => {
    expect(canArchiveProject(team, { myRole: "guest" })).toBe(false);
    expect(canArchiveProject({ id: "p-personal", workspaceId: null }, {})).toBe(false);
    expect(canArchiveProject({ id: "p-1", workspaceId: null }, { myRole: "guest" })).toBe(true);
  });
});

describe("guest capabilities", () => {
  it("guests can view and comment, not edit", () => {
    expect(can("guest", "editContent")).toBe(false);
    expect(can("guest", "createProjects")).toBe(false);
    // honest about today: a guest sees every project (until private projects land)
    expect(ROLE_META.guest.blurb).toBe("Can see every project and comment");
    expect(GUEST_LINE).toMatch(/every project in this workspace/);
    expect(GUEST_LINE).toMatch(/can't change anything/);
  });
});

describe("removing someone says what they leave behind", () => {
  it("names their open tasks and the projects they own", () => {
    expect(removeMemberQuestion("Theo Vance", 7, 2)).toBe("Remove Theo Vance from this workspace? Theo has 7 open tasks and owns 2 projects. They'll stay with Theo until you hand them on. Theo will also be taken off tasks they collaborate on or follow.");
    expect(removeMemberQuestion("Theo Vance", 1, 0)).toBe("Remove Theo Vance from this workspace? Theo has 1 open task. It'll stay assigned to Theo until you hand it on. Theo will also be taken off tasks they collaborate on or follow.");
    expect(removeMemberQuestion("Theo Vance", 0, 1)).toBe("Remove Theo Vance from this workspace? Theo owns 1 project. It'll stay in Theo's name until you hand it on. Theo will also be taken off tasks they collaborate on or follow.");
    expect(removeMemberQuestion("Maya Lin", 0, 0)).toBe("Remove Maya Lin from this workspace? They'll also be taken off tasks they collaborate on or follow.");
    // (0058 in: the projects they own go to the workspace's owner)
    expect(removeMemberQuestion("Theo Vance", 0, 2, "Daniel")).toBe("Remove Theo Vance from this workspace? Theo owns 2 projects. They go to Daniel unless you hand them on first. Theo will also be taken off tasks they collaborate on or follow.");
    expect(removeMemberQuestion("Theo Vance", 3, 1, "Daniel")).toBe("Remove Theo Vance from this workspace? Theo has 3 open tasks and owns 1 project. The tasks stay assigned to Theo until you hand them on; the project goes to Daniel unless you hand it on first. Theo will also be taken off tasks they collaborate on or follow.");
    expect(removeMemberQuestion("Theo Vance", 1, 0, "Daniel")).toBe("Remove Theo Vance from this workspace? Theo has 1 open task. It'll stay assigned to Theo until you hand it on. Theo will also be taken off tasks they collaborate on or follow.");
  });
});
