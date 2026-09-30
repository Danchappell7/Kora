import { describe, it, expect } from "vitest";
import { resolveAdminAccess, isAdminEmail } from "./AdminApp";

describe("admin console gate", () => {
  it("lets delegated admins in on the server's say-so", () => {
    expect(resolveAdminAccess({ data: true }, "teammate@acme.co.uk")).toBe("admin");
  });

  it("keeps non-admins out", () => {
    expect(resolveAdminAccess({ data: false }, "teammate@acme.co.uk")).toBe("denied");
  });

  it("uses the founder allowlist only when the check itself fails", () => {
    const failed = { error: new Error("Failed to fetch") };
    expect(resolveAdminAccess(failed, "danchappell7@gmail.com")).toBe("admin");
    expect(resolveAdminAccess(failed, " DanChappell7@Gmail.com ")).toBe("admin");
    // anyone else gets "couldn't check" (with a retry), not a false "not authorised"
    expect(resolveAdminAccess(failed, "teammate@acme.co.uk")).toBe("unverified");
    expect(resolveAdminAccess({ data: null }, "teammate@acme.co.uk")).toBe("unverified");
  });

  it("matches the founder email case-insensitively", () => {
    expect(isAdminEmail("DANCHAPPELL7@gmail.com")).toBe(true);
    expect(isAdminEmail("someone@gmail.com")).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });
});
