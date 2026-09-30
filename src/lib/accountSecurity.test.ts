import { describe, it, expect } from "vitest";
import { passwordIssue, friendlyPasswordError, friendlySignOutError, PASSWORD_MIN } from "./accountSecurity";

describe("passwordIssue", () => {
  it("needs at least 8 characters", () => {
    expect(PASSWORD_MIN).toBe(8);
    expect(passwordIssue("short", "short")).toMatch(/at least 8/);
    expect(passwordIssue("1234567", "1234567")).toMatch(/at least 8/);
    expect(passwordIssue("12345678", "12345678")).toBeNull();
  });

  it("needs the confirmation to match", () => {
    expect(passwordIssue("correct horse", "correct hose")).toMatch(/don't match/);
    expect(passwordIssue("correct horse", "")).toMatch(/don't match/);
  });

  it("rejects passwords Supabase would refuse or that are only spaces", () => {
    expect(passwordIssue("a".repeat(73), "a".repeat(73))).toMatch(/72 characters or fewer/);
    expect(passwordIssue("a".repeat(72), "a".repeat(72))).toBeNull();
    expect(passwordIssue("        ", "        ")).toMatch(/only spaces/);
  });
});

describe("friendlyPasswordError", () => {
  it("maps Supabase messages to plain guidance", () => {
    expect(friendlyPasswordError("New password should be different from the old password.")).toMatch(/current password/);
    expect(friendlyPasswordError("Password update requires reauthentication.")).toMatch(/sign out and back in/);
    expect(friendlyPasswordError("Auth session missing!")).toMatch(/session has expired/);
    expect(friendlyPasswordError("Password is known to be weak and easy to guess, please choose a different one.")).toMatch(/data breach/);
    expect(friendlyPasswordError("Failed to fetch")).toMatch(/connection/);
    expect(friendlyPasswordError("")).toMatch(/try again/);
  });

  it("passes through anything it doesn't recognise", () => {
    expect(friendlyPasswordError("Password should contain at least one character of each: abc")).toBe("Password should contain at least one character of each: abc");
  });
});

describe("friendlySignOutError", () => {
  it("says nothing was signed out", () => {
    expect(friendlySignOutError("Failed to fetch")).toMatch(/nothing was signed out/);
    expect(friendlySignOutError("boom")).toMatch(/still signed in/);
  });
});
