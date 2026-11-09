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

  it("tells a guest plainly that they'll see every project (until private projects land)", () => {
    expect(guestNote("guest", "Foundrise")).toBe("As a guest you can see every project in Foundrise and comment on its tasks, but you can't change anything.");
    expect(guestNote("member", "Foundrise")).toBeNull();
    expect(guestNote("admin", "Foundrise")).toBeNull();
  });
});
