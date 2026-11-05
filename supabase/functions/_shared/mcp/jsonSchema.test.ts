// @vitest-environment node
import { describe, expect, it } from "vitest";
import { schemaErrors, type JsonSchema } from "./jsonSchema.ts";

const S: JsonSchema = {
  type: "object", additionalProperties: false, required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 4 },
    n: { type: "integer", minimum: 1, maximum: 3 },
    x: { type: "number" },
    nul: { type: ["string", "null"] },
    pick: { type: "string", enum: ["a", "b"] },
    list: { type: "array", maxItems: 2, items: { type: "string" } },
    sub: { type: "object", properties: { y: { type: "boolean" } }, required: ["y"] },
  },
};

describe("schemaErrors", () => {
  it("passes a fitting value", () => {
    expect(schemaErrors(S, { id: "ab", n: 2, x: 1.5, nul: null, pick: "a", list: ["q"], sub: { y: true } })).toEqual([]);
  });
  it.each([
    [{}, /id is required/],
    [{ id: "" }, /id can't be empty/],
    [{ id: "abcde" }, /at most 4/],
    [{ id: "a", n: 1.5 }, /n must be integer/],
    [{ id: "a", n: 9 }, /at most 3/],
    [{ id: "a", n: 0 }, /at least 1/],
    [{ id: "a", x: "1" }, /x must be number/],
    [{ id: "a", pick: "c" }, /one of a, b/],
    [{ id: "a", list: "x" }, /list must be array/],
    [{ id: "a", list: ["1", "2", "3"] }, /at most 2 items/],
    [{ id: "a", list: [1] }, /list\[0\] must be string/],
    [{ id: "a", sub: {} }, /sub\.y is required/],
    [{ id: "a", nope: 1 }, /nope isn't a field/],
    [{ id: 1 }, /id must be string/],
  ])("%j", (v, re) => expect(schemaErrors(S, v).join(" ")).toMatch(re));
  it("says what a whole value should be", () => {
    expect(schemaErrors(S, null)[0]).toMatch(/must be object/);
    expect(schemaErrors({ type: ["string", "null"] }, 1)[0]).toMatch(/must be string/);
  });
  it("doesn't take inherited names as fields", () => {
    expect(schemaErrors(S, { id: "a", constructor: 1 }).join(" ")).toMatch(/constructor isn't a field/);
  });
});
