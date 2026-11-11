// @vitest-environment node
// What an invite email says about the role it's for.
import { describe, expect, it } from "vitest";
import { guestNote, roleLine } from "./inviteCopy.ts";

describe("invite email: the role", () => {
  it("names the role with its article", () => {
    expect(roleLine("admin")).toBe("an admin");
    expect(roleLine("member")).toBe("a member");
    expect(roleLine("guest")).toBe("a guest");
    expect(roleLine("owner")).toBe("a member");     // never invited as owner: the safe default
    expect(roleLine("")).toBe("a member");
  });

  it("tells a guest plainly that they'll see every project (while Project access is off, or before 0058)", () => {
    expect(guestNote("guest", "Foundrise")).toBe("As a guest you can see every project in Foundrise and comment on its tasks, but you can't change anything.");
    expect(guestNote("guest", "Foundrise", false)).toBe(guestNote("guest", "Foundrise"));
    expect(guestNote("member", "Foundrise")).toBeNull();
    expect(guestNote("admin", "Foundrise")).toBeNull();
  });

  it("with Project access on, a guest is told they'll see only the projects they're added to", () => {
    // (never a promise to comment: a guest added as a viewer can't)
    expect(guestNote("guest", "Foundrise", true)).toBe("As a guest you'll see only the projects you're added to. On each one you can read its tasks, or comment on them too, depending on how you were added.");
    expect(guestNote("guest", "Foundrise", true)).not.toMatch(/, and you can comment/);
    expect(guestNote("member", "Foundrise", true)).toBeNull();
    expect(guestNote("admin", "Foundrise", true)).toBeNull();
  });
});
