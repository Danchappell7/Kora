// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PG_TYPES } from "./pgTypes.ts";

describe("the driver's type table", () => {
  it("sends JSON text as it is, not encoded twice", () => {
    const text = JSON.stringify(["https://claude.ai/api/mcp/auth_callback"]);
    expect(PG_TYPES.json.serialize(text)).toBe(text);
  });
  it("encodes anything else once", () => {
    expect(PG_TYPES.json.serialize(["a"])).toBe('["a"]');
    expect(PG_TYPES.json.serialize({ a: 1 })).toBe('{"a":1}');
  });
  it("covers both json and jsonb, sending and reading", () => {
    expect(PG_TYPES.json.from).toEqual([114, 3802]);
    expect(PG_TYPES.json.parse('{"a":1}')).toEqual({ a: 1 });
  });
  it("keeps dates as they are", () => {
    expect(PG_TYPES.date.parse("2026-11-04")).toBe("2026-11-04");
  });
  it("is what db.ts connects with, and db.ts is the only place the driver is opened", () => {
    expect(readFileSync("supabase/functions/_shared/api/db.ts", "utf8")).toMatch(/types: PG_TYPES,/);
    expect(readFileSync("supabase/tests/pglite/driver.ts", "utf8")).toMatch(/types: PG_TYPES,/);
  });
});
